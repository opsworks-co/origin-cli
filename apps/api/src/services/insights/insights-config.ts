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
  reworkWindowDays: 7,

  // Color thresholds for the rework column in Section 1. Numbers are
  // fractions, not percentages.
  reworkRateAmber: 0.05,
  reworkRateRed: 0.15,

  // Section 2 cost-outlier flag fires when a session is more than this
  // multiplier above the dev's average session cost in the range.
  expensiveSessionMultiplier: 2,

  // Section 3 model-fit heuristics. All thresholds inclusive.
  modelFit: {
    // "Opus on a tiny task" — fires when Opus was used but the work
    // looked trivial. All four conditions must hold.
    opusCheap: {
      maxCostUsd: 0.5,
      maxPrompts: 2,
      maxFilesChanged: 1,
      // Estimated savings = costUsd × this ratio (Haiku is ~10% of Opus).
      savingsRatio: 0.9,
    },
    // "Sonnet ran 100+ prompts and produced no commit" — scope problem.
    sonnetLong: {
      minPrompts: 100,
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
} as const;

export type InsightsConfig = typeof INSIGHTS_CONFIG;
