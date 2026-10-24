import http from 'node:http';
import { internetConfig } from './config.js';
import { Rooms, turnCredentials } from './rooms.js';
import { loadInternetAssets } from './assets.js';

export function reply(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

export async function readJson(request, limit = 110_000) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(Error('Message too large'), { status: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

export async function serveInternetAsset(path, response) {
  const asset = (await loadInternetAssets())[path];
  if (!asset) return false;
  response.writeHead(200, {
    'Content-Type': asset.type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https: http://localhost:* http://127.0.0.1:*; frame-src 'self'; object-src 'none'; base-uri 'none'",
  });
  response.end(asset.body);
  return true;
}

export async function startSignaling({
  host = '127.0.0.1',
  port = 8787,
  config = internetConfig(),
  allowedOrigins = [],
  stunUrls = [],
  turn = {},
  now = Date.now,
} = {}) {
  const rooms = new Rooms(config, { now });
  const buckets = new Map();
  const relayGrants = new Map();
  const relayLimit = turn.maxSessions ?? 0;
  if (!Number.isSafeInteger(relayLimit) || relayLimit < 0)
    throw Error('Invalid TURN session limit');
  if (
    turn.lifetimeSeconds != null &&
    (!Number.isSafeInteger(turn.lifetimeSeconds) ||
      turn.lifetimeSeconds <= 0 ||
      turn.lifetimeSeconds > 86_400)
  )
    throw Error('Invalid TURN credential lifetime');
  if (turn.urls?.length && !turn.secret)
    throw Error('TURN URLs require a server-side shared secret');
  const server = http.createServer(async (request, response) => {
    try {
      const origin = request.headers.origin;
      // The reverse proxy terminates TLS; its public origins must be declared.
      const localOrigin = `http://${host}:${server.address().port}`;
      const loopback = origin && /^http:\/\/(127\.0\.0\.1|localhost):[0-9]+$/.test(origin);
      if (
        origin &&
        origin !== localOrigin &&
        !loopback &&
        origin !== 'https://appassets.androidplatform.net' &&
        !allowedOrigins.includes(origin)
      )
        return reply(response, 403, { error: 'Origin is not allowed' });
      if (origin) {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Vary', 'Origin');
      }
      if (request.method === 'OPTIONS') {
        response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE');
        response.writeHead(204);
        response.end();
        return;
      }
      const url = new URL(request.url, localOrigin);
      if (request.method === 'GET' && url.pathname === '/') {
        response.writeHead(302, { Location: '/internet/' });
        response.end();
        return;
      }
      if (request.method === 'GET' && url.pathname === '/internet/config')
        return reply(response, 200, {
          mode: 'browser',
          ...config,
          connectivityConfigured: Boolean(stunUrls.length || turn.urls?.length),
        });
      if (
        request.method === 'GET' &&
        url.pathname.startsWith('/internet/') &&
        (await serveInternetAsset(url.pathname, response))
      )
        return;
      if (!url.pathname.startsWith('/v1/')) return reply(response, 404, { error: 'Not found' });
      const ip = request.socket.remoteAddress;
      for (const [key, value] of buckets) if (now() - value.start >= 60_000) buckets.delete(key);
      if (!buckets.has(ip)) {
        if (buckets.size >= 10_000) return reply(response, 503, { error: 'Service busy' });
        buckets.set(ip, { start: now(), count: 0 });
      }
      if (++buckets.get(ip).count > config.requestsPerMinute)
        return reply(response, 429, { error: 'Too many requests. Wait a minute and retry.' });
      if (request.method === 'POST' && url.pathname === '/v1/rooms')
        return reply(response, 201, { ...rooms.create(), config });
      if (request.method === 'POST' && url.pathname === '/v1/join')
        return reply(response, 200, { ...rooms.join((await readJson(request)).code), config });
      const match = /^\/v1\/rooms\/([a-f0-9]{32})(?:\/(events|signal|approve|ice))?$/.exec(
        url.pathname,
      );
      if (!match) return reply(response, 404, { error: 'Not found' });
      const [, id, action] = match;
      const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '')?.[1];
      rooms.authenticate(id, token);
      if (request.method === 'GET' && action === 'events')
        return reply(response, 200, {
          events: rooms.poll(id, token, url.searchParams.get('connected') === '1'),
        });
      if (request.method === 'GET' && action === 'ice') {
        for (const [roomId, expires] of relayGrants)
          if (expires <= now()) relayGrants.delete(roomId);
        const relayAvailable = Boolean(
          turn.urls?.length &&
          relayLimit > 0 &&
          (relayGrants.has(id) || relayGrants.size < relayLimit),
        );
        if (relayAvailable) relayGrants.set(id, now() + (turn.lifetimeSeconds ?? 3600) * 1000);
        // No static TURN password is shipped to the client. coturn enforces
        // allocation/concurrency/bandwidth quotas independently of signaling.
        return reply(response, 200, {
          relayAvailable,
          iceServers: [
            ...(stunUrls.length ? [{ urls: stunUrls }] : []),
            ...(relayAvailable ? turnCredentials(turn, id, now()) : []),
          ],
        });
      }
      if (request.method === 'POST' && action === 'signal') {
        rooms.signal(id, token, await readJson(request));
        return reply(response, 200, { status: 'sent' });
      }
      if (request.method === 'POST' && action === 'approve') {
        rooms.approve(id, token);
        return reply(response, 200, { status: 'approved' });
      }
      if (request.method === 'DELETE' && !action) {
        rooms.close(id, token);
        return reply(response, 200, { status: 'closed' });
      }
      return reply(response, 404, { error: 'Not found' });
    } catch (error) {
      if (!response.headersSent) reply(response, error.status ?? 400, { error: error.message });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => server.once('error', reject).listen(port, host, resolve));
  const timer = setInterval(() => rooms.sweep(), 1000);
  timer.unref();
  return {
    server,
    rooms,
    url: `http://${host}:${server.address().port}`,
    close: async () => {
      clearInterval(timer);
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
