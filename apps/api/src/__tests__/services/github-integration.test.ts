import { describe, it, expect, vi } from 'vitest';

// Mock the db module
vi.mock('../../db.js', () => ({
  prisma: {},
}));

// Import AFTER mocks (only pure functions, no DB calls)
import {
  parseRepoFullName,
  buildSessionSummaryComment,
  computeCheckStatus,
} from '../../services/github-integration.js';

describe('GitHub Integration Service — Pure Functions', () => {
  // ── parseRepoFullName ───────────────────────────────────────────

  describe('parseRepoFullName', () => {
    it('parses "owner/repo" format', () => {
      expect(parseRepoFullName('org/my-app')).toEqual({ owner: 'org', repo: 'my-app' });
    });

    it('parses full GitHub URL', () => {
      expect(parseRepoFullName('https://github.com/org/my-app')).toEqual({
        owner: 'org',
        repo: 'my-app',
      });
    });

    it('parses URL without protocol', () => {
      expect(parseRepoFullName('github.com/org/my-app')).toEqual({
        owner: 'org',
        repo: 'my-app',
      });
    });

    it('strips .git suffix', () => {
      expect(parseRepoFullName('https://github.com/org/my-app.git')).toEqual({
        owner: 'org',
        repo: 'my-app',
      });
    });

    it('handles leading/trailing slashes', () => {
      expect(parseRepoFullName('/org/my-app/')).toEqual({ owner: 'org', repo: 'my-app' });
    });

    it('returns null for single segment', () => {
      expect(parseRepoFullName('just-a-name')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(parseRepoFullName('')).toBeNull();
    });
  });

  // ── computeCheckStatus ──────────────────────────────────────────

  describe('computeCheckStatus', () => {
    it('returns success when no sessions', () => {
      const result = computeCheckStatus([]);
      expect(result.state).toBe('success');
    });

    it('returns success when all approved', () => {
      const sessions = [
        { id: 's1', agentName: 'a1', model: 'claude-4', costUsd: 1, tokensUsed: 1000, linesAdded: 50, linesRemoved: 10, reviewStatus: 'APPROVED' },
        { id: 's2', agentName: 'a2', model: 'claude-4', costUsd: 2, tokensUsed: 2000, linesAdded: 100, linesRemoved: 20, reviewStatus: 'APPROVED' },
      ];
      const result = computeCheckStatus(sessions);
      expect(result.state).toBe('success');
    });

    it('returns failure when any rejected', () => {
      const sessions = [
        { id: 's1', agentName: 'a1', model: 'claude-4', costUsd: 1, tokensUsed: 1000, linesAdded: 50, linesRemoved: 10, reviewStatus: 'APPROVED' },
        { id: 's2', agentName: 'a2', model: 'claude-4', costUsd: 2, tokensUsed: 2000, linesAdded: 100, linesRemoved: 20, reviewStatus: 'REJECTED' },
      ];
      const result = computeCheckStatus(sessions);
      expect(result.state).toBe('failure');
    });

    it('returns failure when any flagged', () => {
      const sessions = [
        { id: 's1', agentName: null, model: 'gpt-4', costUsd: 1, tokensUsed: 1000, linesAdded: 50, linesRemoved: 10, reviewStatus: 'FLAGGED' },
      ];
      const result = computeCheckStatus(sessions);
      expect(result.state).toBe('failure');
    });

    it('returns pending when reviews are missing', () => {
      const sessions = [
        { id: 's1', agentName: 'a1', model: 'claude-4', costUsd: 1, tokensUsed: 1000, linesAdded: 50, linesRemoved: 10, reviewStatus: null },
      ];
      const result = computeCheckStatus(sessions);
      expect(result.state).toBe('pending');
    });

    it('rejected takes priority over flagged', () => {
      const sessions = [
        { id: 's1', agentName: 'a1', model: 'claude-4', costUsd: 1, tokensUsed: 1000, linesAdded: 50, linesRemoved: 10, reviewStatus: 'REJECTED' },
        { id: 's2', agentName: 'a2', model: 'claude-4', costUsd: 2, tokensUsed: 2000, linesAdded: 100, linesRemoved: 20, reviewStatus: 'FLAGGED' },
      ];
      const result = computeCheckStatus(sessions);
      expect(result.state).toBe('failure');
      expect(result.description).toContain('rejected');
    });
  });

  // ── buildSessionSummaryComment ──────────────────────────────────

  describe('buildSessionSummaryComment', () => {
    it('returns "no sessions" message when empty', () => {
      const comment = buildSessionSummaryComment([], 'http://localhost:5176');
      expect(comment).toContain('No AI coding sessions');
      expect(comment).toContain('Origin');
    });

    it('builds markdown table for sessions', () => {
      const sessions = [
        { id: 's1', agentName: 'code-bot', model: 'claude-4', costUsd: 2.5, tokensUsed: 45000, linesAdded: 850, linesRemoved: 20, reviewStatus: 'APPROVED' },
      ];
      const comment = buildSessionSummaryComment(sessions, 'http://localhost:5176');
      expect(comment).toContain('Origin — AI Governance Report');
      expect(comment).toContain('code-bot');
      expect(comment).toContain('claude-4');
      expect(comment).toContain('$2.50');
      expect(comment).toContain('Approved');
      expect(comment).toContain('1 AI session');
    });

    it('shows "All sessions approved" when all approved', () => {
      const sessions = [
        { id: 's1', agentName: 'a1', model: 'm', costUsd: 1, tokensUsed: 100, linesAdded: 10, linesRemoved: 0, reviewStatus: 'APPROVED' },
      ];
      const comment = buildSessionSummaryComment(sessions, 'http://localhost:5176');
      expect(comment).toContain('All sessions approved');
    });

    it('shows "rejected" status when any rejected', () => {
      const sessions = [
        { id: 's1', agentName: 'a1', model: 'm', costUsd: 1, tokensUsed: 100, linesAdded: 10, linesRemoved: 0, reviewStatus: 'REJECTED' },
      ];
      const comment = buildSessionSummaryComment(sessions, 'http://localhost:5176');
      expect(comment).toContain('rejected');
    });

    it('pluralizes correctly for multiple sessions', () => {
      const sessions = [
        { id: 's1', agentName: 'a1', model: 'm', costUsd: 1, tokensUsed: 100, linesAdded: 10, linesRemoved: 0, reviewStatus: null },
        { id: 's2', agentName: 'a2', model: 'm', costUsd: 2, tokensUsed: 200, linesAdded: 20, linesRemoved: 5, reviewStatus: null },
      ];
      const comment = buildSessionSummaryComment(sessions, 'http://localhost:5176');
      expect(comment).toContain('2 AI sessions');
      expect(comment).toContain('$3.00');
    });
  });
});
