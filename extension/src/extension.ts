// VsCodeOsCore - the VS Code OS desktop shell.
//
// VS Code OS has no desktop environment: the editor is the entire user
// interface. This extension supplies the parts of a desktop that the editor does
// not have - a tray with power, clock, battery, volume and network; a task
// manager; a file manager; and a handful of small apps - and is installed as a
// built-in extension in both images, so it is there on first boot.

import * as vscode from 'vscode';
import { AppPanels } from './apps/panels';
import { FileExplorer } from './apps/fileExplorer';
import { MiniApps } from './apps/miniApps';
import { StatusBar } from './statusbar';
import { FlyoutProvider, runPowerAction } from './views/flyout';
import { TaskManagerProvider } from './views/taskManager';
import { MprisMonitor } from './sys/mpris';
import * as audio from './sys/audio';
import * as display from './sys/display';
import * as mpris from './sys/mpris';
import { open as openBrowser } from './sys/browser';
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

    // --- the tray ----------------------------------------------------------

    const flyout = new FlyoutProvider(context, music);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(FlyoutProvider.viewId, flyout, {
            webviewOptions: { retainContextWhenHidden: true },
        }),
    );

    if (config().get<boolean>('statusBar.enabled', true)) {
        const statusBar = new StatusBar(music);
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

    // --- apps --------------------------------------------------------------

    const panels = new AppPanels(context);
    const files = new FileExplorer(context);
    const apps = new MiniApps(panels);
    context.subscriptions.push(panels, apps, { dispose: () => files.dispose() });
    void apps.ensureDirectories();

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
    register('vscodeos.quickSettings.show', () => flyout.show('quicksettings'));
    register('vscodeos.volume.show', () => flyout.show('volume'));
    register('vscodeos.network.show', () => flyout.show('network'));
    register('vscodeos.music.show', () => flyout.show('music'));

    register('vscodeos.volume.up', () => audio.step(5));
    register('vscodeos.volume.down', () => audio.step(-5));
    register('vscodeos.volume.toggleMute', () => audio.toggleMute());

    register('vscodeos.music.playPause', () => mpris.playPause());
    register('vscodeos.music.next', () => mpris.next());
    register('vscodeos.music.previous', () => mpris.previous());

    register('vscodeos.files.open', () => {
        if (!config().get<boolean>('files.enabled', true)) {
            return vscode.window.showInformationMessage('The file explorer is disabled in settings.');
        }
        return files.open();
    });

    register('vscodeos.browser.open', async () => {
        const homepage = config().get<string>('browser.homepage', 'https://duckduckgo.com');
        const preferred = config().get<string>('browser.command') || undefined;
        const url = await vscode.window.showInputBox({
            prompt: 'Open in the web browser',
            value: homepage,
            valueSelection: [0, homepage.length],
        });
        if (!url) {
            return;
        }
        const normalised = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
        if (!openBrowser(normalised, { preferred })) {
            // Simple Browser ships with every VS Code build; it cannot render
            // sites that send X-Frame-Options, but it beats doing nothing.
            const fallback = await vscode.window.showErrorMessage(
                'No web browser is installed.',
                'Open in Simple Browser',
            );
            if (fallback) {
                await vscode.commands.executeCommand('simpleBrowser.api.open', vscode.Uri.parse(normalised));
            }
        }
    });

    const appsEnabled = (): boolean => config().get<boolean>('apps.enabled', true);
    const guard = (open: () => void) => (): void => {
        if (!appsEnabled()) {
            void vscode.window.showInformationMessage('The built-in apps are disabled in settings.');
            return;
        }
        open();
    };

    register('vscodeos.apps.calculator', guard(() => apps.calculator()));
    register('vscodeos.apps.notepad', guard(() => apps.notepad()));
    register('vscodeos.apps.paint', guard(() => apps.paint()));
    register('vscodeos.apps.screenshot', guard(() => apps.screenshot()));
    register('vscodeos.apps.recorder', guard(() => apps.recorderApp()));
    register('vscodeos.apps.menu', () => apps.menu());

    log.info('VsCodeOsCore ready');
}

export function deactivate(): void {
    // Leave the display the way the kiosk session set it up, rather than with a
    // night-light gamma ramp or DPMS timeout that nothing will clear.
    void display.restoreDefaults();
}
