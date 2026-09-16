import fs from 'fs';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

export interface NativeCommitEvidence {
  sha: string;
  promptText: string;
  nativeTurnId: string;
  replaces?: string;
}

/** Split a simple command list without treating separators in quotes as shell
 * syntax. Pipelines, substitutions and background execution are not proof. */
function simpleCommandList(command: string): string[] | null {
  if (/[`<>]|\$\(/.test(command)) return null;
  const parts: string[] = [];
  let start = 0;
  let quote = '';
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === '\\' && quote !== "'") { i++; continue; }
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === '|') return null;
    if (c === '&' && command[i + 1] !== '&') return null;
    if (c === ';' || c === '\n' || c === '&') {
      parts.push(command.slice(start, i).trim());
      if (c === '&') i++;
      start = i + 1;
    }
  }
  if (quote) return null;
  parts.push(command.slice(start).trim());
  return parts.filter(Boolean);
}

export function nativeCommitOwners(
  native: NativeCommitEvidence[],
  mappings: Array<{ promptIndex: number; promptText: string; commitSha?: string | null; diff?: string | null; filesChanged: string[] }>,
  details: Array<{ sha: string; filesChanged?: string[] }>,
  matchesText: (a: string, b: string) => boolean = (a, b) => a.trim() === b.trim(),
): Array<{ sha: string; promptIndex: number }> {
  return native.flatMap(c => {
    const named = mappings.filter(pm => pm.commitSha && (c.sha.startsWith(pm.commitSha) || pm.commitSha.startsWith(c.sha)));
    const matching = mappings.filter(pm => matchesText(pm.promptText, c.promptText));
    let owner = named.length === 1 ? named[0] : matching.length === 1 ? matching[0] : undefined;
    if (!owner) return []; // Repeated prompts do not establish identity.
    if (!owner.diff?.trim()) {
      const files = details.find(d => d.sha === c.sha)?.filesChanged || [];
      const authors = mappings.filter(pm => pm.promptIndex < owner!.promptIndex && pm.diff?.trim()
        && files.length > 0 && pm.filesChanged.length === files.length
        && files.every(f => pm.filesChanged.includes(f)));
      if (authors.length) owner = authors.sort((a, b) => b.promptIndex - a.promptIndex)[0];
    }
    return [{ sha: c.sha, promptIndex: owner.promptIndex }];
  });
}

/** Recover missed hooks from successful native executions in this checkout.
 * Tool wrapper text, git-log output and commands in other repos are not proof.
 * Deliberately accept only simple git command lines; complex shell programs
 * keep their existing capture path rather than guessing where they committed.
 */
export function codexNativeCommits(rollout: string, repoPath: string): NativeCommitEvidence[] {
  const git = (...args: string[]) => {
    try { return execFileSync('git', args, { cwd: repoPath, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch { return null; }
  };
  const prompts = new Map<string, string>();
  const out: NativeCommitEvidence[] = [];
  const previousByBranch = new Map<string, NativeCommitEvidence>();
  let contextId = '';
  for (const line of rollout.split('\n')) {
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    const p = e?.payload;
    if (e?.type === 'turn_context' && typeof p?.turn_id === 'string') contextId = p.turn_id;
    if (p?.type === 'message' && p.role === 'user') {
      const text = typeof p.content === 'string' ? p.content : Array.isArray(p.content)
        ? p.content.map((c: any) => c?.text || '').join('') : '';
      const id = p.internal_chat_message_metadata_passthrough?.turn_id || contextId;
      if (id && text && !text.includes('<!-- origin-managed -->')
        && !/^#\s+AGENTS\.md instructions for /m.test(text)
        && !/^\s*<(?:environment_context|INSTRUCTIONS)>/.test(text)) prompts.set(id, text.trim());
    }
    const item = p?.item;
    if (e?.type !== 'event_msg' || p?.type !== 'item_completed'
      || item?.type !== 'CommandExecution' || item.exit_code !== 0) continue;
    const promptText = prompts.get(p.turn_id);
    if (!promptText || !Array.isArray(item.command)) continue;
    try {
      const cwd = item.cwd?.startsWith('file:') ? fileURLToPath(item.cwd) : item.cwd;
      if (fs.realpathSync(cwd) !== fs.realpathSync(repoPath)) continue;
    } catch { continue; }
    const command = item.command.at(-1);
    if (typeof command !== 'string') continue;
    const lines = simpleCommandList(command);
    if (!lines?.length || !lines.every((l: string) => /^git (?:add|diff|commit)\b/.test(l))) continue;
    const commits = lines.filter((l: string) => /^git commit\b/.test(l));
    if (commits.length !== 1) continue;
    const match = typeof item.stdout === 'string' && item.stdout.match(/^\[([^\]\n]+) ([a-f0-9]{7,40})\] /m);
    if (!match) continue;
    const sha = git('rev-parse', '--verify', `${match[2]}^{commit}`);
    if (!sha || out.some(c => c.sha === sha)) continue;
    const evidence: NativeCommitEvidence = { sha, promptText, nativeTurnId: p.turn_id };
    const previous = previousByBranch.get(match[1]);
    if (/\s--amend(?:\s|$)/.test(commits[0]) && previous && previous.nativeTurnId === p.turn_id
      && git('show', '-s', '--format=%P', previous.sha) === git('show', '-s', '--format=%P', sha)) {
      evidence.replaces = previous.sha;
    }
    out.push(evidence);
    previousByBranch.set(match[1], evidence);
  }
  return out;
}
