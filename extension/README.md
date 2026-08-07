# VsCodeOsCore

The VS Code OS desktop shell. VS Code OS has no desktop environment — the editor
*is* the user interface — so this extension supplies the parts of a desktop the
editor does not have.

It ships as a **built-in extension** in both images (see
[Packaging](#packaging)), so it is present on first boot and cannot be
accidentally uninstalled.

## What it adds

| | |
| --- | --- |
| **Launcher** | An all-apps button in the bottom-left corner: a searchable grid of every program |
| **Tray** | Notifications, now-playing, battery, volume, network, Bluetooth, clock and date, and the power button, at the right end of the status bar |
| **Flyouts** | Apps, power, calendar, power settings, volume mixer, network picker, Bluetooth, music player and notifications |
| **Notifications** | Serves `org.freedesktop.Notifications`, turning every desktop notification on the machine into an editor notification |
| **Task Manager** | Processes with CPU/RAM, per-core meters, load, uptime and thermals, in the activity bar |
| **Files** | A graphical file explorer: places sidebar, grid/list, rename, trash, copy/paste, and archives that browse like folders. Everything opens in the editor |
| **Recycle Bin** | Restore or permanently delete what the Files app trashed, from the places list or the activity bar |
| **Browser** | A headless Chromium streamed into an editor tab, with tabs, an address bar and history |
| **Media Player** | Video and audio in a tab, with a folder playlist |
| **Music** | MPRIS transport for whatever is playing, plus launchers for Spotify Web and YouTube Music |
| **System Settings** | Display, keyboard, sound devices, storage, updates and about, in one app |
| **Firewall** | A GUI over `ufw`: master switch, default policies, rules and presets |
| **Apps** | Calculator, Paint, Screenshot and Voice Recorder |

Every feature is behind a `vscodeos.<feature>.enabled` setting, all defaulting to
on. The all-apps button, or `VS Code OS: All Apps…` in the command palette,
lists everything.

### Four things worth knowing

**The flyouts are not popups.** VS Code has no API to anchor one to a status bar
item, and the only floating-window route — moving an editor to an auxiliary
window — brings editor tab chrome with it and cannot be sized or placed. So they
are a webview view, in the side bar by default. The bottom panel, where they used
to live, is where the terminal is; `vscodeos.flyout.location` puts them back.

**The browser is a screencast.** Every site worth visiting sends
`X-Frame-Options`, which is why VS Code's own Simple Browser shows a blank
rectangle on most of them. `puppeteer-core` drives a headless Chromium, CDP's
`Page.startScreencast` pushes JPEG frames into an `<img>`, and pointer and key
events go back through `Input.dispatch*`. That costs an encode and a decode per
frame, so `vscodeos.browser.frameRate` and `vscodeos.browser.quality` are
settings — turn them down on a Pi — the stream stops when the tab is hidden, and
"Open in browser" is always there. `puppeteer-core` is bundled into
`dist/extension.js` like everything else.

**The shell is the notification daemon, not a listener.** Nothing on either
image owns `org.freedesktop.Notifications`, so every `notify-send` on the
machine used to fail silently. `dbus-monitor` would not have helped: it can
watch traffic to a daemon but cannot answer a method call, and the problem was
that there was no daemon. So `src/sys/notifications.ts` claims the name over
`dbus-next` — the extension's second runtime dependency, bundled like the first
— implements `Notify`, `CloseNotification`, `GetCapabilities` and
`GetServerInformation`, and emits `NotificationClosed` and `ActionInvoked`. If
something else already holds the name, it logs and walks away.

`src/sys/usocket.ts` is the odd corner. dbus-next's abstract-socket branch calls
`require('usocket')`, a native addon we do not ship, with no guard around it —
and `vscodeos-kiosk`'s `dbus-launch` fallback produces exactly that address form,
so the machines that needed the fallback would have been the ones where this
quietly failed. `node:net` has handled Linux abstract sockets for years, so
esbuild aliases `usocket` to a stub built on it.

**Print Screen is bound by the window manager, not here.** On X11 the Print key
never reaches Electron as a keydown, so a contributed keybinding cannot see it.
Openbox runs `/usr/local/bin/vscodeos-screenshot`, which hands
`vscode://vscodeos.vscodeos-core/screenshot?mode=region` to the running editor,
where a `registerUriHandler` picks it up.

## Developing

```bash
cd extension
npm install
npm run watch     # esbuild in watch mode
```

Then press <kbd>F5</kbd> in VS Code to launch an Extension Development Host. Most
of it works on any Linux desktop; the `sys/*` modules degrade to a hidden status
bar item when the binary they need is missing, so a machine without `nmcli` or
`wpctl` just shows fewer tray items rather than erroring.

```bash
npm run typecheck  # tsc --noEmit
npm test           # node:test, no framework to install
npm run package    # production bundles
```

CI runs all three before either image build starts. The tests cover the two
self-contained modules — the calculator's expression evaluator and the
formatters — because everything else here talks to `/proc`, `nmcli` or the
VS Code API and is verified by running the thing. That is a narrow surface, but
it is the surface where a mistake is invisible: unary minus alone accounted for
three real bugs (`5 − −3`, `2 × −3`, and the `±` key emitting an ASCII hyphen
the tokenizer did not handle).

## Layout

```
src/
  extension.ts     activate(): wires everything, one DisposableStore
  sys/             the only code that touches the machine
  statusbar/       the tray, and the priority ladder that orders it
  views/           flyout (side bar), task manager and recycle bin (activity
                   bar) providers
  apps/            registry, file explorer, browser, media player, firewall,
                   system settings (settings/updates.ts inside it), mini-apps,
                   panel plumbing
  webview/         HTML shell + the host↔webview message types
media/
  src/             one TypeScript entry point per page, shared code in src/lib
  css/             one stylesheet, all colours from --vscode-* variables
  icons/           container and panel icons, plus vscodeos-icons.woff
```

`vscodeos-icons.woff` exists because **none of codicon's 753 icons is a power
symbol** — the nearest is `circle-slash`, a "no entry" sign — so the tray's power
button draws IEC 5009 from a one-glyph font of our own, registered under
`contributes.icons` and used as `$(vscodeos-power)`. It is generated by
`media/icons/build-font.py` to codicon's metrics (300 units per em, 19-unit
stroke) so it sits level with the `$(plug)` and `$(volume)` glyphs beside it. The
font is committed; the generator needs `fonttools` and only runs if the glyph
changes.

`src/webview/protocol.ts` is imported by both sides, so a change to a message
shape is a compile error in the webview that consumes it.

## Packaging

`scripts/build-extension.sh` (in the repo root) produces the tree that ships:

```
/usr/share/vscodeos/extensions/vscodeos-core/
```

and `vscodeos-install-extensions` copies it into

```
/opt/visual-studio-code/resources/app/extensions/vscodeos-core/
```

That folder is VS Code's built-in extension directory. It is scanned as a plain
directory — no `extensions.json`, no marketplace metadata — and built-ins skip
the engine version check entirely, so a VS Code update can never mark the shell
incompatible. The trade is that `vscodeos-update-code` replaces the whole app
tree, so it re-runs `vscodeos-install-extensions --force` afterwards.

Being a built-in has one hard consequence: **stable API only.** Proposed APIs
for built-in extensions are gated on Microsoft's `product.json`, which we do not
control.

## Things this cannot do, and why

These are VS Code and Electron limits, not missing work:

- **No popup anchored to a status bar item.** There is no such API. The flyouts
  are a webview view in the bottom panel, which is why they open above the
  status bar; the panel's height is workbench layout state with no API, so a
  flyout opens at whatever height the panel was last left at.
- **The power button is only rightmost because of a setting.** The notifications
  bell registers at `NEGATIVE_INFINITY` and extension priorities are clamped to
  `-Number.MAX_VALUE`, so no extension can outrank it. The images ship
  `"workbench.notifications.position": "top-right"`, which removes the bell from
  the status bar. Without it the power button sits second from the right.
- **No microphone in a webview.** VS Code's Electron main process omits `media`
  from the permissions it grants webviews, so `getUserMedia({audio:true})` is
  denied outright. The recorder is a `pw-record` subprocess with a webview UI.
- **Spotify audio cannot play inside VS Code.** Stock Electron ships no Widevine
  CDM, so the Web Playback SDK cannot decrypt anything, and `open.spotify.com`
  refuses to be framed. This is why the music player controls real players over
  MPRIS and launches the services as browser app windows — Chromium exports
  MPRIS, so playback there is fully controllable from the tray.
- **Root-owned processes cannot be ended directly.** There is no polkit
  authentication agent in the kiosk session, so `pkexec` has nothing to prompt
  with. End task on another user's process opens a terminal with
  `sudo kill -9 <pid>` ready to run instead.
- **Anything else that needs root goes through a helper script.** For the same
  reason: `pkexec` only works without a prompt for programs polkit has been told
  about by exact path. Updates, Storage Sense's system clean-up and the whole of
  the Firewall app run through `vscodeos-update`, `vscodeos-clean` and
  `vscodeos-firewall` in `rootfs-common/usr/local/bin/`. Each takes a fixed
  vocabulary of words and validates its arguments; none accepts a command line,
  because each one is a password-free path to root.
- **Archives are read-only.** They browse like folders and extract, but nothing
  can be added to an existing one — `bsdtar` cannot append to a zip, and
  half-supporting it would be worse than not offering it.
