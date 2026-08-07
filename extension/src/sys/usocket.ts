// A stand-in for the `usocket` package, which dbus-next reaches for and which
// is not installed here.
//
// usocket is a native addon whose reason to exist is file-descriptor passing
// over a Unix socket, plus abstract-namespace addresses. We need neither: fd
// passing is only used when a caller asks for `negotiateUnixFd`, which nothing
// here does, and Node's own `net` has supported Linux abstract sockets - a path
// beginning with a NUL - for years.
//
// This matters because of how the session bus gets started. When logind is
// driving the session the address is `unix:path=/run/user/<uid>/bus` and
// dbus-next's fallback would have been fine; but vscodeos-kiosk falls back to
// `dbus-launch` when the login session provided no bus, and dbus-launch hands
// back `unix:abstract=/tmp/dbus-XXXXXX`. dbus-next's abstract branch calls
// `require('usocket')` with no guard around it, so on exactly the machines that
// needed the fallback the notification server would have failed to connect.
//
// esbuild.mjs aliases `usocket` to this file, so dbus-next gets a working
// USocket for both address forms and the extension ships no native code.

import * as net from 'node:net';

export interface USocketOptions {
    /** A filesystem path, or one prefixed with NUL for the abstract namespace. */
    path: string;
}

export class USocket extends net.Socket {
    /**
     * dbus-next assigns this after construction and branches on it: false means
     * "write a plain Buffer", which is the only thing this shim supports.
     */
    supportsUnixFd = false;

    constructor(options: USocketOptions) {
        super();
        this.connect({ path: options.path });
    }
}
