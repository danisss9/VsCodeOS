// Calculator: standard and scientific, keyboard-driven.
//
// The expression is evaluated by a small shunting-yard parser rather than by
// handing a string to the JS engine - a webview that eval()s whatever is in a
// text field is exactly the thing a CSP is there to prevent.

import { clear, h, post, root, vscode } from './lib/dom';
import { evaluate, isError } from './lib/calc';
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
            if (!isError(value)) {
                history = [...history, `${expression} = ${value}`].slice(-50);
                persist();
                renderHistory();
                expression = value;
            }
            break;
        }
        case '±':
            // The typographic minus, so the display matches the keypad's '−'.
            expression = expression.startsWith('−') ? expression.slice(1) : `−${expression}`;
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
        result = isError(preview) ? result : preview;
    }
    draw();
}

function draw(): void {
    expressionEl.textContent = expression || ' ';
    resultEl.textContent = result;
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
