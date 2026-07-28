import * as THREE from 'three';
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';
import type { MorphIndex } from '../stage/AvatarLoader';
import type { PoseFrame } from '../types';
import { OneEuroFilter, clamp01, deadzone, snap } from './filters';
import { BodyRig } from './bodyRig';
import { HandRig } from './handRig';

export interface DriverConfig {
  /**
   * Mirror the avatar, like a mirror rather than a video call.
   *
   * The single switch that decides which side of the screen motion appears on.
   * The convention it implements: the avatar faces +Z with the camera at +Z, so
   * screen-right is +X and the avatar's own LEFT limb appears on screen-RIGHT.
   * Mirroring therefore means "the user's right side shows up on screen-right",
   * which needs both a side swap and a position flip for the hands — one picks
   * which arm, the other picks which direction. Flipping only one is how arms end
   * up reaching across the body.
   *
   * Applies to: head yaw and roll, eye blink L/R, gaze x, and hands. NOT brows —
   * those are averaged into one symmetric value, so there is no side to swap.
   *
   * MediaPipe names shapes anatomically (`eyeBlinkLeft` is the subject's left
   * eye) while VRM names them from the model's point of view, so whether these
   * line up depends on whether the pixels fed to the tracker were flipped. This
   * is the bug every implementation ships once; it is a toggle so it takes one
   * glance to settle instead of an afternoon.
   */
  mirror: boolean;

  /**
   * Per-camera sign corrections, applied ON TOP of `mirror`.
   *
   * These are orthogonal to mirroring: `mirror` decides which side of the screen
   * the motion appears on, and these only fix a tracker whose raw axis sign runs
   * the other way. They used to default to `true` for yaw and roll, which
   * cancelled `mirror` exactly — net multiplier `(-1) × (-1) = +1` — so the head
   * was NOT mirrored while the hands were, and the two disagreed about which way
   * is left. Confirm visually once, then forget.
   */
  invertPitch: boolean;
  invertYaw: boolean;
  invertRoll: boolean;

  /** Multiplier on head rotation. Above 1 exaggerates, which reads well on stream. */
  headGain: number;

  /**
   * Neutral-pose offsets in radians, subtracted from the incoming head pose.
   *
   * A webcam sitting below eye level sees the face from underneath and reports a
   * permanently raised chin — the taller you sit, the worse it gets. Rather than
   * guessing a correction, we let the user declare "this is me at rest" and
   * subtract it. Fixes camera placement, seat height, and posture in one action.
   */
  pitchOffset: number;
  yawOffset: number;
  rollOffset: number;

  /**
   * Fraction of head rotation delegated to the neck bone. Driving `head` alone
   * looks like a snapped spine; humans turn with both.
   */
  neckShare: number;

  /** Drive `Fcl_BRW_*` morphs directly. VRM presets contain no eyebrows. */
  brows: boolean;

  /** Eye tracking via VRM lookAt. */
  gaze: boolean;
  /** Flip gaze direction, for a tracker that reports eye look the other way. */
  invertGaze: boolean;
}

export const defaultDriverConfig: DriverConfig = {
  mirror: true,
  invertPitch: false,
  // Left at false so `mirror` is the ONLY thing deciding screen side. With these
  // on, mirroring was silently undone for the head while the hands still obeyed
  // it — leaning left moved the avatar screen-right while a raised right hand
  // correctly appeared screen-right.
  invertYaw: false,
  invertRoll: false,
  headGain: 1.15,
  pitchOffset: 0,
  yawOffset: 0,
  rollOffset: 0,
  neckShare: 0.4,
  brows: true,
  gaze: true,
  invertGaze: false,
};

export interface DriverDebug {
  tracked: boolean;
  pitch: number;
  yaw: number;
  roll: number;
  blinkL: number;
  blinkR: number;
  mouthOpen: number;
  browUp: number;
  browDown: number;
  browMorphs: number;
  /** Bones applied from a full-rig source this frame; 0 for webcam. */
  rigBones: number;
  /** Finger/arm bones written from webcam hand tracking. */
  handBones: number;
  /** Shoulder/chest bones written from webcam pose tracking. */
  bodyBones: number;
}

/**
 * Turns a {@link PoseFrame} into avatar motion.
 *
 * Owns the update ordering, because it matters and is easy to get wrong:
 * expressions and bones must be written *before* `vrm.update()`, while raw morph
 * overrides must be written *after* it — `VRMExpressionManager` rewrites every
 * morph it knows about during the update and would erase them otherwise.
 */
export class AvatarDriver {
  config: DriverConfig = { ...defaultDriverConfig };

  private readonly pitchFilter = new OneEuroFilter(1.0, 0.06);
  private readonly yawFilter = new OneEuroFilter(1.0, 0.06);
  private readonly rollFilter = new OneEuroFilter(1.0, 0.06);
  private readonly mouthFilter = new OneEuroFilter(2.5, 0.02);
  private readonly gazeXFilter = new OneEuroFilter(1.5, 0.03);
  private readonly gazeYFilter = new OneEuroFilter(1.5, 0.03);
  private readonly browUpFilter = new OneEuroFilter(1.2, 0.03);
  private readonly browDownFilter = new OneEuroFilter(1.2, 0.03);

  private readonly lookTarget = new THREE.Object3D();
  private readonly headWorld = new THREE.Vector3();
  private readonly restQuat = new THREE.Quaternion();
  /**
   * −1 when the rig's bone-LOCAL X and Z run backwards against world.
   *
   * True for a VRM 0.x model, whose scene `rotateVRM0` turns 180° about Y. Only
   * local frames are affected; world anatomy is identical on both specs, so this
   * belongs on rotations written into a bone (pitch, roll, torso sway) and NOT on
   * world-space targets (arm reach, gaze).
   */
  private rigFlip = 1;
  private readonly euler = new THREE.Euler();

  private browUpMorphs: { mesh: THREE.Mesh; index: number }[] = [];
  private browDownMorphs: { mesh: THREE.Mesh; index: number }[] = [];

  /** Last uncorrected head pose, so calibration can snapshot the current rest position. */
  private lastRawHead: { pitch: number; yaw: number; roll: number } | null = null;

  private debugState: DriverDebug = {
    tracked: false,
    pitch: 0,
    yaw: 0,
    roll: 0,
    blinkL: 0,
    blinkR: 0,
    mouthOpen: 0,
    browUp: 0,
    browDown: 0,
    browMorphs: 0,
    rigBones: 0,
    handBones: 0,
    bodyBones: 0,
  };

  /** Webcam hand tracking. Unused when a full rig arrives over VMC. */
  readonly hands = new HandRig();
  readonly body = new BodyRig();

  /** Hotkey-driven expression override, VSeeFace-style. */
  private emotionTarget: string | null = null;
  /** Kept while fading out so the expression releases smoothly. */
  private emotionShown: string | null = null;
  private emotionWeight = 0;

  /** Binds to a freshly loaded avatar. Safe to call again when the model changes. */
  attach(vrm: VRM, morphs: MorphIndex, scene: THREE.Scene): void {
    scene.add(this.lookTarget);

    if (vrm.lookAt) {
      vrm.lookAt.target = this.lookTarget;
      // We position the target ourselves every frame.
      vrm.lookAt.autoUpdate = true;
    }

    // The idle arm pose depends on this rig's rest geometry, not on a constant.
    this.hands.prepareIdle(vrm);

    /*
     * Does this rig's bone-LOCAL frame run backwards against world?
     *
     * `rotateVRM0` turns a 0.x scene 180° about Y. World anatomy is unaffected —
     * the eye bones put the avatar's left at world +X and its face at world +Z on
     * both specs — but every normalized bone's local X and Z now point the other
     * way, while local Y is untouched because the turn is about Y.
     *
     * So the rule for every rotation written into a bone's local frame is: flip
     * it if it is about X or Z, leave it if it is about Y. World-space targets
     * (arm reach, gaze) need no correction at all.
     */
    vrm.scene.updateWorldMatrix(true, false);
    vrm.scene.getWorldQuaternion(this.restQuat);
    this.rigFlip = this.restQuat.w * this.restQuat.w < 0.5 ? -1 : 1;
    this.restQuat.identity();

    // Torso sway is written about spine local Z, so it follows the same rule.
    this.body.axisFlip = this.rigFlip;

    this.browUpMorphs = morphs.find('BRW_Surprised');
    this.browDownMorphs = morphs.find('BRW_Angry');
    this.debugState.browMorphs = this.browUpMorphs.length + this.browDownMorphs.length;

    this.resetFilters();
  }

  /**
   * Applies a frame and advances the avatar. Call exactly once per rendered
   * frame; `delta` drives spring bones, so skipping it freezes hair physics.
   */
  update(vrm: VRM, frame: PoseFrame | null, delta: number): void {
    const tracked = frame?.tracked ?? false;
    // Filters measure elapsed time, so a frameless tick still needs a clock.
    const timestamp = frame?.timestamp ?? performance.now();

    // A full-rig source (VMC) has already solved the pose, including limbs and
    // fingers a webcam cannot see. Re-deriving it from blendshapes would throw
    // that away, so the rig wins whenever it is present.
    const rigged = tracked && frame ? this.applyRig(vrm, frame) : 0;
    this.debugState.rigBones = rigged;

    if (rigged === 0) {
      if (tracked && frame) {
        this.applyHead(vrm, frame);
        this.applyGaze(vrm, frame);
      } else {
        // Otherwise the head keeps whatever angle it had when the subject left.
        this.relaxHead(vrm);
      }

      /*
       * Hands and body run whether or not the subject is tracked — passing
       * nulls is exactly what eases the limbs to the idle pose.
       *
       * These used to sit inside a `tracked` guard, so losing the face stopped
       * the calls entirely and the arms froze mid-air. Anyone whose hands were
       * up when tracking dropped got an avatar stuck in a permanent cheer, with
       * no way back short of a reload. The inner early-return in HandRig had the
       * same shape and was fixed; this outer one was missed.
       */
      const live = tracked && frame ? frame.hands : { left: null, right: null };

      // `frame.hands` carries PHYSICAL sides. Mirror mode maps the user's right
      // hand onto the avatar's left (what a mirror shows); non-mirror copies
      // anatomically. This swap must travel with the position flip — flipping
      // one without the other is how arms end up crossing the body.
      const hands = this.config.mirror ? { left: live.right, right: live.left } : live;
      this.hands.apply(vrm, hands, timestamp, this.config.mirror);
      this.debugState.handBones = this.hands.applied;

      // Upper body comes from a separate detector and separate bones, so it runs
      // alongside the hands rather than through them.
      this.body.apply(vrm, tracked ? (frame?.body ?? null) : null, timestamp, this.config.mirror);
      this.debugState.bodyBones = this.body.applied;
    } else {
      this.debugState.handBones = 0;
      this.debugState.bodyBones = 0;
    }

    if (tracked && frame) {
      if (frame.expressions.size > 0) {
        this.applyVRMExpressions(vrm, frame);
      } else {
        this.applyEyes(vrm, frame);
        this.applyMouth(vrm, frame);
      }
    }

    this.debugState.tracked = tracked;

    // Emotions apply with or without tracking — a hotkey should work while the
    // camera is off — and before vrm.update(), which consumes expression values.
    this.applyEmotion(vrm);

    vrm.update(delta);

    // Must follow vrm.update() — see class docs. Brow morphs need ARKit brow
    // coefficients, which a VMC performer does not send.
    if (tracked && frame && this.config.brows && frame.shapes.has('browInnerUp')) {
      this.applyBrows(frame);
    }
  }

  /** Eases the head and neck home, so a turned head does not freeze when lost. */
  private relaxHead(vrm: VRM): void {
    const humanoid = vrm.humanoid;
    if (!humanoid) return;

    for (const name of ['head', 'neck'] as const) {
      humanoid.getNormalizedBoneNode(name)?.quaternion.slerp(this.restQuat, 0.08);
    }
  }

  get debug(): DriverDebug {
    return this.debugState;
  }

  /**
   * Toggles a preset emotion (same name twice = off). Returns the resolved
   * state so the caller can reflect and broadcast it.
   */
  toggleEmotion(name: string | null): string | null {
    this.emotionTarget = name === null || name === this.emotionTarget ? null : name;
    if (this.emotionTarget) this.emotionShown = this.emotionTarget;
    return this.emotionTarget;
  }

  /** Absolute set, for state arriving from another tab via BroadcastChannel. */
  forceEmotion(name: string | null): void {
    this.emotionTarget = name;
    if (name) this.emotionShown = name;
  }

  private applyEmotion(vrm: VRM): void {
    const expressions = vrm.expressionManager;
    if (!expressions || !this.emotionShown) return;

    const target = this.emotionTarget ? 1 : 0;
    this.emotionWeight += (target - this.emotionWeight) * 0.15;

    if (this.emotionWeight < 0.01 && !this.emotionTarget) {
      expressions.setValue(this.emotionShown, 0);
      this.emotionShown = null;
      this.emotionWeight = 0;
      return;
    }

    expressions.setValue(this.emotionShown, Math.min(1, this.emotionWeight));
  }

  /**
   * Takes the current head pose as neutral. Returns false when there is nothing
   * to sample, so the UI can say so instead of silently zeroing.
   */
  calibrate(): boolean {
    if (!this.lastRawHead) return false;
    this.config.pitchOffset = this.lastRawHead.pitch;
    this.config.yawOffset = this.lastRawHead.yaw;
    this.config.rollOffset = this.lastRawHead.roll;
    this.resetFilters();
    return true;
  }

  resetCalibration(): void {
    this.config.pitchOffset = 0;
    this.config.yawOffset = 0;
    this.config.rollOffset = 0;
    this.resetFilters();
  }

  resetFilters(): void {
    this.hands.reset();
    this.body.reset();
    for (const filter of [
      this.pitchFilter,
      this.yawFilter,
      this.rollFilter,
      this.mouthFilter,
      this.gazeXFilter,
      this.gazeYFilter,
      this.browUpFilter,
      this.browDownFilter,
    ]) {
      filter.reset();
    }
  }

  /**
   * Applies a full humanoid rig. Returns how many bones were written, so the
   * caller can tell whether to fall back to blendshape-derived pose.
   */
  private applyRig(vrm: VRM, frame: PoseFrame): number {
    if (frame.bones.size === 0 || !vrm.humanoid) return 0;

    let applied = 0;
    for (const [name, pose] of frame.bones) {
      const node = vrm.humanoid.getNormalizedBoneNode(name as VRMHumanBoneName);
      if (!node) continue;

      const [x, y, z, w] = pose.rotation;
      node.quaternion.set(x, y, z, w);
      applied++;
    }

    // Report the head angle for the debug readout even though we did not compute
    // it, so the panel means the same thing for both source types.
    const head = vrm.humanoid.getNormalizedBoneNode('head');
    if (head) {
      this.euler.setFromQuaternion(head.quaternion, 'YXZ');
      this.debugState.pitch = this.euler.x;
      this.debugState.yaw = this.euler.y;
      this.debugState.roll = this.euler.z;
    }

    return applied;
  }

  /** Passes VRM-named weights (`A`, `Blink_L`, `Joy`, …) straight through. */
  private applyVRMExpressions(vrm: VRM, frame: PoseFrame): void {
    const expressions = vrm.expressionManager;
    if (!expressions) return;

    for (const [name, value] of frame.expressions) {
      expressions.setValue(name, value);
    }

    this.debugState.blinkL = frame.expressions.get('Blink_L') ?? frame.expressions.get('blinkLeft') ?? 0;
    this.debugState.blinkR = frame.expressions.get('Blink_R') ?? frame.expressions.get('blinkRight') ?? 0;
    this.debugState.mouthOpen = frame.expressions.get('A') ?? frame.expressions.get('aa') ?? 0;
  }

  private applyHead(vrm: VRM, frame: PoseFrame): void {
    const head = vrm.humanoid?.getNormalizedBoneNode('head');
    const neck = vrm.humanoid?.getNormalizedBoneNode('neck');
    if (!head || !frame.head) return;

    // Kept uncorrected so calibrate() can snapshot the true rest pose.
    this.lastRawHead = frame.head;

    const {
      mirror,
      invertPitch,
      invertYaw,
      invertRoll,
      headGain,
      neckShare,
      pitchOffset,
      yawOffset,
      rollOffset,
    } = this.config;
    const mirrorSign = mirror ? -1 : 1;

    /*
     * Offsets come off the raw signal, before gain — otherwise raising the gain
     * would re-amplify the very tilt the calibration just removed.
     *
     * `rigFlip` goes on PITCH and ROLL but never YAW. These are written into the
     * head bone's LOCAL frame, and `rotateVRM0` turns a 0.x scene 180° about Y:
     * that negates local X and Z (pitch, roll) and leaves local Y (yaw) exactly
     * as it was. An earlier pass had this precisely backwards — it flipped yaw
     * and left pitch alone — because the probe read the head's local +Z as the
     * nose. On a 0.x rig the face looks along local −Z, so the two errors
     * cancelled in the measurement and hid in the product: yaw came out right on
     * the meter while a nod lifted the chin.
     */
    const pitch =
      this.pitchFilter.filter(frame.head.pitch - pitchOffset, frame.timestamp) *
      (invertPitch ? -1 : 1) *
      this.rigFlip *
      headGain;
    const yaw =
      this.yawFilter.filter(frame.head.yaw - yawOffset, frame.timestamp) *
      (invertYaw ? -1 : 1) *
      mirrorSign *
      headGain;
    const roll =
      this.rollFilter.filter(frame.head.roll - rollOffset, frame.timestamp) *
      (invertRoll ? -1 : 1) *
      mirrorSign *
      this.rigFlip *
      headGain;

    this.debugState.pitch = pitch;
    this.debugState.yaw = yaw;
    this.debugState.roll = roll;

    /*
     * No extra negation here — three.js's rotation signs and MediaPipe's pitch
     * and roll happen to agree once they meet in this bone.
     *
     * A previous pass negated both, reasoning that a positive rotation about
     * local X takes the nose down while `HeadPose.pitch` is documented
     * positive-is-up. The reasoning was sound and the premise was not: the
     * documented direction had never been checked against what the tracker
     * actually emits. The synthetic probe then fed `pitch: +0.5` and asserted the
     * nose should rise, so it confirmed the assumption instead of testing it, and
     * real users had to switch on Pitch and Roll invert to undo the correction.
     *
     * Two spec fixtures needing the SAME toggles is what settled it: that rules
     * out a rig difference (rigFlip above already handles those) and leaves a
     * single shared baseline sign, which belongs at zero, not at two switches
     * every user must discover.
     */
    const headShare = 1 - neckShare;
    head.rotation.set(pitch * headShare, yaw * headShare, roll * headShare, 'YXZ');
    neck?.rotation.set(pitch * neckShare, yaw * neckShare, roll * neckShare, 'YXZ');
  }

  private applyEyes(vrm: VRM, frame: PoseFrame): void {
    const expressions = vrm.expressionManager;
    if (!expressions) return;

    const rawLeft = frame.shapes.get('eyeBlinkLeft') ?? 0;
    const rawRight = frame.shapes.get('eyeBlinkRight') ?? 0;

    // Deliberately unfiltered. A smoothed blink is a slow blink, and a slow
    // blink reads as a sleepy or stoned character. The snap curve is what makes
    // it decisive instead.
    const left = snap(rawLeft);
    const right = snap(rawRight);

    const [modelLeft, modelRight] = this.config.mirror ? [right, left] : [left, right];

    expressions.setValue('blinkLeft', modelLeft);
    expressions.setValue('blinkRight', modelRight);

    this.debugState.blinkL = modelLeft;
    this.debugState.blinkR = modelRight;
  }

  private applyMouth(vrm: VRM, frame: PoseFrame): void {
    const expressions = vrm.expressionManager;
    if (!expressions) return;

    const jaw = frame.shapes.get('jawOpen') ?? 0;
    const funnel = frame.shapes.get('mouthFunnel') ?? 0;
    const pucker = frame.shapes.get('mouthPucker') ?? 0;

    // Visual mouth tracking is the weakest part of webcam capture; audio-driven
    // lipsync replaces this in step 6 of the roadmap. Until then, jaw aperture
    // plus a hint of rounding is honest about what it can actually see.
    const open = clamp01(this.mouthFilter.filter(deadzone(jaw, 0.06), frame.timestamp) * 1.4);
    const round = clamp01(Math.max(funnel, pucker) - 0.15);

    expressions.setValue('aa', open * (1 - round * 0.6));
    expressions.setValue('ou', round * 0.8);

    this.debugState.mouthOpen = open;
  }

  private applyGaze(vrm: VRM, frame: PoseFrame): void {
    if (!vrm.lookAt) return;

    const head = vrm.humanoid?.getNormalizedBoneNode('head');
    if (!head) return;

    head.getWorldPosition(this.headWorld);

    // Gaze off still has to park the target straight ahead every frame, or the
    // eyes stay frozen wherever they happened to be when it was switched off.
    if (!this.config.gaze) {
      this.lookTarget.position.set(this.headWorld.x, this.headWorld.y, this.headWorld.z + 1);
      return;
    }

    const inLeft = frame.shapes.get('eyeLookInLeft') ?? 0;
    const outLeft = frame.shapes.get('eyeLookOutLeft') ?? 0;
    const inRight = frame.shapes.get('eyeLookInRight') ?? 0;
    const outRight = frame.shapes.get('eyeLookOutRight') ?? 0;
    const upLeft = frame.shapes.get('eyeLookUpLeft') ?? 0;
    const upRight = frame.shapes.get('eyeLookUpRight') ?? 0;
    const downLeft = frame.shapes.get('eyeLookDownLeft') ?? 0;
    const downRight = frame.shapes.get('eyeLookDownRight') ?? 0;

    // Subject's left is +X here; both eyes agree on direction, so average them.
    const rawX = (outLeft - inLeft + inRight - outRight) / 2;
    const rawY = (upLeft + upRight) / 2 - (downLeft + downRight) / 2;

    const gazeSign = this.config.invertGaze ? -1 : 1;
    const x =
      this.gazeXFilter.filter(deadzone(rawX, 0.05), frame.timestamp) *
      (this.config.mirror ? -1 : 1) *
      gazeSign;
    const y = this.gazeYFilter.filter(deadzone(rawY, 0.05), frame.timestamp) * gazeSign;

    /*
     * A WORLD-space point one metre in front of the head.
     *
     * World is correct here and the rig's own basis is not: the eye bones show
     * the avatar's face is world +Z and its left is world +X on BOTH specs, so
     * only bone-LOCAL frames differ. Routing this through a per-rig forward
     * vector was tried and aimed a 0.x model's eyes at a point behind its own
     * head, because that vector describes the local frame, not the anatomy.
     */
    this.lookTarget.position.set(
      this.headWorld.x + x * 0.45,
      this.headWorld.y + y * 0.35,
      this.headWorld.z + 1,
    );
  }

  private applyBrows(frame: PoseFrame): void {
    const innerUp = frame.shapes.get('browInnerUp') ?? 0;
    const outerLeft = frame.shapes.get('browOuterUpLeft') ?? 0;
    const outerRight = frame.shapes.get('browOuterUpRight') ?? 0;
    const downLeft = frame.shapes.get('browDownLeft') ?? 0;
    const downRight = frame.shapes.get('browDownRight') ?? 0;

    const up = clamp01(
      this.browUpFilter.filter(
        deadzone(Math.max(innerUp, (outerLeft + outerRight) / 2), 0.08),
        frame.timestamp,
      ) * 1.3,
    );
    const down = clamp01(
      this.browDownFilter.filter(deadzone((downLeft + downRight) / 2, 0.08), frame.timestamp) * 1.3,
    );

    this.debugState.browUp = up;
    this.debugState.browDown = down;

    for (const { mesh, index } of this.browUpMorphs) {
      if (mesh.morphTargetInfluences) mesh.morphTargetInfluences[index] = up;
    }
    for (const { mesh, index } of this.browDownMorphs) {
      if (mesh.morphTargetInfluences) mesh.morphTargetInfluences[index] = down;
    }
  }
}
