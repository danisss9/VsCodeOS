// Updater.
//
// Four rows and a log. The log is the important half: `pacman -Syu` can take
// minutes and can fail in ways only its own output explains, so it is streamed
// verbatim rather than hidden behind a spinner.

import { clear, h, onMessage, post, root } from './lib/dom';
import { icon } from './lib/icons';
import type { HostMessage, UpdateItem, UpdateTarget } from '../../src/webview/protocol';

let items: UpdateItem[] = [];
let running: UpdateTarget | undefined;
let restartNeeded = false;

const rowsEl = h('div', { class: 'update-rows' });
const logEl = h('pre', { class: 'update-log', hidden: true });
const banner = h('div', { class: 'error-banner', hidden: true });

const checkButton = h('button', {
    class: 'button',
    on: { click: () => post({ type: 'checkUpdates' }) },
}, h('span', { html: icon('refresh', 15) }), 'Check again');

const allButton = h('button', {
    class: 'button primary',
    on: { click: () => post({ type: 'runUpdate', target: 'all' }) },
}, h('span', { html: icon('update', 15) }), 'Update everything');

clear(root()).append(h('div', { class: 'app' },
    h('div', { class: 'toolbar' },
        h('span', { html: icon('update', 16) }),
        h('span', {}, 'Updater'),
        h('span', { class: 'spacer' }),
        checkButton,
        allButton,
    ),
    banner,
    h('div', { class: 'body' }, rowsEl, logEl),
));

function statusLabel(item: UpdateItem): { text: string; className: string } {
    switch (item.status) {
        case 'checking': return { text: 'Checking…', className: 'update-badge' };
        case 'available': return { text: item.latest ? `${item.latest} available` : 'Update available', className: 'update-badge available' };
        case 'current': return { text: 'Up to date', className: 'update-badge current' };
        default: return { text: 'Unknown', className: 'update-badge' };
    }
}

function render(): void {
    clear(rowsEl);
    for (const item of items) {
        const status = statusLabel(item);
        rowsEl.append(h('div', { class: 'update-row' },
            h('span', { class: 'update-icon', html: icon(iconFor(item.id), 22) }),
            h('div', { class: 'update-main' },
                h('div', { class: 'update-title' }, item.title),
                h('div', { class: 'list-sub' }, item.description),
                item.current ? h('div', { class: 'list-sub' }, `Installed: ${item.current}`) : null,
                item.detail ? h('pre', { class: 'update-detail' }, item.detail) : null,
            ),
            h('div', { class: 'update-side' },
                h('span', { class: status.className }, status.text),
                item.target
                    ? h('button', {
                        class: `button${item.status === 'available' ? ' primary' : ''}`,
                        disabled: running !== undefined,
                        on: {
                            click: () => post({ type: 'runUpdate', target: item.target as UpdateTarget }),
                        },
                    }, running === item.target ? 'Updating…' : item.status === 'available' ? 'Update' : 'Run anyway')
                    : null,
            ),
        ));
    }

    checkButton.disabled = running !== undefined;
    allButton.disabled = running !== undefined;

    if (restartNeeded) {
        rowsEl.append(h('div', { class: 'update-restart' },
            h('div', { class: 'update-title' }, 'A restart is needed to finish'),
            h('div', { class: 'list-sub' },
                'The editor is still running the files that were just replaced.'),
            h('div', { style: { display: 'flex', gap: '8px', marginTop: '10px' } },
                h('button', {
                    class: 'button primary',
                    on: { click: () => post({ type: 'restart', mode: 'editor' }) },
                }, 'Restart the editor'),
                h('button', {
                    class: 'button',
                    on: { click: () => post({ type: 'restart', mode: 'reboot' }) },
                }, 'Restart the computer'),
            ),
        ));
    }
}

function iconFor(id: UpdateItem['id']): string {
    switch (id) {
        case 'packages': return 'disk';
        case 'code': return 'editor';
        case 'shell': return 'grid';
        default: return 'cpu';
    }
}

function appendLog(chunk: string): void {
    logEl.hidden = false;
    logEl.append(document.createTextNode(chunk));
    // Only follow the tail when the user has not scrolled up to read something.
    const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
    if (atBottom) {
        logEl.scrollTop = logEl.scrollHeight;
    }
}

onMessage<HostMessage>((message) => {
    if (message.type === 'updateStatus') {
        items = message.items;
        running = message.running;
        render();
        return;
    }

    if (message.type === 'updateLog') {
        appendLog(message.chunk);
        return;
    }

    if (message.type === 'updateDone') {
        running = undefined;
        restartNeeded = message.needsRestart;
        if (!message.ok) {
            clear(banner).append(h('div', {}, message.message ?? 'The update failed. The log above has the details.'));
            banner.hidden = false;
        } else {
            banner.hidden = true;
            appendLog('\n✓ finished\n');
        }
        render();
    }
});

post({ type: 'ready' });
