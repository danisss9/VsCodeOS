// Voice recorder.
//
// The record button talks to a pw-record subprocess in the extension host,
// because VS Code denies webviews the microphone permission outright. Playback
// of the finished file is ordinary <audio>, which webviews handle fine.

import { clear, formatDuration, h, onMessage, post, root } from './lib/dom';
import { icon } from './lib/icons';
import type { HostMessage } from '../../src/webview/protocol';

let recording = false;
let startedAt = 0;
let timer: ReturnType<typeof setInterval> | undefined;

const timeEl = h('div', { class: 'record-time' }, '0:00');
const hintEl = h('div', { class: 'flyout-note' }, 'Press record to start.');
const playerEl = h('div', { style: { padding: '0 16px 12px' } });
const listEl = h('div', { class: 'list', style: { padding: '0 12px 16px' } });
const banner = h('div', { class: 'error-banner', hidden: true });

const recordButton = h('button', {
    class: 'record-button',
    title: 'Record',
    html: icon('mic', 34),
    on: { click: () => post({ type: recording ? 'stopRecording' : 'record' }) },
});

clear(root()).append(h('div', { class: 'app' },
    h('div', { class: 'toolbar' },
        h('span', { html: icon('mic', 16) }),
        h('span', {}, 'Voice Recorder'),
        h('span', { class: 'spacer' }),
        h('button', {
            class: 'button',
            on: { click: () => post({ type: 'listRecordings' }) },
        }, h('span', { html: icon('refresh', 15) }), 'Refresh'),
    ),
    banner,
    h('div', { class: 'body' },
        h('div', { class: 'record-hero' }, recordButton, timeEl, hintEl),
        playerEl,
        h('div', { class: 'section-head', style: { padding: '0 14px' } }, 'Recordings'),
        listEl,
    ),
));

onMessage<HostMessage>((message) => {
    if (message.type === 'recording') {
        recording = message.state === 'recording';
        startedAt = message.startedAt ?? Date.now();
        renderRecordingState();
        if (message.uri) {
            clear(playerEl).append(h('audio', { src: message.uri, controls: '' } as never));
        }
    } else if (message.type === 'recordError') {
        banner.hidden = false;
        clear(banner).append(h('span', { html: icon('warning', 16) }), ` ${message.message}`);
    } else if (message.type === 'recordings') {
        clear(listEl);
        if (message.items.length === 0) {
            listEl.append(h('div', { class: 'empty' }, 'No recordings yet.'));
        }
        for (const item of message.items) {
            listEl.append(h('div', { class: 'list-row' },
                h('span', { html: icon('music', 16) }),
                h('span', { class: 'list-main' }, h('div', { class: 'list-name' }, item.name)),
                h('button', {
                    class: 'icon-button',
                    title: 'Play',
                    html: icon('play', 14),
                    on: { click: () => clear(playerEl).append(h('audio', { src: item.uri, controls: '' } as never)) },
                }),
                h('button', {
                    class: 'icon-button',
                    title: 'Delete',
                    html: icon('trash', 14),
                    on: {
                        click: () => {
                            if (confirm(`Delete ${item.name}?`)) {
                                post({ type: 'deleteRecording', path: item.path });
                            }
                        },
                    },
                }),
            ));
        }
    }
});

function renderRecordingState(): void {
    recordButton.classList.toggle('recording', recording);
    recordButton.title = recording ? 'Stop' : 'Record';
    recordButton.innerHTML = icon(recording ? 'stop' : 'mic', recording ? 28 : 34);
    hintEl.textContent = recording ? 'Recording… press again to stop.' : 'Press record to start.';

    if (timer) {
        clearInterval(timer);
        timer = undefined;
    }
    if (recording) {
        banner.hidden = true;
        const tick = (): void => {
            timeEl.textContent = formatDuration((Date.now() - startedAt) / 1000);
        };
        tick();
        timer = setInterval(tick, 250);
    } else {
        timeEl.textContent = '0:00';
    }
}

post({ type: 'ready' });
