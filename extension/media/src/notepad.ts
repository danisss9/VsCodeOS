// Notepad: a plain-text scratchpad that saves to a real file.
//
// Deliberately not a second editor - anything that wants syntax highlighting or
// a diff belongs in VS Code proper, and "Open in editor" is one click away.

import { clear, h, onMessage, post, root } from './lib/dom';
import { icon } from './lib/icons';
import type { HostMessage } from '../../src/webview/protocol';

let path: string | undefined;
let dirty = false;

const textarea = h('textarea', {
    id: 'notepad-text',
    placeholder: 'Start typing…',
    on: {
        input: () => {
            dirty = true;
            renderStatus();
        },
    },
});

const status = h('div', { class: 'status' });

clear(root()).append(h('div', { class: 'app' },
    h('div', { class: 'toolbar' },
        button('New', 'file', () => {
            if (!dirty || confirm('Discard unsaved changes?')) {
                post({ type: 'newNote' });
            }
        }),
        button('Open', 'open', () => post({ type: 'openNote' })),
        button('Save', 'save', () => post({ type: 'saveNote', text: textarea.value, path }), true),
        button('Save as', 'save', () => post({ type: 'saveNote', text: textarea.value, path, saveAs: true })),
        h('span', { class: 'spacer' }),
        button('Open in editor', 'editor', () => post({ type: 'noteToEditor', text: textarea.value })),
    ),
    h('div', { class: 'body', style: { display: 'flex' } }, textarea),
    status,
));

function button(label: string, glyph: string, onClick: () => void, primary = false): HTMLElement {
    return h('button', { class: `button${primary ? ' primary' : ''}`, on: { click: onClick } },
        h('span', { html: icon(glyph, 15) }), label);
}

onMessage<HostMessage>((message) => {
    if (message.type !== 'note') {
        return;
    }
    path = message.path;
    textarea.value = message.text;
    dirty = message.dirty;
    renderStatus();
});

function renderStatus(): void {
    const text = textarea.value;
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    clear(status).append(
        h('span', {}, path ? `${path}${dirty ? ' •' : ''}` : dirty ? 'Unsaved note •' : 'Unsaved note'),
        h('span', {}, `${text.length} characters`),
        h('span', {}, `${words} words`),
        h('span', {}, `${text ? text.split('\n').length : 0} lines`),
    );
}

document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 's') {
        event.preventDefault();
        post({ type: 'saveNote', text: textarea.value, path, saveAs: event.shiftKey });
    } else if ((event.ctrlKey || event.metaKey) && event.key === 'o') {
        event.preventDefault();
        post({ type: 'openNote' });
    }
});

renderStatus();
post({ type: 'ready' });
