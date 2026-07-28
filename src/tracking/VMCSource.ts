import type { TrackingSource, TrackingSourceInfo } from './TrackingSource';
import { emptyFrame, type BonePose, type PoseFrame } from '../types';
import { unityBoneToVRM } from './unityBones';

/** Snapshot shape produced by bridge/vmc-bridge.mjs. */
interface BridgeSnapshot {
  t?: number;
  tracking?: boolean;
  bones?: Record<string, number[]>;
  blend?: Record<string, number>;
}

export interface VMCSourceOptions {
  /** WebSocket URL of the local UDP bridge. */
  url?: string;
  /**
   * Convert Unity's left-handed space to three.js's right-handed space.
   *
   * VMC senders are Unity applications, so bone rotations arrive mirrored
   * through the YZ plane: a quaternion (x, y, z, w) becomes (x, -y, -z, w).
   * Left off, the avatar's limbs move to the wrong side.
   *
   * Exposed as a switch because it cannot be verified without a real sender
   * attached; if arms and head turn the wrong way, flip this.
   */
  convertHandedness?: boolean;
}

const DEFAULT_URL = 'ws://127.0.0.1:39541';

/**
 * Receives an already-solved rig from VSeeFace, VNyan, Warudo, or any other VMC
 * performer.
 *
 * This is the migration-cost-zero path: someone who already trusts their
 * tracker keeps it and uses this app purely as the scene compositor. It also
 * delivers what a webcam cannot — full body, fingers, and a solve that somebody
 * else has already tuned.
 *
 * Requires the local bridge, because browsers cannot open UDP sockets and VMC is
 * OSC over UDP. That is a real caveat, softened by the fact that anyone sending
 * VMC is already running desktop software.
 */
export class VMCSource implements TrackingSource {
  readonly info: TrackingSourceInfo = {
    id: 'vmc',
    label: 'VMC (VSeeFace 등)',
    detail: 'OSC/UDP를 로컬 브리지로 받습니다. 전신·손가락 포함, 트래킹 품질은 보내는 쪽에 달림.',
  };

  private socket: WebSocket | null = null;
  private frame: PoseFrame | null = null;
  private running = false;
  private readonly url: string;
  private readonly convertHandedness: boolean;

  constructor(options: VMCSourceOptions = {}) {
    this.url = options.url ?? DEFAULT_URL;
    this.convertHandedness = options.convertHandedness ?? true;
  }

  start(): Promise<void> {
    if (this.running) return Promise.resolve();

    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(this.url);
      this.socket = socket;

      socket.onopen = () => {
        this.running = true;
        settled = true;
        resolve();
      };

      socket.onerror = () => {
        if (settled) return;
        settled = true;
        reject(
          new Error(
            `브리지에 연결할 수 없습니다 (${this.url}). ` +
              '`npm run bridge`를 먼저 실행하세요.',
          ),
        );
      };

      socket.onclose = () => {
        this.running = false;
        this.frame = null;
      };

      socket.onmessage = (event) => this.ingest(event.data);
    });
  }

  stop(): Promise<void> {
    this.running = false;
    this.socket?.close();
    this.socket = null;
    this.frame = null;
    return Promise.resolve();
  }

  read(): PoseFrame | null {
    return this.frame;
  }

  private ingest(data: unknown): void {
    if (typeof data !== 'string') return;

    let snapshot: BridgeSnapshot;
    try {
      snapshot = JSON.parse(data) as BridgeSnapshot;
    } catch {
      return;
    }

    const bones = new Map<string, BonePose>();
    for (const [unityName, values] of Object.entries(snapshot.bones ?? {})) {
      if (values.length < 7) continue;
      const vrmName = unityBoneToVRM(unityName);
      if (!vrmName) continue;
      bones.set(vrmName, this.toBonePose(values));
    }

    const expressions = new Map<string, number>();
    for (const [name, value] of Object.entries(snapshot.blend ?? {})) {
      if (Number.isFinite(value)) expressions.set(name, value);
    }

    this.frame = {
      ...emptyFrame(),
      expressions,
      bones,
      timestamp: performance.now(),
      // A performer that has sent us a rig is tracking; the explicit flag from
      // /VMC/Ext/OK overrides that when present.
      tracked: snapshot.tracking ?? bones.size > 0,
    };
  }

  private toBonePose(values: number[]): BonePose {
    const [px, py, pz, qx, qy, qz, qw] = values as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];

    if (!this.convertHandedness) {
      return { rotation: [qx, qy, qz, qw], position: [px, py, pz] };
    }

    // Mirror through the YZ plane: Unity is left-handed with +Z forward, three.js
    // is right-handed. The rotation axis components perpendicular to the mirror
    // flip sign; the one along it does not.
    return { rotation: [qx, -qy, -qz, qw], position: [-px, py, pz] };
  }
}
