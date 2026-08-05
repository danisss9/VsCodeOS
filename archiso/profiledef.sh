#!/usr/bin/env bash
# shellcheck disable=SC2034

iso_name="vscodeos"
iso_label="VSCODEOS_$(date +%Y%m)"
iso_publisher="VS Code OS <https://github.com/danisss9/VsCodeOS>"
iso_application="VS Code OS Live/Install Medium"
iso_version="${ISO_VERSION:-$(date +%Y.%m.%d)}"
install_dir="arch"
buildmodes=('iso')
bootmodes=('bios.syslinux.mbr' 'bios.syslinux.eltorito'
           'uefi-ia32.grub.esp' 'uefi-ia32.grub.eltorito'
           'uefi-x64.grub.esp' 'uefi-x64.grub.eltorito')
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
  ["/usr/local/bin/code"]="0:0:755"
  ["/etc/sudoers.d/vscodeos"]="0:0:0440"
)
