// Volume, mute and device selection, for the speakers and the microphone alike.
//
// wpctl (wireplumber) is the native control surface for the PipeWire stack both
// images ship. pactl is kept as a fallback so the extension is also usable on a
// plain PulseAudio desktop when someone runs it outside VS Code OS.

import { output, run, which } from './exec';

export interface AudioDevice {
    id: string;
    name: string;
    isDefault: boolean;
}

export interface AudioState {
    available: boolean;
    volume: number; // 0-100
    muted: boolean;
    sinks: AudioDevice[];
    sources: AudioDevice[];
    /** The default microphone's gain and mute, absent when there is no input. */
    input?: VolumeLevel;
}

const SINK = '@DEFAULT_AUDIO_SINK@';
const SOURCE = '@DEFAULT_AUDIO_SOURCE@';

function backend(): 'wpctl' | 'pactl' | undefined {
    if (which('wpctl')) {
        return 'wpctl';
    }
    return which('pactl') ? 'pactl' : undefined;
}

export function isAvailable(): boolean {
    return backend() !== undefined;
}

export async function getState(): Promise<AudioState> {
    const kind = backend();
    if (!kind) {
        return { available: false, volume: 0, muted: true, sinks: [], sources: [] };
    }
    if (kind === 'wpctl') {
        const text = await output('wpctl', ['get-volume', SINK]);
        // "Volume: 0.65" or "Volume: 0.65 [MUTED]"
        const match = text ? /Volume:\s*([\d.]+)/.exec(text) : undefined;
        const [{ sinks, sources }, input] = await Promise.all([readWpctlDevices(), getInputLevel()]);
        return {
            available: true,
            volume: match ? Math.round(Number(match[1]) * 100) : 0,
            muted: text !== undefined && text.includes('[MUTED]'),
            sinks,
            sources,
            input: input.available ? input : undefined,
        };
    }

    const volumeText = await output('pactl', ['get-sink-volume', '@DEFAULT_SINK@']);
    const muteText = await output('pactl', ['get-sink-mute', '@DEFAULT_SINK@']);
    const percent = volumeText ? /(\d+)%/.exec(volumeText) : undefined;
    const input = await getInputLevel();
    return {
        available: true,
        volume: percent ? Number(percent[1]) : 0,
        muted: muteText?.includes('yes') ?? false,
        sinks: await readPactlDevices('sinks'),
        sources: await readPactlDevices('sources'),
        input: input.available ? input : undefined,
    };
}

export interface VolumeLevel {
    available: boolean;
    volume: number;
    muted: boolean;
}

/**
 * Volume and mute only - one subprocess instead of the three `getState` needs to
 * enumerate devices. This is what the tray polls.
 */
export async function getVolume(): Promise<VolumeLevel> {
    if (which('wpctl')) {
        const text = await output('wpctl', ['get-volume', SINK], 4000);
        const match = text ? /Volume:\s*([\d.]+)/.exec(text) : undefined;
        return {
            available: text !== undefined,
            volume: match ? Math.round(Number(match[1]) * 100) : 0,
            muted: text !== undefined && text.includes('[MUTED]'),
        };
    }
    if (which('pactl')) {
        const volumeText = await output('pactl', ['get-sink-volume', '@DEFAULT_SINK@'], 4000);
        const muteText = await output('pactl', ['get-sink-mute', '@DEFAULT_SINK@'], 4000);
        const percent = volumeText ? /(\d+)%/.exec(volumeText) : undefined;
        return {
            available: volumeText !== undefined,
            volume: percent ? Number(percent[1]) : 0,
            muted: muteText?.includes('yes') ?? false,
        };
    }
    return { available: false, volume: 0, muted: true };
}

export async function setVolume(percent: number): Promise<void> {
    const clamped = Math.max(0, Math.min(150, Math.round(percent)));
    if (which('wpctl')) {
        await run('wpctl', ['set-volume', '-l', '1.5', SINK, `${clamped / 100}`]);
    } else if (which('pactl')) {
        await run('pactl', ['set-sink-volume', '@DEFAULT_SINK@', `${clamped}%`]);
    }
}

export async function step(delta: number): Promise<void> {
    const sign = delta >= 0 ? '+' : '-';
    const magnitude = Math.abs(Math.round(delta));
    if (which('wpctl')) {
        await run('wpctl', ['set-volume', '-l', '1.5', SINK, `${magnitude}%${sign}`]);
    } else if (which('pactl')) {
        await run('pactl', ['set-sink-volume', '@DEFAULT_SINK@', `${sign}${magnitude}%`]);
    }
}

export async function toggleMute(): Promise<void> {
    if (which('wpctl')) {
        await run('wpctl', ['set-mute', SINK, 'toggle']);
    } else if (which('pactl')) {
        await run('pactl', ['set-sink-mute', '@DEFAULT_SINK@', 'toggle']);
    }
}

export async function setDefaultSink(id: string): Promise<void> {
    if (which('wpctl')) {
        await run('wpctl', ['set-default', id]);
    } else if (which('pactl')) {
        await run('pactl', ['set-default-sink', id]);
    }
}

/**
 * Pick the microphone.
 *
 * `wpctl set-default` takes any node id, so it is the same call as for a sink -
 * which is why the ids from readWpctlDevices must not be tidied into something
 * prettier. pactl needs the other verb, and there the id is a device name
 * rather than an index; see readPactlDevices.
 *
 * This also decides which microphone the voice recorder uses, since that
 * records from @DEFAULT_SOURCE@.
 */
export async function setDefaultSource(id: string): Promise<void> {
    if (which('wpctl')) {
        await run('wpctl', ['set-default', id]);
    } else if (which('pactl')) {
        await run('pactl', ['set-default-source', id]);
    }
}

/** Microphone gain and mute: the input-side mirror of getVolume. */
export async function getInputLevel(): Promise<VolumeLevel> {
    if (which('wpctl')) {
        const text = await output('wpctl', ['get-volume', SOURCE], 4000);
        const match = text ? /Volume:\s*([\d.]+)/.exec(text) : undefined;
        return {
            available: text !== undefined,
            volume: match ? Math.round(Number(match[1]) * 100) : 0,
            muted: text !== undefined && text.includes('[MUTED]'),
        };
    }
    if (which('pactl')) {
        const volumeText = await output('pactl', ['get-source-volume', '@DEFAULT_SOURCE@'], 4000);
        const muteText = await output('pactl', ['get-source-mute', '@DEFAULT_SOURCE@'], 4000);
        const percent = volumeText ? /(\d+)%/.exec(volumeText) : undefined;
        return {
            available: volumeText !== undefined,
            volume: percent ? Number(percent[1]) : 0,
            muted: muteText?.includes('yes') ?? false,
        };
    }
    return { available: false, volume: 0, muted: true };
}

export async function setInputVolume(percent: number): Promise<void> {
    // Capped at 100 rather than the sink's 150: pushing a microphone past its
    // hardware level raises the noise floor along with the voice.
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    if (which('wpctl')) {
        await run('wpctl', ['set-volume', SOURCE, `${clamped / 100}`]);
    } else if (which('pactl')) {
        await run('pactl', ['set-source-volume', '@DEFAULT_SOURCE@', `${clamped}%`]);
    }
}

export async function toggleInputMute(): Promise<void> {
    if (which('wpctl')) {
        await run('wpctl', ['set-mute', SOURCE, 'toggle']);
    } else if (which('pactl')) {
        await run('pactl', ['set-source-mute', '@DEFAULT_SOURCE@', 'toggle']);
    }
}

/**
 * `wpctl status` prints a tree; the sections we want are "Sinks:" and "Sources:"
 * under Audio, whose rows look like `│  *   47. Built-in Audio [vol: 0.65]`.
 */
async function readWpctlDevices(): Promise<{ sinks: AudioDevice[]; sources: AudioDevice[] }> {
    const text = await output('wpctl', ['status']);
    if (!text) {
        return { sinks: [], sources: [] };
    }
    return { sinks: parseWpctlSection(text, 'Sinks'), sources: parseWpctlSection(text, 'Sources') };
}

function parseWpctlSection(text: string, section: string): AudioDevice[] {
    const lines = text.split('\n');
    const start = lines.findIndex((l) => l.includes(`${section}:`));
    if (start < 0) {
        return [];
    }
    const devices: AudioDevice[] = [];
    for (const line of lines.slice(start + 1)) {
        // Strip the box-drawing gutter before deciding anything about the row.
        const body = line.replace(/^[\s│├└─|+\\`-]*/u, '');
        if (body === '' || /^[A-Z][\w ]*:$/.test(body)) {
            break;
        }
        const match = /^(\*?)\s*(\d+)\.\s+(.*?)\s*(?:\[vol:.*\])?$/.exec(body);
        if (match) {
            devices.push({ id: match[2], name: match[3].trim(), isDefault: match[1] === '*' });
        }
    }
    return devices;
}

async function readPactlDevices(kind: 'sinks' | 'sources'): Promise<AudioDevice[]> {
    const text = await output('pactl', ['list', 'short', kind]);
    const defaultName = await output('pactl', [kind === 'sinks' ? 'get-default-sink' : 'get-default-source']);
    if (!text) {
        return [];
    }
    return text.split('\n').filter(Boolean).map((line) => {
        const columns = line.split('\t');
        return { id: columns[1] ?? columns[0], name: columns[1] ?? 'Audio device', isDefault: columns[1] === defaultName };
    });
}

/** Codicon matching the current level, so the status bar reads like a volume icon. */
export function iconFor(state: AudioState | VolumeLevel): string {
    if (state.muted || state.volume === 0) {
        return 'mute';
    }
    return 'unmute';
}
