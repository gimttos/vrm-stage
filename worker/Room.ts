import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';

/**
 * One broadcast room: exactly one publisher, many read-only subscribers.
 *
 * The asymmetry is the point. A VTuber broadcast means the *host's* body drives
 * the avatar and everyone else watches; if every viewer could puppet the model it
 * would be a shared toy, not a broadcast. So the publisher role is granted here,
 * against a secret held in storage, and enforced on every inbound message —
 * never by a role claimed in a URL, which any viewer could edit.
 */

/** Generous for a batched pose message (~628 B); small enough to reject junk. */
const MAX_BINARY_BYTES = 8 * 1024;
/** Scene specs can carry data-URL images, so text needs real headroom. */
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_SUBSCRIBERS = 200;
/** A room with nobody in it is swept after this long. */
const IDLE_TTL_MS = 12 * 60 * 60 * 1000;

const TAG_PUB = 'pub';
const TAG_SUB = 'sub';

interface RetainedState {
  scene: string | null;
  emotion: string | null;
  model: string | null;
  /** The host's calibration, axis corrections, framing, and view. */
  config: unknown;
}

export class Room extends DurableObject<Env> {
  /**
   * Claims the room for a host. Fails if already claimed, so a room cannot be
   * stolen by guessing its id and re-initialising it.
   */
  async init(hostKey: string): Promise<boolean> {
    const existing = await this.ctx.storage.get<string>('hostKey');
    if (existing) return false;

    await this.ctx.storage.put('hostKey', hostKey);
    await this.ctx.storage.put('createdAt', Date.now());
    await this.ctx.storage.setAlarm(Date.now() + IDLE_TTL_MS);
    return true;
  }

  async exists(): Promise<boolean> {
    return (await this.ctx.storage.get<string>('hostKey')) !== undefined;
  }

  /**
   * WebSocket upgrades go through `fetch`, not an RPC method.
   *
   * A 101 response carries a live WebSocket, which cannot cross the RPC
   * boundary — attempting it throws inside the object. RPC is still the right
   * choice for everything else here (`init`, `exists`).
   */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket upgrade', { status: 426 });
    }
    return this.join(new URL(request.url).searchParams.get('key'));
  }

  private async join(key: string | null): Promise<Response> {
    const hostKey = await this.ctx.storage.get<string>('hostKey');
    if (!hostKey) {
      return new Response('room not found', { status: 404 });
    }

    const publisher = key !== null && timingSafeEqual(key, hostKey);

    if (!publisher && this.ctx.getWebSockets(TAG_SUB).length >= MAX_SUBSCRIBERS) {
      return new Response('room full', { status: 503 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    if (publisher) {
      // A host that reloaded should take the room back rather than be locked out
      // of it by their own stale socket.
      for (const stale of this.ctx.getWebSockets(TAG_PUB)) {
        try {
          stale.close(4000, 'replaced by a newer host connection');
        } catch {
          // Already gone; nothing to do.
        }
      }
      await this.ctx.storage.setAlarm(Date.now() + IDLE_TTL_MS);
    }

    // Hibernation-aware accept: viewers can stay connected while the host is
    // away without holding the object active.
    this.ctx.acceptWebSocket(server, [publisher ? TAG_PUB : TAG_SUB]);

    const state = await this.retained();
    send(server, {
      type: 'role',
      role: publisher ? 'publisher' : 'subscriber',
      viewers: this.ctx.getWebSockets(TAG_SUB).length,
    });
    // Late joiners must render immediately rather than waiting for the host to
    // next touch a setting.
    if (!publisher) send(server, { type: 'state', ...state });

    this.announceViewers();

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Async, and the text path is awaited rather than floated: a `void`-ed promise
   * here can be abandoned when the runtime considers the handler finished, which
   * silently loses the retained scene a late joiner depends on. The binary path
   * is synchronous fanout and never had that problem, which is exactly why the
   * bug only showed up on scene state.
   */
  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    // The entire authority model, in one line and on the server: a subscriber's
    // messages are dropped, so a viewer cannot move the avatar no matter what
    // they send or how they edited their page.
    if (!this.isPublisher(ws)) return;

    if (typeof message === 'string') {
      if (message.length > MAX_TEXT_BYTES) return;
      await this.handleText(message);
      return;
    }

    if (message.byteLength > MAX_BINARY_BYTES) return;
    this.fanout(message);
  }

  webSocketClose(ws: WebSocket): void {
    // Tell the host their audience changed. Closing sockets are still listed at
    // this point, so the count is taken on the next turn.
    if (!this.isPublisher(ws)) queueMicrotask(() => this.announceViewers());
  }

  webSocketError(): void {
    queueMicrotask(() => this.announceViewers());
  }

  /**
   * Ends the broadcast and deletes the uploaded model.
   *
   * Rooms are ephemeral, and the model only had to exist so viewers could render
   * it. Leaving a 15MB copy of someone's avatar sitting at a public URL after the
   * stream is over is worse than the storage it occupies — an author-only model
   * should stop being fetchable the moment it stops being needed.
   */
  async endBroadcast(key: string): Promise<boolean> {
    const hostKey = await this.ctx.storage.get<string>('hostKey');
    if (!hostKey || !timingSafeEqual(key, hostKey)) return false;

    await this.discardModel();
    await this.ctx.storage.delete(['scene', 'emotion']);

    for (const socket of this.ctx.getWebSockets(TAG_SUB)) {
      try {
        send(socket, { type: 'ended' });
        socket.close(4001, 'broadcast ended');
      } catch {
        // Already gone.
      }
    }
    return true;
  }

  async alarm(): Promise<void> {
    if (this.ctx.getWebSockets().length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + IDLE_TTL_MS);
      return;
    }
    // Backstop for a host that closed the tab without stopping: the model must
    // not outlive the room just because nobody said goodbye.
    await this.discardModel();
    await this.ctx.storage.deleteAll();
  }

  /**
   * Removes the retained model from R2.
   *
   * Only deletes objects whose URL matches the shape this Worker mints, so a
   * crafted `model` message can never point the delete at something else.
   */
  private async discardModel(): Promise<void> {
    const url = await this.ctx.storage.get<string>('model');
    await this.ctx.storage.delete('model');
    if (!url) return;

    const match = /^\/api\/models\/([A-Za-z0-9_-]{1,64}\.vrm)$/.exec(url);
    if (!match) return;

    try {
      await this.env.MODELS.delete(match[1]!);
    } catch {
      // A failed delete is not worth failing the stop on; the alarm retries.
    }
  }

  // ------------------------------------------------------------------ internals

  private isPublisher(ws: WebSocket): boolean {
    return this.ctx.getWebSockets(TAG_PUB).includes(ws);
  }

  private async retained(): Promise<RetainedState> {
    const [scene, emotion, model, config] = await Promise.all([
      this.ctx.storage.get<string>('scene'),
      this.ctx.storage.get<string>('emotion'),
      this.ctx.storage.get<string>('model'),
      this.ctx.storage.get<unknown>('config'),
    ]);
    return {
      scene: scene ?? null,
      emotion: emotion ?? null,
      model: model ?? null,
      config: config ?? null,
    };
  }

  /** Retains scene/emotion/model so late joiners see the current room, then relays. */
  private async handleText(raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;

    const message = parsed as {
      type?: unknown;
      encoded?: unknown;
      name?: unknown;
      url?: unknown;
      config?: unknown;
    };

    if (message.type === 'scene' && typeof message.encoded === 'string') {
      await this.ctx.storage.put('scene', message.encoded);
    } else if (message.type === 'config' && typeof message.config === 'object') {
      // Stored opaquely and validated by the viewer, which copies only the keys
      // it recognises — the room does not need to know the rig's shape.
      await this.ctx.storage.put('config', message.config);
    } else if (message.type === 'emotion') {
      const name = typeof message.name === 'string' ? message.name : null;
      if (name === null) await this.ctx.storage.delete('emotion');
      else await this.ctx.storage.put('emotion', name);
    } else if (message.type === 'model') {
      const url = typeof message.url === 'string' ? message.url : null;
      if (url === null) await this.ctx.storage.delete('model');
      else await this.ctx.storage.put('model', url);
    } else {
      return;
    }

    this.fanout(raw);
  }

  private fanout(message: ArrayBuffer | string): void {
    for (const socket of this.ctx.getWebSockets(TAG_SUB)) {
      try {
        socket.send(message);
      } catch {
        // A socket that died between the lookup and the send; the close handler
        // will clean up.
      }
    }
  }

  private announceViewers(): void {
    const viewers = this.ctx.getWebSockets(TAG_SUB).length;
    for (const socket of this.ctx.getWebSockets(TAG_PUB)) {
      try {
        send(socket, { type: 'role', role: 'publisher', viewers });
      } catch {
        // Host is going away.
      }
    }
  }
}

function send(socket: WebSocket, payload: unknown): void {
  socket.send(JSON.stringify(payload));
}

/**
 * Length-independent comparison, so a wrong key cannot be narrowed down by
 * timing the response.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
