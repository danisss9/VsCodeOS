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
import { MediaPlayer } from './apps/mediaPlayer';
import { MiniApps } from './apps/miniApps';
import { Firewall } from './apps/firewall';
import { SystemSettings } from './apps/systemSettings';
import { StatusBar } from './statusbar';
import { FlyoutProvider, runPowerAction } from './views/flyout';
import { RecycleBinProvider } from './views/recycleBin';
import { TaskManagerProvider } from './views/taskManager';
import { MprisMonitor } from './sys/mpris';
import { NotificationServer } from './sys/notifications';
import * as audio from './sys/audio';
import * as display from './sys/display';
import * as keyboard from './sys/keyboard';
import { TrashService } from './sys/trash';
import * as mpris from './sys/mpris';
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

    // Contributed to both the side bar and the bottom panel under a `when` on
    // vscodeos.flyout.location, so exactly one of these ever resolves. Both are
    // registered because the setting can change without a reload.
    const flyout = new FlyoutProvider(context, music, notifications);
    for (const viewId of [FlyoutProvider.sidebarViewId, FlyoutProvider.panelViewId]) {
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider(viewId, flyout, {
                webviewOptions: { retainContextWhenHidden: true },
            }),
        );
    }

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

    // --- recycle bin -------------------------------------------------------
    //
    // One service behind both surfaces - this view and the Files app's places
    // list - so restoring in either redraws the other.

    const trash = new TrashService();
    const recycleBin = new RecycleBinProvider(context, trash);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(RecycleBinProvider.viewId, recycleBin, {
            webviewOptions: { retainContextWhenHidden: true },
        }),
        recycleBin,
    );

    // --- apps --------------------------------------------------------------

    const panels = new AppPanels(context);
    const files = new FileExplorer(context, trash);
    const apps = new MiniApps(panels);
    const player = new MediaPlayer(panels);
    const browser = new Browser(panels);
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

    register('vscodeos.power.menu', () => flyout.show('power'));
    register('vscodeos.power.shutdown', () => runPowerAction('poweroff'));
    register('vscodeos.power.restart', () => runPowerAction('reboot'));
    register('vscodeos.power.sleep', () => runPowerAction('suspend'));
    register('vscodeos.power.logout', () => runPowerAction('logout'));

    register('vscodeos.calendar.show', () => flyout.show('calendar'));
    register('vscodeos.power.settings', () => flyout.show('powersettings'));
    register('vscodeos.volume.show', () => flyout.show('volume'));
    register('vscodeos.network.show', () => flyout.show('network'));
    register('vscodeos.bluetooth.show', () => flyout.show('bluetooth'));
    register('vscodeos.music.show', () => flyout.show('music'));
    register('vscodeos.apps.menu', () => flyout.show('apps'));
    register('vscodeos.notifications.show', () => flyout.show('notifications'));
    register('vscodeos.notifications.clear', () => notifications.clear());

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
    // Kept as an alias rather than removed: it is in the README, in muscle
    // memory and in the command palette, and it still opens the same four rows.
    register('vscodeos.apps.updater', () => settings.open('updates'));
    register('vscodeos.settings.open', () => settings.open());
    register('vscodeos.settings.display', () => settings.open('display'));
    register('vscodeos.settings.keyboard', () => settings.open('keyboard'));
    register('vscodeos.settings.sound', () => settings.open('sound'));
    register('vscodeos.settings.storage', () => settings.open('storage'));

    register('vscodeos.recycleBin.open', () =>
        vscode.commands.executeCommand(`${RecycleBinProvider.viewId}.focus`));

    register('vscodeos.firewall.open', () => {
        if (!config().get<boolean>('firewall.enabled', true)) {
            return vscode.window.showInformationMessage('The firewall app is disabled in settings.');
        }
        return firewall.open();
    });

    // --- the Print key -----------------------------------------------------

    // Openbox binds Print to /usr/local/bin/vscodeos-screenshot, which hands this
    // URI to the running editor. Electron never sees the key itself on X11, so a
    // contributed keybinding could not do this job.
    context.subscriptions.push(vscode.window.registerUriHandler({
        handleUri(uri: vscode.Uri) {
            if (uri.path !== '/screenshot') {
                log.debug(`ignoring unknown URI path ${uri.path}`);
                return;
            }
            const mode = new URLSearchParams(uri.query).get('mode');
            void vscode.commands.executeCommand(
                mode === 'region' ? 'vscodeos.apps.screenshotRegion' : 'vscodeos.apps.screenshot',
            );
        },
    }));

    log.info('VsCodeOsCore ready');
}

export function deactivate(): void {
    // Leave the display the way the kiosk session set it up, rather than with a
    // night-light gamma ramp or DPMS timeout that nothing will clear.
    void display.restoreDefaults();
}
