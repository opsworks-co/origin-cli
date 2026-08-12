import { describe, it, expect } from 'vitest';
import path from 'path';
import { isCommandAccessible } from '../plugin-system.js';

// The PATH lookup shelled out to `which`, which does not exist on Windows — so
// it threw for EVERY dependency and reported every plugin's requirements as
// unsatisfiable. `where` is the Windows equivalent; both exit non-zero when the
// command is missing. Runs against the real PATH deliberately: the whole bug was
// that the platform's actual lookup tool wasn't being used.
describe('isCommandAccessible', () => {
  it('finds node, which is necessarily on PATH here', () => {
    expect(isCommandAccessible('node')).toBe(true);
  });

  it('rejects a command that cannot exist', () => {
    expect(isCommandAccessible('origin-definitely-not-a-real-binary-xyz')).toBe(false);
  });

  it('takes the first token, so a command with arguments still resolves', () => {
    expect(isCommandAccessible('node --version')).toBe(true);
  });

  // process.execPath is `C:\Program Files\nodejs\node.exe` on a stock Windows
  // install. Splitting on whitespace turned that into `C:\Program`, so every
  // plugin whose command lived under Program Files looked inaccessible.
  it('accepts an absolute path that exists, spaces and all', () => {
    expect(isCommandAccessible(process.execPath)).toBe(true);
  });

  it('accepts a quoted absolute path carrying arguments', () => {
    expect(isCommandAccessible(`"${process.execPath}" --version`)).toBe(true);
  });

  it('rejects a quoted absolute path that does not exist', () => {
    const missing = path.join(path.dirname(process.execPath), 'no-such-file-xyz');
    expect(isCommandAccessible(`"${missing}" --version`)).toBe(false);
  });

  it('rejects empty and whitespace-only commands', () => {
    expect(isCommandAccessible('')).toBe(false);
    expect(isCommandAccessible('   ')).toBe(false);
  });

  it('rejects an absolute path that does not exist', () => {
    expect(isCommandAccessible(path.join(path.dirname(process.execPath), 'no-such-file-xyz'))).toBe(false);
  });
});
