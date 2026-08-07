// Bluetooth, via bluetoothctl.
//
// The tray button hides itself when there is no adapter, which is the normal
// case on a desktop PC and on a Pi without the radio enabled - a dead toggle is
// worse than no toggle.
//
// bluetoothctl is an interactive shell, but every subcommand used here also
// works as a one-shot argv, which is what keeps this inside exec.ts's rules (no
// `shell: true`, always a timeout). Scanning is the one exception that needs
// care: `scan on` never returns on its own, so it is always run with
// --timeout, and the caller's timeout is set above that.

import { output, run, which } from './exec';
import { parseBluetoothDevices } from '../util/parse';

export interface BluetoothDevice {
    mac: string;
    name: string;
    connected: boolean;
    paired: boolean;
}

export interface BluetoothState {
    available: boolean;
    powered: boolean;
    /** Paired devices first, then anything a scan has turned up. */
    devices: BluetoothDevice[];
}

const SCAN_SECONDS = 12;

export function isAvailable(): boolean {
    return which('bluetoothctl') !== undefined;
}

function byMac(text: string | undefined): Map<string, string> {
    return new Map(parseBluetoothDevices(text).map((device) => [device.mac, device.name]));
}

export async function getState(): Promise<BluetoothState> {
    if (!isAvailable()) {
        return { available: false, powered: false, devices: [] };
    }
    const show = await output('bluetoothctl', ['show'], 5000);
    if (!show || show.includes('No default controller')) {
        return { available: false, powered: false, devices: [] };
    }

    const powered = /Powered:\s*yes/i.test(show);
    const devices: BluetoothDevice[] = [];
    if (powered) {
        const [connectedText, pairedText, allText] = await Promise.all([
            output('bluetoothctl', ['devices', 'Connected'], 5000),
            output('bluetoothctl', ['devices', 'Paired'], 5000),
            output('bluetoothctl', ['devices'], 5000),
        ]);
        const connected = byMac(connectedText);
        const paired = byMac(pairedText);
        // `devices` with no filter is everything the daemon knows, which after a
        // scan includes things that have never been paired - the ones a user
        // actually wants to see in a "nearby" list.
        const all = byMac(allText);
        for (const [mac, name] of [...paired, ...all]) {
            if (devices.some((device) => device.mac === mac)) {
                continue;
            }
            devices.push({ mac, name, connected: connected.has(mac), paired: paired.has(mac) });
        }
        devices.sort((a, b) =>
            Number(b.connected) - Number(a.connected)
            || Number(b.paired) - Number(a.paired)
            || a.name.localeCompare(b.name));
    }

    return { available: true, powered, devices };
}

export interface BluetoothSummary {
    available: boolean;
    powered: boolean;
    connected: string[];
}

/**
 * Just enough for the tray button, in two subprocesses instead of four.
 * getState() is for the card, which is only open while somebody is looking at
 * it; this one runs on the status bar's five-second tick forever.
 */
export async function getSummary(): Promise<BluetoothSummary> {
    if (!isAvailable()) {
        return { available: false, powered: false, connected: [] };
    }
    const show = await output('bluetoothctl', ['show'], 5000);
    if (!show || show.includes('No default controller')) {
        return { available: false, powered: false, connected: [] };
    }
    const powered = /Powered:\s*yes/i.test(show);
    if (!powered) {
        return { available: true, powered: false, connected: [] };
    }
    const connected = await output('bluetoothctl', ['devices', 'Connected'], 5000);
    return {
        available: true,
        powered: true,
        connected: parseBluetoothDevices(connected).map((device) => device.name),
    };
}

export async function setPowered(on: boolean): Promise<void> {
    await run('bluetoothctl', ['power', on ? 'on' : 'off'], { timeout: 10000 });
}

/** Discover nearby devices. Resolves once the scan window has closed. */
export async function scan(): Promise<void> {
    await run('bluetoothctl', ['--timeout', String(SCAN_SECONDS), 'scan', 'on'], {
        timeout: (SCAN_SECONDS + 8) * 1000,
    });
}

export async function connect(mac: string): Promise<{ ok: boolean; message?: string }> {
    const result = await run('bluetoothctl', ['connect', mac], { timeout: 30000 });
    const ok = result.ok && /Connection successful/i.test(result.stdout);
    return ok ? { ok: true } : { ok: false, message: 'could not connect to the device' };
}

export async function disconnect(mac: string): Promise<void> {
    await run('bluetoothctl', ['disconnect', mac], { timeout: 15000 });
}

/**
 * Pair, trust, then connect. Trusting is what stops the daemon asking again on
 * every reconnect - there is no agent in this session to answer it, so an
 * untrusted device would simply fail to come back after a reboot.
 */
export async function pair(mac: string): Promise<{ ok: boolean; message?: string }> {
    const paired = await run('bluetoothctl', ['pair', mac], { timeout: 45000 });
    if (!paired.ok && !/Pairing successful|AlreadyExists/i.test(paired.stdout + paired.stderr)) {
        const reason = /Failed to pair:\s*(.*)/i.exec(paired.stdout + paired.stderr)?.[1];
        return { ok: false, message: reason?.trim() || 'pairing failed' };
    }
    await run('bluetoothctl', ['trust', mac], { timeout: 10000 });
    return connect(mac);
}

export async function forget(mac: string): Promise<void> {
    await run('bluetoothctl', ['remove', mac], { timeout: 15000 });
}
