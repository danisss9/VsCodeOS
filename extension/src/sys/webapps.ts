// Installed web apps.
//
// A PWA is a URL with a manifest: a name, an icon and a start address. There is
// nothing to unpack and nothing to compile, so "installing" one here means
// remembering those three facts, keeping a copy of the icon, and writing the
// desktop entry that makes the app visible to anything else on the machine that
// reads ~/.local/share/applications.
//
// Two places own that record and they are kept in step deliberately:
//
//   apps.json   what the All Apps view and the Marketplace read. The registry.
//   *.desktop   what the rest of the desktop reads, marked X-VSCodeOS-WebApp so
//               the .desktop scan in desktopApps.ts knows to leave them to us
//               rather than listing every app twice.
//
// Nothing here needs root: everything is under the user's own home.

import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as browser from './browser';
import { which } from './exec';
import * as http from './http';
import { escapeDesktopExec, escapeDesktopValue } from '../util/desktop';
import {
    hostOf,
    manifestHref,
    normaliseSiteUrl,
    resolve,
    sameSite,
    webAppFromManifest,
    webAppFromPage,
} from '../util/webapp';
import type { WebAppInfo } from '../util/webapp';
import { log } from '../log';

export type { WebAppInfo } from '../util/webapp';

/**
 * Where a web app opens.
 *
 * `window` is a real Chromium `--app=` window: frameless, single-site, and -
 * the part that matters on this machine - it exports MPRIS, so the tray
 * transport controls whatever is playing in it. `editor` keeps it inside the
 * kiosk, in the screencast browser. Chosen per app when it is installed,
 * because which one is right depends entirely on the app.
 */
export type OpenIn = 'window' | 'editor';

export interface InstalledWebApp {
    id: string;
    name: string;
    description: string;
    url: string;
    openIn: OpenIn;
    installedAt: number;
    /** Absolute path of the downloaded icon, when there was one to download. */
    iconFile?: string;
    /** Absolute path of the desktop entry, absent when it could not be written. */
    desktopFile?: string;
}

/** Icons are launcher tiles, not wallpapers; anything larger is a mistake. */
const MAX_ICON_BYTES = 512 * 1024;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;

/** The URI the desktop entry of an editor-mode app hands back to the editor. */
export const WEBAPP_URI = 'vscode://vscodeos.vscodeos-core/webapp';

/** Where `code` is on both images, and what to fall back to off them. */
function codeCommand(): string {
    return which('/opt/visual-studio-code/bin/code') ?? which('code') ?? 'code';
}

const ICON_TYPES: Record<string, string> = {
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
};

function dataHome(): string {
    return process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
}

export interface InstallResult {
    ok: boolean;
    app?: InstalledWebApp;
    message?: string;
}

export class WebAppService extends EventEmitter {
    private cache: InstalledWebApp[] | undefined;

    private get root(): string {
        return path.join(dataHome(), 'vscodeos', 'webapps');
    }

    private get registryFile(): string {
        return path.join(this.root, 'apps.json');
    }

    private get iconDir(): string {
        return path.join(this.root, 'icons');
    }

    private get applicationsDir(): string {
        return path.join(dataHome(), 'applications');
    }

    // ------------------------------------------------------------- registry

    async list(): Promise<InstalledWebApp[]> {
        if (this.cache) {
            return this.cache;
        }
        let apps: InstalledWebApp[] = [];
        try {
            const parsed: unknown = JSON.parse(await fs.readFile(this.registryFile, 'utf8'));
            if (Array.isArray(parsed)) {
                apps = parsed.filter(isWebApp);
            }
        } catch {
            // Nothing installed yet, or a file we cannot read; either way the
            // answer is an empty list rather than an error nobody can act on.
        }
        apps.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
        this.cache = apps;
        return apps;
    }

    async isInstalled(id: string): Promise<boolean> {
        return (await this.list()).some((app) => app.id === id);
    }

    /**
     * The installed app for an address, if there is one.
     *
     * Matched by origin rather than by id, because an app is installed at its
     * manifest's `start_url` and that is usually a deeper path than the address
     * it was found at. See `sameSite` in util/webapp.ts.
     */
    async findForUrl(url: string): Promise<InstalledWebApp | undefined> {
        return (await this.list()).find((app) => sameSite(app.url, url));
    }

    private async save(apps: InstalledWebApp[]): Promise<void> {
        await fs.mkdir(this.root, { recursive: true });
        await fs.writeFile(this.registryFile, `${JSON.stringify(apps, null, 2)}\n`, 'utf8');
        this.cache = apps;
        this.emit('change');
    }

    // -------------------------------------------------------------- discovery

    /**
     * Everything a site says about itself as an app.
     *
     * The manifest is the good answer and most sites worth installing have one.
     * The rest still have a <title>, a description and a favicon, which makes a
     * perfectly usable launcher entry - refusing to install those would mean
     * refusing most of the web for the sake of a spec.
     */
    async discover(address: string): Promise<{ ok: true; info: WebAppInfo } | { ok: false; message: string }> {
        const url = normaliseSiteUrl(address);
        if (!url) {
            return { ok: false, message: `"${address}" is not a web address.` };
        }

        const page = await http.get(url, { maxBytes: MAX_PAGE_BYTES });
        if (!page.ok) {
            return {
                ok: false,
                message: page.status > 0
                    ? `${hostOf(url)} answered ${page.status}.`
                    : `Could not reach ${hostOf(url)}.`,
            };
        }
        const html = page.body.toString('utf8');
        // page.url is where the body actually came from, so a site that
        // redirects http -> https -> /app installs at the address it settled on.
        const pageUrl = page.url;

        const href = manifestHref(html);
        const manifestUrl = href ? resolve(pageUrl, href) : undefined;
        if (manifestUrl) {
            const manifest = await http.getJson(manifestUrl, { maxBytes: MAX_MANIFEST_BYTES });
            const info = manifest ? webAppFromManifest(manifest, manifestUrl, pageUrl) : undefined;
            if (info) {
                return { ok: true, info };
            }
            log.debug(`manifest at ${manifestUrl} was unusable; falling back to the page`);
        }

        return { ok: true, info: webAppFromPage(html, pageUrl) };
    }

    // --------------------------------------------------------------- install

    async install(info: WebAppInfo, openIn: OpenIn): Promise<InstallResult> {
        try {
            // Reinstalling replaces, and "the same app" is the same site rather
            // than the same id - a site reached two ways installs at one
            // start_url, and two rows for it would both claim the same window.
            const existing = await this.list();
            const superseded = existing.filter((app) => app.id === info.id || sameSite(app.url, info.url));
            for (const app of superseded) {
                await this.removeFiles(app);
            }
            const apps = existing.filter((app) => !superseded.includes(app));
            const iconFile = info.iconUrl ? await this.downloadIcon(info.id, info.iconUrl) : undefined;

            const app: InstalledWebApp = {
                id: info.id,
                name: info.name || hostOf(info.url),
                description: info.description || hostOf(info.url),
                url: info.url,
                openIn,
                installedAt: Date.now(),
                iconFile,
            };
            app.desktopFile = await this.writeDesktopEntry(app);

            apps.push(app);
            apps.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
            await this.save(apps);
            log.info(`installed web app ${app.id} (${app.url})`);
            return { ok: true, app };
        } catch (error) {
            log.error(`could not install ${info.url}`, error);
            return { ok: false, message: error instanceof Error ? error.message : String(error) };
        }
    }

    async uninstall(id: string): Promise<boolean> {
        const apps = await this.list();
        const app = apps.find((candidate) => candidate.id === id);
        if (!app) {
            return false;
        }
        await this.removeFiles(app);
        await this.save(apps.filter((candidate) => candidate.id !== id));
        log.info(`uninstalled web app ${id}`);
        return true;
    }

    /** The icon and the desktop entry. Never fatal: a missing file is the goal. */
    private async removeFiles(app: InstalledWebApp): Promise<void> {
        for (const file of [app.iconFile, app.desktopFile]) {
            if (file) {
                await fs.rm(file, { force: true }).catch(() => undefined);
            }
        }
    }

    /** Change where an installed app opens, without reinstalling it. */
    async setOpenIn(id: string, openIn: OpenIn): Promise<void> {
        const apps = await this.list();
        const app = apps.find((candidate) => candidate.id === id);
        if (!app || app.openIn === openIn) {
            return;
        }
        app.openIn = openIn;
        // The Exec line encodes the choice, so the desktop entry has to follow.
        app.desktopFile = await this.writeDesktopEntry(app);
        await this.save(apps);
    }

    private async downloadIcon(id: string, url: string): Promise<string | undefined> {
        const response = await http.get(url, { maxBytes: MAX_ICON_BYTES, accept: 'image/*' });
        if (!response.ok || response.body.length === 0) {
            log.debug(`no icon for ${id}: ${url}`);
            return undefined;
        }
        const extension = extensionFor(url, response.contentType);
        const file = path.join(this.iconDir, `${id}${extension}`);
        await fs.mkdir(this.iconDir, { recursive: true });
        await fs.writeFile(file, response.body);
        return file;
    }

    /**
     * The desktop entry, so the app exists to the rest of the machine and not
     * only to this shell. `StartupWMClass` is what lets a window manager match
     * the Chromium app window back to this entry.
     */
    private async writeDesktopEntry(app: InstalledWebApp): Promise<string | undefined> {
        const file = path.join(this.applicationsDir, `vscodeos-webapp-${app.id}.desktop`);
        const exec = this.execLine(app);
        const lines = [
            '[Desktop Entry]',
            'Type=Application',
            `Name=${escapeDesktopValue(app.name)}`,
            `Comment=${escapeDesktopValue(app.description)}`,
            `Exec=${escapeDesktopExec(exec)}`,
            app.iconFile ? `Icon=${escapeDesktopValue(app.iconFile)}` : undefined,
            'Terminal=false',
            'Categories=Network;X-WebApps;',
            `StartupWMClass=${escapeDesktopValue(`chrome-${hostOf(app.url)}__-Default`)}`,
            `X-VSCodeOS-WebApp=${app.id}`,
            '',
        ].filter((line): line is string => line !== undefined);

        try {
            await fs.mkdir(this.applicationsDir, { recursive: true });
            await fs.writeFile(file, lines.join('\n'), 'utf8');
            return file;
        } catch (error) {
            // Not fatal: the app still works from All Apps, it is only invisible
            // to other launchers.
            log.debug(`could not write ${file}: ${String(error)}`);
            return undefined;
        }
    }

    private execLine(app: InstalledWebApp): string {
        if (app.openIn === 'editor') {
            // Nothing outside the editor can open an editor tab, so the entry
            // hands the app back to the running VS Code the same way the Print
            // key does - `code --open-url` and the URI handler in extension.ts.
            return `${codeCommand()} --open-url "${WEBAPP_URI}?id=${encodeURIComponent(app.id)}"`;
        }
        const detected = browser.detect();
        return detected?.chromiumLike
            ? `${detected.command} --app=${app.url}`
            : `xdg-open ${app.url}`;
    }

    // ---------------------------------------------------------------- launch

    /** The icon as a data URI, for the webviews that list these apps. */
    async iconDataUri(app: InstalledWebApp): Promise<string | undefined> {
        if (!app.iconFile) {
            return undefined;
        }
        try {
            const bytes = await fs.readFile(app.iconFile);
            if (bytes.length > MAX_ICON_BYTES) {
                return undefined;
            }
            const mime = ICON_TYPES[path.extname(app.iconFile).toLowerCase()] ?? 'image/png';
            return `data:${mime};base64,${bytes.toString('base64')}`;
        } catch {
            return undefined;
        }
    }

    dispose(): void {
        this.removeAllListeners();
    }
}

function isWebApp(value: unknown): value is InstalledWebApp {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const app = value as Partial<InstalledWebApp>;
    return typeof app.id === 'string' && typeof app.name === 'string' && typeof app.url === 'string';
}

/** Extension for a downloaded icon, from the URL first and the content type second. */
function extensionFor(url: string, contentType: string): string {
    let fromUrl = '';
    try {
        fromUrl = path.extname(new URL(url).pathname).toLowerCase();
    } catch {
        fromUrl = '';
    }
    if (ICON_TYPES[fromUrl]) {
        return fromUrl;
    }
    const mime = contentType.split(';')[0].trim().toLowerCase();
    const match = Object.entries(ICON_TYPES).find(([, value]) => value === mime);
    return match?.[0] ?? '.png';
}
