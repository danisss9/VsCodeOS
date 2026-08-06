// Screen brightness.
//
// Written straight to sysfs. udev/90-vscodeos-backlight.rules makes
// /sys/class/backlight/*/brightness group-writable by `video`, which the kiosk
// user is already in - so no helper binary and no polkit prompt. Desktops and
// most Pis have no backlight at all, and the caller hides the slider when
// `isAvailable()` comes back false rather than showing a dead control.

import { constants, promises as fs } from 'node:fs';

const BACKLIGHT = '/sys/class/backlight';

export interface BrightnessState {
    available: boolean;
    /** 1-100; 0 would switch the panel off entirely. */
    percent: number;
    writable: boolean;
}

async function firstDevice(): Promise<string | undefined> {
    try {
        const entries = await fs.readdir(BACKLIGHT);
        // Prefer a real panel controller over the ACPI fallback when both exist.
        const preferred = entries.find((e) => !e.startsWith('acpi_video')) ?? entries[0];
        return preferred ? `${BACKLIGHT}/${preferred}` : undefined;
    } catch {
        return undefined;
    }
}

export async function isAvailable(): Promise<boolean> {
    return (await firstDevice()) !== undefined;
}

export async function getState(): Promise<BrightnessState> {
    const device = await firstDevice();
    if (!device) {
        return { available: false, percent: 100, writable: false };
    }
    try {
        const [current, max] = await Promise.all([
            fs.readFile(`${device}/brightness`, 'utf8'),
            fs.readFile(`${device}/max_brightness`, 'utf8'),
        ]);
        const maximum = Number(max.trim()) || 1;
        let writable = true;
        try {
            await fs.access(`${device}/brightness`, constants.W_OK);
        } catch {
            writable = false;
        }
        return {
            available: true,
            percent: Math.max(1, Math.round((Number(current.trim()) / maximum) * 100)),
            writable,
        };
    } catch {
        return { available: false, percent: 100, writable: false };
    }
}

export async function setPercent(percent: number): Promise<boolean> {
    const device = await firstDevice();
    if (!device) {
        return false;
    }
    try {
        const max = Number((await fs.readFile(`${device}/max_brightness`, 'utf8')).trim()) || 1;
        const clamped = Math.max(1, Math.min(100, Math.round(percent)));
        // Never write 0: on most panels that is indistinguishable from a dead screen.
        const value = Math.max(1, Math.round((clamped / 100) * max));
        await fs.writeFile(`${device}/brightness`, String(value));
        return true;
    } catch {
        return false;
    }
}
