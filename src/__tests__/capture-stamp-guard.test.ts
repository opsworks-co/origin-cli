/**
 * Every producer that sends promptChanges must stamp its capture.
 *
 * `captureId` / `capturedAt` are what let the server order two writes to the
 * same row (#1276). The rule in routes/mcp.ts only engages when BOTH sides
 * carry a timestamp, so a producer that omits them is not "unversioned" — it
 * is EXEMPT, and silently outranks every producer that plays by the rules.
 *
 * That is not hypothetical. hooks.ts stamped from the start; transcript-watch.ts
 * did not, and it is the producer that re-sends every prompt in the session
 * every 8 seconds. Its payloads could overwrite fresher hook-written content
 * indefinitely, which is how prod session fdf299d3 ended up with rows whose
 * commitSha came from one capture and whose files and line counts came from
 * another — turn 15 holding turn 20's three files and its +377/-0.
 *
 * Nothing failed when the watcher shipped without the stamp: the field is
 * optional on the wire, the server has a documented fallback for clients that
 * omit it, and every test passed. A missing stamp has no symptom until a row
 * is already wrong. So the check has to be mechanical.
 *
 * If this fails on a new payload builder, add the stamp — do not add the file
 * to an exemption list. There is deliberately no exemption list.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'dist') continue;
      sourceFiles(p, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Files that build a promptChanges payload — they name the wire field AND
 * assemble entries for it. Reading the source rather than exercising the
 * senders is the point: the failure being guarded against is a builder nobody
 * wired a test to.
 */
function payloadBuilders(): string[] {
  return sourceFiles(SRC).filter((file) => {
    const src = fs.readFileSync(file, 'utf-8');
    if (!/promptChanges\s*[:=]/.test(src)) return false;
    // A builder constructs rows: it sets promptIndex on an object literal.
    if (!/promptIndex[,:]/.test(src)) return false;
    // ...and SENDS them. commands/explain.ts assembles a promptChanges-shaped
    // object purely to render locally; it writes nothing, so provenance is
    // meaningless there. Requiring a send keeps the guard honest without an
    // exemption list — the thing an exemption list always rots into.
    return /updateSession\(|method:\s*'PATCH'/.test(src);
  });
}

describe('capture stamp guard', () => {
  it('finds the producers at all — a guard that matches nothing is not a guard', () => {
    const builders = payloadBuilders();
    expect(builders.length).toBeGreaterThan(0);
    // The two known producers must both be in scope. If either stops matching,
    // the detection above has drifted and the guard is quietly inert.
    const names = builders.map((f) => path.relative(SRC, f).replace(/\\/g, '/'));
    expect(names).toContain('commands/hooks.ts');
    expect(names).toContain('transcript-watch.ts');
  });

  it('every promptChanges producer stamps captureId and capturedAt', () => {
    const missing = payloadBuilders().filter((file) => {
      const src = fs.readFileSync(file, 'utf-8');
      // Either spread a stamp helper, or set both fields outright.
      const spreadsStamp = /\.\.\.\s*(captureStamp\b|newCaptureStamp\([^)]*\))/.test(src);
      const setsBoth = /captureId:/.test(src) && /capturedAt:/.test(src);
      return !(spreadsStamp || setsBoth);
    });

    expect(
      missing.map((f) => path.relative(SRC, f).replace(/\\/g, '/')),
      'These build a promptChanges payload without capture provenance.\n'
        + 'The server can only order writes to a row when BOTH carry a timestamp,\n'
        + 'so an unstamped producer is exempt from ordering and silently outranks\n'
        + 'the ones that stamp — see fdf299d3, where turn 15 holds turn 20 work.\n'
        + 'Add `...captureStamp` (hooks.ts) or `...newCaptureStamp()` per pass.',
    ).toEqual([]);
  });
});
