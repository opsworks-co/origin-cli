import { CodeBlock, H2, H3, P, Li, Step, Callout } from '../shared/Markdown';

export default function PoliciesSection() {
  return (
    <>
          <div>
            <h1 id="policies" className="text-2xl font-bold mb-2">Policies</h1>
            <P>
              Policies are governance rules that control what AI agents can and cannot do.
              They are enforced at two levels: <strong className="text-gray-200">server-side</strong> (at session start and end) and
              <strong className="text-gray-200"> client-side</strong> (via the MCP server during sessions).
              All violations are logged to the audit trail and can trigger notifications.
            </P>

            {/* Policies Mockup */}
            <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden my-6">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/80">
                <div className="w-3 h-3 rounded-full bg-red-500/80" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                <div className="w-3 h-3 rounded-full bg-green-500/80" />
                <span className="text-xs text-gray-500 ml-2 font-mono">Policies</span>
              </div>
              <div className="p-4 space-y-2">
                {[
                  { name: 'No sensitive files', type: 'FILE_RESTRICTION', rules: 4, active: true },
                  { name: 'Require review for large changes', type: 'REQUIRE_REVIEW', rules: 2, active: true },
                  { name: 'Model allowlist', type: 'MODEL_ALLOWLIST', rules: 3, active: true },
                  { name: 'Cost limit per session', type: 'COST_LIMIT', rules: 1, active: false },
                ].map((p, i) => (
                  <div key={i} className="flex items-center gap-3 bg-gray-800/40 border border-gray-700/50 rounded-lg px-4 py-3">
                    <div className={`w-8 h-4 rounded-full relative ${p.active ? 'bg-green-600' : 'bg-gray-600'}`}>
                      <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${p.active ? 'right-0.5' : 'left-0.5'}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-gray-200 font-medium">{p.name}</div>
                      <div className="text-[10px] text-gray-500">{p.type}</div>
                    </div>
                    <div className="text-[10px] text-gray-500">{p.rules} rules</div>
                    {p.active && <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />}
                  </div>
                ))}
                <div className="flex justify-center pt-2">
                  <div className="px-3 py-1.5 border border-dashed border-gray-600 rounded-lg text-xs text-gray-500 cursor-pointer hover:border-indigo-500 hover:text-indigo-400">+ Add Policy</div>
                </div>
              </div>
            </div>

            <Callout type="info">
              Policies are only enforced when <strong className="text-gray-200">Active</strong>.
              Toggle a policy on/off from the Policies page. Only active policies are loaded by the MCP server.
            </Callout>

            <H2>How Enforcement Works</H2>
            <P>Policies are enforced at multiple points:</P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Session start (server)</strong> &mdash; MODEL_ALLOWLIST policies are checked. If the model is not allowed and action is &ldquo;block&rdquo;, the session is rejected with HTTP 403. Active enforcement rules are sent to the CLI for client-side enforcement.</Li>
              <Li><strong className="text-gray-200">During session (CLI hooks)</strong> &mdash; FILE_RESTRICTION policies are enforced in real-time via the <code className="text-indigo-400">pre-tool-use</code> hook. When an agent tries to read, edit, or execute a command involving a restricted file, the CLI blocks the tool call before it executes. This works with all supported agents (Claude Code, Gemini CLI, Cursor).</Li>
              <Li><strong className="text-gray-200">During session (MCP server)</strong> &mdash; FILE_RESTRICTION policies are also checked when the agent calls <code className="text-indigo-400">check_file_access</code> via the MCP server.</Li>
              <Li><strong className="text-gray-200">Session end (server)</strong> &mdash; REQUIRE_REVIEW, COST_LIMIT, and FILE_RESTRICTION policies are evaluated against the session&apos;s final data. Violations auto-flag the session for review and notify admins.</Li>
            </ul>

            <H2>Quick Start: Create Your First Policy</H2>

            <Step n={1} title="Go to Policies page">
              <p>Navigate to <strong className="text-gray-200">Policies</strong> in the sidebar and click <strong className="text-gray-200">Add Policy</strong>.</p>
            </Step>
            <Step n={2} title="Choose a type and name">
              <p>Give it a name (e.g. &ldquo;No sensitive files&rdquo;) and select the type (e.g. FILE_RESTRICTION). The description below the type selector explains what each type does.</p>
            </Step>
            <Step n={3} title="Add rules with conditions">
              <p>Expand the policy and click <strong className="text-gray-200">Add Rule</strong>. Enter a JSON condition, choose an action, and set severity. Click the example conditions to auto-fill common patterns. Optionally scope the rule to a specific agent, machine, or repo using the scope dropdowns.</p>
            </Step>
            <Step n={4} title="Ensure the policy is active">
              <p>The toggle on the right activates/deactivates the policy. Active policies show a green pulse indicator.</p>
            </Step>

            <H2 id="policy-types">Policy Types</H2>

            <H3>FILE_RESTRICTION</H3>
            <P>
              Block or flag access to specific file patterns. Use glob patterns for matching.
              Enforced both client-side (MCP check_file_access) and server-side (at session end).
            </P>
            <CodeBlock title="Condition format: JSON with 'path' field (glob pattern)">{`{"path": "**/.env"}         — All .env files anywhere
{"path": "**/.env*"}        — .env, .env.local, .env.production
{"path": "src/auth/**"}     — All files in auth directory
{"path": "**/*.key"}        — All .key files
{"path": "**/secrets/**"}   — Anything in a secrets directory
{"path": "**/*.pem"}        — All certificate files`}</CodeBlock>

            <H3>REQUIRE_REVIEW</H3>
            <P>
              Auto-flag sessions for human review when conditions are met.
              Evaluated at session end against the session&apos;s actual data.
            </P>
            <CodeBlock title="Condition format: JSON with threshold fields">{`{"cost_above": 1.0}             — Flag if session cost > $1.00
{"tokens_above": 50000}         — Flag if tokens > 50k
{"files_above": 10}             — Flag if > 10 files changed
{"max_lines": 500}              — Flag if > 500 lines added
{"max_duration_minutes": 30}    — Flag if session > 30 minutes
{"path": "**/*.sql"}            — Flag if SQL files modified`}</CodeBlock>

            <H3>MODEL_ALLOWLIST</H3>
            <P>
              Restrict which AI models can be used. Checked server-side at session start.
              If the model is not in the allowed list and action is &ldquo;block&rdquo;,
              the session is rejected immediately.
            </P>
            <CodeBlock title="Condition format: JSON with 'models' array">{`{"models": ["claude-sonnet-4-20250514"]}
  — Only allow Claude Sonnet

{"models": ["claude-sonnet-4-20250514", "gpt-4o"]}
  — Allow Sonnet or GPT-4o

{"models": ["claude-sonnet-4-20250514", "claude-opus-4-20250514", "gpt-4o"]}
  — Allow multiple specific models`}</CodeBlock>

            <H3>COST_LIMIT</H3>
            <P>
              Set per-session cost or token limits. Evaluated at session end.
              Violations are logged and can flag the session for review.
            </P>
            <CodeBlock title="Condition format: JSON with limit fields">{`{"max_cost": 5.0}       — Limit $5 per session
{"max_tokens": 100000}  — Limit 100k tokens per session`}</CodeBlock>

            <Callout type="tip">
              For organization-wide monthly spending limits, use the <strong className="text-gray-200">Budget</strong> feature
              in Settings instead. COST_LIMIT policies are for per-session thresholds.
            </Callout>

            <H2>Rule Actions</H2>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-red-400">block</strong> &mdash; Prevent the action entirely. For MODEL_ALLOWLIST, the session is rejected (HTTP 403). For FILE_RESTRICTION, the MCP server returns <code className="text-indigo-400">allowed: false</code>.</Li>
              <Li><strong className="text-amber-400">warn</strong> &mdash; Allow but log the violation to the audit trail and flag the session for review.</Li>
              <Li><strong className="text-blue-400">require_review</strong> &mdash; Allow but auto-create a &ldquo;FLAGGED&rdquo; review on the session with a note explaining which policy triggered it.</Li>
              <Li><strong className="text-purple-400">notify</strong> &mdash; Allow and send a notification to all org admins about the violation.</Li>
            </ul>

            <H2>Rule Severity</H2>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-red-400">HIGH</strong> &mdash; Critical rule. HIGH severity violations always trigger admin notifications.</Li>
              <Li><strong className="text-amber-400">MEDIUM</strong> &mdash; Important but not critical. Logged in audit trail.</Li>
              <Li><strong className="text-green-400">LOW</strong> &mdash; Advisory, for tracking purposes.</Li>
            </ul>

            <H2>What Happens When a Policy Is Violated</H2>
            <P>When the policy engine detects a violation at session end:</P>
            <ul className="space-y-2 mb-4">
              <Li>A <code className="text-indigo-400">POLICY_VIOLATION</code> entry is created in the audit log with full details</Li>
              <Li>If the action is <code className="text-indigo-400">require_review</code> (or policy type is REQUIRE_REVIEW), a &ldquo;FLAGGED&rdquo; review is auto-created on the session</Li>
              <Li>The auto-review includes a note listing which policies triggered and why</Li>
              <Li>For HIGH severity violations, all org admins receive a notification with a link to the session</Li>
            </ul>

            <H2>Scoped Rules</H2>
            <P>
              By default, policy rules apply to all sessions across your entire organization.
              You can narrow the scope of any rule by assigning it to a specific <strong>agent</strong>,
              <strong> machine</strong>, or <strong>repo</strong> using the scope dropdowns when
              adding a rule.
            </P>
            <ul className="space-y-2 mb-4">
              <Li><strong>Agent scope</strong> &mdash; Rule only applies to sessions from a specific AI agent (e.g. &ldquo;Claude Code&rdquo;, &ldquo;Cursor Agent&rdquo;)</Li>
              <Li><strong>Machine scope</strong> &mdash; Rule only applies to sessions from a specific registered machine (e.g. &ldquo;ci-runner-01&rdquo;, &ldquo;artem-mbp&rdquo;)</Li>
              <Li><strong>Repo scope</strong> &mdash; Rule only applies to sessions in a specific repository (e.g. &ldquo;origin&rdquo;, &ldquo;frontend-app&rdquo;)</Li>
              <Li><strong>No scope</strong> &mdash; Rule applies to all sessions (org-wide)</Li>
              <Li><strong>Multiple scopes</strong> &mdash; If a rule has both a machine and repo scope, <em>both must match</em> for the rule to apply (AND logic)</Li>
            </ul>

            <CodeBlock title="Scoped rule examples">{`# Block GPT-4 on CI machines
Policy: MODEL_ALLOWLIST
Rule: {"models": ["claude-sonnet-4-20250514"]} → block, HIGH
Scope: Machine → ci-runner-01

# Require review for production repo
Policy: REQUIRE_REVIEW
Rule: {"cost_above": 0.50} → require_review, MEDIUM
Scope: Repo → production-api

# Cost limit for Cursor agent only
Policy: COST_LIMIT
Rule: {"max_cost": 10.0} → warn, MEDIUM
Scope: Agent → Cursor Agent`}</CodeBlock>

            <H2>Policy Versioning</H2>
            <P>
              Every change to a policy (creation, update, rule added/removed, activation/deactivation)
              is versioned. You can see the version history in the policy detail view. This provides
              a full audit trail of governance changes.
            </P>

            <H2>Example: Setting Up Common Policies</H2>
            <P>Here&apos;s a recommended starter set of policies:</P>

            <CodeBlock title="1. Protect sensitive files (FILE_RESTRICTION)">{`Name: "No sensitive files"
Type: FILE_RESTRICTION
Rule 1: {"path": "**/.env*"}    → block, HIGH
Rule 2: {"path": "**/*.key"}    → block, HIGH
Rule 3: {"path": "**/*.pem"}    → block, HIGH`}</CodeBlock>

            <CodeBlock title="2. Review expensive sessions (REQUIRE_REVIEW)">{`Name: "Review expensive sessions"
Type: REQUIRE_REVIEW
Rule 1: {"cost_above": 2.0}         → require_review, MEDIUM
Rule 2: {"files_above": 15}         → require_review, MEDIUM
Rule 3: {"max_lines": 1000}         → require_review, HIGH`}</CodeBlock>

            <CodeBlock title="3. Allowed models only (MODEL_ALLOWLIST)">{`Name: "Approved models"
Type: MODEL_ALLOWLIST
Rule 1: {"models": ["claude-sonnet-4-20250514", "gpt-4o"]}
        → block, HIGH`}</CodeBlock>
          </div>
    </>
  );
}
