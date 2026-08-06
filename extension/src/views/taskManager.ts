// Task Manager: processes, CPU, memory, in the activity bar.
//
// Sampling only runs while the view is actually visible - a hidden Task Manager
// that keeps reading a few hundred /proc entries every two seconds would be a
// silly thing to ship on a Pi.

import * as vscode from 'vscode';
import { SystemSampler, endProcess } from '../sys/procfs';
import { render, webviewOptions } from '../webview/html';
import type { WebviewMessage } from '../webview/protocol';
import { log } from '../log';

export class TaskManagerProvider implements vscode.WebviewViewProvider {
    static readonly viewId = 'vscodeos.taskManager';

    private view: vscode.WebviewView | undefined;
    private readonly sampler = new SystemSampler();
    private timer: NodeJS.Timeout | undefined;
    private paused = false;
    private sampling = false;

    constructor(private readonly context: vscode.ExtensionContext) {}

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options = webviewOptions(this.context);
        view.webview.html = render(view.webview, this.context, { title: 'Task Manager', script: 'taskmanager' });

        view.webview.onDidReceiveMessage((message: WebviewMessage) => void this.handle(message));

        view.onDidChangeVisibility(() => (view.visible ? this.resume() : this.suspend()));
        view.onDidDispose(() => {
            this.suspend();
            this.view = undefined;
        });

        if (view.visible) {
            this.resume();
        }
    }

    private resume(): void {
        if (this.timer || this.paused) {
            return;
        }
        // Deltas from before the pause would show as a spike; start clean.
        this.sampler.reset();
        void this.sample();
        const interval = vscode.workspace
            .getConfiguration('vscodeos')
            .get<number>('taskManager.refreshInterval', 2000);
        this.timer = setInterval(() => void this.sample(), Math.max(500, interval));
    }

    private suspend(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    private async sample(): Promise<void> {
        if (!this.view?.visible || this.sampling) {
            return;
        }
        this.sampling = true;
        try {
            const { system, processes } = await this.sampler.sample();
            void this.view.webview.postMessage({ type: 'tasks', system, processes });
        } catch (error) {
            log.error('task manager sample failed', error);
            void this.view?.webview.postMessage({
                type: 'taskError',
                message: error instanceof Error ? error.message : String(error),
            });
        } finally {
            this.sampling = false;
        }
    }

    private async handle(message: WebviewMessage): Promise<void> {
        switch (message.type) {
            case 'ready':
                await this.sample();
                return;

            case 'pause':
                this.paused = message.paused;
                if (this.paused) {
                    this.suspend();
                } else {
                    this.resume();
                }
                return;

            case 'endTask': {
                const choice = await vscode.window.showWarningMessage(
                    `End "${message.name}" (PID ${message.pid})?`,
                    { modal: true, detail: 'Unsaved work in that process will be lost.' },
                    'End task',
                );
                if (choice !== 'End task') {
                    return;
                }
                const result = await endProcess(message.pid);
                if (!result.ok) {
                    if (result.error === 'permission denied') {
                        await this.offerRootKill(message.pid, message.name);
                    } else {
                        void vscode.window.showErrorMessage(`Could not end ${message.name}: ${result.error}`);
                    }
                }
                await this.sample();
                return;
            }

            case 'endTaskAsRoot':
                await this.offerRootKill(message.pid, message.name);
                return;

            default:
                return;
        }
    }

    /**
     * Root-owned processes cannot be signalled from here, and there is no polkit
     * agent in the kiosk session for pkexec to talk to. A terminal with the
     * command pre-filled is the honest option: sudo is passwordless on the live
     * medium and prompts on an installed system, and either way the user sees
     * exactly what is about to run.
     */
    private async offerRootKill(pid: number, name: string): Promise<void> {
        const choice = await vscode.window.showWarningMessage(
            `"${name}" (PID ${pid}) belongs to another user.`,
            { modal: true, detail: 'Ending it needs root. A terminal will open with the command ready to run.' },
            'Open terminal',
        );
        if (choice !== 'Open terminal') {
            return;
        }
        const terminal = vscode.window.createTerminal({ name: 'End task' });
        terminal.show();
        // Not sent with a newline on purpose: the user presses Enter themselves.
        terminal.sendText(`sudo kill -9 ${pid}`, false);
    }

    dispose(): void {
        this.suspend();
    }
}
