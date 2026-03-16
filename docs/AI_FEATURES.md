# AI Features: Blame, Ask the Author, Git Notes

Origin provides three features for understanding AI-generated code: who wrote it, why, and portable attribution metadata.

---

## 1. AI Blame (Line-Level Attribution)

Shows which AI prompt produced each line of code in a session. Like `git blame`, but for AI.

### How to Use (Dashboard)

1. Go to **Sessions** and click any session
2. Click the **AI Blame** tab (between Session and Security)
3. Select a file from the dropdown
4. Each line shows:
   - **Line number** on the left
   - **Prompt badge** (P1, P2, etc.) showing which prompt wrote it
   - **Code content**
   - **Ask** button to ask why that line was written

Color-coded borders and a legend at the top map prompts to colors. Hover over a prompt in the legend to highlight all lines it produced.

### How It Works

The blame engine walks through each `PromptChange` record (ordered by prompt index) and parses its unified diff to determine which lines were added or modified. Later prompts override earlier attributions for the same line numbers, so the final view reflects the most recent edit.

No pre-computation is needed. All data comes from the `PromptChange.diff` field that the CLI already captures at session-end.

### API

```
GET /api/sessions/:id/blame?file=<filepath>
Authorization: Bearer <token>
```

Response:
```json
{
  "file": "src/routes/auth.ts",
  "sessionId": "uuid",
  "model": "claude-sonnet-4-20250514",
  "totalAttributedLines": 47,
  "lines": [
    {
      "lineNumber": 1,
      "content": "import express from 'express';",
      "attribution": {
        "promptIndex": 0,
        "promptText": "Add JWT authentication...",
        "type": "added"
      }
    }
  ],
  "prompts": [
    {
      "promptIndex": 0,
      "promptText": "Add JWT authentication...",
      "filesChanged": ["src/routes/auth.ts", "src/middleware/auth.ts"]
    }
  ]
}
```

---

## 2. Ask the Author

Ask natural-language questions about a coding session. Origin feeds the session's full transcript and code diffs to Claude, which explains *why* code was written the way it was.

### How to Use (Dashboard)

1. Go to any session detail page
2. Click the **Ask** button (top-right of the tab bar)
3. A chat panel slides open on the right
4. Type a question like:
   - "Why was this approach chosen?"
   - "What trade-offs were considered?"
   - "Why was line 42 in auth.ts written this way?"
5. The AI responds with context from the actual conversation transcript

You can also trigger Ask from the **AI Blame** tab: hover over any line and click "Ask" to pre-fill a question about that specific line.

### How It Works

The endpoint loads the session's transcript (the full human/AI conversation stored as JSON), all prompt diffs, and session metadata. It builds a system prompt with this context and calls Claude to answer your question.

Supports multi-turn conversation (follow-up questions keep the chat history).

If you provide file or prompt context, only the relevant diffs are included, making answers more focused.

### API

```
POST /api/sessions/:id/ask
Authorization: Bearer <token>
Content-Type: application/json

{
  "question": "Why was Redis chosen over in-memory caching?",
  "context": {
    "file": "src/cache.ts",
    "promptIndex": 3
  }
}
```

Response:
```json
{
  "answer": "Based on the transcript, Redis was chosen in prompt #3 because..."
}
```

For follow-up questions, pass conversation history:
```json
{
  "messages": [
    { "role": "user", "content": "Why was Redis chosen?" },
    { "role": "assistant", "content": "Based on the transcript..." },
    { "role": "user", "content": "What about Memcached?" }
  ]
}
```

### Requirements

The `ANTHROPIC_API_KEY` environment variable must be set on the API server. Without it, the endpoint returns `503 AI chat is not configured`.

---

## 3. Git Notes (Portable Attribution)

Writes AI session metadata directly into your git history as Git Notes. This means attribution data travels with the repo when pushed.

### How It Works

At the end of every CLI-tracked session, Origin automatically writes a Git Note on each commit SHA produced during the session. Notes are stored under a custom ref (`refs/notes/origin`) to avoid conflicts with your own notes.

The note contains structured JSON:

```json
{
  "origin": {
    "version": 1,
    "sessionId": "uuid",
    "model": "claude-sonnet-4-20250514",
    "promptCount": 5,
    "promptSummary": "Add user authentication with JWT...",
    "tokensUsed": 15420,
    "costUsd": 0.12,
    "durationMs": 45000,
    "linesAdded": 120,
    "linesRemoved": 15,
    "originUrl": "https://getorigin.io/sessions/uuid",
    "timestamp": "2026-03-06T10:30:00Z"
  }
}
```

### Reading Notes

```bash
# Show the Origin note for a specific commit
git notes --ref=origin show HEAD

# Show notes for any commit SHA
git notes --ref=origin show abc1234

# List all commits that have Origin notes
git notes --ref=origin list
```

### Pushing Notes

Git Notes don't push by default. To share them:

```bash
# Push Origin notes to remote
git push origin refs/notes/origin

# Fetch Origin notes from remote
git fetch origin refs/notes/origin:refs/notes/origin
```

To auto-push notes, add to `.gitconfig`:

```ini
[remote "origin"]
    push = +refs/notes/origin:refs/notes/origin
    fetch = +refs/notes/origin:refs/notes/origin
```

### No Setup Required

Git Notes are written automatically by the CLI hooks whenever a session ends with commits. If note-writing fails (e.g., not a git repo), it fails silently and never blocks the session.

---

## Requirements Summary

| Feature | Needs | Where |
|---------|-------|-------|
| AI Blame | Session with `PromptChange` data | Dashboard tab |
| Ask the Author | `ANTHROPIC_API_KEY` env var | Dashboard panel + API |
| Git Notes | CLI hooks enabled (`origin enable`) | Automatic at session-end |

All three features work with data the CLI already captures. No schema changes or extra setup needed beyond what Origin already provides.
