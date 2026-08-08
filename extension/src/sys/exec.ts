// Every external command the shell runs goes through here.
//
// Two rules, both load-bearing:
//   * never `shell: true` - arguments come from network names, file names and
//     process names, and none of them are ours to trust;
//   * always a timeout - a wedged `nmcli` must not wedge the status bar with it.

import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { log } from '../log';

export interface RunResult {
    ok: boolean;
    code: number | null;
    stdout: string;
    stderr: string;
}

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * Run a command and collect its output. Never throws: a missing binary, a
 * non-zero exit and a timeout all come back as `ok: false`, because every
 * caller here is drawing a widget and would rather hide it than crash.
 */
export function run(
    command: string,
    args: string[] = [],
    options: { timeout?: number; input?: string } = {},
): Promise<RunResult> {
    return new Promise((resolve) => {
        const child = execFile(
            command,
            args,
            { timeout: options.timeout ?? DEFAULT_TIMEOUT_MS, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
            (error, stdout, stderr) => {
                const code = error && typeof (error as NodeJS.ErrnoException).code === 'number'
                    ? ((error as unknown as { code: number }).code)
                    : error ? null : 0;
                if (error) {
                    log.debug(`${command} ${args.join(' ')} -> ${error.message.trim()}`);
                }
                resolve({ ok: !error, code, stdout: stdout ?? '', stderr: stderr ?? '' });
            },
        );
        if (options.input !== undefined) {
            child.stdin?.end(options.input);
        }
    });
}

/** Run a command, returning its trimmed stdout, or undefined if it failed. */
export async function output(command: string, args: string[] = [], timeout?: number): Promise<string | undefined> {
    const result = await run(command, args, timeout === undefined ? {} : { timeout });
    return result.ok ? result.stdout.trim() : undefined;
}

/**
 * Start a long-lived process and hand back the handle (recorder,
 * playerctl --follow, pkexec of a helper).
 *
 * `cwd` exists for the handful of tools with no equivalent of tar's -C; it is
 * still a real directory handed to spawn, not a shell doing a `cd`, so the
 * no-shell rule at the top of this file holds.
 */
export function start(command: string, args: string[] = [], options: { cwd?: string } = {}): ChildProcess {
    return spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: options.cwd });
}

/**
 * Start a program and let go of it: a browser window, another desktop's app.
 *
 * Detached and unref'd, which is the difference that matters - a child in this
 * process group dies with the editor, and a launcher whose apps close when the
 * editor restarts would be a strange launcher. Its output goes nowhere, because
 * there is nobody to read it.
 *
 * The binary is resolved first, because `spawn` does not fail here for one that
 * is missing: ENOENT arrives later as an `error` event, which would be an
 * unhandled emitter error in the extension host, and the caller would already
 * have been told the launch worked. `error` is still listened for, since the
 * check and the exec are not atomic.
 */
export function launch(command: string, args: string[] = []): boolean {
    const resolved = which(command);
    if (!resolved) {
        log.error(`could not launch ${command}: not found`);
        return false;
    }
    try {
        const child = spawn(resolved, args, { detached: true, stdio: 'ignore' });
        child.on('error', (error) => log.error(`${command} exited immediately`, error));
        child.unref();
        return true;
    } catch (error) {
        log.error(`could not launch ${command}`, error);
        return false;
    }
}

const whichCache = new Map<string, string | undefined>();

/**
 * Resolve a binary against PATH. Cached: the answer only changes when a package
 * is installed, and every status bar tick would otherwise stat the same dirs.
 */
export function which(command: string): string | undefined {
    if (whichCache.has(command)) {
        return whichCache.get(command);
    }
    let found: string | undefined;
    if (command.includes('/')) {
        found = isExecutable(command) ? command : undefined;
    } else {
        for (const dir of (process.env.PATH ?? '/usr/bin:/bin').split(':')) {
            if (!dir) {
                continue;
            }
            const candidate = `${dir}/${command}`;
            if (isExecutable(candidate)) {
                found = candidate;
                break;
            }
        }
    }
    whichCache.set(command, found);
    return found;
}

/** True when every named binary is present - the usual "can this widget work?" test. */
export function hasAll(...commands: string[]): boolean {
    return commands.every((c) => which(c) !== undefined);
}

function isExecutable(path: string): boolean {
    try {
        accessSync(path, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}
