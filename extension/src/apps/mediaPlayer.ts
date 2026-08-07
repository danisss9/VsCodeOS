// The media player.
//
// A webview with one <video> element in it, which plays audio just as well as
// video. This exists because the Files app now opens everything in the editor
// and the editor has no player: text goes to the text editor, images to VS
// Code's built-in preview, and everything with a soundtrack comes here.
//
// The awkward part is `localResourceRoots`. A webview may only load files from
// directories fixed when it was created, and the paint app's trick of reading
// the bytes and handing over a data URI is not available to a player - these
// files are hundreds of megabytes. So the roots follow the file: opening
// something outside the current roots reloads the page with wider ones.

import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openWithDefaultApp } from '../sys/browser';
import { mediaFilterExtensions, mediaKind } from '../util/media';
import { AppPanels } from './panels';
import type { AppOptions } from './panels';
import type { HostMessage, WebviewMessage } from '../webview/protocol';
import { log } from '../log';

const PANEL: AppOptions = {
    id: 'player',
    title: 'Media Player',
    script: 'player',
    icon: 'player',
};

export class MediaPlayer {
    private current: string | undefined;
    private roots: string[] = [];

    constructor(private readonly panels: AppPanels) {}

    async open(target?: string): Promise<void> {
        const file = target ?? (await this.pick());
        if (!file && !this.panels.get(PANEL.id)) {
            // Nothing chosen and nothing open: show the empty player rather than
            // silently doing nothing, so the launcher entry always does something.
            this.panels.open({ ...PANEL, localRoots: this.rootUris(), onMessage: (m) => this.handle(m) });
            return;
        }
        if (!file) {
            this.panels.get(PANEL.id)?.reveal();
            return;
        }

        const directory = path.dirname(file);
        const existed = this.panels.get(PANEL.id) !== undefined;
        const widened = this.remember(directory);

        this.current = file;
        this.panels.open({ ...PANEL, localRoots: this.rootUris(), onMessage: (m) => this.handle(m) });

        if (existed && widened) {
            // The page reloads, so `ready` will ask for the file again.
            this.panels.setLocalRoots(PANEL.id, this.rootUris(), PANEL);
            return;
        }
        if (existed) {
            await this.send();
        }
    }

    private defaultRoots(): string[] {
        const home = os.homedir();
        return [path.join(home, 'Videos'), path.join(home, 'Music'), path.join(home, 'Downloads')];
    }

    /**
     * Widen the roots to cover a directory, reporting whether that was needed.
     * A root covers its subdirectories, so most files under ~/Videos need no
     * change at all - and every change costs the page a reload.
     */
    private remember(directory: string): boolean {
        const covered = [...this.defaultRoots(), ...this.roots].some(
            (root) => directory === root || directory.startsWith(`${root}${path.sep}`),
        );
        if (covered) {
            return false;
        }
        this.roots.push(directory);
        // A page reload per new directory is fine; an unbounded root list is not.
        if (this.roots.length > 8) {
            this.roots.shift();
        }
        return true;
    }

    private rootUris(): vscode.Uri[] {
        return [...new Set([...this.defaultRoots(), ...this.roots])].map((directory) => vscode.Uri.file(directory));
    }

    private async pick(): Promise<string | undefined> {
        const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            defaultUri: vscode.Uri.file(path.join(os.homedir(), 'Videos')),
            filters: { Media: mediaFilterExtensions() },
            openLabel: 'Play',
        });
        return picked?.[0]?.fsPath;
    }

    private post(message: HostMessage): void {
        void this.panels.get(PANEL.id)?.webview.postMessage(message);
    }

    private async send(): Promise<void> {
        const panel = this.panels.get(PANEL.id);
        if (!panel || !this.current) {
            return;
        }
        const kind = mediaKind(this.current) ?? 'video';
        this.post({
            type: 'media',
            path: this.current,
            // Cache-bust: the panel retains its context, so replaying the same
            // file after a seek would otherwise resume the stale element.
            uri: `${panel.webview.asWebviewUri(vscode.Uri.file(this.current))}?t=${Date.now()}`,
            name: path.basename(this.current),
            kind,
        });
        await this.sendPlaylist(panel, path.dirname(this.current));
    }

    /** Everything playable next to the current file, so a folder acts like an album. */
    private async sendPlaylist(panel: vscode.WebviewPanel, directory: string): Promise<void> {
        let names: string[] = [];
        try {
            names = (await fs.readdir(directory)).filter((name) => mediaKind(name) !== undefined);
        } catch (error) {
            log.debug(`media player could not list ${directory}: ${String(error)}`);
        }
        names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        this.post({
            type: 'playlist',
            items: names.map((name) => {
                const full = path.join(directory, name);
                return {
                    name,
                    path: full,
                    uri: String(panel.webview.asWebviewUri(vscode.Uri.file(full))),
                    kind: mediaKind(name) ?? 'video',
                };
            }),
        });
    }

    private async handle(message: WebviewMessage): Promise<void> {
        switch (message.type) {
            case 'ready':
                await this.send();
                return;

            case 'openMedia': {
                const file = await this.pick();
                if (file) {
                    await this.open(file);
                }
                return;
            }

            case 'playMedia':
                this.current = message.path;
                await this.send();
                return;

            case 'openExternal':
                // The codec fallback: MKV and AVI containers are not something
                // Chromium demuxes, and shouting about it helps nobody.
                if (!openWithDefaultApp(message.path || this.current || '')) {
                    void vscode.window.showWarningMessage('xdg-open is not available.');
                }
                return;

            default:
                return;
        }
    }
}
