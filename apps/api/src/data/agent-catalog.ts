// Static catalog of agents Origin supports natively. Slugs MUST match
// what the CLI's hooks emit verbatim — see packages/cli/src/commands/
// hooks.ts:347-385 and enable.ts:95-275 for the canonical list. The
// frontend uses `iconKey` to render a hand-rolled monochrome SVG; we
// don't ship vendor logos.
//
// Adding a new catalog entry: drop a row here, restart the API, and
// every existing org gets the row auto-backfilled by seedCatalogForOrg
// on the next boot. Idempotent.

export interface CatalogEntry {
  slug: string;          // hook slug — `claude-code`, `cursor`, `gemini`, `codex`
  name: string;          // display name (may differ from slug, e.g. "Gemini CLI")
  description: string;   // one-line summary shown on the cards
  defaultModel: string;
  allowedModels: string[];
  iconKey: 'claude-code' | 'cursor' | 'gemini' | 'codex';
  docsUrl: string;
}

export const AGENT_CATALOG: CatalogEntry[] = [
  {
    slug: 'claude-code',
    name: 'Claude Code',
    description: "Anthropic's terminal coding agent",
    defaultModel: 'claude-opus-4-7',
    allowedModels: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
    iconKey: 'claude-code',
    docsUrl: 'https://docs.claude.com/en/docs/claude-code/overview',
  },
  {
    slug: 'cursor',
    name: 'Cursor',
    description: 'AI-native code editor',
    defaultModel: 'claude-sonnet-4-6',
    allowedModels: ['claude-sonnet-4-6', 'gpt-5', 'gpt-4o'],
    iconKey: 'cursor',
    docsUrl: 'https://docs.cursor.com',
  },
  {
    slug: 'gemini',
    name: 'Gemini CLI',
    description: "Google's terminal coding agent",
    defaultModel: 'gemini-2.5-pro',
    allowedModels: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    iconKey: 'gemini',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/cli',
  },
  {
    slug: 'codex',
    name: 'Codex CLI',
    description: "OpenAI's terminal coding agent",
    defaultModel: 'gpt-5',
    allowedModels: ['gpt-5', 'gpt-4o', 'o3'],
    iconKey: 'codex',
    docsUrl: 'https://openai.com/codex',
  },
];

const CATALOG_SLUGS = new Set(AGENT_CATALOG.map((c) => c.slug));

/** Returns true if the slug is one Origin pre-seeds for every org. */
export function isCatalogSlug(slug: string): boolean {
  return CATALOG_SLUGS.has(slug);
}
