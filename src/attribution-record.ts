/**
 * Reference implementation of the v1 attribution record contract
 * (schemas/attribution-record/v1). One place for the pieces every producer
 * and consumer needs: the JSON Schema check, the semantic rules JSON Schema
 * cannot express, the full two-layer validation path, the reader algorithm
 * for newer 1.x minors, and the canonical prompt hash.
 *
 * The Git note writer (A3, attribution-note.ts) validates every record it
 * embeds through this module; the JSON read path (A6) is expected to read
 * through it.
 * The specification is README.md next to the schema; this file implements
 * it and must not disagree with it.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import Ajv2020 from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

export const ATTRIBUTION_RECORD_SCHEMA_VERSION = '1.0';

// src/ (tests, tsx) and dist/ (the built CLI) both sit directly under the
// package root, so the schema resolves the same way from either — the same
// pattern watch-meta.ts uses for package.json. The schemas/ directory ships
// in the npm package (.npmignore does not exclude it).
export const ATTRIBUTION_RECORD_SCHEMA_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'schemas',
  'attribution-record',
  'v1',
  'attribution-record.schema.json',
);

let schemaCache: Record<string, any> | null = null;

/** The parsed v1.0 JSON Schema. Returns a fresh copy; mutating it has no effect here. */
export function attributionRecordSchema(): Record<string, any> {
  if (!schemaCache) schemaCache = JSON.parse(fs.readFileSync(ATTRIBUTION_RECORD_SCHEMA_PATH, 'utf-8'));
  return structuredClone(schemaCache!);
}

// Strict: unknown keywords and ambiguous constructs in the schema itself are
// errors, so a typo in the schema cannot silently stop enforcing a rule.
// strictRequired is Ajv's own lint, not a JSON Schema rule: it rejects the
// standard `anyOf: [{ required: [...] }]` idiom the contribution rules use.
const AJV_OPTIONS = { strict: true, strictRequired: false, allErrors: true } as const;

let exactValidator: ValidateFunction | null = null;
let projectingValidator: ValidateFunction | null = null;

function compile(removeAdditional: boolean): ValidateFunction {
  const ajv = new Ajv2020(removeAdditional ? { ...AJV_OPTIONS, removeAdditional: true } : { ...AJV_OPTIONS });
  addFormats(ajv);
  return ajv.compile(attributionRecordSchema());
}

/**
 * Layer 1: JSON Schema errors for a record that claims exactly 1.0.
 * An empty array means the record passes the schema (not the full path).
 */
export function validateSchema(record: unknown): ErrorObject[] {
  exactValidator ??= compile(false);
  return exactValidator(record) ? [] : [...(exactValidator.errors ?? [])];
}

export type SemanticRule = 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6';

export interface SemanticError {
  rule: SemanticRule;
  /** JSON Pointer to the offending value. */
  instancePath: string;
  message: string;
}

// ?prompt=N is the one suffix the schema requires on an iteration's
// reference_uri (and forbids on a session's), so a suffix match is exact.
const PROMPT_QUERY = /\?prompt=(0|[1-9][0-9]*)$/;

/**
 * Layer 2: the semantic rules of README.md ("Validating a record"). Assumes
 * the record already passed the JSON Schema; on anything else the result is
 * unspecified.
 *
 * S1  (session.id, iteration index) is unique in the whole record.
 * S2  a session id appears in at most one contribution.
 * S3  an iteration reference_uri's ?prompt=N equals that iteration's index.
 * S4  a line range has start_line <= end_line.
 * S5  a line range's iteration_index names an iteration of the same contribution.
 * S6  when session.prompt_count is present, every iteration index is below it.
 */
export function semanticErrors(record: any): SemanticError[] {
  const errors: SemanticError[] = [];
  const sessions = new Set<string>();
  const iterationIds = new Set<string>();

  (record?.contributions ?? []).forEach((c: any, ci: number) => {
    const at = `/contributions/${ci}`;
    const listed = new Set<number>();
    const sessionId = c.session?.id;

    if (typeof sessionId === 'string') {
      if (sessions.has(sessionId)) {
        errors.push({ rule: 'S2', instancePath: `${at}/session/id`, message: `session ${sessionId} already has a contribution in this record` });
      }
      sessions.add(sessionId);
      const promptCount = c.session.prompt_count;

      (c.session.iterations ?? []).forEach((it: any, ii: number) => {
        const itAt = `${at}/session/iterations/${ii}`;
        listed.add(it.index);
        const identity = JSON.stringify([sessionId, it.index]);
        if (iterationIds.has(identity)) {
          errors.push({ rule: 'S1', instancePath: `${itAt}/index`, message: `iteration ${it.index} of session ${sessionId} is listed twice` });
        }
        iterationIds.add(identity);

        // Zero-based index against a cumulative count. Absent count: nothing
        // to check, and nothing is inferred from the largest index.
        if (typeof promptCount === 'number' && it.index >= promptCount) {
          errors.push({ rule: 'S6', instancePath: `${itAt}/index`, message: `iteration ${it.index} is not below prompt_count ${promptCount}` });
        }

        const m = typeof it.reference_uri === 'string' ? PROMPT_QUERY.exec(it.reference_uri) : null;
        if (m && Number(m[1]) !== it.index) {
          errors.push({ rule: 'S3', instancePath: `${itAt}/reference_uri`, message: `prompt=${m[1]} does not match iteration index ${it.index}` });
        }
      });
    }

    (c.files ?? []).forEach((file: any, fi: number) => {
      (file.ranges ?? []).forEach((range: any, ri: number) => {
        const rAt = `${at}/files/${fi}/ranges/${ri}`;
        if (range.start_line > range.end_line) {
          errors.push({ rule: 'S4', instancePath: rAt, message: `start_line ${range.start_line} is after end_line ${range.end_line}` });
        }
        if (range.iteration_index !== undefined && !listed.has(range.iteration_index)) {
          errors.push({ rule: 'S5', instancePath: `${rAt}/iteration_index`, message: `iteration ${range.iteration_index} is not listed in this contribution's session.iterations` });
        }
      });
    });
  });
  return errors;
}

export interface FullValidationResult {
  ok: boolean;
  schemaErrors: ErrorObject[];
  /** Only computed when the schema passes. */
  semanticErrors: SemanticError[];
}

/** The full two-layer validation path for a record that claims exactly 1.0. */
export function validateFull(record: unknown): FullValidationResult {
  const schemaErrors = validateSchema(record);
  const semantic = schemaErrors.length === 0 ? semanticErrors(record) : [];
  return { ok: schemaErrors.length === 0 && semantic.length === 0, schemaErrors, semanticErrors: semantic };
}

export type ReadResult =
  /** A 1.0 record that passed the full validation path unchanged. */
  | { status: 'exact'; record: any }
  /** The 1.0 projection of a newer 1.x record: a transformed copy, not the input. */
  | { status: 'projected'; record: any }
  /** A major version other than 1: never interpreted with v1 semantics. */
  | { status: 'unsupported'; version: string }
  | { status: 'invalid'; reason: 'schema_version' | 'validation' };

/**
 * Reader algorithm of README.md ("Readers"). A newer 1.x record never passes
 * as an exact 1.0 record: it is copied, its schema_version rewritten to 1.0,
 * properties the 1.0 schema does not declare are dropped, and that
 * projection goes through the same full validation path. The input is never
 * modified.
 */
export function readRecord(input: any): ReadResult {
  const version = input?.schema_version;
  const m = typeof version === 'string' ? /^([1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(version) : null;
  if (!m) return { status: 'invalid', reason: 'schema_version' };
  if (m[1] !== '1') return { status: 'unsupported', version };
  if (m[2] === '0') {
    return validateFull(input).ok ? { status: 'exact', record: input } : { status: 'invalid', reason: 'validation' };
  }
  const projection = structuredClone(input);
  projection.schema_version = ATTRIBUTION_RECORD_SCHEMA_VERSION;
  // removeAdditional: true, not 'all' — 'all' also strips inside the
  // schema's if/then branches, which list only the properties they test,
  // and would delete real fields.
  projectingValidator ??= compile(true);
  if (!projectingValidator(projection) || semanticErrors(projection).length > 0) {
    return { status: 'invalid', reason: 'validation' };
  }
  return { status: 'projected', record: projection };
}

/**
 * Canonical prompt hash: SHA-256 over the NFC-normalized text with CRLF and
 * lone CR turned into LF, UTF-8 encoded, as `sha256:<64 lowercase hex>`.
 * Hash exactly the text the permissioned prompt reference serves.
 */
export function canonicalPromptHash(text: string): string {
  const canonical = text.normalize('NFC').replace(/\r\n?/g, '\n');
  return 'sha256:' + crypto.createHash('sha256').update(Buffer.from(canonical, 'utf-8')).digest('hex');
}
