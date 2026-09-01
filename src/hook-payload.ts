// One payload shape for every agent's tool hooks.
//
// Each agent names the same three facts differently — Claude Code sends
// `tool_name` / `tool_input` / `session_id`, others send `toolName` /
// `toolInput` / `sessionId`, and Antigravity sends `toolCall: {name, args}`.
// Every handler that reached for `input.tool_name` therefore worked for
// exactly the agents it was written against and silently did nothing for the
// rest — a no-op that looks identical to "this agent has no tool hooks".
//
// Normalising once, at the edge, means a new agent needs a hook wired and
// nothing else. Fields are only FILLED IN, never overwritten, so an agent that
// already speaks the canonical shape is untouched.
export function normalizeToolHookPayload(input: Record<string, any>): Record<string, any> {
  if (!input || typeof input !== 'object') return input;
  const out: Record<string, any> = { ...input };

  const pick = (...keys: string[]): unknown => {
    for (const k of keys) {
      const v = out[k];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  };

  // Antigravity nests both under `toolCall`; take it as a source for either.
  const toolCall = (out.toolCall && typeof out.toolCall === 'object') ? out.toolCall as Record<string, any> : null;

  if (out.tool_name === undefined) {
    const n = pick('toolName', 'tool', 'name') ?? (toolCall ? toolCall.name : undefined);
    if (typeof n === 'string' && n) out.tool_name = n;
  }
  if (out.tool_input === undefined) {
    const i = pick('toolInput', 'input', 'args', 'params', 'parameters')
      ?? (toolCall ? (toolCall.args ?? toolCall.input ?? toolCall.params) : undefined);
    if (i && typeof i === 'object') out.tool_input = i;
  }
  if (out.session_id === undefined) {
    const s = pick('sessionId', 'conversationId', 'conversation_id');
    if (typeof s === 'string' && s) out.session_id = s;
  }
  if (out.cwd === undefined) {
    const c = pick('workingDirectory', 'working_directory', 'projectRoot', 'project_root');
    if (typeof c === 'string' && c) out.cwd = c;
    else if (Array.isArray(out.workspacePaths) && typeof out.workspacePaths[0] === 'string') {
      out.cwd = out.workspacePaths[0];
    }
  }
  return out;
}
