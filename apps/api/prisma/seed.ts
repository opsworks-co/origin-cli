import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uuid(): string {
  return crypto.randomUUID();
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(
    Math.floor(Math.random() * 14) + 8, // 08:00-22:00
    Math.floor(Math.random() * 60),
    Math.floor(Math.random() * 60),
  );
  return d;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randFloat(min: number, max: number, decimals = 2): number {
  return parseFloat((Math.random() * (max - min) + min).toFixed(decimals));
}

// ---------------------------------------------------------------------------
// Seed data definitions
// ---------------------------------------------------------------------------

const SESSION_DEFS: {
  model: string;
  prompt: string;
  filesChanged: string[];
  transcript: { role: string; content: string }[];
}[] = [
  {
    model: "claude-code",
    prompt: "Add user authentication with JWT tokens",
    filesChanged: [
      "src/auth/jwt.ts",
      "src/auth/middleware.ts",
      "src/routes/auth.ts",
      "src/types/auth.ts",
    ],
    transcript: [
      {
        role: "human",
        content:
          "I need JWT-based authentication for our Express API. We need login/register endpoints and a middleware to protect routes.",
      },
      {
        role: "assistant",
        content:
          "I'll create the JWT authentication system. Let me start by setting up the token utilities and then build the auth middleware and routes.\n\nFirst, I'll create `src/auth/jwt.ts` for token signing and verification, then `src/auth/middleware.ts` for the Express middleware, and finally the auth routes.",
      },
      {
        role: "human",
        content:
          "Make sure the refresh token rotation is included. We need to invalidate old refresh tokens.",
      },
      {
        role: "assistant",
        content:
          "Good call. I'll add a `refreshTokens` table and implement rotation \u2014 each refresh issues a new token and invalidates the previous one. I've updated all four files with the complete implementation including token rotation.",
      },
    ],
  },
  {
    model: "cursor",
    prompt: "Fix pagination bug in /api/sessions endpoint",
    filesChanged: [
      "src/routes/sessions.ts",
      "src/utils/pagination.ts",
    ],
    transcript: [
      {
        role: "human",
        content:
          "The /api/sessions endpoint returns duplicate items when paginating. Page 2 shows some items from page 1.",
      },
      {
        role: "assistant",
        content:
          "The issue is in the offset calculation. The current code uses `(page - 1) * limit` but `page` is being parsed as a string, so the multiplication produces NaN and defaults to 0. I'll fix the parseInt call and add validation.",
      },
    ],
  },
  {
    model: "claude-code",
    prompt: "Refactor database layer to use repository pattern",
    filesChanged: [
      "src/repositories/base.ts",
      "src/repositories/user.repository.ts",
      "src/repositories/session.repository.ts",
      "src/repositories/repo.repository.ts",
      "src/services/user.service.ts",
      "src/services/session.service.ts",
    ],
    transcript: [
      {
        role: "human",
        content:
          "Our database calls are scattered across route handlers. I want to introduce a repository pattern to centralize data access.",
      },
      {
        role: "assistant",
        content:
          "I'll create a base repository class with common CRUD operations, then implement specific repositories for User, Session, and Repo models. The services will depend on these repositories instead of calling Prisma directly.",
      },
      {
        role: "human",
        content: "Include unit-testable interfaces so we can mock the repos.",
      },
      {
        role: "assistant",
        content:
          "Done. Each repository now implements an interface (e.g., `IUserRepository`) that can be injected into services. I've also updated the service constructors to accept the interface type.",
      },
    ],
  },
  {
    model: "gemini-cli",
    prompt: "Add WebSocket support for real-time session updates",
    filesChanged: [
      "src/ws/server.ts",
      "src/ws/handlers.ts",
      "src/index.ts",
    ],
    transcript: [
      {
        role: "human",
        content:
          "I want to push real-time updates to the dashboard when a coding session starts or ends.",
      },
      {
        role: "assistant",
        content:
          "I'll set up a WebSocket server using the `ws` library alongside the existing Express server. Events will be broadcast to connected clients on the `session:start` and `session:end` channels.",
      },
    ],
  },
  {
    model: "aider",
    prompt: "Implement org-level API key management",
    filesChanged: [
      "src/routes/api-keys.ts",
      "src/middleware/api-key-auth.ts",
      "src/utils/crypto.ts",
    ],
    transcript: [
      {
        role: "human",
        content:
          "We need API key CRUD endpoints so orgs can create keys for programmatic access.",
      },
      {
        role: "assistant",
        content:
          "I'll create endpoints for creating, listing, and revoking API keys. Keys will be hashed with SHA-256 before storage and we'll only show the full key once at creation time. The prefix (first 8 chars) is stored for identification.",
      },
    ],
  },
  {
    model: "copilot",
    prompt: "Add Docker Compose setup for local development",
    filesChanged: [
      "docker-compose.yml",
      "Dockerfile",
      ".dockerignore",
      "scripts/docker-entrypoint.sh",
    ],
    transcript: [
      {
        role: "human",
        content:
          "Set up Docker Compose with the API, a Postgres database, and Redis for caching.",
      },
      {
        role: "assistant",
        content:
          "I'll create a multi-service Docker Compose configuration with health checks, volume mounts for development, and environment variable templates. The API service will wait for Postgres to be healthy before starting.",
      },
    ],
  },
  {
    model: "claude-code",
    prompt: "Write unit tests for policy engine evaluation logic",
    filesChanged: [
      "src/policies/__tests__/engine.test.ts",
      "src/policies/__tests__/fixtures.ts",
      "src/policies/engine.ts",
    ],
    transcript: [
      {
        role: "human",
        content:
          "We need comprehensive tests for the policy engine. Cover file restriction matching, cost limit checks, and model allowlist validation.",
      },
      {
        role: "assistant",
        content:
          "I'll write tests for each policy type: FILE_RESTRICTION with glob matching, COST_LIMIT with threshold comparisons, MODEL_ALLOWLIST with inclusion checks, and REQUIRE_REVIEW for flagging. I'll also add edge cases like nested paths and zero-cost sessions.",
      },
      {
        role: "human",
        content: "Add a test for when multiple policies conflict.",
      },
      {
        role: "assistant",
        content:
          "Added a `conflicting policies` test suite. The engine uses severity-based precedence: HIGH > MEDIUM > LOW. When two policies match, BLOCK takes priority over WARN, and REQUIRE_REVIEW is evaluated independently. I've added 5 conflict scenarios.",
      },
    ],
  },
  {
    model: "cursor",
    prompt: "Build CSV export for session analytics",
    filesChanged: [
      "src/routes/exports.ts",
      "src/utils/csv.ts",
    ],
    transcript: [
      {
        role: "human",
        content:
          "I need an endpoint to export session data as CSV for reporting. Include all session metrics and the associated repo name.",
      },
      {
        role: "assistant",
        content:
          "I'll create a streaming CSV export endpoint at `GET /api/exports/sessions` that joins session data with repo info. It uses a cursor-based approach to handle large datasets without loading everything into memory.",
      },
    ],
  },
  {
    model: "gemini-cli",
    prompt: "Add rate limiting middleware with Redis backend",
    filesChanged: [
      "src/middleware/rate-limit.ts",
      "src/config/redis.ts",
      "src/index.ts",
    ],
    transcript: [
      {
        role: "human",
        content: "Implement rate limiting. 100 requests per minute per API key, 20 per minute for unauthenticated requests.",
      },
      {
        role: "assistant",
        content:
          "I'll use a sliding window counter stored in Redis. Each request increments a counter keyed by the API key or IP address. The window slides every minute and expired entries are automatically cleaned up via Redis TTL.",
      },
    ],
  },
  {
    model: "claude-code",
    prompt: "Implement git diff parser for commit analysis",
    filesChanged: [
      "src/git/diff-parser.ts",
      "src/git/types.ts",
      "src/git/__tests__/diff-parser.test.ts",
    ],
    transcript: [
      {
        role: "human",
        content:
          "I need a parser that extracts structured data from git diffs \u2014 files changed, lines added/removed, and hunks.",
      },
      {
        role: "assistant",
        content:
          "I'll build a streaming diff parser that handles unified diff format. It extracts file paths, detects binary files, parses hunk headers for line ranges, and categorizes changes as additions, deletions, or context lines. The output is a typed `DiffResult` object.",
      },
    ],
  },
  {
    model: "aider",
    prompt: "Fix memory leak in session transcript storage",
    filesChanged: [
      "src/services/transcript.service.ts",
      "src/utils/streaming.ts",
    ],
    transcript: [
      {
        role: "human",
        content:
          "The API memory grows unbounded when processing large session transcripts. We suspect the streaming buffer isn't being flushed.",
      },
      {
        role: "assistant",
        content:
          "Found it. The `TranscriptBuffer` class appends chunks to an array but never releases references after writing to the database. I've refactored it to use a fixed-size ring buffer that flushes in batches of 100 messages, then clears the buffer.",
      },
    ],
  },
  {
    model: "copilot",
    prompt: "Add OpenAPI spec generation from route definitions",
    filesChanged: [
      "src/docs/openapi.ts",
      "src/docs/schemas.ts",
      "src/routes/docs.ts",
    ],
    transcript: [
      {
        role: "human",
        content:
          "Generate an OpenAPI 3.0 spec from our Express routes so we can serve Swagger UI.",
      },
      {
        role: "assistant",
        content:
          "I'll create decorators-style metadata for each route and a generator that produces a valid OpenAPI 3.0 spec. The spec includes request/response schemas derived from our Zod validators, authentication requirements, and example payloads.",
      },
    ],
  },
  {
    model: "claude-code",
    prompt: "Implement role-based access control (RBAC) system",
    filesChanged: [
      "src/auth/rbac.ts",
      "src/auth/permissions.ts",
      "src/middleware/authorize.ts",
      "src/routes/users.ts",
    ],
    transcript: [
      {
        role: "human",
        content:
          "We need RBAC with OWNER, ADMIN, and MEMBER roles. Owners can do everything, admins manage repos and agents, members can only view.",
      },
      {
        role: "assistant",
        content:
          "I'll define a permission matrix mapping roles to actions (create, read, update, delete) on each resource type. The `authorize` middleware checks the user's role against the required permission before allowing the request through.",
      },
      {
        role: "human",
        content: "Add support for custom roles in the future.",
      },
      {
        role: "assistant",
        content:
          "Refactored to a permission-based system. Built-in roles (OWNER, ADMIN, MEMBER) map to permission sets, but the middleware checks permissions directly. This means custom roles can be added later by defining new permission sets without changing the middleware.",
      },
    ],
  },
  {
    model: "cursor",
    prompt: "Create dashboard summary stats endpoint",
    filesChanged: [
      "src/routes/dashboard.ts",
      "src/services/analytics.service.ts",
    ],
    transcript: [
      {
        role: "human",
        content:
          "Build a GET /api/dashboard/stats endpoint that returns total sessions, total cost, average duration, and top repos for the last 30 days.",
      },
      {
        role: "assistant",
        content:
          "I'll create an analytics service that runs aggregation queries. The endpoint returns `{ totalSessions, totalCostUsd, avgDurationMs, topRepos, sessionsByModel }` with efficient SQL aggregations using Prisma's `groupBy` and `aggregate` APIs.",
      },
    ],
  },
  {
    model: "gemini-cli",
    prompt: "Set up CI pipeline with GitHub Actions",
    filesChanged: [
      ".github/workflows/ci.yml",
      ".github/workflows/deploy.yml",
      "scripts/run-tests.sh",
    ],
    transcript: [
      {
        role: "human",
        content:
          "Create a CI pipeline that runs lint, typecheck, and tests on every PR. Also a deploy workflow for main branch.",
      },
      {
        role: "assistant",
        content:
          "I've created two workflows: `ci.yml` runs on PR events with lint, typecheck, and test jobs in parallel. `deploy.yml` triggers on push to main after CI passes, builds the Docker image, and deploys to the staging environment. Both use caching for node_modules.",
      },
    ],
  },
];

const REVIEW_STATUSES = ["APPROVED", "REJECTED", "FLAGGED"] as const;

// ---------------------------------------------------------------------------
// Main seed function
// ---------------------------------------------------------------------------

async function main() {
  console.log("Clearing existing data...");

  // Delete in reverse dependency order
  await prisma.auditLog.deleteMany();
  await prisma.sessionReview.deleteMany();
  await prisma.codingSession.deleteMany();
  await prisma.commit.deleteMany();
  await prisma.policyRule.deleteMany();
  await prisma.policy.deleteMany();
  await prisma.apiKey.deleteMany();
  await prisma.agent.deleteMany();
  await prisma.repo.deleteMany();
  await prisma.user.deleteMany();
  await prisma.org.deleteMany();

  console.log("Seeding Origin v2 database...");

  // ── 1. Org ──────────────────────────────────────────────────────
  const orgId = uuid();
  const org = await prisma.org.create({
    data: {
      id: orgId,
      name: "Acme Corp",
      slug: "acme",
    },
  });
  console.log(`  Created org: ${org.name} (${org.slug})`);

  // ── 2. User ─────────────────────────────────────────────────────
  const userId = uuid();
  const passwordHash = await bcrypt.hash("password123", 10);
  const user = await prisma.user.create({
    data: {
      id: userId,
      orgId: org.id,
      email: "artem@origin.dev",
      name: "Artem Dolobanko",
      passwordHash,
      role: "OWNER",
    },
  });
  console.log(`  Created user: ${user.email} (${user.role})`);

  // ── 3. Repos ────────────────────────────────────────────────────
  const repoOriginId = uuid();
  const repoWorkTrustId = uuid();
  const repoProvenantId = uuid();

  const repos = await Promise.all([
    prisma.repo.create({
      data: {
        id: repoOriginId,
        orgId: org.id,
        name: "origin",
        path: "/workspace/origin",
        provider: "local",
        syncedAt: daysAgo(0),
      },
    }),
    prisma.repo.create({
      data: {
        id: repoWorkTrustId,
        orgId: org.id,
        name: "WorkTrust",
        path: "https://github.com/dolobanko/WorkTrust",
        provider: "github",
        syncedAt: daysAgo(1),
      },
    }),
    prisma.repo.create({
      data: {
        id: repoProvenantId,
        orgId: org.id,
        name: "provenant",
        path: "https://github.com/dolobanko/provenant",
        provider: "github",
        syncedAt: daysAgo(2),
      },
    }),
  ]);
  console.log(`  Created ${repos.length} repos`);

  const repoIds = [repoOriginId, repoWorkTrustId, repoProvenantId];

  // ── 4. Agents ───────────────────────────────────────────────────
  const agentClaudeId = uuid();
  const agentCursorId = uuid();

  const agents = await Promise.all([
    prisma.agent.create({
      data: {
        id: agentClaudeId,
        orgId: org.id,
        name: "Claude Code Bot",
        slug: "claude-code-bot",
        description: "Automated coding agent powered by Claude",
        model: "claude-code",
        status: "ACTIVE",
      },
    }),
    prisma.agent.create({
      data: {
        id: agentCursorId,
        orgId: org.id,
        name: "Cursor Agent",
        slug: "cursor-agent",
        description: "Cursor IDE integrated coding agent",
        model: "cursor",
        status: "ACTIVE",
      },
    }),
  ]);
  console.log(`  Created ${agents.length} agents`);

  // ── 5. Coding sessions (15) ─────────────────────────────────────
  const sessionIds: string[] = [];
  const commitIds: string[] = [];

  const agentMap: Record<string, string | null> = {
    "claude-code": agentClaudeId,
    cursor: agentCursorId,
    "gemini-cli": null,
    aider: null,
    copilot: null,
  };

  for (let i = 0; i < SESSION_DEFS.length; i++) {
    const def = SESSION_DEFS[i];
    const commitId = uuid();
    const sessionId = uuid();
    const repoId = repoIds[i % repoIds.length];
    const sessionDate = daysAgo(randInt(0, 13));

    // Determine agent assignment: models with agents get them ~70% of the time
    const possibleAgent = agentMap[def.model];
    const agentId =
      possibleAgent && Math.random() > 0.3 ? possibleAgent : null;

    const sha = [...Array(40)]
      .map(() => Math.floor(Math.random() * 16).toString(16))
      .join("");

    await prisma.commit.create({
      data: {
        id: commitId,
        repoId,
        sha,
        message: def.prompt.toLowerCase().startsWith("fix")
          ? `fix: ${def.prompt.toLowerCase()}`
          : `feat: ${def.prompt.toLowerCase()}`,
        author: "Artem Dolobanko <artem@origin.dev>",
        committedAt: sessionDate,
      },
    });

    await prisma.codingSession.create({
      data: {
        id: sessionId,
        commitId,
        agentId,
        model: def.model,
        prompt: def.prompt,
        transcript: JSON.stringify(def.transcript),
        filesChanged: JSON.stringify(def.filesChanged),
        tokensUsed: randInt(5000, 80000),
        toolCalls: randInt(1, 40),
        durationMs: randInt(10000, 600000),
        linesAdded: randInt(10, 500),
        linesRemoved: randInt(5, 200),
        costUsd: randFloat(0.01, 2.5),
        createdAt: sessionDate,
      },
    });

    sessionIds.push(sessionId);
    commitIds.push(commitId);
  }
  console.log(`  Created 15 coding sessions with commits`);

  // ── 5b. Reviews (some sessions reviewed) ────────────────────────
  // Review roughly 9 of 15 sessions
  const reviewedIndices = [0, 1, 2, 4, 6, 7, 9, 12, 13];
  for (const idx of reviewedIndices) {
    const status = pick([...REVIEW_STATUSES]);
    const notes: Record<string, string> = {
      APPROVED: "Looks good, clean implementation.",
      REJECTED: "Needs refactoring before merge. Too many side effects.",
      FLAGGED: "Potential security concern \u2014 needs closer review.",
    };

    await prisma.sessionReview.create({
      data: {
        id: uuid(),
        sessionId: sessionIds[idx],
        userId: user.id,
        status,
        note: notes[status],
      },
    });
  }
  console.log(
    `  Created ${reviewedIndices.length} session reviews`,
  );

  // ── 6. Policies ─────────────────────────────────────────────────
  const policyDefs = [
    {
      name: "No payments changes",
      description:
        "Block all AI-generated changes to the payments module",
      type: "FILE_RESTRICTION",
      condition: JSON.stringify({ path: "src/payments/**" }),
      action: "BLOCK",
      severity: "HIGH",
    },
    {
      name: "Review infrastructure",
      description:
        "Require human review for any infrastructure changes",
      type: "REQUIRE_REVIEW",
      condition: JSON.stringify({ path: "infra/**" }),
      action: "REQUIRE_REVIEW",
      severity: "HIGH",
    },
    {
      name: "Approved models only",
      description:
        "Only allow sessions from approved AI models",
      type: "MODEL_ALLOWLIST",
      condition: JSON.stringify({
        models: ["claude-code", "cursor"],
      }),
      action: "BLOCK",
      severity: "MEDIUM",
    },
    {
      name: "Session cost limit",
      description:
        "Warn when a single session exceeds $5 in API costs",
      type: "COST_LIMIT",
      condition: JSON.stringify({ maxUsd: 5.0 }),
      action: "WARN",
      severity: "LOW",
    },
    {
      name: "No env changes",
      description:
        "Block AI from modifying environment variable files",
      type: "FILE_RESTRICTION",
      condition: JSON.stringify({ path: ".env*" }),
      action: "BLOCK",
      severity: "HIGH",
    },
  ];

  const policyIds: string[] = [];
  for (const def of policyDefs) {
    const policyId = uuid();
    policyIds.push(policyId);

    await prisma.policy.create({
      data: {
        id: policyId,
        orgId: org.id,
        name: def.name,
        description: def.description,
        type: def.type,
        active: true,
      },
    });

    await prisma.policyRule.create({
      data: {
        id: uuid(),
        policyId,
        condition: def.condition,
        action: def.action,
        severity: def.severity,
      },
    });
  }
  console.log(`  Created ${policyDefs.length} policies with rules`);

  // ── 7. Audit logs ───────────────────────────────────────────────
  const auditEntries: {
    action: string;
    resource: string;
    metadata: string;
    createdAt: Date;
  }[] = [];

  // REPO_SYNCED events
  for (const repo of repos) {
    auditEntries.push({
      action: "REPO_SYNCED",
      resource: `repo:${repo.id}`,
      metadata: JSON.stringify({
        repoName: repo.name,
        provider: repo.provider,
        commitCount: randInt(5, 50),
      }),
      createdAt: daysAgo(randInt(0, 3)),
    });
  }

  // SESSION_REVIEWED events (for reviewed sessions)
  for (const idx of reviewedIndices) {
    auditEntries.push({
      action: "SESSION_REVIEWED",
      resource: `session:${sessionIds[idx]}`,
      metadata: JSON.stringify({
        sessionModel: SESSION_DEFS[idx].model,
        prompt: SESSION_DEFS[idx].prompt,
      }),
      createdAt: daysAgo(randInt(0, 7)),
    });
  }

  // AGENT_CREATED events
  for (const agent of agents) {
    auditEntries.push({
      action: "AGENT_CREATED",
      resource: `agent:${agent.id}`,
      metadata: JSON.stringify({
        agentName: agent.name,
        model: agent.model,
      }),
      createdAt: daysAgo(13),
    });
  }

  // POLICY_CREATED events
  for (let i = 0; i < policyDefs.length; i++) {
    auditEntries.push({
      action: "POLICY_CREATED",
      resource: `policy:${policyIds[i]}`,
      metadata: JSON.stringify({
        policyName: policyDefs[i].name,
        type: policyDefs[i].type,
      }),
      createdAt: daysAgo(12),
    });
  }

  // ── 8. Policy violation audit entries ───────────────────────────
  auditEntries.push({
    action: "POLICY_VIOLATION",
    resource: `session:${sessionIds[5]}`,
    metadata: JSON.stringify({
      policyName: "No payments changes",
      policyType: "FILE_RESTRICTION",
      severity: "HIGH",
      violatingFile: "src/payments/stripe.ts",
      sessionModel: SESSION_DEFS[5].model,
      action: "BLOCK",
      message:
        "Session attempted to modify a protected payments file",
    }),
    createdAt: daysAgo(3),
  });

  auditEntries.push({
    action: "POLICY_VIOLATION",
    resource: `session:${sessionIds[11]}`,
    metadata: JSON.stringify({
      policyName: "No env changes",
      policyType: "FILE_RESTRICTION",
      severity: "HIGH",
      violatingFile: ".env.production",
      sessionModel: SESSION_DEFS[11].model,
      action: "BLOCK",
      message:
        "Session attempted to modify a protected environment file",
    }),
    createdAt: daysAgo(1),
  });

  // Write all audit log entries
  for (const entry of auditEntries) {
    await prisma.auditLog.create({
      data: {
        id: uuid(),
        orgId: org.id,
        userId: user.id,
        action: entry.action,
        resource: entry.resource,
        metadata: entry.metadata,
        createdAt: entry.createdAt,
      },
    });
  }
  console.log(`  Created ${auditEntries.length} audit log entries`);

  console.log("\nSeed completed successfully.");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main()
  .catch((e) => {
    console.error("Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
