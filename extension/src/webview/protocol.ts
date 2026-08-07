// Message types shared by the extension host and the webview bundles.
//
// Imported by both sides, so a rename in one is a compile error in the other -
// which is the only cheap protection there is against a postMessage protocol
// silently drifting apart.

import type { AudioState } from '../sys/audio';
import type { BatteryState } from '../sys/battery';
import type { BluetoothState } from '../sys/bluetooth';
import type { NetworkState } from '../sys/network';
import type { NowPlaying } from '../sys/mpris';
import type { NotificationRecord } from '../sys/notifications';
import type { PowerAction } from '../sys/power';
import type { ProcessInfo, SystemInfo } from '../sys/procfs';

// Re-exported so the webview bundles can type their own copies of the payloads
// without reaching into src/sys, which is host-only code.
export type { AudioState, AudioDevice } from '../sys/audio';
export type { BatteryState } from '../sys/battery';
export type { BluetoothState, BluetoothDevice } from '../sys/bluetooth';
export type { NetworkState, AccessPoint, Connection } from '../sys/network';
export type { NowPlaying } from '../sys/mpris';
export type { NotificationRecord } from '../sys/notifications';
export type { ProcessInfo, SystemInfo } from '../sys/procfs';

export type FlyoutKind =
    | 'apps' | 'power' | 'powersettings' | 'calendar'
    | 'volume' | 'network' | 'bluetooth' | 'music' | 'notifications';

/**
 * One entry in the app launcher. Deliberately plain data: the registry that
 * produces these lives on the host and knows how to test whether an app is
 * enabled, but only the serialisable half crosses into the webview.
 */
export interface AppEntry {
    id: string;
    title: string;
    description: string;
    /** Key in media/src/lib/icons.ts. */
    icon: string;
    command: string;
    /** Extra search terms, for words that are not in the title or description. */
    keywords?: string[];
}

export interface FlyoutState {
    kind: FlyoutKind;
    now: number;
    apps?: AppEntry[];
    battery?: BatteryState;
    audio?: AudioState;
    network?: NetworkState;
    bluetooth?: BluetoothState;
    bluetoothScanning?: boolean;
    brightness?: number;
    airplaneMode?: boolean;
    nightLight?: boolean;
    energySaver?: boolean;
    nowPlaying?: NowPlaying;
    players?: string[];
    mprisAvailable?: boolean;
    canSuspend?: boolean;
    notifications?: NotificationRecord[];
    /** False when another daemon owns the bus name, so nothing will ever arrive. */
    notificationsAvailable?: boolean;
}

/** One row in the updater. */
export interface UpdateItem {
    id: 'packages' | 'code' | 'shell' | 'kernel';
    title: string;
    description: string;
    current: string;
    latest?: string;
    status: 'checking' | 'current' | 'available' | 'unknown';
    detail?: string;
    /** Argument for vscodeos-update, absent when the row cannot be acted on. */
    target?: UpdateTarget;
}

export type UpdateTarget = 'packages' | 'code' | 'shell' | 'all';

/** A pointer, wheel or key event forwarded from the browser webview to Chromium. */
export type BrowserInput =
    | { kind: 'mouse'; type: 'mousePressed' | 'mouseReleased' | 'mouseMoved'; x: number; y: number; button: 'none' | 'left' | 'middle' | 'right'; buttons: number; clickCount: number; modifiers: number }
    | { kind: 'wheel'; x: number; y: number; deltaX: number; deltaY: number; modifiers: number }
    | { kind: 'key'; type: 'keyDown' | 'keyUp' | 'char'; key: string; code: string; text?: string; windowsVirtualKeyCode?: number; modifiers: number };

export interface BrowserTab {
    id: string;
    title: string;
    active: boolean;
}

export interface BrowserState {
    url: string;
    title: string;
    loading: boolean;
    canGoBack: boolean;
    canGoForward: boolean;
    tabs: BrowserTab[];
}

/** Host -> webview. */
export type HostMessage =
    | { type: 'flyout'; kind: FlyoutKind }
    | { type: 'state'; state: FlyoutState }
    | { type: 'scanning' }
    | { type: 'busy'; label: string }
    | { type: 'tasks'; system: SystemInfo; processes: ProcessInfo[] }
    | { type: 'taskError'; message: string }
    | { type: 'files'; path: string; entries: FileEntry[]; places: Place[]; error?: string }
    | { type: 'shot'; path: string; uri: string }
    | { type: 'shotError'; message: string }
    | { type: 'recording'; state: 'idle' | 'recording'; path?: string; uri?: string; startedAt?: number }
    | { type: 'recordError'; message: string }
    | { type: 'recordings'; items: { name: string; uri: string; path: string }[] }
    | { type: 'image'; uri: string; name: string }
    // media player
    | { type: 'media'; path: string; uri: string; name: string; kind: 'audio' | 'video' }
    | { type: 'playlist'; items: { name: string; path: string; uri: string; kind: 'audio' | 'video' }[] }
    | { type: 'mediaError'; message: string; path?: string }
    // browser
    | { type: 'browserFrame'; data: string; width: number; height: number }
    | { type: 'browserState'; state: BrowserState }
    | { type: 'browserError'; message: string; fatal?: boolean }
    // updater
    | { type: 'updateStatus'; items: UpdateItem[]; running?: UpdateTarget }
    | { type: 'updateLog'; chunk: string }
    | { type: 'updateDone'; ok: boolean; needsRestart: boolean; message?: string };

/** Webview -> host. */
export type WebviewMessage =
    | { type: 'ready' }
    | { type: 'power'; action: PowerAction }
    | { type: 'volume'; value: number }
    | { type: 'mute' }
    | { type: 'sink'; id: string }
    | { type: 'brightness'; value: number }
    | { type: 'wifi'; enabled: boolean }
    | { type: 'scan' }
    | { type: 'connect'; ssid: string; secured: boolean; known: boolean; password?: string }
    | { type: 'disconnect'; name: string }
    | { type: 'forget'; name: string }
    | { type: 'airplane'; enabled: boolean }
    | { type: 'bluetooth'; enabled: boolean }
    | { type: 'bluetoothDevice'; mac: string; connect: boolean }
    | { type: 'bluetoothScan' }
    | { type: 'bluetoothPair'; mac: string }
    | { type: 'bluetoothForget'; mac: string; name: string }
    | { type: 'nightLight'; enabled: boolean }
    | { type: 'energySaver'; enabled: boolean }
    | { type: 'transport'; action: 'playPause' | 'next' | 'previous' }
    | { type: 'seek'; seconds: number }
    | { type: 'launchMusic'; service: 'spotify' | 'ytmusic' }
    | { type: 'command'; command: string }
    | { type: 'closeFlyout' }
    // notifications
    | { type: 'dismissNotification'; id: number }
    | { type: 'clearNotifications' }
    // task manager
    | { type: 'endTask'; pid: number; name: string }
    | { type: 'endTaskAsRoot'; pid: number; name: string }
    | { type: 'pause'; paused: boolean }
    // file explorer
    | { type: 'navigate'; path: string }
    | { type: 'openFile'; path: string }
    | { type: 'openExternal'; path: string }
    | { type: 'newFolder'; path: string }
    | { type: 'newFile'; path: string }
    | { type: 'rename'; path: string }
    | { type: 'delete'; paths: string[] }
    | { type: 'clipboard'; paths: string[]; cut: boolean }
    | { type: 'paste'; target: string }
    | { type: 'revealInSidebar'; path: string }
    // screenshot
    | { type: 'capture'; mode: 'screen' | 'window' | 'region'; delay: number }
    | { type: 'saveShot'; path: string }
    // recorder
    | { type: 'record' }
    | { type: 'stopRecording' }
    | { type: 'listRecordings' }
    | { type: 'deleteRecording'; path: string }
    // paint
    | { type: 'savePng'; dataUrl: string; path?: string }
    | { type: 'openImage' }
    // media player
    | { type: 'openMedia' }
    | { type: 'playMedia'; path: string }
    // browser
    | { type: 'browserNavigate'; url: string }
    | { type: 'browserGo'; action: 'back' | 'forward' | 'reload' | 'stop' | 'home' }
    | { type: 'browserResize'; width: number; height: number }
    | { type: 'browserInput'; input: BrowserInput }
    | { type: 'browserTab'; action: 'new' | 'close' | 'select'; id?: string }
    | { type: 'browserExternal' }
    // updater
    | { type: 'checkUpdates' }
    | { type: 'runUpdate'; target: UpdateTarget }
    | { type: 'restart'; mode: 'editor' | 'reboot' };

export interface FileEntry {
    name: string;
    path: string;
    isDirectory: boolean;
    isSymlink: boolean;
    size: number;
    modified: number;
    hidden: boolean;
}

export interface Place {
    name: string;
    path: string;
    icon: string;
}
