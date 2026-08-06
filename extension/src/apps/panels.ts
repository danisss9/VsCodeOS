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

    dispose(): void {
        for (const panel of this.panels.values()) {
            panel.dispose();
        }
        this.panels.clear();
    }
}
