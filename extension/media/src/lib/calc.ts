// Expression evaluation for the calculator.
//
// Shunting-yard to RPN, then a stack evaluation. Deliberately NOT eval() or
// new Function(): a webview that hands a text field to the JS engine is exactly
// what the page's CSP exists to prevent. In its own module so it can be tested
// without a DOM.

type Token = { kind: 'number'; value: number } | { kind: 'op' | 'fn' | 'paren'; value: string };

const PRECEDENCE: Record<string, number> = { '+': 1, '−': 1, '×': 2, '÷': 2, '%': 2, '^': 3 };
const FUNCTIONS: Record<string, (value: number) => number> = {
    sin: (v) => Math.sin(v),
    cos: (v) => Math.cos(v),
    tan: (v) => Math.tan(v),
    ln: (v) => Math.log(v),
    log: (v) => Math.log10(v),
    '√': (v) => Math.sqrt(v),
};

/**
 * Negation is a unary operator, and the only way to get it right is to make it
 * one. Rewriting "−x" as "0 − x" is the obvious shortcut and it is wrong the
 * moment the sign follows anything: "5 − −3" becomes "5 − 0 − 3" = 2 rather
 * than 8, and "2 × −3" becomes "2 × 0 − 3" = −3 rather than −6.
 *
 * It rides the operator stack as a function, which gives it the binding it
 * needs, and is kept out of FUNCTIONS so that "neg" is not typeable as text.
 */
const NEGATE = 'neg';

/** Everything `evaluate` returns that is not a number. */
const FAILURES = ['Error', 'Undefined', 'Overflow'];

/**
 * Whether a result is a failure rather than a value. Callers must not push a
 * failure into the history or carry it forward as the next expression, and
 * checking the message text at each call site is how that goes wrong.
 */
export function isError(result: string): boolean {
    return FAILURES.includes(result);
}

function applyFunction(name: string, value: number): number {
    return name === NEGATE ? -value : FUNCTIONS[name](value);
}

function tokenize(source: string): Token[] | undefined {
    // The keypad shows a typographic minus; the keyboard and clipboard produce
    // an ASCII hyphen. Normalising here is what lets a leading "-5" pick up the
    // unary-sign handling below instead of falling through as a bare operator.
    const input = source.replace(/-/g, '−');
    const tokens: Token[] = [];
    let i = 0;
    while (i < input.length) {
        const char = input[i];
        if (char === ' ') {
            i++;
        } else if (/[\d.]/.test(char)) {
            let number = '';
            while (i < input.length && /[\d.]/.test(input[i])) {
                number += input[i++];
            }
            const value = Number(number);
            if (!Number.isFinite(value)) {
                return undefined;
            }
            tokens.push({ kind: 'number', value });
        } else if (char === 'π') {
            tokens.push({ kind: 'number', value: Math.PI });
            i++;
        } else if (char === 'e') {
            tokens.push({ kind: 'number', value: Math.E });
            i++;
        } else if (char === '(' || char === ')') {
            tokens.push({ kind: 'paren', value: char });
            i++;
        } else if (char in PRECEDENCE) {
            // A minus in prefix position - at the start, after another operator,
            // or just inside a '(' - is a sign, not a subtraction.
            const previous = tokens[tokens.length - 1];
            const prefix = !previous
                || previous.kind === 'op'
                || previous.kind === 'fn'
                || (previous.kind === 'paren' && previous.value === '(');
            tokens.push(char === '−' && prefix
                ? { kind: 'fn', value: NEGATE }
                : { kind: 'op', value: char });
            i++;
        } else {
            const name = Object.keys(FUNCTIONS).find((fn) => input.startsWith(fn, i));
            if (!name) {
                return undefined;
            }
            tokens.push({ kind: 'fn', value: name });
            i += name.length;
        }
    }
    return tokens;
}

/** Shunting-yard to RPN, then a stack evaluation. No eval(), no Function(). */
export function evaluate(input: string): string {
    const tokens = tokenize(input);
    if (!tokens || tokens.length === 0) {
        return 'Error';
    }

    const output: Token[] = [];
    const operators: Token[] = [];

    for (const token of tokens) {
        if (token.kind === 'number') {
            output.push(token);
        } else if (token.kind === 'fn') {
            operators.push(token);
        } else if (token.kind === 'op') {
            while (operators.length) {
                const top = operators[operators.length - 1];
                const higher = top.kind === 'fn'
                    || (top.kind === 'op' && PRECEDENCE[top.value] >= PRECEDENCE[token.value] && token.value !== '^');
                if (top.kind === 'paren' || !higher) {
                    break;
                }
                output.push(operators.pop() as Token);
            }
            operators.push(token);
        } else if (token.value === '(') {
            operators.push(token);
        } else {
            let matched = false;
            while (operators.length) {
                const top = operators.pop() as Token;
                if (top.kind === 'paren' && top.value === '(') {
                    matched = true;
                    break;
                }
                output.push(top);
            }
            if (!matched) {
                return 'Error';
            }
            const top = operators[operators.length - 1];
            if (top?.kind === 'fn') {
                output.push(operators.pop() as Token);
            }
        }
    }
    while (operators.length) {
        const top = operators.pop() as Token;
        if (top.kind === 'paren') {
            return 'Error';
        }
        output.push(top);
    }

    const stack: number[] = [];
    for (const token of output) {
        if (token.kind === 'number') {
            stack.push(token.value);
        } else if (token.kind === 'fn') {
            const value = stack.pop();
            if (value === undefined) {
                return 'Error';
            }
            stack.push(applyFunction(token.value, value));
        } else {
            const right = stack.pop();
            const left = stack.pop();
            if (right === undefined || left === undefined) {
                return 'Error';
            }
            switch (token.value) {
                case '+': stack.push(left + right); break;
                case '−': stack.push(left - right); break;
                case '×': stack.push(left * right); break;
                case '÷': stack.push(right === 0 ? NaN : left / right); break;
                case '%': stack.push(right === 0 ? NaN : left % right); break;
                case '^': stack.push(left ** right); break;
                default: return 'Error';
            }
        }
    }

    const value = stack.pop();
    if (value === undefined || stack.length > 0) {
        return 'Error';
    }
    if (Number.isNaN(value)) {
        // Dividing by zero, or the root or log of a negative. Not "undefined",
        // which in an editor reads like a JavaScript value rather than a domain
        // error.
        return 'Undefined';
    }
    if (!Number.isFinite(value)) {
        return 'Overflow';
    }
    // Kill the float noise 0.1+0.2 produces without truncating real precision.
    return String(Number(value.toPrecision(12)));
}
