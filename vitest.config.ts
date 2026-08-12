import { defineConfig } from 'vitest/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    // Vitest's 5s default is a Linux number. A large share of this suite shells
    // out to git — init, commit, clone, push, notes — and on Windows each of
    // those is a process spawn that Defender inspects, several times slower than
    // the same call on the Ubuntu runner, and slower again under the parallel
    // worker load of a full run. Measured on a full local run: 23 of 40 failures
    // were "Test timed out in 5000ms", and files that failed in the suite passed
    // 3/3 when run alone. That noise is worse than the wait it saves — it leaves
    // no green baseline, so a real regression is indistinguishable from the
    // usual churn. Generous on purpose: this bounds a hang, it is not a budget.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Redirect HOME to a throwaway per-worker temp dir so tests that touch
    // ~/.origin (config/agent, heartbeat pids, and the sessions/ GLOBAL MIRROR
    // saveSessionState writes) never pollute the real home. Without this, on a
    // machine that also runs Origin, fixture sessions leaked into
    // ~/.origin/sessions/ and showed up in `origin status --global` forever.
    // globalSetup removes the scratch homes after the run.
    setupFiles: ['./src/__tests__/setup/isolate-home.ts'],
    globalSetup: ['./src/__tests__/setup/global-teardown.ts'],
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
