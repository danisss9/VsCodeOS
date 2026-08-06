// Tests for the pure logic - the parts where a subtle mistake is invisible
// until someone hits it.
//
// Everything else in this extension talks to /proc, nmcli or the VS Code API and
// is verified by running the thing; these two modules are self-contained, so
// they get real coverage. node:test, so there is no test framework to install.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { evaluate, isError } from '../media/src/lib/calc';
import { expandHome, formatBytes, formatDate, formatDuration, formatElapsed, formatTime } from '../src/util/format';

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
