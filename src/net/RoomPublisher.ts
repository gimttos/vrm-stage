import {
  FRAMES_PER_MESSAGE,
  encodePoses,
  parseRoomMessage,
  type RoomMessage,
} from './protocol';
import { roomSocketUrl } from './rooms';
import type { PoseFrame } from '../types';

/** A partial batch is flushed after this long so motion never stalls waiting to fill. */
const MAX_BATCH_AGE_MS = 120;

/**
 * The host side of a broadcast: turns local PoseFrames into room traffic.
 *
 * Only the window holding the host key can do this, and the room enforces that
 * server-side — this class is merely the sender, not the authority.
 */
export class RoomPublisher {
  private socket: WebSocket | null = null;
  private pending: PoseFrame[] = [];
  private oldestPendingAt = 0;

  /**
   * Timestamp of the last frame actually sent.
   *
   * `TrackingSource.read()` returns the same frame on every rendered frame until
   * the tracker produces a new one, so publishing per render would send each
   * capture twice at 60fps. Capture timestamps are the natural dedup key.
   */
  private lastSent = -1;

  viewers = 0;
  onViewers: ((count: number) => void) | null = null;
  onClose: ((reason: string) => void) | null = null;

  constructor(
    readonly roomId: string,
    private readonly hostKey: string,
  ) {}

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(roomSocketUrl(this.roomId, this.hostKey));
      let opened = false;

      socket.onopen = () => {
        opened = true;
        this.socket = socket;
        resolve();
      };
      socket.onerror = () => {
        if (!opened) reject(new Error('방에 연결할 수 없습니다.'));
      };
      socket.onclose = (event) => {
        this.socket = null;
        if (opened) this.onClose?.(event.reason || '방 연결이 끊어졌습니다.');
      };
      socket.onmessage = (event: MessageEvent) => {
        if (typeof event.data !== 'string') return;
        const message = parseRoomMessage(event.data);
        if (message?.type === 'role') {
          this.viewers = message.viewers;
          this.onViewers?.(message.viewers);
        }
      };
    });
  }

  stop(): void {
    this.flush();
    this.socket?.close();
    this.socket = null;
    this.pending = [];
    this.lastSent = -1;
  }

  /** Queues a frame if it is a new capture. Batches to keep request counts sane. */
  publish(frame: PoseFrame | null): void {
    if (!frame || !this.connected) return;
    if (frame.timestamp === this.lastSent) return;
    this.lastSent = frame.timestamp;

    if (this.pending.length === 0) this.oldestPendingAt = performance.now();
    this.pending.push(frame);

    if (
      this.pending.length >= FRAMES_PER_MESSAGE ||
      performance.now() - this.oldestPendingAt >= MAX_BATCH_AGE_MS
    ) {
      this.flush();
    }
  }

  send(message: RoomMessage): void {
    if (!this.connected) return;
    this.socket!.send(JSON.stringify(message));
  }

  private flush(): void {
    if (this.pending.length === 0 || !this.connected) return;
    this.socket!.send(encodePoses(this.pending));
    this.pending = [];
  }
}
