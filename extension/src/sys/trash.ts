// The Recycle Bin.
//
// The file explorer has always been able to put things in the trash - it calls
// `vscode.workspace.fs.delete({ useTrash: true })`, which goes through Electron
// to the freedesktop trash under ~/.local/share/Trash. Nothing has ever read
// them back, so "Move to trash" has been a slower, more reassuring-sounding
// delete.
//
// The spec is simple: files/<name> holds the thing, info/<name>.trashinfo holds
// where it came from and when it went. Restoring is moving one back and
// deleting the other. The two directories can disagree - a crash between the
// two writes, or someone tidying by hand - so an entry with no info file is
// still listed, just without an original location, and an info file with no
// file is dropped.

import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseTrashInfo } from '../util/parse';
import { log } from '../log';

/**
 * The virtual path the Recycle Bin lives at.
 *
 * A sentinel rather than the real directory: browsing ~/.local/share/Trash/files
 * shows mangled names, no original locations and no way to restore anything, and
 * the file explorer would happily let you rename things in it.
 */
export const TRASH_PATH = 'trash://';

export interface TrashEntry {
    /** Name inside files/, which is also the key for restore and remove. */
    name: string;
    /** Absolute path in the trash, for stat and rm. */
    path: string;
    /** Where it came from, absent when the .trashinfo is missing or unreadable. */
    originalPath?: string;
    deletedAt?: number;
    isDirectory: boolean;
    size: number;
}

function trashRoot(): string {
    const dataHome = process.env.XDG_DATA_HOME;
    return dataHome
        ? path.join(dataHome, 'Trash')
        : path.join(os.homedir(), '.local', 'share', 'Trash');
}

export class TrashService extends EventEmitter {
    private get filesDir(): string {
        return path.join(trashRoot(), 'files');
    }

    private get infoDir(): string {
        return path.join(trashRoot(), 'info');
    }

    async list(): Promise<TrashEntry[]> {
        let names: string[];
        try {
            names = await fs.readdir(this.filesDir);
        } catch {
            // No trash directory means nothing has ever been deleted.
            return [];
        }

        const entries = await Promise.all(names.map((name) => this.describe(name)));
        return entries
            .filter((entry): entry is TrashEntry => entry !== undefined)
            .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
    }

    private async describe(name: string): Promise<TrashEntry | undefined> {
        const full = path.join(this.filesDir, name);
        let isDirectory = false;
        let size = 0;
        try {
            // lstat, not stat: a trashed symlink should be listed as what it is
            // rather than followed to something outside the bin.
            const stat = await fs.lstat(full);
            isDirectory = stat.isDirectory();
            size = stat.size;
        } catch {
            return undefined;
        }

        let info;
        try {
            info = parseTrashInfo(await fs.readFile(path.join(this.infoDir, `${name}.trashinfo`), 'utf8'));
        } catch {
            info = undefined;
        }

        return { name, path: full, originalPath: info?.path, deletedAt: info?.deletedAt, isDirectory, size };
    }

    async isEmpty(): Promise<boolean> {
        try {
            return (await fs.readdir(this.filesDir)).length === 0;
        } catch {
            return true;
        }
    }

    /**
     * Put things back where they came from.
     *
     * An entry whose original location is gone, or whose .trashinfo was lost,
     * cannot be restored automatically - there is nowhere to put it - so the
     * caller is told which ones were skipped rather than having them silently
     * vanish or land somewhere arbitrary.
     */
    async restore(names: string[]): Promise<{ restored: number; skipped: string[] }> {
        const skipped: string[] = [];
        let restored = 0;

        for (const name of names) {
            const entry = await this.describe(name);
            if (!entry?.originalPath) {
                skipped.push(name);
                continue;
            }
            try {
                await fs.mkdir(path.dirname(entry.originalPath), { recursive: true });
                const destination = await uniqueName(entry.originalPath);
                await fs.rename(entry.path, destination);
                await fs.rm(path.join(this.infoDir, `${name}.trashinfo`), { force: true });
                restored += 1;
            } catch (error) {
                log.error(`could not restore ${name}`, error);
                skipped.push(name);
            }
        }

        this.emit('change');
        return { restored, skipped };
    }

    async remove(names: string[]): Promise<void> {
        for (const name of names) {
            await fs.rm(path.join(this.filesDir, name), { recursive: true, force: true });
            await fs.rm(path.join(this.infoDir, `${name}.trashinfo`), { force: true });
        }
        this.emit('change');
    }

    async empty(): Promise<void> {
        for (const directory of [this.filesDir, this.infoDir]) {
            let names: string[];
            try {
                names = await fs.readdir(directory);
            } catch {
                continue;
            }
            for (const name of names) {
                await fs.rm(path.join(directory, name), { recursive: true, force: true }).catch((error: unknown) => {
                    log.debug(`could not empty ${name}: ${String(error)}`);
                });
            }
        }
        this.emit('change');
    }

    /** Something outside this module put a file in the bin; redraw both views. */
    notifyChanged(): void {
        this.emit('change');
    }
}

/**
 * "report.txt" -> "report (1).txt" when the original location is occupied
 * again. Restoring must never overwrite whatever took the old name.
 */
export async function uniqueName(target: string): Promise<string> {
    try {
        await fs.access(target);
    } catch {
        return target;
    }
    const directory = path.dirname(target);
    const extension = path.extname(target);
    const base = path.basename(target, extension);
    for (let i = 1; i < 1000; i++) {
        const candidate = path.join(directory, `${base} (${i})${extension}`);
        try {
            await fs.access(candidate);
        } catch {
            return candidate;
        }
    }
    return `${target}.${Date.now()}`;
}
