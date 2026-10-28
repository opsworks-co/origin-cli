// A headless `codex exec` run (origin issue start --background) was captured
// with 0 tokens and 2 prompts for a one-prompt run:
//   - Codex 0.145 writes the plugins it recommends as a user-role message
//     ahead of the first prompt (<recommended_plugins>), and the rollout
//     parsers took it for the session's prompt 1;
//   - the run's real SessionEnd (headless-run-end.ts) never read the rollout,
//     the only place Codex's tokens live, so it ended the session at zero.
// Fixture: the shape of the real rollout, trimmed.
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parseCodexRollout } from '../commands/hooks.js';
import { parseCodexRolloutLive } from '../agents/codex.js';
import { codexUserPromptText } from '../transcript.js';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const FIXTURE = 'codex-exec-recommended-plugins.jsonl';
const PROMPT = 'Work on issue loc-e2e6: Reply with the word ready';

describe('codex exec capture', () => {
  it('the injected plugin list is not a prompt', () => {
    expect(codexUserPromptText('<recommended_plugins>\nHere is a list…\n</recommended_plugins>')).toBeNull();
    expect(codexUserPromptText('<recommended_plugins>x</recommended_plugins>\nfix the bug')).toBe('fix the bug');
  });

  it('both rollout parsers see one prompt and the run\'s tokens', () => {
    const stop = parseCodexRollout(FIXTURE_DIR, FIXTURE, '')!;
    const live = parseCodexRolloutLive(path.join(FIXTURE_DIR, FIXTURE))!;
    expect(stop.userPrompts).toEqual([PROMPT]);
    expect(live.userPrompts).toEqual([PROMPT]);
    expect(stop.tokensUsed).toBeGreaterThan(0);
    expect(live.tokensUsed).toBe(stop.tokensUsed);
  });

  it('a real SessionEnd reads the Codex rollout, as Stop does', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'commands', 'hooks', 'session-end.ts'), 'utf-8');
    const end = src.indexOf('export async function handleSessionEnd');
    expect(src.indexOf('backfillCodexRollout({', end)).toBeGreaterThan(end);
  });
});
