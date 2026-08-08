// What else is installed on this machine.
//
// The All Apps view used to list the shell's own apps and nothing else, which
// made it a menu of eleven things on a machine with three hundred programs on
// it. `.desktop` files under the XDG application directories are how Linux
// answers "what is installed", so this reads them.
//
// The parsing is in util/desktop.ts; this is the filesystem half - where to
// look, what to leave out, and how to start one. Deliberately cheap: one
// readdir per directory and a read per file, cached until something asks for a
// refresh, because this runs when a side bar view becomes visible.

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { launch as spawnDetached, which } from './exec';
import { execArgv, parseDesktopEntry } from '../util/desktop';
import { log } from '../log';

export interface DesktopApp {
    /** The desktop file id: its name without the .desktop suffix. */
    id: string;
    name: string;
    description: string;
    /** Absolute path of the .desktop file. */
    file: string;
    /** Icon name or absolute path, straight out of the entry. */
    icon: string;
    categories: string[];
    keywords: string[];
    terminal: boolean;
    argv: string[];
}

/** Nothing under here is an application anybody wants in a launcher. */
const HIDDEN_CATEGORIES = new Set(['Screensaver', 'Settings']);

/**
 * Entries this shell already provides better, or that are the shell. Listing
 * VS Code inside VS Code's own start menu is not useful, and the mini-apps have
 * real entries of their own.
 */
const SUPPRESSED_IDS = new Set(['code', 'code-url-handler', 'code-oss', 'visual-studio-code']);

function directories(): string[] {
    const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
    const dataDirs = (process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean);
    // The user's own directory last, so a local override of a system entry wins
    // the id collision below.
    return [...dataDirs, dataHome].map((directory) => path.join(directory, 'applications'));
}

/**
 * Cached because the list is read far more often than it changes: opening the
 * view reads it, and so does every launch, which would otherwise be a second
 * full pass over three hundred files to find the one that was clicked. Nothing
 * watches the directories, so `refresh()` is what picks up an install.
 */
let cached: Promise<DesktopApp[]> | undefined;

/**
 * Every launchable application on the machine.
 *
 * Entries carrying X-VSCodeOS-WebApp are skipped: those are ours, sys/webapps.ts
 * has richer records for them, and listing both would show every web app twice.
 */
export function list(): Promise<DesktopApp[]> {
    cached ??= scan();
    return cached;
}

/** Forget the cache, so the next `list()` reads the directories again. */
export function refresh(): void {
    cached = undefined;
}

async function scan(): Promise<DesktopApp[]> {
    const byId = new Map<string, DesktopApp>();

    for (const directory of directories()) {
        let names: string[];
        try {
            names = await fs.readdir(directory);
        } catch {
            // A machine with no /usr/local/share/applications is normal.
            continue;
        }

        for (const name of names) {
            if (!name.endsWith('.desktop')) {
                continue;
            }
            const id = name.slice(0, -'.desktop'.length);
            const file = path.join(directory, name);
            const app = await read(id, file);
            if (app) {
                byId.set(id, app);
            } else {
                // A user entry that is Hidden=true is a deletion of the system
                // one with the same id, per the spec.
                byId.delete(id);
            }
        }
    }

    return [...byId.values()].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

async function read(id: string, file: string): Promise<DesktopApp | undefined> {
    let text: string;
    try {
        text = await fs.readFile(file, 'utf8');
    } catch {
        return undefined;
    }

    const entry = parseDesktopEntry(text);
    if (!entry || entry.noDisplay || entry.webAppId || !entry.name || SUPPRESSED_IDS.has(id)) {
        return undefined;
    }
    if (entry.categories.some((category) => HIDDEN_CATEGORIES.has(category))) {
        return undefined;
    }

    const argv = execArgv(entry.exec);
    if (argv.length === 0) {
        return undefined;
    }

    return {
        id,
        name: entry.name,
        description: entry.comment || entry.categories.join(', ') || 'Installed application',
        file,
        icon: entry.icon,
        categories: entry.categories,
        keywords: entry.keywords,
        terminal: entry.terminal,
        argv,
    };
}

/**
 * Start one.
 *
 * `gio launch` is the right tool when it is there - it applies the entry's
 * working directory, its environment and its startup notification, none of
 * which a bare spawn of the Exec line does. Without it, argv it is; the
 * splitting follows the spec (util/desktop.ts) and nothing goes near a shell.
 */
export function launch(app: DesktopApp): boolean {
    const gio = which('gio');
    const ok = gio
        ? spawnDetached(gio, ['launch', app.file])
        : spawnDetached(app.argv[0], app.argv.slice(1));
    if (ok) {
        log.info(`launched ${app.id}`);
    }
    return ok;
}
