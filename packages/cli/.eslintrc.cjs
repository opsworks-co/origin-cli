/**
 * ESLint config for @origin/cli.
 *
 * The most important rule here is the `no-restricted-imports` ban on
 * `child_process`. Every shell-out in the CLI MUST go through
 * `src/utils/exec.ts`, which uses `execFileSync`/`spawnSync` with array
 * args (no shell, no string interpolation). Banning the import everywhere
 * else is the only way to keep accidental `execSync('git foo ' + sha)`
 * footguns out of the codebase.
 *
 * Files allowed to import `child_process`:
 *   - src/utils/exec.ts          — the wrapper itself
 *   - src/session-state.ts       — needs `spawn` for the detached heartbeat
 *   - src/plugin-system.ts       — needs `spawn` for plugin processes
 *   - src/heartbeat.ts (if any)  — detached daemon
 *
 * Anywhere else, use the helpers from `./utils/exec.js`:
 *   - run / runDetailed
 *   - git / gitDetailed / gitOrNull
 *   - sqliteQuery / sqliteScalar
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  env: {
    node: true,
    es2022: true,
  },
  ignorePatterns: ['dist/**', 'node_modules/**', '*.d.ts'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        paths: [
          {
            name: 'child_process',
            message:
              'Do not import child_process directly. Use the safe helpers in src/utils/exec.ts (run, runDetailed, git, gitDetailed, sqliteQuery). String-concatenation execSync calls are a shell-injection footgun.',
          },
        ],
      },
    ],
  },
  overrides: [
    {
      // The wrapper file itself, plus the few places that need detached
      // `spawn` for background daemons. These are explicitly audited.
      files: [
        'src/utils/exec.ts',
        'src/session-state.ts',
        'src/plugin-system.ts',
        'src/heartbeat.ts',
        'src/heartbeat-daemon.ts',
      ],
      rules: {
        'no-restricted-imports': 'off',
      },
    },
  ],
};
