/**
 * Ranked full-text search over the history Origin keeps about ONE repo.
 *
 * `origin search` / `origin ask` match a substring of prompt text and nothing
 * else, unranked: "why do we retry the stop hook" finds nothing when the
 * record says "the Stop hook gets time to send the turn". This indexes what
 * the repo's git notes actually hold — session rollups, per-commit memory,
 * decisions, open TODOs, and the prompts behind each annotated commit — and
 * ranks it with BM25, so an agent (via the `search_history` MCP tool) or a
 * person (`origin search-history`) can ask in their own words.
 *
 * Deliberately local and dependency-free: the CLI ships to Node 20 on three
 * platforms, which rules out `node:sqlite` (22.5+) and a native FTS module, and
 * one repo's history is thousands of records, not millions — an in-memory
 * index rebuilt per call is milliseconds of scoring on top of two git reads.
 * Word matching only; meaning-based (embedding) search is a later step if the
 * replay benchmark shows word matching measurably misses.
 */
import { gitDetailed } from './utils/exec.js';
import { MEMORY_STOPWORDS, memoryReadBlocked, readMemoryPayload } from './memory.js';
import { readMemoryTodos } from './todo.js';

export type HistoryKind = 'session' | 'commit' | 'prompt' | 'decision' | 'todo';

export const HISTORY_KINDS: readonly HistoryKind[] = ['session', 'commit', 'prompt', 'decision', 'todo'];

/** One searchable record. `text` is what is matched and quoted; `files` are matched too. */
export interface HistoryDoc {
  kind: HistoryKind;
  id: string;
  title: string;
  text: string;
  files: string[];
  sessionId?: string;
  commits?: string[];
  agent?: string;
  at?: string;
  todoId?: string;
}

export interface HistoryHit {
  kind: HistoryKind;
  score: number;
  title: string;
  snippet: string;
  files: string[];
  sessionId?: string;
  commits?: string[];
  agent?: string;
  at?: string;
  todoId?: string;
}

export interface HistorySearchResult {
  query: string;
  hits: HistoryHit[];
  /** Records searched, per kind — an empty index explains an empty answer. */
  indexed: Record<HistoryKind, number>;
  /** Set when the repo's memory is not readable here (ignored repo, bake-off arm). */
  blocked?: string;
}

// ─── Tokenizing ─────────────────────────────────────────────────────────────

// Plural-only stemming: "hooks"/"hook", "sessions"/"session" must meet, and
// anything more aggressive starts merging identifiers ("process" → "proces").
function stem(term: string): string {
  return term.length > 4 && term.endsWith('s') && !term.endsWith('ss') ? term.slice(0, -1) : term;
}

function keep(term: string): boolean {
  return term.length >= 2 && !MEMORY_STOPWORDS.has(term);
}

/**
 * Terms of a text. A path (`src/memory.ts`) is kept whole and as its basename,
 * an identifier (`readMemoryPayload`, `stop_hook`) whole and as its parts, so
 * a query can name either and still meet the record.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  if (!text) return out;
  for (const raw of text.match(/[A-Za-z0-9_][A-Za-z0-9_./-]*/g) || []) {
    const token = raw.replace(/[./-]+$/, '');
    if (!token) continue;
    const lower = token.toLowerCase();
    const isPath = lower.includes('/') || /\.[a-z][a-z0-9]{0,5}$/.test(lower);
    if (isPath) {
      out.push(lower);
      const base = lower.slice(lower.lastIndexOf('/') + 1);
      if (base !== lower) out.push(base);
    }
    const parts = token
      .split(/[^A-Za-z0-9]+/)
      .flatMap((p) => p.split(/(?<=[a-z0-9])(?=[A-Z])/))
      .map((p) => p.toLowerCase())
      .filter(Boolean);
    if (!isPath && parts.length > 1) out.push(lower); // the identifier as written
    for (const p of parts) if (keep(p)) out.push(stem(p));
  }
  return out;
}

// ─── Reading the repo's history ─────────────────────────────────────────────

const firstLine = (s: string, max = 120) => {
  const line = (s || '').split('\n').find((l) => l.trim()) || '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line.trim();
};

/**
 * Every per-commit attribution note's raw body, read in ONE
 * `git cat-file --batch` — a repo with thousands of annotated commits would
 * otherwise pay one git process per commit. `latin1` keeps one char per byte,
 * so the sizes in the batch headers index the string directly; each body is
 * re-decoded as UTF-8.
 */
export function readAttributionNoteBodies(repoPath: string): { commit: string; body: string }[] {
  const list = gitDetailed(['notes', '--ref=origin', 'list'], { cwd: repoPath, timeoutMs: 20_000 });
  if (list.status !== 0 || !list.stdout.trim()) return [];
  const pairs = list.stdout.trim().split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p.length === 2);
  if (!pairs.length) return [];
  const batch = gitDetailed(['cat-file', '--batch'], {
    cwd: repoPath,
    input: pairs.map(([blob]) => blob).join('\n') + '\n',
    encoding: 'latin1',
    timeoutMs: 60_000,
  });
  if (batch.status !== 0) return [];
  const out: { commit: string; body: string }[] = [];
  const raw = batch.stdout;
  let pos = 0;
  for (const [, commit] of pairs) {
    const nl = raw.indexOf('\n', pos);
    if (nl < 0) break;
    const header = raw.slice(pos, nl).split(' ');
    pos = nl + 1;
    if (header[1] === 'missing') continue;
    const size = Number(header[2]);
    if (!Number.isFinite(size)) break;
    out.push({ commit, body: Buffer.from(raw.slice(pos, pos + size), 'latin1').toString('utf8') });
    pos += size + 1; // trailing newline after each object
  }
  return out;
}

/** Every JSON attribution note, unwrapped from its `origin` envelope. */
function readAttributionNotes(repoPath: string): { commit: string; note: any }[] {
  const out: { commit: string; note: any }[] = [];
  for (const { commit, body } of readAttributionNoteBodies(repoPath)) {
    try {
      const parsed = JSON.parse(body);
      out.push({ commit, note: parsed?.origin ?? parsed });
    } catch { /* not a JSON note — skip it */ }
  }
  return out;
}

// Below this many meaningful terms a prompt is a chat turn, not a record.
// A pasted link alone is not one either, however many words its path has.
const MIN_PROMPT_TERMS = 6;
const URL = /\bhttps?:\/\/\S+/g;

// Commit trailers Origin and agents append (`Origin-Session: …`,
// `Co-Authored-By: …`) are on nearly every commit: matching them would make a
// one-word "wip" commit answer any query that names an agent.
const TRAILER = /^(origin-[a-z-]+|co-authored-by|signed-off-by):.*$/gim;

/** Everything searchable about the repo, as one flat list of records. */
export function buildHistoryDocs(repoPath: string): HistoryDoc[] {
  const docs: HistoryDoc[] = [];
  const memory = readMemoryPayload(repoPath);

  for (const s of memory.sessions) {
    const text = [
      s.summary,
      ...(s.intent || []),
      ...(s.decisions || []),
      ...(s.verify || []),
      ...Object.entries(s.fileNotes || {}).map(([f, n]) => `${f}: ${n}`),
    ].filter(Boolean).join('\n');
    if (!text.trim()) continue;
    docs.push({
      kind: 'session', id: `session:${s.sessionId}`, title: firstLine(s.summary) || `session ${s.sessionId.slice(0, 8)}`,
      text, files: s.filesChanged || [], sessionId: s.sessionId, agent: s.agentSlug, at: s.endedAt || s.startedAt,
    });
  }

  for (const c of memory.commits) {
    const text = [
      (c.message || '').replace(TRAILER, '').trim(),
      ...(c.decisions || []),
      ...Object.entries(c.fileNotes || {}).map(([f, n]) => `${f}: ${n}`),
    ].filter(Boolean).join('\n');
    if (!text.trim()) continue;
    docs.push({
      kind: 'commit', id: `commit:${c.commitSha}`, title: firstLine(c.message),
      text, files: c.filesChanged || [], sessionId: c.sessionId, commits: [c.commitSha], agent: c.agentSlug, at: c.committedAt,
    });
  }

  for (const d of memory.archivedDecisions || []) {
    docs.push({ kind: 'decision', id: `decision:${d.key}`, title: firstLine(d.text), text: d.text, files: [], sessionId: d.sessionId, agent: d.agentSlug, at: d.at });
  }

  let todos: ReturnType<typeof readMemoryTodos> = [];
  try { todos = readMemoryTodos(repoPath); } catch { /* memory unreadable — no TODO records */ }
  for (const t of todos) {
    if (t.status !== 'open') continue;
    docs.push({ kind: 'todo', id: `todo:${t.id}`, title: firstLine(t.text), text: t.text, files: [], sessionId: t.sessionId, at: t.createdAt, todoId: t.id });
  }

  // The prompts behind each annotated commit. A session's prompts recur on
  // every commit it made, so one record per distinct (session, prompt), listing
  // every commit it stands behind.
  const prompts = new Map<string, HistoryDoc>();
  for (const { commit, note } of readAttributionNotes(repoPath)) {
    if (!note || typeof note !== 'object') continue;
    const texts: string[] = Array.isArray(note.prompts)
      ? note.prompts.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).filter(Boolean)
      : [];
    if (!texts.length && typeof note.fullPrompt === 'string' && note.fullPrompt) texts.push(note.fullPrompt);
    const files: string[] = Array.isArray(note.filesChanged) ? note.filesChanged.filter((f: unknown) => typeof f === 'string') : [];
    for (const text of texts) {
      // "retry", "ok merge it", "fix the deploy guard": a chat turn says what to
      // do next, not what the work was, and BM25's short-record bonus would put
      // it above the summary that explains it. Its commit's own records still
      // carry the substance.
      if (tokenize(text.replace(URL, ' ')).length < MIN_PROMPT_TERMS) continue;
      const key = `${note.sessionId || '?'}\u0000${text.trim().toLowerCase()}`;
      const existing = prompts.get(key);
      if (existing) {
        if (!existing.commits!.includes(commit)) existing.commits!.push(commit);
        for (const f of files) if (!existing.files.includes(f)) existing.files.push(f);
        continue;
      }
      prompts.set(key, {
        kind: 'prompt', id: `prompt:${prompts.size}`, title: firstLine(text), text,
        files: [...files], sessionId: note.sessionId, commits: [commit], agent: note.agent, at: note.timestamp,
      });
    }
  }
  docs.push(...prompts.values());
  return docs;
}

// ─── BM25 ───────────────────────────────────────────────────────────────────

const K1 = 1.2;
const B = 0.75;
// A file a record touched is near-conclusive evidence, as in prompt-scoped
// memory retrieval: its path terms count double.
const FILE_TERM_WEIGHT = 2;
// Length normalization floor, as a share of the average record: a one-line
// record still matches, but no longer outranks the paragraph that explains it
// purely for being short.
const MIN_LENGTH_SHARE = 0.5;

interface IndexedDoc { doc: HistoryDoc; tf: Map<string, number>; length: number }

export interface HistoryIndex { docs: IndexedDoc[]; df: Map<string, number>; avgLength: number }

export function buildIndex(docs: HistoryDoc[]): HistoryIndex {
  const indexed: IndexedDoc[] = [];
  const df = new Map<string, number>();
  let total = 0;
  for (const doc of docs) {
    const tf = new Map<string, number>();
    let length = 0;
    const add = (t: string, w: number) => { tf.set(t, (tf.get(t) || 0) + w); length += w; };
    for (const t of tokenize(doc.text)) add(t, 1);
    for (const f of doc.files) for (const t of tokenize(f)) add(t, FILE_TERM_WEIGHT);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    indexed.push({ doc, tf, length });
    total += length;
  }
  return { docs: indexed, df, avgLength: indexed.length ? total / indexed.length : 0 };
}

/** The line of a record that best answers the query, trimmed to quote size. */
function snippetFor(text: string, terms: Set<string>, max = 240): string {
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  let best = lines[0] || '';
  let bestHits = -1;
  for (const line of lines) {
    const hits = new Set(tokenize(line).filter((t) => terms.has(t))).size;
    if (hits > bestHits) { best = line; bestHits = hits; }
  }
  return best.length > max ? `${best.slice(0, max - 1)}…` : best;
}

export function searchIndex(
  index: HistoryIndex,
  query: string,
  opts: { limit?: number; kinds?: HistoryKind[] } = {},
): HistoryHit[] {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length || !index.docs.length) return [];
  const n = index.docs.length;
  const idf = new Map(terms.map((t) => {
    const df = index.df.get(t) || 0;
    return [t, Math.log(1 + (n - df + 0.5) / (df + 0.5))];
  }));
  const kinds = opts.kinds?.length ? new Set(opts.kinds) : null;
  const scored: { d: IndexedDoc; score: number }[] = [];
  for (const d of index.docs) {
    if (kinds && !kinds.has(d.doc.kind)) continue;
    let score = 0;
    for (const t of terms) {
      const tf = d.tf.get(t);
      if (!tf) continue;
      const length = Math.max(d.length, index.avgLength * MIN_LENGTH_SHARE);
      score += idf.get(t)! * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * length) / (index.avgLength || 1))));
    }
    if (score > 0) scored.push({ d, score });
  }
  // Ties go to the newer record: the same words in a fresher session are the
  // likelier answer to "what is the state of this".
  scored.sort((a, b) => b.score - a.score || (b.d.doc.at || '').localeCompare(a.d.doc.at || ''));
  const termSet = new Set(terms);
  return scored.slice(0, Math.max(1, opts.limit ?? 10)).map(({ d, score }) => {
    const { doc } = d;
    return {
      kind: doc.kind,
      score: Math.round(score * 100) / 100,
      title: doc.title,
      snippet: snippetFor(doc.text, termSet),
      files: doc.files.slice(0, 5),
      ...(doc.sessionId ? { sessionId: doc.sessionId } : {}),
      ...(doc.commits?.length ? { commits: doc.commits.slice(0, 5).map((c) => c.slice(0, 12)) } : {}),
      ...(doc.agent ? { agent: doc.agent } : {}),
      ...(doc.at ? { at: doc.at } : {}),
      ...(doc.todoId ? { todoId: doc.todoId } : {}),
    };
  });
}

/** Search one repo's recorded history. */
export function searchHistory(
  repoPath: string,
  query: string,
  opts: { limit?: number; kinds?: HistoryKind[] } = {},
): HistorySearchResult {
  const indexed = Object.fromEntries(HISTORY_KINDS.map((k) => [k, 0])) as Record<HistoryKind, number>;
  if (memoryReadBlocked(repoPath)) {
    return { query, hits: [], indexed, blocked: 'Origin memory is not read in this repo (ignored, or a benchmark arm without a context variant).' };
  }
  const docs = buildHistoryDocs(repoPath);
  for (const d of docs) indexed[d.kind]++;
  return { query, hits: searchIndex(buildIndex(docs), query, opts), indexed };
}
