// Inline SVG icons.
//
// Codicons are a webfont that VS Code does not expose to extension webviews, and
// shipping the font would add ~70 KiB to every image for a dozen glyphs. These
// are drawn on a 24x24 grid and inherit currentColor, so they theme themselves.

const PATHS: Record<string, string> = {
    power: 'M12 3v10M7.8 6.3a7 7 0 1 0 8.4 0',
    restart: 'M4 12a8 8 0 1 1 2.3 5.7M4 12V6M4 12h6',
    sleep: 'M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z',
    logout: 'M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16l-4-4 4-4M6 12h11',
    wifi: 'M2.5 9a15 15 0 0 1 19 0M5.5 12.5a10 10 0 0 1 13 0M8.5 16a5.5 5.5 0 0 1 7 0M12 19.5h.01',
    wifiOff: 'M2.5 9a15 15 0 0 1 6-3.6M15 5.6A15 15 0 0 1 21.5 9M8.5 16a5.5 5.5 0 0 1 7 0M12 19.5h.01M3 3l18 18',
    bluetooth: 'M7 7l10 10-5 4V3l5 4L7 17',
    bluetoothOff: 'M7 7l10 10-5 4V3l5 4L7 17M3 3l18 18',
    airplane: 'M21 15l-9-4V5.5a1.5 1.5 0 0 0-3 0V11l-9 4v2l9-2.5V19l-2.5 1.5V22l4-1 4 1v-1.5L12 19v-4.5L21 17z',
    battery: 'M3 8h14a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1zM21 11v2',
    bolt: 'M13 2L4 14h7l-1 8 9-12h-7l1-8z',
    sun: 'M12 6.5V4M12 20v-2.5M6.5 12H4M20 12h-2.5M7.8 7.8L6 6M18 18l-1.8-1.8M7.8 16.2L6 18M18 6l-1.8 1.8',
    moon: 'M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z',
    accessibility: 'M12 5.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM4 8.5l8 1.5 8-1.5M12 10v5M12 15l-3 6M12 15l3 6',
    volume: 'M11 5L6.5 9H3v6h3.5L11 19V5z',
    volumeMute: 'M11 5L6.5 9H3v6h3.5L11 19V5zM16 9.5l5 5M21 9.5l-5 5',
    volumeLow: 'M11 5L6.5 9H3v6h3.5L11 19V5zM15.5 9.5a3.5 3.5 0 0 1 0 5',
    volumeHigh: 'M11 5L6.5 9H3v6h3.5L11 19V5zM15.5 9.5a3.5 3.5 0 0 1 0 5M18.5 7a7 7 0 0 1 0 10',
    play: 'M7 4l12 8-12 8V4z',
    pause: 'M8 4v16M16 4v16',
    next: 'M6 4l10 8-10 8V4zM19 4v16',
    previous: 'M18 4L8 12l10 8V4zM5 4v16',
    chevronLeft: 'M15 5l-7 7 7 7',
    chevronRight: 'M9 5l7 7-7 7',
    chevronUp: 'M5 15l7-7 7 7',
    chevronDown: 'M5 9l7 7 7-7',
    close: 'M6 6l12 12M18 6L6 18',
    check: 'M4 12.5l5 5L20 6.5',
    lock: 'M6 11h12v9H6v-9zM8.5 11V7.5a3.5 3.5 0 1 1 7 0V11',
    refresh: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5',
    folder: 'M3 6.5h6l2 2.5h10v10H3v-12.5z',
    file: 'M6 3h8l4 4v14H6V3zM14 3v4h4',
    home: 'M4 11l8-7 8 7M6 10v10h12V10',
    disk: 'M3 7a9 4 0 1 0 18 0A9 4 0 1 0 3 7M3 7v10a9 4 0 0 0 18 0V7',
    download: 'M12 3v12M7 11l5 5 5-5M4 20h16',
    image: 'M3 5h18v14H3V5zM3 16l5-5 4 4 3-3 6 6',
    music: 'M9 18V5l10-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM19 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
    video: 'M3 6h13v12H3V6zM16 10l5-3v10l-5-3',
    trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
    plus: 'M12 5v14M5 12h14',
    grid: 'M4 4h7v7H4V4zM13 4h7v7h-7V4zM4 13h7v7H4v-7zM13 13h7v7h-7v-7z',
    list: 'M4 6h16M4 12h16M4 18h16',
    mic: 'M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM6 11a6 6 0 0 0 12 0M12 17v4',
    // The mic with a stroke through it, matching how volumeMute reads.
    micMute: 'M12 3a3 3 0 0 1 3 3v5M9 8v4a3 3 0 0 0 4.9 2.3M6 11a6 6 0 0 0 9.3 5M18 11v1M12 17v4M4 3l16 18',
    stop: 'M6 6h12v12H6z',
    camera: 'M3 7h4l2-2h6l2 2h4v13H3V7zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
    save: 'M4 4h12l4 4v12H4V4zM8 4v6h8V4M8 20v-6h8v6',
    open: 'M4 5h6l2 2h8v12H4V5z',
    editor: 'M4 4h16v16H4V4zM4 9h16',
    undo: 'M9 8H5V4M5.5 8.5A7.5 7.5 0 1 1 4 13',
    redo: 'M15 8h4V4M18.5 8.5A7.5 7.5 0 1 0 20 13',
    ethernet: 'M12 3v8M8 15H4v6h4v-6zM14 15h-4v6h4v-6zM20 15h-4v6h4v-6zM4 11h16',
    globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z',
    cpu: 'M7 7h10v10H7V7zM9 3v4M15 3v4M9 17v4M15 17v4M3 9h4M3 15h4M17 9h4M17 15h4',
    memory: 'M3 7h18v10H3V7zM7 17v3M12 17v3M17 17v3M7 11v2M12 11v2M17 11v2',
    search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM16 16l5 5',
    warning: 'M12 3l9.5 17H2.5L12 3zM12 10v5M12 18h.01',
    plug: 'M9 3v6M15 3v6M6 9h12v3a6 6 0 0 1-12 0V9zM12 18v3',
    // A download arrow inside the refresh ring: "there is a newer one".
    update: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5M12 9v6M9.5 12.5L12 15l2.5-2.5',
    gear: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM12 2.5l1.4 2.6 2.9-.5.6 2.9 2.6 1.4-1.4 2.6 1.4 2.6-2.6 1.4-.6 2.9-2.9-.5L12 21.5l-1.4-2.6-2.9.5-.6-2.9-2.6-1.4L5.9 12 4.5 9.4l2.6-1.4.6-2.9 2.9.5L12 2.5z',
    calculator: 'M5 3h14v18H5V3zM7.5 7h9M7.5 11h2M11 11h2M14.5 11h2M7.5 14.5h2M11 14.5h2M14.5 14.5h2M7.5 18h2M11 18h5.5',
    brush: 'M15.5 3.5l5 5-8 8-5-5 8-8zM7.5 11.5L4 15c-1 1-1 4-1 5 1 0 4 0 5-1l3.5-3.5',
    tab: 'M3 6h7l2 2h9v10H3V6z',
    fullscreen: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
    bell: 'M18 15V10a6 6 0 0 0-12 0v5l-2 3h16l-2-3zM10 21h4',
    shield: 'M12 2.5l8 3v6c0 5-3.4 8.9-8 10-4.6-1.1-8-5-8-10v-6l8-3z',
    // A box with a lid band across it, which is how a zip reads at 18px.
    archive: 'M3 6.5h18v4H3v-4zM4.5 10.5v9h15v-9M10 14h4',
    keyboard: 'M2.5 6.5h19v11h-19v-11zM6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M6 14h12',
    display: 'M3 4.5h18v11H3v-4.5zM8.5 20h7M12 15.5V20',
};

/** Solid glyphs, drawn with a fill instead of a stroke. */
const FILLED = new Set(['play', 'stop', 'airplane', 'bolt', 'next', 'previous']);

export function icon(name: keyof typeof PATHS | string, size = 18): string {
    const path = PATHS[name] ?? PATHS.file;
    const style = FILLED.has(name)
        ? 'fill="currentColor" stroke="none"'
        : 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
    return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" ${style}><path d="${path}"/></svg>`;
}

/** Wi-Fi bars for a 0-100 signal strength. */
export function signalIcon(signal: number, size = 18): string {
    const bars = signal >= 75 ? 4 : signal >= 50 ? 3 : signal >= 25 ? 2 : 1;
    const arcs = [
        { d: 'M12 19.5h.01', level: 1 },
        { d: 'M8.5 16a5.5 5.5 0 0 1 7 0', level: 2 },
        { d: 'M5.5 12.5a10 10 0 0 1 13 0', level: 3 },
        { d: 'M2.5 9a15 15 0 0 1 19 0', level: 4 },
    ];
    const paths = arcs
        .map((arc) => `<path d="${arc.d}" opacity="${arc.level <= bars ? 1 : 0.25}"/>`)
        .join('');
    return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">${paths}</svg>`;
}

/** Battery pictogram whose fill tracks the charge. */
export function batteryIcon(level: number, charging: boolean, size = 18): string {
    const width = Math.max(0, Math.min(13, Math.round((level / 100) * 13)));
    const bolt = charging
        ? '<path d="M12.5 9.5L9.5 13h2.5l-.5 2.5 3-3.5h-2.5l.5-2.5z" fill="currentColor" stroke="none"/>'
        : '';
    return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">
<rect x="2.5" y="8" width="15" height="8" rx="1.5"/>
<path d="M20 11v2" stroke-linecap="round"/>
<rect x="4" y="9.5" width="${width}" height="5" rx="0.6" fill="currentColor" stroke="none"/>
${bolt}
</svg>`;
}
