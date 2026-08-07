// The flyouts: apps, power, calendar, power settings, volume, network,
// bluetooth, music and notifications.
//
// A VS Code extension cannot draw a popup anchored to a status bar item - there
// is no such API, and the only floating-window route (moving an editor to an
// auxiliary window) drags editor tab chrome along with it and cannot be sized or
// placed. So these are webview views, which VS Code will host in the side bar or
// in the bottom panel. The side bar is the default: the bottom panel is where
// the terminal lives, and clicking the clock should not close it.
//
// One provider serves all nine cards, because a container can only hold one
// view without splitting the space between them, and because they share their
// whole refresh loop.

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
import type { NotificationServer } from '../sys/notifications';
import { availableApps } from '../apps/registry';
import { render, webviewOptions } from '../webview/html';
import type { FlyoutKind, FlyoutState, HostMessage, WebviewMessage } from '../webview/protocol';
import { log } from '../log';

const TITLES: Record<FlyoutKind, string> = {
    apps: 'Apps',
    power: 'Power',
    powersettings: 'Power Settings',
    calendar: 'Calendar',
    volume: 'Volume',
    network: 'Network',
    bluetooth: 'Bluetooth',
    music: 'Music',
    notifications: 'Notifications',
};

const REFRESH_MS = 2000;

/**
 * Cards the host has nothing new to say about. Polling them would rebuild the
 * card every two seconds for no reason - and in the launcher's case it would
 * rebuild the search box out from under whoever is typing into it. The calendar
 * ticks its own clock inside the webview.
 */
const STATIC_KINDS: ReadonlySet<FlyoutKind> = new Set<FlyoutKind>(['apps', 'calendar']);

export type FlyoutLocation = 'sidebar' | 'panel';

export class FlyoutProvider implements vscode.WebviewViewProvider {
    /** Contributed twice, under a `when` on vscodeos.flyout.location; one resolves. */
    static readonly sidebarViewId = 'vscodeos.flyout';
    static readonly panelViewId = 'vscodeos.flyout.panel';

    private view: vscode.WebviewView | undefined;
    private kind: FlyoutKind = 'apps';
    private timer: NodeJS.Timeout | undefined;
    private refreshing = false;
    private scanning = false;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly music: MprisMonitor,
        private readonly notifications: NotificationServer,
    ) {}

    private get location(): FlyoutLocation {
        return vscode.workspace.getConfiguration('vscodeos').get<FlyoutLocation>('flyout.location', 'sidebar');
    }

    private get viewId(): string {
        return this.location === 'panel' ? FlyoutProvider.panelViewId : FlyoutProvider.sidebarViewId;
    }

    /**
     * What "click the tray item again to close it" has to run for each host.
     * The side bar gets the toggle rather than a close command: both callers
     * already know the view is the visible one, so toggling can only hide it.
     */
    private get closeCommand(): string {
        return this.location === 'panel'
            ? 'workbench.action.closePanel'
            : 'workbench.action.toggleSidebarVisibility';
    }

    /**
     * Open the panel on a given card. `<viewId>.focus` is auto-registered by the
     * workbench for every contributed view and both reveals the container and
     * expands the view, which `WebviewView.show()` alone cannot do before the
     * first resolve.
     */
    async show(kind: FlyoutKind): Promise<void> {
        // Clicking the tray item that is already open closes it again, which is
        // what a real flyout does.
        if (this.view?.visible && this.kind === kind) {
            await vscode.commands.executeCommand(this.closeCommand);
            return;
        }
        this.kind = kind;
        if (this.view) {
            this.view.title = TITLES[kind];
            this.view.show?.(true);
        }
        // The launcher wants the keyboard, so somebody can start typing straight
        // into its search box; every other card is read, not typed into, and
        // stealing focus from the editor for those would be rude.
        await vscode.commands.executeCommand(`${this.viewId}.focus`, { preserveFocus: kind !== 'apps' });
        this.post({ type: 'flyout', kind });
        // The kind decides whether this card polls at all.
        if (this.view?.visible) {
            this.startPolling();
        }
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
        if (STATIC_KINDS.has(this.kind)) {
            return;
        }
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
            const config = vscode.workspace.getConfiguration('vscodeos');
            const state: FlyoutState = { kind: this.kind, now: Date.now() };

            if (this.kind === 'apps') {
                state.apps = availableApps(config);
            }
            if (this.kind === 'powersettings' || this.kind === 'power') {
                state.battery = await battery.getState();
            }
            if (this.kind === 'volume') {
                state.audio = await audio.getState();
            }
            if (this.kind === 'powersettings') {
                const brightness = await backlight.getState();
                state.brightness = brightness.available && brightness.writable ? brightness.percent : undefined;
                state.nightLight = display.isNightLightOn();
                state.energySaver = display.isEnergySaverOn();
            }
            if (this.kind === 'network') {
                state.network = await network.getState(scan);
                state.airplaneMode = await network.isAirplaneMode();
            }
            if (this.kind === 'bluetooth') {
                state.bluetooth = await bluetooth.getState();
                state.bluetoothScanning = this.scanning;
            }
            if (this.kind === 'music') {
                state.nowPlaying = (await this.music.refreshPosition()) ?? this.music.current;
                state.players = mpris.isAvailable() ? await mpris.listPlayers() : [];
                state.mprisAvailable = mpris.isAvailable();
            }
            if (this.kind === 'power') {
                state.canSuspend = power.canSuspend();
            }
            if (this.kind === 'notifications') {
                state.notifications = this.notifications.records;
                state.notificationsAvailable = this.notifications.running;
                // Opening the card is reading them; the tray badge clears with it.
                this.notifications.markAllRead();
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

            case 'source':
                await audio.setDefaultSource(message.id);
                await this.refresh();
                return;

            case 'micVolume':
                await audio.setInputVolume(message.value);
                await this.refresh();
                return;

            case 'micMute':
                await audio.toggleInputMute();
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

            case 'bluetoothScan': {
                if (this.scanning) {
                    return;
                }
                this.scanning = true;
                this.post({ type: 'scanning' });
                try {
                    await bluetooth.scan();
                } finally {
                    this.scanning = false;
                }
                await this.refresh();
                return;
            }

            case 'bluetoothDevice': {
                this.post({ type: 'busy', label: message.connect ? 'Connecting…' : 'Disconnecting…' });
                const result = message.connect
                    ? await bluetooth.connect(message.mac)
                    : (await bluetooth.disconnect(message.mac), { ok: true as const, message: undefined });
                if (!result.ok) {
                    void vscode.window.showErrorMessage(`Bluetooth: ${result.message}`);
                }
                await this.refresh();
                return;
            }

            case 'bluetoothPair': {
                this.post({ type: 'busy', label: 'Pairing…' });
                const result = await bluetooth.pair(message.mac);
                if (!result.ok) {
                    void vscode.window.showErrorMessage(`Bluetooth: ${result.message}`);
                }
                await this.refresh();
                return;
            }

            case 'bluetoothForget': {
                const choice = await vscode.window.showWarningMessage(
                    `Forget "${message.name}"?`,
                    { modal: true, detail: 'You will have to pair it again to use it.' },
                    'Forget',
                );
                if (choice === 'Forget') {
                    await bluetooth.forget(message.mac);
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
                await vscode.commands.executeCommand('vscodeos.browser.open', url);
                return;
            }

            case 'dismissNotification':
                this.notifications.dismiss(message.id);
                await this.refresh();
                return;

            case 'clearNotifications':
                this.notifications.clear();
                await this.refresh();
                return;

            case 'command':
                await vscode.commands.executeCommand(message.command);
                return;

            case 'closeFlyout':
                await vscode.commands.executeCommand(this.closeCommand);
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
