/**
 * The scene: the whole broadcast frame, avatar included.
 *
 * This is the product's core claim made concrete — a background, a name plate,
 * and the performer are ROWS IN ONE DOCUMENT, not three programs that have never
 * heard of each other. The spec is deliberately plain JSON: cheap to serialize
 * into a URL, cheap to hand to someone else, cheap to diff.
 */
export const SCENE_VERSION = 2;

export interface SceneSpec {
  version: 2;
  background: SceneBackground;
  /** Draw order within each band: later renders on top. */
  items: SceneItem[];
}

export type SceneBackground =
  | { type: 'none' }
  | { type: 'color'; color: string }
  | { type: 'image'; url: string };

/**
 * Which DOM band an item lives in, relative to the WebGL canvas.
 *
 * The canvas sits between two DOM layers, so an item is either behind the avatar
 * or in front of it. A full z-order would be nicer and is not worth it: the
 * canvas is one element and cannot be interleaved with DOM siblings, so two
 * bands is the honest model rather than an ordering we could not honour.
 */
export type Band = 'back' | 'front';

interface SceneItemBase {
  id: string;
  /** Centre position, percent of the stage box (0–100). Resolution-independent. */
  x: number;
  y: number;
  band: Band;
  /** Optional so `false` costs zero bytes in the shared URL. */
  hidden?: boolean;
}

/** Items sized as an explicit rectangle, percent of stage width and height. */
export interface RectItemBase extends SceneItemBase {
  w: number;
  h: number;
}

export interface TextItem extends SceneItemBase {
  kind: 'text';
  text: string;
  /** Font size in px at a 1080p-tall stage; scaled with the actual stage. */
  size: number;
  color: string;
  bold: boolean;
  shadow: boolean;
}

export interface ImageItem extends SceneItemBase {
  kind: 'image';
  url: string;
  /** Width, percent of stage width. Height follows the image's aspect. */
  width: number;
}

/**
 * The avatar's rectangle on the broadcast frame.
 *
 * At most one per scene, enforced by the sanitizer: the rounded-corner mask is a
 * CSS mask on the single WebGL canvas, so a second avatar has nowhere to live.
 *
 * `band` is deliberately absent. The canvas is structurally pinned between the
 * two DOM bands, so this item's position in `items` orders nothing — claiming a
 * band would be a field that quietly does not work.
 */
export interface AvatarItem extends Omit<SceneItemBase, 'band'> {
  kind: 'avatar';
  w: number;
  h: number;
  framing: 'bust' | 'head' | 'full';
  /** Composition inside the rect. These were the `?px`/`?py`/`?zoom` params. */
  panX: number;
  panY: number;
  zoom: number;
  /** Corner radius, percent of the rect's shorter side. 0 is square. */
  radius: number;
  /** Flat fill drawn behind the avatar, inside its rect only. `#hex` or null. */
  plate: string | null;
}

/**
 * A flat coloured rectangle.
 *
 * The presets need panels, capture placeholders and name plates, and the rule
 * for presets is ZERO binary assets — a preset that pulls a background from a
 * CDN is the MediaPipe dependency wearing a different hat, and it blows the URL
 * budget besides. A rectangle is the smallest thing that makes those layouts
 * expressible in colour and geometry alone.
 *
 * Deliberately not a general shape: no borders, no gradients, no rotation. Each
 * of those is a preference with no obvious stopping point.
 */
export interface ShapeItem extends RectItemBase {
  kind: 'shape';
  color: string;
  /** Corner radius, percent of the shorter side. */
  radius: number;
}

/**
 * A framed third-party page: an alert overlay, or a video.
 *
 * This is the item that absorbs "a browser source per widget" — the argument the
 * whole product rests on. StreamElements and Streamlabs come first in the
 * allowlist because they are *designed* to be framed, pass alpha through, and
 * are the ones people actually stack four of.
 *
 * The stored URL is the one the operator typed, normalised. Nothing environment
 * dependent is baked into it — see `embedSrc`, which builds the real iframe URL
 * at render time. Storing Twitch's `parent` would work perfectly until the day
 * the scene is opened on another domain, and then fail silently.
 */
export interface EmbedItem extends RectItemBase {
  kind: 'embed';
  url: string;
  /** Matched allowlist entry. Stored so the UI can name it without re-parsing. */
  provider: EmbedProvider;
}

export type EmbedProvider = 'streamelements' | 'streamlabs' | 'youtube' | 'twitch';

export const EMBED_PROVIDER_NAMES: Record<EmbedProvider, string> = {
  streamelements: 'StreamElements',
  streamlabs: 'Streamlabs',
  youtube: 'YouTube',
  twitch: 'Twitch',
};

export type SceneItem = TextItem | ImageItem | AvatarItem | ShapeItem | EmbedItem;

export function isRect(item: SceneItem): item is AvatarItem | ShapeItem {
  return item.kind === 'avatar' || item.kind === 'shape';
}

export function isAvatar(item: SceneItem): item is AvatarItem {
  return item.kind === 'avatar';
}

/** The avatar filling the whole frame — what a v1 scene meant implicitly. */
export function fullFrameAvatar(): AvatarItem {
  return {
    id: 'avatar',
    kind: 'avatar',
    x: 50,
    y: 50,
    w: 100,
    h: 100,
    framing: 'bust',
    panX: 0,
    panY: 0,
    zoom: 1,
    radius: 0,
    plate: null,
  };
}

export function emptyScene(): SceneSpec {
  return { version: SCENE_VERSION, background: { type: 'none' }, items: [fullFrameAvatar()] };
}
