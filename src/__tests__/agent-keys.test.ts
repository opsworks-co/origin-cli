import { describe, it, expect, afterEach } from 'vitest';
import { agentEnvWithKey } from '../agent-keys.js';

// The injected values below are arbitrary opaque strings — the tests only
// assert precedence (which value ends up in the env), never a real secret.
describe('agentEnvWithKey — injection precedence', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  const resolved = 'resolved-value';
  const fromShell = 'shell-value';

  it('injects the resolved value when the shell has none', () => {
    delete process.env.ANTHROPIC_API_KEY;
    const env = agentEnvWithKey('ANTHROPIC_API_KEY', { anthropic: resolved });
    expect(env.ANTHROPIC_API_KEY).toBe(resolved);
  });

  it('a shell export WINS over the resolved value (never overridden)', () => {
    process.env.ANTHROPIC_API_KEY = fromShell;
    const env = agentEnvWithKey('ANTHROPIC_API_KEY', { anthropic: resolved });
    expect(env.ANTHROPIC_API_KEY).toBe(fromShell);
  });

  it('maps the openai provider to OPENAI_API_KEY', () => {
    delete process.env.OPENAI_API_KEY;
    const env = agentEnvWithKey('OPENAI_API_KEY', { openai: 'openai-value' });
    expect(env.OPENAI_API_KEY).toBe('openai-value');
  });

  it('leaves env untouched when the agent has no key env var', () => {
    const env = agentEnvWithKey(undefined, { anthropic: resolved });
    expect(env.ANTHROPIC_API_KEY).toBe(saved.ANTHROPIC_API_KEY);
  });

  it('does not inject when nothing is resolved for that provider', () => {
    delete process.env.ANTHROPIC_API_KEY;
    const env = agentEnvWithKey('ANTHROPIC_API_KEY', {});
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});
