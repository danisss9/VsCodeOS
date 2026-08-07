// Reading, extracting and building archives.
//
// bsdtar does all of it - zip, tar, every compression, and 7z for reading -
// through one interface, and it needs no new package: libarchive is a hard
// dependency of pacman, so it is on both images by construction. The 7zip
// package is x86-only, and relying on it would have left the Pi without.
//
// unzip and tar are kept as a fallback, the way audio.ts keeps pactl behind
// wpctl, so the extension still works on a machine that has neither libarchive
// nor VS Code OS.
//
// Everything here treats archive contents as hostile. Member names come from a
// file someone downloaded, and "../../etc/passwd" is an old and real attack, so
// extraction never uses -P and listings are filtered before they are shown.

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run, start, which } from './exec';
import { archiveKind, entriesInDirectory, parseArchiveListing, parseUnzipListing } from '../util/archive';
import type { ArchiveEntry } from '../util/archive';
import { log } from '../log';

export type { ArchiveEntry } from '../util/archive';

export function isAvailable(): boolean {
    return which('bsdtar') !== undefined || which('unzip') !== undefined || which('tar') !== undefined;
}

function tool(file: string): 'bsdtar' | 'unzip' | 'tar' | undefined {
    if (which('bsdtar')) {
        return 'bsdtar';
    }
    // Without bsdtar the two families need different tools, and neither can do
    // the other's job: GNU tar cannot read a zip, and unzip cannot read a tar.
    const kind = archiveKind(file);
    if (kind === 'zip') {
        return which('unzip') ? 'unzip' : undefined;
    }
    return which('tar') ? 'tar' : undefined;
}

export async function list(file: string): Promise<ArchiveEntry[]> {
    const chosen = tool(file);
    if (!chosen) {
        return [];
    }

    if (chosen === 'unzip') {
        const result = await run('unzip', ['-l', '--', file], { timeout: 60000 });
        return parseUnzipListing(result.stdout);
    }

    // `--` so a file called "-C" is a file and not an option.
    const result = await run(chosen, ['-tvf', file], { timeout: 60000 });
    if (!result.ok && result.stdout.trim() === '') {
        log.debug(`${chosen} -tvf ${file}: ${result.stderr.trim().split('\n')[0] ?? 'failed'}`);
        return [];
    }
    return parseArchiveListing(result.stdout);
}

/** One level of an archive, folded the way a file explorer shows a folder. */
export async function listDirectory(file: string, directory: string): Promise<ArchiveEntry[]> {
    return entriesInDirectory(await list(file), directory);
}

export interface ArchiveResult {
    ok: boolean;
    message?: string;
}

/**
 * Unpack an archive into a directory, streaming progress.
 *
 * Deliberately no `-P`: without it bsdtar and GNU tar both refuse absolute
 * paths and `..` components, which is the protection that matters most here.
 */
export function extract(
    file: string,
    destination: string,
    onLog: (chunk: string) => void,
): Promise<ArchiveResult> {
    const chosen = tool(file);
    if (!chosen) {
        return Promise.resolve({ ok: false, message: 'No archive tool is installed.' });
    }

    const [command, args] = chosen === 'unzip'
        ? ['unzip', ['-o', '--', file, '-d', destination]]
        : [chosen, ['-x', '-v', '-f', file, '-C', destination]];

    return new Promise((resolve) => {
        onLog(`$ ${command} ${(args as string[]).join(' ')}\n`);
        const child = start(command as string, args as string[]);
        let stderr = '';
        child.stdout?.on('data', (chunk: Buffer) => onLog(String(chunk)));
        child.stderr?.on('data', (chunk: Buffer) => {
            stderr += String(chunk);
            // bsdtar writes its verbose file list to stderr, so this is progress
            // and not necessarily trouble.
            onLog(String(chunk));
        });
        child.on('error', (error) => {
            stderr += error.message;
            onLog(`\n${String(error)}\n`);
        });
        child.on('close', (code) => {
            resolve(code === 0
                ? { ok: true }
                : { ok: false, message: stderr.trim().split('\n').pop() || `${command} exited with ${code ?? '?'}.` });
        });
    });
}

/**
 * Build an archive from a list of paths.
 *
 * They are named relative to a common parent so the archive holds "photos/a.jpg"
 * rather than "/home/vscodeos/Pictures/photos/a.jpg", which is what every other
 * archiver does and what an extraction expects.
 */
export function compress(
    sources: string[],
    destination: string,
    onLog: (chunk: string) => void,
): Promise<ArchiveResult> {
    if (sources.length === 0) {
        return Promise.resolve({ ok: false, message: 'Nothing selected.' });
    }
    const parent = path.dirname(sources[0]);
    const names = sources.map((source) => path.basename(source));

    if (which('bsdtar')) {
        // -a picks the format from the destination's extension.
        return spawnArchive('bsdtar', ['-a', '-c', '-v', '-f', destination, '-C', parent, ...names], onLog);
    }
    if (archiveKind(destination) === 'zip' && which('zip')) {
        return spawnArchive('zip', ['-r', '-q', destination, ...names], onLog, parent);
    }
    if (which('tar')) {
        return spawnArchive('tar', ['-c', '-z', '-v', '-f', destination, '-C', parent, ...names], onLog);
    }
    return Promise.resolve({ ok: false, message: 'No archive tool is installed.' });
}

function spawnArchive(
    command: string,
    args: string[],
    onLog: (chunk: string) => void,
    cwd?: string,
): Promise<ArchiveResult> {
    return new Promise((resolve) => {
        onLog(`$ ${command} ${args.join(' ')}\n`);
        // `zip` has no equivalent of tar's -C, so it is the one case that needs
        // a working directory rather than a flag.
        const child = start(command, args, { cwd });
        let stderr = '';
        child.stdout?.on('data', (chunk: Buffer) => onLog(String(chunk)));
        child.stderr?.on('data', (chunk: Buffer) => {
            stderr += String(chunk);
            onLog(String(chunk));
        });
        child.on('error', (error) => {
            stderr += error.message;
            onLog(`\n${String(error)}\n`);
        });
        child.on('close', (code) => {
            resolve(code === 0
                ? { ok: true }
                : { ok: false, message: stderr.trim().split('\n').pop() || `${command} exited with ${code ?? '?'}.` });
        });
    });
}

/**
 * Pull one member out to a temporary directory so the editor can open it.
 *
 * The member is written under a per-archive temp directory, which is why the
 * caller gets back a real path: a webview cannot be handed a path inside a zip.
 */
export async function extractOne(file: string, member: string): Promise<string | undefined> {
    const chosen = tool(file);
    if (!chosen) {
        return undefined;
    }
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'vscodeos-archive-'));

    const result = chosen === 'unzip'
        ? await run('unzip', ['-o', '--', file, member, '-d', scratch], { timeout: 60000 })
        : await run(chosen, ['-x', '-f', file, '-C', scratch, '--', member], { timeout: 60000 });

    if (!result.ok) {
        log.debug(`extracting ${member}: ${result.stderr.trim().split('\n')[0] ?? 'failed'}`);
        return undefined;
    }

    const extracted = path.join(scratch, member);
    try {
        await fs.access(extracted);
        return extracted;
    } catch {
        return undefined;
    }
}
