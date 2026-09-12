// A hand-written migration is source, not bookkeeping.
//
// `**/prisma/migrations/**` matched the migration BODIES as well as the lock
// file, so an authored `migration.sql` reached no turn's file list, no
// per-prompt diff and no AI Blame — while the session header still counted it,
// because that number comes from git rather than the journal. Prod 824daa22
// read "11 of 12 files" with no way to find the twelfth.
import { describe, it, expect } from 'vitest';
import { shouldIgnoreFile } from '../ignore-patterns.js';
import { isJournalIgnored } from '../write-journal-watch.js';

const AUTHORED = 'apps/api/prisma/migrations/20260907_repo_memory/migration.sql';

describe('prisma migrations', () => {
  it('captures a migration body', () => {
    expect(shouldIgnoreFile(AUTHORED)).toBe(false);
    // The journal is the path that actually lost it — it gates on the same rule.
    expect(isJournalIgnored(AUTHORED)).toBe(false);
  });

  it('captures a migration body at the repo root too', () => {
    expect(shouldIgnoreFile('prisma/migrations/20260101_init/migration.sql')).toBe(false);
  });

  it('still ignores the generated lock file', () => {
    expect(shouldIgnoreFile('apps/api/prisma/migrations/migration_lock.toml')).toBe(true);
    expect(isJournalIgnored('apps/api/prisma/migrations/migration_lock.toml')).toBe(true);
  });

  it('still ignores drizzle metadata wholesale', () => {
    expect(shouldIgnoreFile('db/drizzle/meta/_journal.json')).toBe(true);
    expect(shouldIgnoreFile('db/drizzle/meta/0000_snapshot.json')).toBe(true);
  });

  it('leaves unrelated sql alone in both directions', () => {
    expect(shouldIgnoreFile('scripts/seed.sql')).toBe(false);
    expect(shouldIgnoreFile('apps/api/prisma/schema.prisma')).toBe(false);
  });
});
