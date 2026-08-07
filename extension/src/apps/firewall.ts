// The Firewall app.
//
// A GUI over ufw. It exists because the images ship sshd and, until now, no
// packet filter at all - so a VS Code OS machine on someone else's network had
// nothing between it and that network, and the only way to change that was to
// install and learn ufw from a terminal.
//
// Every operation is privileged (see src/sys/firewall.ts), so this refreshes on
// open and after each change rather than polling.

import * as vscode from 'vscode';
import * as firewall from '../sys/firewall';
import { AppPanels } from './panels';
import type { AppOptions } from './panels';
import type { FirewallState, HostMessage, WebviewMessage } from '../webview/protocol';
import { log } from '../log';

const PANEL: AppOptions = {
    id: 'firewall',
    title: 'Firewall',
    script: 'firewall',
    icon: 'firewall',
};

export class Firewall {
    private busy = false;

    constructor(private readonly panels: AppPanels) {}

    open(): void {
        const existing = this.panels.get(PANEL.id) !== undefined;
        this.panels.open({ ...PANEL, onMessage: (message) => this.handle(message) });
        if (existing) {
            void this.refresh();
        }
    }

    private post(message: HostMessage): void {
        void this.panels.get(PANEL.id)?.webview.postMessage(message);
    }

    private async handle(message: WebviewMessage): Promise<void> {
        try {
            switch (message.type) {
                case 'ready':
                case 'firewallRefresh':
                    await this.refresh();
                    return;

                case 'firewallToggle':
                    await this.toggle(message.enabled);
                    return;

                case 'firewallPolicy':
                    await this.change(
                        [message.direction === 'incoming' ? 'default-incoming' : 'default-outgoing', message.policy],
                    );
                    return;

                case 'firewallRule':
                    if (!firewall.isValidSpec(message.spec)) {
                        void vscode.window.showErrorMessage(
                            `"${message.spec}" is not a port, a port range or an application profile.`,
                        );
                        return;
                    }
                    await this.change([message.action, message.spec]);
                    return;

                case 'firewallDelete': {
                    const choice = await vscode.window.showWarningMessage(
                        `Delete firewall rule ${message.number}?`,
                        { modal: true, detail: message.label },
                        'Delete rule',
                    );
                    if (choice === 'Delete rule') {
                        await this.change(['delete', String(message.number)]);
                    }
                    return;
                }

                case 'firewallLogging':
                    await this.change(['logging', message.enabled ? 'on' : 'off']);
                    return;

                case 'firewallReset': {
                    const choice = await vscode.window.showWarningMessage(
                        'Reset the firewall?',
                        {
                            modal: true,
                            detail: 'Every rule is deleted and the firewall is turned off. This cannot be undone.',
                        },
                        'Reset everything',
                    );
                    if (choice === 'Reset everything') {
                        await this.change(['reset']);
                    }
                    return;
                }

                default:
                    return;
            }
        } catch (error) {
            log.error('firewall', error);
            void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        }
    }

    /**
     * Turning the firewall on is the one action that can cut the machine off
     * from whoever is using it. The default incoming policy is deny, so a Pi
     * being administered over SSH goes dark the moment this is switched on
     * unless port 22 is already allowed.
     */
    private async toggle(enabled: boolean): Promise<void> {
        if (enabled) {
            const status = await firewall.getStatus();
            const allowsSsh = (status?.rules ?? []).some(
                (rule) => /^(22(\/tcp)?|OpenSSH)\b/i.test(rule.to) && rule.action.startsWith('ALLOW'),
            );
            if (!allowsSsh && (await firewall.sshIsListening())) {
                const choice = await vscode.window.showWarningMessage(
                    'Turning the firewall on will block incoming SSH.',
                    {
                        modal: true,
                        detail:
                            'This machine is accepting SSH connections and no rule allows them through. '
                            + 'If you are working on it remotely you will be disconnected and will not be able to reconnect.',
                    },
                    'Allow SSH, then turn on',
                    'Turn on anyway',
                );
                if (!choice) {
                    return;
                }
                if (choice === 'Allow SSH, then turn on') {
                    await this.change(['allow', '22/tcp'], false);
                }
            }
        }
        await this.change([enabled ? 'enable' : 'disable']);
    }

    private async change(args: string[], refresh = true): Promise<void> {
        if (this.busy) {
            return;
        }
        this.busy = true;
        this.post({ type: 'firewallBusy', busy: true });
        try {
            const result = await firewall.apply(args, (chunk) => this.post({ type: 'firewallLog', chunk }));
            if (!result.ok) {
                void vscode.window.showErrorMessage(result.message ?? 'The firewall could not be changed.');
            }
        } finally {
            this.busy = false;
        }
        if (refresh) {
            await this.refresh();
        }
    }

    private async refresh(): Promise<void> {
        const state: FirewallState = {
            installed: firewall.isAvailable(),
            canElevate: firewall.canElevate(),
            busy: this.busy,
        };
        if (state.installed && state.canElevate) {
            state.status = await firewall.getStatus();
            state.sshListening = await firewall.sshIsListening();
        }
        this.post({ type: 'firewall', state });
    }
}
