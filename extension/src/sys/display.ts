// Night light and energy saver.
//
// Both are done with what the images already have. Night light is an xrandr
// gamma ramp on every connected output - the same thing redshift does, without
// adding redshift. Energy saver prefers power-profiles-daemon when it is there
// and otherwise does the two things that genuinely save power on a kiosk:
// re-enables DPMS blanking (which vscodeos-kiosk deliberately turns off) and
// dims the backlight.

import { output, run, which } from './exec';
import * as backlight from './backlight';

/** Warm ramp, roughly 3500 K. Red is left alone; green and blue come down. */
const NIGHT_GAMMA = '1.0:0.82:0.65';
const DAY_GAMMA = '1.0:1.0:1.0';

let nightLightOn = false;
let energySaverOn = false;
let brightnessBeforeSaving: number | undefined;

export function supportsNightLight(): boolean {
    return which('xrandr') !== undefined && !!process.env.DISPLAY;
}

export function isNightLightOn(): boolean {
    return nightLightOn;
}

async function connectedOutputs(): Promise<string[]> {
    const text = await output('xrandr', ['--query'], 5000);
    if (!text) {
        return [];
    }
    return text
        .split('\n')
        .filter((line) => / connected/.test(line))
        .map((line) => line.split(' ')[0])
        .filter(Boolean);
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
