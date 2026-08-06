// Battery and AC state, read from sysfs.
//
// No upower: the kernel already exports everything the tray needs in
// /sys/class/power_supply, it is world-readable, and skipping the daemon keeps a
// package off two image manifests that are already tight against the size limit.

import { promises as fs } from 'node:fs';

export interface BatteryState {
    present: boolean;
    /** Charge, percent. */
    level: number;
    charging: boolean;
    /** "Charging" | "Discharging" | "Full" | "Not charging" | "Unknown" */
    status: string;
    onAc: boolean;
    /** Seconds until full or empty, when the kernel gives us enough to work it out. */
    secondsRemaining?: number;
}

const SUPPLY = '/sys/class/power_supply';

async function readNumber(path: string): Promise<number | undefined> {
    try {
        const value = Number((await fs.readFile(path, 'utf8')).trim());
        return Number.isFinite(value) ? value : undefined;
    } catch {
        return undefined;
    }
}

async function readText(path: string): Promise<string | undefined> {
    try {
        return (await fs.readFile(path, 'utf8')).trim();
    } catch {
        return undefined;
    }
}

export async function getState(): Promise<BatteryState> {
    let entries: string[];
    try {
        entries = await fs.readdir(SUPPLY);
    } catch {
        return { present: false, level: 100, charging: false, status: 'Unknown', onAc: true };
    }

    let battery: BatteryState | undefined;
    let onAc: boolean | undefined;

    for (const entry of entries) {
        const base = `${SUPPLY}/${entry}`;
        const type = await readText(`${base}/type`);

        if (type === 'Mains' || type === 'USB') {
            const online = await readNumber(`${base}/online`);
            if (online !== undefined) {
                onAc = onAc === true || online === 1;
            }
            continue;
        }
        if (type !== 'Battery' || battery) {
            continue;
        }

        const status = (await readText(`${base}/status`)) ?? 'Unknown';
        let level = await readNumber(`${base}/capacity`);
        if (level === undefined) {
            // Some batteries only report energy/charge; derive the percentage.
            const now = (await readNumber(`${base}/energy_now`)) ?? (await readNumber(`${base}/charge_now`));
            const full = (await readNumber(`${base}/energy_full`)) ?? (await readNumber(`${base}/charge_full`));
            if (now !== undefined && full) {
                level = Math.round((now / full) * 100);
            }
        }
        if (level === undefined) {
            continue;
        }

        battery = {
            present: true,
            level: Math.max(0, Math.min(100, level)),
            charging: status === 'Charging',
            status,
            onAc: false,
            secondsRemaining: await estimateRemaining(base, status),
        };
    }

    if (!battery) {
        return { present: false, level: 100, charging: false, status: 'Unknown', onAc: onAc ?? true };
    }
    battery.onAc = onAc ?? battery.charging;
    return battery;
}

async function estimateRemaining(base: string, status: string): Promise<number | undefined> {
    const rate = (await readNumber(`${base}/power_now`)) ?? (await readNumber(`${base}/current_now`));
    if (!rate) {
        return undefined;
    }
    const now = (await readNumber(`${base}/energy_now`)) ?? (await readNumber(`${base}/charge_now`));
    const full = (await readNumber(`${base}/energy_full`)) ?? (await readNumber(`${base}/charge_full`));
    if (now === undefined) {
        return undefined;
    }
    if (status === 'Charging' && full !== undefined) {
        return Math.round(((full - now) / rate) * 3600);
    }
    if (status === 'Discharging') {
        return Math.round((now / rate) * 3600);
    }
    return undefined;
}

/** Codicon for the current charge, so the tray icon tracks the level. */
export function iconFor(state: BatteryState): string {
    if (!state.present) {
        return 'plug';
    }
    if (state.charging) {
        return 'zap';
    }
    return state.level <= 15 ? 'warning' : 'circle-large-outline';
}

export function describeRemaining(state: BatteryState): string | undefined {
    if (state.secondsRemaining === undefined || state.secondsRemaining <= 0) {
        return undefined;
    }
    const hours = Math.floor(state.secondsRemaining / 3600);
    const minutes = Math.round((state.secondsRemaining % 3600) / 60);
    const time = hours > 0 ? `${hours} hr ${minutes} min` : `${minutes} min`;
    return state.charging ? `${time} until full` : `${time} remaining`;
}
