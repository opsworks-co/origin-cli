// Vitest globalSetup: remove the throwaway per-worker HOMEs that isolate-home.ts
// creates under <tmp>/origin-cli-test-home/. Cleans any residue from a crashed
// previous run up front, and the whole tree again once the suite finishes.
import os from 'os';
import path from 'path';
import fs from 'fs';

const BASE = path.join(os.tmpdir(), 'origin-cli-test-home');

export default function () {
  try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* ignore */ }
  return () => {
    try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* ignore */ }
  };
}
