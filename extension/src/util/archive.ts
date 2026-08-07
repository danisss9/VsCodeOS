// What counts as an archive.
//
// Shared by the file explorer, which routes these into the archive browser
// instead of to `vscode.open`, and by sys/archive.ts, which picks a destination
// name when compressing. Kept here rather than in either so it can be tested,
// and so the two cannot disagree about what a ".tar.gz" is.
//
// The double extensions are the whole reason this is not a one-line Set lookup:
// `name.slice(name.lastIndexOf('.'))` reads ".tar.gz" as ".gz", which is a
// different format with a different `bsdtar` invocation and a different
// stripped-down name once it is unpacked.

export type ArchiveKind =
    | 'zip'
    | 'tar'
    | 'tar.gz'
    | 'tar.bz2'
    | 'tar.xz'
    | 'tar.zst'
    | '7z'
    | 'rar'
    | 'gz'
    | 'bz2'
    | 'xz'
    | 'zst';

/** Longest suffix first: ".tar.gz" has to win over ".gz". */
const SUFFIXES: [string, ArchiveKind][] = [
    ['.tar.gz', 'tar.gz'],
    ['.tar.bz2', 'tar.bz2'],
    ['.tar.xz', 'tar.xz'],
    ['.tar.zst', 'tar.zst'],
    ['.tgz', 'tar.gz'],
    ['.tbz2', 'tar.bz2'],
    ['.tbz', 'tar.bz2'],
    ['.txz', 'tar.xz'],
    ['.tzst', 'tar.zst'],
    ['.zip', 'zip'],
    ['.jar', 'zip'],
    ['.whl', 'zip'],
    ['.tar', 'tar'],
    ['.7z', '7z'],
    ['.rar', 'rar'],
    ['.gz', 'gz'],
    ['.bz2', 'bz2'],
    ['.xz', 'xz'],
    ['.zst', 'zst'],
];

/**
 * The archive format a name implies, or undefined when it implies none.
 *
 * A leading dot is a hidden file and not an extension, so ".gz" on its own is
 * not an archive - the same rule util/media.ts applies.
 */
export function archiveKind(file: string): ArchiveKind | undefined {
    const name = file.slice(file.lastIndexOf('/') + 1).toLowerCase();
    for (const [suffix, kind] of SUFFIXES) {
        // `> 0` rather than `>= 0`: ".zip" as a whole name is a hidden file.
        if (name.length > suffix.length && name.endsWith(suffix)) {
            return kind;
        }
    }
    return undefined;
}

/**
 * True when the format holds several files rather than one compressed stream.
 *
 * A plain ".gz" is a single file with its name shortened, so browsing it as a
 * directory would show exactly one entry and an "extract here" is the only
 * sensible action.
 */
export function isMultiFileArchive(kind: ArchiveKind): boolean {
    return kind !== 'gz' && kind !== 'bz2' && kind !== 'xz' && kind !== 'zst';
}

export interface ArchiveEntry {
    /** Path inside the archive, normalised: no leading "./", no trailing slash. */
    path: string;
    isDirectory: boolean;
    /** Uncompressed size; 0 when the listing did not say. */
    size: number;
}

/**
 * A verbose archive listing, from whichever tool produced it.
 *
 * bsdtar is what both images have, and it prints an ls-style row:
 *
 *     -rw-r--r--  0 dan  dan   6 Aug  7 12:00 sub/b.txt
 *
 * GNU tar packs owner and group into one column and uses ISO dates:
 *
 *     -rw-r--r-- root/root   6 2026-08-07 19:51 ./sub/b.txt
 *
 * Rather than count columns - which is what makes this kind of parser break on
 * the other tool, or on a file whose name starts with a digit - each row is
 * matched from the right: a size, a date, a time or a year, then everything
 * left over is the name, spaces and all. A row that does not match at all is
 * still kept, using the whole line as a name with an unknown size, because
 * hiding a file that is genuinely in the archive is worse than showing it
 * without its size.
 */
export function parseArchiveListing(text: string | undefined): ArchiveEntry[] {
    const entries: ArchiveEntry[] = [];
    const seen = new Set<string>();

    for (const raw of (text ?? '').split('\n')) {
        const line = raw.trimEnd();
        if (!line.trim()) {
            continue;
        }

        // Only rows that begin with a permission string are entries; anything
        // else is a header or a summary line.
        const permissions = /^([-dlbcpsD][rwxsStT-]{9}[.+@]?)\s+(.*)$/.exec(line);
        if (!permissions) {
            continue;
        }

        const rest = permissions[2];
        const tail = /\s(\d+)\s+(?:\d{4}-\d{2}-\d{2}|\w{3}\s+\d{1,2})\s+(?:[\d:]{4,8}|\d{4})\s+(.+)$/.exec(rest);

        // Only the size and the name are captured; the date alternatives are
        // non-capturing, so the name is group 2 rather than group 3.
        const name = tail ? tail[2] : rest.split(/\s+/).slice(-1)[0] ?? '';
        const size = tail ? Number(tail[1]) : 0;
        const normalised = normaliseEntryPath(name);
        if (!normalised || seen.has(normalised)) {
            continue;
        }
        seen.add(normalised);

        entries.push({
            path: normalised,
            // Trust the permission bit over the trailing slash: a directory
            // stored without one still has to browse like a directory.
            isDirectory: permissions[1].startsWith('d') || name.endsWith('/'),
            size: Number.isFinite(size) ? size : 0,
        });
    }

    return entries;
}

/**
 * `unzip -l`, the fallback when there is no bsdtar:
 *
 *     ---------  ---------- -----   ----
 *             6  2026-08-07 19:51   sub/b.txt
 */
export function parseUnzipListing(text: string | undefined): ArchiveEntry[] {
    const entries: ArchiveEntry[] = [];
    const seen = new Set<string>();

    for (const raw of (text ?? '').split('\n')) {
        const match = /^\s*(\d+)\s+\d{4}-\d{2}-\d{2}\s+[\d:]+\s+(.+?)\s*$/.exec(raw);
        if (!match) {
            continue;
        }
        const normalised = normaliseEntryPath(match[2]);
        if (!normalised || seen.has(normalised)) {
            continue;
        }
        seen.add(normalised);
        entries.push({
            path: normalised,
            // unzip has no permission column here, so the trailing slash is the
            // only signal - which is exactly what the zip format itself uses.
            isDirectory: match[2].endsWith('/'),
            size: Number(match[1]),
        });
    }

    return entries;
}

/**
 * Strip the "./" tar puts on everything and the trailing slash directories
 * carry, and refuse anything that would escape the extraction directory.
 *
 * An archive is untrusted input: entries named "../../etc/passwd" or "/etc/shadow"
 * are a real and old attack. Extraction itself is done with bsdtar's `-P`
 * absent, which already refuses these, but they must not be *displayed* as
 * though they were ordinary members either.
 */
function normaliseEntryPath(name: string): string | undefined {
    let path = name.trim();
    while (path.startsWith('./')) {
        path = path.slice(2);
    }
    path = path.replace(/\/+$/, '');
    if (!path || path === '.') {
        return undefined;
    }
    if (path.startsWith('/') || path.split('/').includes('..')) {
        return undefined;
    }
    return path;
}

/**
 * The entries directly inside one directory of an archive, folded to a single
 * level the way a file explorer shows a folder.
 *
 * Archives are flat lists, and a directory may have no entry of its own - a zip
 * built from a file list often has "docs/a.txt" and nothing for "docs" - so
 * intermediate directories are synthesised from the paths that mention them.
 */
export function entriesInDirectory(entries: ArchiveEntry[], directory: string): ArchiveEntry[] {
    const prefix = directory ? `${directory}/` : '';
    const direct = new Map<string, ArchiveEntry>();

    for (const entry of entries) {
        if (!entry.path.startsWith(prefix) || entry.path === directory) {
            continue;
        }
        const remainder = entry.path.slice(prefix.length);
        const slash = remainder.indexOf('/');

        if (slash < 0) {
            direct.set(remainder, { ...entry, path: entry.path });
            continue;
        }

        // Deeper than this level: contribute the directory it implies.
        const name = remainder.slice(0, slash);
        if (!direct.has(name)) {
            direct.set(name, { path: `${prefix}${name}`, isDirectory: true, size: 0 });
        }
    }

    return [...direct.values()].sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) {
            return a.isDirectory ? -1 : 1;
        }
        return a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' });
    });
}

/**
 * The name an archive unpacks to, used to offer a destination folder.
 * "photos.tar.gz" -> "photos", "notes.txt.gz" -> "notes.txt".
 */
export function archiveBaseName(file: string): string {
    const name = file.slice(file.lastIndexOf('/') + 1);
    const lower = name.toLowerCase();
    for (const [suffix] of SUFFIXES) {
        if (lower.length > suffix.length && lower.endsWith(suffix)) {
            return name.slice(0, name.length - suffix.length);
        }
    }
    return name;
}
