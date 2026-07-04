// PreToolUse enforcement for Antigravity — agy reads {decision} on stdout, so
// these helpers turn the cached server rules into allow/deny for a tool call.
import { describe, it, expect } from 'vitest';
import { agyToolPaths, agyGlobToRegex, agyEvaluatePreTool } from '../commands/hooks.js';

describe('agyToolPaths', () => {
  it('pulls a file path from the various PascalCase arg keys', () => {
    expect(agyToolPaths({ args: { TargetFile: '/r/a.ts' } }).filePath).toBe('/r/a.ts');
    expect(agyToolPaths({ args: { FilePath: '/r/b.ts' } }).filePath).toBe('/r/b.ts');
    expect(agyToolPaths({ args: { AbsolutePath: '/r/c.ts' } }).filePath).toBe('/r/c.ts');
  });
  it('pulls the command from run_command', () => {
    expect(agyToolPaths({ name: 'run_command', args: { CommandLine: 'git status' } }).command).toBe('git status');
  });
  it('returns nulls for a tool with neither', () => {
    expect(agyToolPaths({ args: { Foo: 1 } })).toEqual({ filePath: null, command: null });
  });
});

describe('agyGlobToRegex', () => {
  it('matches ** across directories (agy passes absolute paths)', () => {
    const re = agyGlobToRegex('**/.env');
    expect(re.test('/repo/config/.env')).toBe(true);
    expect(re.test('/repo/.env')).toBe(true);   // root-level file, absolute path
    expect(re.test('/repo/.env.local')).toBe(false);
  });
  it('* stays within a path segment', () => {
    const re = agyGlobToRegex('src/*.key');
    expect(re.test('src/private.key')).toBe(true);
    expect(re.test('src/sub/private.key')).toBe(false);
  });
});

describe('agyEvaluatePreTool', () => {
  const fileRule = { type: 'FILE_RESTRICTION', action: 'block', condition: JSON.stringify({ path: '**/.env' }), policyName: 'No secrets' };

  it('allows when there is no cache', () => {
    expect(agyEvaluatePreTool({ args: { TargetFile: '/r/.env' } }, null)).toEqual({ decision: 'allow' });
  });
  it('denies a file-restriction match with the policy reason', () => {
    const v = agyEvaluatePreTool({ args: { TargetFile: '/r/config/.env' } }, { enforcementRules: [fileRule] });
    expect(v.decision).toBe('deny');
    expect(v.reason).toContain('No secrets');
  });
  it('allows a non-matching file', () => {
    expect(agyEvaluatePreTool({ args: { TargetFile: '/r/README.md' } }, { enforcementRules: [fileRule] }).decision).toBe('allow');
  });
  it('budget lock denies every tool', () => {
    const v = agyEvaluatePreTool({ args: { CommandLine: 'ls' } }, { budgetBlocked: true, budgetMessage: 'Over budget' });
    expect(v).toEqual({ decision: 'deny', reason: 'Over budget' });
  });
  it('ignores warn-only / non-FILE_RESTRICTION rules', () => {
    const warnRule = { type: 'FILE_RESTRICTION', action: 'warn', condition: JSON.stringify({ path: '**/.env' }) };
    expect(agyEvaluatePreTool({ args: { TargetFile: '/r/.env' } }, { enforcementRules: [warnRule] }).decision).toBe('allow');
  });
});
