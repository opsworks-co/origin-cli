// `origin link --list` and `--unlink` were accepted but ignored: --unlink fell
// through to "show the mapping" and `origin link <slug> --list` linked the repo.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadRepoConfig: vi.fn(),
  saveRepoConfig: vi.fn(),
  clearRepoConfig: vi.fn(),
  getAgents: vi.fn(),
}));

vi.mock('../config.js', () => ({
  loadConfig: () => ({ apiKey: 'k', apiUrl: 'https://example.test' }),
  loadRepoConfig: mocks.loadRepoConfig,
  saveRepoConfig: mocks.saveRepoConfig,
  clearRepoConfig: mocks.clearRepoConfig,
}));
vi.mock('../api.js', () => ({ api: { getAgents: mocks.getAgents } }));
vi.mock('../session-state.js', () => ({ getGitRoot: () => '/repo' }));
vi.mock('../git-notes.js', () => ({ syncNotesFromRemote: vi.fn() }));

import { linkCommand } from '../commands/link.js';

describe('origin link', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mocks.loadRepoConfig.mockReturnValue({ agent: 'cursor-frontend' });
    mocks.getAgents.mockResolvedValue([{ slug: 'claude-x', status: 'ACTIVE', name: 'X', model: 'm' }]);
  });

  it('--unlink removes the mapping, like --clear', async () => {
    await linkCommand(undefined, { unlink: true });
    expect(mocks.clearRepoConfig).toHaveBeenCalledWith('/repo');
  });

  it('--clear still removes the mapping', async () => {
    await linkCommand(undefined, { clear: true });
    expect(mocks.clearRepoConfig).toHaveBeenCalledWith('/repo');
  });

  it('--list shows the mapping and links nothing, even with a slug', async () => {
    await linkCommand('claude-x', { list: true });
    expect(mocks.loadRepoConfig).toHaveBeenCalledWith('/repo');
    expect(mocks.saveRepoConfig).not.toHaveBeenCalled();
    expect(mocks.clearRepoConfig).not.toHaveBeenCalled();
  });

  it('a slug with no flag links the repo', async () => {
    await linkCommand('claude-x', {});
    expect(mocks.saveRepoConfig).toHaveBeenCalledWith('/repo', { agent: 'claude-x' });
  });
});
