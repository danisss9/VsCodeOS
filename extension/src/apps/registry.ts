// The one list of what this desktop can open.
//
// Before this existed the app list was written out by hand in three places -
// contributes.commands, the "All apps" quick pick and the docs - and they drifted.
// The launcher card reads this array, so adding an app now means adding a row
// here and a command handler, and the launcher picks it up.
//
// `enabled` mirrors the settings that guard each app in extension.ts, so a
// disabled app disappears from the launcher instead of appearing and then
// answering a click with "that is disabled in settings".

import type * as vscode from 'vscode';
import type { AppEntry } from '../webview/protocol';

export interface AppDescriptor extends AppEntry {
    enabled?: (config: vscode.WorkspaceConfiguration) => boolean;
}

const apps = (config: vscode.WorkspaceConfiguration): boolean => config.get<boolean>('apps.enabled', true);

export const APPS: AppDescriptor[] = [
    {
        id: 'files',
        title: 'Files',
        description: 'Browse the filesystem',
        icon: 'folder',
        command: 'vscodeos.files.open',
        keywords: ['explorer', 'folder', 'manager'],
        enabled: (config) => config.get<boolean>('files.enabled', true),
    },
    {
        id: 'browser',
        title: 'Web Browser',
        description: 'Browse the web in a tab',
        icon: 'globe',
        command: 'vscodeos.browser.open',
        keywords: ['internet', 'chrome', 'chromium', 'web'],
    },
    {
        id: 'player',
        title: 'Media Player',
        description: 'Play video and audio',
        icon: 'video',
        command: 'vscodeos.apps.player',
        keywords: ['video', 'movie', 'film', 'audio', 'mp4', 'mp3'],
        enabled: apps,
    },
    {
        id: 'music',
        title: 'Music',
        description: 'Spotify and YouTube Music',
        icon: 'music',
        command: 'vscodeos.music.show',
        keywords: ['spotify', 'youtube', 'player'],
        enabled: (config) => config.get<boolean>('music.enabled', true),
    },
    {
        id: 'calculator',
        title: 'Calculator',
        description: 'Arithmetic and scientific functions',
        icon: 'calculator',
        command: 'vscodeos.apps.calculator',
        keywords: ['maths', 'math', 'sum'],
        enabled: apps,
    },
    {
        id: 'paint',
        title: 'Paint',
        description: 'Draw and edit images',
        icon: 'brush',
        command: 'vscodeos.apps.paint',
        keywords: ['draw', 'image', 'sketch'],
        enabled: apps,
    },
    {
        id: 'screenshot',
        title: 'Screenshot',
        description: 'Capture the screen, a window or a region',
        icon: 'camera',
        command: 'vscodeos.apps.screenshot',
        keywords: ['capture', 'snip', 'print screen'],
        enabled: apps,
    },
    {
        id: 'recorder',
        title: 'Voice Recorder',
        description: 'Record from the microphone',
        icon: 'mic',
        command: 'vscodeos.apps.recorder',
        keywords: ['audio', 'microphone', 'dictate'],
        enabled: apps,
    },
    {
        id: 'updater',
        title: 'Updater',
        description: 'Update the system, VS Code and the shell',
        icon: 'update',
        command: 'vscodeos.apps.updater',
        keywords: ['upgrade', 'pacman', 'patch', 'version'],
    },
    {
        id: 'taskManager',
        title: 'Task Manager',
        description: 'Processes, CPU and memory',
        icon: 'cpu',
        command: 'vscodeos.taskManager.focus',
        keywords: ['processes', 'performance', 'kill'],
        enabled: (config) => config.get<boolean>('taskManager.enabled', true),
    },
    {
        id: 'terminal',
        title: 'Terminal',
        description: 'A shell in the editor',
        icon: 'editor',
        command: 'workbench.action.terminal.new',
        keywords: ['bash', 'console', 'command line'],
    },
    {
        id: 'settings',
        title: 'Settings',
        description: 'Editor and desktop settings',
        icon: 'gear',
        command: 'workbench.action.openSettings',
        keywords: ['preferences', 'options', 'configure'],
    },
    {
        id: 'accessibility',
        title: 'Accessibility',
        description: 'Screen reader, contrast and motion',
        icon: 'accessibility',
        command: 'vscodeos.settings.accessibility',
        keywords: ['a11y', 'contrast', 'screen reader', 'zoom'],
    },
];

/** The launcher's list: everything whose feature switch is on, as plain data. */
export function availableApps(config: vscode.WorkspaceConfiguration): AppEntry[] {
    return APPS.filter((app) => app.enabled?.(config) ?? true).map(({ enabled: _enabled, ...entry }) => entry);
}
