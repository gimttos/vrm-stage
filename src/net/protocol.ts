import { emptyFrame, type BodyPose, type HandPose, type PoseFrame } from '../types';

/**
 * Wire format for broadcasting a performance.
 *
 * This is the whole reason a room is cheap: instead of encoding video, the host
 * sends the ~50 numbers the rig actually consumes and every viewer renders the
 * avatar locally. One frame is 208 bytes, so a 30fps broadcast is about 6 KB/s
 * per viewer — three orders of magnitude under video.
 *
 * Only fields the driver reads are on the wire. `HandPose.position`, `.size`,
 * and `.roll` are deliberately absent: `handRig` never touches them, and sending
 * data nothing consumes is how a protocol rots.
 *
 * Absence is encoded as NaN rather than a presence bitmask — a fixed-size frame
 * means encode and decode are two straight loops with no bit fiddling, and the
 * few wasted bytes cost less than the bugs a bitmask invites.
 */

/** Blendshape order on the wire. Append only — never reorder or remove. */
export const WIRE_SHAPES = [
  'browDownLeft',
  'browDownRight',
  'browInnerUp',
  'browOuterUpLeft',
  'browOuterUpRight',
  'eyeBlinkLeft',
  'eyeBlinkRight',
  'eyeLookDownLeft',
  'eyeLookDownRight',
  'eyeLookInLeft',
  'eyeLookInRight',
  'eyeLookOutLeft',
  'eyeLookOutRight',
  'eyeLookUpLeft',
  'eyeLookUpRight',
  'jawOpen',
  'mouthFunnel',
  'mouthPucker',
] as const;

/** curls(5) + spread(1) + relative(3) + basis fingers(3) + normal(3) */
const HAND_FLOATS = 15;
/** sway(1) + tilt(1) */
const BODY_FLOATS = 2;
const FLOATS_PER_FRAME = WIRE_SHAPES.length + 3 + HAND_FLOATS * 2 + BODY_FLOATS;

/** uint8 flags + 3 bytes padding, so the Float32 view stays 4-byte aligned. */
const FRAME_HEADER = 4;
export const FRAME_BYTES = FRAME_HEADER + FLOATS_PER_FRAME * 4;

const FLAG_TRACKED = 1;

/** Message kinds. Binary carries poses; everything else is JSON text. */
export const MSG_POSE = 1;

/**
 * Frames per binary message.
 *
 * With the Hibernation API every inbound WebSocket message is a billed request,
 * so an unbatched 30fps publisher costs ~108,000 requests an hour. Cloudflare's
 * own guidance for high-frequency sockets is to batch, and the subscriber's
 * jitter buffer replays at the original rate — the only cost is a bounded ~100ms
 * of added latency, which a one-way broadcast does not notice.
 */
export const FRAMES_PER_MESSAGE = 3;

/** Writes one frame at `offset` in `view`. Returns the next offset. */
function writeFrame(view: DataView, offset: number, frame: PoseFrame): number {
  view.setUint8(offset, frame.tracked ? FLAG_TRACKED : 0);
  view.setUint8(offset + 1, 0);
  view.setUint16(offset + 2, 0);

  let at = offset + FRAME_HEADER;
  const put = (value: number): void => {
    view.setFloat32(at, value);
    at += 4;
  };

  for (const name of WIRE_SHAPES) put(frame.shapes.get(name) ?? 0);

  if (frame.head) {
    put(frame.head.pitch);
    put(frame.head.yaw);
    put(frame.head.roll);
  } else {
    put(NaN);
    put(NaN);
    put(NaN);
  }

  writeHand(put, frame.hands.left);
  writeHand(put, frame.hands.right);
  writeBody(put, frame.body);

  return at;
}

function writeHand(put: (value: number) => void, hand: HandPose | null): void {
  if (!hand) {
    for (let i = 0; i < HAND_FLOATS; i++) put(NaN);
    return;
  }

  for (let i = 0; i < 5; i++) put(hand.curls[i] ?? 0);
  put(hand.spread);

  if (hand.relative) {
    put(hand.relative.x);
    put(hand.relative.y);
    put(hand.relative.size);
  } else {
    put(NaN);
    put(NaN);
    put(NaN);
  }

  if (hand.basis) {
    for (const value of hand.basis.fingers) put(value);
    for (const value of hand.basis.normal) put(value);
  } else {
    for (let i = 0; i < 6; i++) put(NaN);
  }
}

function writeBody(put: (value: number) => void, body: BodyPose | null): void {
  if (!body) {
    for (let i = 0; i < BODY_FLOATS; i++) put(NaN);
    return;
  }
  put(body.sway);
  put(body.tilt);
}

/** Packs up to {@link FRAMES_PER_MESSAGE} frames into one binary message. */
export function encodePoses(frames: PoseFrame[]): ArrayBuffer {
  const count = Math.min(frames.length, 255);
  const buffer = new ArrayBuffer(4 + count * FRAME_BYTES);
  const view = new DataView(buffer);

  view.setUint8(0, MSG_POSE);
  view.setUint8(1, count);
  view.setUint16(2, 0);

  let offset = 4;
  for (let i = 0; i < count; i++) offset = writeFrame(view, offset, frames[i]!);
  return buffer;
}

/**
 * Decodes a binary pose message. Returns an empty array for anything that is not
 * a well-formed pose message, so a malformed or hostile frame is ignored rather
 * than throwing inside the socket handler.
 */
export function decodePoses(data: ArrayBuffer): PoseFrame[] {
  if (data.byteLength < 4) return [];
  const view = new DataView(data);
  if (view.getUint8(0) !== MSG_POSE) return [];

  const count = view.getUint8(1);
  if (data.byteLength !== 4 + count * FRAME_BYTES) return [];

  const frames: PoseFrame[] = [];
  let offset = 4;
  for (let i = 0; i < count; i++) {
    frames.push(readFrame(view, offset));
    offset += FRAME_BYTES;
  }
  return frames;
}

function readFrame(view: DataView, offset: number): PoseFrame {
  const tracked = (view.getUint8(offset) & FLAG_TRACKED) !== 0;

  let at = offset + FRAME_HEADER;
  const take = (): number => {
    const value = view.getFloat32(at);
    at += 4;
    return value;
  };

  const shapes = new Map<string, number>();
  for (const name of WIRE_SHAPES) shapes.set(name, take());

  const pitch = take();
  const yaw = take();
  const roll = take();
  const head = Number.isNaN(pitch) ? null : { pitch, yaw, roll };

  const left = readHand(take);
  const right = readHand(take);
  const body = readBody(take);

  return {
    ...emptyFrame(),
    shapes,
    head,
    hands: { left, right },
    body,
    // Local clock, not the publisher's: the filters downstream measure elapsed
    // time on this machine, and a remote timestamp would be meaningless here.
    timestamp: performance.now(),
    tracked,
  };
}

function readBody(take: () => number): BodyPose | null {
  const sway = take();
  const tilt = take();
  if (Number.isNaN(sway)) return null;
  return { sway, tilt };
}

function readHand(take: () => number): HandPose | null {
  const curls: [number, number, number, number, number] = [
    take(),
    take(),
    take(),
    take(),
    take(),
  ];
  const spread = take();

  const rx = take();
  const ry = take();
  const rsize = take();

  const fingers: [number, number, number] = [take(), take(), take()];
  const normal: [number, number, number] = [take(), take(), take()];

  if (Number.isNaN(curls[0])) return null;

  return {
    curls,
    spread,
    // Unused by the rig, but the type requires them; kept at neutral rather than
    // inventing values a consumer might one day trust.
    position: { x: 0, y: 0, z: 0 },
    size: 0,
    roll: 0,
    relative: Number.isNaN(rx) ? null : { x: rx, y: ry, size: rsize },
    basis: Number.isNaN(fingers[0]) ? null : { fingers, normal },
  };
}

// -------------------------------------------------------------- text messages

/**
 * How the host interprets and presents their own performance.
 *
 * Published frames are *uncorrected* — calibration, axis inverts, mirror, gain,
 * and neck share are applied inside `AvatarDriver` on the way to the bones, so
 * they never reach the wire. Without shipping them, a viewer decodes the host's
 * face through its own defaults (or worse, through calibration it saved while
 * hosting itself), and the avatar sits at a subtly different angle than the host
 * sees.
 *
 * Composition — framing, pan, zoom, and the avatar's rectangle — is NOT here.
 * It belongs to the avatar row of the scene and travels with it, which is the
 * better channel: the room retains the scene for late joiners, and there is no
 * second copy to disagree with the first.
 *
 * Fields are deliberately loose — the viewer copies only keys it recognises
 * rather than trusting the wire.
 */
export interface PerformConfig {
  driver: Record<string, number | boolean>;
  hands: Record<string, number | boolean>;
  /** Shoulder and torso settings. Absent from older hosts, hence optional. */
  body?: Record<string, number | boolean>;
}

/** Low-frequency room state, sent as JSON text so binary stays pose-only. */
export type RoomMessage =
  | { type: 'scene'; encoded: string }
  | { type: 'emotion'; name: string | null }
  | { type: 'model'; url: string | null }
  | { type: 'config'; config: PerformConfig }
  /** Sent to a subscriber on connect so a late joiner renders immediately. */
  | {
      type: 'state';
      scene: string | null;
      emotion: string | null;
      model: string | null;
      config: PerformConfig | null;
    }
  | { type: 'role'; role: 'publisher' | 'subscriber'; viewers: number }
  /** The host stopped. The model has been deleted, so viewers should stop too. */
  | { type: 'ended' }
  | { type: 'error'; message: string };

export function parseRoomMessage(raw: string): RoomMessage | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const type = (parsed as { type?: unknown }).type;
    if (typeof type !== 'string') return null;
    return parsed as RoomMessage;
  } catch {
    return null;
  }
}
