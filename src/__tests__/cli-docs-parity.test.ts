/**
 * CLI ↔ docs parity gate.
 *
 * The /docs/cli/commands page renders apps/web/src/data/cliCommands.generated.json,
 * which is produced from this package's command registrations by
 * `node scripts/generate-cli-docs.mjs` (repo root). This test re-runs the same
 * extractor over the CURRENT src/index.ts and fails when the JSON is stale —
 * i.e., whenever a command is added, removed, renamed, re-described, or gets
 * new options without the docs being regenerated.
 *
 * Why it exists: the hand-written reference documented ~30 of 74 commands and
 * drifted on every rename (user-reported 2026-07-05, "cli docs doesn't cover
 * even half"). Coverage is now structural, and this gate keeps it that way.
 *
 * To fix a failure:   node scripts/generate-cli-docs.mjs   and commit the JSON.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// The extractor is plain ESM with no dependencies — shared with the generator.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — .mjs module without type declarations
import { extractCliCommands } from '../../../../scripts/cli-docs-extract.mjs';

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const INDEX_TS = path.join(ROOT, 'packages', 'cli', 'src', 'index.ts');
const GENERATED = path.join(ROOT, 'apps', 'web', 'src', 'data', 'cliCommands.generated.json');

describe('CLI docs parity (docs/cli/commands is generated from src/index.ts)', () => {
  const current = extractCliCommands(fs.readFileSync(INDEX_TS, 'utf8'));
  const published = JSON.parse(fs.readFileSync(GENERATED, 'utf8'));

  it('extracts a sane command surface (guards the extractor itself)', () => {
    // If a refactor changes the registration style enough to break the
    // extractor, this fails loudly instead of silently emptying the docs.
    expect(current.length).toBeGreaterThan(100);
    const names = current.map((c: { parent: string | null; name: string }) =>
      c.parent ? `${c.parent} ${c.name}` : c.name,
    );
    for (const expected of ['enable', 'blame', 'why', 'sessions', 'snapshot restore', 'hooks git-post-commit']) {
      expect(names).toContain(expected);
    }
    // Every command must carry a description — a blank one would render an
    // empty card on the docs page.
    const undescribed = current.filter((c: { description: string }) => !c.description);
    expect(undescribed).toEqual([]);
  });

  it('matches the published cliCommands.generated.json exactly', () => {
    expect(published.commands).toEqual(current);
    expect(published.commandCount).toBe(current.length);
  });
});
