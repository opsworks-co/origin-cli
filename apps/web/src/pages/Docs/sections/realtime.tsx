import { CodeBlock, H2, P, Li, Callout } from '../shared/Markdown';

export default function RealtimeSection() {
  return (
    <>
          <div>
            <h1 id="realtime" className="text-2xl font-bold mb-2">Real-Time Streaming</h1>
            <P>
              Origin supports real-time session event streaming using Server-Sent Events (SSE).
              The sessions page automatically connects to the stream and updates live.
            </P>

            <H2>How It Works</H2>
            <P>
              The sessions list page establishes an SSE connection to
              <code className="text-indigo-400"> GET /api/sessions/stream</code>. When sessions
              are created, updated, or ended, events are pushed to all connected clients
              for that organization.
            </P>

            <H2>Event Types</H2>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">session:started</strong> &mdash; A new coding session has begun</Li>
              <Li><strong className="text-gray-200">session:updated</strong> &mdash; A session received incremental data (e.g. new tool calls)</Li>
              <Li><strong className="text-gray-200">session:ended</strong> &mdash; A session has completed</Li>
              <Li><strong className="text-gray-200">session:reviewed</strong> &mdash; A session was reviewed (approved/rejected/flagged)</Li>
            </ul>

            <H2>Connection Status</H2>
            <P>
              The green pulsing dot in the top-right of the Sessions page indicates the SSE
              connection is active. If the connection drops, it shows as a gray dot with
              &ldquo;Connecting...&rdquo;. The browser automatically reconnects.
            </P>

            <H2>API Usage</H2>
            <P>
              To consume the stream programmatically, first obtain a short-lived SSE token,
              then connect to the SSE endpoint with it:
            </P>
            <CodeBlock title="SSE endpoint">{`# Step 1: Get a short-lived SSE token (valid 30 seconds, single use)
POST /api/auth/sse-token
Authorization: Bearer YOUR_JWT_TOKEN

# Step 2: Connect with the SSE token (not the JWT)
GET /api/sessions/stream?sseToken=SHORT_LIVED_TOKEN

# Response: Server-Sent Events
data: {"type":"connected"}

data: {"type":"session:started","sessionId":"abc-123","orgId":"org-1","timestamp":"2025-01-01T00:00:00.000Z"}

data: {"type":"session:ended","sessionId":"abc-123","orgId":"org-1","data":{"costUsd":0.42},"timestamp":"2025-01-01T00:05:00.000Z"}`}</CodeBlock>

            <H2>Heartbeat</H2>
            <P>
              The server sends a heartbeat comment every 30 seconds to keep the connection
              alive through proxies and load balancers. These are SSE comments (lines starting
              with <code className="text-indigo-400">:</code>) and are ignored by EventSource clients.
            </P>

            <Callout type="tip">
              Events are scoped to your organization. You will only receive events for sessions
              belonging to repos in your org.
            </Callout>
          </div>
    </>
  );
}
