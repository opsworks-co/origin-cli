import { describe, it, expect } from 'vitest';
import { windowsNotifyScript } from '../session-limits.js';

// Desktop notifications were macOS + Linux only; Windows silently got nothing.
// The Windows path builds a PowerShell script, so the title and body — which
// carry session titles and prompt text — must be inert data, never code.
describe('windowsNotifyScript', () => {
  // Everything user-supplied has to live inside single-quoted PowerShell
  // literals, the only string form that interpolates nothing.
  const outsideLiterals = (s: string) => s.replace(/'(?:[^']|'')*'/g, '');

  it('doubles embedded single quotes so the literal cannot be closed early', () => {
    const s = windowsNotifyScript("it's", "o'clock");
    expect(s).toContain("'it''s'");
    expect(s).toContain("'o''clock'");
  });

  it('leaves no subexpression or backtick escape outside a literal', () => {
    const s = windowsNotifyScript('$(Get-Date)', 'tick `n tock $env:PATH');
    const rest = outsideLiterals(s);
    expect(rest).not.toContain('$(');
    expect(rest).not.toContain('`');
    expect(rest).not.toContain('$env:');
  });

  it('contains an injection attempt as data rather than a statement', () => {
    const s = windowsNotifyScript("'; Remove-Item C:\\ -Recurse; '", 'body');
    expect(outsideLiterals(s)).not.toContain('Remove-Item');
  });

  it('still produces a runnable-looking balloon for ordinary input', () => {
    const s = windowsNotifyScript('Origin', 'Session limit reached');
    expect(s).toContain('System.Windows.Forms.NotifyIcon');
    expect(s).toContain("$n.ShowBalloonTip(5000, 'Origin', 'Session limit reached'");
    expect(s).toContain('$n.Dispose()');
  });

  // The balloon dies with the process, so the sleep has to finish well inside
  // the caller's 8s execFile timeout — otherwise the kill dismisses the popup.
  it('sleeps less than the caller timeout', () => {
    const ms = Number(windowsNotifyScript('a', 'b').match(/Start-Sleep -Milliseconds (\d+)/)?.[1]);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThan(8000);
  });
});
