#!/usr/bin/env node
/**
 * VMC (OSC/UDP) to WebSocket bridge.
 *
 * Browsers cannot open UDP sockets, and VMC is OSC over UDP, so receiving a rig
 * from VSeeFace/VNyan/Warudo in a web page requires exactly this much native
 * help. It is deliberately tiny and dependency-free apart from `ws`.
 *
 *   VSeeFace  --OSC/UDP 39539-->  bridge  --WebSocket 39541-->  browser
 *
 * A performer sends every bone plus every blendshape many times a second, which
 * is far too many messages to forward one-for-one. The bridge keeps current
 * state and emits coalesced snapshots at a fixed rate instead.
 *
 * Usage:
 *   node bridge/vmc-bridge.mjs [--udp 39539] [--ws 39541] [--rate 60] [--verbose]
 */
import { createSocket } from 'node:dgram';
import { WebSocketServer } from 'ws';
import { decodePacket } from './osc.mjs';

const args = parseArgs(process.argv.slice(2));
const UDP_PORT = args.udp ?? 39539;
const WS_PORT = args.ws ?? 39541;
const RATE = args.rate ?? 60;
const VERBOSE = args.verbose ?? false;

/** Latest known bone poses, keyed by Unity HumanBodyBones name. */
const bones = new Map();
/** Blendshape values staged until /VMC/Ext/Blend/Apply commits them. */
let pendingBlend = new Map();
let appliedBlend = new Map();

let tracking = true;
let vmcTime = 0;
let dirty = false;
let packets = 0;
let lastPacketAt = 0;

// ---------------------------------------------------------------- UDP in

const udp = createSocket('udp4');

udp.on('message', (buffer) => {
  packets++;
  lastPacketAt = Date.now();

  let messages;
  try {
    messages = decodePacket(buffer);
  } catch (error) {
    if (VERBOSE) console.warn('[bridge] malformed OSC packet:', error.message);
    return;
  }

  for (const { address, args: values } of messages) {
    switch (address) {
      case '/VMC/Ext/Bone/Pos': {
        const [name, ...rest] = values;
        if (typeof name === 'string' && rest.length >= 7) {
          bones.set(name, rest.slice(0, 7));
          dirty = true;
        }
        break;
      }
      case '/VMC/Ext/Blend/Val': {
        const [name, value] = values;
        if (typeof name === 'string' && typeof value === 'number') {
          pendingBlend.set(name, value);
        }
        break;
      }
      case '/VMC/Ext/Blend/Apply': {
        appliedBlend = pendingBlend;
        pendingBlend = new Map();
        dirty = true;
        break;
      }
      case '/VMC/Ext/OK': {
        // (loaded, calibration state, calibration mode, tracking status)
        if (values.length >= 4 && typeof values[3] === 'number') {
          tracking = values[3] !== 0;
        }
        break;
      }
      case '/VMC/Ext/T': {
        if (typeof values[0] === 'number') vmcTime = values[0];
        break;
      }
      default:
        // Root, camera, devices, and control messages are not used yet.
        break;
    }
  }
});

udp.on('error', (error) => {
  console.error(`[bridge] UDP error: ${error.message}`);
  process.exit(1);
});

udp.bind(UDP_PORT, () => {
  console.log(`[bridge] listening for VMC on udp://0.0.0.0:${UDP_PORT}`);
});

// ---------------------------------------------------------------- WebSocket out

const wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' });

wss.on('listening', () => {
  console.log(`[bridge] serving snapshots on ws://127.0.0.1:${WS_PORT}`);
  console.log('[bridge] in VSeeFace: Settings > General > VMC protocol sender > enable,');
  console.log(`[bridge] send to 127.0.0.1:${UDP_PORT}`);
});

wss.on('connection', (socket) => {
  console.log(`[bridge] browser connected (${wss.clients.size} total)`);
  socket.on('close', () => console.log(`[bridge] browser left (${wss.clients.size} total)`));
});

setInterval(() => {
  if (!dirty || wss.clients.size === 0) return;
  dirty = false;

  const payload = JSON.stringify({
    t: vmcTime,
    tracking,
    bones: Object.fromEntries(bones),
    blend: Object.fromEntries(appliedBlend),
  });

  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(payload);
  }
}, Math.max(1, Math.round(1000 / RATE)));

// A performer that stops sending should not leave the avatar frozen mid-pose
// looking like it is still live.
setInterval(() => {
  if (lastPacketAt !== 0 && Date.now() - lastPacketAt > 2000 && tracking) {
    tracking = false;
    dirty = true;
    console.log('[bridge] no VMC packets for 2s — marking untracked');
  }
}, 1000);

if (VERBOSE) {
  setInterval(() => {
    console.log(
      `[bridge] ${packets} packets, ${bones.size} bones, ${appliedBlend.size} blendshapes, tracking=${tracking}`,
    );
    packets = 0;
  }, 2000);
}

// ---------------------------------------------------------------- args

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--verbose') {
      out.verbose = true;
    } else if (flag.startsWith('--')) {
      const value = Number(argv[++i]);
      if (Number.isFinite(value)) out[flag.slice(2)] = value;
    }
  }
  return out;
}
