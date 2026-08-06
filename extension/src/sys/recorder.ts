// Microphone capture.
//
// This has to be a subprocess. VS Code's Electron main process omits 'media'
// from the permission set it grants webviews, so getUserMedia({audio:true})
// inside a webview is denied unconditionally and silently - the recorder UI is
// a webview, but the capture is pw-record (PipeWire, already installed) with
// arecord as the ALSA fallback. Playing the finished file back in the webview is
// fine; only capture is blocked.

import type { ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { start, which } from './exec';
import { log } from '../log';

export interface RecordingHandle {
    path: string;
    startedAt: number;
}

export function isAvailable(): boolean {
    return which('pw-record') !== undefined || which('arecord') !== undefined;
}

export class Recorder {
    private child: ChildProcess | undefined;
    private current: RecordingHandle | undefined;
    private stderr = '';

    get recording(): RecordingHandle | undefined {
        return this.current;
    }

    async startRecording(targetPath: string): Promise<{ ok: boolean; message?: string }> {
        if (this.child) {
            return { ok: false, message: 'Already recording.' };
        }
        const slash = targetPath.lastIndexOf('/');
        await fs.mkdir(slash > 0 ? targetPath.slice(0, slash) : '/', { recursive: true });

        let command: string;
        let args: string[];
        if (which('pw-record')) {
            command = 'pw-record';
            args = ['--target', '@DEFAULT_SOURCE@', '--rate', '48000', '--channels', '1', '--format', 's16', targetPath];
        } else if (which('arecord')) {
            command = 'arecord';
            args = ['-f', 'cd', '-t', 'wav', targetPath];
        } else {
            return { ok: false, message: 'No recorder found - install pipewire or alsa-utils.' };
        }

        this.stderr = '';
        const child = start(command, args);
        child.stderr?.on('data', (chunk: Buffer) => {
            this.stderr += chunk.toString();
        });
        child.on('error', (error) => {
            log.error(`${command} failed to start`, error);
            this.child = undefined;
            this.current = undefined;
        });

        this.child = child;
        this.current = { path: targetPath, startedAt: Date.now() };

        // A recorder that dies on the first buffer should not look like it is running.
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (child.exitCode !== null) {
            this.child = undefined;
            this.current = undefined;
            return { ok: false, message: this.stderr.trim().split('\n')[0] || `${command} exited immediately` };
        }
        return { ok: true };
    }

    /** SIGINT, not SIGKILL: the recorder has to rewrite the WAV header on the way out. */
    async stopRecording(): Promise<{ ok: boolean; path?: string; message?: string }> {
        const child = this.child;
        const handle = this.current;
        if (!child || !handle) {
            return { ok: false, message: 'Not recording.' };
        }
        this.child = undefined;
        this.current = undefined;

        await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                child.kill('SIGKILL');
                resolve();
            }, 5000);
            child.once('exit', () => {
                clearTimeout(timer);
                resolve();
            });
            child.kill('SIGINT');
        });

        try {
            const stat = await fs.stat(handle.path);
            if (stat.size <= 44) {
                await fs.rm(handle.path, { force: true });
                return { ok: false, message: 'Nothing was recorded - is a microphone connected?' };
            }
        } catch {
            return { ok: false, message: this.stderr.trim().split('\n')[0] || 'the recording was not written' };
        }
        return { ok: true, path: handle.path };
    }

    dispose(): void {
        this.child?.kill('SIGKILL');
        this.child = undefined;
        this.current = undefined;
    }
}
