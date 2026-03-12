# Origin v2 — Roadmap

## 🔥 High Priority (Core Value)

### 1. Real GitHub PR Integration
Right now the PR workflow is built but the "View in Origin" link still points to localhost. We need the GitHub App/webhook to actually post status checks and comments on real PRs with the correct production URL.

### 2. Team Dashboard / Multi-user View
Right now it's single-user. Engineering leads need to see all developers' sessions, costs, and compliance across the team. Aggregate views: cost per dev, sessions per day, model usage breakdown.

### 3. Alerts & Notifications
Policy violations should trigger Slack/email alerts. "Developer X touched restricted file", "Cost limit exceeded", "Unreviewed AI code merged."

## 🟡 Medium Priority (Differentiation)

### 4. AI Code Quality Scoring
Analyze AI-generated diffs for common issues (security vulnerabilities, test coverage gaps, code smell). Give each session a quality score.

### 5. Prompt Library / Templates
Let teams create approved prompt templates. "Use this prompt for auth changes", "Use this for database migrations." Track which templates produce better outcomes.

### 6. SSO / SAML Auth
Enterprise customers need it. Right now it's API key auth only.

### 7. Cost Budgets & Forecasting
Set monthly budgets per team/developer. Show burn rate, projected monthly cost, alerts when approaching limits.

## 🟢 Nice to Have

### 8. VS Code Extension
Dashboard widget inside the editor instead of a separate web app.

### 9. Diff Viewer
Show the actual AI-generated diff inline in the session view, not just file names.

### 10. Export & Reporting
PDF/CSV compliance reports for auditors. "Here's everything AI generated in Q1."
