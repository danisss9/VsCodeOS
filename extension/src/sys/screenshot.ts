// Screen capture.
//
// scrot is the whole implementation: it is ~60 KiB, it is an X client so it
// needs no compositor portal, and it already does the three modes the tool
// offers. Nothing in a webview can capture the screen, so this has to be native.

import { promises as fs } from 'node:fs';
import { run, which } from './exec';

export type CaptureMode = 'screen' | 'window' | 'region';

export interface CaptureResult {
    ok: boolean;
    path?: string;
    message?: string;
}

export function isAvailable(): boolean {
    return which('scrot') !== undefined;
}

export async function capture(mode: CaptureMode, targetPath: string, delaySeconds = 0): Promise<CaptureResult> {
    if (!isAvailable()) {
        return { ok: false, message: 'scrot is not installed.' };
    }

    await fs.mkdir(dirnameOf(targetPath), { recursive: true });

    const args: string[] = ['--overwrite'];
    if (delaySeconds > 0) {
        args.push('--delay', String(Math.round(delaySeconds)));
    }
    if (mode === 'window') {
        // --focused needs a moment for our own flyout to go away first.
        args.push('--focused');
        if (delaySeconds === 0) {
            args.push('--delay', '1');
        }
    } else if (mode === 'region') {
        args.push('--select', '--freeze');
    }
    args.push('--file', targetPath);

    // A region capture waits for the user to drag a rectangle - no timeout.
    const result = await run('scrot', args, { timeout: mode === 'region' ? 120000 : 30000 });
    if (!result.ok) {
        const stderr = result.stderr.trim();
        // Cancelling a selection is a normal outcome, not an error worth shouting about.
        if (mode === 'region' && /giblib error|Cancelled|failed to grab/i.test(stderr)) {
            return { ok: false, message: 'Selection cancelled.' };
        }
        return { ok: false, message: stderr.split('\n')[0] || 'scrot failed' };
    }

    try {
        await fs.access(targetPath);
    } catch {
        return { ok: false, message: 'scrot reported success but wrote no file.' };
    }
    return { ok: true, path: targetPath };
}

function dirnameOf(path: string): string {
    const slash = path.lastIndexOf('/');
    return slash > 0 ? path.slice(0, slash) : '/';
}
