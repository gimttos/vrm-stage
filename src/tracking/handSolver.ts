import type { HandPose } from '../types';

/**
 * Turns MediaPipe hand landmarks into semantic finger curls and a palm placement.
 *
 * MediaPipe's 21-point layout:
 *   0        wrist
 *   1-4      thumb   CMC, MCP, IP, TIP
 *   5-8      index   MCP, PIP, DIP, TIP
 *   9-12     middle
 *   13-16    ring
 *   17-20    pinky
 *
 * Angles come from the metric world landmarks, which are undistorted; screen
 * placement comes from the normalised landmarks, which are in image space. Using
 * normalised coordinates for angles would bake the camera's aspect ratio into
 * every joint.
 */

interface Point {
  x: number;
  y: number;
  z: number;
}

/** Per finger: the three joints whose flexion we measure, plus the fingertip. */
const CHAINS: [number, number, number, number][] = [
  [1, 2, 3, 4], // thumb
  [5, 6, 7, 8], // index
  [9, 10, 11, 12], // middle
  [13, 14, 15, 16], // ring
  [17, 18, 19, 20], // pinky
];

/**
 * The usable flexion band, in degrees, that gets remapped onto 0..1.
 *
 * A straight finger still measures a few degrees, and the ceiling is far lower
 * than intuition suggests: a human PIP joint tops out near 90-100°, not 180°.
 * Setting the ceiling too high is silently wrong rather than broken — a real
 * fist mapped to only ~0.55 curl, so the avatar's hand never fully closed.
 */
const STRAIGHT_DEG = 10;
const CURLED_DEG = 95;

/**
 * The thumb's own band. It is NOT a finger.
 *
 * Measured across the same chain, a closed fist bends the thumb's MCP and IP to
 * roughly 40-55° between them, nowhere near the 95° a PIP reaches. Scoring it on
 * the finger band capped a real fist near 0.45 curl, and the rig then halves the
 * thumb again — so the thumb moved about a fifth as far as the fingers beside
 * it, which reads as not moving at all.
 */
const THUMB_STRAIGHT_DEG = 8;
const THUMB_CURLED_DEG = 55;

export function solveHand(world: Point[], screen: Point[]): HandPose | null {
  if (world.length < 21 || screen.length < 21) return null;

  const curls = CHAINS.map(([a, b, c, d], finger) => {
    // Two joints per finger, averaged: one alone is noisy, and the distal joint
    // barely moves independently on most hands anyway.
    const proximal = angleAt(world[a]!, world[b]!, world[c]!);
    const distal = angleAt(world[b]!, world[c]!, world[d]!);
    const straight = finger === 0 ? THUMB_STRAIGHT_DEG : STRAIGHT_DEG;
    const curled = finger === 0 ? THUMB_CURLED_DEG : CURLED_DEG;
    return clamp01(((proximal + distal) / 2 - straight) / (curled - straight));
  }) as [number, number, number, number, number];

  // Fan measured across the knuckles, normalised by palm width so it does not
  // change when the hand moves closer to the camera.
  const palmWidth = distance(world[5]!, world[17]!) || 1;
  const tipSpan = distance(world[8]!, world[20]!);
  const spread = clamp01((tipSpan / palmWidth - 0.8) / 0.9);

  // Middle-finger MCP is the steadiest palm centre; the wrist wobbles.
  const palm = screen[9]!;

  // Palm orientation from the world landmarks: fingers direction plus the
  // index×pinky normal. Left hands produce the opposite normal sign; the rig
  // corrects for that because only it knows which side this hand landed on.
  const wristPoint = world[0]!;
  const fingersDir = normalize(subtract(world[9]!, wristPoint));
  const palmNormal = normalize(
    cross(subtract(world[5]!, wristPoint), subtract(world[17]!, wristPoint)),
  );

  // Apparent size: palm width and palm length foreshorten under different
  // rotations, so the larger of the two is the steadier depth proxy.
  const size = Math.max(
    Math.hypot(screen[5]!.x - screen[17]!.x, screen[5]!.y - screen[17]!.y),
    Math.hypot(screen[0]!.x - screen[9]!.x, screen[0]!.y - screen[9]!.y),
  );

  return {
    curls,
    spread,
    size,
    // Filled in by the caller, which knows where the face is.
    relative: null,
    basis:
      fingersDir && palmNormal
        ? { fingers: fingersDir, normal: palmNormal }
        : null,
    position: {
      x: palm.x * 2 - 1,
      // Image y grows downward.
      y: 1 - palm.y * 2,
      z: palm.z,
    },
    roll: Math.atan2(screen[17]!.y - screen[5]!.y, screen[17]!.x - screen[5]!.x),
  };
}

/** Interior angle at `b`, in degrees. */
function angleAt(a: Point, b: Point, c: Point): number {
  const ba = { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
  const bc = { x: c.x - b.x, y: c.y - b.y, z: c.z - b.z };
  const lengths = magnitude(ba) * magnitude(bc);
  if (lengths === 0) return 180;

  const cosine = (ba.x * bc.x + ba.y * bc.y + ba.z * bc.z) / lengths;
  // The measured quantity is flexion, i.e. departure from straight.
  return 180 - (Math.acos(Math.min(1, Math.max(-1, cosine))) * 180) / Math.PI;
}

function magnitude(p: Point): number {
  return Math.hypot(p.x, p.y, p.z);
}

function subtract(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function cross(a: Point, b: Point): Point {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function normalize(p: Point): [number, number, number] | null {
  const length = magnitude(p);
  if (length < 1e-6) return null;
  return [p.x / length, p.y / length, p.z / length];
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
