/**
 * Tests for policyAppliesToCommit — the per-agent assignment filter the
 * pre-commit hook applies before evaluating a policy's rules.
 *
 * The bug: handlePreCommit iterated every active policy with no scope
 * filtering at all, so a CONTENT_FILTER scoped to specific agents (the
 * dashboard shows them as chips) blocked EVERY commit in the org —
 * other agents' commits and hand-typed human commits alike. The server
 * already had the right semantics in policy-engine's shouldSkipPolicy;
 * this mirrors it client-side (inverted: true = enforce).
 */

import { describe, it, expect } from 'vitest';
import { policyAppliesToCommit } from '../commands/hooks.js';

const active = (...slugs: string[]) => new Set(slugs.map((s) => s.toLowerCase()));

describe('policyAppliesToCommit', () => {
  it('org-wide policy (no assignments) applies to every commit', () => {
    expect(policyAppliesToCommit([], active('codex'))).toBe(true);
    expect(policyAppliesToCommit(undefined, active('codex'))).toBe(true);
    // …including human commits with no agent session at all
    expect(policyAppliesToCommit([], active())).toBe(true);
  });

  it('agent-scoped policy applies when an assigned agent is active', () => {
    const assigned = [{ slug: 'claude-code' }, { slug: 'codex' }];
    expect(policyAppliesToCommit(assigned, active('codex'))).toBe(true);
    expect(policyAppliesToCommit(assigned, active('gemini', 'claude-code'))).toBe(true);
  });

  it('agent-scoped policy does NOT apply when no assigned agent is active', () => {
    const assigned = [{ slug: 'claude-code' }, { slug: 'codex' }];
    expect(policyAppliesToCommit(assigned, active('gemini'))).toBe(false);
  });

  it('agent-scoped policy does NOT apply to human commits (no active session)', () => {
    expect(policyAppliesToCommit([{ slug: 'codex' }], active())).toBe(false);
  });

  it('slug matching is case-insensitive', () => {
    expect(policyAppliesToCommit([{ slug: 'Claude-Code' }], active('claude-code'))).toBe(true);
  });

  it('assignments with missing slugs are ignored rather than matching everything', () => {
    expect(policyAppliesToCommit([{ slug: null }, { slug: undefined }], active('codex'))).toBe(false);
  });
});
