import type http from 'http';
import zlib from 'zlib';

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
 *
 * Every fake API calls this, so it is also where gzipped bodies are inflated
 * (see inflateGzipBodies).
 */
export function holdIdleConnections(server: http.Server): http.Server {
  server.keepAliveTimeout = 120_000;
  // Must exceed keepAliveTimeout, or Node closes the socket on the headers timer.
  server.headersTimeout = 121_000;
  return inflateGzipBodies(server);
}

type RequestListener = (req: http.IncomingMessage, res: http.ServerResponse) => void;

/**
 * Hand the server's request handlers an inflated body when the CLI gzipped it.
 *
 * The CLI gzips any body of 16KB or more (fetch-timeout.ts GZIP_BODY_MIN_BYTES),
 * which covers every real session PATCH. The real API's express.json() inflates
 * it. The fake handlers read `req` as text, so without this they would see
 * compressed bytes, and a turn row would look missing when it was actually delivered.
 *
 * Wraps the handlers already registered, so call it after createServer(handler).
 */
export function inflateGzipBodies(server: http.Server): http.Server {
  const handlers = server.listeners('request') as RequestListener[];
  server.removeAllListeners('request');
  server.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (req.headers['content-encoding'] !== 'gzip') {
      for (const h of handlers) h.call(server, req, res);
      return;
    }
    const { 'content-encoding': _gzip, ...headers } = req.headers;
    const body = req.pipe(zlib.createGunzip());
    const inflated = Object.assign(body, {
      method: req.method, url: req.url, headers, socket: req.socket,
    }) as unknown as http.IncomingMessage;
    for (const h of handlers) h.call(server, inflated, res);
  });
  return server;
}
