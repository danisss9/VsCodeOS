// Launching a real web browser.
//
// The images ship Chromium, because Microsoft Edge is AUR-only on Arch and
// Microsoft publishes no ARM64 Linux build at all, so the Pi image could never
// have it. Detection still prefers Edge, so installing it from the AUR is enough
// to make every launcher here use it.
//
// `--app=` gives a frameless single-site window, which is what makes "Spotify
// Web" and "YouTube Music" feel like apps rather than tabs - and Chromium
// exports MPRIS for them, so the status bar transport controls them.

import { launch, which } from './exec';
import { log } from '../log';

const CANDIDATES = [
    'microsoft-edge-stable',
    'microsoft-edge',
    'chromium',
    'google-chrome-stable',
    'google-chrome',
    'firefox',
];

export interface BrowserInfo {
    command: string;
    name: string;
    chromiumLike: boolean;
}

export function detect(preferred?: string): BrowserInfo | undefined {
    const names = preferred ? [preferred, ...CANDIDATES] : CANDIDATES;
    for (const name of names) {
        const path = which(name);
        if (path) {
            return {
                command: path,
                name: prettyName(name),
                chromiumLike: !name.includes('firefox'),
            };
        }
    }
    return undefined;
}

function prettyName(command: string): string {
    const base = command.split('/').pop() ?? command;
    if (base.startsWith('microsoft-edge')) {
        return 'Microsoft Edge';
    }
    if (base.startsWith('google-chrome')) {
        return 'Google Chrome';
    }
    if (base.startsWith('chromium')) {
        return 'Chromium';
    }
    if (base.startsWith('firefox')) {
        return 'Firefox';
    }
    return base;
}

/**
 * Open a URL. `appMode` asks for a frameless single-site window; Firefox has no
 * equivalent, so it gets a normal window instead of a broken flag.
 */
export function open(url: string, options: { preferred?: string; appMode?: boolean } = {}): BrowserInfo | undefined {
    const browser = detect(options.preferred);
    if (!browser) {
        return undefined;
    }
    const args = options.appMode && browser.chromiumLike ? [`--app=${url}`] : [url];
    if (!launch(browser.command, args)) {
        return undefined;
    }
    log.info(`launched ${browser.name}: ${url}`);
    return browser;
}

/** Hand a file or folder to the desktop's default handler. */
export function openWithDefaultApp(path: string): boolean {
    const opener = which('xdg-open');
    return opener ? launch(opener, [path]) : false;
}
