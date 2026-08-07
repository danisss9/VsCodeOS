// What counts as playable media.
//
// Shared by the file explorer, which routes these to the player instead of to
// `vscode.open`, and by the player itself, which builds a folder playlist from
// them. Kept here rather than in either app because a disagreement between the
// two would show up as a file that opens as a wall of binary text.

const VIDEO_EXTENSIONS = new Set([
    '.mp4', '.m4v', '.webm', '.mkv', '.mov', '.avi', '.ogv', '.mpg', '.mpeg', '.wmv', '.flv', '.3gp',
]);

const AUDIO_EXTENSIONS = new Set([
    '.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.oga', '.opus', '.wma', '.aiff', '.mid', '.midi',
]);

export type MediaKind = 'audio' | 'video';

/** The extension, lowercased, including the dot. `path.extname` without the import. */
function extensionOf(file: string): string {
    const name = file.slice(file.lastIndexOf('/') + 1);
    const dot = name.lastIndexOf('.');
    // A leading dot is a hidden file, not an extension: ".bashrc" has none.
    return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

export function mediaKind(file: string): MediaKind | undefined {
    const extension = extensionOf(file);
    if (VIDEO_EXTENSIONS.has(extension)) {
        return 'video';
    }
    return AUDIO_EXTENSIONS.has(extension) ? 'audio' : undefined;
}

/** Extensions without the dot, for a showOpenDialog filter. */
export function mediaFilterExtensions(): string[] {
    return [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS].map((extension) => extension.slice(1));
}
