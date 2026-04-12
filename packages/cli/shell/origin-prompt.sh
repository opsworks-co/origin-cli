#!/usr/bin/env sh
# Origin shell prompt integration
#
# Usage — add ONE of the following to your ~/.bashrc or ~/.zshrc:
#
#   eval "$(origin shell-prompt)"
#
# This defines the _origin_prompt function and wires it into your prompt.
# The function calls `origin prompt-status` which outputs either:
#   [origin: tracking · $0.34]   — when a session is active and running
#   [origin: idle · $0.34]       — when a session is paused/idle
#   (empty)                      — when no session is active
#
# Performance: prompt-status does no API calls or git spawns.
# It reads a small JSON file from .git/ — typically < 5ms.

_origin_prompt() {
  # Run origin prompt-status; capture output
  # Silence any errors so the prompt never breaks
  local _status
  _status="$(origin prompt-status 2>/dev/null)" || return
  printf '%s' "$_status"
}

# ── Bash integration ────────────────────────────────────────────────────────
if [ -n "$BASH_VERSION" ]; then
  # Append origin status to PS1.
  # We wrap in a function called by PROMPT_COMMAND so it's evaluated fresh
  # each time (dynamic cost/status updates).
  _origin_update_ps1() {
    local _origin_info
    _origin_info="$(_origin_prompt)"
    if [ -n "$_origin_info" ]; then
      # Insert before the trailing space / $ of the default PS1.
      # We store the base PS1 on first call so repeated calls don't stack.
      if [ -z "$_ORIGIN_BASE_PS1" ]; then
        export _ORIGIN_BASE_PS1="$PS1"
      fi
      PS1="${_ORIGIN_BASE_PS1} ${_origin_info} "
    else
      # No active session — restore original PS1
      if [ -n "$_ORIGIN_BASE_PS1" ]; then
        PS1="$_ORIGIN_BASE_PS1"
      fi
    fi
  }

  # Prepend to PROMPT_COMMAND (preserve any existing commands)
  if [[ "$PROMPT_COMMAND" != *"_origin_update_ps1"* ]]; then
    PROMPT_COMMAND="_origin_update_ps1${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
  fi

# ── Zsh integration ─────────────────────────────────────────────────────────
elif [ -n "$ZSH_VERSION" ]; then
  # For zsh: add origin status to RPROMPT (right-side prompt).
  # This keeps the left PS1 clean and shows origin info on the right.
  #
  # If you prefer it in the left prompt (PS1), replace the precmd_origin_prompt
  # function body with PS1 manipulation instead.

  autoload -Uz add-zsh-hook

  precmd_origin_prompt() {
    local _origin_info
    _origin_info="$(_origin_prompt)"
    if [ -n "$_origin_info" ]; then
      RPROMPT="%F{cyan}${_origin_info}%f"
    else
      RPROMPT=""
    fi
  }

  add-zsh-hook precmd precmd_origin_prompt
fi
