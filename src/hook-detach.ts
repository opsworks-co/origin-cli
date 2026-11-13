/**
 * Shell fragments for starting the CLI from a git hook so it outlives the
 * agent that ran git.
 *
 * Codex kills whatever a git command's hooks leave running once its shell
 * command exits: a plain `&`, `nohup` and a single `setsid` all died there, so
 * no Codex commit ever reached the post-commit capture (session 7383ad5a) and
 * no Codex amend, rebase, checkout or pull reached its hook either. A double
 * fork with setsid in between survives, measured under Codex 0.158. perl does
 * it in one foreground step that returns at once; where perl is missing, and
 * on Windows (untested there), plain `&` as before.
 *
 * perl's parent waits for its child to be out of the process group: it holds a
 * pipe until after setsid. Without that the hook can return, and the agent kill
 * the group, while the child is still in it. With the kill right after the hook
 * returned, that lost about 1 launch in 10 (58 of 600; 0 of 600 with the pipe).
 */

/** The launch before it waited for setsid. Still on disk until a hook is upgraded. */
const UNSYNCED_DETACH = 'exit 0 if fork; POSIX::setsid(); exit 0 if fork; exec @ARGV';
const SYNCED_DETACH = 'pipe(my $r, my $w); if (fork) { close $w; sysread($r, my $b, 1); exit 0 } close $r; POSIX::setsid(); close $w; exit 0 if fork; exec @ARGV';

/** Whether a hook script still has the launch that can die with its process group. Pure. */
export function hasUnsyncedDetach(script: string): boolean {
  return script.includes(UNSYNCED_DETACH);
}

/** A script with its launch brought up to date; every other line stays. Pure. */
export function syncDetach(script: string): string {
  return script.split(UNSYNCED_DETACH).join(SYNCED_DETACH);
}

/** Marker of a hook script whose CLI launch outlives the agent that ran git. */
export const DETACH_MARKER = '# origin-detach';

/**
 * Start `cmd` (env assignments + a command) detached. stdin and stdout are
 * /dev/null either way: a child holding git's stdout keeps a `git … | tee`
 * pipe open until it exits.
 */
export function detachedLaunch(cmd: string): string {
  return `${DETACH_MARKER}
if [ "$OS" != "Windows_NT" ] && command -v perl >/dev/null 2>&1 \\
  && perl -MPOSIX -e '${SYNCED_DETACH}' env ${cmd} </dev/null >/dev/null 2>&1; then :
else
  ${cmd} >/dev/null 2>&1 &
fi`;
}

/** Indent every line after the first, for a fragment placed inside a block. */
export function indentFragment(fragment: string, indent: string): string {
  return fragment.replace(/\n/g, `\n${indent}`);
}
