import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function shellPromptCommand() {
  // Look for the shell script relative to this file in the package tree.
  // In dist/  : __dirname = dist/commands/  → ../../shell/origin-prompt.sh
  // In src/   : __dirname = src/commands/   → ../../shell/origin-prompt.sh
  const candidates = [
    path.resolve(__dirname, '..', '..', 'shell', 'origin-prompt.sh'),
    path.resolve(__dirname, '..', '..', '..', 'shell', 'origin-prompt.sh'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      try {
        process.stdout.write(fs.readFileSync(candidate, 'utf-8'));
        return;
      } catch { /* fall through */ }
    }
  }

  // Fallback: emit the script inline so the command always works
  // even when the package is installed without the shell/ directory.
  process.stdout.write(INLINE_SCRIPT);
}

// Inline fallback — mirrors shell/origin-prompt.sh
// Uses string concatenation instead of a template literal to avoid TypeScript
// interpreting shell variable references as TS interpolations.
const INLINE_SCRIPT = [
  '#!/usr/bin/env sh',
  '# Origin shell prompt integration',
  '# Add to ~/.bashrc or ~/.zshrc:',
  '#   eval "$(origin shell-prompt)"',
  '',
  '_origin_prompt() {',
  '  local _status',
  '  _status="$(origin prompt-status 2>/dev/null)" || return',
  "  printf '%s' \"$_status\"",
  '}',
  '',
  'if [ -n "$BASH_VERSION" ]; then',
  '  _origin_update_ps1() {',
  '    local _origin_info',
  '    _origin_info="$(_origin_prompt)"',
  '    if [ -n "$_origin_info" ]; then',
  '      if [ -z "$_ORIGIN_BASE_PS1" ]; then',
  '        export _ORIGIN_BASE_PS1="$PS1"',
  '      fi',
  '      PS1="${_ORIGIN_BASE_PS1} ${_origin_info} "',
  '    else',
  '      if [ -n "$_ORIGIN_BASE_PS1" ]; then',
  '        PS1="$_ORIGIN_BASE_PS1"',
  '      fi',
  '    fi',
  '  }',
  '  if [[ "$PROMPT_COMMAND" != *"_origin_update_ps1"* ]]; then',
  '    PROMPT_COMMAND="_origin_update_ps1${PROMPT_COMMAND:+; $PROMPT_COMMAND}"',
  '  fi',
  'elif [ -n "$ZSH_VERSION" ]; then',
  '  autoload -Uz add-zsh-hook',
  '  precmd_origin_prompt() {',
  '    local _origin_info',
  '    _origin_info="$(_origin_prompt)"',
  '    if [ -n "$_origin_info" ]; then',
  '      RPROMPT="%F{cyan}${_origin_info}%f"',
  '    else',
  '      RPROMPT=""',
  '    fi',
  '  }',
  '  add-zsh-hook precmd precmd_origin_prompt',
  'fi',
  '',
].join('\n');
