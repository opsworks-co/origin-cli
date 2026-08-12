/**
 * `origin mcp serve` — the MCP server folded into the CLI (was
 * packages/mcp-server, a separate package that `origin enable` never installed
 * and the release pipeline never shipped; it sat at 0.1.0 for a month).
 *
 * These pin the properties that make it usable at all, each of which the split
 * package got wrong or couldn't have:
 *   1. It is reachable as a CLI subcommand.
 *   2. It reports the CLI's version — one artifact, one version number.
 *   3. It uses the CLI's shared HTTP client, not a second fetch + config loader.
 *   4. stdout stays clean: it is the JSON-RPC channel, and one stray line
 *      breaks the client handshake.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => fs.readFileSync(path.join(SRC, p), 'utf-8');

describe('origin mcp serve — wiring', () => {
  it('is registered as a subcommand in the CLI entrypoint', () => {
    const index = read('index.ts');
    expect(index).toContain("program.command('mcp')");
    expect(index).toContain("mcp.command('serve')");
    expect(index).toContain('mcpServeCommand');
  });

  it('lives inside the CLI package — the standalone package is gone', () => {
    expect(fs.existsSync(path.join(SRC, 'mcp/server.ts'))).toBe(true);
    expect(fs.existsSync(path.join(SRC, 'mcp/file-context.ts'))).toBe(true);
    // The old package must not come back — two copies is how it rotted.
    expect(fs.existsSync(path.resolve(SRC, '../../mcp-server/package.json'))).toBe(false);
  });

  it('reports the CLI version, not a hardcoded one', () => {
    const server = read('mcp/server.ts');
    expect(server).toContain('version: cliVersion()');
    expect(server).not.toContain("version: '0.1.0'");
  });

  it('rides the CLI shared request client (no duplicate fetch/config loader)', () => {
    const api = read('mcp/api.ts');
    expect(api).toContain("from '../api.js'");
    // The duplicate had its own fetch + X-API-Key assembly. Neither should return.
    expect(api).not.toContain('X-API-Key');
    expect(api).not.toMatch(/await fetch\(/);
    expect(fs.existsSync(path.join(SRC, 'mcp/config.ts'))).toBe(false);
  });

  it('keeps every diagnostic off stdout — stdout is the protocol channel', () => {
    const server = read('mcp/server.ts');
    const cmd = read('commands/mcp.ts');
    // console.log writes to stdout and would corrupt JSON-RPC framing.
    expect(server).not.toMatch(/console\.log\(/);
    expect(cmd).not.toMatch(/console\.log\(/);
    // Diagnostics go to stderr instead.
    expect(server).toMatch(/console\.error\(/);
  });

  it('starts even with no Origin config — the git-notes half works offline', () => {
    const server = read('mcp/server.ts');
    // runMcpServer must connect the transport regardless of loadConfig();
    // an early return/throw would take get_file_context down with the
    // server-backed tools on a fresh clone with no account.
    const body = server.slice(server.indexOf('export async function runMcpServer'));
    expect(body).toContain('server.connect(transport)');
    expect(body).not.toMatch(/if \(!config\)[\s\S]{0,80}return;/);
  });
});
