# Design tokens

The rules every primitive in `components/ui/` follows. If you're adding new UI, match these. If you need to deviate, add a variant to the primitive; don't fork.

## Colors (semantic, not decorative)

| Semantic | Tailwind family | Meaning | Example |
|----------|-----------------|---------|---------|
| **indigo** | `indigo-*` | Primary CTA, active nav (team), accent reading action | `Sign in`, `Ask`, team sidebar active item |
| **emerald** | `emerald-*` | Success, solo-account accent | completed badge, solo sidebar active item |
| **purple** | `purple-*` | Running / in-progress / ambient activity | RUNNING session pill, live tickers |
| **amber** | `amber-*` | Warning, irreversible-but-not-destructive | End session, Archive |
| **red** | `red-*` | Destructive only | Delete, revoke, failed state |
| **sky / cyan** | `sky-*` / `cyan-*` | Informational, inspect/detail toggle | Details pane, file changed counts |
| **gray** | `gray-*` | Neutral, structural | borders, text-muted, disabled buttons |

### Non-negotiable rules

1. **Purple is NEVER a CTA.** It signals ambient state, not an action.
2. **Red is NEVER a primary button.** Destructive actions live inside overflow menus or confirmation dialogs.
3. **Indigo is reserved for actions.** Don't use it as decorative accent.
4. **Emerald doubles as success and solo accent.** Same color, context disambiguates.

### Shade conventions for dark mode

Every colored element uses the same three-shade pattern:

- **Solid tint (active):** `bg-{color}-500/15 text-{color}-400 ring-{color}-500/25`
- **Hover on colored pill:** `bg-{color}-500/25`
- **Primary button (CTA):** `bg-{color}-500 hover:bg-{color}-400 text-white`

In light mode the index.css remap handles the inversion — you don't write different classes for light mode.

## Spacing

Stay on the Tailwind scale: `1`, `2`, `3`, `4`, `6`, `8`, `12`, `16`, `24`. Do not reach for `p-[11px]` unless there is no alternative. If you want `text-[11px]`, use the shared token `text-caption` from `design-tokens.ts` (see below).

## Typography

| Size | Use | Tailwind |
|------|-----|----------|
| **h1** | Page title (1 per page) | `text-xl font-semibold` (content) or `text-2xl font-bold` (marketing) |
| **h2** | Section title | `text-lg font-semibold` |
| **h3** | Subsection / card title | `text-base font-semibold` |
| **body** | Paragraphs | `text-sm` |
| **small** | Captions, metadata | `text-xs` |
| **caption** | Pill / chip text, table headers | `text-[11px] uppercase tracking-wider` |

Font family: system stack (default). Numeric values inside pills and tables: `tabular-nums`.

## Border radius

| Element | Radius |
|---------|--------|
| Buttons, inputs, selects | `rounded-lg` (8px) |
| Pills, badges | `rounded-md` (6px) or `rounded-full` for emphasis |
| Cards, modals, panels | `rounded-xl` (12px) |
| Large hero cards | `rounded-2xl` (16px) |

## Shadows

Minimal. The design relies on subtle borders (`border-white/[0.05]` dark, `border-gray-200` light), not drop-shadows. Only use `shadow-lg` for modals / floating menus.

## Focus ring

Handled globally in `index.css` — every focusable element gets a 2px indigo ring. Don't override unless you're building a non-standard control.

---

## Primitives reference

All UI primitives live in `apps/web/src/components/ui/`. Import from `'../ui'` via the barrel `index.ts` or from specific files.

| Primitive | When to use |
|-----------|-------------|
| `PageHeader` | Every page's top — title + subtitle + actions + breadcrumb |
| `Breadcrumb` | Navigation path on detail pages |
| `Pill` | Status chips, labeled metrics, chips in tables |
| `StatCard` | Dashboard grid cells — number + label + trend |
| `ActionButtonGroup` | Toolbar of primary + secondary + overflow actions |
| `DataTable` | Any sortable/filterable list with pagination |
| `EmptyState` | Any "no data yet" path |
| `Dropdown` | Click-outside popover menu |

When Stage 2 refactors pages, these are the only primitives you should need to reach for.
