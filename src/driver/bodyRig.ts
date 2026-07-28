import * as THREE from 'three';
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';
import type { BodyPose } from '../types';
import { OneEuroFilter, deadzone } from './filters';

export interface BodyRigConfig {
  /** Sway and tilt the upper body with the tracked shoulder line. */
  torso: boolean;
  /** Multiplier on everything here. Above 1 exaggerates, which reads on stream. */
  gain: number;
}

export const defaultBodyRigConfig: BodyRigConfig = {
  torso: true,
  gain: 1,
};

/** Radians of spine rotation at a full-width sway. Small on purpose. */
const SWAY_LIMIT = 0.3;
const TILT_LIMIT = 0.28;
/** Fraction of the measured shoulder-line roll passed through. */
const TILT_SHARE = 0.6;

/**
 * Share of the motion taken by the spine rather than the chest.
 *
 * Rotating one bone by the whole amount reads as a hinge. Splitting it the way
 * head motion is split between head and neck gives a curve through the torso,
 * which is what a person actually does when they lean.
 */
const SPINE_SHARE = 0.6;

/**
 * Upper-body sway, from the pose detector.
 *
 * Kept apart from {@link HandRig} because the two solve different problems from
 * different landmarks: hands are precise IK against a close-up detector, this is
 * a coarse read of posture. Mixing them would mean one detector's jitter shaking
 * bones the other owns.
 *
 * Shoulder bones are deliberately untouched. Driving them from a tracked shrug
 * was tried and removed — raised shoulders read as hunched and withdrawn, which
 * is not the body language anyone wants on a broadcast.
 *
 * Everything is clamped hard. A single webcam's pose estimate wanders, and a
 * torso that occasionally snaps sideways is far worse than one that under-reacts.
 */
export class BodyRig {
  config: BodyRigConfig = { ...defaultBodyRigConfig };

  applied = 0;

  private readonly filters = new Map<string, OneEuroFilter>();
  private readonly scratch = new THREE.Euler();
  private readonly target = new THREE.Quaternion();
  private readonly rest = new THREE.Quaternion();

  /**
   * @param mirror Must match the driver's setting: the pose carries the USER'S
   *   own left and right, so mirroring decides which way the avatar leans.
   */
  apply(vrm: VRM, body: BodyPose | null, timestamp: number, mirror: boolean): void {
    this.applied = 0;
    const humanoid = vrm.humanoid;
    if (!humanoid) return;

    if (!body || !this.config.torso) {
      this.relax(vrm);
      return;
    }

    const gain = this.config.gain;

    const swayRaw = this.smooth('sway', deadzone(body.sway, 0.02), timestamp);
    const tiltRaw = this.smooth('tilt', deadzone(body.tilt, 0.02), timestamp);

    const sway = clamp(swayRaw * 1.4 * gain, -SWAY_LIMIT, SWAY_LIMIT);
    const tilt = clamp(tiltRaw * TILT_SHARE * gain, -TILT_LIMIT, TILT_LIMIT);

    /*
     * Both signals are "toward the user's own left" when positive.
     *
     * Mirrored, the user's left belongs on SCREEN-LEFT, which is −X. A positive
     * rotation about Z tips the top of the torso toward −X, so mirrored motion
     * takes the value straight through and unmirrored motion negates it. This is
     * the same single decision `mirror` makes everywhere else: which side of the
     * screen the movement shows up on.
     */
    const toScreen = mirror ? 1 : -1;
    const amount = (sway + tilt) * toScreen;

    this.rotate(humanoid, 'spine', amount * SPINE_SHARE);
    // upperChest is optional in VRM; chest is the reliable fallback.
    const upper = humanoid.getNormalizedBoneNode('upperChest' as VRMHumanBoneName);
    this.rotate(humanoid, upper ? 'upperChest' : 'chest', amount * (1 - SPINE_SHARE));
  }

  private rotate(
    humanoid: NonNullable<VRM['humanoid']>,
    bone: string,
    radians: number,
  ): void {
    const node = humanoid.getNormalizedBoneNode(bone as VRMHumanBoneName);
    if (!node) return;

    this.scratch.set(0, 0, radians, 'XYZ');
    this.target.setFromEuler(this.scratch);
    node.quaternion.slerp(this.target, 0.25);
    this.applied++;
  }

  /** Eases back to rest when the body is lost, or when torso tracking is off. */
  private relax(vrm: VRM): void {
    const humanoid = vrm.humanoid;
    if (!humanoid) return;

    for (const name of ['spine', 'chest', 'upperChest']) {
      humanoid.getNormalizedBoneNode(name as VRMHumanBoneName)?.quaternion.slerp(this.rest, 0.08);
    }
  }

  private smooth(key: string, value: number, timestamp: number): number {
    let filter = this.filters.get(key);
    if (!filter) {
      // Posture moves slowly, so this can be smoothed harder than hands.
      filter = new OneEuroFilter(0.8, 0.01);
      this.filters.set(key, filter);
    }
    return filter.filter(value, timestamp);
  }

  reset(): void {
    for (const filter of this.filters.values()) filter.reset();
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
