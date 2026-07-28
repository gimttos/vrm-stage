#!/usr/bin/env node
/**
 * Synthetic VMC performer, for testing the bridge without a real tracker.
 *
 * Sends a slowly nodding/turning head, a curling right hand, and cycling
 * blendshapes. Verifies OSC encoding, the bridge's parsing and coalescing, the
 * WebSocket hop, and the Unity-to-VRM bone name mapping end to end.
 *
 * It cannot validate the handedness conversion — that needs a real sender, since
 * a synthetic one would only echo back whatever convention this file assumes.
 *
 * Usage: node bridge/vmc-test-sender.mjs [--port 39539] [--host 127.0.0.1]
 */
import { createSocket } from 'node:dgram';

const args = parseArgs(process.argv.slice(2));
const PORT = args.port ?? 39539;
const HOST = args.host ?? '127.0.0.1';

const socket = createSocket('udp4');

/** Bones we animate; everything else is sent at identity so the rig is complete. */
const ANIMATED = ['Head', 'Neck', 'RightIndexProximal', 'RightThumbProximal'];

const IDENTITY_BONES = [
  'Hips',
  'Spine',
  'Chest',
  'UpperChest',
  'LeftShoulder',
  'LeftUpperArm',
  'LeftLowerArm',
  'LeftHand',
  'RightShoulder',
  'RightUpperArm',
  'RightLowerArm',
  'RightHand',
];

let tick = 0;

setInterval(() => {
  tick++;
  const phase = tick / 30;

  const packets = [
    encode('/VMC/Ext/OK', [
      { type: 'i', value: 1 },
      { type: 'i', value: 3 },
      { type: 'i', value: 0 },
      { type: 'i', value: 1 },
    ]),
    encode('/VMC/Ext/T', [{ type: 'f', value: phase }]),
  ];

  for (const name of IDENTITY_BONES) {
    packets.push(bone(name, [0, 0, 0], [0, 0, 0, 1]));
  }

  // Head turns ±20° about Y, neck follows at a third of that.
  packets.push(bone('Head', [0, 0, 0], quatY(Math.sin(phase) * 0.35)));
  packets.push(bone('Neck', [0, 0, 0], quatY(Math.sin(phase) * 0.12)));
  // Right index and thumb curl about X so finger mapping is observable.
  packets.push(bone('RightIndexProximal', [0, 0, 0], quatX(-0.6 - Math.sin(phase * 2) * 0.4)));
  packets.push(bone('RightThumbProximal', [0, 0, 0], quatX(-0.4 - Math.sin(phase * 2) * 0.3)));

  const blink = Math.sin(phase * 3) > 0.9 ? 1 : 0;
  for (const [name, value] of [
    ['A', Math.max(0, Math.sin(phase * 2)) * 0.8],
    ['Blink_L', blink],
    ['Blink_R', blink],
    ['Joy', Math.max(0, Math.sin(phase / 2)) * 0.5],
  ]) {
    packets.push(
      encode('/VMC/Ext/Blend/Val', [
        { type: 's', value: name },
        { type: 'f', value: value },
      ]),
    );
  }
  packets.push(encode('/VMC/Ext/Blend/Apply', []));

  for (const packet of packets) socket.send(packet, PORT, HOST);
}, 1000 / 30);

console.log(`[test-sender] sending synthetic VMC to ${HOST}:${PORT} at 30Hz`);
console.log(`[test-sender] animating: ${ANIMATED.join(', ')}`);

// ---------------------------------------------------------------- helpers

function bone(name, [px, py, pz], [qx, qy, qz, qw]) {
  return encode('/VMC/Ext/Bone/Pos', [
    { type: 's', value: name },
    { type: 'f', value: px },
    { type: 'f', value: py },
    { type: 'f', value: pz },
    { type: 'f', value: qx },
    { type: 'f', value: qy },
    { type: 'f', value: qz },
    { type: 'f', value: qw },
  ]);
}

/**
 * @param {number} radians
 * @returns {[number, number, number, number]} quaternion (x, y, z, w)
 */
function quatY(radians) {
  return [0, Math.sin(radians / 2), 0, Math.cos(radians / 2)];
}

/**
 * @param {number} radians
 * @returns {[number, number, number, number]} quaternion (x, y, z, w)
 */
function quatX(radians) {
  return [Math.sin(radians / 2), 0, 0, Math.cos(radians / 2)];
}

function padded(text) {
  const raw = Buffer.from(text, 'utf8');
  const size = Math.ceil((raw.length + 1) / 4) * 4;
  const out = Buffer.alloc(size);
  raw.copy(out);
  return out;
}

function encode(address, args) {
  const tags = padded(',' + args.map((a) => a.type).join(''));
  const body = args.map((arg) => {
    if (arg.type === 's') return padded(arg.value);
    const buffer = Buffer.alloc(4);
    if (arg.type === 'i') buffer.writeInt32BE(arg.value);
    else buffer.writeFloatBE(arg.value);
    return buffer;
  });
  return Buffer.concat([padded(address), tags, ...body]);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const raw = argv[++i];
    out[key] = key === 'host' ? raw : Number(raw);
  }
  return out;
}
