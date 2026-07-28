import * as THREE from 'three';
import {
  FaceLandmarker,
  FilesetResolver,
  HandLandmarker,
  PoseLandmarker,
} from '@mediapipe/tasks-vision';
import type { TrackingSource, TrackingSourceInfo } from './TrackingSource';
import { emptyFrame, type BodyPose, type HandSet, type PoseFrame } from '../types';
import { solveHand } from './handSolver';
import { BodySolver } from './bodySolver';
import { modelUrl, wasmRoot } from './mediapipeAssets';

/** Track at 30fps and let the renderer interpolate to display rate. */
const TRACK_INTERVAL_MS = 1000 / 30;

/**
 * The zero-install default: webcam in, ARKit-style blendshapes out.
 *
 * This will never match an iPhone's depth camera, and it is not supposed to.
 * It exists so someone with nothing but a browser gets a working avatar in one
 * click; anyone who cares about fidelity attaches a VMC source instead.
 */
export class WebcamSource implements TrackingSource {
  readonly info: TrackingSourceInfo = {
    id: 'webcam',
    label: 'Webcam',
    detail: 'MediaPipe FaceLandmarker. No install, works anywhere, moderate fidelity.',
  };

  readonly video = document.createElement('video');

  private landmarker: FaceLandmarker | null = null;
  private handLandmarker: HandLandmarker | null = null;
  private poseLandmarker: PoseLandmarker | null = null;
  private readonly bodySolver = new BodySolver();
  private stream: MediaStream | null = null;
  private frame: PoseFrame | null = null;
  private running = false;
  private lastDetect = 0;
  private lastVideoTime = -1;

  /** Face centre and width in normalised image coords, for face-relative hands. */
  private faceRef: { cx: number; cy: number; width: number; at: number } | null = null;

  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly euler = new THREE.Euler();
  private readonly scratchPosition = new THREE.Vector3();
  private readonly scratchScale = new THREE.Vector3();

  /**
   * @param trackHands Runs a second detector, roughly doubling GPU cost per
   *   frame. Off means the face path keeps the whole budget.
   */
  constructor(
    private readonly deviceId?: string,
    private readonly trackHands = true,
    /**
     * @param trackBody Runs a THIRD detector for shoulders. Each detector costs
     *   roughly the same per frame, so this is off unless asked for.
     */
    private readonly trackBody = false,
  ) {
    this.video.autoplay = true;
    this.video.muted = true;
    this.video.playsInline = true;
  }

  async start(): Promise<void> {
    if (this.running) return;

    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 30 },
        ...(this.deviceId ? { deviceId: { exact: this.deviceId } } : {}),
      },
      audio: false,
    });

    this.video.srcObject = this.stream;
    await this.video.play();

    const vision = await FilesetResolver.forVisionTasks(wasmRoot());
    this.landmarker = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: modelUrl('face'), delegate: 'GPU' },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    });

    if (this.trackHands) {
      this.handLandmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: modelUrl('hand'), delegate: 'GPU' },
        runningMode: 'VIDEO',
        numHands: 2,
      });
    }

    if (this.trackBody) {
      this.poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: modelUrl('pose'), delegate: 'GPU' },
        runningMode: 'VIDEO',
        numPoses: 1,
      });
    }

    this.running = true;
    this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.landmarker?.close();
    this.landmarker = null;
    this.handLandmarker?.close();
    this.handLandmarker = null;
    this.poseLandmarker?.close();
    this.poseLandmarker = null;
    this.bodySolver.reset();
    this.frame = null;
  }

  read(): PoseFrame | null {
    return this.frame;
  }

  private loop = (): void => {
    if (!this.running) return;
    requestAnimationFrame(this.loop);

    const now = performance.now();
    if (now - this.lastDetect < TRACK_INTERVAL_MS) return;
    this.lastDetect = now;

    const landmarker = this.landmarker;
    if (!landmarker || this.video.readyState < 2) return;

    // detectForVideo rejects repeated timestamps, and a paused camera will keep
    // handing us the same frame.
    if (this.video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = this.video.currentTime;

    const result = landmarker.detectForVideo(this.video, now);
    const blendshapes = result.faceBlendshapes[0];

    // Cheek-to-cheek landmarks give a stable face width; captured before the
    // hand pass so this frame's hands are relative to this frame's face.
    const faceLandmarks = result.faceLandmarks[0];
    if (faceLandmarks && faceLandmarks.length > 454) {
      const a = faceLandmarks[234]!;
      const b = faceLandmarks[454]!;
      const width = Math.hypot(a.x - b.x, a.y - b.y);
      if (width > 1e-4) {
        this.faceRef = { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, width, at: now };
      }
    }

    const hands = this.readHands(now);
    const body = this.readBody(now);

    if (!blendshapes) {
      // Hands can still be visible with the face out of frame, so a lost face is
      // not a lost frame.
      this.frame = {
        ...emptyFrame(),
        hands,
        body,
        timestamp: now,
        tracked: Boolean(hands.left || hands.right || body),
      };
      return;
    }

    const shapes = new Map<string, number>();
    for (const category of blendshapes.categories) {
      if (category.categoryName) shapes.set(category.categoryName, category.score);
    }

    this.frame = {
      ...emptyFrame(),
      shapes,
      hands,
      body,
      head: this.readHead(result.facialTransformationMatrixes[0]?.data),
      timestamp: now,
      tracked: true,
    };
  };

  private readBody(now: number): BodyPose | null {
    const detector = this.poseLandmarker;
    if (!detector) return null;

    const result = detector.detectForVideo(this.video, now);
    return this.bodySolver.solve(result.landmarks[0]);
  }

  private readHands(now: number): HandSet {
    const hands: HandSet = { left: null, right: null };
    const detector = this.handLandmarker;
    if (!detector) return hands;

    const result = detector.detectForVideo(this.video, now);

    for (let i = 0; i < result.landmarks.length; i++) {
      const screen = result.landmarks[i];
      const world = result.worldLandmarks[i];
      const label = result.handedness[i]?.[0]?.categoryName;
      if (!screen || !world || !label) continue;

      const pose = solveHand(world, screen);
      if (!pose) continue;

      // Anchor the hand to the face. A briefly occluded face (hand in front of
      // it, ironically) should not kill the arms, hence the grace window.
      const ref = this.faceRef;
      const palm = screen[9];
      if (ref && palm && now - ref.at < 1500) {
        pose.relative = {
          x: (palm.x - ref.cx) / ref.width,
          // Image y grows downward.
          y: (ref.cy - palm.y) / ref.width,
          size: pose.size / ref.width,
        };
      }

      // MediaPipe's docs say handedness assumes a mirrored selfie image, which
      // would invert labels on our raw feed. EMPIRICALLY that is wrong here:
      // trusting the docs swapped left/right AND flipped palm/back together
      // (the chirality correction landed on the wrong hand). The labels match
      // physical hands directly — observation beats documentation.
      const physical = label === 'Left' ? 'left' : label === 'Right' ? 'right' : null;
      if (!physical) continue;

      // The solver's index×pinky normal points out of a right palm but into a
      // left one. Correct here, where the physical side is known, so that
      // `basis.normal` always means palm-out downstream.
      if (pose.basis && physical === 'left') {
        pose.basis.normal = [
          -pose.basis.normal[0],
          -pose.basis.normal[1],
          -pose.basis.normal[2],
        ];
      }

      hands[physical] = pose;
    }

    return hands;
  }

  private readHead(data: number[] | undefined): PoseFrame['head'] {
    if (!data || data.length < 16) return null;

    this.matrix.fromArray(data);
    this.matrix.decompose(this.scratchPosition, this.quaternion, this.scratchScale);

    // YXZ so yaw is the outermost rotation, which is how a neck actually works:
    // turn first, then nod, then tilt. Reading XYZ here produces gimbal-flavoured
    // cross-talk between yaw and roll at large angles.
    this.euler.setFromQuaternion(this.quaternion, 'YXZ');

    return { pitch: this.euler.x, yaw: this.euler.y, roll: this.euler.z };
  }
}
