import { basePath } from '../basePath';

/**
 * Broadcast room plumbing: minting rooms, storing the host secret, and building
 * the two URLs that matter.
 *
 * The topology this enables is worth stating, because it is not obvious:
 *
 *   studio tab (camera) ──publish──> room ──subscribe──> OBS browser source ──> Twitch
 *                                     └───subscribe──> remote viewers
 *
 * The OBS source is *also* a subscriber, which means only one window ever opens
 * the camera, and OBS and remote viewers use the exact same link.
 */

export interface RoomCredentials {
  roomId: string;
  /** Secret. Whoever holds it can drive the avatar; viewers never receive it. */
  hostKey: string;
}

const STORAGE_KEY = 'vrm-stage:room';

/**
 * Deadlines. A `fetch` with no signal waits on the browser's own timeout, which
 * is minutes — long enough that a stalled request is indistinguishable from a
 * hung app, and the room UI has exactly one notice to say so with.
 */
const API_TIMEOUT_MS = 10_000;
/** Uploads carry ~15MB, so they get their own, much longer budget. */
const UPLOAD_TIMEOUT_MS = 120_000;

export async function createRoom(): Promise<RoomCredentials> {
  const response = await fetch(`${basePath()}api/rooms`, {
    method: 'POST',
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`방을 만들 수 없습니다 (HTTP ${response.status})`);

  const body = (await response.json()) as Partial<RoomCredentials>;
  if (!body.roomId || !body.hostKey) throw new Error('방 응답이 올바르지 않습니다.');
  return { roomId: body.roomId, hostKey: body.hostKey };
}

/**
 * Puts the VRM where viewers can fetch it.
 *
 * Unavoidable for this design: viewers render the avatar locally, so they need
 * the file. 15MB cannot ride the pose channel, and a dropped local file has no
 * URL of its own.
 */
export async function uploadModel(name: string, bytes: ArrayBuffer): Promise<string> {
  const safe = `${name.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48) || 'model'}.vrm`;
  const response = await fetch(`${basePath()}api/models/${safe}`, {
    method: 'PUT',
    body: bytes,
    headers: { 'Content-Type': 'model/gltf-binary' },
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`모델 업로드 실패 (HTTP ${response.status})`);

  const body = (await response.json()) as { url?: string };
  if (!body.url) throw new Error('업로드 응답에 URL이 없습니다.');
  return body.url;
}

/**
 * Ends a broadcast and deletes the uploaded model.
 *
 * Deliberately server-side: the room owns the R2 key and the host secret, so the
 * client cannot be tricked into deleting something it does not own.
 */
export async function endBroadcast(credentials: RoomCredentials): Promise<void> {
  const url = new URL(`${basePath()}api/rooms/${credentials.roomId}/end`, location.href);
  url.searchParams.set('key', credentials.hostKey);

  const response = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`방송 종료 처리 실패 (HTTP ${response.status})`);
}

/** WebSocket URL for a room. Pass the key only from the host's own window. */
export function roomSocketUrl(roomId: string, hostKey?: string): string {
  const url = new URL(`${basePath()}api/rooms/${roomId}/ws`, location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  if (hostKey) url.searchParams.set('key', hostKey);
  return url.toString();
}

export function loadStoredRoom(): RoomCredentials | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { roomId, hostKey } = parsed as Partial<RoomCredentials>;
    return roomId && hostKey ? { roomId, hostKey } : null;
  } catch {
    return null;
  }
}

/** Persisted so a reload keeps hostship instead of orphaning the room. */
export function storeRoom(credentials: RoomCredentials | null): void {
  try {
    if (credentials) localStorage.setItem(STORAGE_KEY, JSON.stringify(credentials));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private browsing — the room simply will not survive a reload.
  }
}
