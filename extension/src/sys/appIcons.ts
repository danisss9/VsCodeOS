// Finding the picture for a desktop entry's `Icon=` line.
//
// The value is either an absolute path - easy - or a *name*, which the icon
// theme specification says to resolve by walking the current theme, then its
// parents, then hicolor, across a directory layout each theme describes in its
// own index.theme. A full implementation is a lot of work for a launcher grid,
// and on these images it lands on the same file this shorter search does.
//
// The shape matters more than the search does. Looking a name up by stat'ing
// every candidate path is four roots times five themes times eight sizes times
// two layouts times three extensions - nearly a thousand syscalls for one icon,
// and a miss costs the full thousand. A machine with three hundred desktop
// entries would spend that three hundred times to draw one grid.
//
// So it is inverted: every icon directory is read once, in preference order,
// into a name -> path map. Forty readdirs, then every lookup is free, including
// the misses.

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { log } from '../log';

/** Big enough to look right on a tile, small enough not to matter as a data URI. */
const SIZES = ['128x128', '96x96', '64x64', 'scalable', '48x48', '256x256', '512x512', '32x32'];

/** Searched in this order, so the first theme to have a name wins it. */
const THEMES = ['hicolor', 'Adwaita', 'breeze', 'Papirus', 'gnome'];

/** No browser renders XPM, so it is not worth indexing: the glyph is better. */
const EXTENSIONS = new Set(['.png', '.svg']);

const MIME: Record<string, string> = {
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
};

/** A tile is 96px; anything past this is a file somebody has mis-installed. */
const MAX_BYTES = 256 * 1024;

let index: Promise<Map<string, string>> | undefined;
const encoded = new Map<string, string | undefined>();

function iconRoots(): string[] {
    const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
    return [
        path.join(dataHome, 'icons'),
        path.join(os.homedir(), '.icons'),
        '/usr/local/share/icons',
        '/usr/share/icons',
    ];
}

/**
 * Every directory that might hold an application icon, best first.
 *
 * The user's own themes come before the system's, larger sizes before smaller,
 * and pixmaps last - it is where packages put an icon when they have not been
 * themed at all.
 */
function searchPath(): string[] {
    const directories: string[] = [];
    for (const root of iconRoots()) {
        for (const theme of THEMES) {
            for (const size of SIZES) {
                // apps/ is where an application icon belongs; some themes write
                // the size the other way round, so both layouts are indexed.
                directories.push(path.join(root, theme, size, 'apps'));
                directories.push(path.join(root, theme, 'apps', size));
            }
        }
    }
    directories.push('/usr/share/pixmaps', '/usr/local/share/pixmaps');
    return directories;
}

async function buildIndex(): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    const directories = searchPath();

    // Sequential on purpose: most of these do not exist, ENOENT is cheap, and
    // firing eight hundred readdirs at once on a Pi's SD card is not.
    for (const directory of directories) {
        let names: string[];
        try {
            names = await fs.readdir(directory);
        } catch {
            continue;
        }
        for (const name of names) {
            const extension = path.extname(name).toLowerCase();
            if (!EXTENSIONS.has(extension)) {
                continue;
            }
            const key = name.slice(0, -extension.length);
            // First writer wins: the search path is already in preference order.
            if (!found.has(key)) {
                found.set(key, path.join(directory, name));
            }
        }
    }

    log.debug(`icon index: ${found.size} names`);
    return found;
}

/**
 * An icon name as a data URI the webviews can draw, or undefined if there is no
 * icon for it.
 */
export async function dataUri(name: string): Promise<string | undefined> {
    if (!name) {
        return undefined;
    }
    if (encoded.has(name)) {
        return encoded.get(name);
    }

    let result: string | undefined;
    try {
        // An absolute path is not a name at all; the spec allows it and plenty
        // of third-party packages use it.
        let file: string | undefined = name;
        if (!name.startsWith('/')) {
            index ??= buildIndex();
            file = (await index).get(name);
        }

        const extension = file ? path.extname(file).toLowerCase() : '';
        if (file && MIME[extension]) {
            const bytes = await fs.readFile(file);
            if (bytes.length <= MAX_BYTES) {
                result = `data:${MIME[extension]};base64,${bytes.toString('base64')}`;
            }
        }
    } catch {
        result = undefined;
    }

    encoded.set(name, result);
    return result;
}

/** Forget everything, so an install or an uninstall is picked up. */
export function clearCache(): void {
    index = undefined;
    encoded.clear();
}
