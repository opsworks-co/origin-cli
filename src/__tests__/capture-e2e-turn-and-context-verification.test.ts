// Verification gates 3d8ae42f and 493c881a: inspect the built CLI's wire rows
// both immediately after post-commit and after Stop/the next prompt.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { commitFiles, createHarness, haveDist, type Harness } from './helpers/stop-next-prompt-harness.js';
import { WINDOWS_SLOWDOWN } from './helpers/windows-e2e.js';

const block = (digest: string) => `<!-- origin-managed -->\nOrigin: Session tracking active\n${digest}\n<!-- origin-managed -->\n\n`;
const T = 180_000 * WINDOWS_SLOWDOWN;
const row = (h: Harness, index: number) => {
  const r = h.rows().find((r) => r.promptIndex === index);
  expect(r, `missing turn ${index}`).toBeTruthy();
  return r!;
};
const expectWork = (h: Harness, index: number, files: string[], added: number, removed: number) => {
  const r = row(h, index);
  expect([...(r.filesChanged || [])].sort()).toEqual([...files].sort());
  expect([r.linesAdded, r.linesRemoved]).toEqual([added, removed]);
  return r;
};
const commit = async (h: Harness, files: string[], message: string) => {
  await h.agentRuns(`commit-${message}`, `git add ${files.join(' ')} && git commit -m '${message}'`, () => {
    h.git(['add', '--', ...files]);
    h.git(['commit', '-qm', message]);
  });
  const sha = h.git(['rev-parse', 'HEAD']);
  const r = await h.gitHook('git-post-commit');
  expect(r.code, r.stderr).toBe(0);
  return sha;
};
const saveEvidence = (h: Harness) => {
  if (process.env.E2E_KEEP) {
    fs.writeFileSync(path.join(h.repo, '..', 'verification.json'), JSON.stringify({ hits: h.hits, rows: h.rows() }, null, 2));
  }
};

describe.skipIf(!haveDist)('fresh committing turns and managed context files', () => {
  it('keeps each commit on its own turn and credits a clean merge with nothing', async () => {
    const h = await createHarness('verify-turn-ownership-0001', 'verify-turn-ownership-server');
    try {
      commitFiles(h, { 'first.txt': 'base\n', 'second.txt': 'base\n' }, 'base');
      h.git(['checkout', '-qb', 'other']);
      commitFiles(h, { 'foreign.txt': 'foreign one\nforeign two\n' }, 'other branch');
      h.git(['checkout', '-q', 'main']);
      await h.startSession('Verification: edit and commit first.txt');
      await h.agentWrites('first', 'first.txt', 'base\nfirst turn\n');
      const first = await commit(h, ['first.txt'], 'first');
      expectWork(h, 0, ['first.txt'], 1, 0);
      h.reply('Committed first.txt.');
      await h.stop();
      await h.submit('Verification: edit and commit second.txt');
      await h.agentWrites('second', 'second.txt', 'base\nsecond turn\nanother line\n');
      const second = await commit(h, ['second.txt'], 'second');
      expectWork(h, 1, ['second.txt'], 2, 0);
      h.reply('Committed second.txt.');
      await h.stop();
      await h.submit('Verification: cleanly merge the other branch without editing');
      await h.agentRuns('merge', 'git merge --no-ff other -m clean-merge', () => { h.git(['merge', '--no-ff', 'other', '-m', 'clean-merge']); });
      expect((await h.gitHook('git-post-commit')).code).toBe(0);
      h.reply('Merged without conflicts.');
      await h.stop();
      await h.submit('Verification: inspect the completed turns without changes');
      expect(expectWork(h, 0, ['first.txt'], 1, 0).commitSha).toBe(first);
      expect(expectWork(h, 1, ['second.txt'], 2, 0).commitSha).toBe(second);
      const merge = expectWork(h, 2, [], 0, 0);
      expect((merge.diff || '') + (merge.uncommittedDiff || '')).toBe('');
      const mergeSha = h.git(['rev-parse', 'HEAD']);
      const details = h.hits.flatMap(hit => hit.body?.gitCapture?.commitDetails || [])
        .filter(detail => detail.sha === mergeSha);
      expect(details.length).toBeGreaterThan(0);
      for (const detail of details) {
        expect(detail.filesChanged).toEqual([]);
        expect([detail.linesAdded, detail.linesRemoved]).toEqual([0, 0]);
        expect(detail.patch || '').toBe('');
      }
    } finally { saveEvidence(h); await h.close(); }
  }, T);

  it('keeps user context edits, excludes block refreshes, and never sends counts without files', async () => {
    const h = await createHarness('verify-context-files-0002', 'verify-context-files-server');
    try {
      const files = ['CLAUDE.md', 'AGENTS.md'];
      commitFiles(h, Object.fromEntries(files.map((f) => [f, block('before') + '# Rules\nOld rule.\n'])), 'base');
      await h.startSession('Verification: edit rules below the managed blocks and commit');
      for (const f of files) await h.agentWrites(`edit-${f}`, f, block('refreshed') + '# Rules\nNew rule.\nExtra rule.\n');
      const own = await commit(h, files, 'user-rules');
      expectWork(h, 0, files, 4, 2);
      h.reply('Committed the user rules.');
      await h.stop();
      await h.submit('Verification: commit only an Origin managed-block refresh');
      await h.agentRuns('refresh', 'refresh Origin managed blocks', () => {
        for (const f of files) fs.writeFileSync(path.join(h.repo, f), block('only bookkeeping changed') + '# Rules\nNew rule.\nExtra rule.\n');
      });
      await commit(h, files, 'managed-refresh');
      expectWork(h, 1, [], 0, 0);
      h.reply('Committed only the managed refresh.');
      await h.stop();
      await h.submit('Verification: inspect the completed context-file turns');
      const authored = expectWork(h, 0, files, 4, 2);
      expect(authored.commitSha).toBe(own);
      expect(authored.diff).toContain('+New rule.');
      expect(authored.diff).not.toContain('origin-managed');
      expectWork(h, 1, [], 0, 0);
      const sent = h.hits.flatMap((hit) => hit.body?.promptChanges || []);
      expect(sent.length).toBeGreaterThan(0);
      for (const r of sent) {
        if ((r.linesAdded || 0) + (r.linesRemoved || 0) > 0) expect(r.filesChanged?.length, JSON.stringify(r)).toBeGreaterThan(0);
      }
    } finally { saveEvidence(h); await h.close(); }
  }, T);
});
