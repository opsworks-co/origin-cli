/**
 * Tests for AiBlameView's build-artifact filter.
 *
 * `isBuildArtifact` is the entire surface that decides whether a file
 * disappears from AI Blame. A wrong regex here silently hides real
 * source files (or leaks build noise into the file list), so the
 * pattern array deserves direct coverage.
 *
 * NOTE: this file mirrors patterns from packages/cli/src/ignore-patterns.ts
 * — when those two arrays are consolidated into a shared module, move
 * these assertions to live alongside the consolidated source.
 */

import { describe, it, expect } from 'vitest';
import { isBuildArtifact } from '../AiBlameView';

describe('isBuildArtifact — files we hide from AI Blame', () => {
  it('hides node_modules anywhere in the path', () => {
    expect(isBuildArtifact('node_modules/foo.js')).toBe(true);
    expect(isBuildArtifact('apps/web/node_modules/react/index.js')).toBe(true);
    expect(isBuildArtifact('packages/cli/node_modules/.pnpm/foo/index.js')).toBe(true);
  });

  it('hides dist/ and build/ directories', () => {
    expect(isBuildArtifact('dist/index.js')).toBe(true);
    expect(isBuildArtifact('apps/api/dist/server.js')).toBe(true);
    expect(isBuildArtifact('build/main.js')).toBe(true);
    expect(isBuildArtifact('apps/web/build/static/index.html')).toBe(true);
  });

  it('hides web-dist (Origin-specific build output)', () => {
    expect(isBuildArtifact('apps/api/web-dist/assets/ActionButtonGroup-BOw2UNCu.js')).toBe(true);
    expect(isBuildArtifact('web-dist/index.html')).toBe(true);
  });

  it('hides .next, vendor, and __snapshots__', () => {
    expect(isBuildArtifact('apps/web/.next/static/chunks/main.js')).toBe(true);
    expect(isBuildArtifact('vendor/jquery.js')).toBe(true);
    expect(isBuildArtifact('packages/cli/src/__snapshots__/foo.snap')).toBe(true);
  });

  it('hides minified and source-map files', () => {
    expect(isBuildArtifact('public/jquery.min.js')).toBe(true);
    expect(isBuildArtifact('apps/web/styles.min.css')).toBe(true);
    expect(isBuildArtifact('dist/index.js.map')).toBe(true);
  });

  it('hides generated files', () => {
    expect(isBuildArtifact('src/api.generated.ts')).toBe(true);
    expect(isBuildArtifact('schema.generated.json')).toBe(true);
  });

  it('hides lockfiles for every common package manager', () => {
    expect(isBuildArtifact('package-lock.json')).toBe(true);
    expect(isBuildArtifact('yarn.lock')).toBe(true);
    expect(isBuildArtifact('pnpm-lock.yaml')).toBe(true);
    expect(isBuildArtifact('Cargo.lock')).toBe(true);
    expect(isBuildArtifact('go.sum')).toBe(true);
    expect(isBuildArtifact('Gemfile.lock')).toBe(true);
    expect(isBuildArtifact('poetry.lock')).toBe(true);
    expect(isBuildArtifact('composer.lock')).toBe(true);
    expect(isBuildArtifact('Pipfile.lock')).toBe(true);
  });

  it('hides Prisma migrations and Drizzle metadata', () => {
    expect(isBuildArtifact('apps/api/prisma/migrations/20260101_init/migration.sql')).toBe(true);
    expect(isBuildArtifact('drizzle/meta/_journal.json')).toBe(true);
  });
});

describe('isBuildArtifact — files we MUST NOT hide', () => {
  it('does not hide real source files', () => {
    expect(isBuildArtifact('src/components/Button.tsx')).toBe(false);
    expect(isBuildArtifact('packages/cli/src/commands/init.ts')).toBe(false);
    expect(isBuildArtifact('apps/api/src/routes/sessions.ts')).toBe(false);
    expect(isBuildArtifact('apps/web/src/pages/SessionDetail.tsx')).toBe(false);
  });

  it('does not hide files that mention build-artifact names in their content path', () => {
    // "node_modules" as a substring inside a real source filename — false positive guard
    expect(isBuildArtifact('src/utils/node_modules-mock.ts')).toBe(false);
    expect(isBuildArtifact('docs/node_modules-explained.md')).toBe(false);
  });

  it('does not hide tests, configs, or documentation', () => {
    expect(isBuildArtifact('packages/cli/src/__tests__/redaction.test.ts')).toBe(false);
    expect(isBuildArtifact('vitest.config.ts')).toBe(false);
    expect(isBuildArtifact('README.md')).toBe(false);
    expect(isBuildArtifact('docs/AGENT_HOOKS.md')).toBe(false);
  });

  it('does not hide Prisma schema (migrations only — schema is hand-edited)', () => {
    expect(isBuildArtifact('apps/api/prisma/schema.prisma')).toBe(false);
  });

  it('does not hide files that happen to contain "dist" or "build" as part of a longer name', () => {
    expect(isBuildArtifact('src/utils/distinct-values.ts')).toBe(false);
    expect(isBuildArtifact('apps/api/src/services/build-info.ts')).toBe(false);
  });
});
