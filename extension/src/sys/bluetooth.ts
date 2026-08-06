// Bluetooth, via bluetoothctl.
//
// The quick-settings tile hides itself when there is no adapter, which is the
// normal case on a desktop PC and on a Pi without the radio enabled - a dead
// toggle is worse than no toggle.

import { output, run, which } from './exec';

export interface BluetoothDevice {
    mac: string;
    name: string;
    connected: boolean;
}

export interface BluetoothState {
    available: boolean;
    powered: boolean;
    devices: BluetoothDevice[];
}

export function isAvailable(): boolean {
    return which('bluetoothctl') !== undefined;
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
        const connected = new Set<string>();
        const connectedText = await output('bluetoothctl', ['devices', 'Connected'], 5000);
        for (const line of (connectedText ?? '').split('\n')) {
            const match = /^Device\s+(\S+)\s+(.*)$/.exec(line.trim());
            if (match) {
                connected.add(match[1]);
            }
        }
        const pairedText = await output('bluetoothctl', ['devices', 'Paired'], 5000);
        for (const line of (pairedText ?? '').split('\n')) {
            const match = /^Device\s+(\S+)\s+(.*)$/.exec(line.trim());
            if (match) {
                devices.push({ mac: match[1], name: match[2] || match[1], connected: connected.has(match[1]) });
            }
        }
        devices.sort((a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name));
    }

    return { available: true, powered, devices };
}

export async function setPowered(on: boolean): Promise<void> {
    await run('bluetoothctl', ['power', on ? 'on' : 'off'], { timeout: 10000 });
}

export async function connect(mac: string): Promise<{ ok: boolean; message?: string }> {
    const result = await run('bluetoothctl', ['connect', mac], { timeout: 30000 });
    const ok = result.ok && /Connection successful/i.test(result.stdout);
    return ok ? { ok: true } : { ok: false, message: 'could not connect to the device' };
}

export async function disconnect(mac: string): Promise<void> {
    await run('bluetoothctl', ['disconnect', mac], { timeout: 15000 });
}
