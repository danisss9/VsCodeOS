# VS Code OS

A Linux distribution whose entire user interface is Visual Studio Code.

It is a minimal Arch Linux base with the official Microsoft build of VS Code
layered on top. There is no desktop environment, no taskbar and no application
menu: the machine boots, logs in and puts the editor on screen fullscreen, and
that is the whole system. Everything else — package management, networking,
git, compilers — is reached through the editor's integrated terminal.

```
   power on
      │
      ├─ systemd ──▶ autologin on tty1
      │                  │
      │                  └─ startx ──▶ openbox (no keybindings, no decorations)
      │                                   │
      └───────────────────────────────────┴─▶ Visual Studio Code, fullscreen
                                                  ↑         │
                                                  └─────────┘
                                            respawned if it ever exits
```

## What you get

| | |
| --- | --- |
| **Base** | Arch Linux (rolling, `base` + `linux`), built with `archiso` |
| **Editor** | Official Visual Studio Code (`stable`, x86-64), in `/opt/visual-studio-code` |
| **Session** | Xorg + Openbox as a kiosk frame — no panel, no launcher, no desktop |
| **Toolchain** | git, Node.js, Python, Go, Rust, JDK, base-devel, Docker |
| **Networking** | NetworkManager (`nmtui` from the terminal), Wi-Fi firmware included |
| **Firmware** | Boots on UEFI (x64 and ia32) and legacy BIOS from the same image |
| **Installer** | `vscodeos-install` — offline, copies the live system to disk |

## Getting an image

Download the ISO from the [latest release](../../releases/latest), then write
it to a USB stick (or burn it to a CD/DVD — it is a hybrid image, so the same
file works for both):

```bash
sudo dd if=VSCodeOS-<version>-x86_64.iso of=/dev/sdX bs=4M status=progress oflag=sync
```

On Windows use [Rufus](https://rufus.ie) or [balenaEtcher](https://etcher.balena.io)
in DD/image mode.

Boot the medium; VS Code appears on its own. Nothing is written to the computer
until you run the installer.

## Installing onto a computer

Open the integrated terminal in the editor (**Ctrl** + **`**) and run:

```bash
sudo vscodeos-install
```

The installer asks for a target disk, hostname, username, password, timezone
and keyboard layout, then partitions the disk, copies the running system onto
it and installs GRUB. Because it copies the live medium rather than downloading
packages, **the installation works with no network connection at all** and
takes a few minutes.

Non-interactive installs are supported too:

```bash
sudo vscodeos-install --target /dev/sda --unattended   # DESTROYS /dev/sda
```

## Living with a kiosk

The editor is deliberately hard to escape:

- **No close or minimise.** Openbox runs with an empty `<keyboard>` section, so
  Alt+F4, Alt+Space and the workspace shortcuts do nothing, and the window is
  drawn undecorated and fullscreen. VS Code's own `Ctrl+Q`, `Ctrl+Shift+W` and
  `F11` bindings are unbound in `keybindings.json`, and its menu bar is hidden.
- **It comes back.** `vscodeos-kiosk` supervises the editor: if it exits or
  crashes it is relaunched immediately (with a back-off if it is crash-looping),
  and the supervisor ignores `SIGHUP`/`SIGINT`/`SIGQUIT` so a stray Ctrl+C or
  terminal hangup cannot end the session. `SIGTERM` is honoured so that reboots
  and shutdowns stay quick.
- **No console escape.** `DontVTSwitch` and `DontZap` are set for Xorg, so
  Ctrl+Alt+F2 and Ctrl+Alt+Backspace do not drop out of the session.

Recovery is by design, not by accident: choose **recovery mode** in the GRUB
menu (or append `systemd.unit=multi-user.target` to the kernel command line) to
get a plain root console instead of the kiosk.

To relax the kiosk permanently, edit `/etc/default/vscodeos`:

```bash
VSCODEOS_WORKSPACE="$HOME/Projects"   # folder opened on boot
VSCODEOS_CODE_FLAGS=""                # extra flags for every launch
VSCODEOS_RESPAWN=1                    # 0 = do not relaunch when VS Code exits
```

## Day-to-day

```bash
sudo pacman -Syu            # update the Arch base
sudo vscodeos-update-code   # update VS Code itself (it is not a pacman package)
nmtui                       # join a Wi-Fi network
code ~/Projects/thing       # open something in the running editor
```

Extensions, settings sync and Marketplace sign-in all work normally;
`gnome-keyring` is started by the session so credentials persist.

## Building the ISO

### With GitHub Actions

Pushing a tag builds the image and publishes a release with the ISO and its
SHA-256 checksum attached:

```bash
git tag v1.0.0
git push origin v1.0.0
```

The **Build ISO** workflow can also be run manually from the Actions tab —
useful for testing a change, or for pinning a specific VS Code version. A
manual run uploads the ISO as a build artifact and does not create a release.

### Locally

You need Docker (or an Arch host with `archiso` installed) and roughly 20 GB of
free disk space:

```bash
docker run --rm --privileged -v "$PWD:/build" -w /build archlinux:latest \
  bash -c 'pacman -Sy --noconfirm --needed archlinux-keyring &&
           pacman -Su --noconfirm --needed archiso git &&
           ./scripts/build-iso.sh -v 1.0.0'
```

The finished image lands in `out/`. Test it without leaving your desk:

```bash
qemu-system-x86_64 -m 4G -enable-kvm -cdrom out/VSCodeOS-1.0.0-x86_64.iso
```

## How the repository is laid out

```
archiso/
  profiledef.sh                     archiso profile: image name, boot modes
  packages.x86_64                   every package installed into the image
  pacman.conf                       repositories used while building
  airootfs/                         files overlaid onto the image's root
    etc/passwd, group, shadow       the kiosk account (uid 1000)
    etc/systemd/system/             autologin on tty1, enabled services
    etc/X11/xorg.conf.d/            kiosk hardening (DontVTSwitch, DontZap)
    etc/default/vscodeos            kiosk settings
    etc/skel/                       the kiosk user's home: .xinitrc, openbox
                                    rules, VS Code settings and keybindings
    usr/local/bin/vscodeos-kiosk    the session supervisor
    usr/local/bin/vscodeos-install  the offline installer
    usr/local/bin/vscodeos-update-code
scripts/
  build-iso.sh                      assembles the profile and runs mkarchiso
  fetch-vscode.sh                   downloads and stages the VS Code tarball
.github/workflows/build-iso.yml     tag -> ISO -> GitHub release
```

Two details worth knowing if you are modifying it:

- **Boot menus are not vendored.** `build-iso.sh` copies `syslinux/`, `grub/`
  and `efiboot/` out of the `archiso` package installed in the build
  environment and rebrands the labels, so the boot configuration always matches
  the version of `mkarchiso` doing the build.
- **`/home/vscodeos` is materialised at build time** from `etc/skel`, because
  `mkarchiso` never runs `useradd`; the account itself is declared directly in
  `airootfs/etc/passwd`.

## Live medium credentials

The live ISO logs in automatically as `vscodeos` with no password (root is
password-less too, as on the official Arch install medium). The installer sets
real passwords for both accounts on the installed system and replaces the live
medium's password-less `sudo` rule with a normal `wheel` rule.

## Licence

The tooling in this repository is MIT-licensed (see [LICENSE](LICENSE)).

Visual Studio Code is downloaded at build time from Microsoft and remains
subject to the [Microsoft Software Licence Terms](https://code.visualstudio.com/license);
those binaries include Microsoft-specific customisations and telemetry, and are
not the MIT-licensed `vscode` source. Arch Linux packages keep their own
licences. This project is not affiliated with Microsoft or Arch Linux.
