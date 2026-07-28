/** A bone's local pose as sent by a full-rig source. Quaternion is (x, y, z, w). */
export interface BonePose {
  rotation: [number, number, number, number];
  position?: [number, number, number] | undefined;
}

/**
 * The normalised frame every tracking backend produces.
 *
 * This is the seam of the whole app: nothing downstream of `PoseFrame` knows
 * whether the data came from a webcam, from VSeeFace over VMC, from an iPhone,
 * or from a remote collaborator's browser. Adding a tracker means adding one
 * adapter, never touching the avatar code.
 *
 * Sources fill in only what they can produce and leave the rest empty. A webcam
 * gives ARKit coefficients and a head angle; a VMC sender gives a whole rig and
 * VRM-named expression weights. The driver picks the richest data available
 * rather than forcing everything through a lowest common denominator.
 */
export interface PoseFrame {
  /**
   * ARKit-compatible blendshape coefficients (0..1), keyed by MediaPipe's
   * category name — `jawOpen`, `eyeBlinkLeft`, `browInnerUp`, and so on.
   */
  shapes: Map<string, number>;

  /**
   * VRM-named expression weights, as sent by VMC performers (`A`, `Blink_L`,
   * `Joy`, …). Case-sensitive per the UniVRM spec.
   */
  expressions: Map<string, number>;

  /**
   * Humanoid bone local rotations, keyed by *VRM* bone name (`head`,
   * `leftUpperArm`, `leftThumbMetacarpal`, …). Present only for full-rig
   * sources; when non-empty the driver applies these instead of deriving pose
   * from blendshapes.
   */
  bones: Map<string, BonePose>;

  /** Head orientation in radians, or null when the source has no head angle. */
  head: HeadPose | null;

  /** Solved hands, when the source tracks them. */
  hands: HandSet;

  /** Upper body from the pose detector, or null when it is off or lost. */
  body: BodyPose | null;

  /** Microphone loudness 0..1. Zero until an audio source is attached. */
  audioLevel: number;

  /** `performance.now()` at capture time. */
  timestamp: number;

  /** False while the source is running but has lost the subject. */
  tracked: boolean;
}

/**
 * A solved hand, in semantic terms rather than raw landmarks.
 *
 * Keeping landmarks out of `PoseFrame` matters: the driver should not have to
 * know that MediaPipe numbers the pinky MCP 17. Every hand source produces
 * curls and a screen position, whatever its underlying representation.
 */
export interface HandPose {
  /** Per-finger flexion 0 (straight) to 1 (fully curled), thumb first. */
  curls: [number, number, number, number, number];
  /** Fanning between fingers, 0 (together) to 1 (spread). */
  spread: number;
  /** Palm centre in view space: x/y in -1..1 (y up), z negative = nearer camera. */
  position: { x: number; y: number; z: number };
  /**
   * Palm centre relative to the face, in face-width units (x right, y up), plus
   * the hand's apparent size in the same units — a hand nearer the camera looks
   * bigger, which is the only depth signal a single webcam has.
   *
   * This, not `position`, is what drives the arms: absolute screen coordinates
   * change with camera placement and framing, but "one face-width left of my
   * chin" means the same thing on every webcam. Null when no face is visible.
   */
  relative: { x: number; y: number; size: number } | null;

  /**
   * Apparent hand size in normalised image units: the larger of palm width and
   * palm length, since whichever is more foreshortened understates the size.
   */
  size: number;
  /** Palm rotation in the view plane, radians. */
  roll: number;
  /**
   * Palm orientation in MediaPipe world coordinates (x image-right, y down,
   * z away from camera): where the fingers point, and the palm-out normal
   * (chirality-corrected by the producer, so it means palm-out for either
   * hand). Null when the landmarks were degenerate.
   */
  basis: { fingers: [number, number, number]; normal: [number, number, number] } | null;
}

export interface HandSet {
  /** The USER'S physical left hand. The driver maps physical→avatar sides. */
  left: HandPose | null;
  /** The user's physical right hand. */
  right: HandPose | null;
}

/**
 * Upper body, from the pose detector.
 *
 * Measured in shoulder-width units rather than pixels, so sitting closer to the
 * camera does not read as a bigger movement.
 *
 * Deliberately just two numbers. An earlier version also reported a per-shoulder
 * shrug, which turned out to be the wrong thing entirely: raised shoulders read
 * as a hunched, withdrawn posture rather than as expression. And it measured
 * lean from the hips, which a bust-framed webcam almost never sees — so the one
 * signal that mattered was usually absent.
 */
export interface BodyPose {
  /**
   * Sideways movement of the shoulder midpoint against a slow running baseline,
   * in shoulder-width units. Positive means the user moved to their OWN left.
   *
   * This is what "sway your upper body" actually is, and unlike a hip-relative
   * lean it needs nothing below the shoulders to be in frame.
   */
  sway: number;
  /** Roll of the shoulder line, radians. Positive raises the user's left side. */
  tilt: number;
}

export interface HeadPose {
  /** Nod. Positive = looking up. */
  pitch: number;
  /** Turn. Positive = turning to the subject's left. */
  yaw: number;
  /** Tilt. Positive = tilting to the subject's left. */
  roll: number;
}

export function emptyFrame(): PoseFrame {
  return {
    shapes: new Map(),
    expressions: new Map(),
    bones: new Map(),
    head: null,
    hands: { left: null, right: null },
    body: null,
    audioLevel: 0,
    timestamp: performance.now(),
    tracked: false,
  };
}
