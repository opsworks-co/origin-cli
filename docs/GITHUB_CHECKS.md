# How GitHub PR Checks Work in Origin

Origin adds an `origin/ai-governance` status check to every pull request in your connected repositories. This check tells you whether AI-authored code meets your organization's policies before it can be merged.

---

## How it works

1. A developer pushes commits to a branch and opens (or updates) a PR
2. GitHub sends a webhook to Origin
3. Origin matches commit SHAs against tracked AI coding sessions
4. The policy engine evaluates all active policies against the linked sessions
5. Origin posts a status check and a summary comment on the PR

---

## Check behavior by scenario

### No policies configured → check passes (informational only)

If your organization has no active policies, the PR check always passes with a green checkmark. Origin still posts a comment showing the number of AI sessions detected, which agent was used, cost, and files changed — but nothing blocks the merge.

This is **informational mode**. It's the default when you first connect GitHub, and it's useful for getting visibility into AI usage before enforcing rules.

```
✅ origin/ai-governance — 2 sessions detected · No active policies
```

### REQUIRE_REVIEW policy → PR blocks until approved

The `REQUIRE_REVIEW` policy requires a human to review and approve each AI coding session before the PR can merge.

**How it works:**
- PR check is set to **pending** until all linked sessions are reviewed
- A reviewer (tech lead, CTO, or anyone with review permissions) opens the session in Origin's dashboard
- They inspect the prompts, diffs, and cost, then click **Approve** or **Reject**
- Once all sessions are approved, the check automatically updates to **success**
- If any session is rejected, the check moves to **failure** with the rejection reason

```
⏳ origin/ai-governance — 1 session pending review · Waiting for approval
```

After approval:
```
✅ origin/ai-governance — All 1 sessions approved
```

### COST_LIMIT policy → PR blocks if session exceeded limit

The `COST_LIMIT` policy sets a maximum allowed cost per AI session. If any session linked to the PR exceeds the threshold, the check fails immediately.

```
❌ origin/ai-governance — Session cost $14.20 exceeds limit $10.00
```

The developer can:
- Split their work into smaller, cheaper sessions
- Request a policy exception from an admin
- Have the cost limit increased if the work justified it

### 0 sessions detected → passes by default

When Origin can't match any commits in the PR to a tracked AI coding session, it assumes the code is human-authored. The check passes automatically.

```
✅ origin/ai-governance — 0 sessions detected
```

This covers:
- PRs written entirely by hand without AI assistance
- AI-authored code where the developer didn't have Origin CLI running (sessions weren't tracked)

> **Note:** Origin identifies AI sessions by matching commit SHAs. If someone uses an AI tool without Origin's CLI tracking the session, those commits appear as human-authored.

### Other policy types

- **FILE_RESTRICTION** — fails if AI modified protected files (e.g., `src/payments/**`)
- **MODEL_ALLOWLIST** — fails if an unapproved AI model was used
- **CONTENT_FILTER** — fails if banned patterns appear in the diff
- **COMMIT_MESSAGE** — fails if commit messages don't match the required format

---

## Agent-scoped vs. organization-wide policies

Policies can be applied at two levels:

### Agent-scoped
Applies only to sessions from a specific agent. For example, you might require review only for a junior developer's Cursor agent but not for a senior's Claude Code sessions.

Create an agent-scoped policy by selecting a specific agent when creating the policy in **Policies > New Policy**.

### Organization-wide
Applies to all sessions across all agents. Use this when you want a blanket rule — e.g., every AI-authored PR must be reviewed regardless of who wrote it or which agent was used.

Create an org-wide policy by leaving the agent field set to **All agents**.

### Conflict resolution
When both an agent-scoped and an org-wide policy apply to the same session, the **stricter policy wins**. If the org-wide policy says "pass" but an agent-scoped policy says "block," the PR is blocked.

---

## Setup: How to enable PR checks

### Step 1: Install the Origin GitHub App

Go to **Settings > Integrations** in Origin and click **Install GitHub App**. This gives Origin permission to:
- Receive webhooks for push and pull_request events
- Post status checks on PRs
- Post summary comments on PRs

### Step 2: Import repositories

Go to **Repositories** and click **Import from GitHub**. Select the repos you want to monitor. Origin only posts checks on PRs in imported repos.

### Step 3: Create a policy (optional)

Go to **Policies > Add Policy** and choose a policy type:

| Policy | What it does |
|--------|-------------|
| `REQUIRE_REVIEW` | Block PRs until sessions are approved in Origin |
| `COST_LIMIT` | Block PRs if session cost exceeds a threshold |
| `FILE_RESTRICTION` | Block PRs if AI modified protected files |
| `MODEL_ALLOWLIST` | Block PRs if an unapproved model was used |
| `CONTENT_FILTER` | Block PRs if banned patterns appear in the diff |
| `COMMIT_MESSAGE` | Block PRs if commit messages don't match format |

Without any policies, checks pass automatically in informational mode.

### Step 4: Enable branch protection (recommended)

In your GitHub repository:
1. Go to **Settings > Branches > Branch protection rules**
2. Add (or edit) a rule for your main branch
3. Enable **"Require status checks to pass before merging"**
4. Search for `origin/ai-governance` and add it as a required check

Now PRs cannot be merged until Origin's check passes.

---

## What the PR comment looks like

Origin posts (or updates) a single comment on each PR with:

- **Session count** and aggregate summary (e.g., "3 sessions · 47 agent turns · 2 human corrections")
- **Per-session table** with: session ID, agent name, model, cost, tokens, review status
- **Policy violations** section (if any) with specific details and fix hints
- **Links** to view each session in the Origin dashboard

Human corrections are commits in the PR that aren't linked to any AI session — assumed to be manual fixes or additions.

---

## Decision tree

```
PR pushed → Origin receives webhook
  │
  ├─ Match commits to sessions by SHA
  │
  ├─ 0 sessions found?           → ✅ Pass (human code assumed)
  ├─ Sessions found, no policies? → ✅ Pass (informational only)
  ├─ REQUIRE_REVIEW active?       → ⏳ Pending until reviewer approves
  ├─ COST_LIMIT exceeded?         → ❌ Fail with cost details
  ├─ Other policy violated?       → ❌ Fail with violation details
  └─ All policies pass?           → ✅ Pass
```

---

## FAQ

**Q: Do I need policies for the check to appear?**
No. The check appears on every PR in imported repos regardless of policies. Without policies, it always passes.

**Q: What if Origin is down?**
If Origin can't be reached, no check is posted. GitHub treats a missing check as "no status" — it won't block the PR unless you've configured branch protection to require the check.

**Q: Can I re-run a check?**
Yes. Go to **Pull Requests** in Origin, find the PR, and click **Re-check**. Or use the CLI: `origin review-pr <pr-url>`.

**Q: Does it work with GitLab?**
Yes. Origin supports GitLab MR checks with the same policy engine. See the GitLab Integration docs for setup.
