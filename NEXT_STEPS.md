# Origin v2 — Next Steps

## What's Built & Deployed

Everything below is live at **https://origin-platform.fly.dev**

### Core Platform
- [x] Session tracking (start/update/end via CLI hooks + MCP)
- [x] Policy engine (MODEL_ALLOWLIST, FILE_RESTRICTION, REQUIRE_REVIEW, COST_LIMIT)
- [x] GitHub integration (webhooks, status checks, PR comments)
- [x] **PR blocking** — policy violations fail GitHub status checks, blocking merges
- [x] PR Checks dashboard page
- [x] Per-member API keys (sessions attributed to individual developers)
- [x] Team invitations (create invite links, accept, join org)
- [x] AI auto-review (Claude-powered session analysis)
- [x] Secret/PII scanning
- [x] Budget controls (monthly limits, alerts)
- [x] Real-time session streaming (SSE)
- [x] CLI (24 commands) + MCP server (16 tools)
- [x] Repo archiving (soft delete)
- [x] Org settings (editable name, slug)

---

## Your Immediate Next Steps

### 1. Test PR Blocking End-to-End

This is the most impactful feature to demo. Here's exactly what to do:

```bash
# a) Create a test policy that will trigger easily
#    Go to https://origin-platform.fly.dev/policies
#    Create a COST_LIMIT policy with max_cost: 0.01
#    (any session will exceed $0.01)

# b) Pick a GitHub repo you've imported into Origin
#    Make sure it has webhooks set up (check Repos page)

# c) Create a branch and make some AI-assisted changes
git checkout -b test/pr-blocking
# ... use Claude Code to make changes ...
git push -u origin test/pr-blocking

# d) Open a PR on GitHub
#    → Origin webhook fires → status check posted

# e) End your Claude Code session
#    → Policy engine runs → session flagged → PR check fails ❌

# f) Go to GitHub — see the failing "origin/ai-governance" check
#    The PR cannot be merged!

# g) Go to Origin → Sessions → find the session → click Approve
#    → PR check updates to ✅ → merge unblocked
```

### 2. Enable Branch Protection on Your Repos

For each repo you want to enforce:

1. GitHub repo → Settings → Branches → Add rule
2. Branch name pattern: `main`
3. Check "Require status checks to pass before merging"
4. Search `origin/ai-governance`, add it
5. Save

### 3. Invite Your Team

1. Go to https://origin-platform.fly.dev/settings?tab=team
2. Enter team member's email → select role → "Send Invite"
3. Share the invite link
4. They create an account and get their own API key
5. Their sessions are now attributed to them personally

### 4. Install CLI on Team Machines

Each developer needs:

```bash
curl -fsSL https://origin-platform.fly.dev/install.sh | sh
origin login
origin init
origin enable   # install hooks in their repo
```

Then they just code normally — sessions are captured automatically.

---

## What to Build Next (Priority Order)

### High Priority — Product Differentiators

#### 1. GitHub App (replace PAT with proper App)
**Why:** One-click install instead of manual PAT setup. Shows "Origin" identity on checks instead of the user's avatar. Better permission model.

**What to build:**
- Register a GitHub App on github.com/settings/apps
- OAuth installation flow (user clicks "Install" → authorizes repos)
- App receives webhooks automatically (no manual webhook creation)
- Use installation access tokens instead of PATs
- Auto-configure branch protection via API

**Effort:** 2-3 days

#### 2. Slack/Teams Notifications
**Why:** Admins need to know about violations in real-time, not by checking a dashboard.

**What to build:**
- Slack webhook integration in Settings
- Notify on: policy violations, sessions needing review, budget alerts
- Optional: Slack bot with `/origin approve <session-id>` command

**Effort:** 1 day

#### 3. CLI Hooks for More Tools
**Why:** Currently hooks work best with Claude Code. Need Cursor, Copilot, Aider support.

**What to build:**
- Cursor: `.cursor/hooks/` integration
- Copilot: VS Code extension or git hooks
- Aider: `--post-commit-hook` flag integration
- Generic: `git post-commit` hook that detects any AI tool

**Effort:** 2-3 days per tool

### Medium Priority — Enterprise Features

#### 4. SSO / SAML Authentication
**Why:** Enterprise customers need SSO. Nobody wants another password.

**What to build:**
- SAML 2.0 IdP integration (Okta, Azure AD, Google Workspace)
- Auto-provisioning users from IdP groups
- Replace email/password login with SSO redirect

**Effort:** 3-5 days

#### 5. Compliance Reports (PDF Export)
**Why:** CISOs need periodic reports for board meetings and audits.

**What to build:**
- Weekly/monthly automated reports
- AI authorship %, policy compliance rate, cost trends
- PDF generation (use puppeteer or react-pdf)
- Email delivery on schedule

**Effort:** 2-3 days

#### 6. Multi-Org Support
**Why:** MSPs and consultancies manage multiple orgs.

**What to build:**
- Org switcher in the UI
- Super-admin role that spans orgs
- Consolidated billing view

**Effort:** 3-5 days

### Lower Priority — Nice to Have

#### 7. Session Diff Viewer Improvements
- Inline code review (like GitHub PR review)
- Add comments on specific lines of AI-generated code
- Side-by-side diff view

#### 8. Custom Webhooks / Event Bus
- Let users configure webhooks for Origin events (session started, policy violated, etc.)
- Integration with Zapier/n8n for workflow automation

#### 9. Role-Based Dashboard Views
- Developer view: my sessions, my costs, my reviews
- Manager view: team overview, policy compliance
- Executive view: org-wide metrics, ROI

#### 10. On-Premise / Self-Hosted
- Docker Compose one-liner deployment
- Helm chart for Kubernetes
- Replace SQLite with PostgreSQL for production

---

## Architecture Decisions to Make

### Database
- Currently: SQLite on Fly.io volume
- **Consider:** PostgreSQL (Fly Postgres or Supabase) for production scale
- **When:** When you have >10 active users or >10k sessions

### Auth
- Currently: JWT + email/password
- **Consider:** OAuth 2.0 / SAML for enterprise
- **When:** First enterprise customer asks for SSO

### Deployment
- Currently: Single Fly.io machine
- **Consider:** Multiple regions, read replicas, CDN for static assets
- **When:** Users in multiple time zones or >50ms latency matters

---

## Key URLs

| Resource | URL |
|----------|-----|
| Production | https://origin-platform.fly.dev |
| GitHub Repo | https://github.com/dolobanko/origin-v2 |
| API Docs | https://origin-platform.fly.dev/docs (select "API Reference") |
| PR Checks | https://origin-platform.fly.dev/pull-requests |

## Key Credentials

| Item | Value |
|------|-------|
| Demo Login | artem@origin.dev / password123 |
| Org API Key | Settings → API Keys → Create |
| Org ID | Settings → General (shown in URL) |
