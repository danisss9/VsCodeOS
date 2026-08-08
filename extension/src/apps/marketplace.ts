// The Marketplace.
//
// Where web apps come from. A curated list to browse (apps/webAppCatalogue.ts)
// and a box to paste an address into, because the list can never be complete
// and a store that only offers what somebody else chose is not much of a store.
//
// Either route ends in the same place: fetch the site, read its manifest, ask
// where it should open, install. The catalogue supplies a URL and nothing more,
// so what actually gets installed is whatever the site says about itself.
//
// This is deliberately not called an "app store": nothing is bought, nothing is
// reviewed, and nothing is downloaded but an icon.

import * as vscode from 'vscode';
import * as browserSys from '../sys/browser';
import type { OpenIn, WebAppService } from '../sys/webapps';
import { appIdFromUrl, hostOf, sameSite } from '../util/webapp';
import { CATALOGUE, CATEGORIES } from './webAppCatalogue';
import { AppPanels } from './panels';
import type { AppOptions } from './panels';
import type { HostMessage, MarketplaceItem, MarketplaceState, WebviewMessage } from '../webview/protocol';
import { log } from '../log';

const PANEL: AppOptions = {
    id: 'marketplace',
    title: 'Marketplace',
    script: 'marketplace',
    icon: 'marketplace',
};

export class Marketplace {
    private category: string = CATEGORIES[1];

    constructor(
        private readonly panels: AppPanels,
        private readonly webApps: WebAppService,
    ) {}

    open(): void {
        const existed = this.panels.get(PANEL.id) !== undefined;
        this.panels.open({ ...PANEL, onMessage: (message) => this.handle(message) });
        if (existed) {
            void this.refresh();
        }
    }

    private post(message: HostMessage): void {
        void this.panels.get(PANEL.id)?.webview.postMessage(message);
    }

    private async handle(message: WebviewMessage): Promise<void> {
        try {
            switch (message.type) {
                case 'ready':
                    await this.refresh();
                    return;

                case 'marketplaceCategory':
                    this.category = message.category;
                    await this.refresh();
                    return;

                case 'installWebApp':
                    await this.install(message.url);
                    return;

                case 'uninstallApp': {
                    const choice = await vscode.window.showWarningMessage(
                        `Uninstall "${message.name}"?`,
                        { modal: true, detail: 'The app and its shortcut are removed.' },
                        'Uninstall',
                    );
                    if (choice === 'Uninstall') {
                        await this.webApps.uninstall(message.id);
                    }
                    await this.refresh();
                    return;
                }

                case 'launchApp':
                    await vscode.commands.executeCommand('vscodeos.webApps.launch', message.id);
                    return;

                case 'openExternal':
                    await vscode.commands.executeCommand('vscodeos.browser.open', message.path);
                    return;

                default:
                    return;
            }
        } catch (error) {
            log.error('marketplace', error);
            void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        }
    }

    private async refresh(): Promise<void> {
        const installed = await this.webApps.list();

        // Matched by site, not by id: an app installs at its manifest's
        // start_url, which is usually deeper than the catalogue's address, so
        // https://docs.google.com lands as .../document/u/0/. Comparing ids
        // would leave every installed catalogue app still offering "Install"
        // and appear a second time under Installed.
        const matched = new Set<string>();
        const items: MarketplaceItem[] = CATALOGUE.map((entry) => {
            const app = installed.find((candidate) => sameSite(candidate.url, entry.url));
            if (app) {
                matched.add(app.id);
            }
            return {
                id: entry.id,
                // The real id when it is installed, so Open and Uninstall reach it.
                appId: app?.id ?? appIdFromUrl(entry.url),
                name: entry.name,
                description: entry.description,
                url: entry.url,
                category: entry.category,
                keywords: entry.keywords,
                installed: app !== undefined,
            };
        });

        // Anything installed from a pasted URL is not in the catalogue, and the
        // Installed tab would be a lie without it.
        for (const app of installed) {
            if (!matched.has(app.id)) {
                items.push({
                    id: `installed-${app.id}`,
                    appId: app.id,
                    name: app.name,
                    description: app.description,
                    url: app.url,
                    category: 'Installed',
                    installed: true,
                });
            }
        }

        const state: MarketplaceState = {
            category: this.category,
            categories: [...CATEGORIES],
            items,
            canOpenWindows: browserSys.detect()?.chromiumLike === true,
        };
        this.post({ type: 'marketplace', state });
    }

    /**
     * Install whatever is at an address.
     *
     * Three steps the user sees: reading the site, choosing where it opens, and
     * the result. The middle one is a quick pick rather than a setting, because
     * the answer is different for a music service (its own window, so Chromium
     * exports MPRIS and the tray can control it) and a wiki (an editor tab, so
     * it stays inside the kiosk).
     */
    async install(address: string): Promise<void> {
        this.post({ type: 'marketplaceBusy', label: `Reading ${hostOf(address) || address}…` });
        const found = await this.webApps.discover(address);
        if (!found.ok) {
            this.post({ type: 'marketplaceBusy' });
            void vscode.window.showErrorMessage(found.message);
            await this.refresh();
            return;
        }

        const info = found.info;
        const openIn = await this.askWhereToOpen(info.name);
        if (!openIn) {
            this.post({ type: 'marketplaceBusy' });
            await this.refresh();
            return;
        }

        this.post({ type: 'marketplaceBusy', label: `Installing ${info.name}…` });
        const result = await this.webApps.install(info, openIn);
        this.post({ type: 'marketplaceBusy' });
        await this.refresh();

        if (!result.ok) {
            void vscode.window.showErrorMessage(`${info.name} could not be installed: ${result.message}`);
            return;
        }
        const open = 'Open it';
        const choice = await vscode.window.showInformationMessage(
            `${info.name} is installed. You will find it in All Apps.`
            + (info.fromManifest ? '' : ' The site published no app manifest, so its name and icon come from the page.'),
            open,
        );
        if (choice === open) {
            await vscode.commands.executeCommand('vscodeos.webApps.launch', info.id);
        }
    }

    private async askWhereToOpen(name: string): Promise<OpenIn | undefined> {
        const chromium = browserSys.detect()?.chromiumLike === true;
        const items: (vscode.QuickPickItem & { value: OpenIn })[] = [
            {
                value: 'window',
                label: '$(multiple-windows) Its own window',
                description: chromium ? undefined : 'No Chromium-like browser installed',
                detail: chromium
                    ? 'A frameless single-site window. Media keys and the tray transport work, because Chromium exports MPRIS.'
                    : 'Falls back to opening the page in whatever browser is installed.',
            },
            {
                value: 'editor',
                label: '$(browser) An editor tab',
                detail: 'Stays inside the editor, in the built-in browser. Heavier, and no media keys.',
            },
        ];
        const picked = await vscode.window.showQuickPick(items, {
            title: `Where should ${name} open?`,
            placeHolder: 'This can be changed later from All Apps',
            ignoreFocusOut: true,
        });
        return picked?.value;
    }
}
