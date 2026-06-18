import { describe, it, expect } from 'vitest';
import { decidePushBlock } from '../push-block.js';

describe('decidePushBlock', () => {
  describe('API reachable', () => {
    it('allows when the server allows', () => {
      expect(decidePushBlock({ reachable: true, allowed: true }).block).toBe(false);
    });

    it('blocks when the server disallows (agent disabled)', () => {
      const d = decidePushBlock({ reachable: true, allowed: false, agentName: 'Claude' });
      expect(d.block).toBe(true);
      expect(d.reason).toMatch(/claude is disabled/i);
    });

    it('falls back to a generic name when none provided', () => {
      const d = decidePushBlock({ reachable: true, allowed: false });
      expect(d.block).toBe(true);
      expect(d.reason).toMatch(/your coding agent/i);
    });
  });

  describe('API unreachable — fail policy from cached mode', () => {
    it('allows when cached mode is off', () => {
      expect(decidePushBlock({ reachable: false, cachedMode: 'off' }).block).toBe(false);
    });

    it('allows when cached mode is fail-open', () => {
      expect(decidePushBlock({ reachable: false, cachedMode: 'on_fail_open' }).block).toBe(false);
    });

    it('blocks when cached mode is fail-closed', () => {
      const d = decidePushBlock({ reachable: false, cachedMode: 'on_fail_closed' });
      expect(d.block).toBe(true);
      expect(d.reason).toMatch(/couldn't reach origin/i);
    });

    it('allows when mode was never cached (org never opted in / never synced)', () => {
      expect(decidePushBlock({ reachable: false, cachedMode: undefined }).block).toBe(false);
    });
  });
});
