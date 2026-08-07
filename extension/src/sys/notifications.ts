// The desktop's notification daemon, which is the editor.
//
// On a normal Linux desktop something owns the `org.freedesktop.Notifications`
// bus name - dunst, mako, GNOME Shell - and every `notify-send`, every finished
// download and every calendar reminder becomes a bubble in the corner. VS Code
// OS ships no such daemon, so until now all of that went nowhere: the call
// failed, silently, and the user never learned there was anything to know.
//
// The editor already has a notification UI, so this owns the name itself and
// turns each `Notify` call into a VS Code message. That makes VsCodeOsCore a
// real notification server rather than an observer, which is why it speaks the
// protocol properly - `dbus-monitor` can watch traffic to a daemon but cannot
// answer a method call, and the whole point here is that there is no daemon.
//
// The one rule: if something else already owns the name, walk away. Two servers
// fighting over it is worse than none.

import * as vscode from 'vscode';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import * as dbus from 'dbus-next';
import { notificationText, parseActions, urgencyOf } from '../util/notify';
import type { Urgency } from '../util/notify';
import { log } from '../log';

const BUS_NAME = 'org.freedesktop.Notifications';
const OBJECT_PATH = '/org/freedesktop/Notifications';

/** Reasons in `NotificationClosed`, from the spec. */
const CLOSED_EXPIRED = 1;
const CLOSED_DISMISSED = 2;
const CLOSED_BY_CALL = 3;

export interface NotificationRecord {
    id: number;
    /** The sending application's own name for itself; may be empty. */
    appName: string;
    summary: string;
    body: string;
    /** The one line that was shown, summary and body already flattened. */
    text: string;
    urgency: Urgency;
    /** Milliseconds since the epoch. */
    at: number;
    read: boolean;
}

/**
 * The exported D-Bus object.
 *
 * Split from `NotificationServer` because `Interface` subclasses have to call
 * `configureMembers` at class-definition time, and every method on them is part
 * of the wire protocol - there is nowhere to keep the extension's own state.
 */
class NotificationsInterface extends dbus.interface.Interface {
    constructor(
        private readonly onNotify: (
            appName: string,
            replacesId: number,
            summary: string,
            body: string,
            actions: string[],
            hints: Record<string, unknown>,
            expireTimeout: number,
        ) => number,
        private readonly onClose: (id: number) => void,
        private readonly version: string,
    ) {
        super(BUS_NAME);
    }

    Notify(
        appName: string,
        replacesId: number,
        _appIcon: string,
        summary: string,
        body: string,
        actions: string[],
        hints: Record<string, unknown>,
        expireTimeout: number,
    ): number {
        return this.onNotify(appName, replacesId, summary, body, actions, hints, expireTimeout);
    }

    CloseNotification(id: number): void {
        this.onClose(id);
    }

    /**
     * Deliberately not `body-markup` or `body-hyperlinks`: a VS Code message is
     * plain text, so claiming to render markup would leave senders emitting
     * angle brackets the user then has to read. `persistence` is honest - the
     * notification centre card keeps them after the toast is gone.
     */
    GetCapabilities(): string[] {
        return ['body', 'actions', 'persistence'];
    }

    GetServerInformation(): string[] {
        return ['VsCodeOsCore', 'VS Code OS', this.version, '1.2'];
    }

    NotificationClosed(id: number, reason: number): number[] {
        return [id, reason];
    }

    ActionInvoked(id: number, actionKey: string): [number, string] {
        return [id, actionKey];
    }
}

NotificationsInterface.configureMembers({
    methods: {
        Notify: { inSignature: 'susssasa{sv}i', outSignature: 'u' },
        CloseNotification: { inSignature: 'u', outSignature: '' },
        GetCapabilities: { inSignature: '', outSignature: 'as' },
        GetServerInformation: { inSignature: '', outSignature: 'ssss' },
    },
    signals: {
        NotificationClosed: { signature: 'uu' },
        ActionInvoked: { signature: 'us' },
    },
});

/**
 * Where the session bus is, resolved here rather than left to dbus-next.
 *
 * Its own search ends at an X11 window-selection lookup, which needs the `x11`
 * package that is not installed - so an unset variable would surface as a
 * module-not-found rather than as "there is no bus". Both of the two ways a VS
 * Code OS session gets a bus are covered: logind exports the variable, and
 * vscodeos-kiosk's `dbus-launch` fallback exports it too.
 */
function sessionBusAddress(): string | undefined {
    const configured = process.env.DBUS_SESSION_BUS_ADDRESS;
    if (configured) {
        return configured;
    }
    // The systemd user bus, in case the variable was lost between the login
    // shell and the extension host.
    const runtime = process.env.XDG_RUNTIME_DIR;
    return runtime && existsSync(`${runtime}/bus`) ? `unix:path=${runtime}/bus` : undefined;
}

/** One notification that is still on screen, so a later call can close it. */
interface Live {
    record: NotificationRecord;
    /** Resolves the shown message early when the sender closes it first. */
    close: (reason: number) => void;
    timer?: NodeJS.Timeout;
}

export class NotificationServer extends EventEmitter {
    private bus: dbus.MessageBus | undefined;
    private iface: NotificationsInterface | undefined;
    private readonly live = new Map<number, Live>();
    private history: NotificationRecord[] = [];
    private nextId = 1;

    constructor(private readonly version: string, private readonly historyLimit = 50) {
        super();
    }

    get records(): NotificationRecord[] {
        return this.history;
    }

    get unread(): number {
        return this.history.filter((record) => !record.read).length;
    }

    get running(): boolean {
        return this.iface !== undefined;
    }

    /**
     * Claim the bus name and export the object.
     *
     * `DO_NOT_QUEUE` matters: without it a losing request sits in a queue and we
     * would silently become the daemon the moment a real one exited, halfway
     * through that other daemon's lifetime. Better to lose once and stay lost.
     */
    async start(): Promise<void> {
        if (this.bus) {
            return;
        }
        const address = sessionBusAddress();
        if (!address) {
            log.info('notifications: no session bus to connect to, not starting');
            return;
        }

        try {
            const bus = dbus.sessionBus({ busAddress: address });
            this.bus = bus;
            bus.on('error', (error: Error) => log.debug(`notification bus: ${error.message}`));

            const reply = await bus.requestName(BUS_NAME, dbus.NameFlag.DO_NOT_QUEUE);
            if (reply !== dbus.RequestNameReply.PRIMARY_OWNER && reply !== dbus.RequestNameReply.ALREADY_OWNER) {
                log.info(`notifications: ${BUS_NAME} is owned by another daemon, leaving it alone`);
                bus.disconnect();
                this.bus = undefined;
                return;
            }

            this.iface = new NotificationsInterface(
                (appName, replacesId, summary, body, actions, hints, expireTimeout) =>
                    this.notify(appName, replacesId, summary, body, actions, hints, expireTimeout),
                (id) => this.closeFromCaller(id),
                this.version,
            );
            bus.export(OBJECT_PATH, this.iface);
            log.info(`notifications: serving ${BUS_NAME}`);
        } catch (error) {
            log.error('notifications: could not take the bus name', error);
            this.bus?.disconnect();
            this.bus = undefined;
            this.iface = undefined;
        }
    }

    // -------------------------------------------------------------- incoming

    private notify(
        appName: string,
        replacesId: number,
        summary: string,
        body: string,
        actions: string[],
        hints: Record<string, unknown>,
        expireTimeout: number,
    ): number {
        // A non-zero replaces_id means "this supersedes that one"; the spec says
        // the id is reused, so the old message is retired first.
        const id = replacesId > 0 ? replacesId : this.nextId++;
        if (replacesId > 0) {
            this.retire(replacesId, CLOSED_BY_CALL);
            this.nextId = Math.max(this.nextId, replacesId + 1);
        }

        const record: NotificationRecord = {
            id,
            appName: appName || 'Application',
            summary,
            body,
            text: notificationText(summary, body),
            urgency: urgencyOf(hints),
            at: Date.now(),
            read: false,
        };

        this.remember(record);
        void this.present(record, parseActions(actions), expireTimeout);
        return id;
    }

    private async present(
        record: NotificationRecord,
        actions: { key: string; label: string }[],
        expireTimeout: number,
    ): Promise<void> {
        let settled = false;
        const finish = (reason: number): void => {
            if (settled) {
                return;
            }
            settled = true;
            this.retire(record.id, reason);
        };

        const early = new Promise<undefined>((resolve) => {
            this.live.set(record.id, {
                record,
                close: (reason) => {
                    finish(reason);
                    resolve(undefined);
                },
                // A positive expire_timeout is in milliseconds. VS Code owns how
                // long its own toast stays up, so this only decides when the
                // sender is told the notification lapsed.
                timer: expireTimeout > 0
                    ? setTimeout(() => {
                        finish(CLOSED_EXPIRED);
                        resolve(undefined);
                    }, expireTimeout)
                    : undefined,
            });
        });

        const show = record.urgency === 'critical'
            ? vscode.window.showWarningMessage(record.text, ...actions.map((a) => a.label))
            : vscode.window.showInformationMessage(record.text, ...actions.map((a) => a.label));

        const choice = await Promise.race([show, early]);
        record.read = true;

        if (choice) {
            const action = actions.find((a) => a.label === choice);
            if (action) {
                this.emitSignal(() => this.iface?.ActionInvoked(record.id, action.key));
            }
        }
        finish(CLOSED_DISMISSED);
        this.emit('change');
    }

    private closeFromCaller(id: number): void {
        const entry = this.live.get(id);
        if (entry) {
            entry.close(CLOSED_BY_CALL);
        }
    }

    /** Drop a live notification and tell the sender why it went. */
    private retire(id: number, reason: number): void {
        const entry = this.live.get(id);
        if (!entry) {
            return;
        }
        if (entry.timer) {
            clearTimeout(entry.timer);
        }
        this.live.delete(id);
        this.emitSignal(() => this.iface?.NotificationClosed(id, reason));
    }

    /**
     * A signal that cannot be delivered must not take the daemon down with it -
     * the sender may well have exited between the call and the reply.
     */
    private emitSignal(emit: () => void): void {
        try {
            emit();
        } catch (error) {
            log.debug(`notification signal failed: ${String(error)}`);
        }
    }

    // --------------------------------------------------------------- history

    private remember(record: NotificationRecord): void {
        // A replacement takes the old one's place rather than sitting next to
        // it. Ids are reused by design when replaces_id is set, and two rows
        // sharing one id would mean dismissing either removed both.
        this.history = [record, ...this.history.filter((old) => old.id !== record.id)]
            .slice(0, Math.max(1, this.historyLimit));
        this.emit('change');
    }

    markAllRead(): void {
        if (this.unread === 0) {
            return;
        }
        this.history = this.history.map((record) => ({ ...record, read: true }));
        this.emit('change');
    }

    dismiss(id: number): void {
        this.history = this.history.filter((record) => record.id !== id);
        this.live.get(id)?.close(CLOSED_DISMISSED);
        this.emit('change');
    }

    clear(): void {
        this.history = [];
        this.emit('change');
    }

    dispose(): void {
        for (const entry of [...this.live.values()]) {
            if (entry.timer) {
                clearTimeout(entry.timer);
            }
        }
        this.live.clear();
        this.removeAllListeners();
        if (this.bus && this.iface) {
            try {
                this.bus.unexport(OBJECT_PATH, this.iface);
            } catch {
                /* the bus may already be gone */
            }
        }
        this.bus?.disconnect();
        this.bus = undefined;
        this.iface = undefined;
    }
}
