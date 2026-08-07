// Outputs, modes, night light and energy saver.
//
// Both are done with what the images already have. Night light is an xrandr
// gamma ramp on every connected output - the same thing redshift does, without
// adding redshift. Energy saver prefers power-profiles-daemon when it is there
// and otherwise does the two things that genuinely save power on a kiosk:
// re-enables DPMS blanking (which vscodeos-kiosk deliberately turns off) and
// dims the backlight.

import { output, run, which } from './exec';
import { parseXrandrOutputs } from '../util/parse';
import type { DisplayOutput, Rotation } from '../util/parse';
import * as backlight from './backlight';

export type { DisplayOutput, DisplayMode, Rotation } from '../util/parse';

/** Warm ramp, roughly 3500 K. Red is left alone; green and blue come down. */
const NIGHT_GAMMA = '1.0:0.82:0.65';
const DAY_GAMMA = '1.0:1.0:1.0';

let nightLightOn = false;
let energySaverOn = false;
let brightnessBeforeSaving: number | undefined;

export function supportsNightLight(): boolean {
    return isAvailable();
}

export function isNightLightOn(): boolean {
    return nightLightOn;
}

export function isAvailable(): boolean {
    return which('xrandr') !== undefined && !!process.env.DISPLAY;
}

/** Every output xrandr knows about, with its modes. */
export async function listOutputs(): Promise<DisplayOutput[]> {
    if (!isAvailable()) {
        return [];
    }
    return parseXrandrOutputs(await output('xrandr', ['--query'], 5000));
}

async function connectedOutputs(): Promise<string[]> {
    return (await listOutputs()).filter((o) => o.connected).map((o) => o.name);
}

export interface ModeChange {
    output: string;
    mode: string;
    rate?: number;
    rotation?: Rotation;
    primary?: boolean;
}

/**
 * Apply a mode. Every argument is checked against what xrandr just reported
 * rather than trusted: these strings arrive from a webview, and `run` refuses
 * `shell: true`, but a bogus mode name still costs a blanked screen.
 */
export async function applyMode(change: ModeChange): Promise<{ ok: boolean; message?: string }> {
    if (!isAvailable()) {
        return { ok: false, message: 'xrandr is not available.' };
    }
    const outputs = await listOutputs();
    const target = outputs.find((o) => o.name === change.output && o.connected);
    if (!target) {
        return { ok: false, message: `No connected output called ${change.output}.` };
    }
    const mode = target.modes.find((m) => m.size === change.mode);
    if (!mode) {
        return { ok: false, message: `${change.output} does not offer ${change.mode}.` };
    }

    const args = ['--output', target.name, '--mode', mode.size];
    if (change.rate !== undefined && mode.rates.includes(change.rate)) {
        args.push('--rate', String(change.rate));
    }
    if (change.rotation) {
        args.push('--rotate', change.rotation);
    }
    if (change.primary) {
        args.push('--primary');
    }

    const result = await run('xrandr', args, { timeout: 15000 });
    return result.ok
        ? { ok: true }
        : { ok: false, message: result.stderr.trim().split('\n')[0] || 'xrandr refused the mode.' };
}

/**
 * Put an output back exactly as it was.
 *
 * This is what makes a mode change safe to offer at all. The kiosk sets
 * DontVTSwitch, so there is no console to escape to: a mode the monitor cannot
 * display leaves the machine with nothing on screen and no way to undo it short
 * of a power cycle. The settings app applies a change, asks whether it worked,
 * and calls this when the answer does not arrive.
 */
export async function restoreOutput(previous: DisplayOutput): Promise<void> {
    if (!isAvailable() || !previous.currentMode) {
        return;
    }
    const args = ['--output', previous.name, '--mode', previous.currentMode, '--rotate', previous.rotation];
    if (previous.currentRate !== undefined) {
        args.push('--rate', String(previous.currentRate));
    }
    if (previous.primary) {
        args.push('--primary');
    }
    await run('xrandr', args, { timeout: 15000 });
}

export async function setNightLight(on: boolean): Promise<boolean> {
    if (!supportsNightLight()) {
        return false;
    }
    const outputs = await connectedOutputs();
    if (outputs.length === 0) {
        return false;
    }
    for (const name of outputs) {
        await run('xrandr', ['--output', name, '--gamma', on ? NIGHT_GAMMA : DAY_GAMMA], { timeout: 8000 });
    }
    nightLightOn = on;
    return true;
}

export function supportsEnergySaver(): boolean {
    return which('powerprofilesctl') !== undefined || which('xset') !== undefined;
}

export function isEnergySaverOn(): boolean {
    return energySaverOn;
}

export async function setEnergySaver(on: boolean): Promise<boolean> {
    let changed = false;

    if (which('powerprofilesctl')) {
        const result = await run('powerprofilesctl', ['set', on ? 'power-saver' : 'balanced'], { timeout: 8000 });
        changed ||= result.ok;
    }

    if (which('xset')) {
        // The kiosk session runs `xset s off -dpms` on purpose, so energy saver
        // is what puts blanking back: standby 5 min, suspend 10, off 15.
        const args = on ? ['+dpms', 'dpms', '300', '600', '900'] : ['s', 'off', '-dpms', 's', 'noblank'];
        const result = await run('xset', args, { timeout: 5000 });
        changed ||= result.ok;
    }

    if (await backlight.isAvailable()) {
        if (on) {
            brightnessBeforeSaving = (await backlight.getState()).percent;
            await backlight.setPercent(40);
        } else if (brightnessBeforeSaving !== undefined) {
            await backlight.setPercent(brightnessBeforeSaving);
            brightnessBeforeSaving = undefined;
        }
        changed = true;
    }

    energySaverOn = on;
    return changed;
}

/** Put the display state back the way the kiosk session set it up. */
export async function restoreDefaults(): Promise<void> {
    if (nightLightOn) {
        await setNightLight(false);
    }
    if (energySaverOn) {
        await setEnergySaver(false);
    }
}
