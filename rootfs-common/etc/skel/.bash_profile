# VS Code OS - kiosk bootstrap
#
# tty1 is auto-logged in by systemd; that login starts the graphical kiosk.
# Every other tty behaves like a normal login shell.

[[ -f ~/.bashrc ]] && . ~/.bashrc

if [[ -z "${DISPLAY}" && "${XDG_VTNR}" == "1" ]]; then
    mkdir -p ~/.local/share/vscodeos
    exec startx -- -nolisten tcp vt1 &> ~/.local/share/vscodeos/xorg-session.log
fi
