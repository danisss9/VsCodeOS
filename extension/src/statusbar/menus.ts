// The tray menus, as popups.
//
// For a long time these were webview cards in the side bar, because VS Code has
// no API to anchor a popup to a status bar item and never has. That is still
// true - but it was the wrong thing to conclude from. A quick pick is a popup:
// it floats over the editor, it takes the keyboard, Escape closes it, and it
// costs nothing to draw. What it cannot do is be *anchored* to the item that
// opened it. That is a much smaller loss than taking the side bar away every
// time somebody wants to see the clock.
//
// So this is the default now, and the cards in views/flyout.ts are what
// `vscodeos.flyout.location` switches to for anyone who wants them.
//
// Everything here is stable API. That is not a preference: the shell ships as a
// built-in extension, and proposed APIs for built-ins are gated on Microsoft's
// product.json (see extension/README.md). Item buttons, separators, title
// buttons and `busy` are all stable.
//
// The one pattern worth knowing: an item can carry `keepOpen`, which acts and
// then rebuilds the list in place. That is what makes a volume slider or a
// Wi-Fi switch usable - a popup that closed on every toggle would be unusable
// for exactly the things people open these menus to do.

import * as vscode from 'vscode';
import * as audio from '../sys/audio';
import * as backlight from '../sys/backlight';
import * as battery from '../sys/battery';
import * as bluetooth from '../sys/bluetooth';
import * as display from '../sys/display';
import * as mpris from '../sys/mpris';
import * as network from '../sys/network';
import * as power from '../sys/power';
import type { MprisMonitor } from '../sys/mpris';
import type { NotificationServer } from '../sys/notifications';
import { formatDuration } from '../util/format';
import { runPowerAction } from '../views/flyout';
import type { FlyoutKind } from '../webview/protocol';
import { log } from '../log';

interface MenuItem extends vscode.QuickPickItem {
    /**
     * What accepting the row does. Rows without one are read-only.
     *
     * Returns `unknown` rather than `void`: almost every sys/ function answers
     * with an ok/message result or a boolean, and nothing here reads them -
     * the redraw that follows shows what happened. Typing this as `void` would
     * mean a `void` wrapper around each one for no gain.
     */
    run?: () => unknown;
    /** Redraw the menu after `run` instead of closing it. */
    keepOpen?: boolean;
    /** What each of this row's `buttons` does, by index. */
    onButton?: (index: number) => unknown;
}

const separator = (label: string): MenuItem => ({ label, kind: vscode.QuickPickItemKind.Separator });

const MINUS = new vscode.ThemeIcon('remove');
const PLUS = new vscode.ThemeIcon('add');

const TITLES: Record<FlyoutKind, string> = {
    power: 'Power',
    powersettings: 'Power & Battery',
    calendar: 'Calendar',
    volume: 'Volume',
    network: 'Network',
    bluetooth: 'Bluetooth',
    music: 'Music',
    notifications: 'Notifications',
};

export class TrayMenus implements vscode.Disposable {
    private pick: vscode.QuickPick<MenuItem> | undefined;
    private openKind: FlyoutKind | undefined;
    /** The calendar's month, kept between redraws of the same popup. */
    private month = new Date();
    private scanning = false;

    constructor(
        private readonly music: MprisMonitor,
        private readonly notifications: NotificationServer,
    ) {}

    /**
     * Open a menu, or close it if it is the one already showing - which is what
     * clicking a tray item a second time has always done here.
     */
    async show(kind: FlyoutKind): Promise<void> {
        if (this.openKind === kind) {
            this.close();
            return;
        }
        this.close();
        this.month = new Date();

        const pick = vscode.window.createQuickPick<MenuItem>();
        this.pick = pick;
        this.openKind = kind;
        pick.title = TITLES[kind];
        pick.matchOnDescription = true;

        pick.onDidAccept(() => {
            const item = pick.selectedItems[0];
            if (!item?.run) {
                return;
            }
            if (!item.keepOpen) {
                pick.hide();
            }
            void this.act(kind, item.run, item.keepOpen === true);
        });

        pick.onDidTriggerItemButton((event) => {
            const index = event.item.buttons?.indexOf(event.button) ?? -1;
            if (index >= 0 && event.item.onButton) {
                void this.act(kind, () => event.item.onButton?.(index), true);
            }
        });

        pick.onDidTriggerButton((button) => {
            void this.act(kind, () => this.titleButton(kind, button), true);
        });

        pick.onDidHide(() => {
            if (this.pick === pick) {
                this.pick = undefined;
                this.openKind = undefined;
            }
            pick.dispose();
        });

        pick.busy = true;
        pick.show();
        await this.draw(kind);
    }

    close(): void {
        this.pick?.hide();
    }

    dispose(): void {
        this.close();
    }

    /** Run an action, then redraw if the menu is meant to stay up. */
    private async act(kind: FlyoutKind, run: () => unknown, redraw: boolean): Promise<void> {
        try {
            await run();
        } catch (error) {
            log.error(`tray menu ${kind}`, error);
        }
        if (redraw && this.openKind === kind) {
            await this.draw(kind);
        }
    }

    /**
     * Rebuild the visible list.
     *
     * The active item is put back afterwards: without that, every toggle would
     * bounce the selection to the top of the list, and holding "+" on the
     * brightness row would be impossible.
     */
    private async draw(kind: FlyoutKind): Promise<void> {
        const pick = this.pick;
        if (!pick || this.openKind !== kind) {
            return;
        }
        pick.busy = true;
        const activeLabel = pick.activeItems[0]?.label;
        let items: MenuItem[] = [];
        try {
            items = await this.build(kind, pick);
        } catch (error) {
            log.error(`tray menu ${kind}`, error);
            items = [{ label: 'Something went wrong reading this.' }];
        }
        if (this.pick !== pick || this.openKind !== kind) {
            return;
        }
        pick.items = items;
        const restored = items.find((item) => item.label === activeLabel && item.kind !== vscode.QuickPickItemKind.Separator);
        if (restored) {
            pick.activeItems = [restored];
        }
        pick.busy = false;
    }

    private build(kind: FlyoutKind, pick: vscode.QuickPick<MenuItem>): Promise<MenuItem[]> {
        switch (kind) {
            case 'power': return this.powerItems(pick);
            case 'powersettings': return this.powerSettingsItems(pick);
            case 'calendar': return this.calendarItems(pick);
            case 'volume': return this.volumeItems(pick);
            case 'network': return this.networkItems(pick);
            case 'bluetooth': return this.bluetoothItems(pick);
            case 'music': return this.musicItems(pick);
            default: return this.notificationItems(pick);
        }
    }

    private titleButton(kind: FlyoutKind, button: vscode.QuickInputButton): void {
        if (kind !== 'calendar') {
            return;
        }
        const id = (button as vscode.QuickInputButton & { id?: string }).id;
        if (id === 'today') {
            this.month = new Date();
        } else {
            this.month = new Date(
                this.month.getFullYear(),
                this.month.getMonth() + (id === 'next' ? 1 : -1),
                1,
            );
        }
    }

    // ------------------------------------------------------------------ power

    private async powerItems(pick: vscode.QuickPick<MenuItem>): Promise<MenuItem[]> {
        pick.buttons = [];
        const state = await battery.getState();
        pick.placeholder = state.present
            ? `Battery ${state.level}% · ${state.charging ? 'charging' : state.status.toLowerCase()}`
            : 'On mains power';

        const action = (label: string, glyph: string, name: power.PowerAction, detail: string): MenuItem => ({
            label: `$(${glyph}) ${label}`,
            detail,
            // runPowerAction does its own confirmation and saves open editors.
            run: () => runPowerAction(name),
        });

        return [
            action('Shut down', 'circle-slash', 'poweroff', 'Turn the computer off'),
            action('Restart', 'debug-restart', 'reboot', 'Turn it off and on again'),
            ...(power.canSuspend()
                ? [action('Sleep', 'debug-pause', 'suspend', 'Keep everything in memory')]
                : []),
            action('Log out', 'sign-out', 'logout', 'End the session'),
        ];
    }

    private async powerSettingsItems(pick: vscode.QuickPick<MenuItem>): Promise<MenuItem[]> {
        pick.buttons = [];
        const [state, brightness] = await Promise.all([battery.getState(), backlight.getState()]);
        const saver = display.isEnergySaverOn();
        const night = display.isNightLightOn();

        pick.placeholder = state.present
            ? `${state.level}% · ${battery.describeRemaining(state) ?? (state.charging ? 'Charging' : 'On battery')}`
            : 'On mains power';

        const items: MenuItem[] = [
            {
                label: `$(zap) Energy saver`,
                description: saver ? 'On' : 'Off',
                detail: saver ? 'Dimmed, and the screen sleeps sooner' : 'Full performance',
                keepOpen: true,
                run: () => display.setEnergySaver(!saver),
            },
        ];

        if (brightness.available && brightness.writable) {
            const percent = brightness.percent;
            items.push({
                label: `$(lightbulb) Brightness`,
                description: `${percent}%`,
                detail: 'Use the − and + buttons on this row',
                buttons: [
                    { iconPath: MINUS, tooltip: 'Dimmer' },
                    { iconPath: PLUS, tooltip: 'Brighter' },
                ],
                keepOpen: true,
                // Read the level again rather than stepping from `percent`:
                // that was captured when the list was drawn, and holding "+"
                // fires faster than the redraw that would refresh it, so every
                // press after the first would recompute the same value.
                onButton: async (index) => {
                    const now = await backlight.getState();
                    await backlight.setPercent(clamp(now.percent + (index === 0 ? -10 : 10), 1, 100));
                },
            });
            items.push({
                label: `$(color-mode) Night light`,
                description: night ? 'On' : 'Off',
                detail: 'Warms the screen colours',
                keepOpen: true,
                run: async () => {
                    if (!(await display.setNightLight(!night))) {
                        void vscode.window.showWarningMessage('Night light needs xrandr and a running X session.');
                    }
                },
            });
        }

        if (state.present) {
            items.push(separator('Battery'), {
                label: `$(${battery.iconFor(state)}) ${state.level}%`,
                description: state.charging ? 'Charging' : state.onAc ? 'Plugged in' : 'On battery',
                detail: battery.describeRemaining(state),
            });
        }
        return items;
    }

    // --------------------------------------------------------------- calendar

    /**
     * A month grid in a list.
     *
     * One row per week, days padded to two characters with U+2007 FIGURE SPACE -
     * which is defined to be exactly as wide as a digit, so the columns line up
     * in a proportional font. Today is wrapped in brackets, because a quick pick
     * has no way to colour part of a label.
     */
    private calendarItems(pick: vscode.QuickPick<MenuItem>): Promise<MenuItem[]> {
        const now = new Date();
        const shown = this.month;
        pick.title = shown.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
        pick.placeholder = now.toLocaleString(undefined, {
            weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
            hour: '2-digit', minute: '2-digit',
        });
        pick.buttons = [
            withId({ iconPath: new vscode.ThemeIcon('chevron-left'), tooltip: 'Previous month' }, 'previous'),
            withId({ iconPath: new vscode.ThemeIcon('calendar'), tooltip: 'This month' }, 'today'),
            withId({ iconPath: new vscode.ThemeIcon('chevron-right'), tooltip: 'Next month' }, 'next'),
        ];

        const first = new Date(shown.getFullYear(), shown.getMonth(), 1);
        // Monday-first, matching the card this replaces.
        const offset = (first.getDay() + 6) % 7;
        const days = new Date(shown.getFullYear(), shown.getMonth() + 1, 0).getDate();
        const isThisMonth = now.getFullYear() === shown.getFullYear() && now.getMonth() === shown.getMonth();

        const cells: string[] = Array.from({ length: offset }, () => pad(''));
        for (let day = 1; day <= days; day++) {
            cells.push(isThisMonth && day === now.getDate() ? `[${pad(String(day))}]` : ` ${pad(String(day))} `);
        }

        const items: MenuItem[] = [{ label: header() }];
        for (let start = 0; start < cells.length; start += 7) {
            items.push({ label: cells.slice(start, start + 7).join('') });
        }
        return Promise.resolve(items);
    }

    // ----------------------------------------------------------------- volume

    private async volumeItems(pick: vscode.QuickPick<MenuItem>): Promise<MenuItem[]> {
        pick.buttons = [];
        const state = await audio.getState();
        if (!state.available) {
            pick.placeholder = 'No audio device found';
            return [{ label: 'No audio device found.' }];
        }
        pick.placeholder = state.muted ? 'Muted' : `${state.volume}%`;

        const items: MenuItem[] = [{
            label: `$(${audio.iconFor(state)}) Volume`,
            description: state.muted ? 'Muted' : `${state.volume}%`,
            detail: 'Enter mutes; the − and + buttons change the level',
            buttons: [
                { iconPath: MINUS, tooltip: 'Quieter' },
                { iconPath: PLUS, tooltip: 'Louder' },
            ],
            keepOpen: true,
            run: () => audio.toggleMute(),
            // `step` reads the current level itself, which matters when the
            // button is pressed faster than the list redraws.
            onButton: (index) => audio.step(index === 0 ? -5 : 5),
        }];

        if (state.sinks.length > 0) {
            items.push(separator('Play through'));
            for (const sink of state.sinks) {
                items.push({
                    label: `${sink.isDefault ? '$(check)' : '$(blank)'} ${sink.name}`,
                    keepOpen: true,
                    run: () => audio.setDefaultSink(sink.id),
                });
            }
        }

        if (state.input) {
            items.push(separator('Microphone'), {
                label: `$(${state.input.muted ? 'mute' : 'mic'}) Microphone`,
                description: state.input.muted ? 'Muted' : `${state.input.volume}%`,
                buttons: [
                    { iconPath: MINUS, tooltip: 'Quieter' },
                    { iconPath: PLUS, tooltip: 'Louder' },
                ],
                keepOpen: true,
                run: () => audio.toggleInputMute(),
                onButton: async (index) => {
                    const now = await audio.getInputLevel();
                    await audio.setInputVolume(clamp(now.volume + (index === 0 ? -5 : 5), 0, 100));
                },
            });
        }

        if (state.sources.length > 0) {
            items.push(separator('Record from'));
            for (const source of state.sources) {
                items.push({
                    label: `${source.isDefault ? '$(check)' : '$(blank)'} ${source.name}`,
                    keepOpen: true,
                    run: () => audio.setDefaultSource(source.id),
                });
            }
        }
        return items;
    }

    // ---------------------------------------------------------------- network

    private async networkItems(pick: vscode.QuickPick<MenuItem>): Promise<MenuItem[]> {
        pick.buttons = [];
        const [state, airplane] = await Promise.all([network.getState(), network.isAirplaneMode()]);
        if (!state.available) {
            pick.placeholder = 'NetworkManager is not running';
            return [{ label: 'NetworkManager is not running.' }];
        }

        const wifi = state.active.find((connection) => connection.type.includes('wireless'));
        pick.placeholder = wifi?.name
            ?? (state.active.length > 0 ? state.active[0].name : 'Not connected');

        // No icon: codicon has no aeroplane, and the nearest glyphs all read as
        // something else.
        const items: MenuItem[] = [{
            label: 'Airplane mode',
            description: airplane ? 'On' : 'Off',
            detail: airplane ? 'Every radio is off' : undefined,
            keepOpen: true,
            run: () => network.setAirplaneMode(!airplane),
        }];

        if (state.wifiHardware) {
            items.push({
                label: `$(${state.wifiEnabled ? 'radio-tower' : 'circle-slash'}) Wi-Fi`,
                description: state.wifiEnabled ? 'On' : 'Off',
                keepOpen: true,
                run: () => network.setWifiEnabled(!state.wifiEnabled),
            });
        }

        const wired = state.active.filter((candidate) => !candidate.type.includes('wireless'));
        if (wired.length > 0) {
            items.push(separator('Wired'));
        }
        for (const connection of wired) {
            items.push({
                label: `$(plug) ${connection.name}`,
                description: connection.device,
                detail: 'Enter disconnects',
                keepOpen: true,
                run: () => network.deactivate(connection.name),
            });
        }

        if (!state.wifiHardware) {
            return items;
        }
        if (!state.wifiEnabled) {
            items.push(separator('Wi-Fi'), { label: 'Wi-Fi is off.' });
            return items;
        }

        items.push(separator('Networks'), {
            label: '$(refresh) Scan again',
            keepOpen: true,
            run: async () => {
                if (this.scanning) {
                    return;
                }
                this.scanning = true;
                try {
                    await network.getState(true);
                } finally {
                    this.scanning = false;
                }
            },
        });

        if (state.accessPoints.length === 0) {
            items.push({ label: 'No networks in range.' });
        }
        for (const point of state.accessPoints) {
            const secured = point.security !== '' && point.security !== '--';
            items.push({
                label: `${point.inUse ? '$(check)' : '$(blank)'} ${point.ssid}`,
                description: `${bars(point.signal)}${secured ? ' $(lock)' : ''}`,
                detail: point.inUse
                    ? 'Connected — Enter disconnects'
                    : point.known ? 'Saved' : secured ? point.security : 'Open',
                buttons: point.known
                    ? [{ iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Forget this network' }]
                    : undefined,
                keepOpen: true,
                run: () => this.connect(point.ssid, secured, point.known, point.inUse),
                onButton: () => network.forget(point.ssid),
            });
        }
        return items;
    }

    private async connect(ssid: string, secured: boolean, known: boolean, inUse: boolean): Promise<void> {
        if (inUse) {
            await network.deactivate(ssid);
            return;
        }
        let password: string | undefined;
        if (secured && !known) {
            password = await vscode.window.showInputBox({
                prompt: `Password for ${ssid}`,
                password: true,
                ignoreFocusOut: true,
            });
            if (password === undefined) {
                return;
            }
        }
        const result = await network.connect(ssid, password);
        if (!result.ok) {
            void vscode.window.showErrorMessage(`Could not connect to ${ssid}: ${result.message}`);
        }
    }

    // -------------------------------------------------------------- bluetooth

    private async bluetoothItems(pick: vscode.QuickPick<MenuItem>): Promise<MenuItem[]> {
        pick.buttons = [];
        const state = await bluetooth.getState();
        if (!state.available) {
            pick.placeholder = 'No Bluetooth adapter';
            return [{ label: 'No Bluetooth adapter on this machine.' }];
        }
        pick.placeholder = state.powered ? 'On' : 'Off';

        const items: MenuItem[] = [{
            label: `$(${state.powered ? 'check' : 'circle-slash'}) Bluetooth`,
            description: state.powered ? 'On' : 'Off',
            keepOpen: true,
            run: () => bluetooth.setPowered(!state.powered),
        }];

        if (!state.powered) {
            return items;
        }

        items.push({
            label: '$(refresh) Look for devices',
            detail: this.scanning ? 'Scanning…' : undefined,
            keepOpen: true,
            run: async () => {
                if (this.scanning) {
                    return;
                }
                this.scanning = true;
                try {
                    await bluetooth.scan();
                } finally {
                    this.scanning = false;
                }
            },
        });

        const paired = state.devices.filter((device) => device.paired);
        const nearby = state.devices.filter((device) => !device.paired);

        items.push(separator('My devices'));
        if (paired.length === 0) {
            items.push({ label: 'Nothing paired yet.' });
        }
        for (const device of paired) {
            items.push({
                label: `${device.connected ? '$(check)' : '$(blank)'} ${device.name}`,
                description: device.mac,
                detail: device.connected ? 'Enter disconnects' : 'Enter connects',
                buttons: [{ iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Forget this device' }],
                keepOpen: true,
                run: async () => {
                    const result = device.connected
                        ? (await bluetooth.disconnect(device.mac), { ok: true as const, message: undefined })
                        : await bluetooth.connect(device.mac);
                    if (!result.ok) {
                        void vscode.window.showErrorMessage(`Bluetooth: ${result.message}`);
                    }
                },
                onButton: () => this.forget(device.mac, device.name),
            });
        }

        items.push(separator('Nearby'));
        if (nearby.length === 0) {
            items.push({ label: 'Nothing found yet. Use "Look for devices".' });
        }
        for (const device of nearby) {
            items.push({
                label: `$(blank) ${device.name}`,
                description: device.mac,
                detail: 'Enter pairs',
                keepOpen: true,
                run: async () => {
                    const result = await bluetooth.pair(device.mac);
                    if (!result.ok) {
                        void vscode.window.showErrorMessage(`Bluetooth: ${result.message}`);
                    }
                },
            });
        }
        return items;
    }

    private async forget(mac: string, name: string): Promise<void> {
        const choice = await vscode.window.showWarningMessage(
            `Forget "${name}"?`,
            { modal: true, detail: 'You will have to pair it again to use it.' },
            'Forget',
        );
        if (choice === 'Forget') {
            await bluetooth.forget(mac);
        }
    }

    // ------------------------------------------------------------------ music

    private async musicItems(pick: vscode.QuickPick<MenuItem>): Promise<MenuItem[]> {
        pick.buttons = [];
        const items: MenuItem[] = [{
            label: '$(library) Open Music',
            detail: 'Play the music on this computer',
            run: () => vscode.commands.executeCommand('vscodeos.music.open'),
        }];

        if (!mpris.isAvailable()) {
            pick.placeholder = 'playerctl is not installed';
            items.push(separator('Now playing'), {
                label: 'Install playerctl to control other players from here',
                detail: 'sudo pacman -S playerctl',
            });
            return items;
        }

        const playing = (await this.music.refreshPosition()) ?? this.music.current;
        if (!playing || playing.status === 'Stopped') {
            pick.placeholder = 'Nothing is playing';
            return items;
        }

        pick.placeholder = playing.artist ? `${playing.artist} — ${playing.title}` : playing.title;
        items.push(
            separator(`In ${playing.player}`),
            {
                label: `$(${playing.status === 'Playing' ? 'debug-pause' : 'play'}) ${playing.title}`,
                description: playing.length > 0
                    ? `${formatDuration(playing.position)} / ${formatDuration(playing.length)}`
                    : undefined,
                detail: [playing.artist, playing.album].filter(Boolean).join(' · ') || undefined,
                buttons: [
                    { iconPath: new vscode.ThemeIcon('chevron-left'), tooltip: 'Previous' },
                    { iconPath: new vscode.ThemeIcon('chevron-right'), tooltip: 'Next' },
                ],
                keepOpen: true,
                run: () => mpris.playPause(),
                onButton: (index) => (index === 0 ? mpris.previous() : mpris.next()),
            },
        );
        return items;
    }

    // ---------------------------------------------------------- notifications

    private notificationItems(pick: vscode.QuickPick<MenuItem>): Promise<MenuItem[]> {
        pick.buttons = [];
        if (!this.notifications.running) {
            pick.placeholder = 'Another daemon owns the desktop bus';
            return Promise.resolve([{
                label: 'Another notification daemon owns the desktop bus, so notifications go there instead.',
            }]);
        }

        const records = this.notifications.records;
        // Opening the menu is reading them; the tray badge clears with it.
        this.notifications.markAllRead();
        pick.placeholder = records.length === 0
            ? 'Nothing to catch up on'
            : `${records.length} notification${records.length === 1 ? '' : 's'}`;

        if (records.length === 0) {
            return Promise.resolve([{ label: 'Nothing to catch up on.' }]);
        }

        const now = Date.now();
        const items: MenuItem[] = records.map((record) => ({
            label: `$(${record.urgency === 'critical' ? 'warning' : 'bell'}) ${record.text}`,
            description: `${record.appName} · ${whenLabel(record.at, now)}`,
            buttons: [{ iconPath: new vscode.ThemeIcon('close'), tooltip: 'Dismiss' }],
            keepOpen: true,
            onButton: () => this.notifications.dismiss(record.id),
        }));

        items.push(separator(''), {
            label: '$(clear-all) Clear all',
            run: () => this.notifications.clear(),
        });
        return Promise.resolve(items);
    }
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, Math.round(value)));
}

/** U+2007 FIGURE SPACE: exactly one digit wide, so the calendar columns align. */
const FIGURE_SPACE = ' ';

function pad(text: string): string {
    return ` ${text.padStart(2, FIGURE_SPACE)} `;
}

function header(): string {
    return ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((day) => ` ${day} `).join('');
}

function bars(signal: number): string {
    const filled = signal >= 75 ? 4 : signal >= 50 ? 3 : signal >= 25 ? 2 : 1;
    return `${'▮'.repeat(filled)}${'▯'.repeat(4 - filled)} ${signal}%`;
}

/** "just now", "6 min ago", "14:32" - the resolution people actually want. */
function whenLabel(at: number, now: number): string {
    const seconds = Math.max(0, Math.round((now - at) / 1000));
    if (seconds < 45) {
        return 'just now';
    }
    if (seconds < 3600) {
        return `${Math.round(seconds / 60)} min ago`;
    }
    const date = new Date(at);
    return seconds < 86400
        ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
        : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** Title buttons come back by identity, so they need something to be told apart by. */
function withId(button: vscode.QuickInputButton, id: string): vscode.QuickInputButton {
    return Object.assign(button, { id });
}
