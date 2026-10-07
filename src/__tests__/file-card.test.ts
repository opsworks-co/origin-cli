// The per-file card: what an agent should know before changing the file in
// front of it — bugs already fixed there, attempts that were undone, decisions
// and open TODOs about it — and nothing when there is nothing. What is pinned
// here is mostly the "nothing": a card on every busy file saying how busy it
// is was the first version, and it gave the agent nothing to act on.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildFileCard, filesNamedByCommand, isCentral, parseBlameCounts, parseFileHistory, plainSubject, renderFileCard, summarizeFileHistory,
  type FileCard, type FileChange,
} from '../file-card.js';
import { cardPathsForTool, fileCardsForTool, FILE_CARDS_CHECKED_PER_SESSION } from '../commands/hooks/tool-use.js';

const DAY = 24 * 60 * 60 * 1000;
// Real time: the real-repo tests go through `git log --since`, which reads the
// real clock, so a fixed date would age out of its window.
const NOW = Date.now();
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
const sha = (c: string) => c.repeat(40);

const change = (over: Partial<FileChange>): FileChange => ({
  sha: sha('a'), date: ago(10), subject: 'feat: something', group: sha('a'),
  agent: true, added: 0, deleted: 0, promptKeys: [], promptTexts: [], decisions: [], ...over,
});

describe('parseFileHistory', () => {
  const record = (fields: string[], numstat: string) => `\x1e${fields.join('\x1f')}\x1d\n\n${numstat}\n`;

  it('reads session, agent-ness, line counts, and the prompts and decisions behind the change', () => {
    const note = JSON.stringify({ origin: {
      sessionId: 'sess-1',
      prompts: [
        { index: 0, text: 'make a handle empty input', files: ['src/a.ts'] },
        { index: 1, text: 'unrelated', files: ['src/b.ts'] },
        { index: 2, text: 'and log it', files: ['src/a.ts', 'src/b.ts'] },
      ],
      markers: { decision: ['kept a.ts synchronous — callers rely on it'] },
    } });
    const out = record([sha('a'), ago(3), 'fix: a', '', '', note], '12\t4\tsrc/a.ts');
    const [c] = parseFileHistory(out, 'src/a.ts');
    expect(c).toMatchObject({ sha: sha('a'), group: 'sess-1', agent: true, added: 12, deleted: 4 });
    expect(c.promptKeys).toEqual(['sess-1:0', 'sess-1:2']);
    expect(c.promptTexts).toEqual(['make a handle empty input', 'and log it']);
    expect(c.decisions).toEqual(['kept a.ts synchronous — callers rely on it']);
  });

  it('counts a commit with no note as an agent change from its trailer or AI co-author', () => {
    const out = record([sha('b'), ago(3), 'fix: b', '', 'Artem <a@x.co>|Claude Opus 5.5 <noreply@anthropic.com>', ''], '5\t0\tsrc/a.ts')
      + record([sha('c'), ago(4), 'fix: c', 'sess-9', '', ''], '1\t1\tsrc/a.ts')
      + record([sha('d'), ago(5), 'docs: by hand', '', 'Someone <s@x.co>', ''], '2\t2\tsrc/a.ts');
    const changes = parseFileHistory(out, 'src/a.ts');
    expect(changes.map((c) => c.agent)).toEqual([true, true, false]);
    expect(changes[1].group).toBe('sess-9');
    expect(changes[0].group).toBe(sha('b'));
  });

  it('reads a binary numstat as zero lines, not NaN', () => {
    const [c] = parseFileHistory(record([sha('e'), ago(1), 's', 'x', '', ''], '-\t-\tlogo.png'), 'logo.png');
    expect(c.added).toBe(0);
  });
});

describe('parseBlameCounts', () => {
  it('counts lines per blamed commit and ignores content lines', () => {
    const porcelain = [
      `${sha('a')} 1 1 2`, 'author X', `\t${sha('b')} 1 1 1 looks like a header but is content`,
      `${sha('a')} 2 2`, '\tline two',
      `${sha('c')} 5 3 1`, '\tline three',
    ].join('\n');
    const counts = parseBlameCounts(porcelain);
    expect(counts.get(sha('a'))).toBe(2);
    expect(counts.get(sha('c'))).toBe(1);
    expect(counts.has(sha('b'))).toBe(false);
  });
});

describe('isCentral', () => {
  it('counts a file as central to a small commit, or to its share of a big one', () => {
    expect(isCentral('10\t2\tsrc/a.ts\n3\t1\tsrc/b.ts', 'src/a.ts')).toBe(true);
    const squash = ['40\t5\tsrc/a.ts', ...Array.from({ length: 10 }, (_, i) => `30\t10\tsrc/f${i}.ts`)].join('\n');
    expect(isCentral(squash, 'src/a.ts')).toBe(false);
    expect(isCentral(squash, 'src/f0.ts')).toBe(false);
    const mostly = ['300\t20\tsrc/a.ts', ...Array.from({ length: 6 }, (_, i) => `10\t2\tsrc/f${i}.ts`)].join('\n');
    expect(isCentral(mostly, 'src/a.ts')).toBe(true);
  });

  it('does not count a one-line version bump riding along with a small fix', () => {
    // Every CLI fix bumps packages/cli/package.json: +1/-1 beside the real change.
    const fix = ['40\t12\tpackages/cli/src/commands/hooks/stop.ts', '1\t1\tpackages/cli/package.json', '1\t1\tpackages/cli/package-lock.json'].join('\n');
    expect(isCentral(fix, 'packages/cli/package.json')).toBe(false);
    expect(isCentral(fix, 'packages/cli/src/commands/hooks/stop.ts')).toBe(true);
    // A small real change in a small commit still counts.
    expect(isCentral('10\t2\tsrc/a.ts\n3\t1\tsrc/b.ts', 'src/b.ts')).toBe(true);
  });

  it('does not let tests or lockfiles make a commit look big', () => {
    const numstat = ['5\t1\tsrc/a.ts', '400\t0\tsrc/__tests__/a.test.ts', '900\t800\tpackage-lock.json', '2\t1\tsrc/b.ts'].join('\n');
    expect(isCentral(numstat, 'src/a.ts')).toBe(true);
  });
});

describe('plainSubject', () => {
  it('drops the conventional-commit type and the PR number', () => {
    expect(plainSubject('fix(capture): a turn keeps its row (#1969)')).toBe('a turn keeps its row');
    expect(plainSubject('Handle empty input')).toBe('Handle empty input');
  });
});

describe('summarizeFileHistory', () => {
  const opts = { now: NOW };

  it('lists the bugs fixed here, newest first, and leaves features out', () => {
    const s = summarizeFileHistory('src/a.ts', [
      change({ sha: sha('c'), subject: 'fix: a crashes on empty input', date: ago(2) }),
      change({ sha: sha('b'), subject: 'feat: a learns a new mode', date: ago(5) }),
      change({ sha: sha('a'), subject: 'fix(a): the timeout is per call, not per batch', date: ago(9), agent: false }),
    ], null, opts);
    expect(s.fixes.map((f) => f.sha)).toEqual([sha('c'), sha('a')]);
  });

  it('names an attempt that was mostly rewritten later, by what it tried', () => {
    const s = summarizeFileHistory('src/a.ts', [
      change({ sha: sha('h'), agent: false, subject: 'refactor: redo it by hand', date: ago(2), added: 30 }),
      change({ sha: sha('b'), subject: 'feat: table-driven parser', date: ago(8), added: 50 }),
      change({ sha: sha('a'), subject: 'feat: small helper', date: ago(20), added: 100 }),
    ], new Map([[sha('a'), 95], [sha('b'), 10], [sha('h'), 30]]), opts);
    expect(s.undone).toEqual([{ sha: sha('b'), subject: 'feat: table-driven parser', how: 'rewritten' }]);
  });

  it('names a reverted attempt, and does not also list a reverted fix as a fixed bug', () => {
    const s = summarizeFileHistory('src/a.ts', [
      change({ sha: sha('r'), agent: false, subject: 'Revert "fix: retry forever"', date: ago(3) }),
      change({ sha: sha('a'), subject: 'fix: retry forever', date: ago(5) }),
    ], null, opts);
    expect(s.undone).toEqual([{ sha: sha('a'), subject: 'fix: retry forever', how: 'reverted' }]);
    expect(s.fixes).toEqual([]);
  });

  it('calls nothing rewritten when blame did not run, or the change is younger than a day', () => {
    expect(summarizeFileHistory('f.ts', [change({ added: 40 })], null, opts).undone).toEqual([]);
    expect(summarizeFileHistory('f.ts', [change({ added: 40, date: ago(0.2) })], new Map(), opts).undone).toEqual([]);
  });

  it('does not name a small change, whatever share of it was lost', () => {
    expect(summarizeFileHistory('f.ts', [change({ added: 12 })], new Map(), opts).undone).toEqual([]);
  });

  it('keeps only decisions and TODOs that name the file', () => {
    const s = summarizeFileHistory('src/parser.ts', [
      change({ decisions: ['parser.ts stays single-pass: the stream cannot be rewound', 'used bcrypt for passwords'] }),
    ], null, opts, {
      decisions: ['kept src/parser.ts free of I/O'],
      open: ['parser.ts drops a trailing comment', 'the dashboard chart is off by one'],
    });
    expect(s.decisions).toEqual(['parser.ts stays single-pass: the stream cannot be rewound', 'kept src/parser.ts free of I/O']);
    expect(s.open).toEqual(['parser.ts drops a trailing comment']);
  });

  it('leaves out the current session\'s own changes', () => {
    const s = summarizeFileHistory('f.ts', [change({ group: 'me', subject: 'fix: mine' })], null, { now: NOW, currentSessionId: 'me' });
    expect(s.fixes).toEqual([]);
  });

});

describe('renderFileCard', () => {
  const empty: FileCard = { path: 'src/a.ts', fixes: [], undone: [], decisions: [], open: [] };

  it('is null when there is nothing to act on', () => {
    expect(renderFileCard(empty)).toBeNull();
  });

  it('says what to keep, what not to repeat, and what is open — with no counts', () => {
    const card = renderFileCard({
      ...empty,
      fixes: [{ sha: sha('a'), subject: 'fix(a): the timeout is per call (#12)', date: '2026-09-20' }],
      undone: [{ sha: sha('b'), subject: 'feat: table-driven parser', how: 'rewritten' }],
      decisions: ['a.ts stays synchronous'],
      open: ['a.ts drops a trailing comment'],
    })!;
    expect(card).toContain('before you change src/a.ts');
    expect(card).toContain('2026-09-20: the timeout is per call');
    expect(card).toContain('"table-driven parser" was mostly rewritten later');
    expect(card).toContain('Decision: a.ts stays synchronous');
    expect(card).toContain('Still open: a.ts drops a trailing comment');
    expect(card).not.toMatch(/\d+%|agent commits?/);
  });

  it('stays small with every field at its limit', () => {
    const long = 'x'.repeat(500);
    const card = renderFileCard({
      path: 'src/a.ts',
      fixes: [1, 2, 3].map((i) => ({ sha: sha(String(i)), subject: long, date: '2026-09-20' })),
      undone: [1, 2].map((i) => ({ sha: sha(String(i)), subject: long, how: 'reverted' as const })),
      decisions: [long, long], open: [long, long],
    })!;
    expect(card.length).toBeLessThan(1600);
  });
});

// ─── Against a real repo ─────────────────────────────────────────────────────

function makeRepo(): { dir: string; git: (args: string[], env?: Record<string, string>) => void } {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-file-card-')));
  const git = (args: string[], env: Record<string, string> = {}) =>
    execFileSync('git', args, { cwd: dir, stdio: 'ignore', env: { ...process.env, ...env } });
  git(['init', '-q']);
  git(['config', 'user.email', 'dev@example.com']);
  git(['config', 'user.name', 'Dev']);
  git(['config', 'commit.gpgsign', 'false']);
  return { dir, git };
}

const commitAt = (git: ReturnType<typeof makeRepo>['git'], message: string, when: string) =>
  git(['commit', '-qam', message], { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when });

describe('buildFileCard on a real repo', () => {
  it('names a fixed bug and an attempt a later commit mostly rewrote', () => {
    const { dir, git } = makeRepo();
    try {
      const lines = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `${tag} ${i}`).join('\n') + '\n';
      fs.writeFileSync(path.join(dir, 'parser.py'), 'start\n');
      git(['add', '.']);
      commitAt(git, 'init', ago(40));
      fs.writeFileSync(path.join(dir, 'parser.py'), 'start\n' + lines('agent', 40));
      commitAt(git, 'feat: table-driven parser rules\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>', ago(20));
      fs.writeFileSync(path.join(dir, 'parser.py'), 'start\n' + lines('agent', 5) + lines('human', 30));
      commitAt(git, 'fix: the parser drops the last rule', ago(18));

      const card = buildFileCard(dir, 'parser.py', { now: NOW })!;
      expect(card).toContain('before you change parser.py');
      expect(card).toContain('the parser drops the last rule');
      expect(card).toContain('"table-driven parser rules" was mostly rewritten later');
      expect(card).not.toMatch(/\d+%/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not hand a version file the bugs of the fixes that bumped it, however many there are', () => {
    // Every fix bumps package.json by one line beside its real change. More
    // fixes than centrality is measured for (MAX_FIXES * 3 = 9) must not let
    // the unmeasured ones through as "central".
    const { dir, git } = makeRepo();
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), '{"version":"0"}\n');
      fs.writeFileSync(path.join(dir, 'engine.ts'), 'start\n');
      git(['add', '.']);
      commitAt(git, 'init', ago(40));
      for (let i = 1; i <= 12; i++) {
        fs.writeFileSync(path.join(dir, 'package.json'), `{"version":"${i}"}\n`);
        fs.appendFileSync(path.join(dir, 'engine.ts'), Array.from({ length: 10 }, (_, j) => `fix ${i} line ${j}`).join('\n') + '\n');
        commitAt(git, `fix: engine bug number ${i}`, ago(30 - i));
      }
      expect(buildFileCard(dir, 'package.json', { now: NOW })).toBeNull();
      const engine = buildFileCard(dir, 'engine.ts', { now: NOW })!;
      expect(engine).toContain('engine bug number 12');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gives no card for a file with only feature work, or for a lockfile', () => {
    const { dir, git } = makeRepo();
    try {
      fs.writeFileSync(path.join(dir, 'app.ts'), 'a\n');
      fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}\n');
      git(['add', '.']);
      commitAt(git, 'feat: app\n\nCo-Authored-By: Claude <noreply@anthropic.com>', ago(5));
      expect(buildFileCard(dir, 'app.ts', { now: NOW })).toBeNull();
      expect(buildFileCard(dir, 'package-lock.json', { now: NOW })).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('fileCardsForTool', () => {
  it('looks a file up once per session, and stops at the per-session cap', () => {
    const { dir, git } = makeRepo();
    try {
      fs.writeFileSync(path.join(dir, 'a.ts'), 'x\n');
      git(['add', '.']);
      commitAt(git, 'fix: a crashes on empty input\n\nCo-Authored-By: Claude <noreply@anthropic.com>', new Date().toISOString());
      const state = { repoPath: dir, sessionId: 'other' } as any;

      expect(fileCardsForTool(state, [path.join(dir, 'a.ts')])).toHaveLength(1);
      expect(fileCardsForTool(state, [path.join(dir, 'a.ts'), 'a.ts'])).toHaveLength(0);
      expect(state.fileCardsChecked).toEqual(['a.ts']);

      state.fileCardsChecked = Array.from({ length: FILE_CARDS_CHECKED_PER_SESSION }, (_, i) => `f${i}.ts`);
      fs.writeFileSync(path.join(dir, 'b.ts'), 'y\n');
      expect(fileCardsForTool(state, [path.join(dir, 'b.ts')])).toHaveLength(0);
      expect(state.fileCardsChecked).not.toContain('b.ts');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores a path outside the repo', () => {
    const state = { repoPath: '/nonexistent/repo', sessionId: 's' } as any;
    expect(fileCardsForTool(state, ['/etc/hosts'])).toEqual([]);
  });
});

describe('filesNamedByCommand', () => {
  it('finds the files a shell command reads, however it names them', () => {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-shell-files-')));
    try {
      fs.mkdirSync(path.join(dir, 'src'));
      for (const f of ['src/a.ts', 'src/b.ts', 'README.md']) fs.writeFileSync(path.join(dir, f), 'x\n');
      const at = (f: string) => path.join(dir, f);
      expect(filesNamedByCommand('cat src/a.ts', dir)).toEqual([at('src/a.ts')]);
      expect(filesNamedByCommand(`sed -n '1,40p' "${at('src/b.ts')}"`, dir)).toEqual([at('src/b.ts')]);
      expect(filesNamedByCommand('grep -n foo src/a.ts src/b.ts | head -5 && wc -l README.md', dir))
        .toEqual([at('src/a.ts'), at('src/b.ts'), at('README.md')]);
      expect(filesNamedByCommand('code src/a.ts:12:4', dir)).toEqual([at('src/a.ts')]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores flags, directories, globs, variables and files that do not exist', () => {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-shell-files-')));
    try {
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'x\n');
      expect(filesNamedByCommand('ls -la src/ && cat src/*.ts $FILE missing.ts --include=*.ts', dir)).toEqual([]);
      expect(filesNamedByCommand('', dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stops at five files, so one sweeping command does not spend the session\'s cards', () => {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-shell-files-')));
    try {
      const names = Array.from({ length: 8 }, (_, i) => `f${i}.ts`);
      for (const n of names) fs.writeFileSync(path.join(dir, n), 'x\n');
      expect(filesNamedByCommand(`cat ${names.join(' ')}`, dir)).toHaveLength(5);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('cardPathsForTool', () => {
  it('reads the command out of a shell tool\'s input, as the hook receives it', () => {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-card-paths-')));
    try {
      fs.writeFileSync(path.join(dir, 'heartbeat.ts'), 'x\n');
      const payload = { tool_name: 'Bash', tool_input: { command: "sed -n '1,80p' heartbeat.ts" } };
      expect(cardPathsForTool(payload, dir, [], false)).toEqual([path.join(dir, 'heartbeat.ts')]);
      expect(cardPathsForTool({ tool_name: 'Read', tool_input: {} }, dir, ['/r/a.ts'], true)).toEqual(['/r/a.ts']);
      expect(cardPathsForTool({ tool_name: 'WebFetch', tool_input: {} }, dir, ['/r/a.ts'], false)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
