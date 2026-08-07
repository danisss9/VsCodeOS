// Web browser front end.
//
// The page itself is an <img> that a headless Chromium repaints many times a
// second. Everything below it exists to make that image behave like a browser:
// the pointer and the keyboard are forwarded to the real page, and coordinates
// are scaled because the <img> is almost never the size of the viewport it is
// showing.

import { clear, h, onMessage, post, root, throttle } from './lib/dom';
import { icon } from './lib/icons';
import type { BrowserInput, BrowserState, HostMessage } from '../../src/webview/protocol';

let state: BrowserState = {
    url: '', title: '', loading: false, canGoBack: false, canGoForward: false, tabs: [],
};
/** The size of the remote viewport, as reported with the last frame. */
let frameSize = { width: 1280, height: 800 };
let addressFocused = false;

const screen = h('img', { class: 'browser-screen', alt: '' });
const stage = h('div', { class: 'browser-stage', tabIndex: 0 }, screen);
const tabsRow = h('div', { class: 'browser-tabs' });
const banner = h('div', { class: 'error-banner', hidden: true });

const address = h('input', {
    class: 'browser-address',
    type: 'text',
    placeholder: 'Search or enter an address',
    'aria-label': 'Address',
    on: {
        focus: () => { addressFocused = true; },
        blur: () => { addressFocused = false; },
        keydown: (event: KeyboardEvent) => {
            if (event.key === 'Enter') {
                post({ type: 'browserNavigate', url: (event.target as HTMLInputElement).value });
                stage.focus();
            }
        },
    },
});

const navButton = (glyph: string, title: string, action: 'back' | 'forward' | 'reload' | 'home'): HTMLButtonElement =>
    h('button', {
        class: 'icon-button',
        title,
        html: icon(glyph, 16),
        on: { click: () => post({ type: 'browserGo', action }) },
    });

const backButton = navButton('chevronLeft', 'Back', 'back');
const forwardButton = navButton('chevronRight', 'Forward', 'forward');

clear(root()).append(h('div', { class: 'app' },
    tabsRow,
    h('div', { class: 'toolbar browser-toolbar' },
        backButton,
        forwardButton,
        navButton('refresh', 'Reload', 'reload'),
        navButton('home', 'Homepage', 'home'),
        address,
        h('button', {
            class: 'button',
            title: 'Open this page in a real browser window',
            on: { click: () => post({ type: 'browserExternal' }) },
        }, h('span', { html: icon('open', 15) }), 'Open in browser'),
    ),
    banner,
    h('div', { class: 'body browser-body' }, stage),
));

// ------------------------------------------------------------------ frames

onMessage<HostMessage>((message) => {
    if (message.type === 'browserFrame') {
        frameSize = { width: message.width, height: message.height };
        screen.src = `data:image/jpeg;base64,${message.data}`;
        return;
    }

    if (message.type === 'browserState') {
        state = message.state;
        // Never fight the user for the address bar while they are typing in it.
        if (!addressFocused) {
            address.value = state.url === 'about:blank' ? '' : state.url;
        }
        backButton.disabled = !state.canGoBack;
        forwardButton.disabled = !state.canGoForward;
        renderTabs();
        return;
    }

    if (message.type === 'browserError') {
        clear(banner).append(h('div', {}, message.message));
        banner.hidden = false;
        if (!message.fatal) {
            setTimeout(() => { banner.hidden = true; }, 6000);
        }
    }
});

function renderTabs(): void {
    clear(tabsRow);
    for (const tab of state.tabs) {
        tabsRow.append(h('div', {
            class: `browser-tab${tab.active ? ' active' : ''}`,
            title: tab.title,
            on: { click: () => post({ type: 'browserTab', action: 'select', id: tab.id }) },
        },
        h('span', { class: 'browser-tab-title' }, tab.title || 'New tab'),
        h('button', {
            class: 'browser-tab-close',
            title: 'Close tab',
            html: icon('close', 12),
            on: {
                click: (event: MouseEvent) => {
                    event.stopPropagation();
                    post({ type: 'browserTab', action: 'close', id: tab.id });
                },
            },
        }),
        ));
    }
    tabsRow.append(h('button', {
        class: 'browser-tab-new',
        title: 'New tab',
        html: icon('plus', 14),
        on: { click: () => post({ type: 'browserTab', action: 'new' }) },
    }));
}

// ------------------------------------------------------------------- sizing

const sendSize = throttle(() => {
    const rect = stage.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
        post({ type: 'browserResize', width: Math.round(rect.width), height: Math.round(rect.height) });
    }
}, 250);

new ResizeObserver(() => sendSize()).observe(stage);

// ------------------------------------------------------------------- input

/**
 * Where a click in the <img> lands in the real page. The image is letterboxed by
 * `object-fit: contain`, so both the scale and the offset have to come out.
 */
function toPage(event: MouseEvent): { x: number; y: number } {
    const rect = screen.getBoundingClientRect();
    const scale = Math.min(rect.width / frameSize.width, rect.height / frameSize.height) || 1;
    const drawnWidth = frameSize.width * scale;
    const drawnHeight = frameSize.height * scale;
    const offsetX = (rect.width - drawnWidth) / 2;
    const offsetY = (rect.height - drawnHeight) / 2;
    return {
        x: Math.round((event.clientX - rect.left - offsetX) / scale),
        y: Math.round((event.clientY - rect.top - offsetY) / scale),
    };
}

/** CDP's modifier bitmask: alt 1, ctrl 2, meta 4, shift 8. */
function modifiers(event: MouseEvent | KeyboardEvent | WheelEvent): number {
    return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
}

const BUTTONS = ['left', 'middle', 'right'] as const;

function send(input: BrowserInput): void {
    post({ type: 'browserInput', input });
}

function mouse(type: 'mousePressed' | 'mouseReleased' | 'mouseMoved', event: MouseEvent): void {
    const { x, y } = toPage(event);
    send({
        kind: 'mouse',
        type,
        x,
        y,
        button: type === 'mouseMoved' ? 'none' : (BUTTONS[event.button] ?? 'left'),
        buttons: event.buttons,
        clickCount: type === 'mouseMoved' ? 0 : event.detail || 1,
        modifiers: modifiers(event),
    });
}

stage.addEventListener('mousedown', (event) => {
    event.preventDefault();
    stage.focus();
    mouse('mousePressed', event);
});
stage.addEventListener('mouseup', (event) => mouse('mouseReleased', event));
// Moves are the noisiest events by far and the page only needs enough of them
// for hover and drag to feel continuous.
stage.addEventListener('mousemove', throttle((event: MouseEvent) => mouse('mouseMoved', event), 40));
stage.addEventListener('contextmenu', (event) => event.preventDefault());

stage.addEventListener('wheel', (event) => {
    event.preventDefault();
    const { x, y } = toPage(event);
    send({ kind: 'wheel', x, y, deltaX: event.deltaX, deltaY: event.deltaY, modifiers: modifiers(event) });
}, { passive: false });

/**
 * Keys that produce a character get a `char` event as well, which is what
 * actually types into a text field; the rest only need down and up.
 */
stage.addEventListener('keydown', (event) => {
    if (event.key === 'F5') {
        event.preventDefault();
        post({ type: 'browserGo', action: 'reload' });
        return;
    }
    event.preventDefault();
    const base = {
        key: event.key,
        code: event.code,
        windowsVirtualKeyCode: event.keyCode,
        modifiers: modifiers(event),
    };
    send({ kind: 'key', type: 'keyDown', ...base, text: event.key.length === 1 ? event.key : undefined });
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
        send({ kind: 'key', type: 'char', ...base, text: event.key });
    }
});

stage.addEventListener('keyup', (event) => {
    event.preventDefault();
    send({
        kind: 'key',
        type: 'keyUp',
        key: event.key,
        code: event.code,
        windowsVirtualKeyCode: event.keyCode,
        modifiers: modifiers(event),
    });
});

renderTabs();
sendSize();
post({ type: 'ready' });
