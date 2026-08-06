// Calculator: standard and scientific, keyboard-driven.
//
// The expression is evaluated by a small shunting-yard parser rather than by
// handing a string to the JS engine - a webview that eval()s whatever is in a
// text field is exactly the thing a CSP is there to prevent.

import { clear, h, post, root, vscode } from './lib/dom';
import { icon } from './lib/icons';

interface Persisted {
    scientific: boolean;
    history: string[];
}

const saved = vscode.getState<Persisted>() ?? { scientific: false, history: [] };
let scientific = saved.scientific;
let history: string[] = saved.history;
let expression = '';
let result = '0';

const expressionEl = h('div', { class: 'calc-expression' });
const resultEl = h('div', { class: 'calc-result' }, '0');
const keysEl = h('div', { class: 'calc-keys' });
const historyEl = h('div', { class: 'calc-history' });

const modeButton = h('button', {
    class: 'button',
    on: {
        click: () => {
            scientific = !scientific;
            persist();
            renderKeys();
            modeButton.replaceChildren(scientific ? 'Standard' : 'Scientific');
        },
    },
}, scientific ? 'Standard' : 'Scientific');

clear(root()).append(h('div', { class: 'app' },
    h('div', { class: 'toolbar' },
        h('span', { html: icon('grid', 16) }),
        h('span', {}, 'Calculator'),
        h('span', { class: 'spacer' }),
        modeButton,
        h('button', {
            class: 'button',
            on: { click: () => { history = []; persist(); renderHistory(); } },
        }, 'Clear history'),
    ),
    h('div', { class: 'body' },
        h('div', { class: 'calc' },
            h('div', { class: 'calc-display' }, expressionEl, resultEl),
            keysEl,
            historyEl,
        ),
    ),
));

const STANDARD: [string, string?][] = [
    ['C'], ['⌫'], ['%'], ['÷'],
    ['7'], ['8'], ['9'], ['×'],
    ['4'], ['5'], ['6'], ['−'],
    ['1'], ['2'], ['3'], ['+'],
    ['±'], ['0'], ['.'], ['='],
];

const SCIENTIFIC: [string, string?][] = [
    ['C'], ['⌫'], ['('], [')'], ['÷'],
    ['sin'], ['cos'], ['tan'], ['^'], ['×'],
    ['ln'], ['log'], ['√'], ['%'], ['−'],
    ['7'], ['8'], ['9'], ['π'], ['+'],
    ['4'], ['5'], ['6'], ['e'], ['='],
    ['1'], ['2'], ['3'], ['0'], ['.'],
];

function renderKeys(): void {
    keysEl.className = `calc-keys${scientific ? ' scientific' : ''}`;
    clear(keysEl);
    for (const [label] of scientific ? SCIENTIFIC : STANDARD) {
        const isOperator = ['÷', '×', '−', '+', '%', '^', '(', ')'].includes(label);
        const isFunction = ['sin', 'cos', 'tan', 'ln', 'log', '√', 'π', 'e'].includes(label);
        keysEl.append(h('button', {
            class: `key${label === '=' ? ' equals' : isOperator || isFunction ? ' op' : ''}`,
            on: { click: () => press(label) },
        }, label));
    }
}

function renderHistory(): void {
    clear(historyEl);
    for (const entry of history.slice(-12).reverse()) {
        historyEl.append(h('div', {}, entry));
    }
}

function persist(): void {
    vscode.setState<Persisted>({ scientific, history });
}

function press(key: string): void {
    switch (key) {
        case 'C':
            expression = '';
            result = '0';
            break;
        case '⌫':
            expression = expression.slice(0, -1);
            break;
        case '=': {
            if (!expression) {
                break;
            }
            const value = evaluate(expression);
            result = value;
            if (!value.startsWith('Error')) {
                history = [...history, `${expression} = ${value}`].slice(-50);
                persist();
                renderHistory();
                expression = value;
            }
            break;
        }
        case '±':
            expression = expression.startsWith('-') ? expression.slice(1) : `-${expression}`;
            break;
        case 'π':
            expression += 'π';
            break;
        case 'e':
            expression += 'e';
            break;
        case 'sin': case 'cos': case 'tan': case 'ln': case 'log': case '√':
            expression += `${key}(`;
            break;
        default:
            expression += key;
    }

    if (key !== '=' && expression) {
        const preview = evaluate(expression);
        result = preview.startsWith('Error') ? result : preview;
    }
    draw();
}

function draw(): void {
    expressionEl.textContent = expression || ' ';
    resultEl.textContent = result;
}

// --------------------------------------------------------------- evaluation

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

function tokenize(input: string): Token[] | undefined {
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
            // A leading minus, or one straight after another operator, is a sign.
            const previous = tokens[tokens.length - 1];
            if (char === '−' && (!previous || previous.kind === 'op' || (previous.kind === 'paren' && previous.value === '('))) {
                tokens.push({ kind: 'number', value: 0 });
            }
            tokens.push({ kind: 'op', value: char });
            i++;
        } else if (char === '-') {
            tokens.push({ kind: 'op', value: '−' });
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
function evaluate(input: string): string {
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
            stack.push(FUNCTIONS[token.value](value));
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
    if (value === undefined || stack.length > 0 || !Number.isFinite(value)) {
        return value !== undefined && !Number.isFinite(value) ? 'Error: undefined' : 'Error';
    }
    // Kill the float noise 0.1+0.2 produces without truncating real precision.
    return String(Number(value.toPrecision(12)));
}

// ----------------------------------------------------------------- keyboard

const KEY_MAP: Record<string, string> = {
    '/': '÷', '*': '×', '-': '−', '+': '+', '%': '%', '^': '^',
    Enter: '=', '=': '=', Backspace: '⌫', Escape: 'C', Delete: 'C',
    '(': '(', ')': ')', '.': '.',
};

document.addEventListener('keydown', (event) => {
    if (/^\d$/.test(event.key)) {
        press(event.key);
    } else if (event.key in KEY_MAP) {
        press(KEY_MAP[event.key]);
    } else {
        return;
    }
    event.preventDefault();
});

renderKeys();
renderHistory();
draw();
post({ type: 'ready' });
