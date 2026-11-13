// The type of src/build-info.ts, which scripts/write-build-info.cjs generates
// (gitignored). Tracked so `tsc` passes in a checkout that never ran the
// script — a new worktree whose node_modules was cloned rather than installed,
// so `prepare` never fired. When the generated .ts exists, tsc reads it instead.
export declare const BUILD_INFO: {
  readonly version: string;
  readonly gitSha: string;
  readonly gitShortSha: string;
  readonly gitBranch: string;
  readonly gitDirty: boolean;
  readonly builtAt: string;
};
