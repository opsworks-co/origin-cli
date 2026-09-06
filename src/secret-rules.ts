/**
 * Shared secret-scanner heuristics.
 *
 * THIS FILE IS THE CANONICAL COPY. `apps/api/src/services/secret-rules.ts` is
 * generated from it by `scripts/sync-shared-modules.mjs`, and a test in apps/api
 * fails if the two drift. Edit here, then run `pnpm sync:shared-modules`.
 *
 * Why a copy rather than a shared package: the CLI ships as an `npm pack`
 * tarball that users install with npm, so a `workspace:*` dependency would be
 * unresolvable for them — and the one existing shared package (`@origin/types`)
 * is source-only, which is why only the bundled web app consumes it. Making
 * this shareable for real would mean bundling the CLI or publishing an
 * intermediate package, i.e. rebuilding a signed, reproducible release path to
 * de-duplicate sixty lines. The generated copy plus a drift test buys the part
 * that matters — one place to edit, and CI failing when they diverge.
 *
 * Deliberately dependency-free. Anything imported here would have to exist in
 * both the CLI tarball and the API image.
 */

/**
 * Paths whose contents are not the author's code.
 *
 * Minified bundles, build output and vendored dependencies trip secret patterns
 * constantly on library internals — one vendored bundle in a diff can bury
 * every real finding under hundreds of fake ones.
 *
 * Matching is substring-based, which is why the entries carry their slashes:
 * `/dist/` must not match `src/distribution/keys.ts`.
 */
export const SCAN_SKIP_PATHS: readonly string[] = [
  '/dist/', '/build/', '/public/', '/web-dist/',
  '.min.js', '.min.css', '.bundle.js', '.chunk.js',
  'node_modules/', 'vendor/', '.tgz',
];

/** True when `filePath` is build output or vendored code. */
export function isSkippedScanPath(filePath: string): boolean {
  return SCAN_SKIP_PATHS.some((p) => (filePath || '').includes(p));
}

/**
 * Is this assignment's value plainly not a secret?
 *
 * Applies ONLY to rules that key off the NAME being assigned (`*_KEY=`,
 * `secret:`, …). Those match any value of sufficient length, so they fire on
 * ordinary constants — and in the pre-commit scanner that BLOCKS the commit. A
 * blocker that cries wolf gets bypassed with --no-verify, and a scanner people
 * routinely bypass detects nothing, so a false positive costs more than a
 * narrower rule does.
 *
 * Never applied to vendor patterns (AKIA…, ghp_…, sk-ant-…): those match the
 * SHAPE of a real credential and need no help.
 *
 * Conservative by construction — every branch describes a value a generated
 * credential cannot have. Anything else returns false and the finding stands.
 *
 * `isPasswordRule` exempts the word-shape check: a diceware passphrase
 * (`correct-horse-battery-staple`) has exactly that shape and IS a credential.
 * Passed as a flag rather than a rule name because the two scanners spell their
 * password rule differently.
 */
export function isNonSecretAssignmentValue(value: string, isPasswordRule = false): boolean {
  const v = (value || '').trim().replace(/^['"]|['"]$/g, '');
  if (!v) return true;

  // 1. A REFERENCE rather than a literal. Reading a secret from the environment
  //    is the CORRECT pattern; flagging it teaches people to ignore the
  //    scanner. `process.env.FOO` matched because `.` is in the rules'
  //    character class.
  if (/^(?:process\.env|import\.meta\.env|Deno\.env|globalThis|window|self)\b/.test(v)) return true;
  if (/^env(?:ironment)?\./.test(v)) return true;
  if (/^\$\{/.test(v) || /^\$[A-Za-z_]/.test(v)) return true;
  if (/^[A-Za-z_$][\w$]*\s*\(/.test(v)) return true;

  // 2. Placeholders written on purpose.
  if (/^(?:x{3,}|\*{3,}|\.{3,}|changeme|change_me|placeholder|redacted|example|dummy|sample|none|null|undefined|todo|tbd|not[-_]?configured|not[-_]?set)$/i.test(v)) return true;
  if (/^<.*>$/.test(v)) return true;
  if (/^your[-_]/i.test(v)) return true;
  if (/[-_](?:here|goes[-_]here)$/i.test(v)) return true;

  // 3. Kebab/snake-cased WORDS — `model-pricing`, `user_profile_cache`. A
  //    generated credential is high-entropy base62/hex, not lowercase words
  //    joined by - or _. A separator is REQUIRED, so an opaque single run like
  //    `supersecret` is still a finding.
  if (!isPasswordRule && /^[a-z]+(?:[-_][a-z]+)+$/.test(v)) return true;

  return false;
}

/**
 * Is this email address nobody's personal data?
 *
 *   - RFC 2606 / 6761 RESERVED names — example.com/.net/.org and the .test,
 *     .example, .invalid, .localhost TLDs exist precisely so documentation and
 *     fixtures have addresses that can never reach a person.
 *   - ROLE addresses that are deliberately unattributed — noreply@ and friends.
 *     This repo writes `noreply@anthropic.com` into every commit trailer, so a
 *     diff touching commit tooling reported PII on its own boilerplate.
 *
 * Deliberately narrow: a real support@ or hello@ at a real domain is still
 * reported. It may not be a named individual, but it is a live address, and
 * that is the reviewer's judgement rather than this function's.
 *
 * The domain checks are ANCHORED — `example.com.evil.io` is not reserved.
 */
/**
 * Is this path a test, fixture or mock — a place where an email address is a
 * stand-in identity rather than a person's data?
 *
 * Every git-backed test in this repo sets `user.email = 't@t.co'` so that
 * `git commit` works in a throwaway repo; two dozen files carry the line. The
 * PII_EMAIL rule reported each one as "Hardcoded Email", and a session that
 * added one more such test opened its Security tab to fixture identities.
 * `isNonPersonalEmail` cannot help: `t.co` is a real TLD, and fixtures use
 * whatever is shortest.
 *
 * Scoped to PII_EMAIL only by the caller. A credential in a test file is still
 * a credential — this exempts addresses, not secrets.
 */
export function isTestFixturePath(filePath: string): boolean {
  const p = (filePath || '').replace(/\\/g, '/').toLowerCase();
  if (!p) return false;
  if (/(?:^|\/)(?:__tests__|__fixtures__|__mocks__|__snapshots__|fixtures|test|tests|spec|specs|testdata)\//.test(p)) return true;
  return /\.(?:test|spec|fixture|fixtures|mock|mocks|stories)\.[a-z0-9]+$/.test(p);
}

export function isNonPersonalEmail(value: string): boolean {
  const v = (value || '').trim().replace(/^['"]|['"]$/g, '').toLowerCase();
  const at = v.lastIndexOf('@');
  if (at <= 0) return false;
  const local = v.slice(0, at);
  const domain = v.slice(at + 1);

  if (/^(?:.+\.)?example\.(?:com|net|org)$/.test(domain)) return true;
  if (/\.(?:test|example|invalid|localhost|local)$/.test(domain)) return true;
  if (/^(?:no-?reply|donot-?reply|do-not-reply)$/.test(local)) return true;

  return false;
}
