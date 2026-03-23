# Origin v2 — Next Steps

## What's Built & Deployed

Everything below is live at **https://getorigin.io**

### Core Platform
- [x] Session tracking (start/update/end via CLI hooks + MCP)
- [x] Policy engine (MODEL_ALLOWLIST, FILE_RESTRICTION, REQUIRE_REVIEW, COST_LIMIT, CONTENT_FILTER, COMMIT_MESSAGE)
- [x] GitHub integration (webhooks, status checks, PR comments)
- [x] **GitHub App** — one-click install, bot identity on checks, auto-webhooks, token auto-refresh
- [x] **Slack notifications** — real-time alerts for violations, reviews, budget via Incoming Webhooks
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
- [x] **Security Rules toggle** — per-agent, injects `<security-rules>` into system prompt (default OFF)
- [x] **CONTENT_FILTER policies** — block commits by diff content pattern (enforced at git pre-commit hook)
- [x] **COMMIT_MESSAGE policies** — validate commit message format (enforced at git pre-commit hook)
- [x] **Natural language policy creation** — describe policies in plain English, AI generates correct type/conditions
- [x] **Pre-commit hook policy enforcement** — `origin hooks git-pre-commit` fetches policies from API and blocks commits

### Analytics & Insights
- [x] **Leaderboard** — rank team members by sessions, lines, cost, quality score with activity heatmaps
- [x] **Compliance Dashboard** — compliance score gauge, violation trends, KPI cards (90-day window)
- [x] **Model Comparison** — per-model stats (cost, tokens, approval rate) with 12-week trend charts
- [x] **Prompt Analytics** — searchable prompt log with keyword-based pattern detection (Bug Fix, New Feature, Refactoring, etc.)
- [x] **Investigation Trails** — group sessions into audit threads with status (active/review/done) and priority
- [x] **AI Blame** — line-level attribution showing which prompt produced each line of code
- [x] **Ask the Author** — natural-language Q&A about any session (Claude-powered, uses transcript context)

### Bug Fixes
- [x] **Production URL fix** — "View in Origin" links in GitHub PR comments now point to production URL instead of localhost

---

## Your Immediate Next Steps

### 1. Test PR Blocking End-to-End

This is the most impactful feature to demo. Here's exactly what to do:

```bash
# a) Create a test policy that will trigger easily
#    Go to https://getorigin.io/policies
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

1. Go to https://getorigin.io/settings?tab=team
2. Enter team member's email → select role → "Send Invite"
3. Share the invite link
4. They create an account and get their own API key
5. Their sessions are now attributed to them personally

### 4. Install CLI on Team Machines

Each developer needs:

```bash
curl -fsSL https://getorigin.io/install.sh | sh
origin login
origin init
origin enable   # install hooks in their repo
```

Then they just code normally — sessions are captured automatically.

---

## What to Build Next (Priority Order)

### High Priority — Product Differentiators

#### ~~1. GitHub App~~ ✅ DONE
Completed. GitHub App (originv2) registered, deployed, and installed. Installation access tokens auto-refresh, centralized webhooks at `/api/webhooks/github-app`, one-click install flow in Settings.

#### ~~2. Slack/Teams Notifications~~ ✅ DONE
Completed. Slack Incoming Webhook integration in Settings with event toggles (violations, flags, reviews, budget). Hooks into `notifyOrgAdmins()` — one line provides full coverage.

#### ~~3. CLI Hooks for More Tools~~ ✅ DONE
Completed. CLI now supports: Claude Code, Cursor, Gemini, Windsurf, and Aider. Auto-detection, hook installation, and cleanup for all five agents.

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
| Production | https://getorigin.io |
| GitHub Repo | https://github.com/dolobanko/origin |
| API Docs | https://getorigin.io/docs (select "API Reference") |
| PR Checks | https://getorigin.io/pull-requests |

## Key Credentials

| Item | Value |
|------|-------|
| Demo Login | artem@origin.dev / password123 |
| Org API Key | Settings → API Keys → Create |
| Org ID | Settings → General (shown in URL) |
