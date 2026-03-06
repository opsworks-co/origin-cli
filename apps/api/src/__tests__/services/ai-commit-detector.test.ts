import { describe, it, expect } from 'vitest';
import { detectAITool } from '../../services/ai-commit-detector.js';

describe('AI Commit Detector', () => {
  describe('Co-Authored-By trailer detection', () => {
    it('detects Claude via Anthropic email', () => {
      const result = detectAITool(
        'feat: add new feature\n\nCo-Authored-By: Claude <noreply@anthropic.com>',
        'Artem Dolobanko'
      );
      expect(result.aiToolDetected).toBe('claude-code');
      expect(result.aiDetectionMethod).toBe('co-author-trailer');
    });

    it('detects Claude Opus variant', () => {
      const result = detectAITool(
        'fix: resolve bug\n\nCo-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>',
        'John Doe'
      );
      expect(result.aiToolDetected).toBe('claude-code');
      expect(result.aiDetectionMethod).toBe('co-author-trailer');
    });

    it('detects Claude Sonnet variant', () => {
      const result = detectAITool(
        'refactor: cleanup\n\nCo-Authored-By: Claude Sonnet <noreply@anthropic.com>',
        'Jane Smith'
      );
      expect(result.aiToolDetected).toBe('claude-code');
      expect(result.aiDetectionMethod).toBe('co-author-trailer');
    });

    it('detects GitHub Copilot', () => {
      const result = detectAITool(
        'feat: autocomplete\n\nCo-Authored-By: GitHub Copilot <noreply@github.com>',
        'Dev User'
      );
      expect(result.aiToolDetected).toBe('copilot');
      expect(result.aiDetectionMethod).toBe('co-author-trailer');
    });

    it('detects Cursor AI', () => {
      const result = detectAITool(
        'feat: implement feature\n\nCo-Authored-By: Cursor <cursor@users.noreply.github.com>',
        'Dev User'
      );
      expect(result.aiToolDetected).toBe('cursor');
      expect(result.aiDetectionMethod).toBe('co-author-trailer');
    });

    it('detects Aider', () => {
      const result = detectAITool(
        'refactor: restructure\n\nCo-Authored-By: aider <aider@aider.chat>',
        'Dev User'
      );
      expect(result.aiToolDetected).toBe('aider');
      expect(result.aiDetectionMethod).toBe('co-author-trailer');
    });

    it('detects Gemini', () => {
      const result = detectAITool(
        'feat: new endpoint\n\nCo-Authored-By: Gemini <gemini@google.com>',
        'Dev User'
      );
      expect(result.aiToolDetected).toBe('gemini');
      expect(result.aiDetectionMethod).toBe('co-author-trailer');
    });

    it('handles case-insensitive Co-Authored-By', () => {
      const result = detectAITool(
        'fix: bug\n\nco-authored-by: Claude <noreply@anthropic.com>',
        'Dev User'
      );
      expect(result.aiToolDetected).toBe('claude-code');
    });

    it('handles multiple Co-Authored-By (picks first AI match)', () => {
      const result = detectAITool(
        'feat: collab\n\nCo-Authored-By: John <john@example.com>\nCo-Authored-By: Claude <noreply@anthropic.com>',
        'Dev User'
      );
      expect(result.aiToolDetected).toBe('claude-code');
    });
  });

  describe('Author pattern detection', () => {
    it('detects mcp-agent author', () => {
      const result = detectAITool('feat: something', 'mcp-agent');
      expect(result.aiToolDetected).toBe('claude-code');
      expect(result.aiDetectionMethod).toBe('author-pattern');
    });

    it('detects ai-agent author', () => {
      const result = detectAITool('fix: something', 'ai-agent');
      expect(result.aiToolDetected).toBe('claude-code');
      expect(result.aiDetectionMethod).toBe('author-pattern');
    });

    it('detects Claude as author name', () => {
      const result = detectAITool('refactor: code', 'Claude');
      expect(result.aiToolDetected).toBe('claude-code');
      expect(result.aiDetectionMethod).toBe('author-pattern');
    });

    it('detects Copilot as author name', () => {
      const result = detectAITool('feat: auto', 'Copilot');
      expect(result.aiToolDetected).toBe('copilot');
      expect(result.aiDetectionMethod).toBe('author-pattern');
    });

    it('detects aider as author name', () => {
      const result = detectAITool('fix: bug', 'aider');
      expect(result.aiToolDetected).toBe('aider');
      expect(result.aiDetectionMethod).toBe('author-pattern');
    });
  });

  describe('Commit message pattern detection', () => {
    it('detects "Generated with Claude Code"', () => {
      const result = detectAITool(
        'feat: new feature\n\nGenerated with Claude Code',
        'Human Dev'
      );
      expect(result.aiToolDetected).toBe('claude-code');
      expect(result.aiDetectionMethod).toBe('commit-message');
    });

    it('detects aider prefix in message', () => {
      const result = detectAITool('[aider] fix: resolve import error', 'Human Dev');
      expect(result.aiToolDetected).toBe('aider');
      expect(result.aiDetectionMethod).toBe('commit-message');
    });

    it('detects aider colon prefix in message', () => {
      const result = detectAITool('aider: fix something', 'Human Dev');
      expect(result.aiToolDetected).toBe('aider');
      expect(result.aiDetectionMethod).toBe('commit-message');
    });
  });

  describe('No detection (human commits)', () => {
    it('returns null for plain human commit', () => {
      const result = detectAITool('fix: resolve login bug', 'John Doe');
      expect(result.aiToolDetected).toBeNull();
      expect(result.aiDetectionMethod).toBeNull();
    });

    it('returns null for empty message', () => {
      const result = detectAITool('', 'John Doe');
      expect(result.aiToolDetected).toBeNull();
      expect(result.aiDetectionMethod).toBeNull();
    });

    it('returns null for human Co-Authored-By', () => {
      const result = detectAITool(
        'feat: pair programming\n\nCo-Authored-By: Jane <jane@company.com>',
        'John Doe'
      );
      expect(result.aiToolDetected).toBeNull();
    });

    it('returns null when both message and author are empty', () => {
      const result = detectAITool('', '');
      expect(result.aiToolDetected).toBeNull();
      expect(result.aiDetectionMethod).toBeNull();
    });
  });

  describe('Priority order', () => {
    it('prefers Co-Authored-By over author pattern', () => {
      // Author is mcp-agent but also has a Copilot Co-Authored-By
      const result = detectAITool(
        'feat: something\n\nCo-Authored-By: GitHub Copilot <noreply@github.com>',
        'mcp-agent'
      );
      expect(result.aiToolDetected).toBe('copilot');
      expect(result.aiDetectionMethod).toBe('co-author-trailer');
    });

    it('prefers author pattern over message pattern', () => {
      const result = detectAITool(
        'Generated with Claude Code',
        'aider'
      );
      expect(result.aiToolDetected).toBe('aider');
      expect(result.aiDetectionMethod).toBe('author-pattern');
    });
  });
});
