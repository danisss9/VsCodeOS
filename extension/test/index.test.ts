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
import {
    archiveBaseName,
    archiveKind,
    entriesInDirectory,
    isMultiFileArchive,
    parseArchiveListing,
    parseUnzipListing,
} from '../src/util/archive';
import { mediaFilterExtensions, mediaKind } from '../src/util/media';
import { notificationText, parseActions, stripNotificationMarkup, urgencyOf } from '../src/util/notify';
import {
    parseBluetoothDevices,
    parsePendingUpdates,
    parseTrashInfo,
    parseUfwStatus,
    parseXrandrOutputs,
} from '../src/util/parse';
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

describe('archive classification', () => {
    const cases: [string, string | undefined][] = [
        ['photos.zip', 'zip'],
        ['backup.tar', 'tar'],
        // The whole point: the last dot is the wrong place to split.
        ['photos.tar.gz', 'tar.gz'],
        ['photos.tar.xz', 'tar.xz'],
        ['photos.tar.bz2', 'tar.bz2'],
        ['photos.tar.zst', 'tar.zst'],
        ['photos.tgz', 'tar.gz'],
        ['notes.txt.gz', 'gz'],
        ['app.jar', 'zip'],
        ['thing.7z', '7z'],
        ['ARCHIVE.ZIP', 'zip'],
        ['/home/vscodeos/Downloads/linux-6.12.tar.xz', 'tar.xz'],
        ['report.txt', undefined],
        ['noextension', undefined],
        // A leading dot is a hidden file, not an extension.
        ['.gz', undefined],
        ['.bashrc', undefined],
    ];
    for (const [name, expected] of cases) {
        it(`${name} -> ${expected ?? 'not an archive'}`, () => {
            assert.equal(archiveKind(name), expected);
        });
    }

    it('knows which formats hold more than one file', () => {
        assert.equal(isMultiFileArchive('zip'), true);
        assert.equal(isMultiFileArchive('tar.gz'), true);
        assert.equal(isMultiFileArchive('gz'), false);
        assert.equal(isMultiFileArchive('xz'), false);
    });

    it('strips the whole suffix when naming a destination', () => {
        assert.equal(archiveBaseName('photos.tar.gz'), 'photos');
        assert.equal(archiveBaseName('notes.txt.gz'), 'notes.txt');
        assert.equal(archiveBaseName('/tmp/a/b.zip'), 'b');
        assert.equal(archiveBaseName('plain'), 'plain');
    });
});

describe('archive listings', () => {
    // Captured from GNU tar, which packs owner and group into one column.
    const gnuTar = [
        'drwxr-xr-x root/root         0 2026-08-07 19:51 ./',
        'drwxr-xr-x root/root         0 2026-08-07 19:51 ./dir with space/',
        '-rw-r--r-- root/root         2 2026-08-07 19:51 ./dir with space/c d.txt',
        'drwxr-xr-x root/root         0 2026-08-07 19:51 ./sub/',
        '-rw-r--r-- root/root         6 2026-08-07 19:51 ./sub/b.txt',
        '-rw-r--r-- root/root         6 2026-08-07 19:51 ./a.txt',
    ].join('\n');

    // bsdtar, which is what both images actually have: ls-style columns, a
    // month-and-day date, and a year instead of a time for anything old.
    const bsdTar = [
        'drwxr-xr-x  0 dan    dan         0 Aug  7 19:51 sub/',
        '-rw-r--r--  0 dan    dan         6 Aug  7 19:51 sub/b.txt',
        '-rw-r--r--  0 dan    dan       142 Jan 14  2024 old notes.txt',
        '-rw-r--r--  0 dan    dan         6 Aug  7 19:51 a.txt',
    ].join('\n');

    it('reads GNU tar rows, stripping the leading ./', () => {
        const entries = parseArchiveListing(gnuTar);
        assert.deepEqual(entries.map((e) => e.path), [
            'dir with space', 'dir with space/c d.txt', 'sub', 'sub/b.txt', 'a.txt',
        ]);
    });

    it('reads bsdtar rows, including a year in place of a time', () => {
        const entries = parseArchiveListing(bsdTar);
        assert.deepEqual(entries.map((e) => e.path), ['sub', 'sub/b.txt', 'old notes.txt', 'a.txt']);
        assert.equal(entries[2].size, 142);
    });

    it('keeps names containing spaces intact', () => {
        const entries = parseArchiveListing(gnuTar);
        const entry = entries.find((e) => e.path.endsWith('c d.txt'));
        assert.equal(entry?.path, 'dir with space/c d.txt');
        assert.equal(entry?.size, 2);
    });

    it('marks directories from the permission bit and the trailing slash alike', () => {
        const entries = parseArchiveListing(gnuTar);
        assert.equal(entries.find((e) => e.path === 'sub')?.isDirectory, true);
        assert.equal(entries.find((e) => e.path === 'sub/b.txt')?.isDirectory, false);
    });

    it('drops entries that would escape the extraction directory', () => {
        const hostile = [
            '-rw-r--r-- root/root        1 2026-08-07 19:51 ../../etc/passwd',
            '-rw-r--r-- root/root        1 2026-08-07 19:51 /etc/shadow',
            '-rw-r--r-- root/root        1 2026-08-07 19:51 ok.txt',
        ].join('\n');
        assert.deepEqual(parseArchiveListing(hostile).map((e) => e.path), ['ok.txt']);
    });

    it('ignores headers, summaries and empty output', () => {
        assert.deepEqual(parseArchiveListing('Archive: t.zip\ntotal 4'), []);
        assert.deepEqual(parseArchiveListing(undefined), []);
        assert.deepEqual(parseArchiveListing(''), []);
    });

    it('reads unzip -l, headers and footers and all', () => {
        // Captured from unzip -l.
        const listing = [
            'Archive:  t.zip',
            '  Length      Date    Time    Name',
            '---------  ---------- -----   ----',
            '        0  2026-08-07 19:51   dir with space/',
            '        2  2026-08-07 19:51   dir with space/c d.txt',
            '        6  2026-08-07 19:51   a.txt',
            '---------                     -------',
            '       14                     5 files',
        ].join('\n');
        const entries = parseUnzipListing(listing);
        assert.deepEqual(entries.map((e) => e.path), ['dir with space', 'dir with space/c d.txt', 'a.txt']);
        assert.equal(entries[0].isDirectory, true);
        assert.equal(entries[2].size, 6);
    });

    it('folds a flat listing down to one directory level', () => {
        const entries = parseArchiveListing(gnuTar);
        assert.deepEqual(entriesInDirectory(entries, '').map((e) => e.path), ['dir with space', 'sub', 'a.txt']);
        assert.deepEqual(entriesInDirectory(entries, 'sub').map((e) => e.path), ['sub/b.txt']);
    });

    it('invents directories the archive never stored', () => {
        // A zip built from a file list has no entry for "docs" at all.
        const sparse = parseArchiveListing([
            '-rw-r--r-- root/root        1 2026-08-07 19:51 docs/deep/a.txt',
            '-rw-r--r-- root/root        1 2026-08-07 19:51 docs/b.txt',
        ].join('\n'));
        const top = entriesInDirectory(sparse, '');
        assert.deepEqual(top.map((e) => e.path), ['docs']);
        assert.equal(top[0].isDirectory, true);
        assert.deepEqual(entriesInDirectory(sparse, 'docs').map((e) => e.path), ['docs/deep', 'docs/b.txt']);
    });
});

describe('notification payloads', () => {
    it('strips the markup subset the spec allows in a body', () => {
        assert.equal(stripNotificationMarkup('<b>Build</b> finished'), 'Build finished');
        assert.equal(stripNotificationMarkup('see <a href="http://x/">the log</a>'), 'see the log');
        assert.equal(stripNotificationMarkup('one<br/>two'), 'one\ntwo');
        assert.equal(stripNotificationMarkup('<img src="x" alt="y"/>done'), 'done');
    });

    it('unescapes entities so an ampersand is an ampersand', () => {
        assert.equal(stripNotificationMarkup('rock &amp; roll'), 'rock & roll');
        assert.equal(stripNotificationMarkup('&lt;not a tag&gt;'), '<not a tag>');
        assert.equal(stripNotificationMarkup('&#65;&#66;'), 'AB');
        // Something unrecognised is left exactly as it came.
        assert.equal(stripNotificationMarkup('&zzz;'), '&zzz;');
    });

    it('pairs the flat action array into keys and labels', () => {
        assert.deepEqual(parseActions(['reply', 'Reply', 'archive', 'Archive']), [
            { key: 'reply', label: 'Reply' },
            { key: 'archive', label: 'Archive' },
        ]);
    });

    it('drops the default action, which is a click target and not a button', () => {
        assert.deepEqual(parseActions(['default', 'Open', 'reply', 'Reply']), [
            { key: 'reply', label: 'Reply' },
        ]);
    });

    it('survives a malformed action list', () => {
        assert.deepEqual(parseActions([]), []);
        assert.deepEqual(parseActions(['orphan']), []);
        assert.deepEqual(parseActions(['a', '', 'b', 'B']), [{ key: 'b', label: 'B' }]);
    });

    it('reads urgency, defaulting anything odd to normal', () => {
        assert.equal(urgencyOf({ urgency: 0 }), 'low');
        assert.equal(urgencyOf({ urgency: 1 }), 'normal');
        assert.equal(urgencyOf({ urgency: 2 }), 'critical');
        assert.equal(urgencyOf({}), 'normal');
        assert.equal(urgencyOf(undefined), 'normal');
        assert.equal(urgencyOf({ urgency: 'loud' }), 'normal');
    });

    it('unwraps the variant the hints dictionary actually delivers', () => {
        // a{sv} means every hint arrives as a Variant, not a bare number.
        assert.equal(urgencyOf({ urgency: { signature: 'y', value: 2 } }), 'critical');
        assert.equal(urgencyOf({ urgency: { signature: 'y', value: 0 } }), 'low');
    });

    it('joins summary and body into one line', () => {
        assert.equal(notificationText('Backup', 'finished in 3s'), 'Backup — finished in 3s');
        assert.equal(notificationText('Backup', ''), 'Backup');
        assert.equal(notificationText('', 'orphan body'), 'orphan body');
        assert.equal(notificationText('', ''), 'Notification');
        assert.equal(notificationText('Sync', 'line one\nline two'), 'Sync — line one line two');
    });
});

describe('xrandr output', () => {
    const query = [
        'Screen 0: minimum 320 x 200, current 4480 x 1440, maximum 16384 x 16384',
        'eDP-1 connected primary 1920x1080+0+0 (normal left inverted right x axis y axis) 344mm x 194mm',
        '   1920x1080     60.02*+  59.97    59.93  ',
        '   1680x1050     59.95    59.88  ',
        'DP-1 connected 2560x1440+1920+0 left (normal left inverted right x axis y axis) 597mm x 336mm',
        '   2560x1440     59.95*+',
        'HDMI-1 disconnected (normal left inverted right x axis y axis)',
    ].join('\n');

    it('finds every output and its connection state', () => {
        const outputs = parseXrandrOutputs(query);
        assert.deepEqual(outputs.map((o) => o.name), ['eDP-1', 'DP-1', 'HDMI-1']);
        assert.deepEqual(outputs.map((o) => o.connected), [true, true, false]);
    });

    it('marks the primary output and only that one', () => {
        const outputs = parseXrandrOutputs(query);
        assert.deepEqual(outputs.map((o) => o.primary), [true, false, false]);
    });

    it('reads rotation from before the bracket, not from inside it', () => {
        // The parenthesised list names every rotation on every line, so a naive
        // search finds "left" on an output that is not rotated at all.
        const outputs = parseXrandrOutputs(query);
        assert.equal(outputs[0].rotation, 'normal');
        assert.equal(outputs[1].rotation, 'left');
        assert.equal(outputs[2].rotation, 'normal');
    });

    it('reads geometry and the active mode', () => {
        const [edp, dp] = parseXrandrOutputs(query);
        assert.deepEqual(edp.geometry, { width: 1920, height: 1080, x: 0, y: 0 });
        assert.deepEqual(dp.geometry, { width: 2560, height: 1440, x: 1920, y: 0 });
        assert.equal(edp.currentMode, '1920x1080');
        assert.equal(edp.currentRate, 60.02);
    });

    it('collects every mode with its rates and flags', () => {
        const [edp] = parseXrandrOutputs(query);
        assert.equal(edp.modes.length, 2);
        assert.deepEqual(edp.modes[0], {
            size: '1920x1080',
            width: 1920,
            height: 1080,
            rates: [60.02, 59.97, 59.93],
            current: true,
            preferred: true,
        });
        assert.equal(edp.modes[1].current, false);
        assert.equal(edp.modes[1].preferred, false);
    });

    it('leaves a disconnected output with no modes and no geometry', () => {
        const hdmi = parseXrandrOutputs(query)[2];
        assert.deepEqual(hdmi.modes, []);
        assert.equal(hdmi.geometry, undefined);
    });

    it('returns nothing when xrandr could not run', () => {
        assert.deepEqual(parseXrandrOutputs(undefined), []);
        assert.deepEqual(parseXrandrOutputs(''), []);
    });
});

describe('ufw status', () => {
    const verbose = [
        'Status: active',
        'Logging: on (low)',
        'Default: deny (incoming), allow (outgoing), disabled (routed)',
        'New profiles: skip',
        '',
        'To                         Action      From',
        '--                         ------      ----',
        '[ 1] 22/tcp                     ALLOW IN    Anywhere',
        '[ 2] 80,443/tcp                 ALLOW IN    Anywhere',
        '[ 3] 22/tcp (v6)                ALLOW IN    Anywhere (v6)',
        '[ 4] 3306/tcp                   DENY IN     192.168.1.0/24',
    ].join('\n');

    it('reads the state and the default policies', () => {
        const status = parseUfwStatus(verbose);
        assert.equal(status.active, true);
        assert.equal(status.logging, 'on (low)');
        assert.equal(status.incoming, 'deny');
        assert.equal(status.outgoing, 'allow');
        // "disabled" is not a policy word, so routed stays unknown.
        assert.equal(status.routed, undefined);
    });

    it('splits the columns even though every field can contain a space', () => {
        const status = parseUfwStatus(verbose);
        assert.equal(status.rules.length, 4);
        assert.deepEqual(status.rules[0], {
            number: 1, to: '22/tcp', action: 'ALLOW IN', from: 'Anywhere', v6: false,
        });
        assert.deepEqual(status.rules[3], {
            number: 4, to: '3306/tcp', action: 'DENY IN', from: '192.168.1.0/24', v6: false,
        });
    });

    it('tags the IPv6 half of a rule', () => {
        const status = parseUfwStatus(verbose);
        assert.deepEqual(status.rules.map((r) => r.v6), [false, false, true, false]);
    });

    it('reports an inactive firewall with no rules', () => {
        const status = parseUfwStatus('Status: inactive\n');
        assert.equal(status.active, false);
        assert.deepEqual(status.rules, []);
    });

    it('survives no output at all', () => {
        assert.deepEqual(parseUfwStatus(undefined), { active: false, rules: [] });
    });
});

describe('trashinfo files', () => {
    it('decodes the original path', () => {
        const info = parseTrashInfo([
            '[Trash Info]',
            'Path=/home/vscodeos/Documents/report%20final%20(2).txt',
            'DeletionDate=2026-08-07T12:34:56',
        ].join('\n'));
        assert.equal(info?.path, '/home/vscodeos/Documents/report final (2).txt');
        assert.equal(new Date(info?.deletedAt ?? 0).getFullYear(), 2026);
    });

    it('tolerates CRLF and odd spacing', () => {
        const info = parseTrashInfo('[Trash Info]\r\nPath = /tmp/a.txt \r\nDeletionDate =2026-01-02T03:04:05\r\n');
        assert.equal(info?.path, '/tmp/a.txt');
        assert.ok(info?.deletedAt);
    });

    it('keeps the entry when the date is missing or unparseable', () => {
        assert.deepEqual(parseTrashInfo('Path=/tmp/a.txt'), { path: '/tmp/a.txt', deletedAt: undefined });
        assert.equal(parseTrashInfo('Path=/tmp/a.txt\nDeletionDate=never')?.deletedAt, undefined);
    });

    it('gives up on an entry with no path, which cannot be restored', () => {
        assert.equal(parseTrashInfo('[Trash Info]\nDeletionDate=2026-08-07T12:34:56'), undefined);
        assert.equal(parseTrashInfo(''), undefined);
        assert.equal(parseTrashInfo(undefined), undefined);
    });

    it('keeps a malformed escape rather than dropping the file', () => {
        assert.equal(parseTrashInfo('Path=/tmp/100%.txt')?.path, '/tmp/100%.txt');
    });
});
