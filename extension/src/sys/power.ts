// Shutdown, restart, sleep.
//
// systemctl + polkit, never sudo: the kiosk's tty1 session is an active seat
// session, so logind's own policy already answers `allow_active` for these -
// and after `vscodeos-install` tightens sudo, a sudo-based path would sit there
// waiting for a password nobody can see. See etc/polkit-1/rules.d/49-vscodeos.rules.

import { run, which } from './exec';

export type PowerAction = 'poweroff' | 'reboot' | 'suspend' | 'hibernate' | 'logout';

export interface PowerResult {
    ok: boolean;
    message?: string;
}

export function canSuspend(): boolean {
    return which('systemctl') !== undefined;
}

export async function perform(action: PowerAction): Promise<PowerResult> {
    if (action === 'logout') {
        return logout();
    }
    if (!which('systemctl')) {
        return { ok: false, message: 'systemctl is not available on this system.' };
    }
    // No `-i`: ignoring inhibitors needs auth_admin_keep, which would prompt.
    const result = await run('systemctl', [action], { timeout: 15000 });
    if (result.ok) {
        return { ok: true };
    }
    return { ok: false, message: firstLine(result.stderr) || `systemctl ${action} failed` };
}

/**
 * Ending the session rather than the machine. On the kiosk systemd logs straight
 * back in, so this reads as "restart the desktop" - which is what it is useful for.
 */
async function logout(): Promise<PowerResult> {
    if (!which('loginctl')) {
        return { ok: false, message: 'loginctl is not available on this system.' };
    }
    const session = process.env.XDG_SESSION_ID;
    const result = session
        ? await run('loginctl', ['terminate-session', session])
        : await run('loginctl', ['terminate-user', process.env.USER ?? String(process.getuid?.() ?? '')]);
    return result.ok ? { ok: true } : { ok: false, message: firstLine(result.stderr) || 'could not end the session' };
}

function firstLine(text: string): string {
    return text.trim().split('\n')[0] ?? '';
}
