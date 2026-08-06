# Welcome to VS Code OS

This machine boots straight into Visual Studio Code. There is no desktop
behind this window — the editor *is* the desktop.

## Getting started

- **Terminal** — `` Ctrl+` `` opens an integrated terminal. It is a normal
  Arch Linux shell with `sudo`, `pacman`, `git`, `node`, `python` and a C
  toolchain already installed. Bigger toolchains are left out to keep the
  download small — `sudo pacman -S go rust jdk-openjdk` adds them.
- **Your files** — this folder (`~/Projects`) is what VS Code opens on boot.
  Anything you put here is waiting for you next time.
- **Extensions** — the Extensions view (`Ctrl+Shift+X`) works exactly as it
  does anywhere else, signed in to the Marketplace.
- **Wi-Fi** — run `nmtui` in the terminal to join a network.

## Installing to this computer

If you are running from a USB stick or CD, install VS Code OS permanently:

```bash
sudo vscodeos-install
```

The installer copies this exact system to a disk of your choice, so the
installed machine needs no network connection.

## Housekeeping

```bash
sudo pacman -Syu              # update the system
sudo vscodeos-update-code     # update Visual Studio Code itself
```

## Where things live

| Path | What it is |
| --- | --- |
| `/opt/visual-studio-code` | The VS Code installation |
| `/etc/default/vscodeos` | Kiosk settings (workspace folder, launch flags) |
| `~/.config/openbox/rc.xml` | Window rules that keep the editor fullscreen |
| `~/.local/share/vscodeos/kiosk.log` | Session log, useful when something fails |

Closing the editor does nothing on purpose: it reopens immediately. To get a
plain console instead, pick **recovery mode** in the boot menu.
