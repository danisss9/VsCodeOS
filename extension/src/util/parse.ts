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
