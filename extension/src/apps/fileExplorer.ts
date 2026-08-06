// A graphical file explorer, as a webview panel.
//
// VS Code's own Explorer is scoped to the open workspace and only really deals
// in text. This one starts at $HOME, browses the whole filesystem, and hands
// anything that is not text to xdg-open - which is what a desktop needs.

import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openWithDefaultApp } from '../sys/browser';
import { output } from '../sys/exec';
import { render, webviewOptions } from '../webview/html';
import type { FileEntry, Place, WebviewMessage } from '../webview/protocol';
import { log } from '../log';

const TEXT_EXTENSIONS = new Set([
    '.txt', '.md', '.markdown', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.conf', '.cfg',
    '.log', '.csv', '.tsv', '.xml', '.html', '.htm', '.css', '.scss', '.less', '.js', '.mjs', '.cjs',
    '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.cs', '.java',
    '.kt', '.swift', '.sh', '.bash', '.zsh', '.fish', '.php', '.pl', '.lua', '.sql', '.env', '.gitignore',
    '.service', '.desktop', '.rules', '.patch', '.diff',
]);

export class FileExplorer {
    private panel: vscode.WebviewPanel | undefined;
    private currentPath = os.homedir();
    private clipboard: { paths: string[]; cut: boolean } | undefined;

    constructor(private readonly context: vscode.ExtensionContext) {}

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
                    const extension = path.extname(message.path).toLowerCase();
                    const stat = await fs.stat(message.path);
                    if (stat.isDirectory()) {
                        await this.list(message.path);
                        return;
                    }
                    // Text opens in the editor, which is the whole point of this OS;
                    // everything else goes to the desktop's handler.
                    if (TEXT_EXTENSIONS.has(extension) || extension === '') {
                        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(message.path));
                        await vscode.window.showTextDocument(document, { preview: false });
                    } else if (!openWithDefaultApp(message.path)) {
                        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(message.path));
                        await vscode.window.showTextDocument(document, { preview: false });
                    }
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
                    await this.list(this.currentPath);
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

/** "report.txt" -> "report (1).txt" when pasting into the same folder. */
async function uniqueName(target: string): Promise<string> {
    try {
        await fs.access(target);
    } catch {
        return target;
    }
    const directory = path.dirname(target);
    const extension = path.extname(target);
    const base = path.basename(target, extension);
    for (let i = 1; i < 1000; i++) {
        const candidate = path.join(directory, `${base} (${i})${extension}`);
        try {
            await fs.access(candidate);
        } catch {
            return candidate;
        }
    }
    return `${target}.${Date.now()}`;
}
