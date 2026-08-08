// All Apps.
//
// A start menu: type, see fewer things, press Enter. It lives in the activity
// bar, which is narrow, so the layout is a search box, a row of source filters
// and a grid of tiles - and the tiles carry a real icon when the app has one
// (a web app's manifest icon, a desktop entry's theme icon) and a glyph when it
// does not.
//
// Right-clicking a tile opens the actions, rather than hanging buttons off
// every tile: at 96px there is no room for them, and only web apps have more
// than one thing that can be done to them anyway.

import { append, clear, h, onMessage, post, root } from './lib/dom';
import { icon } from './lib/icons';
import type { AllAppsState, AppEntry, AppSource, HostMessage } from '../../src/webview/protocol';

type Filter = 'all' | AppSource;

const FILTERS: { id: Filter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'builtin', label: 'Apps' },
    { id: 'webapp', label: 'Web' },
    { id: 'system', label: 'System' },
];

const SOURCE_LABEL: Record<AppSource, string> = {
    builtin: 'Built in',
    webapp: 'Web app',
    system: 'Installed on this computer',
};

let state: AllAppsState | undefined;
let query = '';
let filter: Filter = 'all';

const search = h('input', {
    class: 'app-search',
    type: 'text',
    placeholder: 'Search apps',
    'aria-label': 'Search apps',
    on: {
        input: (event: Event) => {
            query = (event.target as HTMLInputElement).value;
            renderGrid();
        },
        keydown: (event: KeyboardEvent) => {
            if (event.key === 'Enter') {
                const first = visible()[0];
                if (first) {
                    launch(first);
                }
            }
        },
    },
});

const chips = h('div', { class: 'app-filters' });
const grid = h('div', { class: 'app-grid' });
const count = h('span', {});

clear(root()).append(
    h('div', { class: 'app' },
        h('div', { class: 'toolbar app-toolbar' },
            h('div', { class: 'app-search-row' },
                h('span', { class: 'app-search-icon', html: icon('search', 16) }),
                search,
            ),
            chips,
        ),
        h('div', { class: 'body app-body' }, grid),
        h('div', { class: 'status' },
            count,
            h('span', { class: 'spacer' }),
            // Nothing watches the application directories, so an app installed
            // from the terminal needs a nudge to show up here.
            h('button', {
                class: 'link-button',
                title: 'Look for newly installed applications',
                on: { click: () => post({ type: 'refreshApps' }) },
            }, 'Refresh'),
            h('button', {
                class: 'link-button',
                title: 'Find and install web apps',
                on: { click: () => post({ type: 'command', command: 'vscodeos.marketplace.open' }) },
            }, 'Get more apps'),
        ),
    ),
);

onMessage<HostMessage>((message) => {
    if (message.type !== 'apps') {
        return;
    }
    state = message.state;
    renderChips();
    renderGrid();
});

post({ type: 'ready' });

// ------------------------------------------------------------------ filtering

/**
 * Every word has to appear somewhere, so "voice rec" finds the recorder but
 * "voice paint" finds nothing. The same rule the tray launcher used.
 */
function matches(app: AppEntry, text: string): boolean {
    if (!text) {
        return true;
    }
    const haystack = [app.title, app.description, ...(app.keywords ?? [])].join(' ').toLowerCase();
    return text.toLowerCase().split(/\s+/).filter(Boolean).every((word) => haystack.includes(word));
}

function visible(): AppEntry[] {
    return (state?.apps ?? [])
        .filter((app) => filter === 'all' || app.source === filter)
        .filter((app) => matches(app, query));
}

function renderChips(): void {
    clear(chips);
    for (const entry of FILTERS) {
        // A filter for a source with nothing in it is a button that empties the
        // grid, so it is not offered.
        const available = entry.id === 'all'
            || (state?.apps ?? []).some((app) => app.source === entry.id);
        if (!available) {
            continue;
        }
        chips.append(h('button', {
            class: `chip${filter === entry.id ? ' on' : ''}`,
            on: {
                click: () => {
                    filter = entry.id;
                    renderChips();
                    renderGrid();
                },
            },
        }, entry.label));
    }
}

// ----------------------------------------------------------------- the grid

function launch(app: AppEntry): void {
    closeMenu();
    post({ type: 'launchApp', source: app.source, id: app.id });
}

function tile(app: AppEntry): HTMLElement {
    const glyph = app.iconUrl
        ? h('img', { class: 'app-tile-image', src: app.iconUrl, alt: '' })
        : h('span', { class: 'app-tile-icon', html: icon(app.icon, 26) });

    return h('button', {
        class: 'app-tile',
        title: `${app.title}\n${app.description}`,
        on: {
            click: () => launch(app),
            contextmenu: (event: MouseEvent) => {
                event.preventDefault();
                openMenu(app, event.clientX, event.clientY);
            },
        },
    },
    glyph,
    h('span', { class: 'app-tile-label' }, app.title),
    );
}

function renderGrid(): void {
    closeMenu();
    clear(grid);
    const list = visible();

    if (!state) {
        grid.append(h('div', { class: 'empty' }, 'Loading…'));
        return;
    }
    if (list.length === 0) {
        grid.append(h('div', { class: 'empty' },
            query ? 'No app matches that.' : 'Nothing to show here.'));
    }
    for (const app of list) {
        grid.append(tile(app));
    }

    const total = state.apps.length;
    count.textContent = list.length === total
        ? `${total} app${total === 1 ? '' : 's'}`
        : `${list.length} of ${total}`;
}

// -------------------------------------------------------------- context menu

let menu: HTMLElement | undefined;

function closeMenu(): void {
    menu?.remove();
    menu = undefined;
}

function menuItem(label: string, glyph: string, onClick: () => void): HTMLElement {
    return h('button', {
        class: 'list-row',
        on: { click: () => { closeMenu(); onClick(); } },
    },
    h('span', { html: icon(glyph, 15) }),
    h('span', { class: 'list-main' }, h('div', { class: 'list-name' }, label)),
    );
}

function openMenu(app: AppEntry, x: number, y: number): void {
    closeMenu();
    const items: HTMLElement[] = [menuItem('Open', 'open', () => launch(app))];

    if (app.source === 'webapp') {
        const toWindow = app.openIn !== 'window';
        items.push(menuItem(
            toWindow ? 'Open in its own window' : 'Open in an editor tab',
            toWindow ? 'fullscreen' : 'editor',
            () => post({ type: 'setAppOpenIn', id: app.id, openIn: toWindow ? 'window' : 'editor' }),
        ));
    }
    if (app.removable) {
        items.push(menuItem('Uninstall', 'trash', () =>
            post({ type: 'uninstallApp', id: app.id, name: app.title })));
    }

    // Not `.flyout`: that card goes transparent and borderless below 460px so it
    // can fill the side bar, and this view is always narrower than that.
    const created = h('div', { class: 'context-menu' },
        h('div', { class: 'context-head' },
            h('div', { class: 'list-name' }, app.title),
            h('div', { class: 'list-sub' }, app.url ?? SOURCE_LABEL[app.source]),
        ),
    );
    append(created, ...items);

    // Placed against the viewport, then nudged back inside it: the activity bar
    // is narrow and a menu opened on a right-hand tile would otherwise hang off
    // the edge with its actions unreachable.
    created.style.left = `${x}px`;
    created.style.top = `${y}px`;
    document.body.append(created);
    const box = created.getBoundingClientRect();
    if (box.right > window.innerWidth) {
        created.style.left = `${Math.max(4, window.innerWidth - box.width - 4)}px`;
    }
    if (box.bottom > window.innerHeight) {
        created.style.top = `${Math.max(4, window.innerHeight - box.height - 4)}px`;
    }
    menu = created;
}

window.addEventListener('click', (event) => {
    if (menu && !menu.contains(event.target as Node)) {
        closeMenu();
    }
});

window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        if (menu) {
            closeMenu();
            return;
        }
        if (query) {
            query = '';
            search.value = '';
            renderGrid();
        }
    }
});

// Typing should start immediately, the way a start menu does.
setTimeout(() => search.focus(), 0);
