/**
 * Protocol capabilities this CLI declares on every request to Origin's MCP
 * API (`X-Origin-Capabilities`). `rhodecode-remote-identity-1`: it sends the
 * remote of every repo a session touches (session/start `additionalRepos`,
 * attach-repo `repoUrl`). A server that governs prompts with RhodeCode refuses
 * writes from a client that does not declare it (OR-17,
 * apps/api/src/services/client-capability.ts).
 */
export const CLIENT_CAPABILITIES: readonly string[] = ['rhodecode-remote-identity-1'];

export const CAPABILITY_HEADERS: Record<string, string> = {
  'X-Origin-Capabilities': CLIENT_CAPABILITIES.join(','),
};

/**
 * What a REPLAYED payload was built with (update-queue.ts). The transport
 * header above says what the sending binary can do; a payload queued by an
 * older CLI was built without remotes, and this header keeps a fresh binary
 * from vouching for it. `none` when it was built with no capability.
 */
export function payloadCapabilityHeaders(capabilities: readonly string[]): Record<string, string> {
  return { 'X-Origin-Payload-Capabilities': capabilities.length > 0 ? capabilities.join(',') : 'none' };
}
