import type { Env } from './env';

export { Room } from './Room';

/**
 * The API half of the deploy. Static assets are served by the `assets` binding;
 * `run_worker_first` in wrangler.jsonc routes only `/api/*` here.
 *
 * Three jobs:
 *  - mint broadcast rooms (id is public, host key is not)
 *  - upgrade WebSockets into the room's Durable Object
 *  - hold VRM files, because a viewer renders the avatar locally and so needs the
 *    file; 15MB cannot ride the pose channel
 */

/** Ample for a VRoid export; refuses anything that is obviously not a model. */
const MAX_MODEL_BYTES = 64 * 1024 * 1024;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    try {
      if (path === '/api/rooms' && request.method === 'POST') {
        return await createRoom(env);
      }

      const wsMatch = /^\/api\/rooms\/([A-Za-z0-9_-]{4,32})\/ws$/.exec(path);
      if (wsMatch) return await joinRoom(request, env, wsMatch[1]!);

      const endMatch = /^\/api\/rooms\/([A-Za-z0-9_-]{4,32})\/end$/.exec(path);
      if (endMatch && request.method === 'POST') {
        // Authorised by the host key, not by who is asking — a viewer must not be
        // able to end someone else's broadcast.
        const ended = await env.ROOM.getByName(endMatch[1]!).endBroadcast(
          url.searchParams.get('key') ?? '',
        );
        return ended ? json({ ended: true }) : json({ error: 'not the host' }, 403);
      }

      const modelMatch = /^\/api\/models\/([A-Za-z0-9_-]{1,64}\.vrm)$/.exec(path);
      if (modelMatch) return await models(request, env, modelMatch[1]!);

      if (path.startsWith('/api/')) {
        return json({ error: 'not found' }, 404);
      }
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'unexpected error' }, 500);
    }

    // Anything not under /api/ is a static asset.
    return env.ASSETS.fetch(request);
  },
};

async function createRoom(env: Env): Promise<Response> {
  // The id is short because it rides in a shareable link; the key is long
  // because it is the only thing standing between a viewer and the avatar.
  const roomId = randomId(10);
  const hostKey = randomId(32);

  const claimed = await env.ROOM.getByName(roomId).init(hostKey);
  if (!claimed) return json({ error: 'room id collision, retry' }, 409);

  return json({ roomId, hostKey });
}

async function joinRoom(request: Request, env: Env, roomId: string): Promise<Response> {
  if (request.headers.get('Upgrade') !== 'websocket') {
    return json({ error: 'expected websocket upgrade' }, 426);
  }

  // Forwarded as a request rather than an RPC call: the upgrade response carries
  // a live WebSocket, which RPC cannot serialize.
  if (!(await env.ROOM.getByName(roomId).exists())) {
    return json({ error: 'room not found' }, 404);
  }
  // A key in the query string is how the host proves itself. Viewers simply omit
  // it and are accepted read-only.
  return env.ROOM.getByName(roomId).fetch(request);
}

async function models(request: Request, env: Env, key: string): Promise<Response> {
  if (request.method === 'PUT') {
    const declared = Number(request.headers.get('Content-Length') ?? '0');
    if (declared > MAX_MODEL_BYTES) {
      return json({ error: 'model too large' }, 413);
    }
    if (!request.body) return json({ error: 'empty body' }, 400);

    await env.MODELS.put(key, request.body, {
      httpMetadata: { contentType: 'model/gltf-binary' },
    });
    return json({ url: `/api/models/${key}` });
  }

  if (request.method === 'GET' || request.method === 'HEAD') {
    const object = await env.MODELS.get(key);
    if (!object) return json({ error: 'model not found' }, 404);

    return new Response(request.method === 'HEAD' ? null : object.body, {
      headers: {
        'Content-Type': 'model/gltf-binary',
        'Content-Length': String(object.size),
        // Keyed by content hash on upload, so it can never go stale.
        'Cache-Control': 'public, max-age=31536000, immutable',
        ...CORS,
      },
    });
  }

  return json({ error: 'method not allowed' }, 405);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

/** URL-safe random id from the platform CSPRNG. */
function randomId(length: number): string {
  const alphabet = 'abcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}
