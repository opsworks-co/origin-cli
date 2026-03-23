# Origin v2 — Roadmap

## Completed

### ~~1. Real GitHub PR Integration~~ ✅
GitHub App deployed. Status checks and PR comments posted with production URLs. Branch protection supported.

### ~~2. Alerts & Notifications~~ ✅
Slack Incoming Webhook integration with event toggles. Policy violations, flags, reviews, budget alerts.

### ~~3. AI Code Quality Scoring~~ ✅
AI auto-review with quality score (0-100), risk level, concerns, suggestions, and category breakdown.

### ~~4. Content Filtering & Pre-commit Hooks~~ ✅
CONTENT_FILTER and COMMIT_MESSAGE policy types enforced at git pre-commit hook level. Blocks commits before AI agent proceeds.

### ~~5. Security Rules Toggle~~ ✅
Per-agent toggle that injects `<security-rules>` block into system prompt. Default rules cover secrets, credentials, .env files. Custom rules supported.

### ~~6. Natural Language Policy Creation~~ ✅
Create policies from plain English descriptions. AI parses intent into correct policy type, conditions, and actions.

---

## High Priority (Next Up)

### 1. Team Dashboard / Multi-user View
Engineering leads need to see all developers' sessions, costs, and compliance across the team. Aggregate views: cost per dev, sessions per day, model usage breakdown.

### 2. SSO / SAML Auth
Enterprise customers need it. SAML 2.0 IdP integration (Okta, Azure AD, Google Workspace). Auto-provisioning users from IdP groups.

### 3. Compliance Reports (PDF Export)
Weekly/monthly automated reports for CISOs. AI authorship %, policy compliance rate, cost trends. PDF generation + email delivery.

---

## Medium Priority

### 4. Cost Budgets & Forecasting
Set monthly budgets per team/developer. Show burn rate, projected monthly cost, alerts when approaching limits.

### 5. Prompt Library / Templates
Let teams create approved prompt templates. Track which templates produce better outcomes.

### 6. Multi-Org Support
Org switcher in UI, super-admin role, consolidated billing.

---

## Nice to Have

### 7. VS Code Extension
Dashboard widget inside the editor.

### 8. Diff Viewer Improvements
Inline code review, comments on AI-generated lines, side-by-side view.

### 9. On-Premise / Self-Hosted
Docker Compose one-liner, Helm chart, PostgreSQL support.

### 10. Custom Webhooks / Event Bus
Webhooks for Origin events. Zapier/n8n integration.
