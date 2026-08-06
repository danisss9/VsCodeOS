// Calculator, Notepad, Paint, Screenshot and Voice Recorder.
//
// All five are webviews. Two of them need the host for things a webview cannot
// do at all: capturing the screen (scrot) and capturing the microphone
// (pw-record - VS Code denies webviews the 'media' permission outright).

import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as screenshot from '../sys/screenshot';
import { Recorder } from '../sys/recorder';
import { openWithDefaultApp } from '../sys/browser';
import { expandHome } from '../util/format';
import { AppPanels } from './panels';
import type { WebviewMessage } from '../webview/protocol';
import { log } from '../log';

export class MiniApps implements vscode.Disposable {
    private readonly recorder = new Recorder();
    private lastShot: string | undefined;

    constructor(private readonly panels: AppPanels) {}

    calculator(): void {
        this.panels.open({ id: 'calculator', title: 'Calculator', script: 'calculator', icon: 'calculator' });
    }

    paint(): void {
        this.panels.open({
            id: 'paint',
            title: 'Paint',
            script: 'paint',
            icon: 'paint',
            onMessage: (message, panel) => this.handlePaint(message, panel),
        });
    }

    notepad(): void {
        this.panels.open({
            id: 'notepad',
            title: 'Notepad',
            script: 'notepad',
            icon: 'notepad',
            onMessage: (message, panel) => this.handleNotepad(message, panel),
        });
    }

    screenshot(): void {
        this.panels.open({
            id: 'screenshot',
            title: 'Screenshot',
            script: 'screenshot',
            icon: 'screenshot',
            localRoots: [vscode.Uri.file(this.directory('screenshot.directory', '~/Pictures/Screenshots'))],
            onMessage: (message, panel) => this.handleScreenshot(message, panel),
        });
    }

    recorderApp(): void {
        this.panels.open({
            id: 'recorder',
            title: 'Voice Recorder',
            script: 'recorder',
            icon: 'recorder',
            localRoots: [vscode.Uri.file(this.directory('recorder.directory', '~/Music/Recordings'))],
            onMessage: (message, panel) => this.handleRecorder(message, panel),
        });
    }

    /** One list of everything, for the "All apps" palette entry. */
    async menu(): Promise<void> {
        const items: (vscode.QuickPickItem & { command: string })[] = [
            { label: '$(folder) Files', description: 'Browse the filesystem', command: 'vscodeos.files.open' },
            { label: '$(globe) Web Browser', description: 'Open a browser window', command: 'vscodeos.browser.open' },
            { label: '$(play-circle) Music', description: 'Spotify and YouTube Music', command: 'vscodeos.music.show' },
            { label: '$(dashboard) Task Manager', description: 'Processes, CPU and memory', command: 'vscodeos.taskManager.focus' },
            { label: '$(symbol-operator) Calculator', description: '', command: 'vscodeos.apps.calculator' },
            { label: '$(note) Notepad', description: '', command: 'vscodeos.apps.notepad' },
            { label: '$(paintcan) Paint', description: '', command: 'vscodeos.apps.paint' },
            { label: '$(device-camera) Screenshot', description: '', command: 'vscodeos.apps.screenshot' },
            { label: '$(mic) Voice Recorder', description: '', command: 'vscodeos.apps.recorder' },
        ];
        const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Open an app' });
        if (picked) {
            await vscode.commands.executeCommand(picked.command);
        }
    }

    // ---------------------------------------------------------------- paint

    private async handlePaint(message: WebviewMessage, panel: vscode.WebviewPanel): Promise<void> {
        if (message.type === 'savePng') {
            const target = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(path.join(os.homedir(), 'Pictures', `drawing-${stamp()}.png`)),
                filters: { Images: ['png'] },
            });
            if (!target) {
                return;
            }
            const base64 = message.dataUrl.replace(/^data:image\/png;base64,/, '');
            await fs.mkdir(path.dirname(target.fsPath), { recursive: true });
            await fs.writeFile(target.fsPath, Buffer.from(base64, 'base64'));
            void vscode.window.showInformationMessage(`Saved ${path.basename(target.fsPath)}`);
            return;
        }

        if (message.type === 'openImage') {
            const picked = await vscode.window.showOpenDialog({
                canSelectMany: false,
                filters: { Images: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'] },
            });
            const file = picked?.[0];
            if (!file) {
                return;
            }
            // Read it ourselves and hand over a data URI: the picked file is
            // almost never under localResourceRoots, and widening those to the
            // whole filesystem for one image would be the wrong trade.
            const bytes = await fs.readFile(file.fsPath);
            const mime = mimeFor(file.fsPath);
            void panel.webview.postMessage({
                type: 'image',
                uri: `data:${mime};base64,${bytes.toString('base64')}`,
                name: path.basename(file.fsPath),
            });
        }
    }

    // -------------------------------------------------------------- notepad

    private async handleNotepad(message: WebviewMessage, panel: vscode.WebviewPanel): Promise<void> {
        switch (message.type) {
            case 'saveNote': {
                let target = message.path;
                if (!target || message.saveAs) {
                    const directory = this.directory('notepad.directory', '~/Documents');
                    await fs.mkdir(directory, { recursive: true });
                    const picked = await vscode.window.showSaveDialog({
                        defaultUri: vscode.Uri.file(path.join(directory, `note-${stamp()}.txt`)),
                        filters: { Text: ['txt', 'md'] },
                    });
                    if (!picked) {
                        return;
                    }
                    target = picked.fsPath;
                }
                await fs.mkdir(path.dirname(target), { recursive: true });
                await fs.writeFile(target, message.text, 'utf8');
                void panel.webview.postMessage({ type: 'note', path: target, text: message.text, dirty: false });
                return;
            }

            case 'openNote': {
                const picked = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    defaultUri: vscode.Uri.file(this.directory('notepad.directory', '~/Documents')),
                });
                const file = picked?.[0];
                if (!file) {
                    return;
                }
                const text = await fs.readFile(file.fsPath, 'utf8');
                void panel.webview.postMessage({ type: 'note', path: file.fsPath, text, dirty: false });
                return;
            }

            case 'newNote':
                void panel.webview.postMessage({ type: 'note', path: undefined, text: '', dirty: false });
                return;

            case 'noteToEditor': {
                const document = await vscode.workspace.openTextDocument({ content: message.text, language: 'plaintext' });
                await vscode.window.showTextDocument(document, { preview: false });
                return;
            }

            default:
                return;
        }
    }

    // ----------------------------------------------------------- screenshot

    private async handleScreenshot(message: WebviewMessage, panel: vscode.WebviewPanel): Promise<void> {
        if (message.type === 'capture') {
            if (!screenshot.isAvailable()) {
                void panel.webview.postMessage({
                    type: 'shotError',
                    message: 'scrot is not installed. Run: sudo pacman -S scrot',
                });
                return;
            }

            const directory = this.directory('screenshot.directory', '~/Pictures/Screenshots');
            const target = path.join(directory, `screenshot-${stamp()}.png`);

            // Get our own window out of the shot before scrot fires.
            const wasVisible = panel.visible;
            if (message.mode !== 'region' && wasVisible) {
                await vscode.commands.executeCommand('workbench.action.closePanel');
            }
            await new Promise((resolve) => setTimeout(resolve, 200));

            const result = await screenshot.capture(message.mode, target, message.delay);
            if (!result.ok || !result.path) {
                void panel.webview.postMessage({ type: 'shotError', message: result.message ?? 'Capture failed.' });
                return;
            }
            this.lastShot = result.path;
            panel.reveal();
            void panel.webview.postMessage({
                type: 'shot',
                path: result.path,
                // Cache-bust: the panel keeps its context, and the same file name
                // would otherwise show the previous capture.
                uri: `${panel.webview.asWebviewUri(vscode.Uri.file(result.path))}?t=${Date.now()}`,
            });
            return;
        }

        if (message.type === 'saveShot') {
            const source = message.path || this.lastShot;
            if (!source) {
                return;
            }
            const target = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(path.join(os.homedir(), 'Pictures', path.basename(source))),
                filters: { Images: ['png'] },
            });
            if (target) {
                await fs.copyFile(source, target.fsPath);
                void vscode.window.showInformationMessage(`Saved ${path.basename(target.fsPath)}`);
            }
            return;
        }

        if (message.type === 'openExternal') {
            const target = message.path || this.lastShot;
            if (target && !openWithDefaultApp(target)) {
                void vscode.window.showWarningMessage('xdg-open is not available.');
            }
        }
    }

    // ------------------------------------------------------------- recorder

    private async handleRecorder(message: WebviewMessage, panel: vscode.WebviewPanel): Promise<void> {
        const directory = this.directory('recorder.directory', '~/Music/Recordings');

        switch (message.type) {
            case 'ready':
                void panel.webview.postMessage(this.recorderState());
                await this.sendRecordings(panel, directory);
                return;

            case 'record': {
                const target = path.join(directory, `recording-${stamp()}.wav`);
                const result = await this.recorder.startRecording(target);
                if (!result.ok) {
                    void panel.webview.postMessage({ type: 'recordError', message: result.message ?? 'Could not start.' });
                    return;
                }
                void panel.webview.postMessage(this.recorderState());
                return;
            }

            case 'stopRecording': {
                const result = await this.recorder.stopRecording();
                void panel.webview.postMessage(this.recorderState());
                if (!result.ok) {
                    void panel.webview.postMessage({ type: 'recordError', message: result.message ?? 'Nothing recorded.' });
                } else if (result.path) {
                    void panel.webview.postMessage({
                        type: 'recording',
                        state: 'idle',
                        path: result.path,
                        uri: `${panel.webview.asWebviewUri(vscode.Uri.file(result.path))}?t=${Date.now()}`,
                    });
                }
                await this.sendRecordings(panel, directory);
                return;
            }

            case 'listRecordings':
                await this.sendRecordings(panel, directory);
                return;

            case 'deleteRecording':
                await fs.rm(message.path, { force: true });
                await this.sendRecordings(panel, directory);
                return;

            default:
                return;
        }
    }

    private recorderState(): { type: 'recording'; state: 'idle' | 'recording'; startedAt?: number } {
        const active = this.recorder.recording;
        return active
            ? { type: 'recording', state: 'recording', startedAt: active.startedAt }
            : { type: 'recording', state: 'idle' };
    }

    private async sendRecordings(panel: vscode.WebviewPanel, directory: string): Promise<void> {
        let names: string[] = [];
        try {
            names = (await fs.readdir(directory)).filter((n) => /\.(wav|flac|ogg)$/i.test(n)).sort().reverse();
        } catch {
            /* nothing recorded yet */
        }
        void panel.webview.postMessage({
            type: 'recordings',
            items: names.map((name) => {
                const full = path.join(directory, name);
                return { name, path: full, uri: String(panel.webview.asWebviewUri(vscode.Uri.file(full))) };
            }),
        });
    }

    // ---------------------------------------------------------------- misc

    private directory(setting: string, fallback: string): string {
        const configured = vscode.workspace.getConfiguration('vscodeos').get<string>(setting, fallback) || fallback;
        return expandHome(configured, os.homedir());
    }

    /** Directories the webviews load from have to exist before the panel opens. */
    async ensureDirectories(): Promise<void> {
        for (const [setting, fallback] of [
            ['screenshot.directory', '~/Pictures/Screenshots'],
            ['recorder.directory', '~/Music/Recordings'],
        ] as const) {
            try {
                await fs.mkdir(this.directory(setting, fallback), { recursive: true });
            } catch (error) {
                log.debug(`could not create the ${setting} directory: ${String(error)}`);
            }
        }
    }

    dispose(): void {
        this.recorder.dispose();
    }
}

function stamp(): string {
    return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function mimeFor(file: string): string {
    switch (path.extname(file).toLowerCase()) {
        case '.jpg':
        case '.jpeg': return 'image/jpeg';
        case '.gif': return 'image/gif';
        case '.bmp': return 'image/bmp';
        case '.webp': return 'image/webp';
        default: return 'image/png';
    }
}
