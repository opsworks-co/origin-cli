/**
 * Shell writes must reach editsJson.
 *
 * Bug (prod session c5c94af7, repo upplabs.com): three turns restored source
 * off a Fly machine and hand-patched files with `python3 - <<'PY'` scripts —
 * 1929, 1081 and 2 lines, two of them committed. No Edit/Write tool call
 * exists for any of that, so `capturePromptEdits` recorded `{"edits":[]}`,
 * which is byte-identical to a chat-only turn. #1097 taught By-Prompt blame
 * to fall back to the git-captured diff; this is the capture-side half —
 * the turn now ships the edits themselves.
 *
 * The commands below are verbatim from that session's transcript.
 */
import { describe, it, expect } from 'vitest';
import {
  commandWritesFiles,
  stripHeredocBodies,
  isShellTool,
  shellCommandText,
  shellWindowEdits,
  SHELL_WINDOW_SOURCE,
  type ShellWindowDeps,
} from '../shell-write-capture.js';
import { mergeLedgerWithTranscript } from '../prompt-capture/index.js';
import type { PromptCapture } from '../prompt-capture/types.js';

describe('commandWritesFiles — the cost gate', () => {
  it('flags the python heredoc that rewrote src/data/blog.ts', () => {
    // Verbatim shape from turn 3 of session c5c94af7.
    const cmd = [
      'cd /Users/artemdolobanko/Documents/upplabs.com',
      "python3 - <<'PY'",
      "p='next.config.ts'",
      "s=open(p,encoding='utf-8').read()",
      "open(p,'w',encoding='utf-8').write(s.replace(old,new))",
      'PY',
    ].join('\n');
    expect(commandWritesFiles(cmd)).toBe(true);
  });

  it('flags heredoc file creation, in-place sed, and copies', () => {
    expect(commandWritesFiles("cat > zakuski.py <<'PYEOF'\nprint(1)\nPYEOF")).toBe(true);
    expect(commandWritesFiles("sed -i '' 's/a/b/' src/app.ts")).toBe(true);
    expect(commandWritesFiles('cp $S/remote/public/images/awards/clutch.svg public/images/awards/')).toBe(true);
    expect(commandWritesFiles('printf "x" >> notes.txt')).toBe(true);
    expect(commandWritesFiles('scp -r host:/app/src ./src')).toBe(true);
    expect(commandWritesFiles('tar -xzf bundle.tgz -C src')).toBe(true);
    expect(commandWritesFiles('git checkout -b restore/deployed-state-may20')).toBe(true);
  });

  it('leaves the read-only turn alone — every command from turn 1', () => {
    // Turn 1 of c5c94af7 checked Fly access and wrote nothing. If this turn
    // were flagged, it could claim a file the user edited in their editor
    // while the agent was talking.
    const readOnly = [
      'which flyctl fly 2>&1; echo "---"; ls -la /Users/x/upplabs.com | head -40',
      'cat fly.toml; echo "=== auth ==="; flyctl auth whoami 2>&1 | head -5',
      'echo "HOME=$HOME"; echo "USER=$(whoami)"; head -c 20 "$HOME/.fly/config.yml" 2>&1',
      'grep -rn "redirect" next.config.ts | head -30',
      'git status --short; git diff --stat',
      'curl -s -D - -o /dev/null "https://upplabs.com/blog/x/" | grep -i "^HTTP"',
    ];
    for (const cmd of readOnly) {
      expect({ cmd, writes: commandWritesFiles(cmd) }).toEqual({ cmd, writes: false });
    }
  });

  it('does not read JSX inside a heredoc as a redirect', () => {
    // The body is data, not shell. Only `grep` runs here, so nothing writes.
    const cmd = ["grep -q x <<'EOF'", '<Section className="pt-32">', '  <Container />', 'EOF'].join('\n');
    expect(stripHeredocBodies(cmd)).toBe("grep -q x <<'EOF'");
    expect(commandWritesFiles(cmd)).toBe(false);
  });

  it('ignores fd duplication and /dev/null redirects', () => {
    expect(commandWritesFiles('flyctl status 2>&1 | head -30')).toBe(false);
    expect(commandWritesFiles('git check-ignore -q .next 2>/dev/null')).toBe(false);
  });
});

describe('shellCommandText / isShellTool', () => {
  it('recognizes the shell tools that fire PostToolUse', () => {
    expect(isShellTool('Bash')).toBe(true);
    expect(isShellTool('run_shell_command')).toBe(true);
    expect(isShellTool('Edit')).toBe(false);
  });

  it('reads the command out of string and array payloads', () => {
    expect(shellCommandText({ command: 'ls -la' })).toBe('ls -la');
    expect(shellCommandText({ command: ['bash', '-lc', 'sed -i s/a/b/ f'] })).toBe('bash -lc sed -i s/a/b/ f');
    expect(shellCommandText({})).toBe('');
  });
});

// A window with three files: one edited, one created, one deleted.
const deps = (files: string[], base: Record<string, string>, now: Record<string, string>): ShellWindowDeps => ({
  listChangedFiles: () => files,
  readAtRev: (_sha, f) => (f in base ? base[f] : null),
  readWorking: (f) => (f in now ? now[f] : null),
});

describe('shellWindowEdits — the turn window becomes edits', () => {
  it('emits an authoritative edit per changed file with real content', () => {
    const { edits } = shellWindowEdits(
      deps(
        ['next.config.ts', 'src/new.ts', 'src/gone.ts'],
        { 'next.config.ts': 'a\nb\n', 'src/gone.ts': 'bye\n' },
        { 'next.config.ts': 'a\nc\n', 'src/new.ts': 'hello\n' },
      ),
      { baselineSha: 'deadbeef' },
    );
    expect(edits).toEqual([
      {
        file: 'next.config.ts',
        op: 'edit',
        oldContent: 'a\nb\n',
        newContent: 'a\nc\n',
        source: 'uncommitted',
        // Window edits are INFERENCE — pinned so the label cannot be dropped.
        evidence: 'turn_window',
        backfillSource: SHELL_WINDOW_SOURCE,
      },
      {
        file: 'src/new.ts',
        op: 'create',
        oldContent: '',
        newContent: 'hello\n',
        source: 'uncommitted',
        // Window edits are INFERENCE — pinned so the label cannot be dropped.
        evidence: 'turn_window',
        backfillSource: SHELL_WINDOW_SOURCE,
      },
      {
        file: 'src/gone.ts',
        op: 'delete',
        oldContent: 'bye\n',
        newContent: '',
        source: 'uncommitted',
        // Window edits are INFERENCE — pinned so the label cannot be dropped.
        evidence: 'turn_window',
        backfillSource: SHELL_WINDOW_SOURCE,
      },
    ]);
  });

  it("uses a source every server surface already accepts as authorship", () => {
    // The server's authorship filter is
    // `!e.source || e.source === 'tool_call' || e.source === 'uncommitted'`.
    // A new source value would be silently dropped by every one of those sites.
    const { edits } = shellWindowEdits(
      deps(['a.ts'], { 'a.ts': 'x\n' }, { 'a.ts': 'y\n' }),
      { baselineSha: 'sha' },
    );
    const accepted = edits.filter((e) => !e.source || e.source === 'tool_call' || e.source === 'uncommitted');
    expect(accepted).toHaveLength(1);
  });

  it('never re-claims a file the agent edited through a real tool call', () => {
    const { edits, skipped } = shellWindowEdits(
      deps(['src/app.ts', 'gen.txt'], { 'src/app.ts': 'x\n' }, { 'src/app.ts': 'y\n', 'gen.txt': 'g\n' }),
      { baselineSha: 'sha', coveredFiles: ['src/app.ts'] },
    );
    expect(edits.map((e) => e.file)).toEqual(['gen.txt']);
    expect(skipped).toContainEqual({ file: 'src/app.ts', reason: 'covered' });
  });

  it("skips Origin's own managed files and ignored paths", () => {
    const { edits, skipped } = shellWindowEdits(
      deps(['CLAUDE.md', 'src/app.ts'], {}, { 'CLAUDE.md': 'x\n', 'src/app.ts': 'y\n' }),
      { baselineSha: 'sha', isIgnored: (f) => f === 'CLAUDE.md' },
    );
    expect(edits.map((e) => e.file)).toEqual(['src/app.ts']);
    expect(skipped).toContainEqual({ file: 'CLAUDE.md', reason: 'ignored' });
  });

  it('skips binary blobs and oversized files instead of clamping them', () => {
    const big = 'x'.repeat(200);
    const { edits, skipped } = shellWindowEdits(
      deps(
        ['logo.png', 'big.txt', 'ok.txt'],
        {},
        { 'logo.png': 'PNG\0\u0001', 'big.txt': big, 'ok.txt': 'fine\n' },
      ),
      { baselineSha: 'sha', maxFileBytes: 100 },
    );
    expect(edits.map((e) => e.file)).toEqual(['ok.txt']);
    expect(skipped).toContainEqual({ file: 'logo.png', reason: 'binary' });
    expect(skipped).toContainEqual({ file: 'big.txt', reason: 'too-large' });
  });

  it('claims nothing without a baseline — no baseline, no window, no guessing', () => {
    const { edits } = shellWindowEdits(
      deps(['a.ts'], {}, { 'a.ts': 'x\n' }),
      { baselineSha: '' },
    );
    expect(edits).toEqual([]);
  });

  it('drops a mode-only change git reports but content denies', () => {
    const { edits, skipped } = shellWindowEdits(
      deps(['run.sh'], { 'run.sh': '#!/bin/sh\n' }, { 'run.sh': '#!/bin/sh\n' }),
      { baselineSha: 'sha' },
    );
    expect(edits).toEqual([]);
    expect(skipped).toContainEqual({ file: 'run.sh', reason: 'unchanged' });
  });
});

describe('merge with the transcript capture', () => {
  it('keeps the shell-window edit and drops the commit duplicate for that file', () => {
    const ledger: PromptCapture[] = [{
      promptIndex: 0,
      promptText: '',
      agent: 'claude',
      edits: [{
        file: 'src/data/blog.ts',
        op: 'edit',
        oldContent: 'a\n',
        newContent: 'b\n',
        source: 'uncommitted',
        // Window edits are INFERENCE — pinned so the label cannot be dropped.
        evidence: 'turn_window',
        backfillSource: SHELL_WINDOW_SOURCE,
      }],
      commits: [],
    }];
    // What supplementUncoveredCommittedFiles adds for the same file: the whole
    // commit blob, which spans every turn that fed that commit.
    const transcript: PromptCapture[] = [{
      promptIndex: 0,
      promptText: 'yes, pull the source off the machine and restore it',
      agent: 'claude',
      edits: [{
        file: 'src/data/blog.ts',
        op: 'edit',
        oldContent: 'older\n',
        newContent: 'b\n',
        source: 'commit',
        commitSha: 'bed0aa15',
      }],
      commits: ['bed0aa15'],
    }];
    const merged = mergeLedgerWithTranscript(ledger, transcript);
    expect(merged).toHaveLength(1);
    expect(merged[0].edits).toHaveLength(1);
    expect(merged[0].edits[0].backfillSource).toBe(SHELL_WINDOW_SOURCE);
    // Prompt text and commit linkage still come from the transcript.
    expect(merged[0].promptText).toContain('pull the source off the machine');
    expect(merged[0].commits).toEqual(['bed0aa15']);
  });
});

// The shell-write window is a bare baseline..working-tree diff, so on a shared
// checkout it contains whatever OTHER agents were writing while this turn ran.
// Unlike the tool-call path there is no per-edit record to tell them apart, and
// this path never consulted the exclusion list — so three rounds of fixes to
// that list (#1114, #1117, #1119) left shell-heavy turns still claiming other
// sessions' files. Measured on b629d2cb row 18, which took 97ad4482's
// commit-attribution.test.ts and routes/sessions.ts.
describe('shellWindowEdits — a concurrent session\'s files', () => {
  const OURS = 'packages/cli/src/transcript.ts';
  const THEIRS = 'apps/api/src/routes/sessions.ts';

  const deps = (files: string[]) => ({
    listChangedFiles: () => files,
    readAtRev: (_sha: string, f: string) => `old ${f}\n`,
    readWorking: (f: string) => `new ${f}\n`,
  });

  it('drops a file another session owns, and says why', () => {
    const r = shellWindowEdits(deps([OURS, THEIRS]), {
      baselineSha: 'base',
      foreignFiles: [THEIRS],
    });
    expect(r.edits.map((e) => e.file)).toEqual([OURS]);
    expect(r.skipped).toContainEqual({ file: THEIRS, reason: 'foreign' });
  });

  it('claims everything when no sibling is active', () => {
    const r = shellWindowEdits(deps([OURS, THEIRS]), { baselineSha: 'base' });
    expect(r.edits.map((e) => e.file).sort()).toEqual([THEIRS, OURS].sort());
  });

  it('matches on basename too, since the exclusion mixes path shapes', () => {
    // Mappings hold absolute paths from tool calls and repo-relative ones from
    // git captures; the union carries both.
    const r = shellWindowEdits(deps([THEIRS]), {
      baselineSha: 'base',
      foreignFiles: [`/Users/someone/checkout/${THEIRS}`],
    });
    expect(r.edits).toEqual([]);
    expect(r.skipped).toContainEqual({ file: THEIRS, reason: 'foreign' });
  });

  it('keeps a contested file that THIS turn provably edited via a tool call', () => {
    // `covered` is checked first: a file we have a real tool-call record for
    // stays ours even when a sibling also touched it. Otherwise the turn that
    // actually wrote it would lose it.
    const r = shellWindowEdits(deps([OURS]), {
      baselineSha: 'base',
      coveredFiles: [OURS],
      foreignFiles: [OURS],
    });
    expect(r.skipped).toContainEqual({ file: OURS, reason: 'covered' });
    expect(r.skipped.some((s) => s.reason === 'foreign')).toBe(false);
  });
});
