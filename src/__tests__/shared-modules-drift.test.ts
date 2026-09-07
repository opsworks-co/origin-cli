// The modules that exist in both packages/cli and apps/api are kept identical
// by scripts/sync-shared-modules.mjs: one copy is canonical, the other is
// generated. This fails when a copy under THIS package is stale — the
// alternative was two hand-maintained copies, and policy-descriptions drifted
// that way until the CLI printed raw enum names for two enforced policy types.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../');
// Imported by a COMPUTED path, on purpose. A static import made the API's
// Docker build fail: the image compiles this package's tests and does not
// carry the repo-root scripts/ directory, so `tsc` could not resolve the
// module and cli-v0.20260902.2030's deploy died on it. Under vitest the
// script is there; under the image build nothing tries to load it.
const scriptPath = path.join(repoRoot, 'scripts', 'sync-shared-modules.mjs');
const { PAIRS, wantedContent } = (await import(pathToFileURL(scriptPath).href)) as {
  PAIRS: Record<string, { source: string; target: string }>;
  wantedContent: (name: string) => string;
};
// The checkout decides line endings (Windows autocrlf hands back CRLF); the
// guard is about content. See sameContent in the script.
const lf = (s: string) => s.replace(/\r\n/g, '\n');
const mine = Object.entries(PAIRS).filter(([, p]) => p.target.startsWith('packages/cli/'));

describe('shared modules generated into this package', () => {
  it('has at least one pair to guard — a guard that matches nothing is not a guard', () => {
    expect(mine.length).toBeGreaterThan(0);
  });

  for (const [name, { source, target }] of mine) {
    it(`${name}: ${target} is byte-identical to ${source} below its banner`, () => {
      expect(fs.existsSync(path.join(repoRoot, source)), source).toBe(true);
      expect(fs.existsSync(path.join(repoRoot, target)), target).toBe(true);
      const generated = fs.readFileSync(path.join(repoRoot, target), 'utf-8');
      expect(generated.startsWith('// ⚠️  GENERATED FILE — DO NOT EDIT.'), 'missing the DO-NOT-EDIT banner').toBe(true);
      // Plain equality, so a failure prints the diverging line.
      expect(lf(generated)).toBe(lf(wantedContent(name)));
    });

    it(`${name}: the canonical file has no imports — it must compile in both packages`, () => {
      const canonical = fs.readFileSync(path.join(repoRoot, source), 'utf-8');
      const imports = canonical.split('\n').filter((l) => /^\s*import\s/.test(l));
      expect(imports).toEqual([]);
    });
  }
});
