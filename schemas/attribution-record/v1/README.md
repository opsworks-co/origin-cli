# Origin attribution record — schema version 1

Status: **v1.0 draft contract, published in this repository only.** There is no
public URL for the schema yet, and the schema deliberately has no `$id`. The
canonical copy is
`packages/cli/schemas/attribution-record/v1/attribution-record.schema.json`
in the Origin repository (and the same path in the public CLI mirror once it
is synced). The Origin CLI embeds a v1 record in the Git notes it writes; see
[Current runtime formats](#current-runtime-formats-and-mapping).

## Contents

- [Purpose](#purpose)
- [Files](#files)
- [Record overview](#record-overview)
- [Field reference](#field-reference)
- [Absent, null and zero](#absent-null-and-zero)
- [Versioning and compatibility](#versioning-and-compatibility)
- [Identity: actor, agent, model, producer](#identity-actor-agent-model-producer)
- [Attribution level and line-level claims](#attribution-level-and-line-level-claims)
- [Privacy and security](#privacy-and-security)
- [Relationship to Agent Trace](#relationship-to-agent-trace)
- [Current runtime formats and mapping](#current-runtime-formats-and-mapping)
- [Reading records: `origin export`](#reading-records-origin-export)
- [Validating a record](#validating-a-record)
- [Open questions](#open-questions)

## Purpose

An attribution record states which AI contributions are associated with one
VCS revision: which agent, which model, which session and which of its prompts,
on whose behalf, optionally which lines, and how to reach the permissioned
session and prompt records. It is the contract between Origin
(the producer) and any consumer: a code-review tool, a CI job, a VCS hosting
product.

The contract is neutral:

- **Transport-neutral.** It describes data, not storage. Nothing in it refers to
  Git notes, refs, or Origin's database. Today Origin transports attribution in
  Git notes (`refs/notes/origin`), but that is a delivery mechanism with its own
  legacy payload, not this contract.
- **Consumer-neutral.** No field exists for one consumer's UI.
- **VCS-neutral.** Revision identifiers are validated per VCS; Git SHAs are not
  assumed.

A consumer can implement a reader from this document and the schema alone.

## Files

| Path | What it is |
| --- | --- |
| `attribution-record.schema.json` | The canonical JSON Schema (draft 2020-12). |
| `examples/valid/minimal.json` | Smallest valid record: no telemetry, no optional metadata. |
| `examples/valid/full.json` | Every optional field populated. |
| `examples/valid/imported-and-inferred.json` | A non-Git revision with an imported and an inferred contribution. |
| `examples/valid/two-contributions.json` | One revision, two sessions: revision totals once, session totals per contribution. |
| `examples/valid/long-session-subset.json` | A 40-prompt session of which only iterations 17 and 18 went into this revision. |
| `examples/valid/line-level.json` | A line-level record; ranges point at the contributing iteration that produced them. |
| `examples/valid/mixed-line-and-commit.json` | A line-level record in which one contribution has line claims and the other stays commit-level. |
| `examples/invalid/*.json` | One record per rule that must be rejected; the file name names the rule. Most fail the JSON Schema. Seven pass it and fail a semantic rule: `duplicate-iteration-index.json` and `duplicate-session-iteration-index.json` (S1), `duplicate-session-id.json` (S2), `prompt-uri-index-mismatch.json` (S3), `line-range-inverted.json` (S4), `line-range-unknown-iteration.json` (S5), `iteration-index-beyond-prompt-count.json` (S6). |

The reference implementation is `packages/cli/src/attribution-record.ts`
(see [Validating a record](#validating-a-record)). Its tests live in
`packages/cli/src/__tests__/attribution-record-schema.test.ts`.

## Record overview

```json
{
  "schema_version": "1.0",
  "revision": { "vcs": "git", "id": "3f5a1c9e0b7d4a2f8e6c1b0a9d8e7f6a5b4c3d2e" },
  "attribution_level": "commit",
  "recorded_at": "2026-09-24T10:15:30Z",
  "producer": { "name": "origin-cli", "version": "0.20260924.258" },
  "contributions": [
    {
      "evidence": "session_capture",
      "agent": { "id": "claude-code" },
      "session": { "id": "8b1f3c2e-5d4a-4e6f-9a7b-0c1d2e3f4a5b" }
    }
  ]
}
```

One record describes one revision. A revision can have more than one
contribution (for example, a squash of work from two sessions), so
`contributions` is an array.

## Field reference

Types are JSON types. "Required" means the key must be present. Every object in
the schema is closed (`additionalProperties: false`): a writer must not emit keys
that are not listed here.

### Record (top level)

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `schema_version` | string | yes | Exact contract version, `MAJOR.MINOR`. This schema file is `"1.0"` and accepts only that value. See [Versioning](#versioning-and-compatibility). |
| `revision` | object | yes | The revision this record describes. |
| `attribution_level` | string | yes | `"commit"` or `"line"`. See [Attribution level](#attribution-level-and-line-level-claims). |
| `recorded_at` | string | yes | When the producer created this record (timestamp format below). This is not the commit time; the commit time belongs to the VCS. |
| `producer` | object | yes | The software that created this record. |
| `contributions` | array | yes | 1–100 contribution objects. |

### `revision`

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `vcs` | string (slug) | yes | VCS type. Well-known values: `git`, `hg`, `svn`. Other values are allowed. |
| `id` | string | yes | Full, unabbreviated revision identifier. |
| `diff_stats` | object | no | Line counts of the change this revision introduces. See [`diff_stats`](#diff_stats). |

`id` rules by VCS:

| `vcs` | `id` format |
| --- | --- |
| `git` | 40 (SHA-1) or 64 (SHA-256) lowercase hex characters. |
| `hg` | 40 lowercase hex characters (full node id). |
| `svn` | Decimal revision number without leading zeros, 1 or greater. |
| any other | 1–256 printable ASCII characters, no spaces. |

### `producer`

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `name` | string (slug) | yes | Producer name, for example `origin-cli`. A tool that converts another format into this one is the producer of the converted record. |
| `version` | string | yes | Producer version. |

### Contribution (items of `contributions`)

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `evidence` | string | yes | How the producer knows about this contribution. See the table below. |
| `agent` | object | see rule | The AI coding tool. |
| `model` | object | see rule | The language model. |
| `actor` | object | no | The human on whose behalf the agent acted. |
| `session` | object | see rule | The agent session. |
| `files` | array | no | Line-level claims of this contribution. See [Line claims](#line-claims-files). |

Rules, all enforced by the schema: at least one of `agent` and `model` is
present. When `evidence` is `session_capture`, both `agent` and `session` are
required. When `evidence` is `inferred`, `session` is forbidden. A contribution
has no diff statistics of its own; see [`diff_stats`](#diff_stats).

| `evidence` | Meaning |
| --- | --- |
| `session_capture` | The producer observed the agent session directly (for Origin: hooks and transcript capture). |
| `imported` | Converted from another attribution format, such as an Agent Trace record. Only fields present in the source are filled; nothing is guessed. |
| `inferred` | Derived by heuristics without observing a session (for example, from file patterns in a commit). Consumers should present it as lower confidence. `session` is forbidden, because none was observed. |

### `agent`

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | string (slug) | yes | Agent identifier. Must not be `unknown` in any letter case; omit `agent` instead. |
| `version` | string | no | Version of the agent tool, as the agent reports it. |

Well-known `agent.id` values, as the Origin CLI emits them today:
`claude-code`, `cursor`, `codex`, `gemini`, `copilot`, `devin`, `antigravity`,
`windsurf`, `aider`, `amp`, `junie`, `opencode`, `droid`, `rovo`, `continue`.
The vocabulary is open and deliberately not a schema enum; a reader must not
reject an unfamiliar value.

### `model`

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | string | yes | Model identifier exactly as the agent or provider reported it, for example `claude-opus-4-6` or `anthropic/claude-sonnet-4-6`. Up to 200 characters from `A–Z a–z 0–9 . _ : @ / [ ] + -`. Must not be `unknown`; omit `model` instead. |
| `provider` | string (slug) | no | Model provider, for example `anthropic`, `openai`, `google`. |
| `version` | string | no | A version or snapshot the provider reports separately from `id`. Writers must not derive it by parsing `id`. |

A writer must never infer the model from the agent, or the agent from the model.

### `actor`

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | string | no | Opaque identifier of the human, assigned by the producer's system (for example, an Origin user id). Meaningful only to that system. |
| `email` | string | no | Email address of the human. |

At least one field is present when `actor` is present. `actor` is not the commit
author or committer; those remain VCS data and can differ. See
[Privacy](#privacy-and-security) before emitting `email`.

### `session`

Two kinds of values live here, and they must not be confused:

- **Session-cumulative:** `started_at`, `duration_ms`, `prompt_count`, `usage`
  and `diff_stats` describe the whole session up to `recorded_at`, not this
  revision. The same session can appear in several records, so a consumer must
  not sum them across revisions.
- **Revision-scoped:** `iterations` lists only the prompt turns whose work is
  part of **this** revision. See [Iteration](#iteration-items-of-sessioniterations).

Within one record, a session appears in **at most one** contribution
(semantic rule S2). Every session-level value — `reference_uri`, `started_at`,
`duration_ms`, `prompt_count`, `iterations`, `usage`, `diff_stats` — therefore
has exactly one place in a record and cannot be duplicated or contradicted by a
second copy. v1.0 has no representation of one session split across several
contributions (for example, one session that switched models); a producer
records the session once, with the agent and model that describe it.

| Field | Type | Required | Unit / format | Meaning |
| --- | --- | --- | --- | --- |
| `id` | string | yes | 1–256 characters from `A–Z a–z 0–9 . _ : -`, starting with a letter or digit | Session identifier, unique within the producer. |
| `reference_uri` | string | no | [Reference URI](#permissioned-reference-uris) | The permissioned record of the whole session. It does not address any single prompt. |
| `started_at` | string | no | timestamp | When the session started. |
| `duration_ms` | integer | no | milliseconds, 0 or greater | Wall-clock time from `started_at` (or the producer's session start) to `recorded_at`. Not active or compute time. |
| `prompt_count` | integer | no | count | Human prompts submitted in the whole session up to `recorded_at`, including prompts before a resume. Session-cumulative, so it can be larger than the number of `iterations`; every listed iteration `index` is below it (semantic rule S6). |
| `iterations` | array | no | 1–1000 items | The prompt turns whose work went into this revision. |
| `usage` | object | no | | Token and cost usage of the session. |
| `diff_stats` | object | no | | Cumulative change of the whole session up to `recorded_at`. See [`diff_stats`](#diff_stats). |

### Iteration (items of `session.iterations`)

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `index` | integer | yes | Zero-based position of the prompt in the session. |
| `prompt_hash` | string | no | `sha256:` followed by 64 lowercase hex digits. See [Prompt hash](#prompt-hash). |
| `reference_uri` | string | no | [Prompt reference](#permissioned-reference-uris) of **this one prompt**: `<session record>?prompt=<index>`. Omitted when the producer has no prompt link. |

**Which iterations belong here.** `iterations` is the subset of the session's
turns whose work is part of this revision's content — not the session's
history and not every prompt up to `recorded_at`. A long session that touched
this revision in two of its forty turns lists those two; `prompt_count` still
says 40. A revision must not repeat prompts whose work is not in it. A writer
that cannot tell which turns contributed must **omit `iterations`** (and so make
no iteration-level claim) rather than list the whole prefix of the session.

**Index and `prompt_count`.** `index` is zero-based and `prompt_count` counts
every prompt of the session, so when both are present every `index` is below
`prompt_count` (semantic rule S6). For a resumed session, `prompt_count` is the
cumulative count including the prompts before the resume (Origin's
`promptIndexBase`), and `index` counts from the first prompt of the whole
session. A writer that cannot establish the cumulative count omits
`prompt_count`; nobody derives it from the largest index.

**Order.** Writers should list iterations by ascending `index`. Consumers must
not rely on array order; the identity below is what names an iteration.

The iteration identity is the pair (`session.id`, `index`), and it is unique
in the whole record (semantic rule S1 of the
[validation path](#validating-a-record)). JSON Schema cannot express this:
`uniqueItems` compares whole items, so two entries with the same `index` and
different hashes pass, and no keyword compares items of different arrays.

For one iteration, the three prompt fields describe the same prompt:
`reference_uri` serves it to an authorized reader, `prompt_hash` is computed over
exactly the text that URI serves, and (`session.id`, `index`) names it. When the
prompt reference uses the canonical `?prompt=N` form, `N` must equal `index`
(semantic rule S3). The session's `reference_uri` is not a substitute: it
identifies the session, and a consumer must not construct a prompt address from
it.

### `usage`

At least one of `tokens` and `cost` is present when `usage` is present.

`tokens` (at least one field present when `tokens` is present):

| Field | Type | Meaning |
| --- | --- | --- |
| `input` | integer ≥ 0 | Input tokens that were not cache reads or cache writes, as the agent reports them. |
| `output` | integer ≥ 0 | Output tokens as the agent reports them. Whether reasoning tokens are included follows the provider's own accounting. |
| `cache_read` | integer ≥ 0 | Input tokens served from the provider's prompt cache. |
| `cache_write` | integer ≥ 0 | Input tokens written to the provider's prompt cache. |

Each count is an independent measurement. Cache counts can be a large share of
billed usage — often larger than `input` — so a producer that measures them
should record them. A count the provider does not report is absent; `0` means a
measured zero.

There is deliberately no `total`, and no arithmetic relation between the fields
or between them and `cost`. A stored total could disagree with the other counts,
JSON Schema cannot check the arithmetic, and agents account for reasoning and
cache tokens differently. Providers also price cache reads and writes
differently from fresh input, so a consumer must not expect `cost` to follow
from the token counts. A consumer that needs a sum computes it from the fields
that are present. Per-agent token semantics are confirmed by OR-23.

`cost`:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `amount` | string | yes | Non-negative decimal number encoded as a string: digits, optional `.` and 1–6 fractional digits, for example `"0.4213"`. A string avoids binary floating-point rounding. |
| `currency` | string | yes | ISO 4217 alphabetic code, for example `USD`. Origin writes `USD`. |
| `basis` | string | yes | `estimated`: computed by the producer from token usage and a price table. `reported`: taken from the provider's billing data. Origin's current cost is `estimated`. |

All integers in the schema are limited to 0 … 9007199254740991, so they are safe
in JavaScript.

### `diff_stats`

Diff totals only. They say how many lines changed, **not** which lines, and not
how many of them an AI wrote. The same object shape appears in two places, and
the place defines the scope:

| Location | Scope |
| --- | --- |
| `revision.diff_stats` | The change this revision introduces (for a merge, relative to its first parent). At most once per record. |
| `contributions[].session.diff_stats` | The cumulative change of that session up to `recorded_at`. It can span several revisions and can overlap other sessions. |

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `lines_added` | integer ≥ 0 | yes | Added lines. |
| `lines_removed` | integer ≥ 0 | yes | Removed lines. |

Summing rules:

- `revision.diff_stats` is never split across or repeated in contributions (the
  schema rejects `diff_stats` on a contribution). Across records of different
  revisions it may be summed to get the totals of that set of revisions.
- `session.diff_stats` must not be summed across contributions of one record
  (sessions can touch the same lines), across records (the same session appears
  in every revision it touched), or with `revision.diff_stats`.
- The same rule applies to the other session-cumulative values: `usage`,
  `duration_ms` and `prompt_count`.
- Line ranges are not diff totals. A consumer must not derive `files` from
  `diff_stats`, or `diff_stats` from `files`.

### Line claims (`files`)

`contributions[].files` is present only on a line-level contribution.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `path` | string | yes | Repository-relative POSIX path of the file, as it is at this revision. |
| `ranges` | array | yes | 1–10000 line ranges of that file claimed by this contribution. |

Range (items of `ranges`):

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `start_line` | integer ≥ 1 | yes | First line of the range, 1-based, inclusive. |
| `end_line` | integer ≥ 1 | yes | Last line of the range, 1-based, inclusive. `start_line <= end_line` (semantic rule S4); a one-line range has both equal. |
| `iteration_index` | integer ≥ 0 | no | The contributing iteration that produced these lines. It must name an entry of the **same** contribution's `session.iterations` (semantic rule S5). Absent: the contribution is known, but not the prompt; a writer must not fill in a guess. |

Line numbers refer to the file content at this revision. `files` has 1–1000
entries; an empty `files` or `ranges` array is invalid, because a line-level
contribution that claims no lines is not line-level.

**Path format** (enforced by the schema): no leading `/`, no empty segment
(`a//b`), no `.` or `..` segment, no trailing `/`, no backslash, no NUL or other
control character, at most 4096 characters. The schema does not check that the
file exists; that needs the repository.

### Formats

- **Timestamps** use RFC 3339 `date-time` with an explicit offset: `Z` or
  `±HH:MM`, uppercase `T` and `Z`, and optionally 1–9 fractional-second digits.
  Examples: `2026-09-24T10:15:30Z`, `2026-09-24T12:40:05.123+02:00`. A timestamp
  without an offset is invalid. So is an impossible date, which the schema
  checks through `format: date-time`.
- **Slugs** match `^[a-z0-9][a-z0-9._-]{0,63}$`.
- **Version strings** match `^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$`.

## Absent, null and zero

- **Absent means "not known here".** If the producer did not measure or does not
  know a value, the key is omitted. For objects in which every field is optional
  (`actor`, `usage`, `tokens`), the whole object is omitted rather than written
  empty. The schema rejects empty objects.
- **Zero means "measured, and it was zero".** `0` tokens, `"0"` cost and
  `0` lines are real measurements. A writer must not emit `0` as a placeholder.
- **`null` is never valid.** No field defines a meaning for `null`, so the schema
  rejects it everywhere.
- **Empty strings and sentinels are invalid.** `""` fails every string pattern.
  `unknown` is rejected for `agent.id` and `model.id`. Omit the object instead.
- **Tokens and cost are optional** until OR-23 confirms that every supported
  agent fills them reliably. A consumer must not display a missing value as `0`.

## Versioning and compatibility

`schema_version` is `"MAJOR.MINOR"`. The first release is `"1.0"`.

**Within major version 1, a minor release may only:**

- add a new optional property to an existing object;
- add a new optional object.

A minor release never adds a required field, changes a field's type, unit or
meaning, narrows or widens an existing field's allowed values, or removes a
field. Anything else requires a new major version and a new schema file under
`../v2/`.

Each minor version has its own schema file. This file is the 1.0 schema, and it
accepts `schema_version: "1.0"` only; `"1.1"` or `"1.9999"` fail it.

**Writers:**

- A writer emits the exact `schema_version` of the schema it validated against,
  and emits only the fields that version defines. A record passes the writer
  check only through the [full validation path](#validating-a-record) of that
  exact version.
- A writer must not emit a version it does not implement.

**Readers.** Parse `schema_version` as `MAJOR.MINOR` (two non-negative decimal
integers without leading zeros) and then:

1. Not parseable: the record is invalid.
2. Major other than `1`: do not interpret it with v1 semantics. Skip it and report
   it as unsupported. Do not coerce it or partially read it.
3. `1.N` where the reader has the schema for `1.N`: run the full validation path
   with that schema. On success the record is read **exactly**.
4. `1.N` newer than every schema the reader has (for a 1.0 reader: `N > 0`):
   build the record's **1.0 projection** and validate that instead:
   1. Copy the record; never modify the input.
   2. Set `schema_version` to `"1.0"`.
   3. Remove every property that a closed object of the 1.0 schema does not
      declare. With Ajv: compile the 1.0 schema with `removeAdditional: true`.
      Do not use `removeAdditional: "all"`: it also strips inside the schema's
      `if`/`then` branches, which list only the properties they test, and
      deletes real fields.
   4. Run the full validation path of 1.0 on the projection.

   On success the reader uses the projection and must treat it as a
   transformed record, not as a record that passed the 1.0 schema. The
   projection is safe to read because minor releases only add optional
   properties (above): every field it keeps has its 1.0 meaning.
5. Any failure: do not use the record. A producer bug must not become a
   consumer's claim.

`readRecord` in `packages/cli/src/attribution-record.ts` implements this
algorithm.

**Relationship to the legacy `origin.version`.** The Git note payload that Origin
writes today has a key `origin.version` whose value is the number `1`. That value
belongs to the legacy note payload, not to this contract. It is not reliable even
there: the CI squash note also writes `version: 1` with a completely different
shape, and Agent Trace import notes and backfill notes have no `version` at all.
A reader must never treat `origin.version: 1` as `schema_version: "1.0"`, and a
note is not an attribution record unless it contains a record that validates
against this schema. How the Origin CLI embeds a record in its Git notes is
described under [Runtime status](#runtime-status-the-origin-cli-writer); it is
a property of that transport, not of this contract.

## Identity: actor, agent, model, producer

Four different entities appear in a record, and they are never merged:

| Entity | Field | Example | What it is not |
| --- | --- | --- | --- |
| Acting human | `actor` | `user_01j8example` | Not the commit author or committer. Not the agent. |
| AI coding tool | `agent` | `claude-code` | Not the model. Not the producer. |
| Language model | `model` | `claude-opus-4-6` | Not the agent. Never guessed from the agent. |
| Record writer | `producer` | `origin-cli` | Not the agent that wrote the code. |

## Attribution level and line-level claims

Every contribution makes one of two kinds of claim:

- **Commit-level** (no `files`): the contribution is associated with the
  revision as a whole. It does not say which files or lines it wrote.
- **Line-level** (`files` present): the contribution claims the listed line
  ranges of the listed files, optionally down to the contributing iteration.

`attribution_level` summarizes the record, and the schema enforces it:

| `attribution_level` | Rule |
| --- | --- |
| `commit` | No contribution has `files`. Every claim is commit-level. |
| `line` | At least one contribution has non-empty `files`. Contributions without `files` may sit next to it and stay commit-level claims. |

A record's claims never assert more than they say:

- A line-level contribution claims its listed ranges; it does **not** assert
  that unlisted lines are human-written, and a set of line claims is not
  necessarily complete coverage of the revision.
- Commit-level contributions do not say which lines they wrote, even when they
  sit in a `line` record.
- Neither kind is a share of AI versus human lines.
- `diff_stats` are totals of a diff, and legacy `linesAdded`/`linesRemoved` are
  too. A producer must never turn them into ranges, and a producer whose source
  only knows commit-level facts emits commit-level contributions without
  `files` — it never invents ranges.

The value `line` and the `files` shape are part of 1.0, so line-level records do
not need a new major version. A later 1.x minor can only add optional details to
line claims (for example, new optional range properties) without changing the
meaning of the fields defined here.

**Deliberate limits of the 1.0 line shape:**

- A range has no author kind (`ai`/`human`/`mixed`): every range is claimed by
  its contribution.
- Ranges may overlap, within one file entry, across file entries with the same
  path, and across contributions. v1.0 assigns no meaning to an overlap beyond
  "each contribution claims these lines"; a consumer must not sum range lengths
  across contributions to compute a share.
- No per-range confidence, no line content hashes, no range for deleted lines
  (line numbers refer to the file at this revision).
- Producing line ranges from agent events is not part of this contract; no
  Origin writer emits `files` yet.

**Other known limits of v1:**

- No history-rewrite lineage (amend, rebase, squash, cherry-pick). A rewritten
  revision gets its own commit-level record (see
  [Runtime status](#runtime-status-the-origin-cli-writer)); OR-11/A5 needed no
  lineage field. One can still be added as an optional field in a minor release
  if a consumer needs it.
- No line-range remapping across a rewrite: a rewritten revision's record is
  commit-level even when the old revision's was line-level.
- No per-file diff statistics and no list of files read or changed; files
  appear only as line claims.
- No sub-agent breakdown. Sub-agent work is part of its parent session.

## Privacy and security

### No prompt text

A v1 record never contains prompt text or text that could reconstruct it. This
covers the raw prompt, the prompt summary, the agent's own commentary (the
legacy `markers`), and edit captures that embed the prompt (the legacy
`editsJson`). Every object in the schema is closed and every string field has a
restrictive pattern, so the schema itself rejects these carriers. The automated
checks also fail if a property with a prompt- or text-like name is ever
declared.

A record carries only these things about prompts: a count, and for each
contributing iteration an optional hash and an optional permissioned prompt
reference. The session can also have its own permissioned reference. Line
claims carry only paths and line numbers, never line content.

### Prompt hash

- **Algorithm:** SHA-256.
- **Canonical input:**
  1. Start from the prompt text exactly as an authorized reader obtains it from
     the iteration's `reference_uri` (or, when the record has none, from the
     producer's permissioned store for that iteration). Do not truncate it.
  2. Normalize it to Unicode NFC.
  3. Replace every CRLF (`\r\n`) and every lone CR (`\r`) with LF (`\n`).
  4. Encode it as UTF-8 without a byte-order mark. Do not trim whitespace or
     append a newline.
- **Representation:** `sha256:` followed by the 64-character lowercase
  hexadecimal digest.

A writer must hash exactly the text the permissioned record serves. If the
producer redacts secrets before storing prompts, the hash is computed over the
redacted text, so that a reader can verify a match. Language runtime hash
functions (for example JavaScript object hashing or Python `hash()`) are not
acceptable.

Test vectors (JavaScript string escapes):

| Prompt text | Digest |
| --- | --- |
| `"Add a retry to the upload client."` | `sha256:512d6c38f4066df65fc7c9606eee8e56db8f744938c23e1cb473524cb72a6947` |
| `"Also cover the timeout path with a test.\r\nKeep the public API unchanged."` | `sha256:fe415a6ebb38d75f3ff8685e31a4ae1181db8f304f65cb8647f4f2a4e56257ea` |
| `"Café menu: rename the route"` (same digest as the precomposed `"Café …"`) | `sha256:592a611b697d52267ee802619b568864905785626befc57e619940a74be34e13` |

**The hash identifies a prompt; it does not hide it.** An unsalted SHA-256 of a
short or predictable prompt ("fix the tests", "bump the version") can be
recovered by guessing and hashing candidates. Anyone who can read the record can
also confirm a guess about a prompt's content. The hash is for matching a record
to its permissioned prompt, and for detecting that two iterations used the same
prompt. It is not a confidentiality mechanism. Which prompts the Origin CLI
hashes is described under
[Runtime status](#runtime-status-the-origin-cli-writer) (OR-48/A8).

### Permissioned reference URIs

Two reference kinds exist:

| Field | Addresses | Query |
| --- | --- | --- |
| `session.reference_uri` | The whole session. | None. |
| `session.iterations[].reference_uri` | One prompt of the session. | Exactly `prompt=N`, required. |

Format, enforced by the schema:

- `http://` or `https://`, a host name (letters, digits, `.`, `-`), an optional
  `:port`, and an optional path. `https` is expected everywhere except local
  development.
- No userinfo (`user:password@`) and no fragment (`#…`) on either kind.
- `session.reference_uri` has no query at all.
- `iterations[].reference_uri` must end with exactly one query parameter,
  `prompt=N`, where `N` is a non-negative decimal integer without leading zeros,
  and `N` must equal the iteration's `index` (semantic rule S3). Nothing else:
  no other key (`token`, `signature`, `tab`, …), no second `prompt`, no empty or
  non-numeric value, no bare `?`. A URI without `?prompt=N` — including the
  session's own reference — addresses no single prompt, so it is invalid here.
  The field itself stays optional: a producer with no prompt link omits it. A
  path-style prompt endpoint (for example `/sessions/<id>/prompts/<n>`) does not
  exist today; supporting one would be a deliberate change in a later contract
  version.

**Canonical prompt link.** Origin's session record is
`<origin-web>/sessions/<session-id>`, and a prompt of it is
`<origin-web>/sessions/<session-id>?prompt=<index>`, which the existing Origin
session route already understands. Origin's UI also understands
`tab=blame|snapshots`, but that is a presentation choice, not part of the
record: a consumer opens the prompt-only URI and the UI picks the view. Any other
query parameter is a deliberate future contract change with its own allowlist,
never a relaxation of this pattern.
- Path characters are limited to RFC 3986 unreserved characters, sub-delimiters,
  `:`, `@` and percent-encoding. No spaces. At most 2048 characters.
- IPv6 literal hosts are not accepted in v1.

What the schema cannot check: whether a path segment is itself a secret (for
example a bearer token placed in the path). Writers must not put tokens,
signatures, or prompt text anywhere in the URI, and a path segment must be an
identifier, not a credential.

Access rules:

- Dereferencing either reference must require authentication and an
  authorization check at the referenced service. Holding the URI must not grant
  access; a reader without permission must get an error, not the prompt.
- Non-resolvable schemes such as `origin://session/<id>` are invalid.

### Actor

`actor.email` is personal data, and records travel with repository metadata to
every clone and consumer. Prefer `actor.id`. Emit `email` only where the
deployment's policy allows it. Whether Origin emits `actor` at all is not
decided in v1; see [Open questions](#open-questions).

### What this contract does not do

It does not change what Origin writes, and it does not remove prompt text from
existing Git notes. OR-48/A8 made new legacy notes metadata only by default (see
[Runtime status](#runtime-status-the-origin-cli-writer)). Cleaning notes that
were already published is OR-49/A9. Both use this contract as their target.

## Relationship to Agent Trace

Origin already imports and exports Agent Trace v0.1.0 (`src/agent-trace.ts`).
The repository has no vendored copy of the Agent Trace specification. This
comparison is based on the v0.1.0 model as Origin implements it in
`src/agent-trace.ts` and documents it in `docs/INTEGRATIONS.md`. The current
external specification was not re-checked for OR-7.

| OR-7 need | Agent Trace v0.1.0 (as in this repo) | Consequence |
| --- | --- | --- |
| Honest commit-level claim next to line claims | `files[].conversations[].ranges[]` is the core structure. Attribution is always per line range. | A commit-level record would need invented ranges, or an empty `files` array that claims nothing. v1 allows both kinds, per contribution. |
| Agent and model kept apart | A single `contributor.model_id`. `tool` names the program that produced the trace, not the AI agent. | Origin's own export guesses `model_id` from the agent name (`claude` → `anthropic/claude-opus-4-6`). Its import guesses the agent from `model_id`. Both fabricate identity. |
| Tokens, cost, acting user, prompt count, prompt hash | No fields. Only a free-form `metadata` object. | Consumers could not validate these fields, which defeats the purpose of a schema. |
| Missing versus zero | Not specified. | No rule to build on. |
| Permissioned prompt reference | `conversation.url` without access semantics. Origin exports `origin://session/<id>`, which cannot be resolved. | No ACL expectation. |
| Revision identity | `vcs.type` + `vcs.revision`. | Fits. v1 `revision` follows the same idea with per-VCS validation. |
| Contributor kinds | `ai`, `human`, `mixed`, `unknown` per range. | Line-level concepts. Origin's import folds `mixed` into AI. |

**Decision: a separate Origin schema (option 3), not direct use (1) and not a
profile/extension (2).** Direct use fails the commit-level honesty requirement
and cannot express the required telemetry. A profile would put every
OR-7-specific field into the unvalidated `metadata` object, and would bind
Origin to extension rules this repository cannot currently verify. Agent Trace
stays an import/export interchange format. The mapping is:

- **Agent Trace → v1:** one record per `vcs.revision`, with `evidence:
  "imported"`. `model.id` is set only from a source `model_id`. `agent` is set
  only if the source names the agent explicitly. The trace `id` is not a
  session id, so no `session` is created, and ranges carry no
  `iteration_index`. Ranges of `ai` contributors become that contribution's
  `files[].ranges` (`attribution_level: "line"`); `human`, `mixed` and
  `unknown` ranges are not carried, because v1 line claims have no author kind.
  A contributor without `model_id` gives no contribution.
- **v1 → Agent Trace:** possible only for line-level contributions (their
  ranges become `ai` ranges; the conversation URL is the session reference).
  Commit-level contributions have no ranges and cannot be exported. No exporter
  does this yet.

## Current runtime formats and mapping

This section lists the attribution formats that exist and how each maps to
v1, so that a converter or a new writer can be built without reading the
TypeScript sources. Paths are relative to the Origin monorepo.

### Runtime status: the Origin CLI writer

Since OR-9/A3 the CLI's session note writer (`writeGitNotes` in
`packages/cli/src/git-notes.ts`, called from the post-commit, Stop and
SessionEnd hooks) embeds one v1 record per annotated commit in the note on
`refs/notes/origin`, next to the unchanged legacy payload:

```json
{ "origin": { "version": 1, "sessionId": "…", "…": "…" }, "attribution_record": { "schema_version": "1.0", "…": "…" } }
```

- The record is built by `packages/cli/src/attribution-note.ts` and passes
  `validateFull` before it is written. A record that cannot be built honestly,
  or fails validation, is left out; the legacy note is still written.
- One record per commit: `revision.id` is the annotated commit.
- It is written only for an observed session with a captured tool identity:
  `evidence: "session_capture"`, `agent.id` from the hook's agent slug when it
  is one of the well-known ids above, never from the model.
- Emitted optional fields and their sources: `model.id` (the model the agent
  reported; bare agent names such as `claude` are not model ids);
  `session.reference_uri` (`<apiUrl>/sessions/<id>`, only in connected mode for a
  session the server registered); `session.started_at` and `duration_ms` (the
  captured start, not for a resumed session, whose start this launch did not
  see); `session.iterations` (only the turn the post-commit hook watched the
  commit land in, as a cumulative index, with its `?prompt=N` link when the
  session has a reference); that iteration's `prompt_hash` (see below);
  `session.usage.cost` (a positive estimate, `basis: "estimated"`).
- **Prompt hash (OR-48/A8).** `prompt_hash` is written only when the writer can
  prove its input is exactly the text the iteration's `?prompt=N` link serves:
  the whole prompt this launch captured for that turn (cumulative index minus
  `promptIndexBase`), at most 1,000 UTF-16 code units (the stored record is
  clipped there), unchanged by the CLI's secret redaction (some producers
  redact, some do not), with no leading or trailing whitespace and no tag-like
  token or Codex files envelope (the API trims and strips envelopes), and no
  `[image]` placeholder (relinked after an upload). Otherwise the field is
  absent; coverage is partial by design, and an absent hash never removes the
  `reference_uri`. A session without a server record can carry a hash without a
  link. `packages/cli/src/prompt-hash.ts` holds the rule; an API-side parity
  test runs it against the API's own transformations.
- Deliberately absent: `usage.tokens` (the parsers start every count at `0`, so
  a measured zero cannot be told from "not measured" until OR-23),
  `prompt_count` (the cumulative count across resumes is not established
  reliably), `actor`, `revision.diff_stats` and `session.diff_stats` (the note
  writers do not compute them per revision), and `files` (no line ranges are
  captured).
- Notes written before this change are not rewritten, and the other shapes below
  (Agent Trace import, backfill) still carry no record.
- **History rewrites (OR-11/A5).** A commit made by `git commit --amend`,
  `git rebase` (including a `rebase -i` squash/fixup), `git cherry-pick`, or a
  squash merge carried by `origin ci squash-merge --range --target` gets a record
  rebuilt for **the new commit**, never a copy of the old one (which names the
  old revision):
  - `attribution_level` is always `commit`: line ranges are not remapped across
    a rewrite, and no `files` are carried. Line-level remapping is future work.
  - From each old note's record (read with `readRecord`; exact or a 1.x
    projection that names that old commit — anything else gives no claim), or
    else from a legacy session note with an observed session id and an explicit
    agent (the rules of this writer; `detected-*`, `unknown`, a model without an
    agent and squash aggregates give none), a contribution keeps `evidence`,
    `agent`, `model`, `actor`, `session.id`, and `session.reference_uri` /
    `started_at` when every copy agrees. It drops `iterations`, `prompt_count`,
    `usage`, `duration_ms`, `session.diff_stats` and `revision.diff_stats`,
    because they describe the old revision or a session total that summing
    across squashed commits would double-count.
  - Several old commits → one new commit: one contribution per session (S2).
    Copies of one session that disagree on its hard identity — evidence or
    agent — give that session no contribution, rather than one picked by input
    order. Copies that name two different models (a `/model` switch inside the
    session) give one contribution without `model`; a model only some copies
    state is kept. The result does not depend on the order of the old→new
    pairs.
  - `recorded_at` is the rebuild time and `producer` the CLI that rebuilt it.
    The record passes the full validation path before it is written; when no
    contribution survives, the note carries the legacy payload only.
  - No lineage field is added: the old→new link is git's (or the squash
    command's) input, not part of this contract. The note envelope carries
    transport bookkeeping next to `origin` and `attribution_record`:
    `origin_rewrite: {schema: "origin-rewrite/1", target, sources, base}` —
    the commit the note belongs to, every old commit it was built from, and
    whether the commit's own note sits underneath (`base: "note"`). Only that
    exact shape marks a rewrite's note; it is not a field of the record.
  - An existing note on the new commit that a rewrite did not write keeps its
    record's contributions and gains only missing sessions; a record that is
    not an exact 1.0 record for that commit (a newer major included) is left
    exactly as it is, by the rewrite and by the session writer alike. The
    session writer, writing the commit's own note after a rewrite, keeps the
    carried contributions of other sessions, and a rewrite never rebuilds a
    note into one that carries less than it did.

The sections below describe the legacy payloads, which every note still carries.

### Existing writers and readers

Five payload shapes live on `refs/notes/origin` (paths under
`packages/cli/src/`):

| Shape | Writer | Distinguishing keys |
| --- | --- | --- |
| Session note | `git-notes.ts` `buildNotePayload`, called from `commands/hooks/post-commit.ts`, `commands/hooks/session-end.ts` and `commands/hooks/stop.ts` | `{origin: {version: 1, sessionId, …}}` |
| Scrubbed session note | `commands/scrub-notes.ts` (`scrubNoteObject` in `git-notes.ts`) | Session note with prompt text removed and `promptTextWithheld: true` |
| Squash aggregate | `history-rewrite.ts` (`rebuildRewrittenNote`), for a `rebase -i` squash and for `origin ci squash-merge --range --target` (`ci-integration.ts` `squashMergeAttribution`) | `{origin: {version: 1, squashMerge: true, commitsSquashed, sessionIds[], models[]}}` (plus `sessionId`, `agent`, `model` only for a single-session squash), next to a rebuilt `attribution_record`. `commitsSquashed` counts every squashed commit. Notes written by the earlier CI command also carry summed `total*` fields. |
| Agent Trace import note | `agent-trace.ts` `importAgentTrace` | `{origin: {source: "agent-trace", sourceVersion, sourceTool, sessionId: <trace id>, attribution: {files}}}`, no `version` |
| Backfill note | `commands/backfill.ts` `applyBackfillNote` | Bare object without the `origin` wrapper: `{sessionId: "backfill-<sha8>", agent, agentName, model: "unknown", confidence, source}` |

Existing notes are also rewritten in place by `commands/notes-repair.ts` (drops
junk `markers` entries) and `attribution.ts` `preserveAttributionOnMove` (renames
`attribution.files` keys). The `post-rewrite` hook and the cherry-pick carry in
`post-commit` write notes on rewritten commits (never on the old ones).

Readers: `attribution.ts` (`isAiCommit`, `getLineBlame`,
`getSessionContextForCommit`), `commands/show.ts`, `commands/why.ts`,
`mcp/file-context.ts`, `agent-trace.ts` (`getFilesForSession`),
`ci-integration.ts`, and in the API `apps/api/src/services/origin-sessions-import.ts`
(`noteCarriesAiEvidence`, `ensureAiToolDetected`, `synthesizeSessionFromNote`,
used by `POST /api/sessions/:id/import-note` and repository note import) and
`apps/api/src/routes/repos.ts` (GitHub blame fallback). None of them checks
`origin.version`. Several CLI readers (`attribution.ts`, `agent-trace.ts`,
`mcp/file-context.ts`, `commands/report.ts`, `commands/intent-review.ts`) also
accept a bare note object without the `origin` wrapper.

Related formats that are not attribution records: `refs/notes/origin-acceptance`
(acceptance notes), `refs/notes/origin-memory*` (repository memory),
`origin export --format json|csv` without a range (session summaries from the
`origin-sessions` branch), and the Agent Trace export. `origin export
--format=json <range>` does emit v1 records; see
[Reading records: `origin export`](#reading-records-origin-export). `docs/INTEGRATIONS.md` also documents `POST /api/agent-traces`, but no
such route exists in `apps/api`.

### Inventory

"Required today" refers to the TypeScript type or the serialized payload.
"Sensitive" means prompt-derived or personal data.

| Existing field | Existing format/source | Meaning (verified against writers and readers) | Required today | Sensitive | v1 field/disposition |
| --- | --- | --- | --- | --- | --- |
| `origin.version` | Session note, CI squash note | Legacy payload version, always `1`. Absent from the Agent Trace and backfill shapes. The squash note reuses it for a different shape. No reader checks it. | Session note: always written | No | Not mapped. Replaced by `schema_version: "1.0"`, which has independent semantics (see [Versioning](#versioning-and-compatibility)). |
| (annotated commit) | All note shapes | The note is attached to a commit; the payload never contains its own commit id. | Implicit | No | `revision.vcs: "git"`, `revision.id` = the annotated commit, taken from the transport. |
| `sessionId` | Session note | Origin session id. `unknown` is a legacy sentinel for "no session". | Yes | No | `session.id`. Not mapped when empty or `unknown`. |
| `sessionId` | Agent Trace import note | The trace record `id`, not a session. | Yes | No | Not mapped. |
| `sessionId` | Backfill note | Synthetic `backfill-<sha8>`; no session was observed. | Yes | No | Not mapped (`evidence: "inferred"`, no `session`). |
| `agent` | Session note (from `agentSlug`) | Agent slug: `claude-code`, `cursor`, `codex`, `gemini`, `copilot`, `devin`, `antigravity`. Omitted when unknown. | No | No | `agent.id`. |
| `agent`, `agentName` | Backfill note | Agent guessed from file patterns (`.claude/`, `.cursor/`, `.codex/`). | Yes | No | `agent.id`, with `evidence: "inferred"`. `agentName` is not mapped (duplicate). |
| `model` | Session note | Model id reported by the transcript or hook, or the literal `unknown` when not found. | Yes | No | `model.id`. `unknown` means absent. Only the model id is recorded today; no provider or separate version. |
| `model` | Backfill note | Always `unknown`. | Yes | No | Absent. |
| `attribution.files[].model` | Agent Trace import note | Source `model_id`, verbatim. | No | No | `model.id`, with `evidence: "imported"`. |
| `attribution.files[].agent` | Agent Trace import note | Guessed from `model_id` by substring matching. | No | No | Not mapped (inferred identity). |
| `prompts[].authorName`, `prompts[].authorEmail` | Session note type (`PromptNoteEntry`) | Declared, but no writer sets them (`buildPromptNoteEntries` never fills them). | No | Personal data | `actor` is defined but has no source today. |
| (acting user) | none | No note shape records the human who ran the session. The commit author is VCS data and can differ. | — | — | `actor` (optional); no current source. |
| `prompts[].index` | Session note | Zero-based prompt index within the session. The list covers the session's prompts up to note time (capped at 50), not only those that touched this commit. | Yes (per entry) | No | Not mapped from legacy notes: v1 `iterations` lists only contributing turns, and the legacy list is the session prefix. A writer that knows which turns contributed emits their indexes. |
| `promptCount` | Session note | Number of prompts in the local session state (`state.prompts.length`) when the note was written. After a resume the local list restarts, and the prompts before it (`promptIndexBase`) are not included; the note does not say whether that happened. | Yes | No | Not mapped from legacy notes: it is not guaranteed to be the cumulative count `session.prompt_count` requires. A new writer emits the cumulative count including `promptIndexBase`, or omits the field. |
| `promptSummary` | Session note | Redacted prompt text, 200 characters. The first prompt in session-end notes, the last in post-commit/stop notes. | Yes in type; withheld when prompts are excluded | **Prompt text** | Dropped. Never in v1. |
| `fullPrompt` | Session note | Last prompt, redacted, capped at 8 KB. | No | **Prompt text** | Dropped. |
| `prompts[].text` | Session note | Per-prompt text, redacted, capped at 1 KB. | Yes in type; withheld when prompts are excluded | **Prompt text** | Dropped. |
| `markers` | Session note | The agent's `[Origin: …]` commentary from the transcript. | No | **Prompt-derived** | Dropped. |
| `prompts[].editsJson` | Session note | Serialized edit capture, including `promptText` (blanked when prompts are excluded) and code before/after, capped at 16 KB. | No | **Prompt text** (embedded) and code | Dropped. |
| `promptTextWithheld` | Session note, scrubbed note | `true` when prompt text was removed. | No | No | Not mapped. v1 never carries prompt text, so the flag has no meaning. |
| `promptHash`, `prompts[].promptHash` | Session note (since OR-48/A8) | Canonical v1 hash of the prompt `fullPrompt` stands for, and of each listed prompt, written with or without the prompt text and only when provably the text of the permissioned record (see [Runtime status](#runtime-status-the-origin-cli-writer)). Absent otherwise. | No | No (an identifier; low-entropy prompts can be guessed) | Not mapped from legacy notes: the legacy list is the session prefix. The writer puts the contributing iteration's hash in `session.iterations[].prompt_hash` itself. Notes written before OR-48 cannot be hashed faithfully: their stored text is redacted and truncated. |
| (prompt reference) | none | No current payload addresses a single prompt. | — | — | `session.iterations[].reference_uri`; no legacy source. |
| `originUrl` | Session note | `<apiUrl>/sessions/<sessionId>`; empty string when there is no session. | Yes | No (a pointer) | `session.reference_uri` when it passes the reference URI format. It is a session reference, never an iteration reference. The ACL behavior of this route is not verified by OR-7. |
| `conversation.url` | Agent Trace export | `origin://session/<id>` or `origin://unknown`. | Yes | No | Not mapped. Not a resolvable, permissioned URI. |
| `timestamp` | Session note, squash note | Time the note payload was built (`new Date().toISOString()`), not the commit time. | Yes | No | `recorded_at`. |
| `timestamp` | Agent Trace import note | Timestamp of the source trace record. | Yes | No | Not mapped. The converter sets its own `recorded_at`. |
| (session start/end) | Session state, `origin-sessions` metadata | `startedAt`/`endedAt` exist in session state and in the `origin-sessions` branch metadata, not in notes. | — | No | `session.started_at` (optional). No end time: `recorded_at` plus `duration_ms` cover it. |
| (commit timestamp) | VCS | Not in any payload. | — | No | Not duplicated; read it from the VCS. |
| `tokensUsed` | Session note | Session-cumulative input + output tokens, excluding cache. Stop and session-end pass the parser value, which starts at `0`, so `0` can mean "not measured". Post-commit omits it when not measured. | No | No | Not mapped. v1 has no total, and a legacy sum cannot be split into `input` and `output`. A new writer emits `input`/`output` (and `cache_read`/`cache_write` when measured) from the parser's separate counts. |
| (cache tokens) | none | No note payload records cache reads or writes. | — | No | `session.usage.tokens.cache_read`/`cache_write`. Never reconstructed for legacy notes. |
| `costUsd` | Session note | Session-cumulative cost estimated from the pricing table, rounded to 4 decimals. Stop and session-end can write `0` for "no estimate". | No | No | `session.usage.cost` with `currency: "USD"` and `basis: "estimated"`, amount as a decimal string. Legacy `0` is treated as absent. |
| `durationMs` | Session note | Wall-clock time from session start to note time. The stop hook writes `0` when the value is not positive. Older post-commit notes hardcoded `0`. Session-end does not guard an unparseable start time, so the value can serialize as `null`. | No | No | `session.duration_ms`. Legacy `0` and `null` are treated as absent. |
| `linesAdded`, `linesRemoved` | Session note | Post-commit notes: this commit's authored diff. Session-end and stop notes: the whole session's diff, written onto every session commit. The payload does not say which writer produced it. | Yes | No | Post-commit meaning → `revision.diff_stats`; session-end/stop meaning → `session.diff_stats`. Not mapped from legacy notes, because the payload does not say which one it is. |
| `totalLinesAdded`, `totalTokensUsed`, `totalCostUsd`, `totalDurationMs` | CI squash note written before OR-11 | Sums over the squashed commits' notes. An absent value is summed as `0`, and session-scoped values are summed once per commit, so they double-count. Squash aggregates written since OR-11 have none. | No | No | Not mapped. A converter should build contributions from the original per-commit notes, as OR-11's squash rebuild does. |
| `sessionIds[]`, `models[]` | Squash aggregate | Sets of sessions and models, with no pairing between them. | Yes | No | Not mapped faithfully (the agent/model/session pairing is lost). Since OR-11 the squash note carries a rebuilt record with the pairing. |
| `aiPercentage`, `humanPercentage`, `mixedPercentage` | Session note type | Declared and serialized when present, but no current writer passes them. Readers compute percentages on the fly from `git blame`, marking every line of a noted commit as AI. | No | No | Dropped. v1 makes no line-share claim. |
| `attribution.files[].aiLines`, `.humanLines` | Agent Trace import note | Line numbers from the trace's ranges (`mixed` folded into AI). No reader in the CLI or API uses them for display; the rename rewrite preserves them. | Yes | No | Not mapped from the note, because `mixed` is already folded into `aiLines`. Convert from the original Agent Trace record instead (see [Agent Trace](#relationship-to-agent-trace)). |
| (line blame) | `attribution.ts` `getLineBlame`, API blame fallback | Derived by readers: `git blame` maps each line to a commit, and a noted commit makes all of its lines "AI". This is a commit-level fact projected onto lines, not line-level attribution. | — | No | Not a v1 field, and never a source for `files`: a commit-level fact stays a commit-level contribution. |
| `filesChanged`, `snapshot`, `snapshotAt` | Session note type | Passed by post-commit but **not serialized** by `buildNotePayload`. `mcp/file-context.ts` reads `filesChanged`, which never arrives from this writer. | No | No | Not mapped. |
| `filesRead` | Session note | Files the agent read during the session (capped at 100). | No | Repository paths | Dropped. It serves Origin's context features, not attribution. |
| `previousSessionId` | Session note | Previous Origin session in the repository. | No | No | Dropped (Origin-internal chaining). |
| `prompts[].agent`, `prompts[].model` | Session note | Copies of the session-level agent and model. | No | No | Not mapped separately (duplicate of `agent`/`model`). |
| `prompts[].files` | Session note | Files a prompt edited. | No | Repository paths | Dropped. File names without ranges are not a v1 line claim. |
| `prompts[].timestamp` | Session note type | Declared, but no writer sets it. | No | No | Not mapped. |
| `prompts[].treeSha`, `prompts[].commitSha` | Session note | Working-tree SHA and HEAD at the prompt's stop, for Origin's soft restore. | No | No | Dropped (Origin-internal). Not rewrite identity. |
| `origin_rewrite` | Note envelope of a rewritten commit (since OR-11) | `{schema: "origin-rewrite/1", target, sources, base}`: the commit, the full shas of every old commit the note was rebuilt from, and whether the commit's own note sits underneath. Transport bookkeeping for the note writers, next to `origin` and `attribution_record`. | No | No | Not in v1: the record describes the new revision only. |
| `subagents[]` | Session note | Claude Code `Task` spawns: `type`, `promptIndex`, optional `files`. | No | Configuration names | Dropped. Part of the parent session. |
| `source`, `sourceVersion`, `sourceTool` | Agent Trace import note | Origin of the imported data: `agent-trace`, the trace version, the trace's tool name. | Yes | No | `evidence: "imported"`. The converter is the `producer`. The source details are not carried in v1. |
| `confidence`, `source` | Backfill note | Heuristic confidence (`high`/`medium`) and rule name. | Yes | No | `evidence: "inferred"`. Not carried further. |
| (unknown keys) | All shapes | Readers ignore unknown keys; writers added fields without bumping `version`. | — | — | Replaced by the explicit minor-version rules. |

### Converting a legacy session note to v1

Nothing in OR-7 implements this; the rules fix the semantics that a future
converter or writer must follow.

1. Skip the note if it has no `origin` object, if `origin.squashMerge` is `true`,
   or if `origin.source` is present (use the Agent Trace and backfill rules
   instead).
2. `schema_version: "1.0"`, `attribution_level: "commit"`,
   `revision: {vcs: "git", id: <annotated commit>}`, `producer` = the converter,
   `recorded_at` = `origin.timestamp` if it is a valid timestamp, otherwise the
   conversion time.
3. If `sessionId` is non-empty and not `unknown`, create one contribution with
   `evidence: "session_capture"` and `session.id = sessionId`. A
   `session_capture` contribution also needs `agent`, so if `agent` is missing,
   do not emit a record. Do not guess the agent.
4. `agent.id` = `origin.agent`. `model.id` = `origin.model` unless it is empty or
   `unknown`.
5. Do not map `promptCount` (it can miss prompts before a resume) and emit no
   `iterations` (the legacy list is the session prefix, not the contributing
   turns, and carries no hash or prompt reference).
6. `session.reference_uri` = `originUrl` if it passes the reference URI format.
7. `costUsd`, `durationMs`: map only values greater than `0`. Legacy writers used
   `0` (and, for `durationMs`, `null`) for "not measured". Do not map
   `tokensUsed` (see the inventory).
8. Do not map `linesAdded`/`linesRemoved`, because their scope is unknown, and
   never turn them into `files`. Drop every field the inventory marks as
   dropped. Prompt text never crosses over.
9. Run the full validation path, and discard the result if it fails.

## Reading records: `origin export`

`origin export --format=json <range>` (OR-12/A6) is the supported way to read
the records of a Git commit range. A consumer should use it rather than read
`refs/notes/origin`, whose envelope and location are Origin's to change. The
full command contract is in `docs/CLI.md` of the Origin monorepo ("Attribution
records of a range"); in terms of this contract:

- The output is a JSON array whose elements are v1 records, not note
  envelopes: no `origin`, `origin_rewrite` or other transport keys.
- Every record goes through `readRecord`. An exact 1.0 record is emitted as
  is; a newer 1.x record is emitted as its **1.0 projection**. An unsupported
  major, an invalid record, and a record whose `revision` is not `git` with the
  id of the commit it is stored for are not used, as the
  [reader rules](#versioning-and-compatibility) require: each is reported as a
  skipped commit on stderr and does not make the valid records of other
  commits unavailable. `--strict` turns any of them into a failure of the whole
  export. A reader of the output therefore only ever sees
  `schema_version: "1.0"` from this CLI version.
- Commits without a record (no note, or a legacy-only note) are left out. The
  export never builds a record from a legacy payload.
- Records are ordered oldest first in Git topological order.
- `origin export` without a range is the unrelated session-summary export.

The command reads the local clone only; the notes must already be there (see
[Runtime status](#runtime-status-the-origin-cli-writer) for how they travel).

## Validating a record

The full validation path of a 1.0 record has two layers. A record is valid only
if it passes both:

1. **JSON Schema.** `attribution-record.schema.json`, with a JSON Schema 2020-12
   validator that enforces the `date-time`, `uri` and `email` formats.
2. **Semantic rules** that JSON Schema cannot express. v1.0 has exactly six,
   and all apply to the whole record:
   - **S1 — unique iteration identity.** Collect every iteration of every
     contribution as the pair (`contributions[i].session.id`,
     `iterations[j].index`). No pair occurs twice in the record, whichever
     contributions the two entries sit in and whatever their other fields
     (`prompt_hash`, `reference_uri`) say. Iterations of different sessions
     may share an index.
   - **S2 — one contribution per session.** No two contributions of a record
     have the same `session.id`, even when their iteration indexes do not
     overlap. Contributions without `session` are not affected.
   - **S3 — prompt link matches its iteration.** If an iteration's
     `reference_uri` ends with `?prompt=N`, then `N` equals that iteration's
     `index`. Error path: the `reference_uri`.
   - **S4 — ordered line range.** Every range has `start_line <= end_line`.
     Error path: the range.
   - **S5 — line range names a listed iteration.** If a range has
     `iteration_index`, the same contribution's `session.iterations` contains an
     entry with that `index`. An iteration of another contribution does not
     count. Error path: the range's `iteration_index`.
   - **S6 — iteration index below `prompt_count`.** If a contribution's
     `session.prompt_count` is present, every entry of that session's
     `iterations` has `index < prompt_count`. If `prompt_count` is absent, S6
     checks nothing (and no count is inferred from the indexes). Error path:
     the offending iteration's `index`.

   S1 is keyed by session id, so it holds on its own; with S2 in force it
   reduces to "no repeated index inside a session's `iterations`".

The rules on `attribution_level` versus `files` are not semantic rules: the
schema enforces them (`not`/`contains`).

A stock JSON Schema validator alone therefore does not fully validate a record.
Both the exact path and the projection path of the
[reader algorithm](#versioning-and-compatibility) end with this full two-layer
validation, so S1–S6 also apply to the 1.0 projection of a newer minor.

**Reference implementation.** `packages/cli/src/attribution-record.ts` exports:

| Export | What it does |
| --- | --- |
| `ATTRIBUTION_RECORD_SCHEMA_VERSION` | `"1.0"`. |
| `ATTRIBUTION_RECORD_SCHEMA_PATH`, `attributionRecordSchema()` | Location of the schema file (resolved next to the package in both `src/` and the built `dist/`) and a parsed copy of it. |
| `validateSchema(record)` | Layer 1 only: Ajv errors, empty when the schema passes. |
| `semanticErrors(record)` | Layer 2 only: `{rule, instancePath, message}` for S1–S6. Expects a schema-valid record. |
| `validateFull(record)` | Both layers for a record that claims exactly 1.0. |
| `readRecord(input)` | The reader algorithm: `exact`, `projected` (with the transformed copy), `unsupported` or `invalid`. |
| `canonicalPromptHash(text)` | The [prompt hash](#prompt-hash). |

The CLI note writer (OR-9/A3) and the range export (OR-12/A6, below) use it.

With Ajv (JavaScript), layer 1:

```js
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const schema = JSON.parse(fs.readFileSync("attribution-record.schema.json", "utf8"));

// Writer and same-version reader: strict. strictRequired is an Ajv-only lint
// that rejects the standard `anyOf: [{ "required": [...] }]` idiom used here.
const strict = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
addFormats(strict);
const validate = strict.compile(schema);

// Only for the 1.0 projection of a newer 1.x record (Readers, step 4):
// drops undeclared properties, then validates.
const projecting = new Ajv2020({ strict: true, strictRequired: false, allErrors: true, removeAdditional: true });
addFormats(projecting);
const validateProjection = projecting.compile(schema);
```

`removeAdditional` modifies the object it validates; always pass the projection
copy, never the original record.

## Open questions

These were not decided in OR-7, because the available data does not settle them
safely:

1. **Acting user source and policy.** No current writer captures the acting
   human. `actor` is defined as optional. Which identifier Origin emits, and
   whether `email` is ever allowed in records that travel with the repository,
   needs a product and security decision.
2. **Prompt hash defaults and redaction order.** Settled by OR-48/A8 for the
   Origin CLI: hashes are emitted by default, but only for prompts the writer
   can prove are the served text, which secret redaction leaves unchanged — so
   the redaction order cannot make a hash disagree with its record. A
   server-computed hash covering every prompt would need an API change and is
   not part of this contract version.
3. **`reference_uri` ACL.** The current `originUrl` points at
   `<apiUrl>/sessions/<id>`. Whether that route enforces the ACL this contract
   requires, and whether it should be the web or the API host, was not verified.
4. **Where the canonical schema lives and who owns compatibility.** This
   repository path is the working answer. A public URL and `$id` can be added
   once a route actually serves the file.
5. **Transport embedding.** Settled by OR-9/A3: the record sits next to the
   legacy payload under `attribution_record` (see
   [Runtime status](#runtime-status-the-origin-cli-writer)). Since OR-48/A8 the
   legacy payload carries prompt text only with the explicit
   `notesIncludePrompts: true` opt-in.
6. **Token semantics per agent.** Whether each supported agent's `input` really
   excludes cache tokens and how it counts reasoning tokens is confirmed by
   OR-23.
7. **Agent Trace upstream.** If a current Agent Trace specification gains
   first-class fields for these needs, the decision above should be revisited
   against that specification.
