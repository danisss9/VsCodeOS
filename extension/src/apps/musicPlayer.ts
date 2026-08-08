// Music.
//
// What used to be here was two buttons: one opened Spotify Web in a browser
// window, the other YouTube Music. Neither is a music player - they are
// bookmarks - and neither works on a machine with no network, which a kiosk
// often is. This plays the files on the disk.
//
// The Media Player next door opens one file and lists its folder. This is the
// other shape: a library, scanned once from ~/Music, searchable, with a queue
// that survives moving between albums. They share `mediaKind()` so the two
// never disagree about what is audio, and the Files app still routes a
// double-clicked track to the Media Player - opening one file is what that app
// is for.
//
// `localResourceRoots` is the library directory and nothing else, fixed when
// the panel opens. That is the whole reason this is a separate app from the
// Media Player, which has to widen its roots per file and reload the page each
// time it does.

import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expandHome } from '../util/format';
import { mediaKind } from '../util/media';
import { AppPanels } from './panels';
import type { AppOptions } from './panels';
import type { HostMessage, MusicLibrary, Track, WebviewMessage } from '../webview/protocol';
import { log } from '../log';

const PANEL: AppOptions = {
    id: 'music',
    title: 'Music',
    script: 'music',
    icon: 'music',
};

/**
 * A library that is a whole disk is a scan that never ends, and the answer
 * nobody wants. Deep enough for Artist/Album/Disc 1, wide enough for a real
 * collection.
 */
const MAX_DEPTH = 5;
const MAX_TRACKS = 5000;

export class MusicPlayer {
    private library: MusicLibrary | undefined;

    constructor(private readonly panels: AppPanels) {}

    private get directory(): string {
        const configured = vscode.workspace.getConfiguration('vscodeos')
            .get<string>('music.directory', '~/Music') || '~/Music';
        return expandHome(configured, os.homedir());
    }

    open(): void {
        const existed = this.panels.get(PANEL.id) !== undefined;
        this.panels.open({
            ...PANEL,
            localRoots: [vscode.Uri.file(this.directory)],
            onMessage: (message) => this.handle(message),
        });
        if (existed) {
            // A revealed panel sends no second `ready`, so push what it has.
            void this.send();
        }
    }

    private post(message: HostMessage): void {
        void this.panels.get(PANEL.id)?.webview.postMessage(message);
    }

    private async handle(message: WebviewMessage): Promise<void> {
        try {
            switch (message.type) {
                case 'ready':
                    await this.send();
                    return;

                case 'musicRefresh':
                    this.library = undefined;
                    await this.send();
                    return;

                case 'musicChooseFolder':
                    await this.chooseFolder();
                    return;

                case 'revealPath':
                    await vscode.commands.executeCommand('vscodeos.files.open', message.path);
                    return;

                default:
                    return;
            }
        } catch (error) {
            log.error('music', error);
            void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        }
    }

    /**
     * Point the library somewhere else, for good.
     *
     * The setting is the record rather than a field on this object, because the
     * roots a webview may read from are fixed when it is created - so changing
     * the folder means a new panel, and the new panel has to be able to find out
     * where to look.
     */
    private async chooseFolder(): Promise<void> {
        const picked = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            defaultUri: vscode.Uri.file(this.directory),
            openLabel: 'Use this folder',
        });
        const chosen = picked?.[0]?.fsPath;
        if (!chosen || chosen === this.directory) {
            return;
        }
        await vscode.workspace.getConfiguration('vscodeos')
            .update('music.directory', chosen, vscode.ConfigurationTarget.Global);
        this.library = undefined;
        this.panels.get(PANEL.id)?.dispose();
        this.open();
    }

    private async send(): Promise<void> {
        const panel = this.panels.get(PANEL.id);
        if (!panel) {
            return;
        }
        if (!this.library) {
            this.library = await this.scan(panel);
        }
        this.post({ type: 'music', library: this.library });
    }

    private async scan(panel: vscode.WebviewPanel): Promise<MusicLibrary> {
        const directory = this.directory;
        const tracks: Track[] = [];
        let truncated = false;

        const walk = async (current: string, depth: number): Promise<void> => {
            if (depth > MAX_DEPTH || tracks.length >= MAX_TRACKS) {
                return;
            }
            let entries: import('node:fs').Dirent[];
            try {
                entries = await fs.readdir(current, { withFileTypes: true });
            } catch (error) {
                log.debug(`music: could not read ${current}: ${String(error)}`);
                return;
            }
            // Files before directories, so a flat ~/Music is listed in full
            // before the scan disappears into the first subfolder.
            const names = entries.slice().sort((a, b) =>
                Number(a.isDirectory()) - Number(b.isDirectory())
                || a.name.localeCompare(b.name, undefined, { numeric: true }));

            for (const entry of names) {
                if (tracks.length >= MAX_TRACKS) {
                    truncated = true;
                    return;
                }
                if (entry.name.startsWith('.')) {
                    continue;
                }
                const full = path.join(current, entry.name);
                if (entry.isDirectory()) {
                    await walk(full, depth + 1);
                } else if (mediaKind(entry.name) === 'audio') {
                    tracks.push({
                        name: entry.name.replace(/\.[^.]+$/, ''),
                        path: full,
                        uri: String(panel.webview.asWebviewUri(vscode.Uri.file(full))),
                        folder: current === directory ? '' : path.basename(current),
                    });
                }
            }
        };

        try {
            await fs.access(directory);
        } catch {
            return { directory, tracks: [], error: `${directory} does not exist yet.` };
        }

        await walk(directory, 0);
        return { directory, tracks, truncated };
    }
}
