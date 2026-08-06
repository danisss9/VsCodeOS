# VS Code OS - kiosk bootstrap
#
# tty1 is auto-logged in by systemd; that login starts the graphical kiosk.
# Every other tty behaves like a normal login shell.

[[ -f ~/.bashrc ]] && . ~/.bashrc

# XDG_VTNR comes from pam_systemd and is the reliable answer, but it is empty
# if the login was not tracked by logind - fall back to the tty name so the
# kiosk still starts instead of silently leaving a bare shell.
if [[ -z "${DISPLAY:-}" ]] &&
   { [[ "${XDG_VTNR:-}" == "1" ]] || [[ "$(tty 2>/dev/null)" == "/dev/tty1" ]]; }; then

    vscodeos_session_dir="${HOME}/.local/share/vscodeos"
    vscodeos_session_log="${vscodeos_session_dir}/xorg-session.log"
    mkdir -p "${vscodeos_session_dir}"

    # startx is *not* exec'd. If it were, a session that fails to come up would
    # end the login shell, agetty would log the user straight back in, and the
    # machine would sit in a login loop with the reason buried in a log file no
    # one can reach. Running it as a child lets us tell "the user ended a real
    # session" (start another one, the kiosk is supposed to come back) apart
    # from "X died on its face" (stop, and show why).
    vscodeos_failures=0
    while :; do
        vscodeos_started=${SECONDS}
        startx -- -nolisten tcp vt1 >"${vscodeos_session_log}" 2>&1
        vscodeos_rc=$?
        vscodeos_ran=$(( SECONDS - vscodeos_started ))

        if (( vscodeos_ran >= 15 )); then
            # A session that lived is a session that worked. Log out and let
            # agetty start a fresh one, exactly as before.
            exit
        fi

        (( vscodeos_failures++ ))
        (( vscodeos_failures >= 3 )) && break
        sleep 2
    done

    printf '\n\e[38;5;203mThe VS Code OS session could not start.\e[0m\n'
    printf 'startx exited with status %s after %ss, %s times in a row.\n\n' \
        "${vscodeos_rc}" "${vscodeos_ran}" "${vscodeos_failures}"
    printf -- '--- %s (last 20 lines) ---\n' "${vscodeos_session_log}"
    tail -n 20 "${vscodeos_session_log}" 2>/dev/null
    if [[ -s "${HOME}/.local/share/vscodeos/kiosk.log" ]]; then
        printf -- '\n--- kiosk.log (last 20 lines) ---\n'
        tail -n 20 "${HOME}/.local/share/vscodeos/kiosk.log"
    fi
    printf '\nThe X server keeps its own log in ~/.local/share/xorg/Xorg.0.log\n'
    printf 'Retry the session with: startx -- -nolisten tcp vt1\n\n'

    unset vscodeos_session_dir vscodeos_session_log vscodeos_failures \
          vscodeos_started vscodeos_rc vscodeos_ran
    # Falling through leaves an interactive shell on tty1 instead of looping.
fi
