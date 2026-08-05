# VS Code OS default shell configuration
[[ $- != *i* ]] && return

alias ls='ls --color=auto'
alias ll='ls -lah --color=auto'
alias grep='grep --color=auto'

PS1='\[\e[38;5;39m\]\u@\h\[\e[0m\] \[\e[38;5;250m\]\w\[\e[0m\] \$ '

export EDITOR=nano
export VISUAL=nano
export PATH="$HOME/.local/bin:$PATH"

# npm global installs land in the user's home instead of needing root
export NPM_CONFIG_PREFIX="$HOME/.local"

[[ -r /usr/share/bash-completion/bash_completion ]] && . /usr/share/bash-completion/bash_completion
