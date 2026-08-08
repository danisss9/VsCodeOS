// VsCodeOsCore - the VS Code OS desktop shell.
//
// VS Code OS has no desktop environment: the editor is the entire user
// interface. This extension supplies the parts of a desktop that the editor does
// not have - a launcher, a tray with power, clock, battery, volume, network and
// Bluetooth; a task manager; a file manager; a browser; a media player; an
// updater; and a handful of small apps - and is installed as a built-in
// extension in both images, so it is there on first boot.

import * as vscode from 'vscode';
import { AppPanels } from './apps/panels';
import { Browser } from './apps/browser';
import { FileExplorer } from './apps/fileExplorer';
import { Marketplace } from './apps/marketplace';
import { MediaPlayer } from './apps/mediaPlayer';
import { MiniApps } from './apps/miniApps';
import { MusicPlayer } from './apps/musicPlayer';
import { Firewall } from './apps/firewall';
import { SystemSettings } from './apps/systemSettings';
import { StatusBar } from './statusbar';
import { TrayMenus } from './statusbar/menus';
import { AllAppsProvider } from './views/allApps';
import { FlyoutProvider, runPowerAction } from './views/flyout';
import { TaskManagerProvider } from './views/taskManager';
import { MprisMonitor } from './sys/mpris';
import { NotificationServer } from './sys/notifications';
import { WebAppService } from './sys/webapps';
import * as audio from './sys/audio';
import * as browserSys from './sys/browser';
import * as display from './sys/display';
import * as keyboard from './sys/keyboard';
import { TRASH_PATH, TrashService } from './sys/trash';
import * as mpris from './sys/mpris';
import type { FlyoutKind } from './webview/protocol';
import { log } from './log';

export function activate(context: vscode.ExtensionContext): void {
    const channel = vscode.window.createOutputChannel('VS Code OS');
    context.subscriptions.push(channel);
    log.attach(channel);
    log.info(`VsCodeOsCore ${context.extension.packageJSON.version} activating`);

    const config = () => vscode.workspace.getConfiguration('vscodeos');

    const music = new MprisMonitor();
    context.subscriptions.push({ dispose: () => music.dispose() });
    if (config().get<boolean>('music.enabled', true)) {
        music.startWatching();
    }

    // --- notifications -----------------------------------------------------
    //
    // Started early: nothing else owns org.freedesktop.Notifications on either
    // image, and until this claims it every notify-send on the machine fails.
    const notifications = new NotificationServer(
        String(context.extension.packageJSON.version ?? '1.0.0'),
        config().get<number>('notifications.historyLimit', 50),
    );
    context.subscriptions.push({ dispose: () => notifications.dispose() });
    if (config().get<boolean>('notifications.enabled', true)) {
        void notifications.start();
    }

    // --- the tray ----------------------------------------------------------
    //
    // Two implementations of the same eight menus. Quick picks are the default
    // and are what a tray menu should be - a popup over the editor, gone on
    // Escape. The webview cards are richer (real sliders, a month grid, album
    // art) but they have to live in a container, which means taking the side
    // bar or the panel away from whatever was in it.

    const menus = new TrayMenus(music, notifications);
    context.subscriptions.push(menus);

    // Contributed to both the side bar and the bottom panel under a `when` on
    // vscodeos.flyout.location, so at most one of these ever resolves. Both are
    // registered because the setting can change without a reload.
    const flyout = new FlyoutProvider(context, music, notifications);
    for (const viewId of [FlyoutProvider.sidebarViewId, FlyoutProvider.panelViewId]) {
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider(viewId, flyout, {
                webviewOptions: { retainContextWhenHidden: true },
            }),
        );
    }

    /** Every tray item goes through here; the setting decides which one answers. */
    const showTray = (kind: FlyoutKind): Thenable<void> =>
        config().get<string>('flyout.location', 'popup') === 'popup'
            ? menus.show(kind)
            : flyout.show(kind);

    if (config().get<boolean>('statusBar.enabled', true)) {
        const statusBar = new StatusBar(music, notifications);
        statusBar.start();
        context.subscriptions.push(statusBar);
    }

    // --- task manager ------------------------------------------------------

    const taskManager = new TaskManagerProvider(context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(TaskManagerProvider.viewId, taskManager, {
            webviewOptions: { retainContextWhenHidden: true },
        }),
        taskManager,
    );

    // --- the recycle bin ---------------------------------------------------
    //
    // No view of its own any more: it is a place in the Files app, which is
    // where a bin belongs and where it can be browsed with the same columns and
    // the same selection as everything else.

    const trash = new TrashService();

    // --- apps --------------------------------------------------------------

    const webApps = new WebAppService();
    context.subscriptions.push({ dispose: () => webApps.dispose() });

    const allApps = new AllAppsProvider(context, webApps);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(AllAppsProvider.viewId, allApps, {
            webviewOptions: { retainContextWhenHidden: true },
        }),
        allApps,
    );

    const panels = new AppPanels(context);
    const files = new FileExplorer(context, trash);
    const apps = new MiniApps(panels);
    const player = new MediaPlayer(panels);
    const musicApp = new MusicPlayer(panels);
    const browser = new Browser(panels, webApps);
    const marketplace = new Marketplace(panels, webApps);
    const settings = new SystemSettings(panels);
    const firewall = new Firewall(panels);
    context.subscriptions.push(
        panels,
        apps,
        browser,
        { dispose: () => files.dispose() },
    );
    void apps.ensureDirectories();

    // X forgets the key repeat rate with the session, and there is no
    // system-wide place to put it, so the setting is the record and this is
    // what makes it stick across logins.
    void keyboard.setRepeat({
        delay: config().get<number>('keyboard.repeatDelay', keyboard.DEFAULT_REPEAT.delay),
        rate: config().get<number>('keyboard.repeatRate', keyboard.DEFAULT_REPEAT.rate),
    });

    // --- commands ----------------------------------------------------------

    const register = (command: string, handler: (...args: never[]) => unknown): void => {
        context.subscriptions.push(vscode.commands.registerCommand(command, handler));
    };

    register('vscodeos.power.menu', () => showTray('power'));
    register('vscodeos.power.shutdown', () => runPowerAction('poweroff'));
    register('vscodeos.power.restart', () => runPowerAction('reboot'));
    register('vscodeos.power.sleep', () => runPowerAction('suspend'));
    register('vscodeos.power.logout', () => runPowerAction('logout'));

    register('vscodeos.calendar.show', () => showTray('calendar'));
    register('vscodeos.power.settings', () => showTray('powersettings'));
    register('vscodeos.volume.show', () => showTray('volume'));
    register('vscodeos.network.show', () => showTray('network'));
    register('vscodeos.bluetooth.show', () => showTray('bluetooth'));
    register('vscodeos.music.show', () => showTray('music'));
    register('vscodeos.notifications.show', () => showTray('notifications'));
    register('vscodeos.notifications.clear', () => notifications.clear());

    register('vscodeos.apps.menu', () =>
        vscode.commands.executeCommand(`${AllAppsProvider.viewId}.focus`));

    register('vscodeos.volume.up', () => audio.step(5));
    register('vscodeos.volume.down', () => audio.step(-5));
    register('vscodeos.volume.toggleMute', () => audio.toggleMute());

    register('vscodeos.music.playPause', () => mpris.playPause());
    register('vscodeos.music.next', () => mpris.next());
    register('vscodeos.music.previous', () => mpris.previous());

    register('vscodeos.settings.accessibility', () =>
        vscode.commands.executeCommand('workbench.action.openSettings', '@tag:accessibility'));

    register('vscodeos.files.open', (startPath?: string) => {
        if (!config().get<boolean>('files.enabled', true)) {
            return vscode.window.showInformationMessage('The file explorer is disabled in settings.');
        }
        return files.open(typeof startPath === 'string' ? startPath : undefined);
    });

    register('vscodeos.browser.open', (url?: string) => browser.open(typeof url === 'string' ? url : undefined));

    const appsEnabled = (): boolean => config().get<boolean>('apps.enabled', true);
    const guard = <A extends unknown[]>(open: (...args: A) => unknown) => (...args: A): void => {
        if (!appsEnabled()) {
            void vscode.window.showInformationMessage('The built-in apps are disabled in settings.');
            return;
        }
        void open(...args);
    };

    register('vscodeos.apps.calculator', guard(() => apps.calculator()));
    register('vscodeos.apps.paint', guard(() => apps.paint()));
    register('vscodeos.apps.screenshot', guard(() => apps.screenshot()));
    register('vscodeos.apps.screenshotRegion', guard(() => apps.captureRegion()));
    register('vscodeos.apps.recorder', guard(() => apps.recorderApp()));
    register('vscodeos.apps.player', guard((path?: string) => player.open(path)));

    register('vscodeos.music.open', () => {
        if (!config().get<boolean>('music.enabled', true)) {
            return vscode.window.showInformationMessage('The music player is disabled in settings.');
        }
        return musicApp.open();
    });

    // --- web apps ----------------------------------------------------------

    const webAppsEnabled = (): boolean => config().get<boolean>('webApps.enabled', true);

    register('vscodeos.marketplace.open', () => {
        if (!webAppsEnabled()) {
            return vscode.window.showInformationMessage('Web apps are disabled in settings.');
        }
        return marketplace.open();
    });

    register('vscodeos.webApps.install', async (url?: string) => {
        if (!webAppsEnabled()) {
            void vscode.window.showInformationMessage('Web apps are disabled in settings.');
            return;
        }
        const address = typeof url === 'string' && url
            ? url
            : await vscode.window.showInputBox({
                title: 'Install a web app',
                prompt: 'The address of the site to install',
                placeHolder: 'https://example.com',
                ignoreFocusOut: true,
            });
        if (!address) {
            return;
        }
        // Through the Marketplace panel so the progress and the result are shown
        // in one place, whichever route asked for the install.
        marketplace.open();
        await marketplace.install(address);
    });

    register('vscodeos.webApps.launch', async (id?: string) => {
        const installed = await webApps.list();
        const app = typeof id === 'string' ? installed.find((candidate) => candidate.id === id) : undefined;
        if (!app) {
            void vscode.window.showWarningMessage('That web app is no longer installed.');
            return;
        }
        if (app.openIn === 'editor') {
            await vscode.commands.executeCommand('vscodeos.browser.open', app.url);
            return;
        }
        if (!browserSys.open(app.url, {
            preferred: config().get<string>('browser.command') || undefined,
            appMode: true,
        })) {
            // No browser to give it a window of its own; the editor has one.
            await vscode.commands.executeCommand('vscodeos.browser.open', app.url);
        }
    });
    // Kept as an alias rather than removed: it is in the README, in muscle
    // memory and in the command palette, and it still opens the same four rows.
    register('vscodeos.apps.updater', () => settings.open('updates'));
    register('vscodeos.settings.open', () => settings.open());
    register('vscodeos.settings.display', () => settings.open('display'));
    register('vscodeos.settings.keyboard', () => settings.open('keyboard'));
    register('vscodeos.settings.sound', () => settings.open('sound'));
    register('vscodeos.settings.storage', () => settings.open('storage'));

    // The bin lost its activity bar view; the Files app has always listed it as
    // a place, so the command opens it there rather than becoming a dead entry
    // in the command palette.
    register('vscodeos.recycleBin.open', () =>
        vscode.commands.executeCommand('vscodeos.files.open', TRASH_PATH));

    register('vscodeos.firewall.open', () => {
        if (!config().get<boolean>('firewall.enabled', true)) {
            return vscode.window.showInformationMessage('The firewall app is disabled in settings.');
        }
        return firewall.open();
    });

    // --- incoming URIs -----------------------------------------------------

    // Two things outside the editor hand work back to it this way:
    //
    //   /screenshot  openbox's Print binding, /usr/local/bin/vscodeos-screenshot.
    //                Electron never sees the Print key on X11, so a contributed
    //                keybinding could not do this job.
    //   /webapp      the desktop entry of a web app set to open in an editor
    //                tab, started from any launcher on the machine.
    context.subscriptions.push(vscode.window.registerUriHandler({
        handleUri(uri: vscode.Uri) {
            const query = new URLSearchParams(uri.query);
            if (uri.path === '/screenshot') {
                void vscode.commands.executeCommand(
                    query.get('mode') === 'region'
                        ? 'vscodeos.apps.screenshotRegion'
                        : 'vscodeos.apps.screenshot',
                );
                return;
            }
            if (uri.path === '/webapp') {
                void vscode.commands.executeCommand('vscodeos.webApps.launch', query.get('id') ?? '');
                return;
            }
            log.debug(`ignoring unknown URI path ${uri.path}`);
        },
    }));

    log.info('VsCodeOsCore ready');
}

export function deactivate(): void {
    // Leave the display the way the kiosk session set it up, rather than with a
    // night-light gamma ramp or DPMS timeout that nothing will clear.
    void display.restoreDefaults();
}
