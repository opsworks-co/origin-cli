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
  cleanupLegacyCursorProjectConfig,
  mcpConfigPath,
  mcpServerCommand,
  MCP_SUPPORTED_AGENTS,
  mcpCapable,
  mcpAgentsForEnable,
  isProjectScopedMcpAgent,
  preferSpawnableBin,
} from '../mcp/install.js';

let root: string;
let home: string;
let realHome: string | undefined;
let realUserProfile: string | undefined;

// os.homedir() reads $HOME on POSIX but %USERPROFILE% on Windows. Overriding
// only HOME left every home-scoped agent (codex, gemini, antigravity, copilot,
// and now cursor) writing to the RUNNER'S REAL HOME on the Windows leg — shared
// across tests in this file, so state bled between them. It surfaced as a
// backup assertion reading a value another test had written ('keepme' where
// 'v1' was expected), which looks like a bug in backupOnce and is really a
// broken fixture. Redirect both.
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-mcp-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-home-'));
  realHome = process.env.HOME;
  realUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});

afterEach(() => {
  if (realHome !== undefined) process.env.HOME = realHome; else delete process.env.HOME;
  if (realUserProfile !== undefined) process.env.USERPROFILE = realUserProfile;
  else delete process.env.USERPROFILE;
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

// os.homedir() now resolves to the per-test temp home on both platforms.
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
  it('covers every agent with a known MCP config location', () => {
    // Devin is absent because it needs no entry (it reads the project
    // .mcp.json); Aider because it has no MCP client at all.
    expect([...MCP_SUPPORTED_AGENTS].sort())
      .toEqual(['antigravity', 'claude', 'codex', 'copilot', 'cursor', 'gemini']);
  });

  it('puts each agent in its own documented location', () => {
    expect(mcpConfigPath('claude', root)).toBe(path.join(root, '.mcp.json'));
    expect(mcpConfigPath('cursor', root)).toBe(path.join(os.homedir(), '.cursor', 'mcp.json'));
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

describe('mcp install — Windows binary resolution', () => {
  // The bug: npm installs `origin` as BOTH an extensionless `#!/bin/sh` shim
  // and an `origin.cmd`, and `where origin` lists the SHIM FIRST. Taking the
  // first line recorded a path Windows cannot spawn — CreateProcess does not
  // read shebangs — so Antigravity showed a server that failed on launch, and
  // the mcpCapable probe (execFile, no shell) hit ENOENT and refused to install
  // at all, blaming an "older release".
  const npmPair = [
    'C:\\Users\\u\\AppData\\Roaming\\npm\\origin',
    'C:\\Users\\u\\AppData\\Roaming\\npm\\origin.cmd',
  ];

  it('skips the sh shim for the .cmd Windows can actually launch', () => {
    expect(preferSpawnableBin(npmPair, 'win32')).toBe(npmPair[1]);
  });

  it('leaves POSIX alone — one name, one file, already executable', () => {
    expect(preferSpawnableBin(['/usr/local/bin/origin'], 'darwin')).toBe('/usr/local/bin/origin');
    // Order must survive: on POSIX the first hit is the one the shell would run.
    expect(preferSpawnableBin(npmPair, 'linux')).toBe(npmPair[0]);
  });

  it('appends an extension when `where` reported only the shim', () => {
    const shim = path.join(root, 'origin');
    fs.writeFileSync(shim, '#!/bin/sh\n');
    fs.writeFileSync(`${shim}.cmd`, '@echo off\r\n');
    expect(preferSpawnableBin([shim], 'win32')).toBe(`${shim}.cmd`);
  });

  it('prefers a real .exe over a .cmd wrapper', () => {
    expect(preferSpawnableBin(['C:\\bin\\origin.cmd', 'C:\\bin\\origin.exe'], 'win32'))
      .toBe('C:\\bin\\origin.exe');
  });

  it('falls back to the only candidate rather than returning nothing', () => {
    // No sibling exists on disk — better a path that might work than null,
    // which would silently degrade the config to a bare `origin`.
    expect(preferSpawnableBin(['C:\\nowhere\\origin'], 'win32')).toBe('C:\\nowhere\\origin');
    expect(preferSpawnableBin([], 'win32')).toBeNull();
  });
});

describe('mcp registration during enable/disable (Phase 2)', () => {
  it('maps pipeline agent types to the MCP agents we support', () => {
    expect(mcpAgentsForEnable(['claude-code', 'codex', 'gemini', 'cursor'], false))
      .toEqual(['claude', 'codex', 'gemini', 'cursor']);
  });

  it('ignores agents with no verified MCP path', () => {
    // Aider gets hooks but no MCP registration — it has no MCP client. Devin
    // is excluded for the opposite reason: it already reads the project
    // .mcp.json (see below). Antigravity and Copilot both moved OUT of this
    // list once their paths and schemas were pinned down.
    expect(mcpAgentsForEnable(['devin', 'aider'], false)).toEqual([]);
  });

  it('deduplicates when several types map to one MCP agent', () => {
    expect(mcpAgentsForEnable(['claude-code', 'claude'], false)).toEqual(['claude']);
  });

  it('skips project-scoped agents under --global', () => {
    // Global enable's base path is the HOME dir. Claude Code reads .mcp.json
    // from the PROJECT root, so a ~/.mcp.json would never be read — writing it
    // would be the "config nothing reads" failure this module exists to avoid.
    expect(mcpAgentsForEnable(['claude-code', 'cursor', 'codex', 'gemini'], true))
      .toEqual(['cursor', 'codex', 'gemini']);
    expect(isProjectScopedMcpAgent('claude')).toBe(true);
    // Cursor moved to the global path — verified against a real install where
    // the project-scoped file was ignored by Cursor's agent runtime.
    expect(isProjectScopedMcpAgent('cursor')).toBe(false);
    expect(isProjectScopedMcpAgent('codex')).toBe(false);
    expect(isProjectScopedMcpAgent('gemini')).toBe(false);
  });

  it('disable removes the registration for every supported agent', () => {
    for (const agent of MCP_SUPPORTED_AGENTS) installMcpForAgent(agent, root);
    for (const agent of MCP_SUPPORTED_AGENTS) {
      expect(uninstallMcpForAgent(agent, root).status).toBe('updated');
    }
    // Leaving a live `origin mcp serve` pointer behind after the user asked us
    // to remove tracking is the bug this guards.
    const claude = JSON.parse(fs.readFileSync(mcpConfigPath('claude', root), 'utf-8'));
    expect(claude.mcpServers?.origin).toBeUndefined();
    expect(fs.readFileSync(codexPath(), 'utf-8')).not.toContain('[mcp_servers.origin]');
  });
});

describe('mcp install — antigravity (Phase 3)', () => {
  // Path AND schema recovered from the shipped `agy` binary, not guessed:
  // it carries `struct { McpServers map[string]common.MCPServerConfig
  // "json:\"mcpServers\"" }` plus a troubleshooting string naming
  // mcp_config.json, and json tags for command/args/env/cwd.
  it('writes to ~/.gemini/config/mcp_config.json, not gemini-cli settings', () => {
    expect(mcpConfigPath('antigravity', root))
      .toBe(path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json'));
    // Must NOT collide with Gemini CLI, which lives one directory up.
    expect(mcpConfigPath('antigravity', root)).not.toBe(mcpConfigPath('gemini', root));
  });

  it('populates an EMPTY config file — the real-world starting state', () => {
    // On the machine this was verified against, mcp_config.json existed at
    // 0 bytes. JSON.parse throws on that, so a naive reader would crash or
    // silently skip.
    const file = mcpConfigPath('antigravity', root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    expect(installMcpForAgent('antigravity', root).status).toBe('installed');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(parsed.mcpServers.origin.args).toEqual(['mcp', 'serve']);
  });

  it('is global, not project-scoped, so --global enable covers it', () => {
    expect(isProjectScopedMcpAgent('antigravity')).toBe(false);
    expect(mcpAgentsForEnable(['antigravity'], true)).toEqual(['antigravity']);
  });

  it('is reachable from the enable path', () => {
    expect(mcpAgentsForEnable(['antigravity'], false)).toEqual(['antigravity']);
  });
});

describe('mcp — agents deliberately NOT registered', () => {
  it('has no entry for devin: it reads the project .mcp.json already', () => {
    // Verified on a real install — from a repo WITH .mcp.json, `devin mcp list`
    // reports the origin server; from a directory without one it reports none.
    // Adding a devin writer would duplicate the same registration.
    expect(MCP_SUPPORTED_AGENTS).not.toContain('devin' as any);
    expect(mcpAgentsForEnable(['devin'], false)).toEqual([]);
  });

  it('has no entry for aider — it ships no MCP client', () => {
    // Not "unverified": aider's MCP integration PRs were closed unmerged and
    // its config reference lists no MCP options. There is nothing to write.
    expect(mcpAgentsForEnable(['aider'], false)).toEqual([]);
  });
});

describe('mcp install — copilot CLI', () => {
  it('writes ~/.copilot/mcp-config.json, not the VS Code file', () => {
    // Copilot CLI and Copilot in VS Code are DIFFERENT configs: the CLI reads
    // ~/.copilot/mcp-config.json keyed by `mcpServers`; VS Code reads
    // .vscode/mcp.json keyed by `servers`. Writing the wrong one registers
    // nothing while reporting success.
    expect(mcpConfigPath('copilot', root))
      .toBe(path.join(os.homedir(), '.copilot', 'mcp-config.json'));
  });

  it('includes the transport `type` the CLI requires', () => {
    installMcpForAgent('copilot', root);
    const entry = JSON.parse(fs.readFileSync(mcpConfigPath('copilot', root), 'utf-8')).mcpServers.origin;
    expect(entry.type).toBe('local');   // omit this and the entry is rejected
    expect(entry.args).toEqual(['mcp', 'serve']);
  });

  it('leaves the other agents WITHOUT a type field', () => {
    installMcpForAgent('claude', root);
    const entry = JSON.parse(fs.readFileSync(mcpConfigPath('claude', root), 'utf-8')).mcpServers.origin;
    expect(entry.type).toBeUndefined();
  });

  it('is global scope, so --global enable covers it', () => {
    expect(isProjectScopedMcpAgent('copilot')).toBe(false);
    expect(mcpAgentsForEnable(['copilot'], true)).toEqual(['copilot']);
  });
});

describe('mcp install — cursor uses the GLOBAL path', () => {
  it('writes ~/.cursor/mcp.json, not <repo>/.cursor/mcp.json', () => {
    // Verified on a real install: Cursor restarted 30 minutes AFTER a
    // project-scoped <repo>/.cursor/mcp.json appeared, re-scanned its servers,
    // and still exposed only its two built-ins. Writing the global path and
    // restarting produced `user-origin` (status ready, 18 tools) in the agent
    // runtime's own registry at ~/.cursor/projects/<proj>/mcps/.
    expect(mcpConfigPath('cursor', root)).toBe(path.join(os.homedir(), '.cursor', 'mcp.json'));
    expect(mcpConfigPath('cursor', root)).not.toBe(path.join(root, '.cursor', 'mcp.json'));
  });

  it('is covered by --global enable now that it is not project-scoped', () => {
    expect(mcpAgentsForEnable(['cursor'], true)).toEqual(['cursor']);
  });

  it('still writes a plain command/args entry (no copilot-style type)', () => {
    installMcpForAgent('cursor', root);
    const entry = JSON.parse(fs.readFileSync(mcpConfigPath('cursor', root), 'utf-8')).mcpServers.origin;
    expect(entry.type).toBeUndefined();
    expect(entry.args).toEqual(['mcp', 'serve']);
  });
});

describe('mcp install — sweeping the pre-move Cursor project file', () => {
  const legacyPath = (r: string) => path.join(r, '.cursor', 'mcp.json');
  const writeLegacy = (r: string, body: unknown) => {
    fs.mkdirSync(path.join(r, '.cursor'), { recursive: true });
    fs.writeFileSync(legacyPath(r), JSON.stringify(body, null, 2));
  };
  const originEntry = { command: '/usr/local/bin/origin', args: ['mcp', 'serve'] };

  it('deletes a file Origin created, and the .cursor dir it created with it', () => {
    writeLegacy(root, { mcpServers: { origin: originEntry } });

    const r = installMcpForAgent('cursor', root);

    expect(r.legacy).toEqual({ file: legacyPath(root), action: 'removed-file' });
    expect(fs.existsSync(legacyPath(root))).toBe(false);
    expect(fs.existsSync(path.join(root, '.cursor'))).toBe(false);
    // The real registration still happened, at the global path.
    expect(JSON.parse(fs.readFileSync(mcpConfigPath('cursor', root), 'utf-8')).mcpServers.origin)
      .toBeTruthy();
  });

  it('keeps a .cursor dir that holds anything else', () => {
    writeLegacy(root, { mcpServers: { origin: originEntry } });
    fs.mkdirSync(path.join(root, '.cursor', 'rules'), { recursive: true });

    installMcpForAgent('cursor', root);

    expect(fs.existsSync(legacyPath(root))).toBe(false);
    expect(fs.existsSync(path.join(root, '.cursor', 'rules'))).toBe(true);
  });

  it('removes ONLY our entry when the file carries other servers', () => {
    writeLegacy(root, { mcpServers: { origin: originEntry, other: { command: 'keepme' } } });

    const r = installMcpForAgent('cursor', root);

    expect(r.legacy?.action).toBe('removed-entry');
    const left = JSON.parse(fs.readFileSync(legacyPath(root), 'utf-8'));
    expect(left.mcpServers.origin).toBeUndefined();
    expect(left.mcpServers.other.command).toBe('keepme');
  });

  // A backup sibling is proof the file predated Origin — deleting it would
  // destroy something we did not create.
  it('never deletes a file that existed before Origin, even if only our entry is left', () => {
    writeLegacy(root, { mcpServers: { origin: originEntry } });
    fs.writeFileSync(`${legacyPath(root)}.origin-backup`, '{"mcpServers":{}}');

    const r = installMcpForAgent('cursor', root);

    expect(r.legacy?.action).toBe('removed-entry');
    expect(fs.existsSync(legacyPath(root))).toBe(true);
  });

  it('preserves unrelated top-level keys instead of deleting the file', () => {
    writeLegacy(root, { mcpServers: { origin: originEntry }, somethingElse: { keep: true } });

    installMcpForAgent('cursor', root);

    const left = JSON.parse(fs.readFileSync(legacyPath(root), 'utf-8'));
    expect(left.somethingElse).toEqual({ keep: true });
    expect(left.mcpServers).toBeUndefined();
  });

  it('leaves a project file alone when it has no Origin entry', () => {
    writeLegacy(root, { mcpServers: { other: { command: 'keepme' } } });

    const r = installMcpForAgent('cursor', root);

    expect(r.legacy).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(legacyPath(root), 'utf-8')).mcpServers.other.command)
      .toBe('keepme');
  });

  it('reports nothing when there is no project file at all', () => {
    expect(cleanupLegacyCursorProjectConfig(root).action).toBe('none');
    expect(installMcpForAgent('cursor', root).legacy).toBeUndefined();
  });

  it('survives malformed JSON without throwing', () => {
    fs.mkdirSync(path.join(root, '.cursor'), { recursive: true });
    fs.writeFileSync(legacyPath(root), '{ not json');

    expect(() => cleanupLegacyCursorProjectConfig(root)).not.toThrow();
    expect(fs.existsSync(legacyPath(root))).toBe(true);
  });

  // `--uninstall` means "remove Origin", which has to include the stale file
  // even on a machine where the global config was never written.
  it('sweeps the legacy file on uninstall even with no global config present', () => {
    writeLegacy(root, { mcpServers: { origin: originEntry } });
    expect(fs.existsSync(mcpConfigPath('cursor', root))).toBe(false);

    const r = uninstallMcpForAgent('cursor', root);

    expect(r.legacy?.action).toBe('removed-file');
    expect(fs.existsSync(legacyPath(root))).toBe(false);
  });

  it('does not touch a project file for any other agent', () => {
    writeLegacy(root, { mcpServers: { origin: originEntry } });

    installMcpForAgent('claude', root);
    installMcpForAgent('gemini', root);

    expect(fs.existsSync(legacyPath(root))).toBe(true);
  });
});

// The scope rules live in code AND in prose the user reads. When Cursor moved
// to the global path the code was updated and two sentences were not: the
// `enable --global` hint still sent people to run a per-repo install for
// Cursor, which does nothing. Behaviour tests can't catch a stale sentence, so
// assert on the source.
describe('scope prose matches scope behaviour', () => {
  const read = (rel: string) =>
    fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8');

  it('never tells the user Cursor is per-repo', () => {
    for (const f of ['commands/enable.ts', 'commands/mcp-install.ts', 'mcp/install.ts']) {
      const src = read(f);
      // Match the claim, not any mention: Cursor may legitimately appear
      // alongside Claude Code in text about approval prompts.
      expect(src, `${f} calls Cursor per-repo/project-scoped`).not.toMatch(
        /Cursor (are|is) (per-repo|project-scoped)|Claude Code and Cursor are (per-repo|registered PROJECT-scoped)/,
      );
    }
  });

  it('keeps claude as the only project-scoped agent', () => {
    const projectScoped = MCP_SUPPORTED_AGENTS.filter(isProjectScopedMcpAgent);
    expect(projectScoped).toEqual(['claude']);
  });
});
