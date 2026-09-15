// Probe for test-home-isolation.test.ts. Skipped in a normal run; that test
// spawns two whole vitest runs of just this file at once, with
// ORIGIN_HOME_PROBE_DIR set, to prove concurrent runs get separate homes.
import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

const probeDir = process.env.ORIGIN_HOME_PROBE_DIR;
const label = process.env.ORIGIN_HOME_PROBE_LABEL || 'probe';

describe.skipIf(!probeDir)('concurrent-run HOME probe', () => {
  it('keeps its own HOME while the other run is live', async () => {
    const home = process.env.HOME!;
    fs.writeFileSync(path.join(probeDir!, `${label}.home`), home);

    // Hold the run open until the other run has also written its home, so the
    // two runs overlap for real and the other's globalSetup has already run.
    const deadline = Date.now() + 45_000;
    while (fs.readdirSync(probeDir!).filter((f) => f.endsWith('.home')).length < 2) {
      if (Date.now() > deadline) throw new Error('the other run never started');
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(fs.existsSync(path.join(home, '.origin'))).toBe(true);
    fs.writeFileSync(path.join(probeDir!, `${label}.ok`), home);
  }, 60_000);
});
