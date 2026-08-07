// File explorer front-end: places sidebar, breadcrumb, grid/list view.

import { append, clear, formatBytes, h, onMessage, post, root, vscode } from './lib/dom';
import { icon } from './lib/icons';
import { archiveKind } from '../../src/util/archive';
import type { FileEntry, HostMessage, Place } from '../../src/webview/protocol';

interface Persisted {
    view: 'grid' | 'list';
    showHidden: boolean;
    sort: 'name' | 'size' | 'modified';
}

const saved = vscode.getState<Persisted>() ?? { view: 'grid', showHidden: false, sort: 'name' };
let view = saved.view;
let showHidden = saved.showHidden;
let sort = saved.sort;

let currentPath = '/';
let entries: FileEntry[] = [];
let places: Place[] = [];
let selection = new Set<string>();
const history: string[] = [];
let historyIndex = -1;

const breadcrumb = h('div', { class: 'breadcrumb' });
const placesPane = h('div', { class: 'places' });
const filesPane = h('div', { class: 'files' });
const status = h('div', { class: 'status' });
const banner = h('div', { class: 'error-banner', hidden: true });

const backButton = iconButton('chevronLeft', 'Back', () => go(-1));
const forwardButton = iconButton('chevronRight', 'Forward', () => go(1));

/**
 * The Recycle Bin is a place, not a directory, so it is browsed through a
 * sentinel path the host intercepts. Everything that writes into the current
 * folder - new file, new folder, paste, rename - is meaningless there, and the
 * buttons hide rather than failing when pressed.
 */
const TRASH_PATH = 'trash://';
const inTrash = (): boolean => currentPath === TRASH_PATH;

/** "archive:///home/me/photos.zip!sub/dir" - the host owns the meaning. */
const ARCHIVE_SCHEME = 'archive://';
const inArchive = (): boolean => currentPath.startsWith(ARCHIVE_SCHEME);
/** True where the current folder cannot be written to: the bin, or an archive. */
const readOnly = (): boolean => inTrash() || inArchive();

const newFolderButton = iconButton('plus', 'New folder', () => post({ type: 'newFolder', path: currentPath }));
const newFileButton = iconButton('file', 'New file', () => post({ type: 'newFile', path: currentPath }));
const emptyBinButton = iconButton('trash', 'Empty the Recycle Bin', () => post({ type: 'emptyTrash' }));
const extractAllButton = iconButton('archive', 'Extract everything', () => {
    const file = archiveFile();
    if (file) {
        post({ type: 'extract', paths: [file], chooseTarget: true });
    }
});

/** The archive's own path, out of the virtual path currently being browsed. */
function archiveFile(): string | undefined {
    if (!inArchive()) {
        return undefined;
    }
    const rest = currentPath.slice(ARCHIVE_SCHEME.length);
    const bang = rest.indexOf('!');
    return bang < 0 ? rest : rest.slice(0, bang);
}

clear(root()).append(h('div', { class: 'app' },
    h('div', { class: 'toolbar' },
        backButton,
        forwardButton,
        iconButton('chevronUp', 'Up one level', () => {
            const parent = currentPath.replace(/\/[^/]+\/?$/, '') || '/';
            navigate(parent);
        }),
        iconButton('refresh', 'Refresh', () => post({ type: 'navigate', path: currentPath })),
        breadcrumb,
        newFolderButton,
        newFileButton,
        emptyBinButton,
        extractAllButton,
        iconButton(view === 'grid' ? 'list' : 'grid', 'Switch view', () => {
            view = view === 'grid' ? 'list' : 'grid';
            persist();
            renderFiles();
        }),
        iconButton('search', showHidden ? 'Hide hidden files' : 'Show hidden files', () => {
            showHidden = !showHidden;
            persist();
            renderFiles();
        }),
    ),
    banner,
    h('div', { class: 'body' }, h('div', { class: 'explorer' }, placesPane, filesPane)),
    status,
));

function iconButton(glyph: string, title: string, onClick: () => void): HTMLButtonElement {
    return h('button', { class: 'icon-button', title, html: icon(glyph, 16), on: { click: onClick } });
}

onMessage<HostMessage>((message) => {
    if (message.type !== 'files') {
        return;
    }
    currentPath = message.path;
    entries = message.entries;
    places = message.places;
    selection = new Set();

    banner.hidden = !message.error;
    if (message.error) {
        clear(banner).append(h('span', { html: icon('warning', 16) }), ` ${message.error}`);
    }

    // Only record a genuine move, so Back does not walk through refreshes.
    if (history[historyIndex] !== currentPath) {
        history.splice(historyIndex + 1);
        history.push(currentPath);
        historyIndex = history.length - 1;
    }
    backButton.disabled = historyIndex <= 0;
    forwardButton.disabled = historyIndex >= history.length - 1;

    const trash = inTrash();
    newFolderButton.hidden = readOnly();
    newFileButton.hidden = readOnly();
    emptyBinButton.hidden = !trash;
    emptyBinButton.disabled = entries.length === 0;
    extractAllButton.hidden = !inArchive();

    renderPlaces();
    renderBreadcrumb();
    renderFiles();
});

post({ type: 'ready' });

function persist(): void {
    vscode.setState<Persisted>({ view, showHidden, sort });
}

function navigate(path: string): void {
    post({ type: 'navigate', path });
}

function go(delta: number): void {
    const next = historyIndex + delta;
    if (next < 0 || next >= history.length) {
        return;
    }
    historyIndex = next;
    // Do not re-record: the message handler sees the same entry it is on.
    post({ type: 'navigate', path: history[next] });
}

function renderPlaces(): void {
    clear(placesPane);
    for (const place of places) {
        placesPane.append(h('button', {
            class: `list-row${place.path === currentPath ? ' active' : ''}`,
            on: { click: () => navigate(place.path) },
        },
        h('span', { html: icon(place.icon, 16) }),
        h('span', { class: 'list-name' }, place.name),
        ));
    }
}

function renderBreadcrumb(): void {
    clear(breadcrumb);

    if (inTrash()) {
        // "trash://" has no path segments to split on, and splitting it would
        // produce a "trash:" crumb that navigates nowhere.
        breadcrumb.append(h('span', { class: 'crumb' }, 'Recycle Bin'));
        return;
    }

    if (inArchive()) {
        const file = archiveFile() ?? '';
        const inner = currentPath.slice(ARCHIVE_SCHEME.length + file.length + 1);
        // The archive is a file, so its crumb leaves the archive rather than
        // navigating deeper into a path that no longer exists.
        breadcrumb.append(h('button', {
            class: 'crumb',
            on: { click: () => navigate(file.replace(/\/[^/]+$/, '') || '/') },
        }, h('span', { html: icon('archive', 14) })));
        breadcrumb.append(h('button', {
            class: 'crumb',
            on: { click: () => navigate(`${ARCHIVE_SCHEME}${file}!`) },
        }, file.slice(file.lastIndexOf('/') + 1)));

        let accumulated = '';
        for (const part of inner.split('/').filter(Boolean)) {
            accumulated = accumulated ? `${accumulated}/${part}` : part;
            const target = accumulated;
            breadcrumb.append(h('button', {
                class: 'crumb',
                on: { click: () => navigate(`${ARCHIVE_SCHEME}${file}!${target}`) },
            }, part));
        }
        return;
    }

    const parts = currentPath.split('/').filter(Boolean);
    breadcrumb.append(h('button', { class: 'crumb', on: { click: () => navigate('/') } }, '/'));
    let accumulated = '';
    for (const part of parts) {
        accumulated += `/${part}`;
        const target = accumulated;
        breadcrumb.append(h('button', { class: 'crumb', on: { click: () => navigate(target) } }, part));
    }
}

function renderFiles(): void {
    const visible = entries
        .filter((entry) => showHidden || !entry.hidden)
        .sort((a, b) => {
            if (a.isDirectory !== b.isDirectory) {
                return a.isDirectory ? -1 : 1;
            }
            if (sort === 'size') {
                return b.size - a.size;
            }
            if (sort === 'modified') {
                return b.modified - a.modified;
            }
            return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        });

    filesPane.className = `files${view === 'grid' ? ' grid' : ''}`;
    clear(filesPane);

    if (visible.length === 0) {
        filesPane.append(h('div', { class: 'empty' }, 'This folder is empty.'));
    }

    for (const entry of visible) {
        const glyph = entry.isDirectory ? 'folder' : glyphFor(entry.name);
        const activate = (): void => {
            if (inTrash()) {
                // Nothing in the bin can be browsed or opened in place, so the
                // obvious gesture does the obvious thing.
                post({ type: 'restoreFromTrash', paths: [entry.path] });
            } else if (entry.isDirectory) {
                navigate(entry.path);
            } else {
                post({ type: 'openFile', path: entry.path });
            }
        };
        const select = (event: MouseEvent): void => {
            if (!event.ctrlKey && !event.metaKey) {
                selection.clear();
            }
            if (selection.has(entry.path)) {
                selection.delete(entry.path);
            } else {
                selection.add(entry.path);
            }
            renderFiles();
            renderStatus();
        };

        const common = {
            title: entry.originalPath ?? entry.path,
            tabIndex: 0,
            on: {
                click: select as (event: never) => void,
                dblclick: activate,
                keydown: ((event: KeyboardEvent) => {
                    if (event.key === 'Enter') {
                        activate();
                    } else if (event.key === 'Delete') {
                        post(inTrash()
                            ? { type: 'deleteFromTrash', paths: [entry.path] }
                            : { type: 'delete', paths: [entry.path] });
                    } else if (event.key === 'F2' && !readOnly()) {
                        post({ type: 'rename', path: entry.path });
                    }
                }) as (event: never) => void,
                contextmenu: ((event: MouseEvent) => {
                    event.preventDefault();
                    selection = new Set([entry.path]);
                    renderFiles();
                    showMenu(event, entry);
                }) as (event: never) => void,
            },
        };

        if (view === 'grid') {
            filesPane.append(h('div', {
                ...common,
                class: `file-tile${selection.has(entry.path) ? ' selected' : ''}`,
            },
            h('span', { class: entry.isDirectory ? 'folder-icon' : '', html: icon(glyph, 30) }),
            h('span', { class: 'name' }, entry.name),
            ));
        } else {
            filesPane.append(h('div', {
                ...common,
                class: `file-row${selection.has(entry.path) ? ' selected' : ''}`,
            },
            h('span', { class: entry.isDirectory ? 'folder-icon' : '', html: icon(glyph, 17) }),
            h('span', { class: 'name' }, entry.name),
            // In the bin, where it came from and when it went say far more than
            // a size and an mtime that is now the deletion time anyway.
            inTrash()
                ? h('span', { class: 'size trash-origin' }, entry.originalPath ?? 'Original location unknown')
                : h('span', { class: 'size' }, entry.isDirectory ? '' : formatBytes(entry.size)),
            h('span', { class: 'date' }, entry.modified ? new Date(entry.modified).toLocaleString() : ''),
            ));
        }
    }
    renderStatus();
}

function renderStatus(): void {
    if (inTrash()) {
        append(clear(status),
            h('span', {}, entries.length === 0
                ? 'The Recycle Bin is empty'
                : `${entries.length} item${entries.length === 1 ? '' : 's'} in the Recycle Bin`),
            selection.size > 0 ? h('span', {}, `${selection.size} selected`) : null,
        );
        return;
    }
    const folders = entries.filter((e) => e.isDirectory && (showHidden || !e.hidden)).length;
    const files = entries.filter((e) => !e.isDirectory && (showHidden || !e.hidden)).length;
    append(clear(status),
        h('span', {}, `${folders} folders, ${files} files`),
        selection.size > 0 ? h('span', {}, `${selection.size} selected`) : null,
    );
}

/** A small context menu, positioned at the pointer. */
function showMenu(event: MouseEvent, entry: FileEntry): void {
    document.querySelector('.context-menu')?.remove();

    const paths = selection.size > 0 ? [...selection] : [entry.path];
    const item = (label: string, glyph: string, action: () => void): HTMLElement =>
        h('button', { class: 'list-row', on: { click: () => { menu.remove(); action(); } } },
            h('span', { html: icon(glyph, 15) }), h('span', { class: 'list-name' }, label));

    const archives = paths.filter((candidate) => archiveKind(candidate) !== undefined);

    let items: HTMLElement[];
    if (inTrash()) {
        items = [
            item('Restore', 'undo', () => post({ type: 'restoreFromTrash', paths })),
            item('Delete permanently', 'trash', () => post({ type: 'deleteFromTrash', paths })),
            item('Empty Recycle Bin', 'close', () => post({ type: 'emptyTrash' })),
        ];
    } else if (inArchive()) {
        // Nothing inside an archive can be renamed, moved or deleted in place.
        const file = archiveFile();
        items = [
            item(entry.isDirectory ? 'Open' : 'Open a copy', 'open', () =>
                entry.isDirectory ? navigate(entry.path) : post({ type: 'openFile', path: entry.path })),
            file
                ? item('Extract everything…', 'archive', () =>
                    post({ type: 'extract', paths: [file], chooseTarget: true }))
                : null,
        ].filter((node): node is HTMLElement => node !== null);
    } else {
        items = [
            item(entry.isDirectory ? 'Open' : 'Open in editor', 'open', () =>
                entry.isDirectory ? navigate(entry.path) : post({ type: 'openFile', path: entry.path })),
            item('Open with default app', 'globe', () => post({ type: 'openExternal', path: entry.path })),
            item('Reveal in sidebar', 'editor', () => post({ type: 'revealInSidebar', path: entry.path })),
            archives.length > 0
                ? item('Extract here', 'archive', () => post({ type: 'extract', paths: archives, chooseTarget: false }))
                : null,
            archives.length > 0
                ? item('Extract to…', 'archive', () => post({ type: 'extract', paths: archives, chooseTarget: true }))
                : null,
            item(paths.length > 1 ? `Compress ${paths.length} items` : 'Compress', 'archive', () =>
                post({ type: 'compress', paths })),
            item('Copy', 'file', () => post({ type: 'clipboard', paths, cut: false })),
            item('Cut', 'file', () => post({ type: 'clipboard', paths, cut: true })),
            item('Paste here', 'save', () => post({ type: 'paste', target: currentPath })),
            item('Rename', 'editor', () => post({ type: 'rename', path: entry.path })),
            item('Delete', 'trash', () => post({ type: 'delete', paths })),
        ].filter((node): node is HTMLElement => node !== null);
    }

    // Clamped to the menu's own height rather than a constant tuned to one
    // length: the bin's menu is three rows and the ordinary one is eight.
    const height = items.length * 30 + 12;
    const menu = h('div', {
        class: 'context-menu flyout',
        style: {
            position: 'fixed',
            left: `${Math.min(event.clientX, window.innerWidth - 220)}px`,
            top: `${Math.min(event.clientY, window.innerHeight - height)}px`,
            width: '210px',
            padding: '4px',
            zIndex: '30',
        },
    }, ...items);

    document.body.append(menu);
    const dismiss = (): void => {
        menu.remove();
        document.removeEventListener('click', dismiss);
    };
    setTimeout(() => document.addEventListener('click', dismiss), 0);
}

function glyphFor(name: string): string {
    // Checked first, because archiveKind understands the double extensions the
    // last-dot rule below gets wrong - ".tar.gz" is not a ".gz".
    if (archiveKind(name)) {
        return 'archive';
    }
    const extension = name.slice(name.lastIndexOf('.')).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg'].includes(extension)) {
        return 'image';
    }
    if (['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.opus'].includes(extension)) {
        return 'music';
    }
    if (['.mp4', '.mkv', '.webm', '.mov', '.avi'].includes(extension)) {
        return 'video';
    }
    return 'file';
}

document.addEventListener('keydown', (event) => {
    if (event.key === 'Delete' && selection.size > 0) {
        if (inArchive()) {
            // Members cannot be removed from an archive in place.
            return;
        }
        post(inTrash()
            ? { type: 'deleteFromTrash', paths: [...selection] }
            : { type: 'delete', paths: [...selection] });
    } else if ((event.ctrlKey || event.metaKey) && event.key === 'c' && selection.size > 0) {
        post({ type: 'clipboard', paths: [...selection], cut: false });
    } else if ((event.ctrlKey || event.metaKey) && event.key === 'x' && selection.size > 0) {
        post({ type: 'clipboard', paths: [...selection], cut: true });
    } else if ((event.ctrlKey || event.metaKey) && event.key === 'v') {
        post({ type: 'paste', target: currentPath });
    }
});
