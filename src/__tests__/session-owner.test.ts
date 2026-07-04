import { describe, it, expect } from 'vitest';
import { keyFingerprint, ownerFromConfig, isForeignSession } from '../session-owner.js';

describe('session-owner', () => {
  describe('keyFingerprint', () => {
    it('is deterministic and 16 hex chars', () => {
      const fp = keyFingerprint('sk-abc123');
      expect(fp).toMatch(/^[a-f0-9]{16}$/);
      expect(keyFingerprint('sk-abc123')).toBe(fp);
    });

    it('differs for different keys', () => {
      expect(keyFingerprint('sk-aaa')).not.toBe(keyFingerprint('sk-bbb'));
    });

    it('never contains the raw key', () => {
      expect(keyFingerprint('sk-supersecret-raw-value')).not.toContain('supersecret');
    });
  });

  describe('ownerFromConfig', () => {
    it('returns null without apiKey or orgId', () => {
      expect(ownerFromConfig(null)).toBeNull();
      expect(ownerFromConfig({ apiKey: '', orgId: 'o1' } as any)).toBeNull();
      expect(ownerFromConfig({ apiKey: 'k', orgId: '' } as any)).toBeNull();
    });

    it('derives orgId + key fingerprint', () => {
      const owner = ownerFromConfig({ apiKey: 'sk-1', orgId: 'org-1' } as any);
      expect(owner).toEqual({ ownerOrgId: 'org-1', ownerKeyHash: keyFingerprint('sk-1') });
    });
  });

  describe('isForeignSession', () => {
    const owner = ownerFromConfig({ apiKey: 'sk-1', orgId: 'org-1' } as any)!;

    it('treats unstamped sessions as belonging to the current account', () => {
      expect(isForeignSession({}, owner)).toBe(false);
    });

    it('matches same orgId + same key fingerprint → not foreign', () => {
      expect(isForeignSession({ ownerOrgId: 'org-1', ownerKeyHash: keyFingerprint('sk-1') }, owner)).toBe(false);
    });

    it('flags a different orgId → foreign', () => {
      expect(isForeignSession({ ownerOrgId: 'org-2', ownerKeyHash: keyFingerprint('sk-1') }, owner)).toBe(true);
    });

    it('flags the same org but a different key (account swap) → foreign', () => {
      expect(isForeignSession({ ownerOrgId: 'org-1', ownerKeyHash: keyFingerprint('sk-2') }, owner)).toBe(true);
    });

    it('cannot judge when there is no current owner → not foreign', () => {
      expect(isForeignSession({ ownerOrgId: 'org-2', ownerKeyHash: 'x' }, null)).toBe(false);
    });
  });
});
