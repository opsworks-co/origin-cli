// Tunable thresholds for the Spend Quality dashboard.
//
// All heuristic constants live here so the metrics, the UI labels, and the
// flag-coloring stay in sync — and so a manager who wants to tighten "rework
// is amber at 3% instead of 5%" doesn't have to chase three files.
// Imported by services/insights/* and by the frontend via a tiny
// /api/insights/config endpoint (so the UI legend stays accurate when the
// thresholds change).
//
// Keep this file pure data — no imports, no side effects.

export const INSIGHTS_CONFIG = {
  // Window for "did this AI-authored line get rewritten?" — Section 1
  // rework rate counts touches by *later* prompts within this many days.
  // 14d default matches what we tell users in the launch post; tune down to
  // 7 for fast-shipping teams or up to 30 for slower release cycles.
  reworkWindowDays: 14,

  // Color thresholds for the rework column in Section 1. Numbers are
  // fractions, not percentages. Amber bumped from 0.05 to 0.07 — at 5%
  // every dev was permanently amber, which broke the signal value of the
  // colour. 7% is the threshold the Spend Quality launch post documents.
  reworkRateAmber: 0.07,
  reworkRateRed: 0.15,

  // Section 2 cost-outlier flag fires when a session is more than this
  // multiplier above the dev's average session cost in the range.
  expensiveSessionMultiplier: 2,

  // Section 3 model-fit heuristics. All thresholds inclusive.
  // Loosened from the original "≤2 prompts AND ≤$0.50 AND ≤1 file" rule
  // (which almost never fired) to match the launch-post promise: anything
  // run on a flagship model that looked like a small task. Fires more
  // freely now — the savings estimate is conservative so that's fine.
  modelFit: {
    // "Opus on a tiny task" — fires when Opus was used but the work
    // looked trivial. All conditions must hold.
    opusCheap: {
      maxCostUsd: 1.0,
      maxPrompts: 4,
      maxFilesChanged: 2,
      // Estimated savings = costUsd × this ratio (Haiku is ~10% of Opus).
      savingsRatio: 0.9,
    },
    // "Sonnet ran 40+ prompts and produced no commit" — scope problem.
    // Was 100; lowered to 40 so the warning fires while a session is
    // still actionable (a 100-prompt session is already over).
    sonnetLong: {
      minPrompts: 40,
      // Suggested action is "reduce scope," not a cheaper model — savings
      // estimate is 50% of session cost (assumes half the session was
      // wasted spinning).
      savingsRatio: 0.5,
    },
  },

  // Section 5 wasted-prompt window — a prompt that triggered a snapshot
  // restore within this many minutes is flagged as wasted.
  // NOTE: depends on snapshot-restore events being persisted; currently
  // CLI-only, so Section 5 ships in degraded state until that lands.
  wastedPromptWindowMinutes: 10,

  // Section 6 outlier — a dev whose cache-read ratio is this many ×
  // the org median is flagged as an outlier.
  cacheRatioOutlierMultiplier: 10,

  // Section 2 default and max for the "show N rows" picker.
  topSessions: {
    default: 5,
    max: 25,
  },

  // Date-range presets. The shorthand `?range=7d` translates to
  // `from = now - { days: presets[range] }`. Custom ranges send `from`
  // and `to` ISO strings instead.
  rangePresets: {
    '7d': 7,
    '30d': 30,
    '90d': 90,
  } as const,
  defaultRangeDays: 30,

  // Hard cap on rows returned per endpoint to keep payloads bounded.
  maxRowsPerEndpoint: 500,

  // SQL scan caps — used when an endpoint has to walk session rows
  // (rather than aggregate). 50k is well past the 10k-session benchmark
  // and matches existing budget service caps.
  scanCap: 50_000,
};
// Note: intentionally not `as const` — the per-org override layer in
// routes/insights.ts merges this object with admin-tuned values, so the
// fields need to type as widened primitives (e.g. `number`, not `7`).

export type InsightsConfig = typeof INSIGHTS_CONFIG;
