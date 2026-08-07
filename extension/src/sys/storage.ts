// Storage Sense: what is using the disk, and what is safe to delete.
//
// Two questions, answered by two different mechanisms. "How full is each disk"
// is `fs.statfs` over the mountpoints lsblk reports. "What inside my home is
// big" is `du -x -d 2`, because walking a home directory in Node means tens of
// thousands of round trips and `du` is in `base` on both images.
//
// The cleanup half is deliberately a fixed list. Nothing here takes a path from
// the user and deletes it: every target is a constant in this file, so the worst
// a confused caller can do is empty a cache that is meant to be emptiable. The
// three that need root go through /usr/local/bin/vscodeos-clean, which takes one
// word from a fixed vocabulary - the same shape as the updater's helper.

import { promises as fs, statfs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { output, run, which } from './exec';
import { log } from '../log';

const CLEAN_HELPER = '/usr/local/bin/vscodeos-clean';

export interface MountUsage {
    mountpoint: string;
    label?: string;
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
    removable: boolean;
}

export interface DirectoryUsage {
    path: string;
    name: string;
    bytes: number;
}

export type CleanupId =
    | 'user-cache'
    | 'thumbnails'
    | 'code-cache'
    | 'chromium-cache'
    | 'npm-cache'
    | 'tmp'
    | 'trash'
    | 'pacman-cache'
    | 'journal'
    | 'orphans';

export interface CleanupCategory {
    id: CleanupId;
    title: string;
    description: string;
    bytes: number;
    /** Needs root, so it goes through pkexec and the helper. */
    privileged: boolean;
    /** False when the tool it needs is not installed on this machine. */
    available: boolean;
}

export interface StorageState {
    mounts: MountUsage[];
    home: DirectoryUsage[];
    categories: CleanupCategory[];
    /** True when the privileged rows can actually be acted on. */
    canElevate: boolean;
}

/** Where each unprivileged category lives. Constants, never user input. */
function userTargets(): Record<string, string[]> {
    const home = os.homedir();
    return {
        'user-cache': [path.join(home, '.cache')],
        thumbnails: [path.join(home, '.cache', 'thumbnails')],
        'code-cache': [
            path.join(home, '.config', 'Code', 'Cache'),
            path.join(home, '.config', 'Code', 'CachedData'),
            path.join(home, '.config', 'Code', 'Code Cache'),
            path.join(home, '.config', 'Code', 'GPUCache'),
            path.join(home, '.config', 'Code', 'logs'),
        ],
        'chromium-cache': [path.join(home, '.cache', 'chromium')],
        'npm-cache': [path.join(home, '.npm', '_cacache')],
        trash: [path.join(home, '.local', 'share', 'Trash')],
    };
}

// ------------------------------------------------------------------- reading

export async function mounts(): Promise<MountUsage[]> {
    const text = await output('lsblk', ['-nrpo', 'MOUNTPOINT,LABEL,RM'], 5000);
    const seen = new Set<string>();
    const found: MountUsage[] = [];

    for (const line of (text ?? '').split('\n')) {
        const [mountpoint, label, removable] = line.split(' ');
        if (!mountpoint || mountpoint === '[SWAP]' || seen.has(mountpoint)) {
            continue;
        }
        seen.add(mountpoint);
        const usage = await usageOf(mountpoint);
        if (usage) {
            found.push({
                mountpoint,
                label: label || undefined,
                removable: removable === '1',
                ...usage,
            });
        }
    }

    // A machine whose lsblk says nothing useful - a container, an overlay root -
    // should still see how full "/" is.
    if (found.length === 0) {
        const usage = await usageOf('/');
        if (usage) {
            found.push({ mountpoint: '/', removable: false, ...usage });
        }
    }
    return found;
}

function usageOf(mountpoint: string): Promise<{ totalBytes: number; freeBytes: number; usedBytes: number } | undefined> {
    return new Promise((resolve) => {
        statfs(mountpoint, (error, stats) => {
            if (error || !stats || stats.blocks === 0) {
                resolve(undefined);
                return;
            }
            const total = Number(stats.blocks) * Number(stats.bsize);
            // bavail, not bfree: the reserved blocks are not space anyone can use.
            const free = Number(stats.bavail) * Number(stats.bsize);
            resolve({ totalBytes: total, freeBytes: free, usedBytes: total - free });
        });
    });
}

/**
 * The biggest things under a directory, two levels down.
 *
 * `-x` keeps it on one filesystem, so a mounted USB stick under the home
 * directory is not counted twice, and `du` is left to do the walking because a
 * Node recursion over a real home directory is thousands of stat calls.
 */
export async function largestDirectories(root = os.homedir(), limit = 12): Promise<DirectoryUsage[]> {
    if (!which('du')) {
        return [];
    }
    const result = await run('du', ['-x', '-d', '2', '-B1', root], { timeout: 60000 });
    // du exits non-zero when it could not read something, which is routine and
    // does not invalidate the lines it did produce.
    const entries: DirectoryUsage[] = [];
    for (const line of result.stdout.split('\n')) {
        const tab = line.indexOf('\t');
        if (tab < 1) {
            continue;
        }
        const bytes = Number(line.slice(0, tab));
        const full = line.slice(tab + 1);
        if (!Number.isFinite(bytes) || full === root) {
            continue;
        }
        entries.push({ path: full, name: path.relative(root, full) || path.basename(full), bytes });
    }

    // Keep only the deepest interesting rows: a parent and its one big child say
    // the same thing twice, and the child is the more useful of the two.
    entries.sort((a, b) => b.bytes - a.bytes);
    const kept: DirectoryUsage[] = [];
    for (const entry of entries) {
        if (kept.some((k) => entry.path.startsWith(`${k.path}${path.sep}`))) {
            continue;
        }
        kept.push(entry);
        if (kept.length >= limit) {
            break;
        }
    }
    return kept;
}

async function sizeOf(targets: string[]): Promise<number> {
    if (!which('du')) {
        return 0;
    }
    let total = 0;
    for (const target of targets) {
        const result = await run('du', ['-sx', '-B1', target], { timeout: 30000 });
        const bytes = Number(result.stdout.split('\t')[0]);
        if (Number.isFinite(bytes)) {
            total += bytes;
        }
    }
    return total;
}

/** Files directly in /tmp that this user owns. Nothing recursive, nothing else's. */
async function tmpSize(): Promise<number> {
    let total = 0;
    try {
        const uid = os.userInfo().uid;
        for (const entry of await fs.readdir('/tmp')) {
            const full = path.join('/tmp', entry);
            try {
                const stat = await fs.lstat(full);
                if (stat.uid === uid) {
                    total += stat.size;
                }
            } catch {
                /* vanished between readdir and lstat, or not ours to stat */
            }
        }
    } catch (error) {
        log.debug(`storage: could not measure /tmp: ${String(error)}`);
    }
    return total;
}

/**
 * What the helper reports for the privileged categories.
 * `vscodeos-clean report` prints "<id> <bytes>" lines.
 */
async function privilegedSizes(): Promise<Record<string, number>> {
    if (!which('pkexec')) {
        return {};
    }
    const result = await run('pkexec', [CLEAN_HELPER, 'report'], { timeout: 60000 });
    const sizes: Record<string, number> = {};
    for (const line of result.stdout.split('\n')) {
        const [id, bytes] = line.trim().split(/\s+/);
        if (id && Number.isFinite(Number(bytes))) {
            sizes[id] = Number(bytes);
        }
    }
    return sizes;
}

export async function getState(): Promise<StorageState> {
    const targets = userTargets();
    const canElevate = which('pkexec') !== undefined;

    const [mountList, home, sizes, tmpBytes, privileged] = await Promise.all([
        mounts(),
        largestDirectories(),
        Promise.all(
            Object.entries(targets).map(async ([id, paths]) => [id, await sizeOf(paths)] as const),
        ),
        tmpSize(),
        canElevate ? privilegedSizes() : Promise.resolve({} as Record<string, number>),
    ]);

    const userBytes = Object.fromEntries(sizes);
    const categories: CleanupCategory[] = [
        {
            id: 'user-cache',
            title: 'Application cache',
            description: '~/.cache — rebuilt on demand by whatever put it there',
            bytes: userBytes['user-cache'] ?? 0,
            privileged: false,
            available: true,
        },
        {
            id: 'thumbnails',
            title: 'Thumbnails',
            description: 'Preview images for files you have browsed',
            bytes: userBytes.thumbnails ?? 0,
            privileged: false,
            available: true,
        },
        {
            id: 'code-cache',
            title: 'Editor cache',
            description: "VS Code's own caches and logs, not your settings",
            bytes: userBytes['code-cache'] ?? 0,
            privileged: false,
            available: true,
        },
        {
            id: 'chromium-cache',
            title: 'Browser cache',
            description: 'Chromium page cache; history and logins are untouched',
            bytes: userBytes['chromium-cache'] ?? 0,
            privileged: false,
            available: true,
        },
        {
            id: 'npm-cache',
            title: 'npm cache',
            description: 'Downloaded packages, re-fetched when next needed',
            bytes: userBytes['npm-cache'] ?? 0,
            privileged: false,
            available: true,
        },
        {
            id: 'tmp',
            title: 'Temporary files',
            description: 'Your own files in /tmp',
            bytes: tmpBytes,
            privileged: false,
            available: true,
        },
        {
            id: 'trash',
            title: 'Recycle Bin',
            description: 'Everything you have deleted and not yet restored',
            bytes: userBytes.trash ?? 0,
            privileged: false,
            available: true,
        },
        {
            id: 'pacman-cache',
            title: 'Package cache',
            description: 'Downloaded packages, keeping the most recent of each',
            bytes: privileged['pacman-cache'] ?? 0,
            privileged: true,
            available: canElevate,
        },
        {
            id: 'journal',
            title: 'System logs',
            description: 'Trims the systemd journal to 50 MB',
            bytes: privileged.journal ?? 0,
            privileged: true,
            available: canElevate,
        },
        {
            id: 'orphans',
            title: 'Orphaned packages',
            description: 'Packages pulled in as dependencies and no longer needed',
            bytes: privileged.orphans ?? 0,
            privileged: true,
            available: canElevate,
        },
    ];

    return { mounts: mountList, home, categories, canElevate };
}

// ------------------------------------------------------------------ cleaning

/** Empty a directory without removing the directory itself. */
async function emptyDirectory(target: string): Promise<void> {
    let names: string[];
    try {
        names = await fs.readdir(target);
    } catch {
        return; // never existed, which is the same as already clean
    }
    for (const name of names) {
        await fs.rm(path.join(target, name), { recursive: true, force: true }).catch((error: unknown) => {
            log.debug(`storage: could not remove ${name}: ${String(error)}`);
        });
    }
}

/**
 * Run one unprivileged cleanup. Returns false for the privileged ids, which the
 * caller has to send through the helper instead.
 */
export async function cleanUser(id: CleanupId): Promise<boolean> {
    const targets = userTargets();

    if (id === 'tmp') {
        const uid = os.userInfo().uid;
        for (const entry of await fs.readdir('/tmp').catch(() => [] as string[])) {
            const full = path.join('/tmp', entry);
            try {
                if ((await fs.lstat(full)).uid === uid) {
                    await fs.rm(full, { recursive: true, force: true });
                }
            } catch {
                /* not ours, or gone already */
            }
        }
        return true;
    }

    const paths = targets[id];
    if (!paths) {
        return false;
    }
    for (const target of paths) {
        await emptyDirectory(target);
    }
    return true;
}

export function isPrivileged(id: CleanupId): boolean {
    return id === 'pacman-cache' || id === 'journal' || id === 'orphans';
}

export const cleanHelper = CLEAN_HELPER;
