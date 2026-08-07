// Keyboard layout and key repeat.
//
// Two halves that are easy to confuse. `setxkbmap` changes the layout of the
// running X session and forgets it the moment the session ends; `localectl
// set-x11-keymap` writes /etc/X11/xorg.conf.d/00-keyboard.conf, which is what
// the next session reads. A settings pane has to do both, or the change either
// does not take effect now or does not survive a reboot.
//
// Persisting is privileged, but not through a helper script: localectl talks to
// systemd-localed over D-Bus, and polkit answers
// org.freedesktop.locale1.set-keyboard for this session
// (rootfs-common/etc/polkit-1/rules.d/49-vscodeos.rules). That keeps a
// password-free path to root down to one named systemd action rather than
// another program of ours.

import { output, run, which } from './exec';

export interface KeyboardLayout {
    /** The xkb code: "us", "gb", "de". */
    code: string;
    /** Optional variant: "intl", "dvorak", "colemak". */
    variant?: string;
}

export interface KeyboardState {
    /** False when neither setxkbmap nor localectl is installed. */
    available: boolean;
    /** True when the layout can be made to stick across reboots. */
    canPersist: boolean;
    current?: KeyboardLayout;
    /** Every layout code the X keyboard data offers, sorted. */
    layouts: string[];
    repeat: RepeatRate;
}

export interface RepeatRate {
    /** Milliseconds held before a key starts repeating. */
    delay: number;
    /** Repeats per second once it starts. */
    rate: number;
}

export const DEFAULT_REPEAT: RepeatRate = { delay: 500, rate: 25 };

export function isAvailable(): boolean {
    return which('setxkbmap') !== undefined || which('localectl') !== undefined;
}

export function canPersist(): boolean {
    return which('localectl') !== undefined;
}

/**
 * `setxkbmap -query` is the honest answer for the running session:
 *
 *     rules:      evdev
 *     model:      pc105
 *     layout:     gb
 *     variant:    intl
 */
async function currentLayout(): Promise<KeyboardLayout | undefined> {
    const text = which('setxkbmap') ? await output('setxkbmap', ['-query'], 4000) : undefined;
    if (text) {
        const layout = /^layout:\s*(\S+)/m.exec(text);
        const variant = /^variant:\s*(\S+)/m.exec(text);
        if (layout) {
            // A comma-separated list means several layouts are loaded; the first
            // is the active one and the rest are switched to with a hotkey we do
            // not configure, so only the first is shown.
            return { code: layout[1].split(',')[0], variant: variant?.[1].split(',')[0] };
        }
    }

    // No X, or no setxkbmap: fall back to what the next session will use.
    const status = await output('localectl', ['status'], 4000);
    const layout = status ? /X11 Layout:\s*(\S+)/.exec(status) : undefined;
    const variant = status ? /X11 Variant:\s*(\S+)/.exec(status) : undefined;
    return layout ? { code: layout[1].split(',')[0], variant: variant?.[1].split(',')[0] } : undefined;
}

export async function listLayouts(): Promise<string[]> {
    const text = await output('localectl', ['list-x11-keymap-layouts'], 8000);
    return (text ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
}

export async function listVariants(layout: string): Promise<string[]> {
    if (!/^[a-z0-9_-]{1,32}$/i.test(layout)) {
        return [];
    }
    const text = await output('localectl', ['list-x11-keymap-variants', layout], 8000);
    return (text ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
}

export async function getState(repeat: RepeatRate): Promise<KeyboardState> {
    if (!isAvailable()) {
        return { available: false, canPersist: false, layouts: [], repeat };
    }
    const [current, layouts] = await Promise.all([currentLayout(), listLayouts()]);
    return { available: true, canPersist: canPersist(), current, layouts, repeat };
}

/** xkb codes are short and alphanumeric; anything else never reaches a command. */
function validLayout(layout: KeyboardLayout): boolean {
    return /^[a-z0-9_-]{1,32}$/i.test(layout.code)
        && (!layout.variant || /^[a-z0-9_-]{1,32}$/i.test(layout.variant));
}

export interface KeyboardResult {
    ok: boolean;
    message?: string;
    /** True when the change will survive a reboot as well as applying now. */
    persisted?: boolean;
}

export async function setLayout(layout: KeyboardLayout): Promise<KeyboardResult> {
    if (!validLayout(layout)) {
        return { ok: false, message: 'That is not a valid keyboard layout name.' };
    }

    let applied = false;
    if (which('setxkbmap') && process.env.DISPLAY) {
        const args = ['-layout', layout.code, ...(layout.variant ? ['-variant', layout.variant] : [])];
        const result = await run('setxkbmap', args, { timeout: 8000 });
        if (!result.ok) {
            return { ok: false, message: result.stderr.trim().split('\n')[0] || 'setxkbmap refused the layout.' };
        }
        applied = true;
    }

    let persisted = false;
    if (canPersist()) {
        // Model is left as the empty string so localed keeps whatever the
        // installer wrote; only the layout and variant are ours to set.
        const result = await run(
            'localectl',
            ['set-x11-keymap', layout.code, '', layout.variant ?? ''],
            { timeout: 15000 },
        );
        persisted = result.ok;
        if (!result.ok && !applied) {
            return {
                ok: false,
                message: result.stderr.trim().split('\n')[0] || 'localectl could not set the keymap.',
            };
        }
    }

    return { ok: applied || persisted, persisted };
}

/**
 * `xset r rate <delay> <rate>`. Session-only - there is no system-wide place
 * for it - so the settings app stores the numbers and reapplies them on
 * activation.
 */
export async function setRepeat(repeat: RepeatRate): Promise<boolean> {
    if (!which('xset') || !process.env.DISPLAY) {
        return false;
    }
    const delay = Math.max(100, Math.min(2000, Math.round(repeat.delay)));
    const rate = Math.max(1, Math.min(110, Math.round(repeat.rate)));
    const result = await run('xset', ['r', 'rate', String(delay), String(rate)], { timeout: 5000 });
    return result.ok;
}
