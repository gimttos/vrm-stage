#!/usr/bin/env node
/**
 * End-to-end check of a broadcast room against a running `wrangler dev`.
 *
 * The assertion that matters is #5: a subscriber's messages must reach nobody.
 * That is what makes a room a broadcast rather than a shared puppet — and it has
 * to hold on the server, because a viewer can edit anything in their own page.
 *
 *   npm run serve      # terminal 1
 *   npm run room:test  # terminal 2
 */
import { WebSocket } from 'ws';
import process from 'node:process';

const ORIGIN = process.env.ROOM_ORIGIN ?? 'http://localhost:8787';
const WS_ORIGIN = ORIGIN.replace(/^http/, 'ws');

let failures = 0;

function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
}

/** Collects messages, and lets a test wait for one or time out. */
function collect(socket) {
  const seen = [];
  socket.on('message', (data, isBinary) => {
    seen.push(isBinary ? { binary: Buffer.from(data) } : { text: data.toString() });
  });
  return {
    seen,
    async waitFor(predicate, ms = 1500) {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const hit = seen.find(predicate);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 25));
      }
      return null;
    },
  };
}

function open(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

const json = (entry) => {
  if (!entry?.text) return null;
  try {
    return JSON.parse(entry.text);
  } catch {
    return null;
  }
};

async function main() {
  // 1 — mint a room
  const created = await fetch(`${ORIGIN}/api/rooms`, { method: 'POST' });
  const { roomId, hostKey } = /** @type {{roomId: string, hostKey: string}} */ (
    await created.json()
  );
  check('POST /api/rooms returns an id and a key', Boolean(roomId && hostKey), `room=${roomId}`);
  check('host key is not guessable from the id', hostKey.length >= 32);

  // 2 — host joins with the key
  const host = await open(`${WS_ORIGIN}/api/rooms/${roomId}/ws?key=${hostKey}`);
  const hostFeed = collect(host);
  const hostRole = json(await hostFeed.waitFor((m) => json(m)?.type === 'role'));
  check('correct key is accepted as publisher', hostRole?.role === 'publisher');

  // 3 — a viewer joins with no key
  const viewer = await open(`${WS_ORIGIN}/api/rooms/${roomId}/ws`);
  const viewerFeed = collect(viewer);
  const viewerRole = json(await viewerFeed.waitFor((m) => json(m)?.type === 'role'));
  check('no key is accepted read-only', viewerRole?.role === 'subscriber');

  const wrongKey = await open(`${WS_ORIGIN}/api/rooms/${roomId}/ws?key=${'x'.repeat(32)}`);
  const wrongFeed = collect(wrongKey);
  const wrongRole = json(await wrongFeed.waitFor((m) => json(m)?.type === 'role'));
  check('a wrong key is downgraded, not trusted', wrongRole?.role === 'subscriber');

  // 4 — host publishes; viewer receives
  const pose = Buffer.from([1, 1, 0, 0, ...new Array(208).fill(7)]);
  host.send(pose);
  const relayed = await viewerFeed.waitFor((m) => m.binary);
  check('publisher frames reach subscribers', relayed?.binary?.length === pose.length);

  // 5 — THE ONE THAT MATTERS: a viewer cannot drive the avatar
  const beforeHost = hostFeed.seen.filter((m) => m.binary).length;
  const beforeOther = wrongFeed.seen.filter((m) => m.binary).length;
  viewer.send(Buffer.from([1, 1, 0, 0, ...new Array(208).fill(9)]));
  wrongKey.send(Buffer.from([1, 1, 0, 0, ...new Array(208).fill(9)]));
  await new Promise((r) => setTimeout(r, 600));
  check(
    'subscriber frames reach NOBODY',
    hostFeed.seen.filter((m) => m.binary).length === beforeHost &&
      wrongFeed.seen.filter((m) => m.binary).length === beforeOther,
  );

  // 6 — retained state, so a late joiner renders immediately
  host.send(JSON.stringify({ type: 'scene', encoded: 'SCENE-ABC' }));
  host.send(JSON.stringify({ type: 'model', url: '/api/models/test.vrm' }));
  // Published frames are uncorrected, so the host's calibration has to travel or
  // viewers render the same performance at a different angle.
  host.send(
    JSON.stringify({
      type: 'config',
      config: { driver: { pitchOffset: 0.25 }, hands: {}, framing: 'head', view: { panX: 0.1, panY: 0, zoom: 2 } },
    }),
  );
  await new Promise((r) => setTimeout(r, 300));

  const late = await open(`${WS_ORIGIN}/api/rooms/${roomId}/ws`);
  const lateFeed = collect(late);
  const state = json(await lateFeed.waitFor((m) => json(m)?.type === 'state'));
  check('late joiner is sent retained scene', state?.scene === 'SCENE-ABC');
  check('late joiner is sent retained model', state?.model === '/api/models/test.vrm');
  check('late joiner is sent the host calibration', state?.config?.driver?.pitchOffset === 0.25);
  check('late joiner is sent the host composition', state?.config?.view?.zoom === 2);

  // 7 — viewer count reaches the host
  const counted = json(
    await hostFeed.waitFor((m) => {
      const parsed = json(m);
      return parsed?.type === 'role' && parsed.viewers >= 3;
    }),
  );
  check('host is told how many are watching', (counted?.viewers ?? 0) >= 3, `viewers=${counted?.viewers}`);

  // 8 — a second host connection takes over rather than being locked out
  const rehost = await open(`${WS_ORIGIN}/api/rooms/${roomId}/ws?key=${hostKey}`);
  const rehostFeed = collect(rehost);
  const rehostRole = json(await rehostFeed.waitFor((m) => json(m)?.type === 'role'));
  check('a reconnecting host reclaims the room', rehostRole?.role === 'publisher');

  // 9 — an unclaimed room must be refused, not silently created
  // (attempted as a real upgrade: node's fetch cannot represent one)
  let ghostRefused = false;
  try {
    const ghost = await open(`${WS_ORIGIN}/api/rooms/zzzzzzzzzz/ws`);
    ghost.close();
  } catch {
    ghostRefused = true;
  }
  check('unknown room is refused, not opened empty', ghostRefused);

  // 10 — model store round trip
  const body = Buffer.from('glTF-ish bytes');
  const put = await fetch(`${ORIGIN}/api/models/test.vrm`, { method: 'PUT', body });
  const putBody = /** @type {{url?: string}} */ (await put.json());
  check('model upload returns a plain URL', putBody?.url === '/api/models/test.vrm');

  const got = await fetch(`${ORIGIN}/api/models/test.vrm`);
  const gotBody = Buffer.from(await got.arrayBuffer());
  check(
    'model download round-trips',
    got.status === 200 && gotBody.equals(body),
    `type=${got.headers.get('content-type')}`,
  );

  // 11 — ending the broadcast must delete the model, and only the host may do it
  host.send(JSON.stringify({ type: 'model', url: '/api/models/test.vrm' }));
  await new Promise((r) => setTimeout(r, 300));

  const byViewer = await fetch(`${ORIGIN}/api/rooms/${roomId}/end?key=${'x'.repeat(32)}`, {
    method: 'POST',
  });
  check('a viewer cannot end the broadcast', byViewer.status === 403, `status=${byViewer.status}`);
  check(
    'model survives an unauthorised end attempt',
    (await fetch(`${ORIGIN}/api/models/test.vrm`)).status === 200,
  );

  const ended = await fetch(`${ORIGIN}/api/rooms/${roomId}/end?key=${hostKey}`, {
    method: 'POST',
  });
  check('host can end the broadcast', ended.ok);

  const afterEnd = await fetch(`${ORIGIN}/api/models/test.vrm`);
  check('model is deleted when the broadcast ends', afterEnd.status === 404, `status=${afterEnd.status}`);

  const endNotice = json(await lateFeed.waitFor((m) => json(m)?.type === 'ended'));
  check('viewers are told the broadcast ended', endNotice?.type === 'ended');

  for (const socket of [host, viewer, wrongKey, late, rehost]) socket.close();

  console.log(failures === 0 ? '\nall room checks passed' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`\nroom-test could not run: ${error.message}`);
  console.error(`Is \`npm run serve\` up at ${ORIGIN}?`);
  process.exit(1);
});
