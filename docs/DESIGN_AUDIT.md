# Origin Web — Design System Audit

Scope: `apps/web/src/` on the current `main` as of this audit. All claims trace to specific files; counts come from `grep` / `wc` runs against the working tree.

---

## 1. Component inventory

Files in `apps/web/src/components/` (23 total):

| Component | Purpose | Imports (pages + components) |
|-----------|---------|------------------------------|
| `Layout.tsx` | Team sidebar + main shell | wired via `App.tsx` routes |
| `DeveloperLayout.tsx` | Solo sidebar + main shell | wired via `App.tsx` routes |
| `PublicLayout.tsx` | Marketing/public shell (nav bar, UseCases dropdown) | marketing routes |
| `ChatWidget.tsx` | Floating AI assistant | used by both Layouts |
| `NotificationBell.tsx` | Bell + unread count | used by both Layouts |
| `Logo.tsx` | `<LogoMark />` brand mark | used by both Layouts |
| `TurnTimeline.tsx` | Per-prompt timeline (the Checkpoints tab) | `SessionDetail` |
| `UnifiedSessionView.tsx` | Transcript + diff reader (Session tab) | `SessionDetail` |
| `AiBlameView.tsx` | File blame with line attribution (Blame tab) | `SessionDetail`, `RepoDetail` |
| `AskAuthorPanel.tsx` | Side panel for "ask the author" queries | `SessionDetail` |
| `CommitDetail.tsx` usage etc. | — | — |
| `KpiCard.tsx` | Stat-card primitive | only 3 pages (`Dashboard`, `Compliance`, `Infrastructure`) |
| `ScoreGauge.tsx` | Donut-style score gauge | review screens |
| `Sparkline.tsx` | Inline sparkline | used in a couple places |
| `ActivityHeatmap.tsx` | GitHub-style contribution heatmap | `MyDashboard` |
| `StatusBanner.tsx` | Inline warning banner | ad hoc |
| `Skeleton.tsx` | Loading placeholder | **1 file imports it** — everyone else inlines `animate-pulse` |
| `ConfirmDialog.tsx` | Destructive-action modal | ad hoc |
| `Toast.tsx` | Toast notifications | global |
| `FadeIn.tsx` | Animation wrapper | marketing |
| `ErrorBoundary.tsx` | Error boundary | `App.tsx` |
| `ProductTour.tsx` | Onboarding tour | `DeveloperLayout` |
| `VersionHistory.tsx` | Diff viewer for policy/agent versions | policy/agent detail |
| `WebhookSettings.tsx` | Webhook config form | `Settings` |

**Clearly missing components (searched for, not found):**

- **`PageHeader`** — `grep -l PageHeader` returns 0 files. Every page reinvents `<h1 text-xl font-bold text-gray-100> + <p text-sm text-gray-500>` inline. 48 pages match this shape (`grep -ln '<h1 className=\"text-'`).
- **`Breadcrumb`** — only 2 files mention it (`SessionDetail.tsx` inlines its own, `CommitDetail.tsx` inlines its own). No shared component.
- **`ActionButtonGroup` / `ActionBar`** — 0 hits. Every detail page hand-assembles a button row. 10 pages use inline `onClick={() => navigate(...)}` for back-nav plus ad hoc action button clusters.
- **`Pill` / `Stat`** — 0 shared. `SessionDetail` hand-rolls 7 stat pills inline (`bg-gray-800/40 border border-gray-700/40 rounded-lg px-2.5 py-1`). Others reinvent it differently.
- **`EmptyState`** — 1 reference in the whole app. Each empty-data path ships its own centered `<div>` with an emoji + two lines.
- **`DataTable`** — 0 shared. `Sessions.tsx` (926 L), `Repos.tsx` (1,189 L), `IAM.tsx` (901 L), `PullRequests.tsx`, `AuditLog.tsx`, `Trails.tsx` each roll their own `<table>` with slightly different hover/sort/empty patterns.
- **`Dropdown` / `Menu` / `Popover`** — 0 shared. `SessionDetail` has a click-outside `⋯` menu built inline; `AiBlameView` has its own `fileDropdownOpen` pattern; `PublicLayout` has a `UseCasesDropdown`. Three different implementations.

`KpiCard` exists but is under-used — only 3 of the 8 dashboard-like pages import it; the rest open-code equivalent cards.

---

## 2. Pattern duplication

Three visual patterns that belong in shared components today:

### Pattern A — Page header (title + optional subtitle + action buttons)

Reinvented across ~48 pages (see grep result above). Examples:

- `Sessions.tsx`: `<h1 className="text-xl font-bold text-gray-100">` + `<p className="text-sm text-gray-500 mt-0.5">`
- `MyDashboard.tsx`: same shape, different spacing.
- `Repos.tsx`, `Dashboard.tsx`, `Policies.tsx`, `Settings.tsx`, `Integrations.tsx`, `Agents.tsx`, `Snapshots.tsx`, `IAM.tsx`, `Budget.tsx`, `Insights.tsx`, `Admin.tsx`, `Compliance.tsx`, `Reports.tsx`, `Trails.tsx`, `ApiKeys.tsx`, `Notifications.tsx`, `Team.tsx`, `ModelComparison.tsx`, `AuditLog.tsx`, `Infrastructure.tsx`, `PullRequests.tsx`, `Leaderboard.tsx`, `Prompts.tsx`, `LiveFeed.tsx`, plus detail pages.

Each differs slightly in `mb-*`, font weight, or wrapper `div` structure.

### Pattern B — Stat pills / metric rows

The "labeled mini-card" shape — small `rounded-lg` with a number and a label — exists in many variants:

- `SessionDetail.tsx` hand-rolls 7 stat pills with `bg-gray-800/40 border border-gray-700/40 rounded-lg px-2.5 py-1` (only file matching this exact class set).
- `Dashboard.tsx` and `MyDashboard.tsx` use grid grids (`grid-cols-2 md:grid-cols-4`) with gradient card variants.
- `Snapshots.tsx` inlines its own stat card grid (lines ~180–210).
- `CommitDetail.tsx` inlines three of them in the commit stats row.
- `RepoDetail.tsx` inlines a row of them at the top.
- `Compliance.tsx`, `Infrastructure.tsx` use `KpiCard` — the only pages to do so.

Same concept, at least 4 visual variants.

### Pattern C — Status badge

`getStatusBadgeClass` exists in `src/utils.ts:25` and returns Tailwind classes, but pages still roll their own:

- `SessionDetail.tsx` defines a local `statusBadge()` helper with additional colors.
- `Sessions.tsx` hits `badge-*` utility classes seven times with local variants.
- `Repos.tsx`, `Policies.tsx`, `Prompts.tsx`, `RepoDetail.tsx`, `Settings.tsx`, `Compliance.tsx`, `Dashboard.tsx` each mix `statusBadge` / `getStatusBadgeClass` / `badge-green` class chains.

The CSS defines `.badge-green / -cyan / -amber / -red / -blue / -purple / -gray` at `index.css:232–264`; pages sometimes use them, sometimes inline `bg-emerald-500/10 text-emerald-400 ring-1 ring-emerald-500/20` by hand.

---

## 3. Color / spacing / typography drift

### Colors

**Hardcoded hex outside CSS:** 169 matches (`grep -rn '#[0-9a-fA-F]\{6\}'` in `pages/` + `components/`). Most are in `Landing.tsx`, `BlogPost.tsx`, `MyDashboard.tsx` — marketing/gradient contexts where hex is reasonable. `SessionDetail.tsx` has **0** hex values (passes). `Login.tsx` has **0**.

**Purple usage conflict:** purple is used both as the RUNNING status color (status badge, live ticker in the newly-redesigned SessionDetail) AND as a primary CTA color in places:

- `.badge-purple` — generic purple badge (`index.css:256`)
- `MyDashboard.tsx` stat card (uses purple as "50–89% AI" tier)
- `SessionDetail.tsx` uses purple now only for RUNNING status (fixed this session)
- `Replay` button was purple before the recent redesign; now neutral.
- `Snapshots.tsx` purple is used for "in both" state in snapshot compare file lists.

The semantic of purple is inconsistent: status in one place, neutral-accent in another, interactive in a third.

**Indigo** is the designated CTA color per `index.css` (`.btn-primary` uses `bg-indigo-600`). It is also used as the active-nav color in team `Layout.tsx` AND as the share-link action color AND as the accent for `Ask`. Overloaded, but at least consistent within the CTA/accent bucket.

**Emerald** is the solo-account accent (new sidebar), but also means "success" in `.badge-green`. Contextual mostly works but causes visual flatness on emerald-heavy solo pages.

### Spacing

Tailwind arbitrary spacing values (`p-[*]`, `w-[*]`, `h-[*]`, `text-[*]`) by page:

- `MyDashboard.tsx`: 58 arbitrary values
- `SessionDetail.tsx`: 45
- `RepoDetail.tsx`: 23
- `Landing.tsx`: 11
- `Dashboard.tsx`: 10
- `Settings.tsx`: 10
- `Sessions.tsx`: 5
- `Repos.tsx`: 2
- `Login.tsx`: 0

The bulk of arbitrary values are `text-[10px]`, `text-[11px]`, `text-[13px]` — outside Tailwind's default scale. These are consistent with each other but bypass the scale, which means a later `text-xs` / `text-sm` change won't touch them.

The core scale used otherwise is 4 / 8 / 12 / 16 / 24 / 32 (`gap-1 gap-2 gap-3 gap-4 gap-6 gap-8`). That part is consistent.

### Typography

- Titles: inconsistent across pages. `text-lg font-semibold`, `text-xl font-bold`, `text-2xl font-bold` all in use for what should be "page title".
- Body: consistent (`text-sm` / `text-[13px]`).
- Monospace: consistent (`font-mono` + tabular-nums where numeric).

---

## 4. Page-size outliers

Top 10 by line count (`wc -l apps/web/src/pages/*.tsx | sort -rn | head -10`):

| Rank | Page | Lines | Refactor candidate? |
|------|------|-------|---------------------|
| 1 | `Docs.tsx` | 5,996 | **Yes** — content should move to MDX / `docs/` files |
| 2 | `BlogPost.tsx` | 3,307 | **Yes** — post content should be MDX, not JSX |
| 3 | `Settings.tsx` | 2,670 | **Yes** — split per-settings-section |
| 4 | `MyDashboard.tsx` | 2,607 | **Yes** — widgets already factored but wrapper still huge |
| 5 | `Integrations.tsx` | 1,658 | Yes — GitHub / GitLab / Slack / etc. should each be a subcomponent |
| 6 | `SessionDetail.tsx` | 1,401 | Borderline — large because it hosts 5 tabs |
| 7 | `CLI.tsx` | 1,198 | Marketing content, same issue as `Docs.tsx` |
| 8 | `Repos.tsx` | 1,189 | Yes — table + filters + empty-state could factor into a DataTable |
| 9 | `RepoDetail.tsx` | 1,101 | Borderline |
| 10 | `LiveFeed.tsx` | 963 | Borderline |

Any page over 1,000 lines is a refactor candidate by the review's own bar. Nine pages cross that line; four cross 2,000.

---

## 5. Routing + navigation audit

From `App.tsx`:

**Duplicate-purpose pages confirmed:**

- **`Dashboard.tsx` vs `MyDashboard.tsx`** — `DashboardRedirect` (`App.tsx:93`) routes developer accounts to `MyDashboard` (`/me`) and org accounts to `Dashboard`. They're intentional per-tier dashboards but they're not sharing any components — they duplicate card grids, time filters, and layout scaffolding.
- **Demo pages** — `Demo.tsx`, `DemoPlatform.tsx`, `DemoCLI.tsx`, plus `DemoSolo.tsx` (unreferenced in `App.tsx` — stale). Three active demo routes (`/demo`, `/demo/platform`, `/demo/cli`); `DemoSolo` is orphan.
- **`CLI.tsx` vs `CLICommands.tsx`** — both under the Docs/marketing surface; both ~1k lines of CLI command documentation.

**Breadcrumbs:**

- Inline breadcrumbs exist in `SessionDetail.tsx` (newly added) and `CommitDetail.tsx` only.
- Every other detail page (`RepoDetail`, `AgentDetail`, `PolicyDetail`, `MachineDetail`, `UserDetail`, `TrailDetail`, `CommitDetail`) lacks breadcrumbs entirely, using only a back-arrow button.
- No shared `<Breadcrumb>` primitive — `SessionDetail` and `CommitDetail` implement different markup.

**Back-arrow SVG** inlined identically in 3 pages (`DemoPlatform`, `DemoSolo`, `SessionDetail`). Others use Lucide `ArrowLeft`. Inconsistent.

---

## 6. Recommendations

Prioritized — by estimated impact × surface area touched.

### R1. Extract `PageHeader`, replace in 48 pages

**Change:** New `components/PageHeader.tsx` with props `{ title, subtitle?, actions?, breadcrumb? }`. Render inside every page's top `<div>`. Deletes the `<h1 className="text-xl font-bold text-gray-100">` + `<p className="text-sm text-gray-500">` + back-arrow SVG pattern from 48 files.

**Payoff:** Fixes the title-size inconsistency (`text-lg` / `text-xl` / `text-2xl` become one prop). Forces consistent action-button placement. Makes adding breadcrumbs a 1-line change across the app.

### R2. Extract `Breadcrumb` + apply to all detail pages

**Change:** `components/Breadcrumb.tsx`, replace both inline implementations (`SessionDetail`, `CommitDetail`) and add to `RepoDetail`, `AgentDetail`, `PolicyDetail`, `MachineDetail`, `UserDetail`, `TrailDetail`. 8 pages total get breadcrumbs.

**Payoff:** Navigation consistency for detail screens. Kills two inline SVG back-arrow variants.

### R3. Extract `StatPill` and `StatCard`; require them in dashboards

**Change:** Two primitives — `StatPill` (small inline metric, used in `SessionDetail`'s pill row, `CommitDetail`, `RepoDetail` top row) and `StatCard` (grid cell, used in `Dashboard`, `MyDashboard`, `Snapshots`, `Compliance`, `Infrastructure`). Deprecate `KpiCard` by merging it into `StatCard`.

**Payoff:** Collapses 4+ visual variants of the same card. Standardizes on one padding / border / corner-radius. Turns `MyDashboard.tsx`'s 58 arbitrary-value sprinkle into semantic props.

### R4. Extract `DataTable` — `Sessions`, `Repos`, `IAM`, `PullRequests`, `AuditLog`, `Trails`

**Change:** One generic table with columns, sort, empty-state, pagination, row-click handler. 6 pages converge on it; each currently ships its own `<table>` implementation with inconsistent hover / sort / empty states.

**Payoff:** ~5,500 combined lines of table code → likely 3,000. Consistent keyboard shortcuts and accessibility (currently neither). Adds `EmptyState` naturally as a table prop.

### R5. Resolve the purple-vs-indigo semantic

**Change:** Pick one and document it. Proposed: **purple = status/ambient (RUNNING, in-progress, pending)**, **indigo = CTA/primary action**, **emerald = success / solo-accent**, **amber = warning / irreversible**, **red = destructive only**. Then `grep` for `text-purple-400` / `bg-purple-500/*` usage outside status contexts and reassign. Update `.badge-purple` docs or rename it.

**Payoff:** A button will stop looking like a status badge. The status badge will stop looking like a button. This is the single most impactful fix for "my eye doesn't know where to go" on busy pages like `SessionDetail`.

### Lower priority (worth mentioning but not ranked)

- `Docs.tsx` (5,996 L) and `BlogPost.tsx` (3,307 L) should both be driven by MDX / external content files, not hand-written JSX. Not a design system problem per se, but it's why the top-10-by-line-count list is dominated by content pages.
- `DemoSolo.tsx` is unreferenced in `App.tsx` and should be deleted or wired up.
- `Skeleton` exists but only 1 import — either delete it or adopt it everywhere by replacing inline `animate-pulse` blocks.
