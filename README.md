# VS Code OS

A Linux distribution whose entire user interface is Visual Studio Code.

It is a minimal Arch Linux base with the official Microsoft build of VS Code
layered on top. There is no desktop environment and no application menu: the
machine boots, logs in and puts the editor on screen fullscreen, and that is the
whole system. What a desktop would normally give you — a tray with a clock and a
power button, a task manager, a file manager, a browser, a handful of small apps
— is supplied by **VsCodeOsCore**, an extension built into the editor itself.

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

Two images are published for every release, sharing the same kiosk:

| | `x86_64.iso` (PCs) | `aarch64-rpi.img.xz` (Raspberry Pi) |
| --- | --- | --- |
| **Base** | Arch Linux, built with `archiso` | Arch Linux ARM |
| **Editor** | Official VS Code, `linux-x64` | Official VS Code, `linux-arm64` |
| **Session** | Xorg + Openbox kiosk — no panel, no launcher, no desktop | same |
| **Shell** | VsCodeOsCore, built into the editor | same |
| **Browser** | Chromium | Chromium |
| **Toolchain** | git, git-lfs, Node.js, Python, base-devel, Docker | git, Node.js, Python, base-devel |
| **Boot** | UEFI (x64 and ia32) and legacy BIOS, one hybrid image | Pi firmware from a FAT partition |
| **Getting it onto a machine** | live medium + `vscodeos-install` | flash the image; it *is* the system |

Neither image ships Go, Rust or the JDK. They are the heaviest toolchains Arch
packages — over a gigabyte of installed files between them — and both releases
have to stay under GitHub's 2 GiB asset limit. Install whichever you need from
the editor's terminal, once, on the installed system:

```bash
sudo pacman -S go rust jdk-openjdk
```

The Pi image is leaner still, because an SD card is small and a Pi has little
RAM: it also leaves out Docker and git-lfs.

Nothing is pinned to a version. Both images are assembled from the Arch Linux
and Arch Linux ARM repositories as they stand on the day of the release, so
each release is a current system rather than a frozen one. The `.packages.txt`
file published next to each image lists exactly which versions it shipped.

### The desktop shell

The editor has no menu bar and no window controls, so everything a desktop needs
lives in **VsCodeOsCore** — a VS Code extension that ships *inside* the editor
rather than being installed from the Marketplace. Its source is in
[`extension/`](extension/), and it adds:

- **A tray**, at the right end of the status bar. Left to right: now playing,
  battery, volume, network, the clock and date, and the power button in the
  corner. Each one opens a flyout in the bottom panel — a Windows-style card
  that rises directly above the item you clicked.
- **Power** — sleep, restart, shut down and log out, with a confirmation.
- **Calendar** — a month grid with today highlighted, on the clock.
- **Quick settings** — Wi-Fi, Bluetooth, airplane mode, energy saver, night
  light and accessibility, plus brightness and volume sliders. Tiles hide
  themselves when the hardware is not there, rather than showing a dead switch.
- **Network** — scan, connect with a password, and switch between saved
  connections.
- **Task Manager**, in the activity bar — processes with CPU and memory, per-core
  meters, load average, uptime and CPU temperature, sortable and filterable, with
  End task.
- **Files** — a graphical file explorer with a places sidebar, grid and list
  views, rename, trash, copy and paste. Text opens in the editor; everything else
  goes to `xdg-open`.
- **Music** — transport controls for whatever is playing, over MPRIS, plus
  one-click launchers that open Spotify Web and YouTube Music as their own
  browser windows.
- **Apps** — Calculator, Notepad, Paint, Screenshot and Voice Recorder. `VS Code
  OS: All Apps…` in the command palette (**Ctrl** + **Shift** + **P**) lists
  everything.

Two honest limits, both imposed by VS Code rather than by this project:
**Spotify audio cannot play inside the editor** (VS Code's Electron ships no
Widevine, so the Web Playback SDK cannot work — which is exactly why the player
controls a real browser window instead), and **Microsoft Edge is not on either
image** (it is AUR-only on Arch, and Microsoft publishes no ARM64 Linux build at
all, so the Pi could never have matched). The browser launcher prefers
`microsoft-edge-stable` if you install it yourself, and falls back to Chromium.

Every part of the shell can be turned off individually in settings under
`vscodeos.*`; [`extension/README.md`](extension/README.md) has the details.

### Supported Raspberry Pi models

64-bit boards only: **Pi 5, Pi 4, Pi 400, CM4, Pi 3/3+ and Zero 2 W**. A 4 GB
Pi 4 or a Pi 5 is what you want — VS Code is an Electron application, and on
1–2 GB boards it leans hard on the zram swap the image configures. 32-bit-only
boards (Pi 1, 2, Zero/Zero W) are not supported.

## Getting an image

Both images are on the [latest release](../../releases/latest).

### PCs

Write the ISO to a USB stick, or burn it to a CD/DVD — it is a hybrid image, so
the same file works for both:

```bash
sudo dd if=VSCodeOS-<version>-x86_64.iso of=/dev/sdX bs=4M status=progress oflag=sync
```

On Windows use [Rufus](https://rufus.ie) or [balenaEtcher](https://etcher.balena.io)
in DD/image mode.

Boot the medium; VS Code appears on its own. Nothing is written to the computer
until you run the installer.

### Raspberry Pi

A Pi cannot boot an ISO — its firmware reads the first FAT partition of the
card directly, with no BIOS and no stock UEFI — so the Pi target is a flashable
disk image instead. Use [Raspberry Pi Imager](https://www.raspberrypi.com/software/)
("Use custom" → pick the `.img.xz`), balenaEtcher, or:

```bash
xz -dc VSCodeOS-<version>-aarch64-rpi.img.xz |
  sudo dd of=/dev/sdX bs=4M status=progress oflag=sync
```

The image unpacks to 6 GiB, so an 8 GB card is the minimum; 16 GB or more
leaves room to work in.

There is no installer step: **the flashed card is the installed system**. On
first boot the root filesystem expands to fill the card, and the editor comes
up. The default login is `vscodeos` / `vscodeos` — change it with `passwd` from
the editor's terminal. Root is locked; use `sudo`.

## Installing onto a PC

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

Recovery is by design, not by accident, and differs by target:

- **PC** — choose **recovery mode** in the GRUB menu, or append
  `systemd.unit=multi-user.target` to the kernel command line.
- **Raspberry Pi** — put the card in any computer and append
  `systemd.unit=multi-user.target` to `cmdline.txt` on the FAT boot partition.
  It is plain FAT, so Windows and macOS can edit it too. Keep it to one line.

A session that cannot start is the one case where the kiosk gets out of your
way: if `startx` dies three times in a row within seconds, tty1 stops retrying
and leaves an ordinary shell with the reason on screen — the tail of
`~/.local/share/vscodeos/xorg-session.log` and, when the X server did come up,
of `~/.local/share/vscodeos/kiosk.log`. The full X server log is in
`~/.local/share/xorg/Xorg.0.log`. Without that stop, an auto-logged-in tty1
answers a broken session by logging straight back in, which looks like the
machine looping on its login banner.

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
nmtui                       # join a Wi-Fi network (or use the tray)
code ~/Projects/thing       # open something in the running editor
```

Extensions, settings sync and Marketplace sign-in all work normally;
`gnome-keyring` is started by the session so credentials persist.

`vscodeos-update-code` replaces the whole editor tree, which is where the shell
lives, so it reinstalls VsCodeOsCore afterwards. To do that by hand — say after
unpacking a VS Code build yourself:

```bash
sudo vscodeos-install-extensions --force
```

## Building the images

### With GitHub Actions

Pushing a tag builds both images in parallel and publishes one release with
each image and its SHA-256 checksum attached:

```bash
git tag v1.0.0
git push origin v1.0.0
```

The x86-64 ISO builds on a standard runner; the Pi image builds on a native
`ubuntu-24.04-arm` runner, so it can chroot into the image instead of emulating
every command through QEMU. (These arm64 runners are free for public
repositories; a private repo needs a plan that includes them.)

The **Build images** workflow can also be run manually from the Actions tab,
where you can pick one target or both and pin a specific VS Code version. A
manual run uploads the images as build artifacts and does not create a
release.

Pull requests run the desktop shell's typecheck, tests and bundle build, and
nothing else — a couple of minutes, and the only part of a build that fails on
a code mistake rather than on a mirror or a runner. The images themselves are
two-hour builds producing gigabyte artifacts, so they stay on tags and manual
runs.

### Locally

Both builds compile the desktop shell first, so a local build needs **Node.js**
on the machine doing the building — `pacman -S nodejs npm`, or whatever your
distribution calls it. The container one-liner below installs it itself. Pass
`VSCODEOS_SKIP_EXTENSION=1` to leave the shell out and build the bare kiosk.

**x86-64 ISO** — needs Docker (or an Arch host with `archiso`) and roughly
20 GB of free disk space:

```bash
docker run --rm --privileged --pull always -v "$PWD:/build" -w /build archlinux:latest \
  bash -c 'pacman -Sy --noconfirm --needed archlinux-keyring &&
           pacman -Syu --noconfirm --needed archiso git grub nodejs npm &&
           ./scripts/build-iso.sh -v 1.0.0'
```

```bash
qemu-system-x86_64 -m 4G -enable-kvm -cdrom out/VSCodeOS-1.0.0-x86_64.iso
```

**Raspberry Pi image** — best run on an aarch64 machine (another Pi, an ARM
laptop, an ARM VM), because the build chroots into the image it is assembling:

```bash
sudo apt-get install -y libarchive-tools dosfstools e2fsprogs xz-utils util-linux nodejs npm
sudo ./rpi/build-image.sh -v 1.0.0
```

On x86-64 the same script works through QEMU's binfmt handler, considerably
more slowly. Register it first:

```bash
docker run --privileged --rm tonistiigi/binfmt --install arm64
sudo ./rpi/build-image.sh -v 1.0.0
```

Both builds write to `out/`, each alongside a `.sha256` checksum and a
`.packages.txt` manifest listing every package version that went into that
image. The build prints the headline versions — kernel, toolchain, graphics
stack — when it finishes.

## How the repository is laid out

```
extension/                          VsCodeOsCore, the desktop shell
  src/                              extension host: sys/, statusbar/, views/, apps/
  media/                            one webview bundle per page, plus the stylesheet
                                    (see extension/README.md)

rootfs-common/                      the kiosk, shared by both images
  etc/passwd, group, shadow         the kiosk account (uid 1000)
  etc/systemd/system/               autologin on tty1, enabled services
  etc/X11/xorg.conf.d/              kiosk hardening (DontVTSwitch, DontZap)
  etc/polkit-1/rules.d/             power and NetworkManager without a password
  etc/udev/rules.d/                 backlight writable by the `video` group
  etc/default/vscodeos              kiosk settings
  etc/skel/                         the kiosk user's home: .xinitrc, openbox
                                    rules, VS Code settings and keybindings
  usr/local/bin/vscodeos-kiosk      the session supervisor
  usr/local/bin/vscodeos-update-code
  usr/local/bin/vscodeos-install-extensions

archiso/                            x86-64 only
  profiledef.sh                     archiso profile: image name, boot modes
  packages.x86_64                   packages for the PC image
  pacman.conf                       repositories used while building
  airootfs/                         live-medium extras layered over the shared
                                    rootfs: archiso initramfs hooks, Arch
                                    mirrors, and vscodeos-install

rpi/                                Raspberry Pi only
  build-image.sh                    assembles the flashable disk image
  packages.aarch64                  packages for the Pi image
  boot/config.txt, cmdline.txt      Raspberry Pi firmware configuration
  overlay/                          fstab, ALARM mirrors, zram, the vc4
                                    PrimaryGPU rule for Xorg, and the
                                    first-boot root filesystem expansion

scripts/
  build-iso.sh                      assembles the profile and runs mkarchiso
  fetch-vscode.sh                   downloads and stages VS Code (x64 or arm64)
  build-extension.sh                bundles VsCodeOsCore for both images
  pkg-versions.sh                   summarises a build's package manifest
.github/workflows/build-iso.yml     tag -> both images -> one GitHub release
```

Details worth knowing if you are modifying it:

- **The kiosk is shared, the plumbing is not.** Everything in `rootfs-common/`
  is copied into both images; anything architecture-specific lives in
  `archiso/airootfs/` or `rpi/overlay/`.
- **The shell is a built-in extension, not a Marketplace one.** Both builds stage
  it at `/usr/share/vscodeos/extensions/`, then `vscodeos-install-extensions`
  copies it into `/opt/visual-studio-code/resources/app/extensions/`. That
  directory is a plain scan — no `extensions.json`, no version check — so a
  VS Code update can never decide the desktop is incompatible and disable it. It
  does, however, replace the whole tree, which is why `vscodeos-update-code`
  re-runs the installer.
- **The extension is built once, for both images.** It is architecture-neutral
  JavaScript, so CI has a separate `extension` job and passes the result to both
  image jobs via `VSCODEOS_EXTENSION_PREBUILT`. Local builds compile it on the
  spot and cache the result; `VSCODEOS_SKIP_EXTENSION=1` leaves it out when you
  are only iterating on the OS.
- **Boot menus are not vendored.** `build-iso.sh` copies `syslinux/`, `grub/`
  and `efiboot/` out of the `archiso` package installed in the build
  environment and rebrands the labels, so the boot configuration always matches
  the version of `mkarchiso` doing the build.
- **`/home/vscodeos` is materialised at build time** on the ISO, because
  `mkarchiso` never runs `useradd`; the account is declared directly in
  `rootfs-common/etc/passwd`. The Pi build has a working chroot, so it runs
  `useradd` normally and skips those four files.
- **The Pi addresses its root filesystem by PARTUUID**, derived from a fixed MBR
  disk identifier in `build-image.sh`. `cmdline.txt` and `fstab` hardcode the
  matching values, and the build asserts they agree — a mismatch would be a
  kernel panic on real hardware.
- **Nothing pins a package version.** Both builds install from the repositories
  as they stand at that moment, so a rebuild is a newer system. To keep that
  honest, the x86 build container is pulled fresh and fully upgraded before
  `pacstrap` reads its databases, and the Pi build refreshes
  `archlinuxarm-keyring` before its own `pacman -Syu` — a base tarball too old
  to verify the current signing keys would otherwise fail the upgrade and ship
  the snapshot's packages instead. Each build then writes a
  `.packages.txt` manifest recording what it actually installed.

## Default credentials

**PC live ISO** — logs in automatically as `vscodeos` with no password (root is
password-less too, as on the official Arch install medium). Anyone who boots
the medium therefore has root on that machine, which is true of any live
medium. The installer sets real passwords for both accounts on the installed
system and replaces the live medium's password-less `sudo` rule with a normal
`wheel` rule.

**Raspberry Pi image** — ships with `vscodeos` / `vscodeos` and a locked root
account, because a flashed card has no installer to ask you for a password.
`sudo` requires that password. Change it on first boot:

```bash
passwd
```

## Licence

The tooling in this repository is MIT-licensed (see [LICENSE](LICENSE)).

Visual Studio Code is downloaded at build time from Microsoft and remains
subject to the [Microsoft Software Licence Terms](https://code.visualstudio.com/license);
those binaries include Microsoft-specific customisations and telemetry, and are
not the MIT-licensed `vscode` source. Arch Linux packages keep their own
licences. The Raspberry Pi image is built on [Arch Linux ARM](https://archlinuxarm.org),
a community project separate from Arch Linux. This project is not affiliated
with Microsoft, Arch Linux, Arch Linux ARM or Raspberry Pi Ltd.
