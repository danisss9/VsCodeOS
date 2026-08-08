// The web browser, inside the editor.
//
// A webview cannot simply <iframe> the web: every site worth visiting sends
// X-Frame-Options or frame-ancestors, which is why VS Code's own Simple Browser
// shows a blank rectangle on most of them. The way to render arbitrary pages is
// to run a real browser and stream its picture, so that is what this does:
//
//   * puppeteer-core launches the Chromium that both images already ship,
//     headless, with no profile of its own beyond a scratch directory;
//   * CDP's Page.startScreencast pushes JPEG frames, which the webview draws
//     into an <img>;
//   * pointer and key events go back the other way through Input.dispatch*.
//
// That is not free - it is a JPEG encode and decode per frame - so the frame
// rate and quality are settings, the stream stops the moment the tab is hidden,
// and there is an "Open in browser" button for the times when a real window is
// simply the better answer (video, WebGL, a Pi under load).

import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
// puppeteer-core is ESM-only, and this file compiles as CommonJS. The runtime
// side is a dynamic import, which is legal from CJS; the types need to be told
// to resolve the same way.
import type { Browser as PuppeteerBrowser, CDPSession, Page } from 'puppeteer-core' with { 'resolution-mode': 'import' };
import { detect, open as openExternally } from '../sys/browser';
import type { WebAppService } from '../sys/webapps';
import { normaliseAddress } from '../util/url';
import { AppPanels } from './panels';
import type { AppOptions } from './panels';
import type { BrowserInput, BrowserState, BrowserTab, HostMessage, WebviewMessage } from '../webview/protocol';
import { log } from '../log';

const PANEL: AppOptions = {
    id: 'browser',
    title: 'Web Browser',
    script: 'browser',
    icon: 'browser',
};

/**
 * Chromium flags that matter on the machines this ships to.
 *
 * Note what is *not* here: --no-sandbox. This process renders whatever the web
 * hands it, on a desktop session with the user's own files - it keeps its
 * sandbox. The kiosk user is unprivileged and Arch's chromium sandboxes through
 * user namespaces, so there is nothing to work around.
 */
const LAUNCH_ARGS = [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
];

interface Tab {
    id: string;
    page: Page;
    session?: CDPSession;
}

export class Browser implements vscode.Disposable {
    private browser: PuppeteerBrowser | undefined;
    private starting: Promise<PuppeteerBrowser | undefined> | undefined;
    private profileDir: string | undefined;
    private readonly tabs: Tab[] = [];
    private activeId: string | undefined;
    private streaming = false;
    private viewport = { width: 1280, height: 800 };
    private nextId = 1;
    /** Where to go once the webview has told us how big it is. */
    private pending: string | undefined;

    constructor(
        private readonly panels: AppPanels,
        private readonly webApps: WebAppService,
    ) {}

    private get config(): vscode.WorkspaceConfiguration {
        return vscode.workspace.getConfiguration('vscodeos');
    }

    async open(url?: string): Promise<void> {
        const target = normaliseAddress(url ?? this.config.get<string>('browser.homepage', 'https://duckduckgo.com'));
        const existed = this.panels.get(PANEL.id) !== undefined;

        const panel = this.panels.open({
            ...PANEL,
            onMessage: (message) => this.handle(message),
            onDispose: () => void this.shutdown(),
        });
        if (!existed) {
            // Only once per panel: re-opening the app must not stack listeners.
            // Streaming frames into a hidden tab is pure waste, and on a Pi it is
            // waste that is felt.
            panel.onDidChangeViewState(() => void this.setStreaming(panel.visible));
        }

        if (existed && url) {
            await this.navigate(target);
        } else if (existed) {
            panel.reveal();
        } else {
            this.pending = target;
        }
    }

    private post(message: HostMessage): void {
        void this.panels.get(PANEL.id)?.webview.postMessage(message);
    }

    // ------------------------------------------------------------- lifecycle

    private async launch(): Promise<PuppeteerBrowser | undefined> {
        if (this.browser) {
            return this.browser;
        }
        if (this.starting) {
            return this.starting;
        }
        this.starting = (async () => {
            const chromium = detect(this.config.get<string>('browser.command') || undefined);
            if (!chromium || !chromium.chromiumLike) {
                this.post({
                    type: 'browserError',
                    message: 'No Chromium-based browser is installed. Run: sudo pacman -S chromium',
                    fatal: true,
                });
                return undefined;
            }
            try {
                // A profile per session, thrown away on close: the point of this
                // browser is to render pages, not to be somebody's daily driver
                // with a cookie jar the editor has to look after.
                this.profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vscodeos-browser-'));
                const puppeteer = await import('puppeteer-core');
                this.browser = await puppeteer.launch({
                    executablePath: chromium.command,
                    headless: true,
                    args: LAUNCH_ARGS,
                    userDataDir: this.profileDir,
                    defaultViewport: this.viewport,
                    protocolTimeout: 60000,
                });
                log.info(`browser engine started: ${chromium.name}`);
                return this.browser;
            } catch (error) {
                log.error('could not start the browser engine', error);
                this.post({
                    type: 'browserError',
                    message: `Could not start ${chromium.name}: ${error instanceof Error ? error.message : String(error)}`,
                    fatal: true,
                });
                return undefined;
            } finally {
                this.starting = undefined;
            }
        })();
        return this.starting;
    }

    private get active(): Tab | undefined {
        return this.tabs.find((tab) => tab.id === this.activeId) ?? this.tabs[0];
    }

    private async newTab(url: string): Promise<Tab | undefined> {
        const browser = await this.launch();
        if (!browser) {
            return undefined;
        }
        const page = await browser.newPage();
        await page.setViewport(this.viewport);
        const tab: Tab = { id: `tab-${this.nextId++}`, page };
        this.tabs.push(tab);
        this.activeId = tab.id;

        page.on('framenavigated', () => this.pushState());
        page.on('load', () => this.pushState());
        page.on('close', () => {
            const index = this.tabs.findIndex((candidate) => candidate.id === tab.id);
            if (index >= 0) {
                this.tabs.splice(index, 1);
            }
            if (this.activeId === tab.id) {
                this.activeId = this.tabs[this.tabs.length - 1]?.id;
                void this.setStreaming(this.streaming);
            }
            this.pushState();
        });

        await this.goto(tab, url);
        return tab;
    }

    private async goto(tab: Tab, url: string): Promise<void> {
        try {
            await tab.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        } catch (error) {
            // A navigation timeout still leaves a usable half-loaded page, and
            // the address bar has already moved on; only say something for the
            // failures that leave nothing at all.
            log.debug(`navigation to ${url} failed: ${String(error)}`);
            this.post({
                type: 'browserError',
                message: `Could not load ${url}`,
            });
        }
        await this.pushState();
    }

    private async navigate(url: string): Promise<void> {
        const tab = this.active;
        if (!tab) {
            await this.newTab(url);
            await this.setStreaming(true);
            return;
        }
        await this.goto(tab, url);
    }

    // ------------------------------------------------------------ screencast

    private async setStreaming(on: boolean): Promise<void> {
        this.streaming = on;
        const tab = this.active;
        if (!tab) {
            return;
        }
        try {
            if (!on) {
                await tab.session?.send('Page.stopScreencast');
                return;
            }
            if (!tab.session) {
                tab.session = await tab.page.createCDPSession();
                await tab.session.send('Page.enable');
                tab.session.on('Page.screencastFrame', (frame: { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } }) => {
                    this.post({
                        type: 'browserFrame',
                        data: frame.data,
                        width: frame.metadata.deviceWidth || this.viewport.width,
                        height: frame.metadata.deviceHeight || this.viewport.height,
                    });
                    // Acknowledging is what asks for the next frame; without it
                    // the stream stops after a handful.
                    void tab.session?.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined);
                });
            }
            await tab.session.send('Page.startScreencast', {
                format: 'jpeg',
                quality: this.config.get<number>('browser.quality', 65),
                maxWidth: this.viewport.width,
                maxHeight: this.viewport.height,
                everyNthFrame: Math.max(1, Math.round(60 / this.config.get<number>('browser.frameRate', 15))),
            });
        } catch (error) {
            log.debug(`screencast toggle failed: ${String(error)}`);
        }
    }

    private async pushState(): Promise<void> {
        const tab = this.active;
        if (!tab) {
            this.post({
                type: 'browserState',
                state: { url: '', title: '', loading: false, canGoBack: false, canGoForward: false, tabs: [] },
            });
            return;
        }
        let title = '';
        let url = '';
        try {
            url = tab.page.url();
            title = await tab.page.title();
        } catch {
            // The page can go away between the check and the call.
        }
        const tabs: BrowserTab[] = await Promise.all(this.tabs.map(async (candidate) => ({
            id: candidate.id,
            title: (await candidate.page.title().catch(() => '')) || candidate.page.url() || 'New tab',
            active: candidate.id === this.active?.id,
        })));

        const history = await this.historyFlags(tab);
        const state: BrowserState = {
            url,
            title,
            loading: false,
            ...history,
            tabs,
            installable: await this.installable(tab, url, title),
        };
        this.post({ type: 'browserState', state });
    }

    /**
     * Whether the page in front of you is installable as an app.
     *
     * This is the one place in the shell that can answer that question the way
     * a browser does, because it *is* a browser: the page is loaded, so the
     * manifest link is right there in the DOM. Everywhere else has to fetch the
     * page again to find out.
     */
    private async installable(tab: Tab, url: string, title: string): Promise<BrowserState['installable']> {
        if (!url.startsWith('http') || !this.config.get<boolean>('webApps.enabled', true)) {
            return undefined;
        }
        try {
            const href = await tab.page.evaluate(
                () => document.querySelector<HTMLLinkElement>('link[rel~="manifest"]')?.href ?? '',
            );
            if (!href) {
                return undefined;
            }
            // Offering to install something that is already installed is a
            // button that does nothing useful, so it hides once it has been used.
            return (await this.webApps.findForUrl(url)) ? undefined : { url, name: title || url };
        } catch {
            // Mid-navigation, or a page that will not run script for us.
            return undefined;
        }
    }

    /**
     * Whether back and forward would do anything. Puppeteer has no accessor for
     * this, but the CDP navigation history has both the entries and the index.
     */
    private async historyFlags(tab: Tab): Promise<{ canGoBack: boolean; canGoForward: boolean }> {
        try {
            const session = tab.session ?? (await tab.page.createCDPSession());
            tab.session = session;
            const history = await session.send('Page.getNavigationHistory');
            return {
                canGoBack: history.currentIndex > 0,
                canGoForward: history.currentIndex < history.entries.length - 1,
            };
        } catch {
            return { canGoBack: false, canGoForward: false };
        }
    }

    // --------------------------------------------------------------- input

    private async dispatch(input: BrowserInput): Promise<void> {
        const session = this.active?.session;
        if (!session) {
            return;
        }
        try {
            if (input.kind === 'mouse') {
                await session.send('Input.dispatchMouseEvent', {
                    type: input.type,
                    x: input.x,
                    y: input.y,
                    button: input.button,
                    buttons: input.buttons,
                    clickCount: input.clickCount,
                    modifiers: input.modifiers,
                });
                return;
            }
            if (input.kind === 'wheel') {
                await session.send('Input.dispatchMouseEvent', {
                    type: 'mouseWheel',
                    x: input.x,
                    y: input.y,
                    deltaX: input.deltaX,
                    deltaY: input.deltaY,
                    modifiers: input.modifiers,
                });
                return;
            }
            await session.send('Input.dispatchKeyEvent', {
                type: input.type,
                key: input.key,
                code: input.code,
                text: input.text,
                unmodifiedText: input.text,
                windowsVirtualKeyCode: input.windowsVirtualKeyCode,
                nativeVirtualKeyCode: input.windowsVirtualKeyCode,
                modifiers: input.modifiers,
            });
        } catch (error) {
            log.debug(`input dispatch failed: ${String(error)}`);
        }
    }

    // ------------------------------------------------------------- messages

    private async handle(message: WebviewMessage): Promise<void> {
        switch (message.type) {
            case 'ready': {
                const target = this.pending ?? this.config.get<string>('browser.homepage', 'https://duckduckgo.com');
                this.pending = undefined;
                if (this.tabs.length === 0) {
                    await this.newTab(normaliseAddress(target));
                }
                await this.setStreaming(true);
                await this.pushState();
                return;
            }

            case 'browserResize': {
                const width = Math.max(320, Math.round(message.width));
                const height = Math.max(240, Math.round(message.height));
                if (width === this.viewport.width && height === this.viewport.height) {
                    return;
                }
                this.viewport = { width, height };
                for (const tab of this.tabs) {
                    await tab.page.setViewport(this.viewport).catch(() => undefined);
                }
                if (this.streaming) {
                    await this.setStreaming(true);
                }
                return;
            }

            case 'browserNavigate':
                await this.navigate(normaliseAddress(message.url));
                return;

            case 'browserGo': {
                const tab = this.active;
                if (!tab) {
                    return;
                }
                if (message.action === 'back') {
                    await tab.page.goBack().catch(() => undefined);
                } else if (message.action === 'forward') {
                    await tab.page.goForward().catch(() => undefined);
                } else if (message.action === 'reload') {
                    await tab.page.reload().catch(() => undefined);
                } else if (message.action === 'home') {
                    await this.navigate(normaliseAddress(this.config.get<string>('browser.homepage', 'https://duckduckgo.com')));
                } else {
                    await tab.session?.send('Page.stopLoading').catch(() => undefined);
                }
                await this.pushState();
                return;
            }

            case 'browserTab': {
                if (message.action === 'new') {
                    await this.newTab(normaliseAddress(this.config.get<string>('browser.homepage', 'https://duckduckgo.com')));
                    await this.setStreaming(true);
                } else if (message.action === 'select' && message.id) {
                    this.activeId = message.id;
                    await this.setStreaming(true);
                } else if (message.action === 'close' && message.id) {
                    const tab = this.tabs.find((candidate) => candidate.id === message.id);
                    await tab?.page.close().catch(() => undefined);
                }
                await this.pushState();
                return;
            }

            case 'browserInput':
                await this.dispatch(message.input);
                return;

            case 'browserExternal': {
                const url = this.active?.page.url();
                if (url && !openExternally(url, { preferred: this.config.get<string>('browser.command') || undefined })) {
                    void vscode.window.showErrorMessage('No browser is installed to hand this page to.');
                }
                return;
            }

            case 'browserInstallApp': {
                const url = this.active?.page.url();
                if (url) {
                    // The Marketplace owns the install flow - reading the
                    // manifest, asking where the app should open, reporting the
                    // result - so this is the same three steps either way in.
                    await vscode.commands.executeCommand('vscodeos.webApps.install', url);
                }
                return;
            }

            default:
                return;
        }
    }

    // -------------------------------------------------------------- teardown

    private async shutdown(): Promise<void> {
        this.streaming = false;
        this.tabs.length = 0;
        this.activeId = undefined;
        const browser = this.browser;
        this.browser = undefined;
        try {
            await browser?.close();
        } catch (error) {
            log.debug(`browser close failed: ${String(error)}`);
        }
        if (this.profileDir) {
            await fs.rm(this.profileDir, { recursive: true, force: true }).catch(() => undefined);
            this.profileDir = undefined;
        }
    }

    dispose(): void {
        void this.shutdown();
    }
}
