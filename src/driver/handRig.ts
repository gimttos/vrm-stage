import * as THREE from 'three';
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';
import type { HandPose, HandSet } from '../types';
import { OneEuroFilter } from './filters';

export interface HandRigConfig {
  /** Curl the fingers from tracked flexion. */
  fingers: boolean;
  /**
   * Drive the arms with a two-bone analytic IK.
   *
   * A pole vector (down, outward, slightly back — where a human elbow actually
   * sits) fixes the plane the elbow bends in. That removes the twist ambiguity
   * that made the old aim-and-bend approach fold shoulders backwards: with the
   * plane pinned and the reach clamped away from full extension, there is no
   * configuration where the solve flips.
   */
  arms: boolean;
  /** Horizontal reach multiplier: how far the hand travels for a given camera motion. */
  armReach: number;
  /** Flip finger bend direction, should curls go the wrong way. */
  invertCurl: boolean;

  /**
   * Per-camera sign corrections for where the arm reaches, matching the head's
   * `invertPitch`/`invertYaw`/`invertRoll`.
   *
   * The internal mapping is verified correct — a hand above the face raises the
   * avatar's hand, a hand nearer the camera reaches forward. But what a given
   * webcam and driver actually report for "above" and "nearer" is not something
   * this code can know, and a vertically flipped feed or an unreliable size cue
   * inverts them. One glance settles it; guessing from a bug report does not.
   */
  invertArmY: boolean;
  /** Depth comes from apparent hand size, which foreshortening can invert. */
  invertArmZ: boolean;
  /** Rotate the wrist from the tracked palm orientation. */
  wrist: boolean;
}

export const defaultHandRigConfig: HandRigConfig = {
  fingers: true,
  arms: true,
  armReach: 1,
  invertCurl: false,
  invertArmY: false,
  invertArmZ: false,
  wrist: true,
};

type Side = 'left' | 'right';
type Finger = 'Thumb' | 'Index' | 'Middle' | 'Ring' | 'Little';

const FINGERS: Finger[] = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'];

/**
 * How much of a finger's total curl each joint takes, and its ceiling in radians.
 * Real fingers bend most at the middle joint; loading them equally gives a
 * stiff, claw-like hand.
 */
/**
 * Idle pose, used whenever a hand is not tracked.
 *
 * VRM 1.0 mandates a T-pose at rest, which is a rigging convention, not a stance
 * anyone stands in — untracked, the avatar read as a scarecrow. These bring the
 * arms down to the sides with a slight outward clearance so they do not clip the
 * torso, plus a small elbow bend and finger curl so the limb looks relaxed
 * rather than rigid.
 */
const IDLE_ARM_DEG = 72;
const IDLE_ELBOW_DEG = 9;
const IDLE_CURL = 0.18;

const JOINT_LIMITS: Record<'proximal' | 'intermediate' | 'distal', number> = {
  proximal: 1.15,
  intermediate: 1.4,
  distal: 0.85,
};

/** VRM 1.0 joint names per finger, proximal to distal. */
function jointNames(side: Side, finger: Finger): [string, string, string] {
  const prefix = side === 'left' ? 'left' : 'right';
  if (finger === 'Thumb') {
    return [
      `${prefix}ThumbMetacarpal`,
      `${prefix}ThumbProximal`,
      `${prefix}ThumbDistal`,
    ];
  }
  return [
    `${prefix}${finger}Proximal`,
    `${prefix}${finger}Intermediate`,
    `${prefix}${finger}Distal`,
  ];
}

export class HandRig {
  config: HandRigConfig = { ...defaultHandRigConfig };

  private readonly curlFilters = new Map<string, OneEuroFilter>();
  private readonly posFilters = new Map<string, OneEuroFilter>();

  /** Eased presence per side, so a lost hand relaxes instead of snapping to rest. */
  private readonly presence: Record<Side, number> = { left: 0, right: 0 };

  private readonly restDirection = new THREE.Vector3();
  private readonly targetDirection = new THREE.Vector3();
  private readonly parentInverse = new THREE.Quaternion();
  private readonly scratchQuat = new THREE.Quaternion();
  private readonly scratchEuler = new THREE.Euler();
  private readonly idleFinger = new THREE.Quaternion();

  /**
   * Arms-down target per side, built once.
   *
   * The left arm's limb axis is +X and the right's is −X, so swinging both down
   * toward −Y takes opposite signs about Z.
   */
  private readonly idleUpper: Record<Side, THREE.Quaternion> = {
    left: new THREE.Quaternion().setFromEuler(
      new THREE.Euler(0, 0, (-IDLE_ARM_DEG * Math.PI) / 180, 'XYZ'),
    ),
    right: new THREE.Quaternion().setFromEuler(
      new THREE.Euler(0, 0, (IDLE_ARM_DEG * Math.PI) / 180, 'XYZ'),
    ),
  };

  private readonly idleLower: Record<Side, THREE.Quaternion> = {
    left: new THREE.Quaternion().setFromEuler(
      new THREE.Euler(0, (IDLE_ELBOW_DEG * Math.PI) / 180, 0, 'XYZ'),
    ),
    right: new THREE.Quaternion().setFromEuler(
      new THREE.Euler(0, (-IDLE_ELBOW_DEG * Math.PI) / 180, 0, 'XYZ'),
    ),
  };
  private readonly shoulderWorld = new THREE.Vector3();
  private readonly handWorld = new THREE.Vector3();
  private readonly headWorld = new THREE.Vector3();
  private readonly hipsWorld = new THREE.Vector3();
  private readonly pole = new THREE.Vector3();
  private readonly elbowSide = new THREE.Vector3();
  private readonly upperDir = new THREE.Vector3();
  private readonly elbowWorld = new THREE.Vector3();
  private readonly forearmDir = new THREE.Vector3();
  private readonly worldQuat = new THREE.Quaternion();
  private readonly basisX = new THREE.Vector3();
  private readonly basisY = new THREE.Vector3();
  private readonly basisZ = new THREE.Vector3();
  private readonly basisMatrix = new THREE.Matrix4();

  applied = 0;

  /**
   * Call before `vrm.update()`, like the rest of the bone writes.
   *
   * @param mirror The driver's mirror setting; hands must agree with the face
   *   about which way is left or the avatar reaches across its own body.
   */
  apply(vrm: VRM, hands: HandSet, timestamp: number, mirror = true): void {
    this.applied = 0;
    if (!vrm.humanoid) return;

    for (const side of ['left', 'right'] as Side[]) {
      const pose = hands[side];
      const target = pose ? 1 : 0;
      // ~150ms to fade in or out.
      this.presence[side] += (target - this.presence[side]) * 0.12;

      if (!pose) {
        // Runs even at zero presence, which the old early-return skipped — that
        // is why an untracked model sat in its T-pose rest forever instead of
        // standing there with its arms down.
        this.relax(vrm, side);
        continue;
      }

      if (this.config.fingers) this.applyFingers(vrm, side, pose, timestamp);
      if (this.config.arms) this.applyArm(vrm, side, pose, timestamp, mirror);
    }
  }

  /**
   * Eases one side's arm and fingers to the idle pose: arms down at the sides.
   *
   * Not the rig's rest pose — VRM 1.0 mandates a T-pose, which reads as a
   * scarecrow the moment hands leave frame. The target is built once per side
   * from {@link IDLE_ARM_DEG}: rotating about Z swings the limb axis (+X for the
   * left arm, −X for the right) down toward −Y, so the two sides take opposite
   * signs.
   */
  private relax(vrm: VRM, side: Side): void {
    const humanoid = vrm.humanoid;
    if (!humanoid) return;

    const prefix = side === 'left' ? 'left' : 'right';

    humanoid
      .getNormalizedBoneNode(`${prefix}UpperArm` as VRMHumanBoneName)
      ?.quaternion.slerp(this.idleUpper[side], 0.1);
    humanoid
      .getNormalizedBoneNode(`${prefix}LowerArm` as VRMHumanBoneName)
      ?.quaternion.slerp(this.idleLower[side], 0.1);

    // A completely straight hand looks like a mannequin; real hands rest with a
    // little curl in them.
    for (const finger of FINGERS) {
      const curlSign = (side === 'left' ? -1 : 1) * (this.config.invertCurl ? -1 : 1);
      jointNames(side, finger).forEach((joint, depth) => {
        const node = humanoid.getNormalizedBoneNode(joint as VRMHumanBoneName);
        if (!node) return;
        const amount = IDLE_CURL * [1, 0.9, 0.7][depth]!;
        this.scratchEuler.set(0, 0, curlSign * amount, 'XYZ');
        this.idleFinger.setFromEuler(this.scratchEuler);
        node.quaternion.slerp(this.idleFinger, 0.12);
      });
    }
  }

  private applyFingers(vrm: VRM, side: Side, pose: HandPose | null, timestamp: number): void {
    const weight = this.presence[side];

    // Left fingers curl by rotating +X toward -Y, which is negative about Z;
    // the right hand points down -X so its sign flips.
    const sideSign = side === 'left' ? -1 : 1;
    const curlSign = sideSign * (this.config.invertCurl ? -1 : 1);

    FINGERS.forEach((finger, index) => {
      const raw = pose?.curls[index] ?? 0;
      const curl = this.smooth(this.curlFilters, `${side}:${finger}`, raw, timestamp) * weight;
      const names = jointNames(side, finger);

      (['proximal', 'intermediate', 'distal'] as const).forEach((joint, depth) => {
        const node = vrm.humanoid?.getNormalizedBoneNode(names[depth] as VRMHumanBoneName);
        if (!node) return;

        const angle = curl * JOINT_LIMITS[joint];

        if (finger === 'Thumb') {
          // The thumb opposes rather than curls into the palm, so it swings about
          // a different axis. Most likely part of this file to need tuning.
          node.rotation.set(0, curlSign * angle * 0.55, curlSign * angle * 0.45, 'XYZ');
        } else {
          const fan = pose ? (pose.spread - 0.5) * 0.18 * (index - 2) : 0;
          node.rotation.set(0, joint === 'proximal' ? fan * weight : 0, curlSign * angle, 'XYZ');
        }
        this.applied++;
      });
    });
  }

  /**
   * Two-bone analytic IK with a pole vector.
   *
   * Every quantity is computed in world space and converted through the actual
   * parent rotations, so it also survives the 180° root turn `rotateVRM0`
   * applies to 0.x models. No sign toggles: the pole fixes the elbow plane and
   * the forearm rotation is *derived* (elbow→target, both known points), not
   * guessed from an axis convention.
   */
  private applyArm(
    vrm: VRM,
    side: Side,
    pose: HandPose,
    timestamp: number,
    mirror: boolean,
  ): void {
    const humanoid = vrm.humanoid;
    if (!humanoid) return;

    // Without a face there is no anchor, and absolute screen coordinates were
    // exactly what sent hands to the wrong place. Better a still arm than a
    // wrong one.
    const relative = pose.relative;
    if (!relative) return;

    const prefix = side === 'left' ? 'left' : 'right';
    const upper = humanoid.getNormalizedBoneNode(`${prefix}UpperArm` as VRMHumanBoneName);
    const lower = humanoid.getNormalizedBoneNode(`${prefix}LowerArm` as VRMHumanBoneName);
    const hand = humanoid.getNormalizedBoneNode(`${prefix}Hand` as VRMHumanBoneName);
    const head = humanoid.getNormalizedBoneNode('head');
    const hips = humanoid.getNormalizedBoneNode('hips');
    if (!upper || !lower || !head || !hips) return;

    const weight = this.presence[side];
    const sideSign = side === 'left' ? 1 : -1;
    const mirrorSign = mirror ? -1 : 1;

    head.getWorldPosition(this.headWorld);
    hips.getWorldPosition(this.hipsWorld);
    upper.getWorldPosition(this.shoulderWorld);

    // Torso length is the same scale proxy the camera framing uses.
    const scale = Math.max(0.15, this.headWorld.y - this.hipsWorld.y);

    const x = this.smooth(this.posFilters, `${side}:x`, relative.x, timestamp) * mirrorSign;
    const y =
      this.smooth(this.posFilters, `${side}:y`, relative.y, timestamp) *
      (this.config.invertArmY ? -1 : 1);

    // Depth from apparent hand size — the only depth cue a single webcam has.
    // A hand at face depth measures ~0.62 face-widths; bigger means nearer the
    // camera, i.e. further toward the viewer (+Z). Gain is modest and clamped
    // because size also wobbles with hand rotation. This is what lets the
    // distance BETWEEN the hands read in 3D instead of both being pinned to
    // one plane.
    const depthRaw =
      relative.size > 0
        ? Math.min(0.45, Math.max(-0.3, (relative.size / 0.62 - 1) * 0.8))
        : 0;
    const depth =
      this.smooth(this.posFilters, `${side}:z`, depthRaw, timestamp) *
      (this.config.invertArmZ ? -1 : 1);

    // Map face-width units onto the avatar: its own face is ~0.35 torso-lengths
    // wide, so "two face-widths from the chin" lands at the same body-relative
    // spot on any model. The avatar faces +Z, so in front is +Z — this sign was
    // backwards once, and the IK dutifully reached behind the avatar's back.
    const unit = scale * 0.35 * this.config.armReach;
    this.handWorld.set(
      this.headWorld.x + x * unit,
      this.headWorld.y + y * unit,
      this.shoulderWorld.z + scale * (0.45 + depth),
    );

    // Bone lengths from the rig itself. The hand offset stands in for
    // forearm-to-palm; slightly extended so the palm, not the wrist, meets the
    // target.
    const upperLength = Math.max(0.05, lower.position.length());
    const lowerLength = Math.max(0.05, (hand?.position.length() ?? upperLength * 0.85) * 1.1);

    this.targetDirection.copy(this.handWorld).sub(this.shoulderWorld);
    const rawDistance = this.targetDirection.length();
    if (rawDistance < 1e-4) return;
    this.targetDirection.normalize();

    // Clamp reach away from both singularities: full extension (direction flips
    // become visible) and full fold (elbow angle undefined).
    const distance = Math.min(
      Math.max(rawDistance, Math.abs(upperLength - lowerLength) + 0.02),
      (upperLength + lowerLength) * 0.98,
    );

    // The elbow plane. Human elbows at rest point down, a little outward, and a
    // little behind the chest plane — that last part is what makes a hand held
    // near the face read as a natural tucked arm rather than a chicken wing.
    // Behind = -Z, since the avatar faces +Z.
    this.pole.set(sideSign * 0.3, -1, -0.3).normalize();
    this.elbowSide
      .copy(this.pole)
      .addScaledVector(this.targetDirection, -this.pole.dot(this.targetDirection));
    if (this.elbowSide.lengthSq() < 1e-6) {
      // Hand straight along the pole; any perpendicular will do, stably.
      this.elbowSide.set(sideSign, 0, 0);
    }
    this.elbowSide.normalize();

    // Law of cosines: how far the upper arm swings off the shoulder-target line.
    const cosShoulder = Math.min(
      1,
      Math.max(
        -1,
        (upperLength * upperLength + distance * distance - lowerLength * lowerLength) /
          (2 * upperLength * distance),
      ),
    );
    const sinShoulder = Math.sqrt(1 - cosShoulder * cosShoulder);

    this.upperDir
      .copy(this.targetDirection)
      .multiplyScalar(cosShoulder)
      .addScaledVector(this.elbowSide, sinShoulder);

    // Upper arm: world direction into parent space, shortest arc from rest.
    upper.parent?.getWorldQuaternion(this.parentInverse);
    this.parentInverse.invert();
    this.restDirection.set(sideSign, 0, 0);
    this.scratchQuat.setFromUnitVectors(
      this.restDirection,
      this.targetDirection.copy(this.upperDir).applyQuaternion(this.parentInverse),
    );
    upper.quaternion.slerp(this.scratchQuat, weight);

    // Forearm: derived, not guessed. The elbow sits at a known world point; the
    // forearm must run from there to the target. Convert that world direction
    // into the upper arm's actual (post-slerp) frame and rotate from rest.
    this.elbowWorld.copy(this.shoulderWorld).addScaledVector(this.upperDir, upperLength);
    this.forearmDir.copy(this.handWorld).sub(this.elbowWorld);

    // Re-derive the reachable target implied by the clamped distance: when the
    // raw target is out of range the forearm still points sensibly.
    if (this.forearmDir.lengthSq() < 1e-6) {
      this.forearmDir.copy(this.upperDir);
    }
    this.forearmDir.normalize();

    upper.getWorldQuaternion(this.worldQuat);
    this.worldQuat.invert();
    this.scratchQuat.setFromUnitVectors(
      this.restDirection,
      this.forearmDir.applyQuaternion(this.worldQuat),
    );
    lower.quaternion.slerp(this.scratchQuat, weight);

    this.applied += 2;

    if (this.config.wrist && hand && pose.basis) {
      this.applyWrist(hand, lower, pose, side, mirrorSign, weight);
      this.applied += 1;
    }
  }

  /**
   * Orients the hand bone from the tracked palm basis.
   *
   * The camera-to-avatar vector map, derived once instead of toggled forever.
   * MediaPipe world: x image-right, y down, z away from camera. Avatar world:
   * faces +Z toward the viewer, screen-right +X, up +Y. Copying anatomically
   * (non-mirror) maps a user vector as (x, -y, -z); mirroring flips x on top of
   * that. The z flip is the one that was missing when wrists pointed backwards.
   *
   * Dropping the mirror flip here was tried and reverted: the reasoning was that
   * an orientation, unlike a position, has its reflection absorbed by the
   * opposite limb's already-mirrored rest frame. In practice that bent the palm
   * the other way, so the flip stays. Whatever remains wrong with the wrist is
   * not this.
   */
  private applyWrist(
    hand: THREE.Object3D,
    lower: THREE.Object3D,
    pose: HandPose,
    side: Side,
    mirrorSign: number,
    weight: number,
  ): void {
    const basis = pose.basis;
    if (!basis) return;

    // `side` is the avatar side; local fingers-axis is +X left hand, -X right.
    const sideSign = side === 'left' ? 1 : -1;

    this.basisX
      .set(basis.fingers[0] * mirrorSign, -basis.fingers[1], -basis.fingers[2])
      .multiplyScalar(sideSign);

    // basis.normal arrives chirality-corrected (always palm-out). VRM rest pose
    // has palms down, so palm-out is local -Y: the +Y column is its negation.
    this.basisY
      .set(basis.normal[0] * mirrorSign, -basis.normal[1], -basis.normal[2])
      .multiplyScalar(-1);

    if (this.basisX.lengthSq() < 1e-6 || this.basisY.lengthSq() < 1e-6) return;
    this.basisX.normalize();

    this.basisZ.crossVectors(this.basisX, this.basisY);
    if (this.basisZ.lengthSq() < 1e-6) return;
    this.basisZ.normalize();
    this.basisY.crossVectors(this.basisZ, this.basisX);

    this.basisMatrix.makeBasis(this.basisX, this.basisY, this.basisZ);
    this.worldQuat.setFromRotationMatrix(this.basisMatrix);

    // World orientation into the forearm's frame.
    lower.getWorldQuaternion(this.parentInverse);
    this.parentInverse.invert();
    this.scratchQuat.copy(this.parentInverse).multiply(this.worldQuat);
    hand.quaternion.slerp(this.scratchQuat, weight * 0.85);
  }

  private smooth(
    bank: Map<string, OneEuroFilter>,
    key: string,
    value: number,
    timestamp: number,
  ): number {
    let filter = bank.get(key);
    if (!filter) {
      // Hands jitter harder than faces: small features, fast motion, and a
      // detector that re-acquires between frames.
      filter = new OneEuroFilter(1.0, 0.02);
      bank.set(key, filter);
    }
    return filter.filter(value, timestamp);
  }

  reset(): void {
    for (const filter of this.curlFilters.values()) filter.reset();
    for (const filter of this.posFilters.values()) filter.reset();
    this.presence.left = 0;
    this.presence.right = 0;
  }
}
