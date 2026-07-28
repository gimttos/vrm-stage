import type { TrackingSource, TrackingSourceInfo } from './TrackingSource';
import { decodePoses } from '../net/protocol';
import type { PoseFrame } from '../types';

/** Nominal publisher rate; the playout clock spaces frames this far apart. */
const FRAME_INTERVAL_MS = 1000 / 30;

/**
 * How far ahead of playout the buffer is allowed to run before it catches up.
 *
 * A hiccup that resolves leaves a burst of frames queued. Replaying all of them
 * would put the avatar permanently behind the host, so anything beyond this
 * window is dropped — a broadcast wants to be current, not complete.
 */
const MAX_BUFFER_MS = 400;

/**
 * A viewer's tracking source: PoseFrames arrive over a WebSocket instead of a
 * camera.
 *
 * This is the payoff of the `TrackingSource` seam. Nothing downstream changes —
 * `AvatarDriver` and `Stage` cannot tell a remote performance from a local one.
 * And because a viewer page never constructs a `WebcamSource`, there is no code
 * path on which it could ask for a camera at all: read-only is structural, not a
 * flag someone can flip in devtools.
 */
export class RemoteSource implements TrackingSource {
  readonly info: TrackingSourceInfo = {
    id: 'remote',
    label: '방송 수신',
    detail: '호스트의 움직임을 실시간으로 받습니다. 이 창은 카메라를 사용하지 않습니다.',
  };

  private socket: WebSocket | null = null;
  private running = false;

  /** Jitter buffer: frames waiting for their playout slot. */
  private queue: PoseFrame[] = [];
  /** Last frame handed to the driver, held when the queue runs dry. */
  private current: PoseFrame | null = null;
  private nextPlayout = 0;

  /** Fired for the room's JSON messages, which this source does not interpret. */
  onText: ((raw: string) => void) | null = null;
  onClose: ((reason: string) => void) | null = null;

  constructor(private readonly url: string) {}

  async start(): Promise<void> {
    if (this.running) return;

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url);
      socket.binaryType = 'arraybuffer';
      let opened = false;

      socket.onopen = () => {
        opened = true;
        this.socket = socket;
        this.running = true;
        resolve();
      };

      socket.onerror = () => {
        if (!opened) {
          reject(new Error('방송에 연결할 수 없습니다 — 방이 닫혔거나 주소가 틀렸습니다.'));
        }
      };

      socket.onclose = (event) => {
        this.running = false;
        this.socket = null;
        if (opened) this.onClose?.(event.reason || '방송 연결이 끊어졌습니다.');
      };

      socket.onmessage = (event: MessageEvent) => {
        if (typeof event.data === 'string') {
          this.onText?.(event.data);
          return;
        }
        if (event.data instanceof ArrayBuffer) this.ingest(event.data);
      };
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.socket?.close();
    this.socket = null;
    this.queue = [];
    this.current = null;
  }

  /**
   * Hands the driver the newest frame whose playout slot has arrived.
   *
   * Batched arrivals are spaced back out here rather than applied all at once —
   * otherwise a 3-frame message would move the avatar in 10fps steps no matter
   * how smoothly it was captured.
   */
  read(): PoseFrame | null {
    const now = performance.now();

    while (this.queue.length > 0 && now >= this.nextPlayout) {
      this.current = this.queue.shift()!;
      this.nextPlayout = now + FRAME_INTERVAL_MS;
    }

    return this.current;
  }

  private ingest(data: ArrayBuffer): void {
    const frames = decodePoses(data);
    if (frames.length === 0) return;

    // First frames after connecting: start the playout clock now.
    if (this.queue.length === 0 && this.current === null) {
      this.nextPlayout = performance.now();
    }

    this.queue.push(...frames);

    const maxFrames = Math.ceil(MAX_BUFFER_MS / FRAME_INTERVAL_MS);
    if (this.queue.length > maxFrames) {
      this.queue.splice(0, this.queue.length - maxFrames);
    }
  }
}
