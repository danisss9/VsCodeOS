// A graphical file explorer, as a webview panel.
//
// VS Code's own Explorer is scoped to the open workspace and only really deals
// in text. This one starts at $HOME and browses the whole filesystem.
//
// Everything opens *in the editor*. There used to be a list of known text
// extensions here, with everything else thrown at xdg-open - which meant
// double-clicking a PNG launched some other program on top of the editor, and an
// unlisted extension did too. `vscode.open` already routes a file to whatever
// editor claims it: the text editor for text, the built-in image preview for
// pictures, the binary notice for the rest. The one thing the editor has no
// answer for is media with a soundtrack, and that now has an app of its own.

import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openWithDefaultApp } from '../sys/browser';
import { output } from '../sys/exec';
import { TRASH_PATH, uniqueName } from '../sys/trash';
import type { TrashService } from '../sys/trash';
import { render, webviewOptions } from '../webview/html';
import { mediaKind } from '../util/media';
import type { FileEntry, Place, WebviewMessage } from '../webview/protocol';
import { log } from '../log';

export class FileExplorer {
    private panel: vscode.WebviewPanel | undefined;
    private currentPath = os.homedir();
    private clipboard: { paths: string[]; cut: boolean } | undefined;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly trash: TrashService,
    ) {
        // Restoring something from the activity bar view has to show up here too.
        this.trash.on('change', () => {
            if (this.currentPath === TRASH_PATH) {
                void this.list(TRASH_PATH);
            }
        });
    }

    async open(startPath?: string): Promise<void> {
        if (startPath) {
            this.currentPath = startPath;
        }
        if (this.panel) {
            this.panel.reveal();
            await this.list(this.currentPath);
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            'vscodeos.files',
            'Files',
            vscode.ViewColumn.Active,
            { ...webviewOptions(this.context), retainContextWhenHidden: true },
        );
        this.panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'icons', 'files.svg');
        this.panel.webview.html = render(this.panel.webview, this.context, { title: 'Files', script: 'files' });
        this.panel.webview.onDidReceiveMessage((message: WebviewMessage) => void this.handle(message));
        this.panel.onDidDispose(() => (this.panel = undefined));
    }

    private post(message: unknown): void {
        void this.panel?.webview.postMessage(message);
    }

    private async list(target: string, error?: string): Promise<void> {
        if (target === TRASH_PATH) {
            await this.listTrash(error);
            return;
        }

        let entries: FileEntry[] = [];
        try {
            const names = await fs.readdir(target, { withFileTypes: true });
            entries = await Promise.all(names.map(async (entry) => {
                const full = path.join(target, entry.name);
                let size = 0;
                let modified = 0;
                let isDirectory = entry.isDirectory();
                try {
                    // stat, not lstat: a symlink to a directory should browse like one.
                    const stat = await fs.stat(full);
                    size = stat.size;
                    modified = stat.mtimeMs;
                    isDirectory = stat.isDirectory();
                } catch {
                    // Broken symlink or a file we cannot stat; still list it.
                    isDirectory = entry.isDirectory();
                }
                return {
                    name: entry.name,
                    path: full,
                    isDirectory,
                    isSymlink: entry.isSymbolicLink(),
                    size,
                    modified,
                    hidden: entry.name.startsWith('.'),
                };
            }));
            this.currentPath = target;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.post({ type: 'files', path: this.currentPath, entries: [], places: await places(), error: message });
            return;
        }

        this.post({ type: 'files', path: target, entries, places: await places(), error });
    }

    /**
     * The bin is not a directory listing. Names inside files/ are mangled to
     * avoid collisions, so what gets shown is the original name, with where it
     * came from and when it went in place of the usual size and date.
     */
    private async listTrash(error?: string): Promise<void> {
        this.currentPath = TRASH_PATH;
        const items = await this.trash.list();
        const entries: FileEntry[] = items.map((item) => ({
            name: item.originalPath ? path.basename(item.originalPath) : item.name,
            // The key the host needs back for restore and delete, not a real path.
            path: item.name,
            isDirectory: item.isDirectory,
            isSymlink: false,
            size: item.size,
            modified: item.deletedAt ?? 0,
            hidden: false,
            originalPath: item.originalPath,
            deletedAt: item.deletedAt,
        }));
        this.post({ type: 'files', path: TRASH_PATH, entries, places: await places(), error });
    }

    private async handle(message: WebviewMessage): Promise<void> {
        try {
            switch (message.type) {
                case 'ready':
                    await this.list(this.currentPath);
                    return;

                case 'navigate':
                    await this.list(message.path);
                    return;

                case 'openFile': {
                    if (this.currentPath === TRASH_PATH) {
                        // Opening something in the bin would edit a file that is
                        // meant to be deleted; restore it first.
                        void vscode.window.showInformationMessage(
                            'Restore this item before opening it.',
                        );
                        return;
                    }
                    const stat = await fs.stat(message.path);
                    if (stat.isDirectory()) {
                        await this.list(message.path);
                        return;
                    }
                    if (mediaKind(message.path)) {
                        await vscode.commands.executeCommand('vscodeos.apps.player', message.path);
                        return;
                    }
                    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(message.path));
                    return;
                }

                case 'openExternal':
                    if (!openWithDefaultApp(message.path)) {
                        void vscode.window.showWarningMessage('xdg-open is not available.');
                    }
                    return;

                case 'revealInSidebar':
                    await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(message.path));
                    return;

                case 'newFolder': {
                    const name = await vscode.window.showInputBox({ prompt: 'New folder name', value: 'New folder' });
                    if (name) {
                        await fs.mkdir(path.join(message.path, name), { recursive: false });
                        await this.list(message.path);
                    }
                    return;
                }

                case 'newFile': {
                    const name = await vscode.window.showInputBox({ prompt: 'New file name' });
                    if (name) {
                        const full = path.join(message.path, name);
                        await fs.writeFile(full, '', { flag: 'wx' });
                        await this.list(message.path);
                    }
                    return;
                }

                case 'rename': {
                    const current = path.basename(message.path);
                    const name = await vscode.window.showInputBox({
                        prompt: 'Rename to',
                        value: current,
                        valueSelection: [0, current.lastIndexOf('.') > 0 ? current.lastIndexOf('.') : current.length],
                    });
                    if (name && name !== current) {
                        await fs.rename(message.path, path.join(path.dirname(message.path), name));
                        await this.list(this.currentPath);
                    }
                    return;
                }

                case 'delete': {
                    if (this.currentPath === TRASH_PATH) {
                        await this.deleteFromTrash(message.paths);
                        return;
                    }
                    const label = message.paths.length === 1
                        ? `"${path.basename(message.paths[0])}"`
                        : `${message.paths.length} items`;
                    const choice = await vscode.window.showWarningMessage(
                        `Move ${label} to the trash?`,
                        { modal: true },
                        'Move to trash',
                        'Delete permanently',
                    );
                    if (!choice) {
                        return;
                    }
                    for (const target of message.paths) {
                        if (choice === 'Move to trash') {
                            // The workspace API is what knows about the desktop trash.
                            await vscode.workspace.fs.delete(vscode.Uri.file(target), {
                                recursive: true,
                                useTrash: true,
                            });
                        } else {
                            await fs.rm(target, { recursive: true, force: true });
                        }
                    }
                    if (choice === 'Move to trash') {
                        this.trash.notifyChanged();
                    }
                    await this.list(this.currentPath);
                    return;
                }

                case 'restoreFromTrash': {
                    const { restored, skipped } = await this.trash.restore(message.paths);
                    if (skipped.length > 0) {
                        void vscode.window.showWarningMessage(
                            `${skipped.length} item${skipped.length === 1 ? '' : 's'} could not be restored: `
                            + 'the original location is unknown.',
                        );
                    } else if (restored > 0) {
                        void vscode.window.showInformationMessage(
                            `Restored ${restored} item${restored === 1 ? '' : 's'}.`,
                        );
                    }
                    await this.list(TRASH_PATH);
                    return;
                }

                case 'deleteFromTrash':
                    await this.deleteFromTrash(message.paths);
                    return;

                case 'emptyTrash': {
                    if (await this.trash.isEmpty()) {
                        return;
                    }
                    const choice = await vscode.window.showWarningMessage(
                        'Empty the Recycle Bin?',
                        { modal: true, detail: 'Everything in it is deleted for good.' },
                        'Empty Recycle Bin',
                    );
                    if (choice === 'Empty Recycle Bin') {
                        await this.trash.empty();
                    }
                    await this.list(TRASH_PATH);
                    return;
                }

                case 'clipboard':
                    this.clipboard = { paths: message.paths, cut: message.cut };
                    return;

                case 'paste': {
                    if (!this.clipboard) {
                        return;
                    }
                    for (const source of this.clipboard.paths) {
                        const destination = await uniqueName(path.join(message.target, path.basename(source)));
                        if (this.clipboard.cut) {
                            await fs.rename(source, destination);
                        } else {
                            await fs.cp(source, destination, { recursive: true });
                        }
                    }
                    if (this.clipboard.cut) {
                        this.clipboard = undefined;
                    }
                    await this.list(message.target);
                    return;
                }

                default:
                    return;
            }
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            log.error('file explorer', error);
            void vscode.window.showErrorMessage(detail);
            await this.list(this.currentPath);
        }
    }

    private async deleteFromTrash(names: string[]): Promise<void> {
        const label = names.length === 1 ? 'this item' : `${names.length} items`;
        const choice = await vscode.window.showWarningMessage(
            `Permanently delete ${label}?`,
            { modal: true, detail: 'This cannot be undone.' },
            'Delete permanently',
        );
        if (choice === 'Delete permanently') {
            await this.trash.remove(names);
        }
        await this.list(TRASH_PATH);
    }

    dispose(): void {
        this.panel?.dispose();
    }
}

/** The sidebar: home, the XDG user dirs that exist, and any mounted volume. */
async function places(): Promise<Place[]> {
    const home = os.homedir();
    const candidates: Place[] = [
        { name: 'Home', path: home, icon: 'home' },
        { name: 'Projects', path: path.join(home, 'Projects'), icon: 'folder' },
        { name: 'Documents', path: path.join(home, 'Documents'), icon: 'file' },
        { name: 'Downloads', path: path.join(home, 'Downloads'), icon: 'download' },
        { name: 'Pictures', path: path.join(home, 'Pictures'), icon: 'image' },
        { name: 'Music', path: path.join(home, 'Music'), icon: 'music' },
        { name: 'Videos', path: path.join(home, 'Videos'), icon: 'video' },
    ];

    const existing: Place[] = [];
    for (const place of candidates) {
        try {
            if ((await fs.stat(place.path)).isDirectory()) {
                existing.push(place);
            }
        } catch {
            /* the user never created it */
        }
    }
    existing.push({ name: 'Filesystem', path: '/', icon: 'disk' });
    // Always listed, even when empty: a Recycle Bin that appears only once you
    // have deleted something is a Recycle Bin nobody finds.
    existing.push({ name: 'Recycle Bin', path: TRASH_PATH, icon: 'trash' });

    // Removable media, straight from lsblk rather than by guessing at /run/media.
    const mounts = await output('lsblk', ['-nrpo', 'MOUNTPOINT,LABEL,RM'], 4000);
    for (const line of (mounts ?? '').split('\n')) {
        const [mountpoint, label, removable] = line.split(' ');
        if (!mountpoint || mountpoint === '/' || mountpoint.startsWith('/boot') || mountpoint === '[SWAP]') {
            continue;
        }
        if (removable !== '1' && !mountpoint.startsWith('/run/media') && !mountpoint.startsWith('/media')) {
            continue;
        }
        existing.push({ name: label || path.basename(mountpoint), path: mountpoint, icon: 'disk' });
    }
    return existing;
}
