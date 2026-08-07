// System Settings.
//
// The desktop's control panel: the screen, the keyboard, the sound devices, the
// disk, updates and what this machine actually is. It exists because those
// settings had nowhere to live - display control was a night-light toggle in a
// tray card, the keyboard was not configurable at all, and the Updater was a
// whole app of its own for four rows and a log.
//
// One webview with a rail down the left, rather than six apps. Every pane is
// asked for only when it is opened: `du` over a home directory and a `pkexec`
// round trip for the package cache are not things to do because someone wanted
// to change their keyboard layout.

import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as audio from '../sys/audio';
import * as backlight from '../sys/backlight';
import * as display from '../sys/display';
import * as keyboard from '../sys/keyboard';
import * as storage from '../sys/storage';
import { start, which } from '../sys/exec';
import { AppPanels } from './panels';
import type { AppOptions } from './panels';
import { UpdatesController } from './settings/updates';
import type {
    AboutInfo,
    CleanupId,
    HostMessage,
    SettingsSection,
    SettingsState,
    WebviewMessage,
} from '../webview/protocol';
import { log } from '../log';

const PANEL: AppOptions = {
    id: 'settings',
    title: 'System Settings',
    script: 'settings',
    icon: 'settings',
};

/** How long a new display mode is on trial before it is put back. */
const MODE_REVERT_MS = 15000;

export class SystemSettings {
    private section: SettingsSection = 'display';
    private readonly updates = new UpdatesController((message) => this.post(message));

    constructor(private readonly panels: AppPanels) {}

    open(section?: SettingsSection): void {
        if (section) {
            this.section = section;
        }
        const existing = this.panels.get(PANEL.id) !== undefined;
        this.panels.open({ ...PANEL, onMessage: (message) => this.handle(message) });
        if (existing) {
            // Already open on another pane: jump it, since the page will not
            // send a fresh `ready`.
            this.post({ type: 'settings', state: { section: this.section } });
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
                    await this.refresh();
                    return;

                case 'settingsSection':
                    this.section = message.section;
                    await this.refresh();
                    return;

                case 'setDisplayMode':
                    await this.changeMode(message);
                    return;

                case 'setKeyboardLayout':
                    await this.changeLayout(message.code, message.variant);
                    return;

                case 'setKeyRepeat':
                    await keyboard.setRepeat(message.repeat);
                    await vscode.workspace.getConfiguration('vscodeos').update(
                        'keyboard.repeatDelay',
                        message.repeat.delay,
                        vscode.ConfigurationTarget.Global,
                    );
                    await vscode.workspace.getConfiguration('vscodeos').update(
                        'keyboard.repeatRate',
                        message.repeat.rate,
                        vscode.ConfigurationTarget.Global,
                    );
                    await this.refresh();
                    return;

                // Sound: the same messages the volume flyout sends, so the two
                // stay in step without a second set of handlers.
                case 'volume':
                    await audio.setVolume(message.value);
                    await this.refresh();
                    return;
                case 'mute':
                    await audio.toggleMute();
                    await this.refresh();
                    return;
                case 'sink':
                    await audio.setDefaultSink(message.id);
                    await this.refresh();
                    return;
                case 'source':
                    await audio.setDefaultSource(message.id);
                    await this.refresh();
                    return;
                case 'micVolume':
                    await audio.setInputVolume(message.value);
                    await this.refresh();
                    return;
                case 'micMute':
                    await audio.toggleInputMute();
                    await this.refresh();
                    return;

                case 'cleanStorage':
                    await this.clean(message.ids);
                    return;

                case 'revealPath':
                    await vscode.commands.executeCommand('vscodeos.files.open', message.path);
                    return;

                case 'checkUpdates':
                case 'runUpdate':
                case 'restart':
                    await this.updates.handle(message);
                    return;

                default:
                    return;
            }
        } catch (error) {
            log.error('system settings', error);
            void vscode.window.showErrorMessage(
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    // ---------------------------------------------------------------- reading

    private async refresh(): Promise<void> {
        const state: SettingsState = { section: this.section };

        switch (this.section) {
            case 'display': {
                const brightness = await backlight.getState();
                state.display = {
                    available: display.isAvailable(),
                    outputs: await display.listOutputs(),
                    nightLight: display.isNightLightOn(),
                    energySaver: display.isEnergySaverOn(),
                    brightness: brightness.available && brightness.writable ? brightness.percent : undefined,
                };
                break;
            }
            case 'keyboard':
                state.keyboard = await keyboard.getState(this.repeatSetting());
                break;
            case 'sound':
                state.audio = await audio.getState();
                break;
            case 'storage':
                this.post({ type: 'settingsBusy', label: 'Measuring…' });
                state.storage = await storage.getState();
                break;
            case 'about':
                state.about = await this.about();
                break;
            default:
                break;
        }

        this.post({ type: 'settings', state });
    }

    private repeatSetting(): keyboard.RepeatRate {
        const config = vscode.workspace.getConfiguration('vscodeos');
        return {
            delay: config.get<number>('keyboard.repeatDelay', keyboard.DEFAULT_REPEAT.delay),
            rate: config.get<number>('keyboard.repeatRate', keyboard.DEFAULT_REPEAT.rate),
        };
    }

    private async about(): Promise<AboutInfo> {
        const [build, code] = await Promise.all([
            readText('/usr/share/vscodeos/build-info'),
            readText('/opt/visual-studio-code/resources/app/package.json'),
        ]);
        let codeVersion: string | undefined;
        try {
            codeVersion = code ? (JSON.parse(code) as { version?: string }).version : undefined;
        } catch {
            codeVersion = undefined;
        }

        const extension = vscode.extensions.getExtension('vscodeos.vscodeos-core');
        return {
            hostname: os.hostname(),
            kernel: os.release(),
            architecture: os.arch(),
            build: build?.trim() || undefined,
            codeVersion,
            shellVersion: String(extension?.packageJSON?.version ?? 'unknown'),
            cpu: os.cpus()[0]?.model,
            memoryBytes: os.totalmem(),
            uptimeSeconds: os.uptime(),
        };
    }

    // ---------------------------------------------------------------- writing

    /**
     * Change a display mode, then ask whether it worked.
     *
     * The kiosk sets DontVTSwitch, so a mode the monitor cannot show leaves no
     * console to escape to and no way back short of a power cycle. The old mode
     * is captured first and put back if the confirmation does not arrive, which
     * is the only thing that makes this safe to offer at all.
     */
    private async changeMode(request: {
        output: string;
        mode: string;
        rate?: number;
        rotation?: display.Rotation;
        primary?: boolean;
    }): Promise<void> {
        const before = (await display.listOutputs()).find((o) => o.name === request.output);
        const result = await display.applyMode(request);
        if (!result.ok) {
            void vscode.window.showErrorMessage(result.message ?? 'The display mode could not be changed.');
            await this.refresh();
            return;
        }

        const keep = 'Keep these settings';
        const choice = await Promise.race([
            vscode.window.showWarningMessage(
                `${request.output} is now ${request.mode}. Keep it?`,
                { modal: true, detail: `Reverting in ${MODE_REVERT_MS / 1000} seconds if you do not answer.` },
                keep,
            ),
            new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), MODE_REVERT_MS)),
        ]);

        if (choice !== keep && before) {
            await display.restoreOutput(before);
        }
        await this.refresh();
    }

    private async changeLayout(code: string, variant?: string): Promise<void> {
        const result = await keyboard.setLayout({ code, variant });
        if (!result.ok) {
            void vscode.window.showErrorMessage(result.message ?? 'The keyboard layout could not be changed.');
        } else if (!result.persisted) {
            void vscode.window.showWarningMessage(
                'The layout is active now but will not survive a reboot: localectl is not available.',
            );
        }
        await this.refresh();
    }

    /**
     * Clean up. The unprivileged categories are done here; the three that need
     * root go through one pkexec of vscodeos-clean with the ids as its
     * arguments, so the user answers at most one authorisation.
     */
    private async clean(ids: CleanupId[]): Promise<void> {
        if (ids.length === 0) {
            return;
        }
        const privileged = ids.filter((id) => storage.isPrivileged(id));
        const plain = ids.filter((id) => !storage.isPrivileged(id));

        this.post({ type: 'settingsBusy', label: 'Cleaning up…' });

        for (const id of plain) {
            await storage.cleanUser(id);
        }

        if (privileged.length > 0) {
            if (!which('pkexec')) {
                void vscode.window.showErrorMessage('pkexec is not installed, so system files cannot be cleaned.');
            } else {
                await this.runCleanHelper(privileged);
            }
        }

        await this.refresh();
    }

    private runCleanHelper(ids: CleanupId[]): Promise<void> {
        return new Promise((resolve) => {
            this.post({ type: 'updateLog', chunk: `$ pkexec ${storage.cleanHelper} ${ids.join(' ')}\n` });
            const child = start('pkexec', [storage.cleanHelper, ...ids]);
            const feed = (chunk: Buffer | string): void => this.post({ type: 'updateLog', chunk: String(chunk) });
            child.stdout?.on('data', feed);
            child.stderr?.on('data', feed);
            child.on('error', (error) => this.post({ type: 'updateLog', chunk: `\n${String(error)}\n` }));
            child.on('close', (code) => {
                if (code !== 0) {
                    log.error(`vscodeos-clean exited with ${String(code)}`);
                    void vscode.window.showErrorMessage(
                        `Cleaning system files failed (vscodeos-clean exited with ${code ?? 'unknown'}).`,
                    );
                }
                resolve();
            });
        });
    }
}

async function readText(file: string): Promise<string | undefined> {
    try {
        return await fs.readFile(file, 'utf8');
    } catch {
        return undefined;
    }
}
