/**
 * `origin mcp install` — Phase 1 agent registration.
 *
 * The failure mode these guard against is not a crash, it's a no-op that
 * reports success: a config written to the wrong key, a duplicate block, or a
 * bare `origin` command that never spawns because the agent's PATH lacks it.
 * All three look exactly like "installed" until someone checks the agent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  installMcpForAgent,
  uninstallMcpForAgent,
  mcpConfigPath,
  mcpServerCommand,
  MCP_PHASE1_AGENTS,
  mcpCapable,
} from '../mcp/install.js';

let root: string;
let home: string;
let realHome: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-mcp-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-home-'));
  realHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(() => {
  if (realHome !== undefined) process.env.HOME = realHome;
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

// os.homedir() reads $HOME on POSIX, which the hooks above redirect.
const codexPath = () => path.join(os.homedir(), '.codex', 'config.toml');

describe('mcp install — JSON agents (claude, cursor, gemini)', () => {
  it('writes the server under mcpServers.origin', () => {
    const r = installMcpForAgent('claude', root);
    expect(r.status).toBe('installed');
    const parsed = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf-8'));
    expect(parsed.mcpServers.origin.args).toEqual(['mcp', 'serve']);
  });

  it('never writes a bare `origin` when the binary resolves', () => {
    // A bare command assumes the agent inherits the user's PATH. That
    // assumption is what silently broke every Windows git hook in #1037.
    const { command } = mcpServerCommand();
    installMcpForAgent('cursor', root);
    const parsed = JSON.parse(fs.readFileSync(mcpConfigPath('cursor', root), 'utf-8'));
    expect(parsed.mcpServers.origin.command).toBe(command);
    if (command !== 'origin') expect(path.isAbsolute(command)).toBe(true);
  });

  it('preserves unrelated MCP servers already configured', () => {
    const file = mcpConfigPath('cursor', root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: 'keepme' } } }));
    installMcpForAgent('cursor', root);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(parsed.mcpServers.other.command).toBe('keepme');
    expect(parsed.mcpServers.origin).toBeTruthy();
  });

  it('preserves unrelated top-level settings (gemini shares its hooks file)', () => {
    const file = mcpConfigPath('gemini', root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ general: { vimMode: false }, hooks: { x: 1 } }));
    installMcpForAgent('gemini', root);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(parsed.general).toEqual({ vimMode: false });
    expect(parsed.hooks).toEqual({ x: 1 });
    expect(parsed.mcpServers.origin).toBeTruthy();
  });

  it('is idempotent — a second run reports unchanged', () => {
    expect(installMcpForAgent('claude', root).status).toBe('installed');
    expect(installMcpForAgent('claude', root).status).toBe('unchanged');
  });

  it('backs up the pre-Origin file once, keeping the ORIGINAL', () => {
    const file = mcpConfigPath('cursor', root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: 'v1' } } }));
    installMcpForAgent('cursor', root);
    const bak = `${file}.origin-backup`;
    expect(fs.existsSync(bak)).toBe(true);
    // A later re-install must not overwrite the backup with an Origin-modified copy.
    fs.writeFileSync(file, JSON.stringify({ mcpServers: {} }));
    installMcpForAgent('cursor', root);
    expect(JSON.parse(fs.readFileSync(bak, 'utf-8')).mcpServers.other.command).toBe('v1');
  });

  it('uninstall removes only Origin, leaving other servers intact', () => {
    const file = mcpConfigPath('cursor', root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: 'keepme' } } }));
    installMcpForAgent('cursor', root);
    expect(uninstallMcpForAgent('cursor', root).status).toBe('updated');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(parsed.mcpServers.other.command).toBe('keepme');
    expect(parsed.mcpServers.origin).toBeUndefined();
  });

  it('survives a corrupt config rather than throwing', () => {
    const file = mcpConfigPath('claude', root);
    fs.writeFileSync(file, '{ this is not json');
    expect(installMcpForAgent('claude', root).status).toBe('installed');
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).mcpServers.origin).toBeTruthy();
  });
});

describe('mcp install — codex TOML', () => {
  const seed = () => {
    const file = codexPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file,
      'notify = ["something"]\n\n# my own comment\n[projects."/tmp/x"]\ntrust_level = "trusted"\n\n' +
      '[mcp_servers.other]\ncommand = "keepme"\n');
    return file;
  };

  it('appends a block without disturbing comments or other tables', () => {
    const file = seed();
    expect(installMcpForAgent('codex', root).status).toBe('installed');
    const body = fs.readFileSync(file, 'utf-8');
    expect(body).toContain('# my own comment');
    expect(body).toContain('[projects."/tmp/x"]');
    expect(body).toContain('[mcp_servers.other]');
    expect(body).toContain('[mcp_servers.origin]');
    expect(body).toContain('args = ["mcp", "serve"]');
  });

  it('never duplicates the block across repeated installs', () => {
    seed();
    installMcpForAgent('codex', root);
    installMcpForAgent('codex', root);
    installMcpForAgent('codex', root);
    const body = fs.readFileSync(codexPath(), 'utf-8');
    expect(body.match(/\[mcp_servers\.origin\]/g)?.length).toBe(1);
    expect(installMcpForAgent('codex', root).status).toBe('unchanged');
  });

  it('uninstall strips only Origin, leaving the rest of the file', () => {
    const file = seed();
    installMcpForAgent('codex', root);
    expect(uninstallMcpForAgent('codex', root).status).toBe('updated');
    const body = fs.readFileSync(file, 'utf-8');
    expect(body).not.toContain('[mcp_servers.origin]');
    expect(body).not.toContain('Origin MCP server');
    expect(body).toContain('[mcp_servers.other]');
    expect(body).toContain('trust_level = "trusted"');
    expect(body).toContain('# my own comment');
  });

  it('uninstall on a file Origin never touched is a no-op', () => {
    seed();
    expect(uninstallMcpForAgent('codex', root).status).toBe('unchanged');
  });
});

describe('mcp install — agent scope', () => {
  it('covers exactly the four verified agents', () => {
    // Copilot/Devin/Antigravity/Aider are deliberately excluded until their
    // MCP config path is confirmed against a real install. A config written
    // where nothing reads it is worse than none — it reports success.
    expect([...MCP_PHASE1_AGENTS].sort()).toEqual(['claude', 'codex', 'cursor', 'gemini']);
  });

  it('puts each agent in its own documented location', () => {
    expect(mcpConfigPath('claude', root)).toBe(path.join(root, '.mcp.json'));
    expect(mcpConfigPath('cursor', root)).toBe(path.join(root, '.cursor', 'mcp.json'));
    expect(mcpConfigPath('codex', root)).toBe(path.join(os.homedir(), '.codex', 'config.toml'));
    expect(mcpConfigPath('gemini', root)).toBe(path.join(os.homedir(), '.gemini', 'settings.json'));
  });
});

describe('mcp install — binary capability guard', () => {
  // A stand-in `origin` that exits with `code`. On Windows this MUST be a .cmd:
  // there is no #!/bin/sh, and .cmd is also the shape npm actually installs, so
  // the fixture exercises the same shell path production takes there.
  const fakeBin = (name: string, code: number): string => {
    if (process.platform === 'win32') {
      const p = path.join(root, `${name}.cmd`);
      fs.writeFileSync(p, `@echo off\r\nexit /b ${code}\r\n`);
      return p;
    }
    const p = path.join(root, name);
    fs.writeFileSync(p, `#!/bin/sh\nexit ${code}\n`);
    fs.chmodSync(p, 0o755);
    return p;
  };

  it('rejects a binary that does not know the `mcp` command', () => {
    // The real failure: `origin mcp install` from a source checkout resolves
    // `origin` to the last RELEASED build, which predates the MCP fold and
    // answers "unknown command 'mcp'" with exit 1. Recording it hands the
    // agent a server that dies on spawn — present, broken, silent.
    expect(mcpCapable(fakeBin('fake-origin', 1))).toBe(false);
  });

  it('accepts a binary whose `mcp status` succeeds', () => {
    // Guards the Windows .cmd path specifically: Node cannot execFile a .cmd
    // without a shell, so an unguarded probe throws EINVAL and reads as
    // "incapable" — which would refuse to install on every Windows machine.
    expect(mcpCapable(fakeBin('ok-origin', 0))).toBe(true);
  });

  it('reports incapable rather than throwing when the binary is missing', () => {
    expect(mcpCapable(path.join(root, 'does-not-exist'))).toBe(false);
  });
});
