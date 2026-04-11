#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Write build-info.json next to the bundled CLI so `origin --version --verbose`
 * can report the exact git SHA and build timestamp the binary was built from.
 *
 * Run as a prebuild step. Failures are non-fatal — we fall back to "unknown".
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function safeGit(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

const sha = safeGit(['rev-parse', 'HEAD']) || 'unknown';
const shortSha = sha === 'unknown' ? 'unknown' : sha.slice(0, 12);
const branch = safeGit(['rev-parse', '--abbrev-ref', 'HEAD']) || 'unknown';
const dirty = safeGit(['status', '--porcelain']) ? true : false;

// Locate the CLI package root by walking upward from this script.
const pkgRoot = path.resolve(__dirname, '..');
const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf-8'));

const buildInfo = {
  version: pkgJson.version,
  gitSha: sha,
  gitShortSha: shortSha,
  gitBranch: branch,
  gitDirty: dirty,
  builtAt: new Date().toISOString(),
};

const distDir = path.join(pkgRoot, 'dist');
fs.mkdirSync(distDir, { recursive: true });
fs.writeFileSync(path.join(distDir, 'build-info.json'), JSON.stringify(buildInfo, null, 2) + '\n');

// Also write a generated TS file in src/ so that bundling picks it up — but
// gitignored so we don't accidentally commit a build artifact.
const srcGenerated = `// AUTO-GENERATED at build time by scripts/write-build-info.cjs.
// Do not edit by hand. This file is gitignored.
export const BUILD_INFO = ${JSON.stringify(buildInfo, null, 2)} as const;
`;
fs.writeFileSync(path.join(pkgRoot, 'src', 'build-info.ts'), srcGenerated);

console.log(`[build-info] version=${buildInfo.version} sha=${shortSha}${dirty ? ' (dirty)' : ''} built=${buildInfo.builtAt}`);
