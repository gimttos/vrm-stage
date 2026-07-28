#!/usr/bin/env node
/**
 * Synthetic host: mints a room and publishes a sweeping head turn.
 *
 * Lets the viewer path be exercised without a camera — open the printed link and
 * the avatar should turn its head. The frame bytes are written here from the
 * documented layout rather than by importing the app's encoder, so this also
 * checks the decoder against an independent implementation.
 *
 *   npm run serve                  # terminal 1 (worker)
 *   npm run dev                    # terminal 2 (app, proxies /api)
 *   node scripts/room-publish-demo.mjs
 */
import { WebSocket } from 'ws';
import process from 'node:process';

const API = process.env.ROOM_ORIGIN ?? 'http://localhost:8787';
const APP = process.env.APP_ORIGIN ?? 'http://localhost:5174';
const MODEL = process.env.DEMO_MODEL ?? '/fixtures/tttt.vrm';

// Layout from src/net/protocol.ts — 18 shapes, then pitch/yaw/roll, then 2 hands.
const SHAPE_COUNT = 18;
const HAND_FLOATS = 15;
const FLOATS = SHAPE_COUNT + 3 + HAND_FLOATS * 2;
const FRAME_HEADER = 4;
const FRAME_BYTES = FRAME_HEADER + FLOATS * 4;
const MSG_POSE = 1;
const FRAMES_PER_MESSAGE = 3;

/** @param {{jawOpen:number, pitch:number, yaw:number, roll:number}} pose */
function frameInto(view, offset, pose) {
  view.setUint8(offset, 1); // tracked
  view.setUint8(offset + 1, 0);
  view.setUint16(offset + 2, 0);

  let at = offset + FRAME_HEADER;
  const put = (v) => {
    view.setFloat32(at, v);
    at += 4;
  };

  for (let i = 0; i < SHAPE_COUNT; i++) put(0);
  // jawOpen is index 15 in WIRE_SHAPES; rewrite it in place.
  view.setFloat32(offset + FRAME_HEADER + 15 * 4, pose.jawOpen);

  put(pose.pitch);
  put(pose.yaw);
  put(pose.roll);

  // No hands: NaN marks absence.
  for (let i = 0; i < HAND_FLOATS * 2; i++) put(NaN);
  return at;
}

function encode(poses) {
  const buffer = new ArrayBuffer(4 + poses.length * FRAME_BYTES);
  const view = new DataView(buffer);
  view.setUint8(0, MSG_POSE);
  view.setUint8(1, poses.length);
  view.setUint16(2, 0);

  let offset = 4;
  for (const pose of poses) offset = frameInto(view, offset, pose);
  return Buffer.from(buffer);
}

const created = await fetch(`${API}/api/rooms`, { method: 'POST' });
const { roomId, hostKey } = /** @type {{roomId: string, hostKey: string}} */ (
  await created.json()
);

const wsUrl = `${API.replace(/^http/, 'ws')}/api/rooms/${roomId}/ws?key=${hostKey}`;
const socket = new WebSocket(wsUrl);

const watchLink = `${APP}/?mode=live&source=remote&room=${roomId}&model=${MODEL}`;

socket.on('open', () => {
  console.log(`room     ${roomId}`);
  console.log(`watch    ${watchLink}`);
  console.log('\npublishing a head sweep at 30fps — Ctrl+C to stop\n');

  socket.send(JSON.stringify({ type: 'model', url: MODEL }));

  // Deliberately non-default so a viewer that ignored the host's settings is
  // visibly wrong rather than subtly wrong: pitch is offset by 0.25 rad and the
  // head gain is doubled.
  socket.send(
    JSON.stringify({
      type: 'config',
      config: {
        driver: {
          mirror: false,
          invertPitch: false,
          invertYaw: false,
          invertRoll: false,
          headGain: 2,
          pitchOffset: 0.25,
          yawOffset: 0,
          rollOffset: 0,
          neckShare: 0.4,
          brows: true,
          gaze: true,
        },
        hands: { fingers: true, arms: true, armReach: 1, invertCurl: false, wrist: true },
        framing: 'head',
        view: { panX: 0.1, panY: -0.05, zoom: 1.5 },
      },
    }),
  );

  let tick = 0;
  const batch = [];
  setInterval(() => {
    const phase = tick / 30;
    tick++;
    batch.push({
      jawOpen: Math.max(0, Math.sin(phase * 2)) * 0.8,
      pitch: Math.sin(phase * 0.7) * 0.2,
      yaw: Math.sin(phase) * 0.5,
      roll: Math.sin(phase * 1.3) * 0.15,
    });
    if (batch.length >= FRAMES_PER_MESSAGE) {
      socket.send(encode(batch.splice(0, batch.length)));
    }
  }, 1000 / 30);
});

socket.on('message', (data, isBinary) => {
  if (!isBinary) {
    const message = JSON.parse(data.toString());
    if (message.type === 'role') console.log(`viewers  ${message.viewers}`);
  }
});

socket.on('error', (error) => {
  console.error(`socket error: ${error.message}`);
  process.exit(1);
});
