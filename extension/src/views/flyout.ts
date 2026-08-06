// The flyouts: power, calendar, quick settings, volume, network and music.
//
// A VS Code extension cannot draw a popup anchored to a status bar item - there
// is no such API - so the closest honest equivalent is a webview view in the
// bottom panel, which opens directly above the status bar. The webview draws a
// right-anchored card so it reads as a flyout rising out of the tray.
//
// One provider serves all six panels and switches on a message, because the
// panel container can only hold one view without splitting the space between
// them, and because they share their whole refresh loop.

import * as vscode from 'vscode';
import * as audio from '../sys/audio';
import * as backlight from '../sys/backlight';
import * as battery from '../sys/battery';
import * as bluetooth from '../sys/bluetooth';
import * as display from '../sys/display';
import * as mpris from '../sys/mpris';
import * as network from '../sys/network';
import * as power from '../sys/power';
import { MprisMonitor } from '../sys/mpris';
import { open as openBrowser } from '../sys/browser';
import { render, webviewOptions } from '../webview/html';
import type { FlyoutKind, FlyoutState, HostMessage, WebviewMessage } from '../webview/protocol';
import { log } from '../log';

const TITLES: Record<FlyoutKind, string> = {
    power: 'Power',
    calendar: 'Calendar',
    quicksettings: 'Quick Settings',
    volume: 'Volume',
    network: 'Network',
    music: 'Music',
};

const REFRESH_MS = 2000;

export class FlyoutProvider implements vscode.WebviewViewProvider {
    static readonly viewId = 'vscodeos.flyout';

    private view: vscode.WebviewView | undefined;
    private kind: FlyoutKind = 'quicksettings';
    private timer: NodeJS.Timeout | undefined;
    private refreshing = false;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly music: MprisMonitor,
    ) {}

    /**
     * Open the panel on a given card. `<viewId>.focus` is auto-registered by the
     * workbench for every contributed view and both reveals the panel and expands
     * the view, which `WebviewView.show()` alone cannot do before the first resolve.
     */
    async show(kind: FlyoutKind): Promise<void> {
        // Clicking the tray item that is already open closes the panel again,
        // which is what a real flyout does.
        if (this.view?.visible && this.kind === kind) {
            await vscode.commands.executeCommand('workbench.action.closePanel');
            return;
        }
        this.kind = kind;
        if (this.view) {
            this.view.title = TITLES[kind];
            this.view.show?.(true);
        }
        await vscode.commands.executeCommand(`${FlyoutProvider.viewId}.focus`, { preserveFocus: true });
        this.post({ type: 'flyout', kind });
        await this.refresh();
    }

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.title = TITLES[this.kind];
        view.webview.options = webviewOptions(this.context);
        view.webview.html = render(view.webview, this.context, { title: 'VS Code OS', script: 'flyout' });

        view.webview.onDidReceiveMessage((message: WebviewMessage) => {
            void this.handle(message);
        });

        view.onDidChangeVisibility(() => {
            if (view.visible) {
                this.startPolling();
                void this.refresh();
            } else {
                this.stopPolling();
            }
        });

        view.onDidDispose(() => {
            this.stopPolling();
            this.view = undefined;
        });

        if (view.visible) {
            this.startPolling();
        }
    }

    private startPolling(): void {
        this.stopPolling();
        this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    }

    private stopPolling(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    private post(message: HostMessage): void {
        void this.view?.webview.postMessage(message);
    }

    /** Gather only what the visible card needs; nothing else costs a process spawn. */
    private async refresh(scan = false): Promise<void> {
        if (!this.view?.visible || this.refreshing) {
            return;
        }
        this.refreshing = true;
        try {
            const state: FlyoutState = { kind: this.kind, now: Date.now() };

            if (this.kind === 'quicksettings' || this.kind === 'power') {
                state.battery = await battery.getState();
            }
            if (this.kind === 'quicksettings' || this.kind === 'volume') {
                state.audio = await audio.getState();
            }
            if (this.kind === 'quicksettings') {
                const brightness = await backlight.getState();
                state.brightness = brightness.available && brightness.writable ? brightness.percent : undefined;
                state.bluetooth = await bluetooth.getState();
                state.airplaneMode = await network.isAirplaneMode();
                state.nightLight = display.isNightLightOn();
                state.energySaver = display.isEnergySaverOn();
                state.network = await network.getState(false);
            }
            if (this.kind === 'network') {
                state.network = await network.getState(scan);
            }
            if (this.kind === 'music') {
                state.nowPlaying = (await this.music.refreshPosition()) ?? this.music.current;
                state.players = mpris.isAvailable() ? await mpris.listPlayers() : [];
                state.mprisAvailable = mpris.isAvailable();
            }
            if (this.kind === 'power') {
                state.canSuspend = power.canSuspend();
            }

            this.post({ type: 'state', state });
        } catch (error) {
            log.error('flyout refresh failed', error);
        } finally {
            this.refreshing = false;
        }
    }

    private async handle(message: WebviewMessage): Promise<void> {
        switch (message.type) {
            case 'ready':
                this.post({ type: 'flyout', kind: this.kind });
                await this.refresh();
                return;

            case 'power':
                await runPowerAction(message.action);
                return;

            case 'volume':
                await audio.setVolume(message.value);
                await this.refresh();
                return;

            case 'mute':
                await audio.toggleMute();
                await this.refresh();
                return;

            case 'sink':
                await audio.setDefaultSink(message.id);
                await this.refresh();
                return;

            case 'brightness':
                await backlight.setPercent(message.value);
                return;

            case 'wifi':
                await network.setWifiEnabled(message.enabled);
                await this.refresh();
                return;

            case 'scan':
                this.post({ type: 'scanning' });
                await this.refresh(true);
                return;

            case 'connect': {
                let password = message.password;
                if (!password && message.secured && !message.known) {
                    password = await vscode.window.showInputBox({
                        prompt: `Password for ${message.ssid}`,
                        password: true,
                        ignoreFocusOut: true,
                    });
                    if (password === undefined) {
                        return;
                    }
                }
                this.post({ type: 'busy', label: `Connecting to ${message.ssid}…` });
                const result = await network.connect(message.ssid, password);
                if (!result.ok) {
                    void vscode.window.showErrorMessage(`Could not connect to ${message.ssid}: ${result.message}`);
                }
                await this.refresh();
                return;
            }

            case 'disconnect':
                await network.deactivate(message.name);
                await this.refresh();
                return;

            case 'forget':
                await network.forget(message.name);
                await this.refresh();
                return;

            case 'airplane':
                await network.setAirplaneMode(message.enabled);
                await this.refresh();
                return;

            case 'bluetooth':
                await bluetooth.setPowered(message.enabled);
                await this.refresh();
                return;

            case 'bluetoothDevice': {
                const result = message.connect
                    ? await bluetooth.connect(message.mac)
                    : (await bluetooth.disconnect(message.mac), { ok: true as const });
                if (!result.ok) {
                    void vscode.window.showErrorMessage(`Bluetooth: ${result.message}`);
                }
                await this.refresh();
                return;
            }

            case 'nightLight':
                if (!(await display.setNightLight(message.enabled))) {
                    void vscode.window.showWarningMessage('Night light needs xrandr and a running X session.');
                }
                await this.refresh();
                return;

            case 'energySaver':
                await display.setEnergySaver(message.enabled);
                await this.refresh();
                return;

            case 'accessibility':
                await vscode.commands.executeCommand('workbench.action.openSettings', '@tag:accessibility');
                return;

            case 'transport':
                if (message.action === 'playPause') {
                    await mpris.playPause();
                } else if (message.action === 'next') {
                    await mpris.next();
                } else {
                    await mpris.previous();
                }
                setTimeout(() => void this.refresh(), 300);
                return;

            case 'seek':
                await mpris.seek(message.seconds);
                await this.refresh();
                return;

            case 'launchMusic': {
                const url = message.service === 'spotify'
                    ? 'https://open.spotify.com'
                    : 'https://music.youtube.com';
                const preferred = vscode.workspace.getConfiguration('vscodeos').get<string>('browser.command') || undefined;
                if (!openBrowser(url, { preferred, appMode: true })) {
                    void vscode.window.showErrorMessage(
                        'No browser found. Install chromium (or set vscodeos.browser.command).',
                    );
                }
                return;
            }

            case 'command':
                await vscode.commands.executeCommand(message.command);
                return;

            default:
                return;
        }
    }
}

/** Shared by the flyout and the command palette entries. */
export async function runPowerAction(action: power.PowerAction): Promise<void> {
    const confirm = vscode.workspace.getConfiguration('vscodeos').get<boolean>('power.confirm', true);
    const labels: Record<power.PowerAction, string> = {
        poweroff: 'Shut down',
        reboot: 'Restart',
        suspend: 'Sleep',
        hibernate: 'Hibernate',
        logout: 'Log out',
    };

    if (confirm && (action === 'poweroff' || action === 'reboot' || action === 'logout')) {
        const choice = await vscode.window.showWarningMessage(
            `${labels[action]} this computer?`,
            { modal: true, detail: 'Unsaved changes in open editors are saved automatically.' },
            labels[action],
        );
        if (choice !== labels[action]) {
            return;
        }
    }

    // Files are saved on a delay by default; flush them before the machine goes.
    await vscode.workspace.saveAll(false);

    const result = await power.perform(action);
    if (!result.ok) {
        void vscode.window.showErrorMessage(`${labels[action]} failed: ${result.message}`);
    }
}
