// The six tray flyouts, drawn as one right-anchored card.
//
// The panel is full width, so the card pins itself to the bottom-right corner:
// that is what makes it read as a flyout rising out of the tray item that was
// clicked, rather than as a docked panel.

import { append, clear, h, onMessage, post, root, throttle, formatDuration } from './lib/dom';
import { icon, signalIcon } from './lib/icons';
import type { FlyoutKind, FlyoutState, HostMessage } from '../../src/webview/protocol';

let kind: FlyoutKind = 'quicksettings';
let state: FlyoutState | undefined;
let busy: string | undefined;
/** Month the calendar is showing; the clock keeps ticking regardless. */
let calendarMonth = new Date();

const host = h('div', { class: 'flyout-host' });
const card = h('div', { class: 'flyout' });
host.append(card);
clear(root()).append(host);

onMessage<HostMessage>((message) => {
    switch (message.type) {
        case 'flyout':
            if (message.kind !== kind) {
                kind = message.kind;
                calendarMonth = new Date();
                busy = undefined;
            }
            render();
            return;
        case 'state':
            state = message.state;
            busy = undefined;
            render();
            return;
        case 'scanning':
            busy = 'Scanning for networks…';
            render();
            return;
        case 'busy':
            busy = message.label;
            render();
            return;
        default:
            return;
    }
});

post({ type: 'ready' });

// The clock in the calendar card has to tick on its own; the host only pushes
// state every couple of seconds.
setInterval(() => {
    if (kind === 'calendar') {
        render();
    }
}, 1000);

function render(): void {
    card.classList.toggle('wide', kind === 'network' || kind === 'music');
    clear(card);
    switch (kind) {
        case 'power': return renderPower();
        case 'calendar': return renderCalendar();
        case 'volume': return renderVolume();
        case 'network': return renderNetwork();
        case 'music': return renderMusic();
        default: return renderQuickSettings();
    }
}

function title(text: string): HTMLElement {
    return h('h2', { class: 'flyout-title' }, text);
}

// ------------------------------------------------------------------- power

type PowerName = 'poweroff' | 'reboot' | 'suspend' | 'logout';

function renderPower(): void {
    const button = (name: PowerName, label: string, glyph: string, danger = false): HTMLElement =>
        h('button', {
            class: `power-button${danger ? ' danger' : ''}`,
            on: { click: () => post({ type: 'power', action: name }) },
        }, h('span', { html: icon(glyph, 26) }), label);

    append(card,
        title('Power'),
        h('div', { class: 'power-grid' },
            button('poweroff', 'Shut down', 'power', true),
            button('reboot', 'Restart', 'restart'),
            state?.canSuspend !== false ? button('suspend', 'Sleep', 'sleep') : null,
            button('logout', 'Log out', 'logout'),
        ),
        state?.battery?.present
            ? h('p', { class: 'flyout-note' },
                `Battery ${state.battery.level}% · ${state.battery.charging ? 'charging' : state.battery.status.toLowerCase()}`)
            : null,
    );
}

// ---------------------------------------------------------------- calendar

function renderCalendar(): void {
    const now = new Date();
    const shown = calendarMonth;
    const first = new Date(shown.getFullYear(), shown.getMonth(), 1);
    // Monday-first, matching the reference and most of Europe.
    const offset = (first.getDay() + 6) % 7;
    const daysInMonth = new Date(shown.getFullYear(), shown.getMonth() + 1, 0).getDate();
    const daysInPrevious = new Date(shown.getFullYear(), shown.getMonth(), 0).getDate();

    const grid = h('div', { class: 'calendar-grid' });
    for (const day of ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']) {
        grid.append(h('div', { class: 'dow' }, day));
    }

    const cell = (day: number, otherMonth: boolean, date: Date): HTMLElement => {
        const isToday = date.toDateString() === now.toDateString();
        return h('button', {
            class: `calendar-day${otherMonth ? ' other-month' : ''}${isToday ? ' today' : ''}`,
            title: date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
        }, String(day));
    };

    for (let i = offset - 1; i >= 0; i--) {
        const day = daysInPrevious - i;
        grid.append(cell(day, true, new Date(shown.getFullYear(), shown.getMonth() - 1, day)));
    }
    for (let day = 1; day <= daysInMonth; day++) {
        grid.append(cell(day, false, new Date(shown.getFullYear(), shown.getMonth(), day)));
    }
    // Fill the last row so the grid never reflows between months.
    const used = offset + daysInMonth;
    for (let day = 1; used + day - 1 < Math.ceil(used / 7) * 7; day++) {
        grid.append(cell(day, true, new Date(shown.getFullYear(), shown.getMonth() + 1, day)));
    }

    const step = (months: number) => () => {
        calendarMonth = new Date(shown.getFullYear(), shown.getMonth() + months, 1);
        render();
    };

    card.append(
        h('div', { class: 'calendar-clock' }, now.toLocaleTimeString()),
        h('div', { class: 'calendar-date' },
            now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })),
        h('div', { class: 'calendar-head' },
            h('button', {
                class: 'calendar-title icon-button',
                style: { width: 'auto', padding: '0 8px' },
                title: 'Back to this month',
                on: { click: () => { calendarMonth = new Date(); render(); } },
            }, shown.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })),
            h('div', { class: 'calendar-nav' },
                h('button', { title: 'Previous month', html: icon('chevronUp', 16), on: { click: step(-1) } }),
                h('button', { title: 'Next month', html: icon('chevronDown', 16), on: { click: step(1) } }),
            ),
        ),
        grid,
    );
}

// ----------------------------------------------------------- quick settings

function renderQuickSettings(): void {
    const tiles = h('div', { class: 'tiles' });

    const tile = (options: {
        on: boolean;
        glyph: string;
        label: string;
        sub?: string;
        onClick: () => void;
        disabled?: boolean;
    }): HTMLElement =>
        h('button', {
            class: `tile${options.on ? ' on' : ''}`,
            disabled: options.disabled,
            on: { click: options.onClick },
        },
        h('span', { html: options.glyph }),
        h('span', { class: 'tile-label' },
            options.label,
            options.sub ? h('div', { class: 'tile-sub' }, options.sub) : null,
        ));

    const network = state?.network;
    if (network?.wifiHardware) {
        const active = network.active.find((c) => c.type.includes('wireless'));
        tiles.append(tile({
            on: network.wifiEnabled,
            // A real signal strength only exists per access point, and the tile
            // has no room for one - so it says on/off rather than inventing bars.
            glyph: icon(network.wifiEnabled ? 'wifi' : 'wifiOff', 20),
            label: 'Wi-Fi',
            sub: network.wifiEnabled ? (active?.name ?? 'Not connected') : 'Off',
            onClick: () => post({ type: 'wifi', enabled: !network.wifiEnabled }),
        }));
    }

    if (state?.bluetooth?.available) {
        const connected = state.bluetooth.devices.find((d) => d.connected);
        tiles.append(tile({
            on: state.bluetooth.powered,
            glyph: icon('bluetooth', 20),
            label: 'Bluetooth',
            sub: state.bluetooth.powered ? (connected?.name ?? 'Not connected') : 'Off',
            onClick: () => post({ type: 'bluetooth', enabled: !state?.bluetooth?.powered }),
        }));
    }

    tiles.append(tile({
        on: state?.airplaneMode ?? false,
        glyph: icon('airplane', 20),
        label: 'Airplane mode',
        onClick: () => post({ type: 'airplane', enabled: !state?.airplaneMode }),
    }));

    tiles.append(tile({
        on: state?.energySaver ?? false,
        glyph: icon('battery', 20),
        label: 'Energy saver',
        onClick: () => post({ type: 'energySaver', enabled: !state?.energySaver }),
    }));

    tiles.append(tile({
        on: state?.nightLight ?? false,
        glyph: icon('moon', 20),
        label: 'Night light',
        onClick: () => post({ type: 'nightLight', enabled: !state?.nightLight }),
    }));

    tiles.append(tile({
        on: false,
        glyph: icon('accessibility', 20),
        label: 'Accessibility',
        onClick: () => post({ type: 'accessibility' }),
    }));

    card.append(title('Quick settings'), tiles);

    if (state?.brightness !== undefined) {
        card.append(slider('sun', state.brightness, 1, 100, (value) => post({ type: 'brightness', value })));
    }

    if (state?.audio?.available) {
        const audio = state.audio;
        card.append(slider(
            audio.muted ? 'volumeMute' : 'volumeHigh',
            audio.muted ? 0 : audio.volume,
            0,
            100,
            (value) => post({ type: 'volume', value }),
            () => post({ type: 'mute' }),
        ));
    }

    const battery = state?.battery;
    if (battery) {
        card.append(h('p', { class: 'flyout-note' },
            battery.present
                ? `Battery ${battery.level}% · ${battery.charging ? 'charging' : battery.onAc ? 'plugged in' : 'on battery'}`
                : 'Running on mains power'));
    }
}

function slider(
    glyph: string,
    value: number,
    min: number,
    max: number,
    onInput: (value: number) => void,
    onIconClick?: () => void,
): HTMLElement {
    const readout = h('span', { class: 'slider-value' }, `${Math.round(value)}%`);
    const send = throttle(onInput, 120);
    return h('div', { class: 'slider-row' },
        h(onIconClick ? 'button' : 'span', {
            class: onIconClick ? 'icon-button' : '',
            html: icon(glyph, 18),
            on: onIconClick ? { click: onIconClick } : {},
        }),
        h('input', {
            type: 'range',
            min,
            max,
            value,
            on: {
                input: (event: Event) => {
                    const next = Number((event.target as HTMLInputElement).value);
                    readout.textContent = `${next}%`;
                    send(next);
                },
            },
        }),
        readout,
    );
}

// ------------------------------------------------------------------ volume

function renderVolume(): void {
    const audio = state?.audio;
    if (!audio?.available) {
        card.append(title('Volume'), h('div', { class: 'empty' }, 'No audio device found.'));
        return;
    }

    card.append(
        title('Volume'),
        slider(
            audio.muted ? 'volumeMute' : 'volumeHigh',
            audio.muted ? 0 : audio.volume,
            0,
            100,
            (value) => post({ type: 'volume', value }),
            () => post({ type: 'mute' }),
        ),
        h('div', { class: 'section-head' }, 'Output device'),
    );

    const list = h('div', { class: 'list' });
    if (audio.sinks.length === 0) {
        list.append(h('div', { class: 'empty' }, 'No outputs reported.'));
    }
    for (const sink of audio.sinks) {
        list.append(h('button', {
            class: `list-row${sink.isDefault ? ' active' : ''}`,
            on: { click: () => post({ type: 'sink', id: sink.id }) },
        },
        h('span', { html: icon('volume', 18) }),
        h('span', { class: 'list-main' }, h('div', { class: 'list-name' }, sink.name)),
        sink.isDefault ? h('span', { html: icon('check', 16) }) : null,
        ));
    }
    card.append(list);
}

// ----------------------------------------------------------------- network

function renderNetwork(): void {
    const network = state?.network;
    card.append(title('Network'));

    if (!network?.available) {
        card.append(h('div', { class: 'empty' }, 'NetworkManager is not running.'));
        return;
    }

    const list = h('div', { class: 'list' });

    for (const connection of network.active.filter((c) => !c.type.includes('wireless'))) {
        list.append(h('div', { class: 'list-row active' },
            h('span', { html: icon('ethernet', 18) }),
            h('span', { class: 'list-main' },
                h('div', { class: 'list-name' }, connection.name),
                h('div', { class: 'list-sub' }, `${connection.type} · ${connection.device}`),
            ),
            h('button', {
                class: 'icon-button',
                title: 'Disconnect',
                html: icon('close', 15),
                on: { click: () => post({ type: 'disconnect', name: connection.name }) },
            }),
        ));
    }

    card.append(
        h('div', { class: 'section-head' },
            h('span', {}, network.wifiHardware ? 'Wi-Fi' : 'Connections'),
            h('span', { style: { display: 'flex', gap: '2px' } },
                network.wifiHardware
                    ? h('button', {
                        class: 'icon-button',
                        title: network.wifiEnabled ? 'Turn Wi-Fi off' : 'Turn Wi-Fi on',
                        html: icon(network.wifiEnabled ? 'wifi' : 'wifiOff', 15),
                        on: { click: () => post({ type: 'wifi', enabled: !network.wifiEnabled }) },
                    })
                    : null,
                network.wifiHardware && network.wifiEnabled
                    ? h('button', {
                        class: 'icon-button',
                        title: 'Scan again',
                        html: icon('refresh', 15),
                        on: { click: () => post({ type: 'scan' }) },
                    })
                    : null,
            ),
        ),
        list,
    );

    if (busy) {
        card.append(h('div', { class: 'empty' }, busy));
        return;
    }

    if (!network.wifiHardware) {
        card.append(h('p', { class: 'flyout-note' }, 'No wireless adapter on this machine.'));
        return;
    }
    if (!network.wifiEnabled) {
        card.append(h('div', { class: 'empty' }, 'Wi-Fi is off.'));
        return;
    }
    if (network.accessPoints.length === 0) {
        card.append(h('div', { class: 'empty' }, 'No networks in range.'));
        return;
    }

    const wifiList = h('div', { class: 'list' });
    for (const point of network.accessPoints) {
        const secured = point.security !== '' && point.security !== '--';
        wifiList.append(h('button', {
            class: `list-row${point.inUse ? ' active' : ''}`,
            on: {
                click: () => {
                    if (point.inUse) {
                        post({ type: 'disconnect', name: point.ssid });
                    } else {
                        post({ type: 'connect', ssid: point.ssid, secured, known: point.known });
                    }
                },
            },
        },
        h('span', { html: signalIcon(point.signal, 18) }),
        h('span', { class: 'list-main' },
            h('div', { class: 'list-name' }, point.ssid),
            h('div', { class: 'list-sub' },
                point.inUse ? 'Connected' : point.known ? 'Saved' : secured ? point.security : 'Open'),
        ),
        secured ? h('span', { html: icon('lock', 14), style: { opacity: '0.7' } }) : null,
        ));
    }
    card.append(wifiList);
}

// ------------------------------------------------------------------- music

function renderMusic(): void {
    card.append(title('Music'));

    const launchers = h('div', { class: 'tiles', style: { gridTemplateColumns: 'repeat(2, 1fr)' } },
        h('button', {
            class: 'tile',
            on: { click: () => post({ type: 'launchMusic', service: 'spotify' }) },
        }, h('span', { html: icon('music', 20) }), h('span', { class: 'tile-label' }, 'Spotify Web')),
        h('button', {
            class: 'tile',
            on: { click: () => post({ type: 'launchMusic', service: 'ytmusic' }) },
        }, h('span', { html: icon('play', 20) }), h('span', { class: 'tile-label' }, 'YouTube Music')),
    );
    card.append(launchers);

    if (!state?.mprisAvailable) {
        card.append(h('p', { class: 'flyout-note' },
            'Install playerctl to control playback from here: sudo pacman -S playerctl'));
        return;
    }

    const playing = state.nowPlaying;
    card.append(h('div', { class: 'section-head' }, 'Now playing'));

    if (!playing) {
        card.append(h('div', { class: 'empty' },
            'Nothing is playing. Open one of the services above and press play.'));
        return;
    }

    card.append(h('div', { class: 'now-playing' },
        playing.artUrl
            ? h('img', { class: 'album-art', src: playing.artUrl, alt: '' })
            : h('div', { class: 'album-art', style: { display: 'flex', alignItems: 'center', justifyContent: 'center' }, html: icon('music', 26) }),
        h('div', { class: 'list-main' },
            h('div', { class: 'list-name', style: { fontWeight: '600' } }, playing.title),
            h('div', { class: 'list-sub' }, playing.artist || '—'),
            h('div', { class: 'list-sub' }, playing.album || playing.player),
        ),
    ));

    card.append(h('div', { class: 'transport' },
        h('button', {
            title: 'Previous',
            html: icon('previous', 18),
            on: { click: () => post({ type: 'transport', action: 'previous' }) },
        }),
        h('button', {
            class: 'primary',
            title: playing.status === 'Playing' ? 'Pause' : 'Play',
            html: icon(playing.status === 'Playing' ? 'pause' : 'play', 20),
            on: { click: () => post({ type: 'transport', action: 'playPause' }) },
        }),
        h('button', {
            title: 'Next',
            html: icon('next', 18),
            on: { click: () => post({ type: 'transport', action: 'next' }) },
        }),
    ));

    if (playing.length > 0) {
        card.append(h('div', { class: 'progress-row' },
            h('span', {}, formatDuration(playing.position)),
            h('input', {
                type: 'range',
                min: 0,
                max: Math.round(playing.length),
                value: Math.round(playing.position),
                on: {
                    change: (event: Event) =>
                        post({ type: 'seek', seconds: Number((event.target as HTMLInputElement).value) }),
                },
            }),
            h('span', {}, formatDuration(playing.length)),
        ));
    }

    if ((state.players?.length ?? 0) > 1) {
        card.append(h('p', { class: 'flyout-note' }, `Players: ${state.players?.join(', ')}`));
    }
}

// Escape closes the flyout, the way a real one does.
window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        post({ type: 'command', command: 'workbench.action.closePanel' });
    }
});
