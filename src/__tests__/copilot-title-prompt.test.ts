import { describe, it, expect } from 'vitest';
import { isCopilotTitlePrompt } from '../copilot-title-session.js';

const wrap = (instruction: string, tag = 'user_message', body = 'fix the flaky watcher test') =>
  `${instruction}\n\n<${tag}>\n${body}\n</${tag}>`;

describe('isCopilotTitlePrompt', () => {
  it("matches the Copilot app's current template", () => {
    expect(isCopilotTitlePrompt(wrap("Name this session based on the user's first message:"))).toBe(true);
  });

  it('still matches when an app update rewords the sentence or renames the tag', () => {
    expect(isCopilotTitlePrompt(wrap('Generate a short title for this chat from the message below.'))).toBe(true);
    expect(isCopilotTitlePrompt(wrap('Suggest a concise name for the conversation, using the first message:'))).toBe(true);
    expect(isCopilotTitlePrompt(wrap('Title this thread:', 'first_message'))).toBe(true);
    expect(isCopilotTitlePrompt(wrap('Name this session:', 'user_request'))).toBe(true);
  });

  it('does not match a real prompt that only talks about naming sessions', () => {
    expect(isCopilotTitlePrompt('Rename the session title column in the sessions table')).toBe(false);
    expect(isCopilotTitlePrompt("Why does Copilot's naming session get the title 'Name this session'?")).toBe(false);
  });

  it('does not match pasted markup, even with the right words before it', () => {
    expect(isCopilotTitlePrompt(wrap('Add a title to the chat page:', 'div', '<h1>Chat</h1>'))).toBe(false);
    expect(isCopilotTitlePrompt(wrap('Put the session name in the header:', 'header', 'Origin'))).toBe(false);
  });

  it('does not match a message tag with no naming instruction, or a long preamble', () => {
    expect(isCopilotTitlePrompt(wrap('Summarise this for me:'))).toBe(false);
    expect(isCopilotTitlePrompt(wrap(`${'Some context. '.repeat(30)}Name this session:`))).toBe(false);
  });

  it('ignores non-strings', () => {
    expect(isCopilotTitlePrompt(undefined)).toBe(false);
    expect(isCopilotTitlePrompt({ prompt: 'x' })).toBe(false);
  });
});
