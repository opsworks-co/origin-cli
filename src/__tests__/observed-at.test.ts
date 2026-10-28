import { describe, it, expect } from 'vitest';
import { stampObservedAt } from '../observed-at.js';

describe('stampObservedAt', () => {
  it('stamps an update once, on the caller\'s object, and never overwrites', () => {
    const data: any = { tokensUsed: 1 };
    stampObservedAt(data);
    const first = data.observedAt;
    expect(Number.isFinite(Date.parse(first))).toBe(true);
    stampObservedAt(data);
    expect(data.observedAt).toBe(first);
  });

  it('leaves non-objects alone', () => {
    expect(() => stampObservedAt(null)).not.toThrow();
    const arr: any = [];
    stampObservedAt(arr);
    expect(arr.observedAt).toBeUndefined();
  });
});
