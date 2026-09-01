/**
 * The agy ADAPTER has to forward the tool count the parser already computes.
 *
 * agy-tool-call-counting.test.ts pins parseAntigravityTranscript: it counts
 * every tool_call and breaks it down by the normalized UI label. The adapter
 * then hardcoded `toolCalls: 0` and dropped the breakdown, so the whole thing
 * was computed on every parse and thrown away one line later — which is why
 * session 65953fe2 rendered "0 tools" beside a transcript holding 28 of them.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { antigravityAdapter } from '../transcript-adapters.js';

function line(o: Record<string, unknown>): string { return JSON.stringify(o); }

const TRANSCRIPT = [
  line({ type: 'USER_INPUT', source: 'USER_EXPLICIT', step_index: 0, created_at: '2026-08-26T15:23:14Z', content: 'have a look around' }),
  line({ type: 'PLANNER_RESPONSE', source: 'MODEL', step_index: 1, created_at: '2026-08-26T15:23:19Z', content: '', tool_calls: [
    { name: 'list_dir', args: { DirectoryPath: '"/repo"' } },
    { name: 'view_file', args: { AbsolutePath: '"/repo/README.md"' } },
  ] }),
  line({ type: 'PLANNER_RESPONSE', source: 'MODEL', step_index: 2, created_at: '2026-08-26T15:23:26Z', content: '', tool_calls: [
    { name: 'write_to_file', args: { TargetFile: '"/repo/a.py"', CodeContent: '"x = 1\\n"' } },
    { name: 'run_command', args: { CommandLine: '"python a.py"', Cwd: '"/repo"' } },
  ] }),
].join('\n');

describe('antigravity adapter', () => {
  it('forwards the parser tool count and breakdown instead of zeroing them', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-agy-adapter-')));
    const fp = path.join(dir, 'transcript_full.jsonl');
    fs.writeFileSync(fp, TRANSCRIPT);
    try {
      const parsed = antigravityAdapter.parse(fp)!;
      expect(parsed.toolCalls).toBe(4);
      const byName = Object.fromEntries((parsed.toolBreakdown || []).map((t) => [t.name, t.count]));
      expect(byName).toEqual({ Read: 2, Write: 1, Bash: 1 });
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });
});
