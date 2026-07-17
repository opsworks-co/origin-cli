import { defineConfig } from 'vitest/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    // Isolate every test (and every git subprocess tests spawn) from the
    // host's real git configuration. On a machine with Origin installed,
    // global git config points core.hooksPath at Origin's REAL network-
    // calling hooks — every fixture `git commit` fired them (~1-8s each,
    // flaky under parallel load; one file dropped 53s → 1.9s when
    // isolated). The fixture config pins the few globals tests DO rely
    // on (init.defaultBranch=main — notes-auto-sync clones/pushes `main`
    // and broke on CI under a bare /dev/null) and disables hooks; system
    // config is dropped entirely. Fixtures still set their own
    // user.name/email.
    env: {
      GIT_CONFIG_GLOBAL: path.resolve(__dirname, 'test-fixtures/gitconfig'),
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  },
});
