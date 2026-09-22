/**
 * Only a file that exists nowhere, and that no tool call ever wrote, is taken
 * off a turn. See vanished-watched-files.ts.
 *
 * Driven against REAL git: the working tree, HEAD and the session's commits
 * are what decide.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { dropVanishedWatchedAdds } from '../vanished-watched-files.js';

let repo: string;
const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
const write = (f: string, c: string) => { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), c); };

const addSection = (file: string, line: string) => [
  `diff --git a/${file} b/${file}`,
  'new file mode 100644',
  'index 0000000..1111111',
  '--- /dev/null',
  `+++ b/${file}`,
  '@@ -0,0 +1 @@',
  `+${line}`,
  '',
].join('\n');

const deleteSection = (file: string, line: string) => [
  `diff --git a/${file} b/${file}`,
  'deleted file mode 100644',
  'index 1111111..0000000',
  `--- a/${file}`,
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  `-${line}`,
  '',
].join('\n');

const editSection = (file: string, line: string) => [
  `diff --git a/${file} b/${file}`,
  'index 1111111..2222222 100644',
  `--- a/${file}`,
  `+++ b/${file}`,
  '@@ -1 +1,2 @@',
  ' kept',
  `+${line}`,
  '',
].join('\n');

const row = (over: Record<string, unknown> = {}) => ({
  promptIndex: 0, filesChanged: ['src/gone.ts'], diff: addSection('src/gone.ts', 'GONE'),
  uncommittedDiff: '', linesAdded: 1, linesRemoved: 0, ...over,
}) as any;

const edits = (file: string, evidence: string) => new Map([[0, JSON.stringify({ edits: [{ file, evidence }] })]]);

beforeEach(() => {
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-vanished-')));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t'); git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  write('src/kept.ts', 'kept\n');
  git('add', '-A'); git('commit', '-qm', 'base');
});
afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ } });

describe('dropVanishedWatchedAdds', () => {
  it('drops a file that exists nowhere and no tool wrote', () => {
    const r = row();
    const dropped = dropVanishedWatchedAdds(repo, [r]);
    expect([...dropped.values()]).toEqual([['src/gone.ts']]);
    expect(r.filesChanged).toEqual([]);
    expect(r.diff).toBe('');
    expect([r.linesAdded, r.linesRemoved]).toEqual([0, 0]);
  });

  it('drops the removal of a file that never existed anywhere — the other half of the same job', () => {
    const r = row({ diff: deleteSection('src/gone.ts', 'GONE'), linesAdded: 0, linesRemoved: 1 });
    dropVanishedWatchedAdds(repo, [r]);
    expect(r.filesChanged).toEqual([]);
    expect([r.linesAdded, r.linesRemoved]).toEqual([0, 0]);
  });

  it('keeps a file a tool call wrote, however gone it is', () => {
    const r = row();
    dropVanishedWatchedAdds(repo, [r], { editsByIndex: edits('src/gone.ts', 'tool_call') });
    expect(r.filesChanged).toEqual(['src/gone.ts']);
    expect(r.diff).toContain('GONE');
  });

  it('drops it when the only evidence is the write journal', () => {
    const r = row();
    dropVanishedWatchedAdds(repo, [r], { editsByIndex: edits('src/gone.ts', 'write_journal') });
    expect(r.filesChanged).toEqual([]);
  });

  it('keeps a file that is still on disk', () => {
    write('src/gone.ts', 'GONE\n');
    const r = row();
    dropVanishedWatchedAdds(repo, [r]);
    expect(r.filesChanged).toEqual(['src/gone.ts']);
  });

  it('keeps a file a commit of the session holds', () => {
    write('src/gone.ts', 'GONE\n');
    git('add', '-A'); git('commit', '-qm', 'wip');
    const sha = git('rev-parse', 'HEAD');
    git('reset', '-q', '--hard', 'HEAD~1');
    const r = row();
    dropVanishedWatchedAdds(repo, [r], { commitShas: [sha] });
    expect(r.filesChanged).toEqual(['src/gone.ts']);
  });

  it('keeps the turn\'s deletion of a real file — it is in HEAD', () => {
    fs.rmSync(path.join(repo, 'src/kept.ts'));
    const r = row({ filesChanged: ['src/kept.ts'], diff: deleteSection('src/kept.ts', 'kept'), linesAdded: 0, linesRemoved: 1 });
    dropVanishedWatchedAdds(repo, [r]);
    expect(r.filesChanged).toEqual(['src/kept.ts']);
    expect([r.linesAdded, r.linesRemoved]).toEqual([0, 1]);
  });

  it('keeps an edit of a file, gone or not: it had a before-state', () => {
    const r = row({ filesChanged: ['src/kept.ts'], diff: editSection('src/kept.ts', 'MORE') });
    dropVanishedWatchedAdds(repo, [r]);
    expect(r.filesChanged).toEqual(['src/kept.ts']);
  });

  it('takes only the vanished section, leaving the rest of the row', () => {
    const r = row({
      filesChanged: ['src/gone.ts', 'src/kept.ts'],
      diff: addSection('src/gone.ts', 'GONE') + editSection('src/kept.ts', 'MORE'),
      linesAdded: 2,
    });
    dropVanishedWatchedAdds(repo, [r]);
    expect(r.filesChanged).toEqual(['src/kept.ts']);
    expect(r.diff).not.toContain('GONE');
    expect(r.diff).toContain('MORE');
    expect(r.linesAdded).toBe(1);
  });

  // Absence of evidence is not evidence of absence: every check the drop
  // depends on must tell "git says no" apart from "git could not answer".
  it('keeps the file when the commit walk itself fails — one sha git cannot read', () => {
    write('src/gone.ts', 'GONE\n');
    git('add', '-A'); git('commit', '-qm', 'wip');
    const real = git('rev-parse', 'HEAD');
    git('reset', '-q', '--hard', 'HEAD~1');
    const r = row();
    // A sha of the right shape that this repo does not have: `git show` fails
    // for the whole list, so the file list of the surviving commits is unknown.
    dropVanishedWatchedAdds(repo, [r], { commitShas: [real, 'd'.repeat(40)] });
    expect(r.filesChanged, 'an unreadable commit list dropped the file').toEqual(['src/gone.ts']);
    expect(r.diff).toContain('GONE');
    expect([r.linesAdded, r.linesRemoved]).toEqual([1, 0]);
  });

  it('keeps a file that is on disk but ignored — `ls-files --others` never names it', () => {
    fs.writeFileSync(path.join(repo, '.gitignore'), 'src/gone.ts\n');
    write('src/gone.ts', 'GONE\n');
    const r = row();
    dropVanishedWatchedAdds(repo, [r]);
    expect(r.filesChanged, 'an ignored file on disk was called vanished').toEqual(['src/gone.ts']);
  });

  it('keeps the file when HEAD is readable but its tree is not', () => {
    // The commit object is there, so the health probes pass; the tree it points
    // at is gone, so `ls-tree` fails and "is it in HEAD" has no answer.
    const tree = git('rev-parse', 'HEAD^{tree}');
    const loose = path.join(repo, '.git', 'objects', tree.slice(0, 2), tree.slice(2));
    expect(fs.existsSync(loose), 'the tree object is packed — this test needs it loose').toBe(true);
    fs.rmSync(loose);
    expect(git('rev-parse', '--verify', 'HEAD')).toBeTruthy();
    const r = row();
    dropVanishedWatchedAdds(repo, [r]);
    expect(r.filesChanged, 'an unreadable tree dropped the file').toEqual(['src/gone.ts']);
    expect(r.diff).toContain('GONE');
  });

  // A symlink whose target is missing is still a directory entry that exists.
  // `existsSync` follows the link and says false for it.
  const symlinks = (() => {
    const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-symlink-probe-'));
    try { fs.symlinkSync('nowhere', path.join(probe, 'l')); return true; }
    catch { return false; }
    finally { try { fs.rmSync(probe, { recursive: true, force: true }); } catch { /* ignore */ } }
  })();

  it.skipIf(!symlinks)('keeps a dangling symlink that is really on disk', () => {
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.symlinkSync('target-that-is-not-there.ts', path.join(repo, 'src/gone.ts'));
    expect(fs.lstatSync(path.join(repo, 'src/gone.ts')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(repo, 'src/gone.ts')), 'the probe needs a DANGLING link').toBe(false);
    const r = row();
    const before = { ...r, filesChanged: [...r.filesChanged] };
    dropVanishedWatchedAdds(repo, [r]);
    expect(r.filesChanged, 'a dangling symlink on disk was called vanished').toEqual(before.filesChanged);
    expect(r.diff).toBe(before.diff);
    expect(r.uncommittedDiff).toBe(before.uncommittedDiff);
    expect([r.linesAdded, r.linesRemoved]).toEqual([before.linesAdded, before.linesRemoved]);
  });

  it.skipIf(!symlinks)('still drops a symlink that was removed from disk and is in no commit', () => {
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.symlinkSync('target-that-is-not-there.ts', path.join(repo, 'src/gone.ts'));
    fs.rmSync(path.join(repo, 'src/gone.ts'));
    const r = row();
    dropVanishedWatchedAdds(repo, [r]);
    expect(r.filesChanged).toEqual([]);
    expect(r.diff).toBe('');
  });

  // RCCE-423: a file whose only life was a commit the session reset away is
  // gone by the session's own hand. Authorship — a tool call, or a shell
  // command that named the file — keeps a vanished file everywhere else; here
  // it must not, or the turn card shows work the repository does not have
  // under a session header that counts nothing.
  it('drops an authored file that the session proved it threw away', () => {
    const r = row();
    dropVanishedWatchedAdds(repo, [r], {
      editsByIndex: edits('src/gone.ts', 'command_named'),
      abandonedFiles: ['src/gone.ts'],
    });
    expect(r.filesChanged).toEqual([]);
    expect(r.diff).toBe('');
  });

  it('keeps an authored file that is NOT on the abandoned list', () => {
    const r = row();
    dropVanishedWatchedAdds(repo, [r], {
      editsByIndex: edits('src/gone.ts', 'command_named'),
      abandonedFiles: ['src/other.ts'],
    });
    expect(r.filesChanged).toEqual(['src/gone.ts']);
  });

  // The list says "the session threw this away", never "the file is gone" —
  // the three git checks still have to answer that, so a file on the list that
  // is still on disk stays.
  it('keeps a file on the abandoned list that is still in the working tree', () => {
    write('src/gone.ts', 'GONE\n');
    const r = row();
    dropVanishedWatchedAdds(repo, [r], { abandonedFiles: ['src/gone.ts'] });
    expect(r.filesChanged).toEqual(['src/gone.ts']);
  });

  it('leaves every row alone when git cannot be read', () => {
    const r = row();
    dropVanishedWatchedAdds(path.join(repo, 'no-such-dir'), [r]);
    expect(r.filesChanged).toEqual(['src/gone.ts']);
  });
});
