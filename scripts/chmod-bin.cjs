#!/usr/bin/env node
// `tsc` writes plain 0644 files, but package.json's `bin` points at
// dist/index.js. npm sets the exec bit itself at install/pack time, so a
// PUBLISHED install is fine — a LOCAL build is not, and this repo's everyday
// setup is a global install symlinked straight at dist/ (`pnpm cli:upgrade`).
//
// So every `pnpm --filter @origin/cli run build` left the binary at 0644 and
// the next `origin` in a shell died with `zsh: permission denied: origin`,
// which reads like a broken PATH rather than a missing mode bit. Found the
// hard way: a stale second install on the PATH masked it until that one was
// removed, and then the CLI was simply gone.
//
// Best-effort by design — a filesystem that cannot chmod (a Windows checkout,
// a read-only mount) must not fail the build.
const fs = require('fs');
const path = require('path');

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
const bins = typeof pkg.bin === 'string' ? { [pkg.name]: pkg.bin } : (pkg.bin || {});

for (const rel of Object.values(bins)) {
  const abs = path.join(__dirname, '..', rel);
  try {
    if (!fs.existsSync(abs)) continue;
    // Preserve the read bits already there; add execute wherever read exists.
    const mode = fs.statSync(abs).mode;
    fs.chmodSync(abs, mode | 0o111);
    // stderr, never stdout: `npm pack --json | jq` is parsed by the release
    // workflow, and a lifecycle script logging to stdout corrupted it once.
    process.stderr.write(`[chmod-bin] +x ${rel}\n`);
  } catch (err) {
    process.stderr.write(`[chmod-bin] skipped ${rel}: ${err.message}\n`);
  }
}
