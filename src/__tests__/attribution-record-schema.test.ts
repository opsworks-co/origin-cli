/**
 * Pins the published v1 attribution record contract
 * (schemas/attribution-record/v1) through its reference implementation,
 * src/attribution-record.ts — the module A3 (writer), A6 (export) and other
 * consumers will import. This file holds no copy of that logic: it drives
 * the production exports against the published examples.
 *
 * Beyond example validity it guards the privacy invariants the contract
 * exists for: no prompt-text carrier can be declared, no free-form object
 * can smuggle one in, and `null` is never a legal value.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  ATTRIBUTION_RECORD_SCHEMA_PATH,
  ATTRIBUTION_RECORD_SCHEMA_VERSION,
  attributionRecordSchema,
  canonicalPromptHash,
  readRecord,
  semanticErrors,
  validateFull,
  validateSchema,
} from '../attribution-record.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const V1_DIR = path.resolve(here, '../../schemas/attribution-record/v1');
const README_PATH = path.join(V1_DIR, 'README.md');

const schema = attributionRecordSchema();
const readme = fs.readFileSync(README_PATH, 'utf-8');

function example(kind: 'valid' | 'invalid', file: string): any {
  return JSON.parse(fs.readFileSync(path.join(V1_DIR, 'examples', kind, file), 'utf-8'));
}

function examples(kind: 'valid' | 'invalid'): string[] {
  const dir = path.join(V1_DIR, 'examples', kind);
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
}

const schemaOk = (record: unknown) => validateSchema(record).length === 0;

type Expected =
  | { layer: 'schema'; keyword: string; instancePath: string }
  | { layer: 'semantic'; rule: string; instancePath: string };

const schemaFail = (keyword: string, instancePath: string): Expected => ({ layer: 'schema', keyword, instancePath });
const semanticFail = (rule: string, instancePath: string): Expected => ({ layer: 'semantic', rule, instancePath });

const S0 = '/contributions/0';
const SESSION = `${S0}/session`;
const IT0 = `${SESSION}/iterations/0`;
const TOKENS = `${SESSION}/usage/tokens`;
const FILE0 = `${S0}/files/0`;
const RANGE0 = `${FILE0}/ranges/0`;

// Each invalid example must fail for its stated reason, not incidentally.
const EXPECTED_FAILURES: Record<string, Expected> = {
  'abbreviated-git-revision.json': schemaFail('pattern', '/revision/id'),
  'cache-read-negative.json': schemaFail('minimum', `${TOKENS}/cache_read`),
  'cache-read-string.json': schemaFail('type', `${TOKENS}/cache_read`),
  'cache-write-fractional.json': schemaFail('type', `${TOKENS}/cache_write`),
  'commit-level-with-files.json': schemaFail('not', S0),
  'contribution-without-agent-or-model.json': schemaFail('anyOf', S0),
  'cost-as-number.json': schemaFail('type', `${SESSION}/usage/cost/amount`),
  'duplicate-iteration-index.json': semanticFail('S1', `${SESSION}/iterations/1/index`),
  'duplicate-session-id.json': semanticFail('S2', '/contributions/1/session/id'),
  'duplicate-session-iteration-index.json': semanticFail('S1', '/contributions/1/session/iterations/0/index'),
  'empty-contributions.json': schemaFail('minItems', '/contributions'),
  'impossible-date.json': schemaFail('format', '/recorded_at'),
  'inferred-with-session.json': schemaFail('not', S0),
  'iteration-index-beyond-prompt-count.json': semanticFail('S6', `${SESSION}/iterations/1/index`),
  'legacy-prompt-summary.json': schemaFail('additionalProperties', ''),
  'line-files-empty.json': schemaFail('minItems', `${S0}/files`),
  'line-level-without-files.json': schemaFail('contains', '/contributions'),
  'line-path-absolute.json': schemaFail('pattern', `${FILE0}/path`),
  'line-path-backslash.json': schemaFail('pattern', `${FILE0}/path`),
  'line-path-empty.json': schemaFail('pattern', `${FILE0}/path`),
  'line-path-parent-segment.json': schemaFail('pattern', `${FILE0}/path`),
  'line-range-empty.json': schemaFail('minItems', `${FILE0}/ranges`),
  'line-range-inverted.json': semanticFail('S4', RANGE0),
  'line-range-unknown-iteration.json': semanticFail('S5', `${RANGE0}/iteration_index`),
  'line-range-zero-start.json': schemaFail('minimum', `${RANGE0}/start_line`),
  'line-ranges-structure.json': schemaFail('additionalProperties', ''),
  'malformed-prompt-hash.json': schemaFail('pattern', `${IT0}/prompt_hash`),
  'malformed-timestamp.json': schemaFail('pattern', '/recorded_at'),
  'missing-schema-version.json': schemaFail('required', ''),
  'negative-line-count.json': schemaFail('minimum', '/revision/diff_stats/lines_added'),
  'negative-token-count.json': schemaFail('minimum', `${TOKENS}/output`),
  'null-telemetry.json': schemaFail('type', `${TOKENS}/input`),
  'prompt-uri-empty-index.json': schemaFail('pattern', `${IT0}/reference_uri`),
  'prompt-uri-equals-session-uri.json': schemaFail('pattern', `${IT0}/reference_uri`),
  'prompt-uri-extra-tab-key.json': schemaFail('pattern', `${IT0}/reference_uri`),
  'prompt-uri-extra-token-key.json': schemaFail('pattern', `${IT0}/reference_uri`),
  'prompt-uri-fractional-index.json': schemaFail('pattern', `${IT0}/reference_uri`),
  'prompt-uri-fragment.json': schemaFail('pattern', `${IT0}/reference_uri`),
  'prompt-uri-index-mismatch.json': semanticFail('S3', `${IT0}/reference_uri`),
  'prompt-uri-malformed.json': schemaFail('pattern', `${IT0}/reference_uri`),
  'prompt-uri-negative-index.json': schemaFail('pattern', `${IT0}/reference_uri`),
  'prompt-uri-non-http.json': schemaFail('pattern', `${IT0}/reference_uri`),
  'prompt-uri-non-numeric-index.json': schemaFail('pattern', `${IT0}/reference_uri`),
  'prompt-uri-query.json': schemaFail('pattern', `${IT0}/reference_uri`),
  'prompt-uri-repeated-prompt.json': schemaFail('pattern', `${IT0}/reference_uri`),
  'prompt-uri-userinfo.json': schemaFail('pattern', `${IT0}/reference_uri`),
  'prompt-uri-without-prompt-key.json': schemaFail('pattern', `${IT0}/reference_uri`),
  'raw-prompt-in-iteration.json': schemaFail('additionalProperties', IT0),
  'raw-prompt-text.json': schemaFail('additionalProperties', SESSION),
  'revision-stats-in-contribution.json': schemaFail('additionalProperties', S0),
  'session-capture-without-session.json': schemaFail('required', S0),
  'session-uri-fragment.json': schemaFail('pattern', `${SESSION}/reference_uri`),
  'session-uri-non-http.json': schemaFail('pattern', `${SESSION}/reference_uri`),
  'session-uri-prompt-query.json': schemaFail('pattern', `${SESSION}/reference_uri`),
  'session-uri-query.json': schemaFail('pattern', `${SESSION}/reference_uri`),
  'session-uri-userinfo.json': schemaFail('pattern', `${SESSION}/reference_uri`),
  'timestamp-without-offset.json': schemaFail('pattern', '/recorded_at'),
  'token-total-field.json': schemaFail('additionalProperties', TOKENS),
  'unknown-attribution-level.json': schemaFail('enum', '/attribution_level'),
  'unknown-model-sentinel.json': schemaFail('not', `${S0}/model/id`),
  'unsupported-schema-major.json': schemaFail('const', '/schema_version'),
  'uppercase-prompt-hash.json': schemaFail('pattern', `${IT0}/prompt_hash`),
  'writer-newer-minor.json': schemaFail('const', '/schema_version'),
  'writer-nonexistent-minor.json': schemaFail('const', '/schema_version'),
};

// Conditional branches only restate or narrow properties that a shape
// schema declares; they never define a shape of their own.
const PREDICATE_KEYWORDS = new Set(['if', 'then', 'else', 'not']);

// Walk every shape subschema, yielding each one that declares `properties`.
function* objectSchemas(node: unknown): Generator<Record<string, any>> {
  if (Array.isArray(node)) {
    for (const item of node) yield* objectSchemas(item);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, any>;
  if (obj.properties && typeof obj.properties === 'object' && !Array.isArray(obj.properties)) yield obj;
  for (const [key, value] of Object.entries(obj)) {
    if (PREDICATE_KEYWORDS.has(key)) continue;
    if (key === 'properties') {
      for (const sub of Object.values(value as Record<string, unknown>)) yield* objectSchemas(sub);
    } else {
      yield* objectSchemas(value);
    }
  }
}

function declaredPropertyNames(): string[] {
  const names = new Set<string>();
  for (const s of objectSchemas(schema)) {
    for (const name of Object.keys(s.properties)) names.add(name);
  }
  return [...names].sort();
}

// Inputs for readRecord's projection path: same record, newer minor, one
// property the 1.0 schema does not know.
function asNewerMinor(record: any, minor = 3): any {
  const newer = structuredClone(record);
  newer.schema_version = `1.${minor}`;
  newer.contributions[0].future_optional_field = { any: 'shape' };
  return newer;
}

describe('attribution record v1 reference implementation', () => {
  it('loads the published schema through the production module', () => {
    expect(ATTRIBUTION_RECORD_SCHEMA_PATH).toBe(path.join(V1_DIR, 'attribution-record.schema.json'));
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.properties.schema_version).toEqual(expect.objectContaining({ const: ATTRIBUTION_RECORD_SCHEMA_VERSION }));
    // Compiles under strict mode on first use.
    expect(() => validateSchema({})).not.toThrow();
  });

  it('returns a schema copy that callers cannot corrupt', () => {
    const copy = attributionRecordSchema();
    copy.properties.schema_version = { type: 'string' };
    expect(attributionRecordSchema().properties.schema_version.const).toBe('1.0');
  });

  it('holds no local copy of the reference functions in this test file', () => {
    const source = fs.readFileSync(fileURLToPath(import.meta.url), 'utf-8');
    const names = ['semanticErrors', 'validateFull', 'readRecord', 'canonicalPromptHash', 'validateSchema'];
    expect(source).not.toMatch(new RegExp('function\\s+(' + names.join('|') + ')\\b'));
    expect(source).not.toMatch(new RegExp('(const|let)\\s+(' + names.join('|') + ')\\s*='));
    expect(source).not.toMatch(/new\s+Ajv/);
    expect(source).not.toMatch(/from\s+'ajv/);
  });

  it('does not claim a public $id URL', () => {
    expect(schema.$id).toBeUndefined();
  });
});

describe('attribution record v1 examples', () => {
  it.each(examples('valid'))('accepts valid example %s through the full validation path', (file) => {
    const result = validateFull(example('valid', file));
    expect(result.schemaErrors).toEqual([]);
    expect(result.semanticErrors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it.each(examples('valid'))('reads valid example %s exactly, and as a projection when it claims a newer minor', (file) => {
    expect(readRecord(example('valid', file)).status).toBe('exact');
    expect(readRecord(asNewerMinor(example('valid', file))).status).toBe('projected');
  });

  it('has an expected failure reason for every invalid example, and an example for every reason', () => {
    expect(examples('invalid')).toEqual(Object.keys(EXPECTED_FAILURES).sort());
  });

  it.each(examples('invalid'))('rejects invalid example %s for its stated reason', (file) => {
    const expected = EXPECTED_FAILURES[file];
    const result = validateFull(example('invalid', file));
    expect(result.ok).toBe(false);
    if (expected.layer === 'schema') {
      const matched = result.schemaErrors.some(
        (e) => e.keyword === expected.keyword && e.instancePath === expected.instancePath,
      );
      expect(matched, JSON.stringify(result.schemaErrors, null, 2)).toBe(true);
    } else {
      // A semantic failure must be one the schema alone cannot see.
      expect(result.schemaErrors).toEqual([]);
      expect(result.semanticErrors).toContainEqual(
        expect.objectContaining({ rule: expected.rule, instancePath: expected.instancePath }),
      );
    }
  });

  it.each(Object.entries(EXPECTED_FAILURES).filter(([, e]) => e.layer === 'semantic').map(([f]) => f))(
    'rejects semantic fixture %s in readRecord, exact and projected',
    (file) => {
      expect(readRecord(example('invalid', file))).toEqual({ status: 'invalid', reason: 'validation' });
      expect(readRecord(asNewerMinor(example('invalid', file)))).toEqual({ status: 'invalid', reason: 'validation' });
    },
  );

  it('ships the required valid examples', () => {
    expect(examples('valid')).toEqual(expect.arrayContaining([
      'minimal.json', 'full.json', 'two-contributions.json', 'long-session-subset.json',
      'line-level.json', 'mixed-line-and-commit.json',
    ]));
  });
});

describe('attribution record v1 versioning', () => {
  it('pins the writer schema to exactly 1.0', () => {
    for (const version of ['1.1', '1.9999', '1', '1.00', '2.0']) {
      const record = example('valid', 'minimal.json');
      record.schema_version = version;
      expect(schemaOk(record), version).toBe(false);
    }
  });

  it('reads a newer 1.x minor only as a transformed 1.0 projection', () => {
    const newer = asNewerMinor(example('valid', 'full.json'));
    expect(validateFull(structuredClone(newer)).ok).toBe(false);

    const result = readRecord(newer);
    expect(result.status).toBe('projected');
    if (result.status !== 'projected') return;
    expect(result.record.schema_version).toBe('1.0');
    expect(result.record.contributions[0].future_optional_field).toBeUndefined();
    expect(result.record.contributions[0].session.iterations).toEqual(
      example('valid', 'full.json').contributions[0].session.iterations,
    );
    // The input is left untouched.
    expect(newer.schema_version).toBe('1.3');
    expect(newer.contributions[0].future_optional_field).toBeDefined();
  });

  it('refuses to interpret an unknown major as v1', () => {
    for (const version of ['2.0', '10.1']) {
      const record = example('valid', 'minimal.json');
      record.schema_version = version;
      expect(readRecord(record)).toEqual({ status: 'unsupported', version });
    }
    expect(readRecord({ schema_version: 'v1' })).toEqual({ status: 'invalid', reason: 'schema_version' });
  });
});

describe('attribution record v1 iterations', () => {
  it('lists only contributing turns: prompt_count may exceed the iterations listed', () => {
    const record = example('valid', 'long-session-subset.json');
    const session = record.contributions[0].session;
    expect(session.prompt_count).toBeGreaterThan(session.iterations.length);
    expect(session.iterations.map((i: any) => i.index)).toEqual([17, 18]);
    expect(validateFull(record).ok).toBe(true);
  });

  it('bounds every iteration index by prompt_count when prompt_count is present (S6)', () => {
    const at = (count: number | undefined, index: number) => {
      const record = example('valid', 'minimal.json');
      const session = record.contributions[0].session;
      if (count !== undefined) session.prompt_count = count;
      session.iterations = [{ index }];
      return record;
    };
    expect(validateFull(at(1, 0)).ok).toBe(true);
    const over = validateFull(at(1, 1));
    expect(over.schemaErrors).toEqual([]);
    expect(over.semanticErrors.map((e) => [e.rule, e.instancePath])).toEqual([['S6', `${IT0}/index`]]);
    expect(validateFull(at(0, 0)).semanticErrors.map((e) => e.rule)).toEqual(['S6']);
    // No prompt_count: S6 checks nothing and infers nothing from the index.
    expect(validateFull(at(undefined, 99)).ok).toBe(true);
    // The long-session subset stays valid: 17 and 18 are below 40.
    expect(validateFull(example('valid', 'long-session-subset.json')).ok).toBe(true);
  });

  it('applies S6 in readRecord, exact and projected', () => {
    const record = example('invalid', 'iteration-index-beyond-prompt-count.json');
    expect(validateFull(structuredClone(record)).semanticErrors.map((e) => e.rule)).toEqual(['S6']);
    expect(readRecord(structuredClone(record))).toEqual({ status: 'invalid', reason: 'validation' });
    expect(readRecord(asNewerMinor(record))).toEqual({ status: 'invalid', reason: 'validation' });
    record.contributions[0].session.prompt_count = 2;
    expect(readRecord(structuredClone(record)).status).toBe('exact');
    expect(readRecord(asNewerMinor(record)).status).toBe('projected');
  });

  it('rejects the same (session.id, index) across two contributions, even with different hashes', () => {
    const record = example('invalid', 'duplicate-session-iteration-index.json');
    const [a, b] = record.contributions;
    expect(a.session.id).toBe(b.session.id);
    expect(a.session.iterations[0].index).toBe(b.session.iterations[0].index);
    expect(a.session.iterations[0].prompt_hash).not.toBe(b.session.iterations[0].prompt_hash);
    expect(schemaOk(record)).toBe(true);
    expect(semanticErrors(record)).toContainEqual(
      expect.objectContaining({ rule: 'S1', instancePath: '/contributions/1/session/iterations/0/index' }),
    );
  });

  it('rejects a repeated session id even when the iteration indexes do not overlap', () => {
    const record = example('invalid', 'duplicate-session-id.json');
    const indexes = record.contributions.flatMap((c: any) => c.session.iterations.map((i: any) => i.index));
    expect(new Set(indexes).size).toBe(indexes.length);
    expect(semanticErrors(record).map((e) => [e.rule, e.instancePath])).toEqual([['S2', '/contributions/1/session/id']]);
  });

  it('keeps two different sessions that both start at iteration 0 valid', () => {
    const two = example('valid', 'two-contributions.json');
    two.contributions[0].session.iterations = [{ index: 0, prompt_hash: 'sha256:' + 'a'.repeat(64) }];
    two.contributions[1].session.iterations = [{ index: 0, prompt_hash: 'sha256:' + 'b'.repeat(64) }];
    expect(validateFull(structuredClone(two)).ok).toBe(true);
    expect(readRecord(structuredClone(two)).status).toBe('exact');
    expect(readRecord(asNewerMinor(two)).status).toBe('projected');
  });
});

describe('attribution record v1 references', () => {
  it('accepts a canonical prompt deep link whose prompt=N equals the iteration index', () => {
    const record = example('valid', 'full.json');
    const session = record.contributions[0].session;
    for (const it of session.iterations) {
      expect(it.reference_uri).toBe(`${session.reference_uri}?prompt=${it.index}`);
    }
    expect(validateFull(record).ok).toBe(true);
    // Without ?prompt=N the URI addresses no prompt, so 1.0 rejects it, even on a
    // path that looks prompt-specific.
    for (const uri of [session.reference_uri, 'https://origin.example.com/sessions/abc/prompts/0']) {
      session.iterations[0].reference_uri = uri;
      expect(validateFull(record).ok, uri).toBe(false);
    }
  });

  it('rejects an iteration reference that is just the session reference, exact and projected', () => {
    const record = example('invalid', 'prompt-uri-equals-session-uri.json');
    const session = record.contributions[0].session;
    expect(session.iterations[0].reference_uri).toBe(session.reference_uri);
    const result = validateFull(structuredClone(record));
    expect(result.schemaErrors).toContainEqual(
      expect.objectContaining({ keyword: 'pattern', instancePath: `${IT0}/reference_uri` }),
    );
    expect(readRecord(structuredClone(record))).toEqual({ status: 'invalid', reason: 'validation' });
    expect(readRecord(asNewerMinor(record))).toEqual({ status: 'invalid', reason: 'validation' });
  });

  it('rejects a prompt deep link that points at another iteration', () => {
    const record = example('valid', 'full.json');
    record.contributions[0].session.iterations[1].reference_uri = `${record.contributions[0].session.reference_uri}?prompt=0`;
    const result = validateFull(record);
    expect(result.schemaErrors).toEqual([]);
    expect(result.semanticErrors.map((e) => [e.rule, e.instancePath])).toEqual([
      ['S3', '/contributions/0/session/iterations/1/reference_uri'],
    ]);
    expect(readRecord(asNewerMinor(record)).status).toBe('invalid');
  });

  it('allows only ?prompt=N on prompt references and no query at all on session references', () => {
    const base = 'https://origin.example.com/sessions/abc';
    const badPrompt = [
      `${base}?tab=blame`, `${base}?prompt=0&token=secret`, `${base}?prompt=0&signature=x`,
      `${base}?prompt=0&tab=blame`, `${base}?prompt=0&prompt=0`, `${base}?prompt=-1`, `${base}?prompt=1.5`,
      `${base}?prompt=`, `${base}?prompt=first`, `${base}?prompt=01`, `${base}?`, `${base}?prompt=0#x`,
      'https://reader:secret@origin.example.com/sessions/abc?prompt=0',
    ];
    for (const uri of badPrompt) {
      const record = example('valid', 'full.json');
      record.contributions[0].session.iterations[0].reference_uri = uri;
      expect(validateFull(record).ok, uri).toBe(false);
    }
    const badSession = [
      `${base}?prompt=0`, `${base}?token=secret`, `${base}#token`, 'https://reader:secret@origin.example.com/s/1',
      'https://origin.example.com/s/1 x', 'ftp://origin.example.com/s/1', 'https://',
    ];
    for (const uri of badSession) {
      const record = example('valid', 'full.json');
      record.contributions[0].session.reference_uri = uri;
      expect(validateFull(record).ok, uri).toBe(false);
    }
    const good = example('valid', 'full.json');
    good.contributions[0].session.iterations[0].reference_uri = 'http://localhost:4002/sessions/abc?prompt=0';
    expect(validateFull(good).ok).toBe(true);
  });
});

describe('attribution record v1 attribution levels', () => {
  it('accepts pure commit-level, pure line-level and mixed records', () => {
    expect(validateFull(example('valid', 'full.json')).ok).toBe(true);
    const line = example('valid', 'line-level.json');
    expect(line.attribution_level).toBe('line');
    expect(line.contributions.every((c: any) => Array.isArray(c.files))).toBe(true);
    expect(validateFull(line).ok).toBe(true);
    const mixed = example('valid', 'mixed-line-and-commit.json');
    expect(mixed.contributions.map((c: any) => Array.isArray(c.files))).toEqual([true, false]);
    expect(validateFull(mixed).ok).toBe(true);
  });

  it('rejects files on a commit-level record and a line-level record without files', () => {
    const commit = example('valid', 'line-level.json');
    commit.attribution_level = 'commit';
    expect(validateFull(commit).ok).toBe(false);
    const line = example('valid', 'full.json');
    line.attribution_level = 'line';
    expect(validateFull(line).ok).toBe(false);
  });

  it('checks line bounds and iteration references through the semantic layer', () => {
    const record = example('valid', 'line-level.json');
    const range = record.contributions[0].files[0].ranges[0];
    range.start_line = 43;
    range.end_line = 43;
    expect(validateFull(structuredClone(record)).ok).toBe(true); // a one-line range
    range.end_line = 42;
    range.iteration_index = 0;
    const result = validateFull(record);
    expect(result.schemaErrors).toEqual([]);
    expect(result.semanticErrors.map((e) => e.rule).sort()).toEqual(['S4', 'S5']);
  });

  it('never requires an iteration for a line range, and never lets one point outside its contribution', () => {
    const mixed = example('valid', 'mixed-line-and-commit.json');
    delete mixed.contributions[0].files[0].ranges[0].iteration_index;
    expect(validateFull(structuredClone(mixed)).ok).toBe(true);
    // Iteration 7 exists — but in the other session, so it does not count.
    mixed.contributions[1].session.prompt_count = 8;
    mixed.contributions[1].session.iterations = [{ index: 7 }];
    mixed.contributions[1].session.iterations[0].prompt_hash = 'sha256:' + 'c'.repeat(64);
    mixed.contributions[0].files[0].ranges[0].iteration_index = 7;
    expect(semanticErrors(mixed).map((e) => e.rule)).toEqual(['S5']);
  });

  it('keeps diff totals out of line claims', () => {
    expect(schema.$defs.diff_stats.properties).not.toHaveProperty('ranges');
    expect(Object.keys(schema.$defs.line_range.properties).sort()).toEqual(['end_line', 'iteration_index', 'start_line']);
    expect(Object.keys(schema.$defs.line_file.properties).sort()).toEqual(['path', 'ranges']);
  });
});

describe('attribution record v1 privacy invariants', () => {
  it('declares no property that could carry prompt or transcript text', () => {
    const allowed = new Set(['prompt_count', 'prompt_hash']);
    const suspicious = declaredPropertyNames().filter(
      (name) => !allowed.has(name)
        && /prompt|text|summary|marker|edit|transcript|message|content|body|comment/i.test(name),
    );
    expect(suspicious).toEqual([]);
  });

  it('closes every object, so no free-form bag can smuggle prompt text', () => {
    const open: string[] = [];
    for (const s of objectSchemas(schema)) {
      if (s.additionalProperties !== false) open.push(Object.keys(s.properties).join(','));
    }
    expect(open).toEqual([]);
  });

  it('never allows null', () => {
    expect(JSON.stringify(schema)).not.toMatch(/"null"/);
  });

  it('rejects the legacy note prompt-text carriers wherever a writer might put them', () => {
    const base = example('valid', 'full.json');
    const carriers: Array<(r: any) => void> = [
      (r) => { r.fullPrompt = 'x'; },
      (r) => { r.contributions[0].promptSummary = 'x'; },
      (r) => { r.contributions[0].session.prompts = [{ index: 0, text: 'x' }]; },
      (r) => { r.contributions[0].session.iterations[0].prompt_text = 'x'; },
      (r) => { r.contributions[0].session.markers = { intent: ['x'] }; },
      (r) => { r.contributions[0].session.iterations[0].edits_json = '{"promptText":"x"}'; },
    ];
    for (const mutate of carriers) {
      const record = structuredClone(base);
      mutate(record);
      expect(schemaOk(record)).toBe(false);
    }
  });

  it('keeps the valid examples free of prompt text', () => {
    for (const file of examples('valid')) {
      const raw = fs.readFileSync(path.join(V1_DIR, 'examples', 'valid', file), 'utf-8');
      expect(raw).not.toMatch(/"(text|prompt_text|promptSummary|fullPrompt|summary|markers|editsJson)"/);
    }
  });
});

describe('attribution record v1 semantics', () => {
  it('distinguishes a measured zero from an absent value', () => {
    const base = example('valid', 'full.json');
    const zero = structuredClone(base);
    zero.contributions[0].session.usage.tokens = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
    zero.contributions[0].session.usage.cost.amount = '0';
    zero.contributions[0].session.duration_ms = 0;
    expect(schemaOk(zero)).toBe(true);

    const absent = structuredClone(base);
    delete absent.contributions[0].session.usage;
    delete absent.contributions[0].session.duration_ms;
    expect(schemaOk(absent)).toBe(true);

    // An empty object would be a third, meaningless state.
    const empty = structuredClone(base);
    empty.contributions[0].session.usage = { tokens: {} };
    expect(schemaOk(empty)).toBe(false);
  });

  it('accepts measured cache token counts and rejects negative, fractional and string ones', () => {
    for (const [value, ok] of [[0, true], [1, true], [152300, true], [-1, false], [2.5, false], ['10', false]] as const) {
      for (const field of ['cache_read', 'cache_write']) {
        const record = example('valid', 'full.json');
        record.contributions[0].session.usage.tokens[field] = value;
        expect(schemaOk(record), `${field}=${JSON.stringify(value)}`).toBe(ok);
      }
    }
    // Each cache count can stand alone; there is no sum they must match.
    const alone = example('valid', 'full.json');
    alone.contributions[0].session.usage.tokens = { cache_read: 5 };
    expect(schemaOk(alone)).toBe(true);
  });

  it('stores no token total that could disagree with the other counts', () => {
    const record = example('valid', 'full.json');
    record.contributions[0].session.usage.tokens.total = 999;
    expect(schemaOk(record)).toBe(false);
    expect(Object.keys(schema.$defs.usage.properties.tokens.properties).sort()).toEqual(
      ['cache_read', 'cache_write', 'input', 'output'],
    );
  });

  it('forbids a session on an inferred contribution and requires one on a captured contribution', () => {
    const record = example('valid', 'minimal.json');
    record.contributions[0].evidence = 'inferred';
    expect(schemaOk(record)).toBe(false);
    delete record.contributions[0].session;
    expect(schemaOk(record)).toBe(true);
    record.contributions[0].evidence = 'session_capture';
    expect(schemaOk(record)).toBe(false);
  });

  it('keeps revision totals once per record and session totals inside each contribution', () => {
    const two = example('valid', 'two-contributions.json');
    expect(two.contributions).toHaveLength(2);
    expect(two.revision.diff_stats).toBeDefined();
    for (const c of two.contributions) {
      expect(c.diff_stats).toBeUndefined();
      expect(c.session.diff_stats).toBeDefined();
    }
    const repeated = structuredClone(two);
    repeated.contributions[0].diff_stats = structuredClone(two.revision.diff_stats);
    expect(schemaOk(repeated)).toBe(false);
    expect(schema.$defs.contribution.properties.diff_stats).toBeUndefined();
  });

  it('validates non-git revision identifiers by their own VCS rules', () => {
    const base = example('valid', 'minimal.json');
    const cases: Array<[string, string, boolean]> = [
      ['svn', '1234', true],
      ['svn', '0', false],
      ['hg', '9c0e2b4d6f8a1c3e5a7b9d0f2e4c6a8b0d1f3e5a', true],
      ['hg', '9c0e2b4', false],
      ['git', 'a'.repeat(64), true],
      ['perforce', '12345', true],
    ];
    for (const [vcs, id, ok] of cases) {
      const record = structuredClone(base);
      record.revision = { vcs, id };
      expect(schemaOk(record), `${vcs}:${id}`).toBe(ok);
    }
  });

  it('documents prompt-hash test vectors that match the production hash', () => {
    const vectors: Array<[string, string]> = [
      ['Add a retry to the upload client.', 'sha256:512d6c38f4066df65fc7c9606eee8e56db8f744938c23e1cb473524cb72a6947'],
      ['Also cover the timeout path with a test.\r\nKeep the public API unchanged.', 'sha256:fe415a6ebb38d75f3ff8685e31a4ae1181db8f304f65cb8647f4f2a4e56257ea'],
      ['Café menu: rename the route', 'sha256:592a611b697d52267ee802619b568864905785626befc57e619940a74be34e13'],
    ];
    for (const [text, digest] of vectors) {
      expect(canonicalPromptHash(text)).toBe(digest);
      expect(readme).toContain(digest);
    }
    // NFC folds the decomposed accent onto the precomposed form.
    expect(canonicalPromptHash('Café menu: rename the route')).toBe(canonicalPromptHash('Café menu: rename the route'));
    const full = example('valid', 'full.json');
    expect(full.contributions[0].session.iterations.map((i: any) => i.prompt_hash)).toEqual([vectors[0][1], vectors[1][1]]);
  });

  it('documents every property the schema declares', () => {
    const missing = declaredPropertyNames().filter((name) => !readme.includes('`' + name + '`'));
    expect(missing).toEqual([]);
  });
});
