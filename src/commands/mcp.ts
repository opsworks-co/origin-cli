import { runMcpServer } from '../mcp/server.js';
/**
 * `origin mcp serve` — speak MCP over stdio so the agent can query Origin.
 *
 * Agents spawn this as a long-lived child process and talk JSON-RPC on
 * stdin/stdout. Two consequences shape this command:
 *
 *   1. NOTHING may be written to stdout except protocol frames. No banner, no
 *      chalk, no update-check notice. A single stray line makes the client
 *      fail to parse the handshake and the server silently "doesn't work".
 *   2. It must not exit on its own. The promise resolves when the transport
 *      closes (client went away), which is the normal shutdown path.
 */
export async function mcpServeCommand(): Promise<void> {
  try {
    await runMcpServer();
  } catch (err: any) {
    // stderr, not stdout — see above.
    console.error(`[origin-mcp] Fatal error: ${err?.message || err}`);
    process.exit(1);
  }
}
