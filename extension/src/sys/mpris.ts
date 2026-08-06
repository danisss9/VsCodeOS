// Now-playing state and transport control over MPRIS.
//
// This is why the music player controls *real* players instead of embedding one:
// VS Code's Electron ships no Widevine CDM, so Spotify's Web Playback SDK cannot
// decrypt anything, and both open.spotify.com and music.youtube.com refuse to be
// framed. Chromium, however, exports MPRIS for whatever is playing in it - so a
// Spotify Web or YouTube Music tab launched as an app window is fully
// controllable from the status bar, with real audio and no API keys.

import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { output, run, start, which } from './exec';
import { log } from '../log';

export interface NowPlaying {
    player: string;
    status: 'Playing' | 'Paused' | 'Stopped';
    title: string;
    artist: string;
    album: string;
    artUrl: string;
    /** Seconds; 0 when the player does not report a length. */
    length: number;
    position: number;
}

const SEPARATOR = ''; // unit separator: cannot appear in a track title
const FORMAT = [
    '{{playerName}}',
    '{{status}}',
    '{{title}}',
    '{{artist}}',
    '{{album}}',
    '{{mpris:artUrl}}',
    '{{mpris:length}}',
].join(SEPARATOR);

export function isAvailable(): boolean {
    return which('playerctl') !== undefined;
}

export class MprisMonitor extends EventEmitter {
    private child: ChildProcess | undefined;
    private buffer = '';
    private state: NowPlaying | undefined;

    get current(): NowPlaying | undefined {
        return this.state;
    }

    /**
     * `playerctl --follow` streams a line per metadata change, so the status bar
     * updates the moment a track changes instead of polling once a second.
     */
    startWatching(): void {
        if (this.child || !isAvailable()) {
            return;
        }
        const child = start('playerctl', ['--follow', '--format', FORMAT, 'metadata']);
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => this.consume(chunk));
        child.on('error', (error) => log.debug(`playerctl --follow: ${error.message}`));
        child.on('exit', (code) => {
            log.debug(`playerctl --follow exited (${code})`);
            this.child = undefined;
            if (this.state) {
                this.state = undefined;
                this.emit('change', undefined);
            }
        });
        this.child = child;
    }

    private consume(chunk: string): void {
        this.buffer += chunk;
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() ?? '';
        for (const line of lines) {
            this.state = parseLine(line) ?? undefined;
            this.emit('change', this.state);
        }
    }

    /** Position is not part of the change stream; the open flyout asks for it. */
    async refreshPosition(): Promise<NowPlaying | undefined> {
        if (!this.state) {
            return undefined;
        }
        const [position, status] = await Promise.all([
            output('playerctl', ['position'], 3000),
            output('playerctl', ['status'], 3000),
        ]);
        const seconds = Number(position);
        if (Number.isFinite(seconds)) {
            this.state = { ...this.state, position: seconds };
        }
        if (status === 'Playing' || status === 'Paused' || status === 'Stopped') {
            this.state = { ...this.state, status };
        }
        return this.state;
    }

    dispose(): void {
        this.child?.kill();
        this.child = undefined;
        this.removeAllListeners();
    }
}

function parseLine(line: string): NowPlaying | null {
    const trimmed = line.trim();
    if (!trimmed || trimmed === 'No players found') {
        return null;
    }
    const parts = trimmed.split(SEPARATOR);
    if (parts.length < 7) {
        return null;
    }
    const status = parts[1] === 'Playing' || parts[1] === 'Paused' ? parts[1] : 'Stopped';
    return {
        player: parts[0] || 'player',
        status,
        title: parts[2] || 'Unknown track',
        artist: parts[3] || '',
        album: parts[4] || '',
        artUrl: parts[5] || '',
        // MPRIS lengths are microseconds.
        length: Number(parts[6]) > 0 ? Number(parts[6]) / 1_000_000 : 0,
        position: 0,
    };
}

export async function playPause(): Promise<void> {
    await run('playerctl', ['play-pause'], { timeout: 5000 });
}

export async function next(): Promise<void> {
    await run('playerctl', ['next'], { timeout: 5000 });
}

export async function previous(): Promise<void> {
    await run('playerctl', ['previous'], { timeout: 5000 });
}

export async function seek(seconds: number): Promise<void> {
    await run('playerctl', ['position', String(Math.max(0, Math.round(seconds)))], { timeout: 5000 });
}

export async function listPlayers(): Promise<string[]> {
    const text = await output('playerctl', ['--list-all'], 3000);
    if (!text || text === 'No players found') {
        return [];
    }
    return text.split('\n').map((l) => l.trim()).filter(Boolean);
}
