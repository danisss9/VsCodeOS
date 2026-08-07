// Media player.
//
// One <video> element does both jobs: Chromium plays audio through it happily,
// and using a single element means one set of controls, one keyboard map and one
// error path. The error path matters - VS Code's Electron demuxes MP4, WebM, MP3
// and WAV but not MKV or AVI, and the honest answer there is to hand the file to
// the desktop's own player rather than to show a dead black rectangle.

import { append, clear, formatDuration, h, onMessage, post, root, vscode } from './lib/dom';
import { icon } from './lib/icons';
import type { HostMessage } from '../../src/webview/protocol';

interface PlaylistItem {
    name: string;
    path: string;
    uri: string;
    kind: 'audio' | 'video';
}

interface Persisted {
    volume: number;
    muted: boolean;
}

const saved = vscode.getState<Persisted>() ?? { volume: 1, muted: false };

let current: string | undefined;
let playlist: PlaylistItem[] = [];

const video = h('video', { controls: true, class: 'player-surface' });
video.volume = saved.volume;
video.muted = saved.muted;
video.setAttribute('playsinline', '');

const titleEl = h('span', { class: 'player-title' }, 'No file open');
const artEl = h('div', { class: 'player-art', html: icon('music', 64) });
const banner = h('div', { class: 'error-banner', hidden: true });
const listEl = h('div', { class: 'list' });
const stage = h('div', { class: 'player-stage' }, video, artEl);

const externalButton = h('button', {
    class: 'button',
    title: 'Open in the desktop’s own player',
    on: { click: () => current && post({ type: 'openExternal', path: current }) },
}, h('span', { html: icon('open', 15) }), 'Open externally');

clear(root()).append(h('div', { class: 'app' },
    h('div', { class: 'toolbar' },
        h('button', {
            class: 'button primary',
            on: { click: () => post({ type: 'openMedia' }) },
        }, h('span', { html: icon('folder', 15) }), 'Open…'),
        titleEl,
        h('span', { class: 'spacer' }),
        externalButton,
    ),
    banner,
    h('div', { class: 'body player-body' },
        stage,
        h('div', { class: 'player-list' },
            h('div', { class: 'section-head' }, 'In this folder'),
            listEl,
        ),
    ),
));

// ------------------------------------------------------------------ state

function persist(): void {
    vscode.setState<Persisted>({ volume: video.volume, muted: video.muted });
}

video.addEventListener('volumechange', persist);

video.addEventListener('error', () => {
    // MEDIA_ERR_SRC_NOT_SUPPORTED is the container/codec case; the others are
    // genuine read failures and read the same way to a user.
    showError('This file’s format cannot be played inside the editor.', true);
});

video.addEventListener('loadeddata', () => hideError());

video.addEventListener('ended', () => {
    const index = playlist.findIndex((item) => item.path === current);
    const next = playlist[index + 1];
    if (next) {
        play(next);
    }
});

function showError(message: string, offerExternal: boolean): void {
    append(clear(banner),
        h('div', {}, message),
        offerExternal && current
            ? h('button', {
                class: 'button',
                style: { marginTop: '8px' },
                on: { click: () => post({ type: 'openExternal', path: current as string }) },
            }, h('span', { html: icon('open', 15) }), 'Open in the desktop player')
            : null,
    );
    banner.hidden = false;
}

function hideError(): void {
    banner.hidden = true;
}

function play(item: PlaylistItem): void {
    post({ type: 'playMedia', path: item.path });
}

function renderList(): void {
    clear(listEl);
    if (playlist.length === 0) {
        listEl.append(h('div', { class: 'empty' }, 'Nothing else here.'));
        return;
    }
    for (const item of playlist) {
        listEl.append(h('div', {
            class: `list-row${item.path === current ? ' active' : ''}`,
            title: item.path,
            on: { click: () => play(item) },
        },
        h('span', { html: icon(item.kind === 'audio' ? 'music' : 'video', 16) }),
        h('div', { class: 'list-main' },
            h('div', { class: 'list-name' }, item.name),
        )));
    }
}

// --------------------------------------------------------------- messages

onMessage<HostMessage>((message) => {
    if (message.type === 'media') {
        hideError();
        current = message.path;
        titleEl.textContent = message.name;
        artEl.hidden = message.kind === 'video';
        video.src = message.uri;
        void video.play().catch(() => {
            // Autoplay can be refused; the controls are right there.
        });
        renderList();
        return;
    }

    if (message.type === 'playlist') {
        playlist = message.items;
        renderList();
        return;
    }

    if (message.type === 'mediaError') {
        showError(message.message, Boolean(message.path));
    }
});

// --------------------------------------------------------------- keyboard

document.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        return;
    }
    switch (event.key) {
        case ' ':
            event.preventDefault();
            if (video.paused) {
                void video.play().catch(() => undefined);
            } else {
                video.pause();
            }
            return;
        case 'ArrowRight':
            event.preventDefault();
            video.currentTime = Math.min(video.duration || 0, video.currentTime + 5);
            return;
        case 'ArrowLeft':
            event.preventDefault();
            video.currentTime = Math.max(0, video.currentTime - 5);
            return;
        case 'f':
            event.preventDefault();
            void (document.fullscreenElement ? document.exitFullscreen() : video.requestFullscreen()).catch(
                () => undefined,
            );
            return;
        case 'm':
            event.preventDefault();
            video.muted = !video.muted;
            return;
        default:
    }
});

// A time readout in the status strip, because <video>'s own is easy to miss on
// a small window and this is the one number people look for.
const timeEl = h('span', {}, '0:00');
video.addEventListener('timeupdate', () => {
    timeEl.textContent = `${formatDuration(video.currentTime)} / ${formatDuration(video.duration || 0)}`;
});
root().firstElementChild?.append(h('div', { class: 'status' }, timeEl, h('span', {}, 'Space play · ←/→ seek · F fullscreen · M mute')));

post({ type: 'ready' });
