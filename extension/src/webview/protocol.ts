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
import type { PowerAction } from '../sys/power';
import type { ProcessInfo, SystemInfo } from '../sys/procfs';

// Re-exported so the webview bundles can type their own copies of the payloads
// without reaching into src/sys, which is host-only code.
export type { AudioState, AudioDevice } from '../sys/audio';
export type { BatteryState } from '../sys/battery';
export type { BluetoothState, BluetoothDevice } from '../sys/bluetooth';
export type { NetworkState, AccessPoint, Connection } from '../sys/network';
export type { NowPlaying } from '../sys/mpris';
export type { ProcessInfo, SystemInfo } from '../sys/procfs';

export type FlyoutKind = 'power' | 'calendar' | 'quicksettings' | 'volume' | 'network' | 'music';

export interface FlyoutState {
    kind: FlyoutKind;
    now: number;
    battery?: BatteryState;
    audio?: AudioState;
    network?: NetworkState;
    bluetooth?: BluetoothState;
    brightness?: number;
    airplaneMode?: boolean;
    nightLight?: boolean;
    energySaver?: boolean;
    nowPlaying?: NowPlaying;
    players?: string[];
    mprisAvailable?: boolean;
    canSuspend?: boolean;
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
    | { type: 'note'; path?: string; text: string; dirty: boolean }
    | { type: 'shot'; path: string; uri: string }
    | { type: 'shotError'; message: string }
    | { type: 'recording'; state: 'idle' | 'recording'; path?: string; uri?: string; startedAt?: number }
    | { type: 'recordError'; message: string }
    | { type: 'recordings'; items: { name: string; uri: string; path: string }[] }
    | { type: 'image'; uri: string; name: string };

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
    | { type: 'nightLight'; enabled: boolean }
    | { type: 'energySaver'; enabled: boolean }
    | { type: 'accessibility' }
    | { type: 'transport'; action: 'playPause' | 'next' | 'previous' }
    | { type: 'seek'; seconds: number }
    | { type: 'launchMusic'; service: 'spotify' | 'ytmusic' }
    | { type: 'command'; command: string }
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
    // notepad
    | { type: 'saveNote'; text: string; path?: string; saveAs?: boolean }
    | { type: 'openNote' }
    | { type: 'newNote' }
    | { type: 'noteToEditor'; text: string }
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
    | { type: 'openImage' };

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
