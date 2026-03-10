# Server-Side Cost Calculation with Per-Agent Pricing

## Context

Cost is currently estimated by the CLI using a hardcoded pricing table in `packages/cli/src/transcript.ts`. The server blindly stores whatever the CLI sends. Problems:
- Pricing is only as good as the hardcoded table (Gemini 3 preview = guessed)
- Thinking/reasoning tokens not handled separately
- No way for admins to set custom pricing per agent
- Cost can't be corrected server-side

**Goal:** Move cost calculation to the server. Add optional per-agent pricing overrides. Keep CLI estimation as a fallback display.

---

## Changes (6 files)

### 1. Schema — Add pricing fields to Agent

**File:** `apps/api/prisma/schema.prisma` — Agent model (line ~112)

Add two nullable Float fields:
```prisma
inputTokenPrice   Float?   // Custom $/1M input tokens (null = use model default)
outputTokenPrice  Float?   // Custom $/1M output tokens (null = use model default)
```

Run `prisma db push`.

### 2. New pricing service

**File:** `apps/api/src/services/pricing.ts` — **NEW**

- `MODEL_PRICING` constant — same table from CLI's transcript.ts, moved server-side
- `calculateSessionCost(model, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, agentPricing?)` function
  - If agentPricing provided → use those rates
  - Otherwise → match model name against MODEL_PRICING defaults
  - Cache read = input × 0.1, cache creation = input × 1.25

### 3. Server recalculates cost on session-end

**File:** `apps/api/src/routes/mcp.ts` — POST /session/end (line ~380)

After saving the session, recalculate cost:
- Fetch the agent linked to the session (if `agentId` is set)
- Call `calculateSessionCost()` with token counts + agent pricing
- Update session's `costUsd` with the server-calculated value (overrides client estimate)
- Also apply in PATCH /session/:id if tokens change

### 4. Agent routes accept pricing fields

**File:** `apps/api/src/routes/agents.ts`

- POST / (create): accept `inputTokenPrice`, `outputTokenPrice`
- PUT /:id (update): accept `inputTokenPrice`, `outputTokenPrice`
- Validate: must be positive numbers if provided

### 5. Frontend — Agent pricing in settings

**File:** `apps/web/src/pages/Agents.tsx` (or wherever agent create/edit form is)

- Add optional input fields for "Input token price ($/1M)" and "Output token price ($/1M)"
- Show as advanced/optional fields
- Display current pricing on agent detail

### 6. Frontend API types

**File:** `apps/web/src/api.ts`

- Add `inputTokenPrice` and `outputTokenPrice` to `Agent`, `AgentCreateData`, `AgentUpdateData` interfaces

---

## Verification

1. Build API + web (`npx tsc --noEmit` in both)
2. Run `prisma db push`
3. Deploy to Fly.io
4. **Test default pricing:** Start a Claude session → end it → verify server recalculated cost matches expected Sonnet pricing
5. **Test custom pricing:** Set custom pricing on Gemini agent in dashboard → start Gemini session → verify cost uses custom rates
6. **Test null pricing:** Agent with no custom pricing → verify it falls back to model defaults
