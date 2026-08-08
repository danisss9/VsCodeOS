// The music player.
//
// One <audio> element and a list. Everything else - the queue, shuffle, repeat,
// what "next" means when a search is filtering the library - is decided here,
// because the element only knows about one file at a time.
//
// The queue is a copy of whatever was on screen when playback started, not a
// live view of the filter. Typing into the search box while a track plays must
// not silently change what comes next.

import { clear, formatDuration, h, onMessage, post, root, vscode } from './lib/dom';
import { icon } from './lib/icons';
import type { HostMessage, MusicLibrary, Track } from '../../src/webview/protocol';

interface Saved {
    volume: number;
    shuffle: boolean;
    repeat: boolean;
}

const saved = vscode.getState<Saved>() ?? { volume: 1, shuffle: false, repeat: false };

let library: MusicLibrary | undefined;
let query = '';
/** Indices into `library.tracks`, in the order they will play. */
let queue: number[] = [];
let position = -1;

const audio = new Audio();
audio.volume = saved.volume;
audio.preload = 'metadata';

const search = h('input', {
    class: 'app-search',
    type: 'text',
    placeholder: 'Search the library',
    'aria-label': 'Search the library',
    on: {
        input: (event: Event) => {
            query = (event.target as HTMLInputElement).value;
            renderList();
        },
    },
});

const list = h('div', { class: 'list music-list' });
const nowTitle = h('div', { class: 'list-name', style: { fontWeight: '600' } }, 'Nothing playing');
const nowSub = h('div', { class: 'list-sub' }, '—');
const elapsed = h('span', { class: 'music-time' }, '0:00');
const total = h('span', { class: 'music-time' }, '0:00');
const banner = h('div', { class: 'error-banner', hidden: true });
const status = h('span', {});

const seek = h('input', {
    type: 'range',
    min: 0,
    max: 1000,
    value: 0,
    'aria-label': 'Seek',
    on: {
        input: (event: Event) => {
            if (Number.isFinite(audio.duration) && audio.duration > 0) {
                audio.currentTime = (Number((event.target as HTMLInputElement).value) / 1000) * audio.duration;
            }
        },
    },
});

const playButton = button('play', 'Play', () => togglePlay(), 'primary');
const shuffleButton = button('shuffle', 'Shuffle', () => {
    saved.shuffle = !saved.shuffle;
    persist();
    // Reshuffle from where we are, so the current track keeps playing.
    rebuildQueue(currentIndex());
    renderTransport();
});
const repeatButton = button('repeat', 'Repeat', () => {
    saved.repeat = !saved.repeat;
    persist();
    renderTransport();
});

clear(root()).append(
    h('div', { class: 'app' },
        h('div', { class: 'toolbar' },
            h('div', { class: 'app-search-row', style: { flex: '1', marginBottom: '0' } },
                h('span', { class: 'app-search-icon', html: icon('search', 16) }),
                search,
            ),
            h('button', {
                class: 'button',
                title: 'Scan the library again',
                on: { click: () => post({ type: 'musicRefresh' }) },
            }, h('span', { html: icon('refresh', 15) }), 'Rescan'),
            h('button', {
                class: 'button',
                title: 'Play music from a different folder',
                on: { click: () => post({ type: 'musicChooseFolder' }) },
            }, h('span', { html: icon('folder', 15) }), 'Change folder'),
        ),
        banner,
        h('div', { class: 'body music-body' }, list),
        h('div', { class: 'music-bar' },
            h('div', { class: 'music-now' },
                h('span', { class: 'music-art', html: icon('music', 22) }),
                h('span', { class: 'list-main' }, nowTitle, nowSub),
            ),
            h('div', { class: 'transport' },
                button('previous', 'Previous', () => step(-1)),
                playButton,
                button('next', 'Next', () => step(1)),
                shuffleButton,
                repeatButton,
            ),
            h('div', { class: 'progress-row' },
                elapsed,
                seek,
                total,
            ),
        ),
        h('div', { class: 'status' }, status),
    ),
);

function button(glyph: string, title: string, onClick: () => void, extra = ''): HTMLButtonElement {
    return h('button', {
        class: extra,
        title,
        html: icon(glyph, extra === 'primary' ? 20 : 18),
        on: { click: onClick },
    });
}

onMessage<HostMessage>((message) => {
    if (message.type !== 'music') {
        return;
    }
    library = message.library;
    // Every index in the queue points into the old array, so it has to go.
    queue = [];
    position = -1;
    renderList();
    renderTransport();
});

post({ type: 'ready' });

// ------------------------------------------------------------------ the list

function filtered(): number[] {
    const tracks = library?.tracks ?? [];
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const indices: number[] = [];
    for (let index = 0; index < tracks.length; index++) {
        const haystack = `${tracks[index].name} ${tracks[index].folder}`.toLowerCase();
        if (words.every((word) => haystack.includes(word))) {
            indices.push(index);
        }
    }
    return indices;
}

function renderList(): void {
    clear(list);
    const tracks = library?.tracks ?? [];
    const indices = filtered();

    banner.hidden = !library?.error;
    if (library?.error) {
        banner.textContent = `${library.error} Put some music in it, or choose another folder.`;
    }

    if (indices.length === 0) {
        list.append(h('div', { class: 'empty' },
            !library
                ? 'Reading the library…'
                : tracks.length === 0
                    ? `No audio files under ${library.directory}.`
                    : 'Nothing matches that.'));
    }

    const playing = currentIndex();
    for (const index of indices) {
        const track = tracks[index];
        list.append(h('button', {
            class: `list-row${index === playing ? ' active' : ''}`,
            title: track.path,
            on: { click: () => playFrom(index) },
        },
        h('span', { html: icon(index === playing && !audio.paused ? 'pause' : 'music', 17) }),
        h('span', { class: 'list-main' },
            h('div', { class: 'list-name' }, track.name),
            h('div', { class: 'list-sub' }, track.folder || library?.directory || ''),
        ),
        ));
    }

    status.textContent = library
        ? `${tracks.length} track${tracks.length === 1 ? '' : 's'}`
            + (indices.length === tracks.length ? '' : `, ${indices.length} shown`)
            + (library.truncated ? ' (library capped at 5000)' : '')
        : '';
}

// ----------------------------------------------------------------- playback

function currentIndex(): number {
    return position >= 0 && position < queue.length ? queue[position] : -1;
}

/**
 * Build the play order from what is on screen. Shuffle is a shuffled copy with
 * `start` moved to the front, so turning it on mid-track does not restart the
 * track that is playing.
 */
function rebuildQueue(start: number): void {
    const indices = filtered();
    if (indices.length === 0) {
        queue = [];
        position = -1;
        return;
    }

    if (!saved.shuffle) {
        queue = indices;
        position = Math.max(0, queue.indexOf(start));
        return;
    }

    const rest = indices.filter((index) => index !== start);
    for (let i = rest.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    queue = indices.includes(start) ? [start, ...rest] : rest;
    position = 0;
}

function playFrom(index: number): void {
    rebuildQueue(index);
    play();
}

function play(): void {
    const track = library?.tracks[currentIndex()];
    if (!track) {
        return;
    }
    audio.src = track.uri;
    void audio.play().catch(() => {
        banner.hidden = false;
        banner.textContent = `${track.name} could not be played. The editor may not have a decoder for it.`;
    });
    renderNowPlaying(track);
    renderList();
}

function togglePlay(): void {
    if (currentIndex() < 0) {
        const first = filtered()[0];
        if (first !== undefined) {
            playFrom(first);
        }
        return;
    }
    if (audio.paused) {
        void audio.play();
    } else {
        audio.pause();
    }
    renderTransport();
    renderList();
}

function step(delta: number): void {
    if (queue.length === 0) {
        return;
    }
    // Wrapping in both directions: the end of a queue is the start of it, which
    // is what every other player does and costs nothing.
    position = (position + delta + queue.length) % queue.length;
    play();
}

function renderNowPlaying(track: Track): void {
    nowTitle.textContent = track.name;
    nowSub.textContent = track.folder || library?.directory || '';
    renderTransport();
}

function renderTransport(): void {
    playButton.innerHTML = icon(audio.paused ? 'play' : 'pause', 20);
    playButton.title = audio.paused ? 'Play' : 'Pause';
    shuffleButton.className = saved.shuffle ? 'on' : '';
    repeatButton.className = saved.repeat ? 'on' : '';
}

function persist(): void {
    vscode.setState<Saved>(saved);
}

audio.addEventListener('timeupdate', () => {
    elapsed.textContent = formatDuration(audio.currentTime);
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
        seek.value = String(Math.round((audio.currentTime / audio.duration) * 1000));
    }
});

audio.addEventListener('loadedmetadata', () => {
    total.textContent = formatDuration(audio.duration);
});

audio.addEventListener('ended', () => {
    if (saved.repeat && queue.length === 1) {
        void audio.play();
        return;
    }
    if (position >= queue.length - 1 && !saved.repeat) {
        // The end of the queue: stop rather than loop back to the first track.
        audio.pause();
        renderTransport();
        renderList();
        return;
    }
    step(1);
});

audio.addEventListener('play', () => { renderTransport(); renderList(); });
audio.addEventListener('pause', () => { renderTransport(); renderList(); });

window.addEventListener('keydown', (event) => {
    if (event.target === search) {
        return;
    }
    if (event.key === ' ') {
        event.preventDefault();
        togglePlay();
    } else if (event.key === 'ArrowRight' && event.ctrlKey) {
        step(1);
    } else if (event.key === 'ArrowLeft' && event.ctrlKey) {
        step(-1);
    }
});

renderTransport();
