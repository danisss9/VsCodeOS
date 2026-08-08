// Reading XDG desktop entries.
//
// `.desktop` files are how a Linux machine says what is installed on it, so
// they are what the All Apps view lists beyond the shell's own apps. The format
// is an INI file with one group that matters, a fixed set of keys, and an `Exec`
// line that is *not* a shell command line: it has its own quoting rules and a
// set of field codes standing in for the files being opened.
//
// Parsing lives here, away from the filesystem walk in src/sys/desktopApps.ts,
// because this is the half where a mistake is invisible - an Exec line split
// wrongly launches the wrong thing - and the half that can be tested.

export interface DesktopEntry {
    name: string;
    comment: string;
    exec: string;
    icon: string;
    terminal: boolean;
    /** The entry asks not to be shown in menus; the All Apps view honours it. */
    noDisplay: boolean;
    categories: string[];
    keywords: string[];
    /** X-VSCodeOS-WebApp, written by the web app installer so its own entries are recognisable. */
    webAppId?: string;
}

function isTrue(value: string | undefined): boolean {
    return value?.toLowerCase() === 'true';
}

function splitList(value: string | undefined): string[] {
    return (value ?? '').split(';').map((part) => part.trim()).filter(Boolean);
}

/**
 * Read the `[Desktop Entry]` group.
 *
 * Returns undefined for everything that is not a launchable application: Link
 * and Directory entries, `Hidden=true` (which means "deleted", not "not shown")
 * and anything with no Exec line.
 */
export function parseDesktopEntry(text: string): DesktopEntry | undefined {
    const fields = new Map<string, string>();
    let inGroup = false;

    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) {
            continue;
        }
        if (line.startsWith('[')) {
            // Only the first group is the application itself; the rest are
            // desktop actions ("New Window", "Private Window") with their own
            // Name and Exec, which would otherwise overwrite the real ones.
            inGroup = line === '[Desktop Entry]';
            continue;
        }
        if (!inGroup) {
            continue;
        }
        const equals = line.indexOf('=');
        if (equals <= 0) {
            continue;
        }
        const key = line.slice(0, equals).trim();
        // Localised keys are "Name[pt_BR]". There is no locale to match against
        // here, and picking a translation at random is worse than the C name.
        if (key.endsWith(']')) {
            continue;
        }
        if (!fields.has(key)) {
            fields.set(key, line.slice(equals + 1).trim());
        }
    }

    const exec = fields.get('Exec') ?? '';
    if ((fields.get('Type') ?? 'Application') !== 'Application' || !exec || isTrue(fields.get('Hidden'))) {
        return undefined;
    }

    return {
        name: fields.get('Name') ?? '',
        comment: fields.get('Comment') ?? fields.get('GenericName') ?? '',
        exec,
        icon: fields.get('Icon') ?? '',
        terminal: isTrue(fields.get('Terminal')),
        noDisplay: isTrue(fields.get('NoDisplay')),
        categories: splitList(fields.get('Categories')),
        keywords: splitList(fields.get('Keywords')),
        webAppId: fields.get('X-VSCodeOS-WebApp') || undefined,
    };
}

/** Field codes: the file names, URLs and icon the launcher would substitute in. */
const FIELD_CODE = /%[fFuUdDnNickvm]/g;

/**
 * Split an `Exec` line into argv.
 *
 * Not a shell split: the specification allows only double quotes, escapes
 * `\\ \" \` \$` inside them, and reserves `%` for field codes. Nothing here is
 * handed to a shell either - src/sys/exec.ts spawns argv directly - so the one
 * job is to cut the string the same way a compliant launcher would.
 */
export function execArgv(exec: string): string[] {
    const args: string[] = [];
    let current = '';
    let started = false;
    let quoted = false;

    for (let i = 0; i < exec.length; i++) {
        const character = exec[i];
        if (quoted) {
            if (character === '\\' && i + 1 < exec.length) {
                current += exec[++i];
                continue;
            }
            if (character === '"') {
                quoted = false;
                continue;
            }
            current += character;
            continue;
        }
        if (character === '"') {
            quoted = true;
            started = true;
            continue;
        }
        if (character === ' ' || character === '\t') {
            if (started) {
                args.push(current);
                current = '';
                started = false;
            }
            continue;
        }
        current += character;
        started = true;
    }
    if (started) {
        args.push(current);
    }

    // A field code stands for something being opened, and nothing is: drop them,
    // then drop the arguments that were nothing but a field code. The program
    // itself is index 0 and always survives.
    return args
        .map((arg) => arg.replace(FIELD_CODE, '').replace(/%%/g, '%'))
        .filter((arg, index) => index === 0 || arg !== '');
}

/** Escape a value for writing back into a desktop entry. */
export function escapeDesktopValue(value: string): string {
    return value
        .replace(/\\/g, '\\\\')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '')
        .replace(/\t/g, '\\t');
}

/**
 * Escape a value for an `Exec` line, where `%` is not a literal.
 *
 * A percent-encoded URL is the case that matters: `https://x/a%20b` reaches the
 * launcher as the field code `%2` followed by `0b`, GLib rejects the whole entry
 * as having an unrecognised field code, and the app vanishes from every menu on
 * the machine without saying why. `%%` is the spec's literal percent.
 */
export function escapeDesktopExec(value: string): string {
    return escapeDesktopValue(value).replace(/%/g, '%%');
}
