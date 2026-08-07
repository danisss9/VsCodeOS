// The Recycle Bin, in the activity bar.
//
// The same TrashService the Files app browses, in a view that is one click away
// rather than three. Restoring here redraws the Files app and vice versa,
// because both listen to the service's `change` event.
//
// Like the Task Manager, this only reads the trash while it is actually
// visible: a hidden view re-listing a bin full of files on every change would
// be work nobody asked for.

import * as vscode from 'vscode';
import { render, webviewOptions } from '../webview/html';
import type { TrashService } from '../sys/trash';
import type { WebviewMessage } from '../webview/protocol';
import { log } from '../log';

export class RecycleBinProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    static readonly viewId = 'vscodeos.recycleBin';

    private view: vscode.WebviewView | undefined;
    private readonly subscription: () => void;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly trash: TrashService,
    ) {
        const onChange = (): void => void this.refresh();
        this.trash.on('change', onChange);
        this.subscription = () => this.trash.off('change', onChange);
    }

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options = webviewOptions(this.context);
        view.webview.html = render(view.webview, this.context, {
            title: 'Recycle Bin',
            script: 'recyclebin',
        });

        view.webview.onDidReceiveMessage((message: WebviewMessage) => void this.handle(message));
        view.onDidChangeVisibility(() => {
            if (view.visible) {
                void this.refresh();
            }
        });
        view.onDidDispose(() => (this.view = undefined));
    }

    private async refresh(): Promise<void> {
        if (!this.view?.visible) {
            return;
        }
        try {
            const entries = await this.trash.list();
            void this.view.webview.postMessage({ type: 'trash', entries });
        } catch (error) {
            log.error('recycle bin', error);
        }
    }

    private async handle(message: WebviewMessage): Promise<void> {
        switch (message.type) {
            case 'ready':
                await this.refresh();
                return;

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
                return;
            }

            case 'deleteFromTrash': {
                const label = message.paths.length === 1 ? 'this item' : `${message.paths.length} items`;
                const choice = await vscode.window.showWarningMessage(
                    `Permanently delete ${label}?`,
                    { modal: true, detail: 'This cannot be undone.' },
                    'Delete permanently',
                );
                if (choice === 'Delete permanently') {
                    await this.trash.remove(message.paths);
                }
                return;
            }

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
                return;
            }

            case 'command':
                await vscode.commands.executeCommand(message.command);
                return;

            default:
                return;
        }
    }

    dispose(): void {
        this.subscription();
    }
}
