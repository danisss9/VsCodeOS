// Tests for the pure logic - the parts where a subtle mistake is invisible
// until someone hits it.
//
// Everything else in this extension talks to /proc, nmcli or the VS Code API and
// is verified by running the thing; these modules are self-contained, so they
// get real coverage. node:test, so there is no test framework to install.
//
// Note what is *not* imported here: anything under src/sys or src/apps, which
// all import `vscode` and cannot be bundled outside the extension host. The
// parsers and classifiers those modules depend on live in src/util for exactly
// that reason.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { evaluate, isError } from '../media/src/lib/calc';
import { expandHome, formatBytes, formatDate, formatDuration, formatElapsed, formatTime } from '../src/util/format';
import { mediaFilterExtensions, mediaKind } from '../src/util/media';
import { parseBluetoothDevices, parsePendingUpdates } from '../src/util/parse';
import { codeUpdateUrl, normaliseAddress } from '../src/util/url';

describe('calculator', () => {
    const cases: [string, string][] = [
        ['1+2', '3'],
        ['2×3+4', '10'],
        ['4+2×3', '10'],
        ['(4+2)×3', '18'],
        ['10÷4', '2.5'],
        // Float noise is trimmed without truncating real precision.
        ['0.1+0.2', '0.3'],
        // Exponentiation is right-associative: 2^(3^2), not (2^3)^2.
        ['2^3^2', '512'],
        ['5%3', '2'],
        ['√(16)', '4'],
        ['ln(e)', '1'],
        ['log(1000)', '3'],
        ['sin(0)', '0'],
        ['π', '3.14159265359'],
        ['2×π', '6.28318530718'],
    ];
    for (const [input, expected] of cases) {
        it(`evaluates ${input}`, () => assert.equal(evaluate(input), expected));
    }

    // Negation is a unary operator, not "0 −  x". Rewriting it as a subtraction
    // is right at the start of an expression and wrong everywhere else, which is
    // exactly the sort of bug that ships.
    const signs: [string, string][] = [
        ['−5+3', '-2'],
        ['-5+3', '-2'],      // the keyboard and clipboard produce ASCII hyphens
        ['−12', '-12'],
        ['−−5', '5'],
        ['5−−3', '8'],
        ['5−-3', '8'],
        ['2×−3', '-6'],
        ['2×-3', '-6'],
        ['3+−−2', '5'],
        ['10÷−2', '-5'],
        ['−(2+3)', '-5'],
        ['3×(−2)', '-6'],
        ['(−2)^2', '4'],
        ['sin(−0)', '0'],
    ];
    for (const [input, expected] of signs) {
        it(`handles the sign in ${input}`, () => assert.equal(evaluate(input), expected));
    }

    const failures: [string, string][] = [
        ['1÷0', 'Undefined'],
        ['5%0', 'Undefined'],
        ['√(-4)', 'Undefined'],
        ['9^9999', 'Overflow'],
        ['ln(0)', 'Overflow'],
        ['(1+2', 'Error'],
        ['1+2)', 'Error'],
        ['1++2', 'Error'],
        ['', 'Error'],
        ['abc', 'Error'],
        // 'neg' is the internal name for negation and must not be typeable.
        ['neg(2)', 'Error'],
    ];
    for (const [input, expected] of failures) {
        it(`rejects ${input || '(empty)'}`, () => {
            const result = evaluate(input);
            assert.equal(result, expected);
            assert.ok(isError(result), `${result} should be reported as a failure`);
        });
    }

    it('does not report a value as a failure', () => {
        assert.equal(isError('3'), false);
        assert.equal(isError('-2'), false);
        assert.equal(isError('0'), false);
    });
});

describe('formatters', () => {
    const when = new Date(2026, 7, 6, 14, 54, 7);

    it('formats the clock', () => {
        assert.equal(formatTime(when, 'HH:mm'), '14:54');
        assert.equal(formatTime(when, 'HH:mm:ss'), '14:54:07');
        assert.equal(formatTime(when, 'h:mm a'), '2:54 pm');
        assert.equal(formatTime(when, 'h:mm A'), '2:54 PM');
        assert.equal(formatTime(when, ''), '14:54');
    });

    it('formats the date', () => {
        assert.equal(formatDate(when, 'dd/MM/yyyy'), '06/08/2026');
        assert.equal(formatDate(when, 'd/M/yy'), '6/8/26');
        assert.equal(formatDate(when, ''), '06/08/2026');
    });

    it('formats sizes', () => {
        assert.equal(formatBytes(0), '0 B');
        assert.equal(formatBytes(-1), '0 B');
        assert.equal(formatBytes(1023), '1023 B');
        assert.equal(formatBytes(1536), '1.5 KB');
        assert.equal(formatBytes(1048576), '1.0 MB');
        assert.equal(formatBytes(1048576 * 400), '400 MB');
    });

    it('formats durations', () => {
        assert.equal(formatDuration(0), '0:00');
        assert.equal(formatDuration(-5), '0:00');
        assert.equal(formatDuration(102), '1:42');
        assert.equal(formatDuration(3725), '1:02:05');
        assert.equal(formatElapsed(90061), '1d 1:01:01');
    });

    it('expands ~ against $HOME', () => {
        assert.equal(expandHome('~/Pictures', '/home/vscodeos'), '/home/vscodeos/Pictures');
        assert.equal(expandHome('~', '/home/vscodeos'), '/home/vscodeos');
        assert.equal(expandHome('/tmp/x', '/home/vscodeos'), '/tmp/x');
        // A leading ~ that is not a path separator is a real directory name.
        assert.equal(expandHome('~weird', '/home/vscodeos'), '~weird');
    });
});

describe('media classification', () => {
    it('recognises video and audio', () => {
        assert.equal(mediaKind('/home/vscodeos/Videos/holiday.mp4'), 'video');
        assert.equal(mediaKind('song.FLAC'), 'audio');
        assert.equal(mediaKind('/x/y/clip.WebM'), 'video');
    });

    it('leaves everything else to the editor', () => {
        assert.equal(mediaKind('notes.txt'), undefined);
        assert.equal(mediaKind('photo.png'), undefined);
        assert.equal(mediaKind('archive.tar.gz'), undefined);
        // No extension at all: a README or a script, which the editor opens.
        assert.equal(mediaKind('/usr/local/bin/vscodeos-kiosk'), undefined);
    });

    it('does not mistake a dotfile for an extension', () => {
        // ".mp4" as a whole file name is hidden, not a video called nothing.
        assert.equal(mediaKind('.mp4'), undefined);
        assert.equal(mediaKind('/home/vscodeos/.bashrc'), undefined);
    });

    it('does not read the directory as an extension', () => {
        // The dot is in the directory, not in the file name.
        assert.equal(mediaKind('/home/vscodeos/my.videos/README'), undefined);
    });

    it('offers dialog filters without the dot', () => {
        const filters = mediaFilterExtensions();
        assert.ok(filters.includes('mp4'));
        assert.ok(filters.includes('mp3'));
        assert.ok(filters.every((extension) => !extension.startsWith('.')));
    });
});

describe('address bar', () => {
    it('leaves real URLs alone', () => {
        assert.equal(normaliseAddress('https://example.com/a?b=c'), 'https://example.com/a?b=c');
        assert.equal(normaliseAddress('http://example.com'), 'http://example.com');
        assert.equal(normaliseAddress('about:blank'), 'about:blank');
        assert.equal(normaliseAddress('file:///etc/hosts'), 'file:///etc/hosts');
    });

    it('adds a scheme to a bare host', () => {
        assert.equal(normaliseAddress('example.com'), 'https://example.com');
        assert.equal(normaliseAddress('example.com/path'), 'https://example.com/path');
        assert.equal(normaliseAddress('sub.example.co.uk:8443/x'), 'https://sub.example.co.uk:8443/x');
    });

    it('keeps localhost on http, with or without a port', () => {
        // https://localhost is a dead end on a dev box: nothing serves a
        // certificate there.
        assert.equal(normaliseAddress('localhost:3000'), 'http://localhost:3000');
        assert.equal(normaliseAddress('localhost'), 'http://localhost');
    });

    it('searches for anything with a space in it', () => {
        assert.equal(normaliseAddress('npm install'), 'https://duckduckgo.com/?q=npm%20install');
        // A dotted phrase with spaces is still a search, not a host.
        assert.equal(normaliseAddress('what is node.js'), 'https://duckduckgo.com/?q=what%20is%20node.js');
        assert.equal(normaliseAddress('vscode'), 'https://duckduckgo.com/?q=vscode');
    });

    it('has somewhere to go when nothing was typed', () => {
        assert.equal(normaliseAddress(''), 'about:blank');
        assert.equal(normaliseAddress('   '), 'about:blank');
    });
});

describe('bluetoothctl output', () => {
    it('keeps spaces in device names', () => {
        const devices = parseBluetoothDevices([
            'Device AA:BB:CC:DD:EE:FF Sony WH-1000XM4',
            'Device 11:22:33:44:55:66 Keyboard',
        ].join('\n'));
        assert.deepEqual(devices, [
            { mac: 'AA:BB:CC:DD:EE:FF', name: 'Sony WH-1000XM4' },
            { mac: '11:22:33:44:55:66', name: 'Keyboard' },
        ]);
    });

    it('falls back to the address when a device never advertised a name', () => {
        assert.deepEqual(parseBluetoothDevices('Device AA:BB:CC:DD:EE:FF'), [
            { mac: 'AA:BB:CC:DD:EE:FF', name: 'AA:BB:CC:DD:EE:FF' },
        ]);
    });

    it('ignores anything that is not a device line', () => {
        assert.deepEqual(parseBluetoothDevices(undefined), []);
        assert.deepEqual(parseBluetoothDevices('No default controller available'), []);
        assert.deepEqual(parseBluetoothDevices(''), []);
    });
});

describe('checkupdates output', () => {
    it('counts pending updates', () => {
        const pending = parsePendingUpdates('linux 6.12.1-1 -> 6.12.4-1\nchromium 131.0-1 -> 132.0-1\n');
        assert.equal(pending.count, 2);
        assert.deepEqual(pending.lines, ['linux 6.12.1-1 -> 6.12.4-1', 'chromium 131.0-1 -> 132.0-1']);
    });

    it('reports nothing for empty output', () => {
        assert.equal(parsePendingUpdates('').count, 0);
        assert.equal(parsePendingUpdates('\n\n  \n').count, 0);
    });

    it('truncates a long list without losing the count', () => {
        const stdout = Array.from({ length: 30 }, (_, i) => `pkg${i} 1-1 -> 2-1`).join('\n');
        const pending = parsePendingUpdates(stdout, 12);
        assert.equal(pending.count, 30);
        assert.equal(pending.lines.length, 13);
        assert.equal(pending.lines[12], '…and 18 more');
    });
});

describe('VS Code update endpoint', () => {
    it('asks for the right build per architecture', () => {
        assert.match(codeUpdateUrl('x64'), /\/api\/update\/linux-x64\/stable\//);
        assert.match(codeUpdateUrl('arm64'), /\/api\/update\/linux-arm64\/stable\//);
        assert.match(codeUpdateUrl('arm'), /\/api\/update\/linux-armhf\/stable\//);
    });

    it('sends a commit that can never be the installed one', () => {
        // Sending the real commit would answer "you are up to date" and the
        // updater would never see a version to compare against.
        assert.ok(codeUpdateUrl('x64').endsWith(`/${'0'.repeat(40)}`));
    });
});
