// Screenshot tool: capture full screen, focused window or a dragged region.
//
// The capture itself is scrot, run by the extension host - nothing inside a
// webview can read the screen.

import { clear, h, onMessage, post, root } from './lib/dom';
import { icon } from './lib/icons';
import type { HostMessage } from '../../src/webview/protocol';

let currentPath: string | undefined;
let delay = 0;

const preview = h('div', { class: 'shot-preview' },
    h('div', { class: 'empty' }, 'Take a screenshot to see it here.'));
const status = h('div', { class: 'status' });
const banner = h('div', { class: 'error-banner', hidden: true });

const saveButton = h('button', {
    class: 'button',
    disabled: true,
    on: { click: () => currentPath && post({ type: 'saveShot', path: currentPath }) },
}, h('span', { html: icon('save', 15) }), 'Save a copy');

const openButton = h('button', {
    class: 'button',
    disabled: true,
    on: { click: () => currentPath && post({ type: 'openExternal', path: currentPath }) },
}, h('span', { html: icon('open', 15) }), 'Open');

clear(root()).append(h('div', { class: 'app' },
    h('div', { class: 'toolbar' },
        capture('screen', 'camera', 'Whole screen'),
        capture('window', 'editor', 'Focused window'),
        capture('region', 'grid', 'Select a region'),
        h('div', { class: 'field' },
            h('label', {}, 'Delay'),
            h('select', {
                on: { change: (event: Event) => (delay = Number((event.target as HTMLSelectElement).value)) },
            },
            h('option', { value: 0 }, 'None'),
            h('option', { value: 3 }, '3 s'),
            h('option', { value: 5 }, '5 s'),
            h('option', { value: 10 }, '10 s'),
            ),
        ),
        h('span', { class: 'spacer' }),
        saveButton,
        openButton,
    ),
    banner,
    h('div', { class: 'body' }, preview),
    status,
));

function capture(mode: 'screen' | 'window' | 'region', glyph: string, label: string): HTMLElement {
    return h('button', {
        class: `button${mode === 'screen' ? ' primary' : ''}`,
        on: {
            click: () => {
                banner.hidden = true;
                clear(status).append(h('span', {}, 'Capturing…'));
                post({ type: 'capture', mode, delay });
            },
        },
    }, h('span', { html: icon(glyph, 15) }), label);
}

onMessage<HostMessage>((message) => {
    if (message.type === 'shot') {
        currentPath = message.path;
        saveButton.disabled = false;
        openButton.disabled = false;
        banner.hidden = true;
        clear(preview).append(h('img', { src: message.uri, alt: 'Screenshot' }));
        clear(status).append(h('span', {}, `Saved to ${message.path}`));
    } else if (message.type === 'shotError') {
        banner.hidden = false;
        clear(banner).append(h('span', { html: icon('warning', 16) }), ` ${message.message}`);
        clear(status).append(h('span', {}, 'Ready'));
    }
});

clear(status).append(h('span', {}, 'Ready'));
post({ type: 'ready' });
