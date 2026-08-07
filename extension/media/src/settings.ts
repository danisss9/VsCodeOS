// System Settings, drawn as a rail and a pane.
//
// Every pane is rebuilt from whatever `settings` message last arrived. The one
// exception is Updates, which keeps its own module state in lib/updates.ts so a
// running `pacman -Syu` and its log survive a trip to another pane and back.

import { append, clear, formatBytes, h, onMessage, post, root, throttle } from './lib/dom';
import { icon } from './lib/icons';
import { handleUpdateMessage, renderUpdates } from './lib/updates';
import type {
    AboutInfo,
    CleanupCategory,
    CleanupId,
    DisplayOutput,
    DisplaySettings,
    HostMessage,
    KeyboardState,
    SettingsSection,
    SettingsState,
    AudioState,
    StorageState,
} from '../../src/webview/protocol';

interface RailEntry {
    id: SettingsSection;
    title: string;
    glyph: string;
    sub: string;
}

const RAIL: RailEntry[] = [
    { id: 'display', title: 'Display', glyph: 'display', sub: 'Resolution, rotation, night light' },
    { id: 'keyboard', title: 'Keyboard', glyph: 'keyboard', sub: 'Layout and key repeat' },
    { id: 'sound', title: 'Sound', glyph: 'volume', sub: 'Speakers and microphone' },
    { id: 'storage', title: 'Storage', glyph: 'disk', sub: 'Disk usage and clean-up' },
    { id: 'updates', title: 'Updates', glyph: 'update', sub: 'System, editor and shell' },
    { id: 'about', title: 'About', glyph: 'cpu', sub: 'What this machine is' },
];

let state: SettingsState = { section: 'display' };
let busy: string | undefined;
/** Cleanup rows the user has ticked, kept across the refresh a clean triggers. */
const chosen = new Set<CleanupId>();

const rail = h('div', { class: 'places settings-rail' });
const pane = h('div', { class: 'files settings-pane' });

clear(root()).append(h('div', { class: 'app' },
    h('div', { class: 'toolbar' },
        h('span', { html: icon('gear', 16) }),
        h('span', {}, 'System Settings'),
    ),
    h('div', { class: 'body' }, h('div', { class: 'explorer' }, rail, pane)),
));

onMessage<HostMessage>((message) => {
    if (message.type === 'settings') {
        state = message.state;
        busy = undefined;
        render();
        return;
    }
    if (message.type === 'settingsBusy') {
        busy = message.label;
        render();
        return;
    }
    // Updates owns its own DOM; it only needs redrawing when it is on screen.
    if (handleUpdateMessage(message) && state.section === 'updates') {
        render();
    }
});

post({ type: 'ready' });

// ------------------------------------------------------------------ chrome

function render(): void {
    renderRail();
    clear(pane);

    if (busy) {
        pane.append(h('div', { class: 'empty' }, busy));
        return;
    }

    switch (state.section) {
        case 'display': return renderDisplay(state.display);
        case 'keyboard': return renderKeyboard(state.keyboard);
        case 'sound': return renderSound(state.audio);
        case 'storage': return renderStorage(state.storage);
        case 'updates': return renderUpdates(pane);
        default: return renderAbout(state.about);
    }
}

function renderRail(): void {
    clear(rail);
    for (const entry of RAIL) {
        rail.append(h('button', {
            class: `list-row${entry.id === state.section ? ' active' : ''}`,
            on: { click: () => post({ type: 'settingsSection', section: entry.id }) },
        },
        h('span', { html: icon(entry.glyph, 17) }),
        h('span', { class: 'list-main' },
            h('div', { class: 'list-name' }, entry.title),
            h('div', { class: 'list-sub' }, entry.sub),
        ),
        ));
    }
}

function paneHead(title: string, sub: string, ...actions: (Node | null)[]): HTMLElement {
    return h('div', { class: 'pane-head' },
        h('div', { class: 'pane-title' }, title),
        h('div', { class: 'pane-sub' }, sub),
        actions.some(Boolean) ? append(h('div', { class: 'pane-actions' }), ...actions) : null,
    );
}

function field(label: string, control: Node, hint?: string): HTMLElement {
    return h('div', { class: 'setting-row' },
        h('div', { class: 'setting-label' },
            h('div', {}, label),
            hint ? h('div', { class: 'list-sub' }, hint) : null,
        ),
        h('div', { class: 'setting-control' }, control),
    );
}

function select(options: { value: string; label: string }[], current: string, onPick: (value: string) => void): HTMLElement {
    const el = h('select', { class: 'setting-select' }) as HTMLSelectElement;
    for (const option of options) {
        const item = h('option', { value: option.value }, option.label) as HTMLOptionElement;
        item.selected = option.value === current;
        el.append(item);
    }
    el.addEventListener('change', () => onPick(el.value));
    return el;
}

// ----------------------------------------------------------------- display

function renderDisplay(settings: DisplaySettings | undefined): void {
    pane.append(paneHead('Display', 'Resolution, refresh rate and orientation, per screen.'));

    if (!settings?.available) {
        pane.append(h('div', { class: 'empty' },
            'xrandr is not available, so the screen cannot be reconfigured from here.'));
        return;
    }

    const connected = settings.outputs.filter((o) => o.connected);
    if (connected.length === 0) {
        pane.append(h('div', { class: 'empty' }, 'No connected screens reported.'));
    }

    for (const out of connected) {
        pane.append(renderOutput(out, connected.length > 1));
    }

    const disconnected = settings.outputs.filter((o) => !o.connected);
    if (disconnected.length > 0) {
        pane.append(
            h('div', { class: 'section-head' }, 'Not connected'),
            h('div', { class: 'list-sub' }, disconnected.map((o) => o.name).join(', ')),
        );
    }
}

function renderOutput(out: DisplayOutput, showPrimary: boolean): HTMLElement {
    const block = h('div', { class: 'setting-group' },
        h('div', { class: 'section-head' },
            h('span', {}, out.name),
            out.primary ? h('span', { class: 'update-badge current' }, 'Primary') : null,
        ),
    );

    // One entry per size; the rate picker below chooses among that size's rates.
    const sizes = out.modes.map((mode) => ({
        value: mode.size,
        label: `${mode.size}${mode.preferred ? ' (recommended)' : ''}`,
    }));
    const current = out.currentMode ?? sizes[0]?.value ?? '';
    const currentMode = out.modes.find((m) => m.size === current);

    block.append(field(
        'Resolution',
        select(sizes, current, (mode) => post({ type: 'setDisplayMode', output: out.name, mode })),
        currentMode?.preferred ? 'This is the screen’s native resolution.' : undefined,
    ));

    if (currentMode && currentMode.rates.length > 1) {
        block.append(field(
            'Refresh rate',
            select(
                currentMode.rates.map((rate) => ({ value: String(rate), label: `${rate} Hz` })),
                String(out.currentRate ?? currentMode.rates[0]),
                (rate) => post({ type: 'setDisplayMode', output: out.name, mode: current, rate: Number(rate) }),
            ),
        ));
    }

    block.append(field(
        'Orientation',
        select(
            [
                { value: 'normal', label: 'Landscape' },
                { value: 'left', label: 'Portrait (left)' },
                { value: 'right', label: 'Portrait (right)' },
                { value: 'inverted', label: 'Upside down' },
            ],
            out.rotation,
            (rotation) => post({
                type: 'setDisplayMode',
                output: out.name,
                mode: current,
                rotation: rotation as DisplayOutput['rotation'],
            }),
        ),
    ));

    if (showPrimary && !out.primary) {
        block.append(field(
            'Primary screen',
            h('button', {
                class: 'button',
                on: {
                    click: () => post({ type: 'setDisplayMode', output: out.name, mode: current, primary: true }),
                },
            }, `Make ${out.name} primary`),
        ));
    }

    return block;
}

// ---------------------------------------------------------------- keyboard

function renderKeyboard(settings: KeyboardState | undefined): void {
    pane.append(paneHead('Keyboard', 'The layout, and how fast a held key repeats.'));

    if (!settings?.available) {
        pane.append(h('div', { class: 'empty' },
            'Neither setxkbmap nor localectl is installed, so the layout cannot be changed from here.'));
        return;
    }

    const layouts = settings.layouts.length > 0
        ? settings.layouts
        : [settings.current?.code ?? 'us'];

    pane.append(h('div', { class: 'setting-group' },
        field(
            'Layout',
            select(
                layouts.map((code) => ({ value: code, label: code })),
                settings.current?.code ?? '',
                (code) => post({ type: 'setKeyboardLayout', code }),
            ),
            settings.canPersist
                ? 'Applies now and is written to /etc/X11 so it survives a reboot.'
                : 'Applies to this session only: localectl is not installed.',
        ),
        settings.current?.variant
            ? field('Variant', h('div', { class: 'setting-static' }, settings.current.variant))
            : null,
    ));

    const repeat = settings.repeat;
    const group = h('div', { class: 'setting-group' },
        h('div', { class: 'section-head' }, 'Key repeat'),
    );

    const sendRepeat = throttle(
        (next: { delay: number; rate: number }) => post({ type: 'setKeyRepeat', repeat: next }),
        200,
    );

    group.append(
        field(
            'Delay before repeating',
            rangeControl(repeat.delay, 100, 1000, 50, `${repeat.delay} ms`,
                (delay) => sendRepeat({ delay, rate: repeat.rate })),
        ),
        field(
            'Repeat speed',
            rangeControl(repeat.rate, 5, 60, 1, `${repeat.rate} / second`,
                (rate) => sendRepeat({ delay: repeat.delay, rate })),
        ),
        h('div', { class: 'list-sub' },
            'Key repeat applies to this session; the shell reapplies it at every login.'),
    );
    pane.append(group);

    pane.append(h('div', { class: 'setting-group' },
        h('div', { class: 'section-head' }, 'Try it'),
        h('input', {
            class: 'app-search',
            type: 'text',
            placeholder: 'Type here to test the layout and repeat rate',
        }),
    ));
}

function rangeControl(
    value: number,
    min: number,
    max: number,
    step: number,
    label: string,
    onInput: (value: number) => void,
): HTMLElement {
    const readout = h('span', { class: 'slider-value' }, label);
    const input = h('input', {
        type: 'range',
        min: String(min),
        max: String(max),
        step: String(step),
        value: String(value),
        on: {
            input: (event: Event) => {
                const next = Number((event.target as HTMLInputElement).value);
                readout.textContent = label.replace(/^[\d.]+/, String(next));
                onInput(next);
            },
        },
    });
    return h('div', { class: 'slider-row' }, input, readout);
}

// ------------------------------------------------------------------- sound

function renderSound(audio: AudioState | undefined): void {
    pane.append(paneHead('Sound', 'Which speakers play, which microphone records.'));

    if (!audio?.available) {
        pane.append(h('div', { class: 'empty' }, 'No audio server is running.'));
        return;
    }

    pane.append(deviceGroup(
        'Output',
        audio.sinks,
        'volume',
        audio.muted ? 0 : audio.volume,
        audio.muted,
        (value) => post({ type: 'volume', value }),
        () => post({ type: 'mute' }),
        (id) => post({ type: 'sink', id }),
        'No speakers reported.',
    ));

    pane.append(deviceGroup(
        'Input',
        audio.sources,
        'mic',
        audio.input ? (audio.input.muted ? 0 : audio.input.volume) : undefined,
        audio.input?.muted ?? false,
        (value) => post({ type: 'micVolume', value }),
        () => post({ type: 'micMute' }),
        (id) => post({ type: 'source', id }),
        'No microphone found.',
    ));

    pane.append(h('div', { class: 'list-sub' },
        'The voice recorder records from whichever input is selected here.'));
}

function deviceGroup(
    title: string,
    devices: { id: string; name: string; isDefault: boolean }[],
    glyph: string,
    level: number | undefined,
    muted: boolean,
    onLevel: (value: number) => void,
    onMute: () => void,
    onPick: (id: string) => void,
    emptyText: string,
): HTMLElement {
    const group = h('div', { class: 'setting-group' }, h('div', { class: 'section-head' }, title));

    if (level !== undefined) {
        const readout = h('span', { class: 'slider-value' }, muted ? 'Muted' : `${level}%`);
        const send = throttle(onLevel, 120);
        group.append(h('div', { class: 'slider-row' },
            h('button', {
                class: 'icon-button',
                title: muted ? 'Unmute' : 'Mute',
                html: icon(muted ? (glyph === 'mic' ? 'micMute' : 'volumeMute') : glyph, 18),
                on: { click: onMute },
            }),
            h('input', {
                type: 'range',
                min: '0',
                max: '100',
                value: String(level),
                on: {
                    input: (event: Event) => {
                        const next = Number((event.target as HTMLInputElement).value);
                        readout.textContent = `${next}%`;
                        send(next);
                    },
                },
            }),
            readout,
        ));
    }

    const list = h('div', { class: 'list' });
    if (devices.length === 0) {
        list.append(h('div', { class: 'empty' }, emptyText));
    }
    for (const device of devices) {
        list.append(h('button', {
            class: `list-row${device.isDefault ? ' active' : ''}`,
            on: { click: () => onPick(device.id) },
        },
        h('span', { html: icon(glyph, 18) }),
        h('span', { class: 'list-main' }, h('div', { class: 'list-name' }, device.name)),
        device.isDefault ? h('span', { html: icon('check', 16) }) : null,
        ));
    }
    group.append(list);
    return group;
}

// ----------------------------------------------------------------- storage

function renderStorage(storage: StorageState | undefined): void {
    const selectable = (storage?.categories ?? []).filter((c) => c.available && c.bytes > 0);
    const total = selectable
        .filter((c) => chosen.has(c.id))
        .reduce((sum, c) => sum + c.bytes, 0);

    pane.append(paneHead(
        'Storage',
        'What is using the disk, and what can safely be thrown away.',
        h('button', {
            class: 'button',
            on: { click: () => post({ type: 'settingsSection', section: 'storage' }) },
        }, h('span', { html: icon('refresh', 15) }), 'Rescan'),
        chosen.size > 0
            ? h('button', {
                class: 'button primary',
                on: { click: () => post({ type: 'cleanStorage', ids: [...chosen] }) },
            }, `Clean up ${formatBytes(total)}`)
            : null,
    ));

    if (!storage) {
        pane.append(h('div', { class: 'empty' }, 'Measuring…'));
        return;
    }

    pane.append(h('div', { class: 'section-head' }, 'Disks'));
    const disks = h('div', { class: 'setting-group' });
    for (const mount of storage.mounts) {
        const percent = mount.totalBytes > 0 ? (mount.usedBytes / mount.totalBytes) * 100 : 0;
        disks.append(h('div', { class: 'storage-mount' },
            h('div', { class: 'storage-mount-head' },
                h('span', { html: icon('disk', 16) }),
                h('span', { class: 'list-name' }, mount.label || mount.mountpoint),
                h('span', { class: 'list-sub' },
                    `${formatBytes(mount.freeBytes)} free of ${formatBytes(mount.totalBytes)}`),
            ),
            h('div', { class: `bar${percent >= 90 ? ' warn' : ''}` },
                h('span', { style: { width: `${Math.min(100, percent)}%` } }),
            ),
        ));
    }
    pane.append(disks);

    pane.append(h('div', { class: 'section-head' }, 'Clean up'));
    const list = h('div', { class: 'list' });
    const cleanable = storage.categories.filter((c) => c.available);
    if (cleanable.length === 0) {
        list.append(h('div', { class: 'empty' }, 'Nothing measurable to clean.'));
    }
    for (const category of cleanable) {
        list.append(cleanupRow(category));
    }
    pane.append(list);

    if (!storage.canElevate) {
        pane.append(h('div', { class: 'list-sub' },
            'pkexec is not installed, so the package cache and system logs cannot be cleaned from here.'));
    }

    if (storage.home.length > 0) {
        pane.append(h('div', { class: 'section-head' }, 'Largest folders in your home'));
        const folders = h('div', { class: 'list' });
        for (const entry of storage.home) {
            folders.append(h('button', {
                class: 'list-row',
                title: entry.path,
                on: { click: () => post({ type: 'revealPath', path: entry.path }) },
            },
            h('span', { html: icon('folder', 18) }),
            h('span', { class: 'list-main' },
                h('div', { class: 'list-name' }, entry.name),
                h('div', { class: 'list-sub' }, entry.path),
            ),
            h('span', { class: 'storage-size' }, formatBytes(entry.bytes)),
            ));
        }
        pane.append(folders);
    }
}

function cleanupRow(category: CleanupCategory): HTMLElement {
    const box = h('input', {
        type: 'checkbox',
        checked: chosen.has(category.id),
        disabled: category.bytes === 0,
        on: {
            change: (event: Event) => {
                if ((event.target as HTMLInputElement).checked) {
                    chosen.add(category.id);
                } else {
                    chosen.delete(category.id);
                }
                render();
            },
        },
    });

    return h('label', { class: 'list-row' },
        box,
        h('span', { class: 'list-main' },
            h('div', { class: 'list-name' },
                category.title,
                category.privileged ? h('span', { class: 'update-badge' }, 'needs root') : null,
            ),
            h('div', { class: 'list-sub' }, category.description),
        ),
        h('span', { class: 'storage-size' }, category.bytes > 0 ? formatBytes(category.bytes) : '—'),
    );
}

// ------------------------------------------------------------------- about

function renderAbout(about: AboutInfo | undefined): void {
    pane.append(paneHead('About', 'What this machine is running.'));
    if (!about) {
        return;
    }

    const rows: [string, string | undefined][] = [
        ['Device name', about.hostname],
        ['Visual Studio Code', about.codeVersion],
        ['Desktop shell', `VsCodeOsCore ${about.shellVersion}`],
        ['Kernel', `${about.kernel} (${about.architecture})`],
        ['Processor', about.cpu],
        ['Memory', about.memoryBytes ? formatBytes(about.memoryBytes) : undefined],
        ['Uptime', formatUptime(about.uptimeSeconds)],
        ['Image', about.build],
    ];

    const group = h('div', { class: 'setting-group' });
    for (const [label, value] of rows) {
        if (value) {
            group.append(field(label, h('div', { class: 'setting-static' }, value)));
        }
    }
    pane.append(group);
}

function formatUptime(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) {
        return `${days} day${days === 1 ? '' : 's'}, ${hours} h ${minutes} min`;
    }
    return hours > 0 ? `${hours} h ${minutes} min` : `${minutes} min`;
}
