// Parsers for the output of the commands the shell shells out to.
//
// These live away from the sys/ modules that call them so they can be tested
// without a VS Code API or a machine: a parser that quietly drops a device or
// miscounts an update is exactly the kind of mistake that ships.

export interface ParsedDevice {
    mac: string;
    name: string;
}

/**
 * `bluetoothctl devices [Paired|Connected]`:
 *
 *     Device AA:BB:CC:DD:EE:FF Sony WH-1000XM4
 *
 * Names contain spaces, so only the first two fields are fixed. A device that
 * has never advertised a name repeats its address there, which is what the
 * caller ends up showing.
 */
export function parseBluetoothDevices(text: string | undefined): ParsedDevice[] {
    const devices: ParsedDevice[] = [];
    for (const line of (text ?? '').split('\n')) {
        const match = /^Device\s+(\S+)\s*(.*)$/.exec(line.trim());
        if (match) {
            devices.push({ mac: match[1], name: match[2].trim() || match[1] });
        }
    }
    return devices;
}

export interface PendingUpdates {
    count: number;
    /** One "name old -> new" line per package, capped for display. */
    lines: string[];
}

/**
 * `checkupdates`, one package per line:
 *
 *     linux 6.12.1.arch1-1 -> 6.12.4.arch1-1
 *
 * It exits 2 with no output when there is nothing to do, so the caller has to
 * read the exit code; this only deals with the text.
 */
export function parsePendingUpdates(stdout: string, limit = 12): PendingUpdates {
    const lines = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    return {
        count: lines.length,
        lines: lines.length > limit
            ? [...lines.slice(0, limit), `…and ${lines.length - limit} more`]
            : lines,
    };
}

export type Rotation = 'normal' | 'left' | 'right' | 'inverted';

export interface DisplayMode {
    /** "1920x1080", the form xrandr --mode wants back. */
    size: string;
    width: number;
    height: number;
    /** Refresh rates offered for this size, best first as xrandr prints them. */
    rates: number[];
    /** The mode the output is running now. */
    current: boolean;
    /** The monitor's own preferred mode, which is usually the panel's native one. */
    preferred: boolean;
}

export interface DisplayOutput {
    name: string;
    connected: boolean;
    primary: boolean;
    rotation: Rotation;
    /** Position and size of the current mode, absent when the output is off. */
    geometry?: { width: number; height: number; x: number; y: number };
    currentMode?: string;
    currentRate?: number;
    modes: DisplayMode[];
}

const ROTATIONS: Rotation[] = ['left', 'right', 'inverted'];

/**
 * `xrandr --query`:
 *
 *     eDP-1 connected primary 1920x1080+0+0 (normal left inverted …) 344mm x 194mm
 *        1920x1080     60.02*+  59.97    59.93
 *        1680x1050     59.95
 *     HDMI-1 disconnected (normal left inverted right x axis y axis)
 *
 * Two things make this fiddly. The parenthesised list always contains the words
 * "left", "right" and "inverted" whether or not the output is rotated, so the
 * rotation has to be read from the text *before* the bracket. And the flags on a
 * refresh rate are positional: `*` marks the active mode and `+` the preferred
 * one, and they can appear together, apart, or with a space between the rate and
 * the plus.
 */
export function parseXrandrOutputs(text: string | undefined): DisplayOutput[] {
    const outputs: DisplayOutput[] = [];
    let current: DisplayOutput | undefined;

    for (const line of (text ?? '').split('\n')) {
        const header = /^(\S+)\s+(connected|disconnected)\b(.*?)(?:\(|$)/.exec(line);
        if (header) {
            const flags = header[3];
            const geometry = /(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/.exec(flags);
            current = {
                name: header[1],
                connected: header[2] === 'connected',
                primary: /\bprimary\b/.test(flags),
                rotation: ROTATIONS.find((r) => new RegExp(`\\b${r}\\b`).test(flags)) ?? 'normal',
                geometry: geometry
                    ? {
                        width: Number(geometry[1]),
                        height: Number(geometry[2]),
                        x: Number(geometry[3]),
                        y: Number(geometry[4]),
                    }
                    : undefined,
                modes: [],
            };
            outputs.push(current);
            continue;
        }

        // A mode line is indented; anything else at column 0 ends the output.
        const mode = /^\s+(\d+)x(\d+)i?\s+(.*\S)\s*$/.exec(line);
        if (!mode || !current) {
            continue;
        }

        const rates: number[] = [];
        let isCurrent = false;
        let isPreferred = false;
        for (const match of mode[3].matchAll(/([\d.]+)\s*([*+]*)/g)) {
            rates.push(Number(match[1]));
            if (match[2].includes('*')) {
                isCurrent = true;
            }
            if (match[2].includes('+')) {
                isPreferred = true;
            }
        }

        const size = `${mode[1]}x${mode[2]}`;
        current.modes.push({
            size,
            width: Number(mode[1]),
            height: Number(mode[2]),
            rates,
            current: isCurrent,
            preferred: isPreferred,
        });
        if (isCurrent) {
            current.currentMode = size;
            // The starred rate, not the first one: a mode can offer several.
            const starred = /([\d.]+)\s*\*/.exec(mode[3]);
            current.currentRate = starred ? Number(starred[1]) : rates[0];
        }
    }

    return outputs;
}

export type FirewallPolicy = 'allow' | 'deny' | 'reject';

export interface FirewallRule {
    number: number;
    to: string;
    action: string;
    from: string;
    /** ufw lists the IPv6 half of each rule separately, tagged "(v6)". */
    v6: boolean;
}

export interface FirewallStatus {
    active: boolean;
    logging?: string;
    incoming?: FirewallPolicy;
    outgoing?: FirewallPolicy;
    routed?: FirewallPolicy;
    rules: FirewallRule[];
}

const POLICIES: FirewallPolicy[] = ['allow', 'deny', 'reject'];

function policy(word: string | undefined): FirewallPolicy | undefined {
    return POLICIES.find((p) => p === word?.toLowerCase());
}

/**
 * `ufw status numbered verbose`:
 *
 *     Status: active
 *     Logging: on (low)
 *     Default: deny (incoming), allow (outgoing), disabled (routed)
 *
 *     To                         Action      From
 *     --                         ------      ----
 *     [ 1] 22/tcp                ALLOW IN    Anywhere
 *     [ 2] 22/tcp (v6)           ALLOW IN    Anywhere (v6)
 *
 * An inactive firewall prints "Status: inactive" and nothing else, so an empty
 * rule list there means "unknown", not "no rules" - the rules are still on disk.
 * The columns are separated by runs of spaces and every field can contain a
 * single space ("ALLOW IN", "Anywhere (v6)"), so they are split on two-or-more.
 */
export function parseUfwStatus(text: string | undefined): FirewallStatus {
    const status: FirewallStatus = { active: false, rules: [] };

    for (const raw of (text ?? '').split('\n')) {
        const line = raw.trimEnd();

        const state = /^Status:\s*(\w+)/i.exec(line);
        if (state) {
            status.active = state[1].toLowerCase() === 'active';
            continue;
        }

        const logging = /^Logging:\s*(.+)$/i.exec(line);
        if (logging) {
            status.logging = logging[1].trim();
            continue;
        }

        if (/^Default:/i.test(line)) {
            for (const match of line.matchAll(/(\w+)\s*\((incoming|outgoing|routed)\)/gi)) {
                const value = policy(match[1]);
                const where = match[2].toLowerCase();
                if (where === 'incoming') {
                    status.incoming = value;
                } else if (where === 'outgoing') {
                    status.outgoing = value;
                } else {
                    status.routed = value;
                }
            }
            continue;
        }

        const rule = /^\[\s*(\d+)\]\s+(.+?)\s{2,}(\S+(?:\s+(?:IN|OUT|FWD))?)\s{2,}(.+?)\s*$/.exec(line);
        if (rule) {
            const to = rule[2].trim();
            status.rules.push({
                number: Number(rule[1]),
                to,
                action: rule[3].replace(/\s+/g, ' ').trim(),
                from: rule[4].trim(),
                v6: /\(v6\)/.test(to),
            });
        }
    }

    return status;
}

export interface TrashInfo {
    /** Absolute path the file came from, percent-decoded. */
    path: string;
    /** Milliseconds since the epoch, or undefined when the date is missing or bad. */
    deletedAt?: number;
}

/**
 * A `.trashinfo` file, per the freedesktop trash spec:
 *
 *     [Trash Info]
 *     Path=/home/vscodeos/Documents/report%20final.txt
 *     DeletionDate=2026-08-07T12:34:56
 *
 * `Path` is percent-encoded and `DeletionDate` is local time with no offset,
 * which is what `new Date` assumes for a bare date-time. A file with no readable
 * Path is not restorable and the caller drops it.
 */
export function parseTrashInfo(text: string | undefined): TrashInfo | undefined {
    let path: string | undefined;
    let deletedAt: number | undefined;

    for (const raw of (text ?? '').split('\n')) {
        const line = raw.trim();
        const equals = line.indexOf('=');
        if (equals < 1) {
            continue;
        }
        const key = line.slice(0, equals).trim().toLowerCase();
        const value = line.slice(equals + 1).trim();

        if (key === 'path' && path === undefined) {
            try {
                path = decodeURIComponent(value);
            } catch {
                // A malformed escape is still a name; showing it beats hiding
                // the entry, and restoring it will simply fail loudly.
                path = value;
            }
        } else if (key === 'deletiondate' && deletedAt === undefined) {
            const parsed = Date.parse(value);
            deletedAt = Number.isNaN(parsed) ? undefined : parsed;
        }
    }

    return path ? { path, deletedAt } : undefined;
}
