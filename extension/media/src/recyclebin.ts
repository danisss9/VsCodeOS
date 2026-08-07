// The Recycle Bin view in the activity bar.
//
// Narrow by design - it shares its container with the Task Manager - so each
// row is the name, where it came from, and when. Selection is multi-select the
// way the file explorer's is, because restoring twenty things one at a time is
// not a feature.

import { clear, formatBytes, h, onMessage, post, root } from './lib/dom';
import { icon } from './lib/icons';
import type { FileEntry } from '../../src/webview/protocol';

interface TrashMessage {
    type: 'trash';
    entries: (FileEntry & { originalPath?: string; deletedAt?: number })[];
}

let entries: TrashMessage['entries'] = [];
const selection = new Set<string>();

const list = h('div', { class: 'list' });
const emptyButton = h('button', {
    class: 'button',
    on: { click: () => post({ type: 'emptyTrash' }) },
}, h('span', { html: icon('trash', 15) }), 'Empty');

const restoreButton = h('button', {
    class: 'button primary',
    on: { click: () => post({ type: 'restoreFromTrash', paths: [...selection] }) },
}, 'Restore');

const deleteButton = h('button', {
    class: 'button',
    on: { click: () => post({ type: 'deleteFromTrash', paths: [...selection] }) },
}, 'Delete');

const actions = h('div', { class: 'bin-actions', hidden: true }, restoreButton, deleteButton);

clear(root()).append(h('div', { class: 'app bin' },
    h('div', { class: 'toolbar' },
        h('span', { html: icon('trash', 15) }),
        h('span', { class: 'bin-count' }, ''),
        h('span', { class: 'spacer' }),
        emptyButton,
    ),
    actions,
    h('div', { class: 'body' }, list),
));

const countLabel = document.querySelector('.bin-count') as HTMLElement;

onMessage<TrashMessage>((message) => {
    if (message.type !== 'trash') {
        return;
    }
    entries = message.entries;
    // Anything restored or deleted elsewhere should not stay selected here.
    for (const name of [...selection]) {
        if (!entries.some((entry) => entry.path === name)) {
            selection.delete(name);
        }
    }
    render();
});

post({ type: 'ready' });

function whenLabel(at: number | undefined): string {
    if (!at) {
        return 'unknown date';
    }
    const date = new Date(at);
    const days = Math.floor((Date.now() - at) / 86400000);
    if (days === 0) {
        return `today, ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
    }
    if (days === 1) {
        return 'yesterday';
    }
    return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function render(): void {
    countLabel.textContent = entries.length === 0
        ? 'Recycle Bin'
        : `${entries.length} item${entries.length === 1 ? '' : 's'}`;
    emptyButton.disabled = entries.length === 0;
    actions.hidden = selection.size === 0;
    restoreButton.textContent = `Restore ${selection.size}`;
    deleteButton.textContent = `Delete ${selection.size}`;

    clear(list);
    if (entries.length === 0) {
        list.append(h('div', { class: 'empty' }, 'The Recycle Bin is empty.'));
        return;
    }

    for (const entry of entries) {
        const selected = selection.has(entry.path);
        list.append(h('div', {
            class: `list-row${selected ? ' active' : ''}`,
            title: entry.originalPath ?? entry.name,
            tabIndex: 0,
            on: {
                click: (event: MouseEvent) => {
                    if (!event.ctrlKey && !event.metaKey) {
                        selection.clear();
                    }
                    if (selected) {
                        selection.delete(entry.path);
                    } else {
                        selection.add(entry.path);
                    }
                    render();
                },
                dblclick: () => post({ type: 'restoreFromTrash', paths: [entry.path] }),
            },
        },
        h('span', { html: icon(entry.isDirectory ? 'folder' : 'file', 16) }),
        h('span', { class: 'list-main' },
            h('div', { class: 'list-name' }, entry.name),
            h('div', { class: 'list-sub' },
                entry.originalPath
                    ? `${entry.originalPath} · ${whenLabel(entry.deletedAt)}`
                    : `Original location unknown · ${formatBytes(entry.size)}`),
        ),
        ));
    }
}
