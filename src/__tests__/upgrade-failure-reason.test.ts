// `origin upgrade` printed only "Upgrade failed. Try manually:" — the catch
// threw the error away unless it was EACCES. Seen 2026-10-29: the run stopped
// after "Downloading...", so curl failed, and nothing said whether it timed
// out (30s then) or the server answered an error. The failure now names why.
import { describe, it, expect } from 'vitest';
import { upgradeFailureReason } from '../commands/upgrade.js';

describe('upgradeFailureReason', () => {
  it('says the download timed out when execFileSync killed curl', () => {
    expect(upgradeFailureReason({ killed: true, signal: 'SIGTERM', message: 'spawnSync curl ETIMEDOUT' })).toMatch(/took longer than 120s/);
    expect(upgradeFailureReason({ code: 'ETIMEDOUT' })).toMatch(/took longer than/);
  });

  it("quotes curl's own error line", () => {
    const err = { status: 22, stderr: 'curl: (22) The requested URL returned error: 503\n', message: 'Command failed: curl -fsSL …' };
    expect(upgradeFailureReason(err)).toBe('curl: (22) The requested URL returned error: 503');
    expect(upgradeFailureReason({ stderr: Buffer.from('curl: (6) Could not resolve host: getorigin.io\n') })).toBe('curl: (6) Could not resolve host: getorigin.io');
  });

  it('falls back to the error message, then to something', () => {
    expect(upgradeFailureReason(new Error('staged install did not report 0.20261029.307'))).toBe('staged install did not report 0.20261029.307');
    expect(upgradeFailureReason({})).toBe('unknown error');
  });
});
