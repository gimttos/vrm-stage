import type { BodyPose } from '../types';

/** MediaPipe pose landmark indices we use. */
const LEFT_SHOULDER = 11;
const RIGHT_SHOULDER = 12;

/** Below this the landmark is a guess, and a guessed shoulder is worse than none. */
const MIN_VISIBILITY = 0.6;

interface Landmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

/**
 * Turns pose landmarks into upper-body sway.
 *
 * Only the two shoulder landmarks are read, and only for where the shoulder line
 * *is* — not how high each end sits. Per-shoulder shrug was tried and removed:
 * raised shoulders read as a hunched, withdrawn posture, which is the opposite of
 * expressive. Elbows and wrists are ignored too, because the hand tracker already
 * solves the arms from a much closer view and two solvers fighting over the same
 * bones is worse than one.
 *
 * The slow baseline is what makes sway usable. Where the shoulders sit in frame
 * depends entirely on how the operator is sitting, so absolute position carries
 * no information — only the deviation does. It adapts slowly enough that a held
 * lean still reads, then drifts to whatever posture is being maintained.
 */
export class BodySolver {
  private baseline: { x: number } | null = null;

  /** ~15s at 30fps: fast enough to follow posture, slow enough to keep a lean. */
  private readonly adapt = 0.0022;

  solve(landmarks: Landmark[] | undefined): BodyPose | null {
    if (!landmarks || landmarks.length <= RIGHT_SHOULDER) return null;

    const left = landmarks[LEFT_SHOULDER];
    const right = landmarks[RIGHT_SHOULDER];
    if (!visible(left) || !visible(right)) {
      // Losing the subject must not leave a stale baseline, or the next
      // acquisition reads as a huge lurch.
      this.baseline = null;
      return null;
    }

    // HORIZONTAL separation as the scale reference, not the 2D distance between
    // the shoulders: the 2D distance changes when the shoulder line tilts, which
    // would make a tilt leak into the sway measurement.
    const width = Math.abs(left.x - right.x);
    if (width < 1e-3) return null;

    // MediaPipe labels sides anatomically, so LEFT_SHOULDER is the user's own
    // left — which appears on the IMAGE-right. Moving to their own left
    // therefore increases image x, making positive sway "toward the user's left".
    const midX = (left.x + right.x) / 2;

    if (!this.baseline) {
      this.baseline = { x: midX };
    } else {
      this.baseline.x += (midX - this.baseline.x) * this.adapt;
    }

    return {
      sway: (midX - this.baseline.x) / width,
      // atan2 over the shoulder line, matching HeadPose.roll's convention that
      // positive tilts toward the subject's left.
      tilt: Math.atan2(right.y - left.y, width),
    };
  }

  reset(): void {
    this.baseline = null;
  }
}

function visible(landmark: Landmark | undefined): landmark is Landmark {
  return landmark !== undefined && (landmark.visibility ?? 1) >= MIN_VISIBILITY;
}
