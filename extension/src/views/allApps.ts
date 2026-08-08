// All Apps, in the activity bar.
//
// This used to be a card in the tray, opened from a $(menu) button in the
// bottom-left corner of the status bar. A start menu is not a tray item: it is
// the one place you go to find anything on the machine, and the activity bar is
// where VS Code puts the things you go to. So it is a view of its own, with an
// icon that is always there rather than a button competing with the status bar.
//
// The list is three sources merged into one grid:
//
//   builtin  the shell's own apps, from apps/registry.ts
//   webapp   PWAs installed through the Marketplace, from sys/webapps.ts
//   system   everything else on the machine, from its .desktop files
//
// Only the middle one can be uninstalled, because it is the only one this shell
// installed. Removing a pacman package would mean a password-free path to root
// for arbitrary package removal, and that is not a trade worth making for a
// context menu item.

import * as vscode from 'vscode';
import * as appIcons from '../sys/appIcons';
import * as desktopApps from '../sys/desktopApps';
import type { WebAppService } from '../sys/webapps';
import { availableApps } from '../apps/registry';
import { render, webviewOptions } from '../webview/html';
import type { AllAppsState, AppEntry, HostMessage, OpenIn, WebviewMessage } from '../webview/protocol';
import { log } from '../log';

export class AllAppsProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    static readonly viewId = 'vscodeos.allApps';

    private view: vscode.WebviewView | undefined;
    private readonly unsubscribe: () => void;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly webApps: WebAppService,
    ) {
        // Installing or removing an app anywhere - the Marketplace, the browser's
        // install button, this view's own context menu - redraws this grid.
        const onChange = (): void => void this.refresh();
        this.webApps.on('change', onChange);
        this.unsubscribe = () => this.webApps.off('change', onChange);
    }

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options = webviewOptions(this.context);
        view.webview.html = render(view.webview, this.context, { title: 'All Apps', script: 'allapps' });

        view.webview.onDidReceiveMessage((message: WebviewMessage) => void this.handle(message));
        view.onDidChangeVisibility(() => {
            if (view.visible) {
                void this.refresh();
            }
        });
        view.onDidDispose(() => (this.view = undefined));
    }

    private post(message: HostMessage): void {
        void this.view?.webview.postMessage(message);
    }

    private get config(): vscode.WorkspaceConfiguration {
        return vscode.workspace.getConfiguration('vscodeos');
    }

    /**
     * Rebuild the list. Only while the view is on screen: scanning every
     * .desktop file on the machine and base64-ing their icons is not work to do
     * because somebody installed an app in a tab nobody is looking at.
     */
    private async refresh(): Promise<void> {
        if (!this.view?.visible) {
            return;
        }
        const showSystem = this.config.get<boolean>('allApps.systemApps', true);
        const webAppsEnabled = this.config.get<boolean>('webApps.enabled', true);

        const apps: AppEntry[] = availableApps(this.config);
        try {
            if (webAppsEnabled) {
                apps.push(...(await this.webAppEntries()));
            }
            if (showSystem) {
                apps.push(...(await this.systemEntries()));
            }
        } catch (error) {
            log.error('all apps', error);
        }

        const state: AllAppsState = { apps, systemApps: showSystem, webApps: webAppsEnabled };
        this.post({ type: 'apps', state });
    }

    private async webAppEntries(): Promise<AppEntry[]> {
        const installed = await this.webApps.list();
        return Promise.all(installed.map(async (app) => ({
            id: app.id,
            title: app.name,
            description: app.description,
            icon: 'globe',
            command: '',
            keywords: ['web app', 'pwa', app.url],
            source: 'webapp' as const,
            iconUrl: await this.webApps.iconDataUri(app),
            removable: true,
            openIn: app.openIn,
            url: app.url,
        })));
    }

    private async systemEntries(): Promise<AppEntry[]> {
        const installed = await desktopApps.list();
        return Promise.all(installed.map(async (app) => ({
            id: app.id,
            title: app.name,
            description: app.description,
            icon: 'package',
            command: '',
            keywords: [...app.keywords, ...app.categories],
            source: 'system' as const,
            iconUrl: await appIcons.dataUri(app.icon),
        })));
    }

    // -------------------------------------------------------------- messages

    private async handle(message: WebviewMessage): Promise<void> {
        try {
            switch (message.type) {
                case 'ready':
                case 'refreshApps':
                    // Nothing watches the application or icon directories, so
                    // this is what picks up something installed from a terminal.
                    desktopApps.refresh();
                    appIcons.clearCache();
                    await this.refresh();
                    return;

                case 'launchApp':
                    await this.launch(message.source, message.id);
                    return;

                case 'uninstallApp':
                    await this.uninstall(message.id, message.name);
                    return;

                case 'setAppOpenIn':
                    await this.webApps.setOpenIn(message.id, message.openIn as OpenIn);
                    await this.refresh();
                    return;

                case 'command':
                    await vscode.commands.executeCommand(message.command);
                    return;

                default:
                    return;
            }
        } catch (error) {
            log.error('all apps', error);
            void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        }
    }

    private async launch(source: AppEntry['source'], id: string): Promise<void> {
        if (source === 'builtin') {
            const app = availableApps(this.config).find((candidate) => candidate.id === id);
            if (app) {
                await vscode.commands.executeCommand(app.command);
            }
            return;
        }
        if (source === 'webapp') {
            await vscode.commands.executeCommand('vscodeos.webApps.launch', id);
            return;
        }

        const app = (await desktopApps.list()).find((candidate) => candidate.id === id);
        if (!app) {
            await this.refresh();
            return;
        }
        if (app.terminal) {
            // A Terminal=true entry is a command-line program with a menu entry;
            // starting it detached would run it with nowhere to draw. The editor
            // has a terminal, so it goes there - and this is the one place the
            // argv has to become a command line again, so it is quoted rather
            // than joined. `/opt/My App/tool` is not two arguments.
            const terminal = vscode.window.createTerminal({ name: app.name });
            terminal.sendText(app.argv.map(shellQuote).join(' '));
            terminal.show();
            return;
        }
        if (!desktopApps.launch(app)) {
            void vscode.window.showErrorMessage(`${app.name} could not be started.`);
        }
    }

    private async uninstall(id: string, name: string): Promise<void> {
        const choice = await vscode.window.showWarningMessage(
            `Uninstall "${name}"?`,
            { modal: true, detail: 'The app and its shortcut are removed. Nothing on the site itself changes.' },
            'Uninstall',
        );
        if (choice !== 'Uninstall') {
            return;
        }
        if (await this.webApps.uninstall(id)) {
            void vscode.window.showInformationMessage(`Uninstalled ${name}.`);
        }
        await this.refresh();
    }

    dispose(): void {
        this.unsubscribe();
    }
}

/**
 * One argv element, safe to paste into a shell.
 *
 * Single quotes, because inside them a POSIX shell expands nothing at all; the
 * only character that needs work is the single quote itself, which has to be
 * closed, escaped and reopened.
 */
function shellQuote(argument: string): string {
    return /^[\w@%+=:,./-]+$/.test(argument)
        ? argument
        : `'${argument.replace(/'/g, `'\\''`)}'`;
}
