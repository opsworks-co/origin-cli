import { describe, it, expect } from 'vitest';
import { looksLikeSessionId } from '../commands/prompts.js';

const never = () => false;

describe('looksLikeSessionId', () => {
  it('accepts the full UUID every Origin surface prints', () => {
    // The regression: `origin explain` prints this exact string, and
    // `origin prompts <that string>` answered "No commits found for ...".
    expect(looksLikeSessionId('92e45049-a542-46b0-95c1-77b4c21b0039', never)).toBe(true);
    expect(looksLikeSessionId('92E45049-A542-46B0-95C1-77B4C21B0039', never)).toBe(true);
  });

  it('still accepts a session tag and a bare hex prefix', () => {
    expect(looksLikeSessionId('92e45049-a54', never)).toBe(false); // not a UUID, has hyphen
    expect(looksLikeSessionId('92e45049', never)).toBe(true);
    expect(looksLikeSessionId('92e45049a542', never)).toBe(true);
  });

  it('rejects paths and ordinary filenames', () => {
    expect(looksLikeSessionId('src/index.ts', never)).toBe(false);
    expect(looksLikeSessionId('README.md', never)).toBe(false);
    expect(looksLikeSessionId('deadbeef.ts', never)).toBe(false);
    expect(looksLikeSessionId('./92e45049', never)).toBe(false);
    expect(looksLikeSessionId('a\\b', never)).toBe(false);
    expect(looksLikeSessionId('', never)).toBe(false);
  });

  it('rejects too-short hex — 7 chars is a git prefix, not a session', () => {
    expect(looksLikeSessionId('92e4504', never)).toBe(false);
  });

  it('lets a file that exists on disk win over an ID-shaped name', () => {
    const exists = () => true;
    expect(looksLikeSessionId('92e45049-a542-46b0-95c1-77b4c21b0039', exists)).toBe(false);
    expect(looksLikeSessionId('deadbeef', exists)).toBe(false);
  });
});
