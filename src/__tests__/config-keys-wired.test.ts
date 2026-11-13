// Every key `origin config` accepts has to be read somewhere, and every key
// the CLI tells a user to set has to be accepted.
//
// Both halves broke at once: the MCP server's review_session rejection said
// "To override: origin config set mcpAllowSelfReview true", and `config set`
// answered "Unknown config key". Meanwhile `config list` offered autoUpdate and
// hookChaining, which nothing read. Asserted through the built CLI, so the
// write (`config set`) and the read (the MCP server, the update notice) are the
// real ones, not two halves that each pass on their own.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../../dist/index.js');

let home: string;

function env() {
  return { ...process.env, HOME: home, USERPROFILE: home };
}

function cli(args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: home, encoding: 'utf-8', env: env() });
  if (r.error) throw r.error;
  return { out: r.stdout ?? '', err: r.stderr ?? '', code: r.status ?? 1 };
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(home, '.origin', 'config.json'), 'utf-8'));
}

/** initialize + tools/list over `origin mcp serve`; resolves with the tool names. */
function mcpToolNames(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'mcp', 'serve'], { cwd: home, stdio: ['pipe', 'pipe', 'ignore'], env: env() });
    let buf = '';
    let listed = false;
    const timer = setTimeout(() => { child.kill(); reject(new Error('timed out waiting for tools/list')); }, 30_000);
    child.stdout.on('data', (d) => {
      buf += d.toString();
      for (const line of buf.split('\n')) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 1 && !listed) {
            listed = true;
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
          }
          if (msg.id === 2) {
            clearTimeout(timer);
            child.kill();
            resolve((msg.result?.tools || []).map((t: { name: string }) => t.name));
            return;
          }
        } catch { /* partial line — wait for more */ }
      }
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'origin-test', version: '0.0.0' } },
    }) + '\n');
  });
}

describe('origin config — keys match what the CLI reads', () => {
  if (!fs.existsSync(CLI)) {
    it.skip('requires a built CLI (pnpm run build)', () => { /* skipped */ });
    return;
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-config-keys-'));
    fs.mkdirSync(path.join(home, '.origin'), { recursive: true });
    // `config set` refuses to run unconfigured. Port 9 (discard) so nothing
    // that does reach for the API gets an answer.
    fs.writeFileSync(path.join(home, '.origin', 'config.json'), JSON.stringify({
      apiUrl: 'http://127.0.0.1:9', apiKey: 'test-key', orgId: 'org-test', userId: 'user-test',
    }));
  });
  afterEach(() => {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('config set mcpAllowSelfReview true is accepted and turns on review_session', async () => {
    expect(await mcpToolNames()).not.toContain('review_session');

    const r = cli(['config', 'set', 'mcpAllowSelfReview', 'true']);
    expect(r.code, `stdout: ${r.out}\nstderr: ${r.err}`).toBe(0);
    expect(readConfig().mcpAllowSelfReview).toBe(true);

    expect(await mcpToolNames()).toContain('review_session');

    expect(cli(['config', 'set', 'mcp-allow-self-review', 'false']).code).toBe(0);
    expect(readConfig().mcpAllowSelfReview).toBe(false);
    expect(await mcpToolNames()).not.toContain('review_session');
  }, 90_000);

  it('autoUpdate false silences the update notice', () => {
    // A cached "latest" no release can overtake: the notice fires from cache,
    // with no network and no test-only switch.
    fs.writeFileSync(
      path.join(home, '.origin', 'last-update-check.json'),
      JSON.stringify({ latest: '99.99999999.9999', checkedAt: new Date().toISOString() }),
    );
    expect(cli(['config', 'get', 'apiUrl']).err).toContain('Update available');

    expect(cli(['config', 'set', 'autoUpdate', 'false']).code).toBe(0);
    const r = cli(['config', 'get', 'apiUrl']);
    expect(r.code).toBe(0);
    expect(r.err).not.toContain('Update available');
  });

  it('hookChaining is no longer offered — Origin always chains existing hooks', () => {
    expect(cli(['config', 'list']).out).not.toContain('hookChaining');
    const r = cli(['config', 'set', 'hookChaining', 'true']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('Unknown config key');
  });
});
