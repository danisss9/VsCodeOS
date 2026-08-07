// The Updates pane of System Settings.
//
// VS Code OS is updated from two places that know nothing about each other:
// pacman, for the Arch base, and a tarball from Microsoft, for the editor. Both
// were terminal-only once, which on a machine whose whole UI is the editor
// meant "read the README and type two commands".
//
// Checking is unprivileged on purpose. `checkupdates` computes pending package
// updates against a copy of the database rather than running `pacman -Sy`, which
// would leave the real database half-synced and the system one bad `-S` away
// from a partial upgrade. Applying is the only privileged half, and it goes
// through one script - see rootfs-common/usr/local/bin/vscodeos-update.

import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import * as https from 'node:https';
import * as os from 'node:os';
import { run, start, which } from '../../sys/exec';
import { parsePendingUpdates } from '../../util/parse';
import { codeUpdateUrl } from '../../util/url';
import { runPowerAction } from '../../views/flyout';
import type { HostMessage, UpdateItem, UpdateTarget, WebviewMessage } from '../../webview/protocol';
import { log } from '../../log';

const CODE_PREFIX = '/opt/visual-studio-code';
const UPDATE_HELPER = '/usr/local/bin/vscodeos-update';

/**
 * The updater's own state lives on the host rather than in the page, so closing
 * System Settings in the middle of a `pacman -Syu` and reopening it picks the
 * running update back up instead of losing it.
 */
export class UpdatesController {
    private running: UpdateTarget | undefined;
    private restartNeeded = false;

    /** `post` is supplied by whoever owns the panel; see apps/systemSettings.ts. */
    constructor(private readonly post: (message: HostMessage) => void) {}

    /** True while an update is applying, which the settings rail shows. */
    get isRunning(): boolean {
        return this.running !== undefined;
    }

    async handle(message: WebviewMessage): Promise<void> {
        switch (message.type) {
            case 'checkUpdates':
                await this.check();
                return;

            case 'runUpdate':
                await this.apply(message.target);
                return;

            case 'restart':
                if (message.mode === 'reboot') {
                    await runPowerAction('reboot');
                } else {
                    await runPowerAction('logout');
                }
                return;

            default:
                return;
        }
    }

    // ----------------------------------------------------------------- check

    async check(): Promise<void> {
        this.post({
            type: 'updateStatus',
            items: this.skeleton().map((item) => ({ ...item, status: 'checking' as const })),
            running: this.running,
        });

        const [packages, code, shell, kernel] = await Promise.all([
            this.checkPackages(),
            this.checkCode(),
            this.checkShell(),
            this.checkKernel(),
        ]);

        this.post({ type: 'updateStatus', items: [packages, code, shell, kernel], running: this.running });
    }

    private skeleton(): UpdateItem[] {
        return [
            { id: 'packages', title: 'System packages', description: 'The Arch Linux base', current: '', status: 'unknown', target: 'packages' },
            { id: 'code', title: 'Visual Studio Code', description: 'The editor this desktop is', current: '', status: 'unknown', target: 'code' },
            { id: 'shell', title: 'VS Code OS shell', description: 'The tray, apps and file manager', current: '', status: 'unknown', target: 'shell' },
            { id: 'kernel', title: 'Kernel', description: 'Updated with the system packages', current: '', status: 'unknown' },
        ];
    }

    private async checkPackages(): Promise<UpdateItem> {
        const base: UpdateItem = {
            id: 'packages',
            title: 'System packages',
            description: 'The Arch Linux base',
            current: '',
            status: 'unknown',
            target: 'packages',
        };

        if (!which('checkupdates')) {
            return {
                ...base,
                detail: 'checkupdates is not installed. Run: sudo pacman -S pacman-contrib',
            };
        }

        // checkupdates exits 2 when there is nothing to do, which run() reports
        // as a failure - so the exit code has to be read rather than `ok`.
        const result = await run('checkupdates', [], { timeout: 120000 });
        if (result.code === 2 || (result.ok && result.stdout.trim() === '')) {
            return { ...base, status: 'current', current: 'Up to date' };
        }
        if (!result.ok && result.code !== 0) {
            return { ...base, detail: firstLine(result.stderr) || 'could not reach the package mirrors' };
        }

        const pending = parsePendingUpdates(result.stdout);
        if (pending.count === 0) {
            return { ...base, status: 'current', current: 'Up to date' };
        }
        return {
            ...base,
            status: 'available',
            current: `${pending.count} update${pending.count === 1 ? '' : 's'}`,
            detail: pending.lines.join('\n'),
        };
    }

    private async checkCode(): Promise<UpdateItem> {
        const base: UpdateItem = {
            id: 'code',
            title: 'Visual Studio Code',
            description: 'The editor this desktop is',
            current: 'not installed',
            status: 'unknown',
            target: 'code',
        };

        const installed = await readJson<{ version?: string }>(`${CODE_PREFIX}/resources/app/package.json`);
        if (!installed?.version) {
            return { ...base, detail: `Nothing at ${CODE_PREFIX}.` };
        }

        const latest = await latestCodeVersion();
        if (!latest) {
            return { ...base, current: installed.version, status: 'unknown', detail: 'Could not reach update.code.visualstudio.com.' };
        }
        return {
            ...base,
            current: installed.version,
            latest,
            status: latest === installed.version ? 'current' : 'available',
        };
    }

    private async checkShell(): Promise<UpdateItem> {
        const extension = vscode.extensions.getExtension('vscodeos.vscodeos-core');
        const running = String(extension?.packageJSON?.version ?? 'unknown');
        // The staged copy is what a VS Code update would reinstall; when it is
        // newer than what is loaded, the editor is running a stale shell.
        const staged = await readJson<{ version?: string }>('/usr/share/vscodeos/extensions/vscodeos-core/package.json');
        const available = staged?.version && staged.version !== running;
        return {
            id: 'shell',
            title: 'VS Code OS shell',
            description: 'The tray, apps and file manager',
            current: running,
            latest: staged?.version,
            status: available ? 'available' : 'current',
            detail: available
                ? 'A newer shell is staged on disk but is not the one running.'
                : 'Reinstall this after a VS Code update if the tray disappears.',
            target: 'shell',
        };
    }

    private async checkKernel(): Promise<UpdateItem> {
        return {
            id: 'kernel',
            title: 'Kernel',
            description: 'Updated with the system packages',
            current: os.release(),
            status: 'current',
            detail: 'A kernel update needs a restart to take effect.',
        };
    }

    // ----------------------------------------------------------------- apply

    private async apply(target: UpdateTarget): Promise<void> {
        if (this.running) {
            void vscode.window.showInformationMessage(`An update is already running (${this.running}).`);
            return;
        }
        if (!which('pkexec')) {
            this.post({ type: 'updateDone', ok: false, needsRestart: false, message: 'pkexec is not installed.' });
            return;
        }

        this.running = target;
        this.post({ type: 'updateStatus', items: this.skeleton(), running: target });
        this.post({ type: 'updateLog', chunk: `$ pkexec ${UPDATE_HELPER} ${target}\n` });

        await new Promise<void>((resolve) => {
            const child = start('pkexec', [UPDATE_HELPER, target]);
            const feed = (chunk: Buffer | string): void => {
                this.post({ type: 'updateLog', chunk: String(chunk) });
            };
            child.stdout?.on('data', feed);
            child.stderr?.on('data', feed);

            child.on('error', (error) => {
                this.post({ type: 'updateLog', chunk: `\n${String(error)}\n` });
            });

            child.on('close', (code) => {
                const ok = code === 0;
                this.running = undefined;
                // Both of these replace files the running editor has open; only a
                // restart actually puts the new ones in front of the user.
                this.restartNeeded = this.restartNeeded || (ok && (target === 'code' || target === 'shell' || target === 'all'));
                this.post({
                    type: 'updateDone',
                    ok,
                    needsRestart: this.restartNeeded,
                    message: ok ? undefined : `vscodeos-update exited with status ${code ?? 'unknown'}.`,
                });
                if (!ok) {
                    log.error(`vscodeos-update ${target} failed with ${String(code)}`);
                }
                resolve();
            });
        });

        await this.check();
    }
}

function firstLine(text: string): string {
    return text.trim().split('\n')[0] ?? '';
}

async function readJson<T>(file: string): Promise<T | undefined> {
    try {
        return JSON.parse(await fs.readFile(file, 'utf8')) as T;
    } catch {
        return undefined;
    }
}

function latestCodeVersion(): Promise<string | undefined> {
    return new Promise((resolve) => {
        const request = https.get(codeUpdateUrl(), { timeout: 8000 }, (response) => {
            if (response.statusCode !== 200) {
                response.resume();
                resolve(undefined);
                return;
            }
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk: string) => {
                body += chunk;
                // Nothing legitimate is this big; stop before a bad endpoint can
                // fill memory.
                if (body.length > 64 * 1024) {
                    request.destroy();
                }
            });
            response.on('end', () => {
                try {
                    resolve((JSON.parse(body) as { productVersion?: string }).productVersion);
                } catch {
                    resolve(undefined);
                }
            });
        });
        request.on('timeout', () => request.destroy());
        request.on('error', () => resolve(undefined));
        request.on('close', () => resolve(undefined));
    });
}
