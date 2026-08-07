// Panel plumbing shared by every mini-app.
//
// Each app is a single reusable webview panel: opening it twice reveals the one
// that is already there rather than stacking tabs, which is how a desktop app
// behaves and what makes the app launcher feel like a launcher.

import * as vscode from 'vscode';
import { render, webviewOptions } from '../webview/html';
import type { PageOptions } from '../webview/html';
import type { WebviewMessage } from '../webview/protocol';

export interface AppOptions {
    id: string;
    title: string;
    script: string;
    icon?: string;
    /** Extra directories the page may load resources from (saved shots, recordings). */
    localRoots?: vscode.Uri[];
    csp?: PageOptions['csp'];
    onMessage?: (message: WebviewMessage, panel: vscode.WebviewPanel) => void | Promise<void>;
    onDispose?: () => void;
}

export class AppPanels implements vscode.Disposable {
    private readonly panels = new Map<string, vscode.WebviewPanel>();

    constructor(private readonly context: vscode.ExtensionContext) {}

    open(options: AppOptions): vscode.WebviewPanel {
        const existing = this.panels.get(options.id);
        if (existing) {
            existing.reveal();
            return existing;
        }

        const panel = vscode.window.createWebviewPanel(
            `vscodeos.${options.id}`,
            options.title,
            vscode.ViewColumn.Active,
            {
                ...webviewOptions(this.context, options.localRoots ?? []),
                retainContextWhenHidden: true,
            },
        );
        if (options.icon) {
            panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'icons', `${options.icon}.svg`);
        }
        panel.webview.html = render(panel.webview, this.context, {
            title: options.title,
            script: options.script,
            csp: options.csp,
        });
        if (options.onMessage) {
            panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
                void options.onMessage?.(message, panel);
            });
        }
        panel.onDidDispose(() => {
            this.panels.delete(options.id);
            options.onDispose?.();
        });

        this.panels.set(options.id, panel);
        return panel;
    }

    get(id: string): vscode.WebviewPanel | undefined {
        return this.panels.get(id);
    }

    /**
     * Widen (or narrow) the directories a live panel may load files from.
     *
     * The media player needs this: `localResourceRoots` is fixed when a webview
     * is created, but the player has to reach whichever directory the next file
     * happens to be in, and a video is far too big to hand over as a data URI the
     * way the paint app does with images. Reassigning `options` reloads the page,
     * so the HTML is re-rendered and the caller waits for the fresh `ready`.
     */
    setLocalRoots(id: string, roots: vscode.Uri[], options: AppOptions): boolean {
        const panel = this.panels.get(id);
        if (!panel) {
            return false;
        }
        // retainContextWhenHidden is a panel option, not a webview one, and was
        // set when the panel was created; only the roots change here.
        panel.webview.options = webviewOptions(this.context, roots);
        panel.webview.html = render(panel.webview, this.context, {
            title: options.title,
            script: options.script,
            csp: options.csp,
        });
        return true;
    }

    dispose(): void {
        for (const panel of this.panels.values()) {
            panel.dispose();
        }
        this.panels.clear();
    }
}
