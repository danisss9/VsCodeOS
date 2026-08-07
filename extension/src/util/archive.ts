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
