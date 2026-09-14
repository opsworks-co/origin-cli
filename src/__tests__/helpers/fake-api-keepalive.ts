import type http from 'http';

/**
 * Keep a capture-e2e fake API from closing a hook's idle connection mid-hook.
 *
 * Node's http.Server drops an idle keep-alive socket after `keepAliveTimeout`
 * (5 s). A hook process reuses its connection across requests, and undici can
 * pick a socket in the moment the server is closing it: the request fails at
 * once with "fetch failed", the durable queue takes the payload, the hook still
 * logs "update complete", and a LATER hook replays it — after the test has
 * already read the turn.
 *
 * Under full-suite load on the native Windows runner, Stop's git work stretched
 * the gap before its main PATCH past 5 s (turns 1-3: 2.2-4.5 s, delivered;
 * turn 4: 6.07 s, failed). That is the whole of capture-e2e-real-binary's
 * "turn 4's own write is missing from its evidence". A production API sits
 * behind a proxy with a far longer idle timeout; the test server should not be
 * stricter than the thing it stands in for.
 */
export function holdIdleConnections(server: http.Server): http.Server {
  server.keepAliveTimeout = 120_000;
  // Must exceed keepAliveTimeout, or Node closes the socket on the headers timer.
  server.headersTimeout = 121_000;
  return server;
}
