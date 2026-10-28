/**
 * Memory is pushed by default, so `origin sync` only explains a held-back push
 * when something turned it off. "opted out" alone left people stuck — no
 * command flips the switch — so the line names the key and the file to edit.
 */
import { describe, it, expect } from 'vitest';
import chalk from 'chalk';
import { describeMemoryOptOut } from '../commands/sync.js';

chalk.level = 0;
const root = '/work/rhodecode-enterprise-ce';
const text = (d: Parameters<typeof describeMemoryOptOut>[0]) => describeMemoryOptOut(d, root).join('\n');

describe('describeMemoryOptOut', () => {
  it('a machine-wide notesPushMemory: false names the machine file first, and the repo file', () => {
    const out = text({ source: 'machine', key: 'notesPushMemory' });
    expect(out).toMatch(/notesPushMemory is false in ~\/\.origin\/config\.json/);
    expect(out).toContain(`{"notesPushMemory": true} in ${root}/.origin.json`);
    expect(out).toMatch(/Prompt text stays out of pushed memory unless notesIncludePrompts is true/);
  });

  it('the older notesIncludePrompts: false is named as what keeps memory local', () => {
    expect(text({ source: 'machine', key: 'notesIncludePrompts' })).toMatch(/notesIncludePrompts is false in ~\/\.origin\/config\.json, which also keeps memory on this machine/);
    expect(text({ source: 'repo', key: 'notesIncludePrompts' })).toContain(`notesIncludePrompts is false in ${root}/.origin.json`);
  });

  it('a repo decision points only at the repo file — the machine cannot override it', () => {
    for (const d of [{ source: 'repo', key: 'notesPushMemory' }, { source: 'repo-invalid' }] as const) {
      const out = text(d);
      expect(out, d.source).toContain(`"notesPushMemory": true in ${root}/.origin.json`);
      expect(out, d.source).not.toContain('~/.origin/config.json');
    }
    expect(text({ source: 'repo-invalid' })).toMatch(/not a valid config/);
  });
});
