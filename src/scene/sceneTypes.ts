/**
 * The scene: everything on the broadcast frame that is not the avatar.
 *
 * This is the product's core claim made concrete — a background, alerts, and
 * labels are ROWS IN ONE DOCUMENT, not three programs that have never heard of
 * each other. The spec is deliberately plain JSON: cheap to serialize into a
 * URL, cheap to hand to someone else, cheap to diff.
 */
export interface SceneSpec {
  version: 1;
  background: SceneBackground;
  /** Draw order: later items render on top. */
  items: SceneItem[];
}

export type SceneBackground =
  | { type: 'none' }
  | { type: 'color'; color: string }
  | { type: 'image'; url: string };

interface SceneItemBase {
  id: string;
  /** Centre position, percent of the stage box (0–100). Resolution-independent. */
  x: number;
  y: number;
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
  /** Width, percent of stage width. */
  width: number;
}

export type SceneItem = TextItem | ImageItem;

export function emptyScene(): SceneSpec {
  return { version: 1, background: { type: 'none' }, items: [] };
}
