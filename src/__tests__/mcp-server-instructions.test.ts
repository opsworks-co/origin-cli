// MCP's `instructions` are returned on `initialize` and loaded into the
// client's context before the first prompt — the one delivery channel that does
// not depend on a hook firing.
//
// That matters because Origin's hook-borne startup directive cannot reach
// everyone: Antigravity has no SessionStart, Devin Desktop has no hooks at all,
// and a host can be configured with Origin's MCP server and none of its hooks.
// For those, this is the ONLY place a "read the memory first" instruction lives.
//
// Asserted over the real JSON-RPC handshake rather than by importing the
// constant: the field has to survive the SDK's initialize response to do
// anything, and a constant declared but never passed to the Server would pass
// any test that only read the constant.
import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(here, '../../dist/index.js');

function initialize(): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [distPath, 'mcp', 'serve'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env },
    });
    let buf = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('timed out waiting for initialize response')); }, 30_000);
    child.stdout.on('data', (d) => {
      buf += d.toString();
      // stdio transport is newline-delimited JSON-RPC.
      for (const line of buf.split('\n')) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 1) {
            clearTimeout(timer);
            child.kill();
            resolve(msg.result);
            return;
          }
        } catch { /* partial line — wait for more */ }
      }
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'origin-test', version: '0.0.0' },
      },
    }) + '\n');
  });
}

describe('origin mcp serve — initialize', () => {
  if (!fs.existsSync(distPath)) {
    it.skip('requires a built CLI (pnpm run build)', () => { /* skipped */ });
    return;
  }

  it('returns instructions telling the agent to read repo memory first', async () => {
    const result = await initialize();
    expect(typeof result.instructions).toBe('string');
    expect(result.instructions).toContain('get_repo_memory');
    // The ordering constraint is the whole point — a description of the tool
    // without "before your first substantive action" is what agents already
    // ignored.
    expect(result.instructions).toContain('BEFORE your first substantive action');
  }, 40_000);

  it('still reports the CLI version, not a second hardcoded one', async () => {
    // The standalone package sat at 0.1.0 for a month of CLI releases; adding a
    // field to this constructor is exactly when that regresses.
    const result = await initialize();
    expect(result.serverInfo?.name).toBe('origin-mcp-server');
    expect(result.serverInfo?.version).not.toBe('0.1.0');
  }, 40_000);
});
