import { H2, P, Li, Callout } from '../shared/Markdown';

export default function SecretScanningSection() {
  return (
    <>
          <div>
            <h1 id="secret-scanning" className="text-2xl font-bold mb-2">Secret & PII Scanning</h1>
            <P>
              Origin automatically scans code diffs at the end of every coding session for
              hardcoded secrets, API keys, credentials, and personally identifiable information (PII).
              Findings are displayed in the session detail and trigger notifications for critical issues.
            </P>

            {/* Secret Scanning Mockup */}
            <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden my-6">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/80">
                <div className="w-3 h-3 rounded-full bg-red-500/80" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                <div className="w-3 h-3 rounded-full bg-green-500/80" />
                <span className="text-xs text-gray-500 ml-2 font-mono">Security &mdash; Session Findings</span>
              </div>
              <div className="p-4">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-xs text-red-400 font-medium">3 findings detected</span>
                </div>
                <div className="space-y-2">
                  {[
                    { type: 'AWS_SECRET', severity: 'critical', file: 'src/config/aws.ts', line: 12, match: 'AKIA****' },
                    { type: 'API_KEY', severity: 'high', file: 'src/services/stripe.ts', line: 8, match: 'sk_l****' },
                    { type: 'PII_EMAIL', severity: 'low', file: 'src/utils/notify.ts', line: 45, match: 'admi****@company.com' },
                  ].map((f, i) => (
                    <div key={i} className="flex items-center gap-3 bg-gray-800/40 border border-gray-700/50 rounded-lg px-3 py-2.5">
                      <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${
                        f.severity === 'critical' ? 'bg-red-900/50 text-red-400' :
                        f.severity === 'high' ? 'bg-orange-900/50 text-orange-400' :
                        'bg-gray-700/50 text-gray-400'
                      }`}>{f.severity}</span>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-gray-200 font-mono">{f.type}</div>
                        <div className="text-[10px] text-gray-500">{f.file}:{f.line}</div>
                      </div>
                      <span className="text-xs text-gray-500 font-mono">{f.match}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <H2 id="detection-types">Detection Types</H2>
            <P>The scanner checks for the following patterns in added lines:</P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">AWS_SECRET</strong> &mdash; AWS access keys and secret keys (AKIA... pattern)</Li>
              <Li><strong className="text-gray-200">API_KEY</strong> &mdash; Generic API key assignments, GitHub tokens (ghp_...), Slack tokens (xox...)</Li>
              <Li><strong className="text-gray-200">PRIVATE_KEY</strong> &mdash; Private keys (-----BEGIN PRIVATE KEY-----)</Li>
              <Li><strong className="text-gray-200">CONNECTION_STRING</strong> &mdash; Database connection strings (mongodb://, postgres://)</Li>
              <Li><strong className="text-gray-200">JWT_TOKEN</strong> &mdash; Hardcoded JSON Web Tokens (eyJ...)</Li>
              <Li><strong className="text-gray-200">PASSWORD</strong> &mdash; Hardcoded passwords in code assignments</Li>
              <Li><strong className="text-gray-200">PII_EMAIL</strong> &mdash; Hardcoded email addresses in string literals</Li>
              <Li><strong className="text-gray-200">GENERIC_SECRET</strong> &mdash; Secret/token/auth key assignments with long values</Li>
            </ul>

            <H2>How It Works</H2>
            <P>
              When a session ends with a git diff, the scanner parses the unified diff to extract
              only <strong className="text-gray-200">added lines</strong> (lines starting with +).
              It skips comments and empty lines, then runs each detection regex against the content.
              Matched values are automatically redacted (first 4 characters + ****) before storage.
            </P>

            <H2>Severity Levels</H2>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-red-400">Critical</strong> &mdash; AWS keys, private keys, connection strings</Li>
              <Li><strong className="text-orange-400">High</strong> &mdash; API keys, JWT tokens, hardcoded passwords</Li>
              <Li><strong className="text-amber-400">Medium</strong> &mdash; Generic secrets and tokens</Li>
              <Li><strong className="text-gray-400">Low</strong> &mdash; Hardcoded email addresses</Li>
            </ul>

            <H2>Viewing Findings</H2>
            <P>
              Open any session and click the <strong className="text-gray-200">Security</strong> tab
              to view findings. Each finding shows the detection type, severity, file path, line number,
              and redacted match. A green checkmark appears when no secrets are detected.
            </P>
            <P>
              Aggregate finding statistics are shown on the Insights page in the
              &ldquo;Secret Detections by Type&rdquo; chart and on the Dashboard as a stat card.
            </P>

            <H2>Notifications</H2>
            <P>
              When high or critical severity findings are detected, all organization admins receive
              a notification with a link to the session. The notification type
              is <code className="text-indigo-400">SECRET_DETECTED</code>.
            </P>

            <Callout type="tip">
              The scanner only analyzes added lines in diffs, not removed lines or existing code.
              This means it only catches secrets being introduced, not those being removed.
            </Callout>
          </div>
    </>
  );
}
