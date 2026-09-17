/**
 * A context file Origin also writes (CLAUDE.md, AGENTS.md, GEMINI.md) counts
 * the lines around Origin's `<!-- origin-managed -->` block as the agent's work.
 *
 * Session 97c6ba73 turn 4 committed a rule change below the block in all three
 * files (f5880972, +6/-3) from a second worktree. The turn rendered no diff
 * under a commit chip claiming three files, for two reasons:
 * - capture dropped those files whole, so nothing of the change could survive;
 * - the commit-patch pass filtered them out of its dirty check, was left with an
 *   empty pathspec — the whole tree — and declined on Origin's own uncommitted
 *   refresh of the same files.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  ORIGIN_MANAGED_MARKER as M,
  ORIGIN_BUDGET_LOCK_MARKER,
  agentPartOfManagedSection,
  stripOriginManagedBlock,
} from '../managed-block-diff.js';
import { stripIgnoredSectionsFromDiff } from '../ignore-patterns.js';
import { renderManagedFile, scopedCommitForTurn, commitTurnContentUnit } from '../commands/hooks.js';
import { writeBudgetLockNotice, clearBudgetLockNotice } from '../budget-breach.js';
import { preferCommitPatchForCommittedTurns, pathsInDiff } from '../commit-patch-for-committed-turn.js';
import { captureGitState, createShadowCommit } from '../git-capture.js';

const block = (digest: string) => `${M}\nOrigin: Session tracking active — prompts, files, and tokens will be captured.\n\n${digest}\n${M}`;
const RULES = '## Picking what to work on next\n\n1. Bugs.\n2. Verifications.\n3. Repairs of old stored rows.\n\nCover every open task.\n';

describe('stripOriginManagedBlock', () => {
  it('removes the block at the top, with the blank lines that follow it', () => {
    expect(stripOriginManagedBlock(`${block('digest A')}\n\n${RULES}`)).toBe(RULES);
  });

  it('removes a block renderManagedFile appended to an existing file', () => {
    const file = renderManagedFile(RULES, 'Origin: Session tracking active\ndigest');
    expect(file).toContain(M);
    expect(stripOriginManagedBlock(file)).toBe(RULES);
  });

  it('reads the same whatever digest the block holds', () => {
    expect(stripOriginManagedBlock(`${block('digest A')}\n${RULES}`))
      .toBe(stripOriginManagedBlock(`${block('a much longer\ndigest\nB')}\n\n${RULES}`));
  });

  it('removes a damaged block from its marker to the end when the preamble follows', () => {
    expect(stripOriginManagedBlock(`${RULES}\n${M}\nOrigin: Session tracking active\nrest`)).toBe(RULES);
  });

  it('removes only an orphan marker the user wrote around', () => {
    expect(stripOriginManagedBlock(`# Notes\n${M}\nmine\n`)).toBe('# Notes\nmine\n');
  });

  it('leaves a file without a marker alone', () => {
    expect(stripOriginManagedBlock(RULES)).toBe(RULES);
  });

  it('removes the budget-lock notice budget-breach.ts puts at the top of AGENTS.md', () => {
    const notice = `${ORIGIN_BUDGET_LOCK_MARKER}\n# BUDGET LOCK\nStop.\n${ORIGIN_BUDGET_LOCK_MARKER}`;
    expect(stripOriginManagedBlock(`${notice}\n\n${block('digest')}\n${RULES}`)).toBe(RULES);
  });

  it('reads a block appended to a file without a final newline as no change to it', () => {
    const mine = '# Notes\nlast line';
    expect(stripOriginManagedBlock(renderManagedFile(mine, 'Origin: Session tracking active\ndigest')))
      .toBe(stripOriginManagedBlock(mine));
  });

  it('treats a line that contains a marker as the marker, as renderManagedFile does', () => {
    expect(stripOriginManagedBlock(`# Notes\nsee ${M}\ndigest\n${M}\nmine\n`)).toBe('# Notes\nmine\n');
  });
});

describe('agentPartOfManagedSection', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString();
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-context-section-'));
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t.t'); git(dir, 'config', 'user.name', 'T');
    git(dir, 'config', 'commit.gpgsign', 'false');
  });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  /** git's own section for CLAUDE.md between two contents, at `unified` context. */
  const section = (before: string | null, after: string, unified: number) => {
    if (before !== null) {
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), before);
      git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'before');
    } else {
      git(dir, 'commit', '-q', '--allow-empty', '-m', 'empty');
    }
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), after);
    git(dir, 'add', '-A');
    return git(dir, 'diff', '--cached', `--unified=${unified}`);
  };

  it('keeps an edit below the block and nothing of the block', () => {
    const before = `${block('digest A')}\n${RULES}`;
    const after = `${block('digest B\nmore digest')}\n${RULES.replace('3. Repairs of old stored rows.\n', 'Never repair stored data.\n')}`;
    const agent = agentPartOfManagedSection(section(before, after, 2000), 'CLAUDE.md');
    expect(agent).not.toContain(M);
    expect(agent).not.toContain('digest');
    expect(agent.split('\n').filter((l) => /^[+-][^+-]/.test(l))).toEqual([
      '-3. Repairs of old stored rows.',
      '+Never repair stored data.',
    ]);
  });

  it('is empty when only the block changed', () => {
    const before = `${block('digest A')}\n${RULES}`;
    const after = `${block('digest B')}\n${RULES}`;
    expect(agentPartOfManagedSection(section(before, after, 2000), 'CLAUDE.md')).toBe('');
  });

  it('is empty for a file Origin created and nobody else wrote', () => {
    expect(agentPartOfManagedSection(section(null, `${block('digest')}\n`, 2000), 'CLAUDE.md')).toBe('');
  });

  it('cannot split a section that does not carry the whole file', () => {
    const before = `${block('digest A')}\n${'filler\n'.repeat(20)}${RULES}`;
    const after = before.replace('3. Repairs of old stored rows.', 'Never repair stored data.');
    expect(agentPartOfManagedSection(section(before, after, 3), 'CLAUDE.md')).toBe('');
  });

  it('stripIgnoredSectionsFromDiff keeps the agent part beside other files', () => {
    const before = `${block('digest A')}\n${RULES}`;
    fs.writeFileSync(path.join(dir, 'a.ts'), 'a1\n');
    const after = `${block('digest B')}\n${RULES}extra rule\n`;
    const raw = section(before, after, 2000);
    fs.writeFileSync(path.join(dir, 'a.ts'), 'a1\na2\n');
    git(dir, 'add', '-A');
    const both = git(dir, 'diff', '--cached', '--unified=2000', 'HEAD');
    const out = stripIgnoredSectionsFromDiff(both);
    expect(pathsInDiff(out).sort()).toEqual(['CLAUDE.md', 'a.ts']);
    expect(out).not.toContain(M);
    expect(out).toContain('+extra rule');
    expect(raw).toContain(M);
  });
});

describe('a turn whose commit changed only context files, on another branch', () => {
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
  const write = (f: string, c: string) => fs.writeFileSync(path.join(repo, f), c);

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-context-commit-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t.t'); git('config', 'user.name', 'T');
    git('config', 'commit.gpgsign', 'false');
    for (const f of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']) write(f, `${block('digest A')}\n${RULES}`);
    write('a.ts', 'a1\n');
    git('add', '-A'); git('commit', '-qm', 'base');
  });
  afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch {} });

  it('takes the commit patch, with the agent lines of each file and no block', () => {
    const baseline = createShadowCommit(repo, 'turn0') || git('rev-parse', 'HEAD');
    git('checkout', '-qb', 'docs/rule');
    for (const f of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']) {
      write(f, `${block('digest A')}\n${RULES.replace('3. Repairs of old stored rows.\n', '\nNever repair stored data.\n')}`);
    }
    git('add', '-A'); git('commit', '-qm', 'docs: rule');
    const sha = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    // Origin's session-start refresh of the same files, left uncommitted in the
    // session's own tree.
    for (const f of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']) write(f, `${block('digest B, refreshed')}\n${RULES}`);

    const state = {
      promptTurnIds: ['t_0'],
      commitTurns: [{ sha, turnId: 't_0' }],
      promptShadows: [{ promptIndex: 0, shadowSha: baseline }],
      prePromptSha: null,
    };
    const mapping = { promptIndex: 0, filesChanged: [] as string[], diff: '', uncommittedDiff: '', linesAdded: 0, linesRemoved: 0 };
    const log: string[] = [];
    expect(preferCommitPatchForCommittedTurns(state, [mapping], repo, { log: (e) => log.push(e) })).toBe(1);
    expect(log.join('\n')).not.toContain('dirty against its commit');
    expect(pathsInDiff(mapping.diff).sort()).toEqual(['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']);
    expect(mapping.diff).not.toContain(M);
    expect(mapping.diff).not.toContain('digest');
    expect([mapping.linesAdded, mapping.linesRemoved]).toEqual([6, 3]);
  });

  it('a commit of Origin\'s refresh alone still authors nothing', () => {
    const baseline = createShadowCommit(repo, 'turn0') || git('rev-parse', 'HEAD');
    for (const f of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']) write(f, `${block('digest B, refreshed')}\n${RULES}`);
    write('a.ts', 'a1\na2\n');
    git('add', '-A'); git('commit', '-qm', 'feat: a');
    const sha = git('rev-parse', 'HEAD');
    const state = {
      promptTurnIds: ['t_0'],
      commitTurns: [{ sha, turnId: 't_0' }],
      promptShadows: [{ promptIndex: 0, shadowSha: baseline }],
      prePromptSha: null,
    };
    const mapping = { promptIndex: 0, filesChanged: ['a.ts'], diff: '', uncommittedDiff: '', linesAdded: 0, linesRemoved: 0 };
    expect(preferCommitPatchForCommittedTurns(state, [mapping], repo)).toBe(1);
    expect(pathsInDiff(mapping.diff)).toEqual(['a.ts']);
    expect([mapping.linesAdded, mapping.linesRemoved]).toEqual([1, 0]);
  });
});

describe('context-file lines in the other capture paths', () => {
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
  const write = (f: string, c: string) => fs.writeFileSync(path.join(repo, f), c);
  const count = (d: string) => [
    d.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length,
    d.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).length,
  ];

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-context-paths-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t.t'); git('config', 'user.name', 'T');
    git('config', 'commit.gpgsign', 'false');
    for (const f of ['CLAUDE.md', 'AGENTS.md']) write(f, `${block('digest A')}\n${RULES}`);
    write('a.ts', 'a1\n');
    git('add', '-A'); git('commit', '-qm', 'base');
  });
  afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch {} });

  it('the budget-lock notice going on and off AGENTS.md is no agent work', () => {
    const baseline = createShadowCommit(repo, 'turn0')!;
    writeBudgetLockNotice(repo, 'monthly cap');
    let cap = captureGitState(repo, baseline, { fullContext: true });
    expect(fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf-8')).toContain(ORIGIN_BUDGET_LOCK_MARKER);
    expect(`${cap.diff}${cap.workingTreeDiff}`).not.toContain('AGENTS.md');
    expect([cap.linesAdded, cap.linesRemoved]).toEqual([0, 0]);
    const locked = createShadowCommit(repo, 'turn1')!;
    clearBudgetLockNotice(repo);
    cap = captureGitState(repo, locked, { fullContext: true });
    expect(`${cap.diff}${cap.workingTreeDiff}`).not.toContain('AGENTS.md');
    expect([cap.linesAdded, cap.linesRemoved]).toEqual([0, 0]);
  });

  it('captureGitState counts the agent lines it keeps, from a shadow baseline', () => {
    // Dirty before the turn, so the baseline is a real Origin shadow commit.
    write('a.ts', 'a1\nearlier turn\n');
    const baseline = createShadowCommit(repo, 'turn0')!;
    expect(git('log', '-1', '--format=%ae', baseline)).not.toBe(git('log', '-1', '--format=%ae', 'HEAD'));
    write('CLAUDE.md', `${block('digest B')}\n${RULES}extra rule\n`);
    const cap = captureGitState(repo, baseline, { fullContext: true });
    expect(cap.workingTreeDiff).toContain('+extra rule');
    expect(cap.workingTreeDiff).not.toContain(M);
    expect([cap.linesAdded, cap.linesRemoved]).toEqual(count(cap.workingTreeDiff));
    expect(cap.linesAdded).toBe(1);
  });

  it('captureGitState committedOnly counts the agent lines it keeps', () => {
    const start = git('rev-parse', 'HEAD');
    write('CLAUDE.md', `${block('digest B')}\n${RULES.replace('1. Bugs.\n', '1. Bugs first.\n')}`);
    git('add', '-A'); git('commit', '-qm', 'rules');
    const cap = captureGitState(repo, start, { fullContext: true, committedOnly: true });
    expect(cap.committedDiff).toContain('+1. Bugs first.');
    expect(cap.committedDiff).not.toContain(M);
    expect([cap.linesAdded, cap.linesRemoved]).toEqual(count(cap.committedDiff));
    expect([cap.linesAdded, cap.linesRemoved]).toEqual([1, 1]);
  });

  it('post-commit: a commit that only carries a CLAUDE.md refresh sends no lines (TODO 9bceb64e)', () => {
    // The turn's shadow holds Origin's refreshed block; the commit was made
    // from the committed tree with a DIFFERENT refresh (another worktree).
    write('CLAUDE.md', `${block('digest B, refreshed in the session tree\nmore\nmore')}\n${RULES}`);
    const shadow = createShadowCommit(repo, 'turn3')!;
    git('checkout', '-q', '--', '.');
    git('checkout', '-qb', 'refresh');
    write('CLAUDE.md', `${block('digest C')}\n${RULES}`);
    git('add', '-A'); git('commit', '-qm', 'chore: refresh');
    const sha = git('rev-parse', 'HEAD');
    const state = {
      sessionId: 's-9bceb64e', sessionTag: 's-9bceb64e', repoPath: repo, lastCwd: repo,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      prompts: ['p0', 'p1', 'p2', 'clean up'], promptTurnIds: ['t0', 't1', 't2', 't3'],
      promptShadows: [{ promptIndex: 3, shadowSha: shadow }],
      sessionCommitShas: [sha], commitTurns: [{ sha, turnId: 't3' }],
    } as any;
    const scoped = scopedCommitForTurn(repo, state, 3, shadow, sha, ['CLAUDE.md']);
    const unit = commitTurnContentUnit(scoped, ['CLAUDE.md'], '');
    // On main this was {filesChanged: [], diff: '', +N/-M}: lines with no file.
    expect(unit).toEqual({ filesChanged: [], diff: '', linesAdded: 0, linesRemoved: 0 });
  });
});
