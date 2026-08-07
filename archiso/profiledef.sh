#!/usr/bin/env bash
# shellcheck disable=SC2034

iso_name="vscodeos"
iso_label="VSCODEOS_$(date +%Y%m)"
iso_publisher="VS Code OS <https://github.com/danisss9/VsCodeOS>"
iso_application="VS Code OS Live/Install Medium"
iso_version="${ISO_VERSION:-$(date +%Y.%m.%d)}"
install_dir="arch"
buildmodes=('iso')
# archiso 86 folded the old '<mode>.esp'/'<mode>.eltorito' pairs into one name
# per boot loader; the split spellings still work but warn on every build.
# 'uefi.grub' writes GRUB to both an ESP and an El Torito image, and on x86_64
# it emits the ia32 binary as well, so 32-bit UEFI firmware still boots.
bootmodes=('bios.syslinux' 'uefi.grub')
arch="x86_64"
pacman_conf="pacman.conf"
airootfs_image_type="squashfs"
airootfs_image_tool_options=('-comp' 'xz' '-Xbcj' 'x86' '-b' '1M' '-Xdict-size' '1M')
bootstrap_tarball_compression=('zstd' '-c' '-T0' '--auto-threads=logical' '--long' '-19')
file_permissions=(
  ["/etc/gshadow"]="0:0:0400"
  ["/etc/shadow"]="0:0:0400"
  ["/root"]="0:0:750"
  ["/usr/local/bin/vscodeos-install"]="0:0:755"
  ["/usr/local/bin/vscodeos-kiosk"]="0:0:755"
  ["/usr/local/bin/vscodeos-update-code"]="0:0:755"
  ["/usr/local/bin/vscodeos-install-extensions"]="0:0:755"
  # These three are load-bearing for security, not just for tidiness: polkit
  # grants `pkexec` on each of them without a password, so a copy the kiosk user
  # could write to would be a one-line path to root.
  ["/usr/local/bin/vscodeos-update"]="0:0:755"
  ["/usr/local/bin/vscodeos-clean"]="0:0:755"
  ["/usr/local/bin/vscodeos-firewall"]="0:0:755"
  ["/usr/local/bin/vscodeos-screenshot"]="0:0:755"
  ["/usr/local/bin/code"]="0:0:755"
  ["/etc/sudoers.d/vscodeos"]="0:0:0440"
)
