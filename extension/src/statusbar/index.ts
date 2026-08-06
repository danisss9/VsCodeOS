// The tray: power, clock, battery, volume, network and now-playing.
//
// Two things about the status bar that decide this whole file:
//
//  * For Alignment.Right, a HIGHER priority puts an item further LEFT. The whole
//    ladder below is therefore negative and reads left-to-right as it descends.
//
//  * No extension can be the rightmost item on its own. The notifications bell
//    registers at NEGATIVE_INFINITY, and the extension host clamps extension
//    priorities to -Number.MAX_VALUE, which is strictly greater. The images ship
//    `"workbench.notifications.position": "top-right"` in the skel settings,
//    which removes the bell from the status bar entirely and frees the corner.
//    Without that setting the power button simply sits second from the right.

import * as vscode from 'vscode';
import * as audioSys from '../sys/audio';
import * as batterySys from '../sys/battery';
import * as networkSys from '../sys/network';
import { MprisMonitor, type NowPlaying } from '../sys/mpris';
import { formatDate, formatTime } from '../util/format';

/** Left to right, as the tray is read. */
const PRIORITY = {
    media: -50,
    battery: -100,
    volume: -200,
    network: -300,
    clock: -400,
    power: -Number.MAX_VALUE,
} as const;

const SLOW_TICK_MS = 5000;

export class StatusBar implements vscode.Disposable {
    private readonly items: vscode.StatusBarItem[] = [];
    private readonly power: vscode.StatusBarItem;
    private readonly clock: vscode.StatusBarItem;
    private readonly batteryItem: vscode.StatusBarItem;
    private readonly volumeItem: vscode.StatusBarItem;
    private readonly networkItem: vscode.StatusBarItem;
    private readonly mediaItem: vscode.StatusBarItem;

    private clockTimer: NodeJS.Timeout | undefined;
    private slowTimer: NodeJS.Timeout | undefined;

    constructor(private readonly music: MprisMonitor) {
        // The first argument is the item's *id*, which has to be unique - the
        // battery tile and the power button are both "power" to a user, but they
        // cannot share one here.
        this.mediaItem = this.create('media', PRIORITY.media, 'vscodeos.music.show', 'Music');
        this.batteryItem = this.create('battery', PRIORITY.battery, 'vscodeos.quickSettings.show', 'Battery');
        this.volumeItem = this.create('volume', PRIORITY.volume, 'vscodeos.volume.show', 'Volume');
        this.networkItem = this.create('network', PRIORITY.network, 'vscodeos.network.show', 'Network');
        this.clock = this.create('clock', PRIORITY.clock, 'vscodeos.calendar.show', 'Date and time');
        this.power = this.create('power', PRIORITY.power, 'vscodeos.power.menu', 'Power');

        // No codicon is a power symbol; circle-slash is the closest that is
        // guaranteed to exist in every VS Code build.
        this.power.text = '$(circle-slash)';
        this.power.tooltip = new vscode.MarkdownString('**Power** — sleep, restart or shut down');

        this.music.on('change', (state: NowPlaying | undefined) => this.renderMedia(state));
    }

    private create(id: string, priority: number, command: string, name: string): vscode.StatusBarItem {
        const item = vscode.window.createStatusBarItem(
            `vscodeos.${id}`,
            vscode.StatusBarAlignment.Right,
            priority,
        );
        item.name = `VS Code OS: ${name}`;
        item.command = command;
        this.items.push(item);
        return item;
    }

    start(): void {
        this.power.show();
        this.tickClock();
        void this.tickSlow();

        // Line the clock up with the wall clock so the minute flips on the minute.
        const toNextMinute = 60000 - (Date.now() % 60000);
        setTimeout(() => {
            this.tickClock();
            this.clockTimer = setInterval(() => this.tickClock(), 60000);
        }, toNextMinute);

        this.slowTimer = setInterval(() => void this.tickSlow(), SLOW_TICK_MS);
        this.renderMedia(this.music.current);
    }

    private tickClock(): void {
        const config = vscode.workspace.getConfiguration('vscodeos');
        const now = new Date();
        const time = formatTime(now, config.get<string>('clock.timeFormat', 'HH:mm'));
        const date = config.get<string>('clock.dateFormat', 'dd/MM/yyyy');
        this.clock.text = date ? `${time}  ${formatDate(now, date)}` : time;
        this.clock.tooltip = new vscode.MarkdownString(
            `**${now.toLocaleTimeString()}**\n\n${now.toLocaleDateString(undefined, {
                weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
            })}\n\n_Click for the calendar_`,
        );
        this.clock.show();
    }

    /** Everything that costs a syscall or a subprocess, on a slower beat than the clock. */
    private async tickSlow(): Promise<void> {
        await Promise.all([this.renderBattery(), this.renderVolume(), this.renderNetwork()]);
    }

    private async renderBattery(): Promise<void> {
        const state = await batterySys.getState();
        if (!state.present) {
            // A desktop still gets the tile: it is how quick settings is reached.
            this.batteryItem.text = '$(plug)';
            this.batteryItem.tooltip = new vscode.MarkdownString('**On mains power**\n\n_Click for quick settings_');
            this.batteryItem.show();
            return;
        }

        this.batteryItem.text = `$(${batterySys.iconFor(state)}) ${state.level}%`;
        const remaining = batterySys.describeRemaining(state);
        this.batteryItem.tooltip = new vscode.MarkdownString(
            [
                `**Battery ${state.level}%**`,
                state.charging ? 'Charging' : state.onAc ? 'Plugged in' : 'On battery',
                remaining ?? '',
                '',
                '_Click for quick settings_',
            ].filter(Boolean).join('\n\n'),
        );
        this.batteryItem.backgroundColor = !state.charging && state.level <= 10
            ? new vscode.ThemeColor('statusBarItem.warningBackground')
            : undefined;
        this.batteryItem.show();
    }

    private async renderVolume(): Promise<void> {
        const state = await audioSys.getVolume();
        if (!state.available) {
            this.volumeItem.hide();
            return;
        }
        this.volumeItem.text = `$(${audioSys.iconFor(state)}) ${state.muted ? 'Muted' : `${state.volume}%`}`;
        this.volumeItem.tooltip = new vscode.MarkdownString(
            `**Volume ${state.volume}%**${state.muted ? ' (muted)' : ''}\n\n_Click for the mixer_`,
        );
        this.volumeItem.show();
    }

    private async renderNetwork(): Promise<void> {
        const state = await networkSys.getSummary();
        if (!state.available) {
            this.networkItem.hide();
            return;
        }
        const wifi = state.active.find((c) => c.type.includes('wireless'));
        const wired = state.active.find((c) => c.type.includes('ethernet'));
        const label = wifi?.name ?? (wired ? 'Wired' : 'Offline');

        this.networkItem.text = `$(${networkSys.iconFor(state)}) ${label}`;
        this.networkItem.tooltip = new vscode.MarkdownString([
            `**${label}**`,
            state.connectivity === 'full' ? 'Internet access' : `Connectivity: ${state.connectivity}`,
            '',
            '_Click to change network_',
        ].join('\n\n'));
        this.networkItem.show();
    }

    private renderMedia(state: NowPlaying | undefined): void {
        const enabled = vscode.workspace.getConfiguration('vscodeos').get<boolean>('music.enabled', true);
        if (!enabled || !state || state.status === 'Stopped') {
            this.mediaItem.hide();
            return;
        }
        const icon = state.status === 'Playing' ? 'debug-pause' : 'play';
        const label = state.artist ? `${state.artist} — ${state.title}` : state.title;
        this.mediaItem.text = `$(${icon}) ${truncate(label, 40)}`;
        this.mediaItem.tooltip = new vscode.MarkdownString(
            [
                `**${state.title}**`,
                state.artist,
                state.album,
                `Playing in ${state.player}`,
                '',
                '_Click for the player_',
            ].filter(Boolean).join('\n\n'),
        );
        this.mediaItem.show();
    }

    dispose(): void {
        if (this.clockTimer) {
            clearInterval(this.clockTimer);
        }
        if (this.slowTimer) {
            clearInterval(this.slowTimer);
        }
        for (const item of this.items) {
            item.dispose();
        }
    }
}

function truncate(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
