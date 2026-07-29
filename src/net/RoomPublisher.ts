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

/** How long to wait for the upgrade before calling it dead. */
const CONNECT_TIMEOUT_MS = 10_000;

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

  /**
   * Opens the publisher socket.
   *
   * Every exit is covered, which it was not: `onclose` used to do nothing when
   * the socket closed BEFORE opening, and a refused upgrade — a stale room id, a
   * wrong host key, a Worker that never deployed — fires exactly that, often
   * with no `onerror` at all. The promise then never settled and the UI sat on
   * "방을 만들고 있습니다…" forever with nothing logged. A socket left in
   * CONNECTING did the same, so there is a deadline too.
   */
  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(roomSocketUrl(this.roomId, this.hostKey));
      let opened = false;
      let settled = false;

      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        try {
          socket.close();
        } catch {
          // Already closing; nothing to do.
        }
        reject(new Error(message));
      };

      const deadline = setTimeout(() => {
        fail('방 서버가 응답하지 않습니다 (10초 초과).');
      }, CONNECT_TIMEOUT_MS);

      socket.onopen = () => {
        opened = true;
        settled = true;
        clearTimeout(deadline);
        this.socket = socket;
        resolve();
      };
      socket.onerror = () => {
        fail('방에 연결할 수 없습니다.');
      };
      socket.onclose = (event) => {
        this.socket = null;
        if (opened) {
          this.onClose?.(event.reason || '방 연결이 끊어졌습니다.');
          return;
        }
        // Closed without ever opening: the server refused the upgrade.
        fail(event.reason || `방에 연결할 수 없습니다 (코드 ${event.code}).`);
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
