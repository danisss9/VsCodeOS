// The nine tray flyouts, drawn as one card.
//
// In the bottom panel the host is full width, so the card pins itself to the
// bottom-right corner and reads as a flyout rising out of the tray item that was
// clicked. In the side bar - the default - the container is already the right
// width and the anchoring does nothing, which is exactly what is wanted there.

import { append, clear, h, onMessage, post, root, throttle, formatDuration } from './lib/dom';
import { icon, signalIcon } from './lib/icons';
import type {
    AppEntry,
    BluetoothDevice,
    FlyoutKind,
    FlyoutState,
    HostMessage,
    NotificationRecord,
} from '../../src/webview/protocol';

let kind: FlyoutKind = 'apps';
let state: FlyoutState | undefined;
let busy: string | undefined;
/** Month the calendar is showing; the clock keeps ticking regardless. */
let calendarMonth = new Date();
/** What has been typed into the launcher's search box. */
let appQuery = '';

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
                appQuery = '';
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
    card.classList.toggle(
        'wide',
        kind === 'network' || kind === 'music' || kind === 'apps'
        || kind === 'bluetooth' || kind === 'notifications',
    );
    clear(card);
    switch (kind) {
        case 'apps': return renderApps();
        case 'power': return renderPower();
        case 'calendar': return renderCalendar();
        case 'volume': return renderVolume();
        case 'network': return renderNetwork();
        case 'bluetooth': return renderBluetooth();
        case 'music': return renderMusic();
        case 'notifications': return renderNotifications();
        default: return renderPowerSettings();
    }
}

function title(text: string): HTMLElement {
    return h('h2', { class: 'flyout-title' }, text);
}

// -------------------------------------------------------------- app launcher

function matches(app: AppEntry, query: string): boolean {
    if (!query) {
        return true;
    }
    const haystack = [app.title, app.description, ...(app.keywords ?? [])].join(' ').toLowerCase();
    // Every word has to appear somewhere, so "voice rec" finds the recorder but
    // "voice paint" finds nothing.
    return query.toLowerCase().split(/\s+/).filter(Boolean).every((word) => haystack.includes(word));
}

function renderApps(): void {
    const open = (app: AppEntry): void => post({ type: 'command', command: app.command });

    const search = h('input', {
        class: 'app-search',
        type: 'text',
        placeholder: 'Search apps',
        value: appQuery,
        'aria-label': 'Search apps',
        on: {
            input: (event: Event) => {
                appQuery = (event.target as HTMLInputElement).value;
                renderGrid();
            },
            keydown: (event: KeyboardEvent) => {
                if (event.key === 'Enter') {
                    const first = (state?.apps ?? []).filter((app) => matches(app, appQuery))[0];
                    if (first) {
                        open(first);
                    }
                }
            },
        },
    });

    const grid = h('div', { class: 'app-grid' });

    function renderGrid(): void {
        const list = (state?.apps ?? []).filter((app) => matches(app, appQuery));
        clear(grid);
        if (list.length === 0) {
            grid.append(h('div', { class: 'empty' }, 'No app matches that.'));
            return;
        }
        for (const app of list) {
            grid.append(h('button', {
                class: 'app-tile',
                title: app.description,
                on: { click: () => open(app) },
            },
            h('span', { class: 'app-tile-icon', html: icon(app.icon, 26) }),
            h('span', { class: 'app-tile-label' }, app.title),
            ));
        }
    }

    card.append(
        h('div', { class: 'app-search-row' },
            h('span', { class: 'app-search-icon', html: icon('search', 16) }),
            search,
        ),
        grid,
    );
    renderGrid();

    // Typing should start immediately, the way a start menu does. The view is
    // focused by the host unless it was opened with preserveFocus.
    setTimeout(() => search.focus(), 0);
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

// ----------------------------------------------------------- power settings

/**
 * The battery tile's menu. Three things and no more: how much power the machine
 * is using, how bright the screen is, and how much charge is left. Wi-Fi,
 * Bluetooth and airplane mode used to be here too and are now on the tray items
 * and cards that own them.
 */
function renderPowerSettings(): void {
    const battery = state?.battery;

    card.append(
        title('Power'),
        h('div', { class: 'tiles', style: { gridTemplateColumns: '1fr' } },
            h('button', {
                class: `tile${state?.energySaver ? ' on' : ''}`,
                on: { click: () => post({ type: 'energySaver', enabled: !state?.energySaver }) },
            },
            h('span', { html: icon('bolt', 20) }),
            h('span', { class: 'tile-label' },
                'Energy saver',
                h('div', { class: 'tile-sub' },
                    state?.energySaver ? 'On — dimmed, screen sleeps sooner' : 'Off — full performance'),
            )),
        ),
    );

    if (state?.brightness !== undefined) {
        // The moon button toggles night light: it is a property of the screen's
        // light, so it belongs on the brightness row rather than in a tile.
        card.append(slider(
            state.nightLight ? 'moon' : 'sun',
            state.brightness,
            1,
            100,
            (value) => post({ type: 'brightness', value }),
            () => post({ type: 'nightLight', enabled: !state?.nightLight }),
            state.nightLight ? 'Turn night light off' : 'Turn night light on',
        ));
    }

    if (battery?.present) {
        card.append(h('div', { class: 'battery-readout' },
            h('span', { class: 'battery-level' }, `${battery.level}%`),
            h('span', { class: 'list-sub' },
                battery.charging ? 'Charging' : battery.onAc ? 'Plugged in' : 'On battery'),
        ));
    } else if (battery) {
        card.append(h('p', { class: 'flyout-note' }, 'Running on mains power.'));
    }
}

function slider(
    glyph: string,
    value: number,
    min: number,
    max: number,
    onInput: (value: number) => void,
    onIconClick?: () => void,
    iconTitle?: string,
): HTMLElement {
    const readout = h('span', { class: 'slider-value' }, `${Math.round(value)}%`);
    const send = throttle(onInput, 120);
    return h('div', { class: 'slider-row' },
        h(onIconClick ? 'button' : 'span', {
            class: onIconClick ? 'icon-button' : '',
            title: iconTitle,
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

// ----------------------------------------------------------- notifications

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
    if (seconds < 86400) {
        return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    }
    return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function notificationRow(record: NotificationRecord, now: number): HTMLElement {
    return h('div', { class: `list-row${record.urgency === 'critical' ? ' urgent' : ''}` },
        h('span', { html: icon(record.urgency === 'critical' ? 'warning' : 'bell', 18) }),
        h('span', { class: 'list-main' },
            h('div', { class: 'list-name wrap' }, record.text),
            h('div', { class: 'list-sub' }, `${record.appName} · ${whenLabel(record.at, now)}`),
        ),
        h('button', {
            class: 'icon-button',
            title: 'Dismiss',
            html: icon('close', 15),
            on: { click: () => post({ type: 'dismissNotification', id: record.id }) },
        }),
    );
}

function renderNotifications(): void {
    const records = state?.notifications ?? [];
    card.append(
        h('div', { class: 'section-head' },
            h('span', {}, 'Notifications'),
            records.length > 0
                ? h('button', {
                    class: 'link-button',
                    on: { click: () => post({ type: 'clearNotifications' }) },
                }, 'Clear all')
                : null,
        ),
    );

    if (state?.notificationsAvailable === false) {
        // Another daemon holds the bus name, so nothing will ever land here and
        // an empty list would look like a bug rather than a decision.
        card.append(h('div', { class: 'empty' },
            'Another notification daemon owns the desktop bus, so notifications go there instead.'));
        return;
    }

    if (records.length === 0) {
        card.append(h('div', { class: 'empty' }, 'Nothing to catch up on.'));
        return;
    }

    const now = state?.now ?? Date.now();
    const list = h('div', { class: 'list' });
    for (const record of records) {
        list.append(notificationRow(record, now));
    }
    card.append(list);
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

    // The input half. It was already being fetched and thrown away; a machine
    // with two microphones had no way at all to say which one to record from.
    if (audio.sources.length === 0 && !audio.input) {
        return;
    }
    card.append(h('div', { class: 'section-head' }, 'Input device'));
    if (audio.input) {
        card.append(slider(
            audio.input.muted ? 'micMute' : 'mic',
            audio.input.muted ? 0 : audio.input.volume,
            0,
            100,
            (value) => post({ type: 'micVolume', value }),
            () => post({ type: 'micMute' }),
            audio.input.muted ? 'Unmute the microphone' : 'Mute the microphone',
        ));
    }

    const inputs = h('div', { class: 'list' });
    if (audio.sources.length === 0) {
        inputs.append(h('div', { class: 'empty' }, 'No microphone found.'));
    }
    for (const source of audio.sources) {
        inputs.append(h('button', {
            class: `list-row${source.isDefault ? ' active' : ''}`,
            on: { click: () => post({ type: 'source', id: source.id }) },
        },
        h('span', { html: icon('mic', 18) }),
        h('span', { class: 'list-main' }, h('div', { class: 'list-name' }, source.name)),
        source.isDefault ? h('span', { html: icon('check', 16) }) : null,
        ));
    }
    card.append(inputs);
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
                // Airplane mode lives here rather than in the power menu: it is a
                // radio switch, and this is the card about radios.
                h('button', {
                    class: `icon-button${state?.airplaneMode ? ' on' : ''}`,
                    title: state?.airplaneMode ? 'Turn airplane mode off' : 'Turn airplane mode on',
                    html: icon('airplane', 15),
                    on: { click: () => post({ type: 'airplane', enabled: !state?.airplaneMode }) },
                }),
                network.wifiHardware
                    ? h('button', {
                        class: `icon-button${network.wifiEnabled ? ' on' : ''}`,
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

    if (state?.airplaneMode) {
        card.append(h('p', { class: 'flyout-note' }, 'Airplane mode is on — every radio is off.'));
    }

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

// --------------------------------------------------------------- bluetooth

function renderBluetooth(): void {
    const bluetooth = state?.bluetooth;
    card.append(title('Bluetooth'));

    if (!bluetooth?.available) {
        card.append(h('div', { class: 'empty' }, 'No Bluetooth adapter on this machine.'));
        return;
    }

    card.append(h('div', { class: 'section-head' },
        h('span', {}, bluetooth.powered ? 'On' : 'Off'),
        h('span', { style: { display: 'flex', gap: '2px' } },
            h('button', {
                class: `icon-button${bluetooth.powered ? ' on' : ''}`,
                title: bluetooth.powered ? 'Turn Bluetooth off' : 'Turn Bluetooth on',
                html: icon(bluetooth.powered ? 'bluetooth' : 'bluetoothOff', 15),
                on: { click: () => post({ type: 'bluetooth', enabled: !bluetooth.powered }) },
            }),
            bluetooth.powered
                ? h('button', {
                    class: 'icon-button',
                    title: 'Look for nearby devices',
                    disabled: state?.bluetoothScanning,
                    html: icon('refresh', 15),
                    on: { click: () => post({ type: 'bluetoothScan' }) },
                })
                : null,
        ),
    ));

    if (!bluetooth.powered) {
        card.append(h('div', { class: 'empty' }, 'Bluetooth is off.'));
        return;
    }

    if (busy) {
        card.append(h('div', { class: 'empty' }, busy));
        return;
    }

    const paired = bluetooth.devices.filter((device) => device.paired);
    const nearby = bluetooth.devices.filter((device) => !device.paired);

    const row = (device: BluetoothDevice): HTMLElement =>
        h('div', {
            class: `list-row${device.connected ? ' active' : ''}`,
            title: device.mac,
        },
        h('span', { html: icon('bluetooth', 18) }),
        h('span', { class: 'list-main' },
            h('div', { class: 'list-name' }, device.name),
            h('div', { class: 'list-sub' }, device.connected ? 'Connected' : device.paired ? 'Paired' : device.mac),
        ),
        h('button', {
            class: 'button',
            on: {
                click: () => post(device.paired
                    ? { type: 'bluetoothDevice', mac: device.mac, connect: !device.connected }
                    : { type: 'bluetoothPair', mac: device.mac }),
            },
        }, device.paired ? (device.connected ? 'Disconnect' : 'Connect') : 'Pair'),
        device.paired
            ? h('button', {
                class: 'icon-button',
                title: 'Forget this device',
                html: icon('trash', 15),
                on: { click: () => post({ type: 'bluetoothForget', mac: device.mac, name: device.name }) },
            })
            : null,
        );

    const pairedList = h('div', { class: 'list' });
    if (paired.length === 0) {
        pairedList.append(h('div', { class: 'empty' }, 'Nothing paired yet.'));
    }
    for (const device of paired) {
        pairedList.append(row(device));
    }
    card.append(h('div', { class: 'section-head' }, 'My devices'), pairedList);

    card.append(h('div', { class: 'section-head' },
        state?.bluetoothScanning ? 'Looking for devices…' : 'Nearby'));
    const nearbyList = h('div', { class: 'list' });
    if (nearby.length === 0) {
        nearbyList.append(h('div', { class: 'empty' },
            state?.bluetoothScanning ? 'Scanning…' : 'Press the refresh button to look for devices.'));
    }
    for (const device of nearby) {
        nearbyList.append(row(device));
    }
    card.append(nearbyList);
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

// Escape closes the flyout, the way a real one does. Which container it lives in
// decides whether that means closing the side bar or the panel, and only the
// host knows - closing both here would take the terminal down with it.
window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        post({ type: 'closeFlyout' });
    }
});
