// The firewall, driven through one privileged helper.
//
// ufw needs root even to read its status - the rules are in /etc/ufw and the
// live ruleset is in the kernel - so there is no cheap unprivileged probe to
// poll with, the way the network tray polls nmcli. Everything goes through
// `pkexec /usr/local/bin/vscodeos-firewall`, which polkit answers without a
// prompt, and the app refreshes on open and after each change instead of on a
// timer.
//
// The helper is where the validation lives: it takes a fixed vocabulary and one
// checked argument. This module still refuses obvious nonsense before spawning
// anything, because a round trip through pkexec to be told "no" is a waste.

import { run, start, which } from './exec';
import { parseUfwStatus } from '../util/parse';
import type { FirewallStatus } from '../util/parse';
import { log } from '../log';

export type { FirewallStatus, FirewallRule, FirewallPolicy } from '../util/parse';

const HELPER = '/usr/local/bin/vscodeos-firewall';

/** A port, a range, either with a protocol, or an application profile name. */
const PORT = /^\d{1,5}(:\d{1,5})?(\/(tcp|udp))?$/;
const PROFILE = /^[A-Za-z][A-Za-z0-9 ._+-]{0,63}$/;

export function isAvailable(): boolean {
    return which('ufw') !== undefined;
}

export function canElevate(): boolean {
    return which('pkexec') !== undefined;
}

export function isValidSpec(spec: string): boolean {
    if (PORT.test(spec)) {
        return spec
            .split('/')[0]
            .split(':')
            .every((part) => {
                const port = Number(part);
                return port >= 1 && port <= 65535;
            });
    }
    return PROFILE.test(spec);
}

export interface FirewallResult {
    ok: boolean;
    message?: string;
}

async function helper(args: string[], timeout = 60000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    if (!canElevate()) {
        return { ok: false, stdout: '', stderr: 'pkexec is not installed.' };
    }
    const result = await run('pkexec', [HELPER, ...args], { timeout });
    return { ok: result.ok, stdout: result.stdout, stderr: result.stderr };
}

export async function getStatus(): Promise<FirewallStatus | undefined> {
    const result = await helper(['status'], 30000);
    if (!result.ok) {
        log.debug(`firewall status failed: ${result.stderr.trim()}`);
        return undefined;
    }
    return parseUfwStatus(result.stdout);
}

/**
 * Run a change and stream its output, the way the updater streams pacman's.
 * `onLog` sees the helper's own `==>` lines, so the app can show what happened
 * rather than only whether it worked.
 */
export function apply(args: string[], onLog: (chunk: string) => void): Promise<FirewallResult> {
    if (!canElevate()) {
        return Promise.resolve({ ok: false, message: 'pkexec is not installed.' });
    }
    return new Promise((resolve) => {
        onLog(`$ pkexec ${HELPER} ${args.join(' ')}\n`);
        const child = start('pkexec', [HELPER, ...args]);
        let stderr = '';
        child.stdout?.on('data', (chunk: Buffer) => onLog(String(chunk)));
        child.stderr?.on('data', (chunk: Buffer) => {
            stderr += String(chunk);
            onLog(String(chunk));
        });
        child.on('error', (error) => {
            onLog(`\n${String(error)}\n`);
            stderr += error.message;
        });
        child.on('close', (code) => {
            if (code === 0) {
                resolve({ ok: true });
                return;
            }
            log.error(`vscodeos-firewall ${args[0]} exited with ${String(code)}`);
            resolve({
                ok: false,
                message: firstError(stderr) || `vscodeos-firewall exited with status ${code ?? 'unknown'}.`,
            });
        });
    });
}

function firstError(text: string): string {
    const line = text.trim().split('\n').find((l) => l.startsWith('error: '));
    return line ? line.slice('error: '.length) : text.trim().split('\n')[0] ?? '';
}

/**
 * Whether anything is listening for incoming SSH.
 *
 * Used to warn before incoming traffic is denied: `openssh` is on both images,
 * and someone administering a Pi over the network can lock themselves out of it
 * with two clicks and no way back except a keyboard and a monitor.
 */
export async function sshIsListening(): Promise<boolean> {
    if (which('ss')) {
        const result = await run('ss', ['-Hltn', 'sport = :22'], { timeout: 5000 });
        return result.ok && result.stdout.trim() !== '';
    }
    if (which('systemctl')) {
        const result = await run('systemctl', ['is-active', 'sshd.service'], { timeout: 5000 });
        return result.stdout.trim() === 'active';
    }
    return false;
}
