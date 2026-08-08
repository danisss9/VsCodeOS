// The Marketplace page.
//
// Two panes, the same shape as System Settings: categories down the left,
// results on the right. The search box searches the whole catalogue rather than
// the open category - typing "regex" and being told there are no results
// because you happen to be looking at Media would be a poor answer.
//
// Icons are not fetched for the browse list. They come from each site's own
// manifest, which means one request per row to draw a grid nobody has asked to
// install anything from yet; a letter tile costs nothing and says as much.

import { clear, h, onMessage, post, root } from './lib/dom';
import { icon } from './lib/icons';
import type { HostMessage, MarketplaceItem, MarketplaceState } from '../../src/webview/protocol';

let state: MarketplaceState | undefined;
let query = '';
let busy: string | undefined;

const rail = h('div', { class: 'places settings-rail' });
const pane = h('div', { class: 'files settings-pane' });

const address = h('input', {
    class: 'app-search',
    type: 'text',
    placeholder: 'Paste a web address to install any site',
    'aria-label': 'Install from a web address',
    on: {
        keydown: (event: KeyboardEvent) => {
            if (event.key === 'Enter') {
                installTyped();
            }
        },
    },
});

const search = h('input', {
    class: 'app-search',
    type: 'text',
    placeholder: 'Search',
    'aria-label': 'Search the catalogue',
    on: {
        input: (event: Event) => {
            query = (event.target as HTMLInputElement).value;
            render();
        },
    },
});

clear(root()).append(
    h('div', { class: 'app' },
        h('div', { class: 'toolbar' },
            h('div', { class: 'app-search-row', style: { flex: '1', marginBottom: '0' } },
                h('span', { class: 'app-search-icon', html: icon('search', 16) }),
                search,
            ),
            h('div', { class: 'app-search-row market-address', style: { marginBottom: '0' } },
                h('span', { class: 'app-search-icon', html: icon('link', 16) }),
                address,
            ),
            h('button', {
                class: 'button primary',
                title: 'Read the site and install it as an app',
                on: { click: () => installTyped() },
            }, h('span', { html: icon('download', 15) }), 'Install'),
        ),
        h('div', { class: 'body' }, h('div', { class: 'explorer' }, rail, pane)),
    ),
);

onMessage<HostMessage>((message) => {
    if (message.type === 'marketplace') {
        state = message.state;
        busy = undefined;
        render();
        return;
    }
    if (message.type === 'marketplaceBusy') {
        busy = message.label;
        render();
    }
});

post({ type: 'ready' });

function installTyped(): void {
    const url = address.value.trim();
    if (!url) {
        return;
    }
    post({ type: 'installWebApp', url });
    address.value = '';
}

// ------------------------------------------------------------------- render

function render(): void {
    renderRail();
    renderPane();
}

function renderRail(): void {
    clear(rail);
    if (!state) {
        return;
    }
    for (const category of state.categories) {
        const count = state.items.filter((item) =>
            category === 'Installed' ? item.installed : item.category === category).length;
        rail.append(h('button', {
            class: `list-row${state.category === category && !query ? ' active' : ''}`,
            on: {
                click: () => {
                    query = '';
                    search.value = '';
                    post({ type: 'marketplaceCategory', category });
                },
            },
        },
        h('span', { html: icon(category === 'Installed' ? 'check' : 'store', 17) }),
        h('span', { class: 'list-main' },
            h('div', { class: 'list-name' }, category),
            h('div', { class: 'list-sub' }, `${count} app${count === 1 ? '' : 's'}`),
        ),
        ));
    }
}

/** A word-for-word match over the whole catalogue, the same rule All Apps uses. */
function matches(item: MarketplaceItem, text: string): boolean {
    const haystack = [item.name, item.description, item.url, ...(item.keywords ?? [])]
        .join(' ')
        .toLowerCase();
    return text.toLowerCase().split(/\s+/).filter(Boolean).every((word) => haystack.includes(word));
}

function shown(): MarketplaceItem[] {
    if (!state) {
        return [];
    }
    // A search leaves the category behind on purpose: looking for something by
    // name should find it wherever it happens to be filed.
    if (query) {
        return state.items.filter((item) => matches(item, query));
    }
    return state.items.filter((item) =>
        state?.category === 'Installed' ? item.installed : item.category === state?.category);
}

/** A coloured initial, so a list of thirty rows is not thirty identical glyphs. */
function letterTile(item: MarketplaceItem): HTMLElement {
    let hash = 0;
    for (const character of item.name) {
        hash = (hash * 31 + character.charCodeAt(0)) % 360;
    }
    return h('span', {
        class: 'market-letter',
        style: { background: `hsl(${hash}, 42%, 42%)` },
    }, item.name.slice(0, 1).toUpperCase());
}

function row(item: MarketplaceItem): HTMLElement {
    const actions = h('span', { class: 'market-actions' });

    if (item.installed) {
        actions.append(
            h('span', { class: 'update-badge current' }, 'Installed'),
            h('button', {
                class: 'button',
                title: 'Open this app',
                on: { click: () => post({ type: 'launchApp', source: 'webapp', id: item.appId }) },
            }, 'Open'),
            h('button', {
                class: 'icon-button',
                title: 'Uninstall',
                html: icon('trash', 15),
                on: { click: () => post({ type: 'uninstallApp', id: item.appId, name: item.name }) },
            }),
        );
    } else {
        actions.append(
            h('button', {
                class: 'button primary',
                title: `Install ${item.name}`,
                on: { click: () => post({ type: 'installWebApp', url: item.url }) },
            }, 'Install'),
            h('button', {
                class: 'icon-button',
                title: 'Visit the site first',
                html: icon('globe', 15),
                on: { click: () => post({ type: 'openExternal', path: item.url }) },
            }),
        );
    }

    return h('div', { class: 'list-row market-row', title: item.url },
        letterTile(item),
        h('span', { class: 'list-main' },
            h('div', { class: 'list-name' }, item.name),
            h('div', { class: 'list-sub' }, item.description),
        ),
        actions,
    );
}

function renderPane(): void {
    clear(pane);
    if (!state) {
        pane.append(h('div', { class: 'empty' }, 'Loading…'));
        return;
    }

    const items = shown();
    const title = query ? `Results for “${query}”` : state.category;
    pane.append(h('div', { class: 'pane-head' },
        h('div', {},
            h('div', { class: 'pane-title' }, title),
            h('div', { class: 'pane-sub' },
                state.category === 'Installed' && !query
                    ? 'Apps this shell installed. Uninstalling removes the shortcut, not your account.'
                    : 'Installing reads the site’s own app manifest for its name and icon.'),
        ),
    ));

    if (busy) {
        pane.append(h('div', { class: 'empty' }, busy));
    }

    if (!state.canOpenWindows) {
        pane.append(h('p', { class: 'flyout-note' },
            'No Chromium-based browser is installed, so web apps will open in an editor tab. '
            + 'Run: sudo pacman -S chromium'));
    }

    if (items.length === 0) {
        pane.append(h('div', { class: 'empty' },
            query
                ? 'Nothing in the catalogue matches that. Any site can still be installed by pasting its address above.'
                : state.category === 'Installed'
                    ? 'No web apps installed yet.'
                    : 'Nothing here yet.'));
        return;
    }

    const list = h('div', { class: 'list' });
    for (const item of items) {
        list.append(row(item));
    }
    pane.append(list);
}
