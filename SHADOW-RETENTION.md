# Shadow ref retention

`origin clean --shadow-refs` previews eligible refs in the current repository.
`origin clean --shadow-refs --force` applies that cleanup. An explicit
`--dry-run` always wins over `--force` in this mode.

This mode only removes refs under `refs/origin/shadow/`. It does not run the
other `clean` operations, delete session files, prune Git objects, or run GC.
It is explicit maintenance, never part of a capture hook.

A ref is eligible only when both the shadow's recorded creation time and
commit time are older than 30 days, its author has Origin's shadow identity,
and its commit message matches the ref's tag. Symbolic refs and unfamiliar
objects are retained.

Cleanup preserves refs whose SHA appears in saved evidence or whose tag
contains a saved session identity. Evidence includes common Git directory
state, legacy state in every linked worktree's Git directory, and the current
user's `~/.origin/sessions`, `queue`, and `journals`. Ended and unsynced sessions
are included without an age cutoff: they may still resume or upload. This
deliberately retains more refs than an age-only policy. Other users' home
directories and externally backed-up/deleted session files are outside this
inventory; do not use this command while restoring those files.

Unreadable, malformed, oversized, or partially written evidence stops cleanup.
An apply rescans the inventory before deleting. All deletions use one Git
transaction with expected old SHAs; if a capture refreshes a candidate ref,
the transaction aborts. Git objects remain subject to normal Git GC policy
after their refs are removed.
