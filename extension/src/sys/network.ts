// NetworkManager, driven through nmcli's terse output.
//
// `-t` gives colon-separated records with literal colons backslash-escaped, which
// is the only nmcli format that parses reliably - the pretty tables reflow with
// terminal width and localise their headers.

import { output, run, which } from './exec';

export interface AccessPoint {
    ssid: string;
    signal: number;
    security: string;
    inUse: boolean;
    known: boolean;
}

export interface Connection {
    name: string;
    type: string;
    device: string;
}

export interface NetworkState {
    available: boolean;
    connectivity: string;
    wifiEnabled: boolean;
    wifiHardware: boolean;
    active: Connection[];
    accessPoints: AccessPoint[];
    known: string[];
}

export function isAvailable(): boolean {
    return which('nmcli') !== undefined;
}

/** Split one terse nmcli record, honouring its `\:` and `\\` escapes. */
function splitTerse(line: string): string[] {
    const fields: string[] = [];
    let current = '';
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '\\' && i + 1 < line.length) {
            current += line[++i];
        } else if (char === ':') {
            fields.push(current);
            current = '';
        } else {
            current += char;
        }
    }
    fields.push(current);
    return fields;
}

async function terse(fields: string, args: string[]): Promise<string[][]> {
    const text = await output('nmcli', ['-t', '-f', fields, ...args]);
    if (!text) {
        return [];
    }
    return text.split('\n').filter(Boolean).map(splitTerse);
}

export async function getState(scan = false): Promise<NetworkState> {
    if (!isAvailable()) {
        return {
            available: false,
            connectivity: 'unknown',
            wifiEnabled: false,
            wifiHardware: false,
            active: [],
            accessPoints: [],
            known: [],
        };
    }

    const [general, radio, activeRows, knownRows] = await Promise.all([
        terse('CONNECTIVITY', ['general', 'status']),
        output('nmcli', ['-t', 'radio', 'wifi']),
        terse('NAME,TYPE,DEVICE', ['connection', 'show', '--active']),
        terse('NAME,TYPE', ['connection', 'show']),
    ]);

    const wifiEnabled = radio?.trim() === 'enabled';
    const known = knownRows.filter((r) => r[1]?.includes('wireless')).map((r) => r[0]);

    let accessPoints: AccessPoint[] = [];
    let wifiHardware = false;
    const devices = await terse('DEVICE,TYPE,STATE', ['device', 'status']);
    wifiHardware = devices.some((d) => d[1] === 'wifi');

    if (wifiHardware && wifiEnabled) {
        // --rescan no by default: a rescan takes seconds and drops the current
        // list while it runs, which makes the flyout flicker on every open.
        const rows = await terse('IN-USE,SSID,SIGNAL,SECURITY', [
            'device', 'wifi', 'list', '--rescan', scan ? 'yes' : 'no',
        ]);
        const bySsid = new Map<string, AccessPoint>();
        for (const row of rows) {
            const ssid = row[1] ?? '';
            if (!ssid) {
                continue; // hidden network - nothing to show and nothing to click
            }
            const point: AccessPoint = {
                ssid,
                signal: Number(row[2]) || 0,
                security: row[3] || '',
                inUse: row[0] === '*',
                known: known.includes(ssid),
            };
            // Same SSID on two bands shows once, at its best signal.
            const existing = bySsid.get(ssid);
            if (!existing || point.signal > existing.signal) {
                bySsid.set(ssid, point);
            }
        }
        accessPoints = [...bySsid.values()].sort((a, b) => Number(b.inUse) - Number(a.inUse) || b.signal - a.signal);
    }

    return {
        available: true,
        connectivity: general[0]?.[0] ?? 'unknown',
        wifiEnabled,
        wifiHardware,
        active: activeRows.map((r) => ({ name: r[0], type: r[1], device: r[2] })),
        accessPoints,
        known,
    };
}

export interface NetworkSummary {
    available: boolean;
    connectivity: string;
    active: Connection[];
}

/**
 * The two cheap calls, for the tray's five-second tick. `getState` spawns five
 * nmcli processes because it also enumerates access points; doing that on a
 * timer would be rude on a Pi Zero.
 */
export async function getSummary(): Promise<NetworkSummary> {
    if (!isAvailable()) {
        return { available: false, connectivity: 'unknown', active: [] };
    }
    const [general, activeRows] = await Promise.all([
        terse('CONNECTIVITY', ['general', 'status']),
        terse('NAME,TYPE,DEVICE', ['connection', 'show', '--active']),
    ]);
    return {
        available: true,
        connectivity: general[0]?.[0] ?? 'unknown',
        active: activeRows.map((r) => ({ name: r[0], type: r[1], device: r[2] })),
    };
}

export async function setWifiEnabled(enabled: boolean): Promise<void> {
    await run('nmcli', ['radio', 'wifi', enabled ? 'on' : 'off'], { timeout: 15000 });
}

export async function connect(ssid: string, password?: string): Promise<{ ok: boolean; message?: string }> {
    const args = ['device', 'wifi', 'connect', ssid];
    if (password) {
        args.push('password', password);
    }
    const result = await run('nmcli', args, { timeout: 45000 });
    return result.ok ? { ok: true } : { ok: false, message: cleanError(result.stderr) };
}

export async function activate(name: string): Promise<{ ok: boolean; message?: string }> {
    const result = await run('nmcli', ['connection', 'up', 'id', name], { timeout: 45000 });
    return result.ok ? { ok: true } : { ok: false, message: cleanError(result.stderr) };
}

export async function deactivate(name: string): Promise<{ ok: boolean; message?: string }> {
    const result = await run('nmcli', ['connection', 'down', 'id', name], { timeout: 30000 });
    return result.ok ? { ok: true } : { ok: false, message: cleanError(result.stderr) };
}

export async function forget(name: string): Promise<void> {
    await run('nmcli', ['connection', 'delete', 'id', name], { timeout: 15000 });
}

/** Airplane mode: everything radio, not just Wi-Fi. */
export async function setAirplaneMode(on: boolean): Promise<void> {
    if (which('rfkill')) {
        await run('rfkill', [on ? 'block' : 'unblock', 'all'], { timeout: 10000 });
        return;
    }
    await run('nmcli', ['radio', 'all', on ? 'off' : 'on'], { timeout: 10000 });
}

export async function isAirplaneMode(): Promise<boolean> {
    const text = await output('nmcli', ['-t', 'radio', 'all']);
    // "enabled:enabled:enabled:enabled" - wifi, wifi-hw, wwan, wwan-hw
    return text !== undefined && text.length > 0 && !text.split(':').some((v) => v === 'enabled');
}

/** Which codicon the status bar should show for the current state. */
export function iconFor(state: NetworkState | NetworkSummary): string {
    if (!state.available || state.active.length === 0) {
        return 'circle-slash';
    }
    if (state.active.some((c) => c.type.includes('ethernet'))) {
        return 'plug';
    }
    if (state.active.some((c) => c.type.includes('wireless'))) {
        return 'radio-tower';
    }
    return 'globe';
}

function cleanError(stderr: string): string {
    return stderr.trim().split('\n')[0]?.replace(/^Error:\s*/, '') || 'the connection failed';
}
