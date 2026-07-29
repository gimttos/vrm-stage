import { withBase } from '../basePath';
import {
  SCENE_VERSION,
  emptyScene,
  fullFrameAvatar,
  type AvatarItem,
  type ImageItem,
  type SceneBackground,
  type SceneItem,
  type SceneSpec,
  type TextItem,
} from './sceneTypes';

const STORAGE_KEY = 'vrm-stage:scene';

/** Design height the text sizes are authored against. */
const DESIGN_HEIGHT = 1080;

type Corner = 'nw' | 'ne' | 'sw' | 'se';
const CORNERS: Corner[] = ['nw', 'ne', 'sw', 'se'];

/** Grab radius for a corner handle, in CSS pixels. */
const HANDLE_GRAB = 15;

/** Smallest crop, percent. Also the threshold below which a drag is a click. */
const MIN_RECT = 5;

/**
 * Owns the scene document and its DOM: background, overlay items, selection,
 * and drag editing. Independent of the control panel so the OBS instance can
 * render scenes with no UI at all.
 *
 * Persistence layers, in load priority order:
 *  1. URL hash (`#s=…`) — self-contained, survives into a real OBS browser
 *     source, which is a separate browser sharing NO storage with Chrome.
 *  2. localStorage — same-browser continuity between sessions.
 */
export class SceneManager {
  private spec: SceneSpec = emptyScene();
  /**
   * DOM bands around the WebGL canvas:
   *
   *   #scene-back    background fill + items behind the avatar
   *   canvas         the avatar, inside its own viewport rect
   *   #scene-front   items in front of the avatar
   *   #scene-edit    drag grips only; never built in live mode
   *
   * Editing handles live in their own band rather than on the rendered element.
   * The avatar has no DOM node to grab at all — it is pixels in a shared canvas —
   * and a future media embed would swallow pointer events entirely, so the grip
   * has to be a sibling either way.
   */
  private readonly bands: { back: HTMLElement; front: HTMLElement; edit: HTMLElement | null };
  private readonly elements = new Map<string, HTMLElement>();
  /** The avatar's backing plate, kept apart because `elements` holds its grip. */
  private readonly plates = new Map<string, HTMLElement>();
  private selectedId: string | null = null;

  /**
   * Crop mode: the stage becomes a photo-crop surface for the avatar.
   *
   * Off by default and off is the important half — an always-visible outline
   * around the avatar is pure noise, and for a full-frame avatar it is a
   * rectangle drawn around the entire stage. The rect only appears when the
   * operator has said they are working on it.
   */
  private cropping = false;

  /** Fired after any user-visible change; wired to broadcast + notices. */
  onChange: (() => void) | null = null;
  /** Fired when the selection changes; the panel renders its inspector from it. */
  onSelect: ((item: SceneItem | null) => void) | null = null;

  constructor(
    private readonly stageEl: HTMLElement,
    private readonly editable: boolean,
  ) {
    const back = document.createElement('div');
    back.id = 'scene-back';
    // insertBefore rather than relying on the canvas already being first: this
    // stays correct if construction order ever changes.
    stageEl.insertBefore(back, stageEl.firstChild);

    const front = document.createElement('div');
    front.id = 'scene-front';
    stageEl.appendChild(front);

    // Gates `pointer-events` in CSS: in live output nothing is grabbable, so the
    // composited frame behaves like the flat image it is meant to be.
    if (editable) for (const band of [back, front]) band.classList.add('editable');

    let edit: HTMLElement | null = null;
    if (editable) {
      edit = document.createElement('div');
      edit.id = 'scene-edit';
      stageEl.appendChild(edit);

      // Last responder. Items handle their own clicks and stop propagation, so
      // anything arriving here missed every overlay.
      stageEl.addEventListener('pointerdown', (event) => {
        // Ctrl/Cmd is the camera's, always. Keeping it reserved is what lets
        // plain drag mean something different without the two ever colliding.
        if (event.ctrlKey || event.metaKey) return;

        if (!this.cropping) {
          this.select(null);
          return;
        }

        // Crop mode. Overlays are inert here (CSS), so the whole stage is one
        // surface and the gesture is decided by geometry alone.
        const avatar = this.avatarItem;
        if (!avatar) return;

        // A full-frame avatar is the "not cropped yet" state, and it leaves no
        // outside to start a marquee from. Every drag draws, or the first crop
        // would be impossible to make.
        if (avatar.w >= 99 && avatar.h >= 99) {
          this.beginMarquee(event, avatar);
          return;
        }

        const corner = this.hitsCorner(event, avatar);
        if (corner) this.beginResize(event, avatar, corner);
        else if (this.hitsAvatar(event, avatar)) this.beginDrag(event, avatar.id);
        else this.beginMarquee(event, avatar);
      });

      // Cursor is the only affordance a geometric hit test gets for free —
      // nothing under the pointer is a real element, so :hover cannot help.
      stageEl.addEventListener('pointermove', (event) => {
        if (!this.cropping) return;
        const avatar = this.avatarItem;
        if (!avatar) return;
        if (avatar.w >= 99 && avatar.h >= 99) {
          stageEl.style.cursor = 'crosshair';
          return;
        }
        const corner = this.hitsCorner(event, avatar);
        stageEl.style.cursor = corner
          ? corner === 'nw' || corner === 'se'
            ? 'nwse-resize'
            : 'nesw-resize'
          : this.hitsAvatar(event, avatar)
            ? 'move'
            : 'crosshair';
      });
    }

    this.bands = { back, front, edit };

    // Text sizes are authored against a 1080p-tall stage; rescale on resize so
    // the OBS render and the editor agree about proportions.
    new ResizeObserver(() => this.positionAll()).observe(stageEl);
  }

  get scene(): SceneSpec {
    return this.spec;
  }

  get selected(): SceneItem | null {
    return this.spec.items.find((item) => item.id === this.selectedId) ?? null;
  }

  // ------------------------------------------------------------- persistence

  /** Loads a spec (already parsed). Does NOT emit — loading is not editing. */
  load(spec: SceneSpec): void {
    this.spec = spec;
    this.selectedId = null;
    this.renderAll();
    this.onSelect?.(null);
  }

  /**
   * Restores the last scene edited in THIS browser.
   *
   * The avatar's box is deliberately not restored — every load starts full
   * frame. Local storage is a convenience, and a crop is far too easy to make by
   * accident (in crop mode a forgotten Ctrl draws one), so carrying it across
   * reloads means a stray drag can leave the avatar stuck in a corner with no
   * obvious cause. Overlays and background are restored as before; only the box
   * resets.
   *
   * A crop that was MEANT survives the way every deliberate scene does — in the
   * `#s=` link and in exported scene JSON, both of which load through `load()`
   * untouched. That distinction matters: the OBS browser source opens a `#s=`
   * URL, so broadcast layouts keep their corner cam.
   */
  loadFromStorage(): boolean {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const spec = sanitizeScene(JSON.parse(raw));
      if (!spec) return false;

      const avatar = spec.items.find((item) => item.kind === 'avatar') as AvatarItem | undefined;
      if (avatar) {
        const fresh = fullFrameAvatar();
        avatar.x = fresh.x;
        avatar.y = fresh.y;
        avatar.w = fresh.w;
        avatar.h = fresh.h;
        // The rounding and backing plate only read as deliberate on a cropped
        // box; stretched across the whole frame they are leftovers, not a look.
        avatar.radius = fresh.radius;
        avatar.plate = fresh.plate;
      }

      this.load(spec);
      return true;
    } catch {
      return false;
    }
  }

  serialize(): string {
    return toBase64Url(JSON.stringify(compact(this.spec)));
  }

  static parseEncoded(encoded: string): SceneSpec | null {
    try {
      return sanitizeScene(JSON.parse(fromBase64Url(encoded)));
    } catch {
      return null;
    }
  }

  exportJson(): string {
    return JSON.stringify(compact(this.spec), null, 2);
  }

  importJson(json: string): boolean {
    try {
      const spec = sanitizeScene(JSON.parse(json));
      if (!spec) return false;
      this.load(spec);
      this.emit();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Empty means "nothing to share".
   *
   * A default avatar row does not count — it is what a scene-less app already
   * shows. A MOVED one does: the avatar now carries the rect, framing and
   * composition, so treating it as nothing would drop the operator's whole
   * layout from the copied link.
   */
  get isEmpty(): boolean {
    if (this.spec.background.type !== 'none') return false;
    const defaults = fullFrameAvatar();
    return this.spec.items.every(
      (item) =>
        item.kind === 'avatar' &&
        (Object.keys(defaults) as (keyof AvatarItem)[]).every(
          (key) => key === 'id' || item[key] === defaults[key],
        ),
    );
  }

  /** The single avatar row, which every sanitized scene has. */
  get avatarItem(): AvatarItem | null {
    return (this.spec.items.find((item) => item.kind === 'avatar') as AvatarItem) ?? null;
  }

  get cropMode(): boolean {
    return this.cropping;
  }

  /**
   * Enters or leaves crop mode.
   *
   * While cropping, overlays stop taking pointer events (see the `.cropping`
   * rules): the stage is one surface for one job, so a stray text item cannot
   * intercept half of a crop drag.
   */
  setCropMode(on: boolean): void {
    if (!this.editable || this.cropping === on) return;
    this.cropping = on;
    this.bands.back.classList.toggle('cropping', on);
    this.bands.front.classList.toggle('cropping', on);
    if (!on) {
      this.stageEl.style.cursor = '';
      this.select(null);
    }
    this.renderAll();
  }

  /** Restores the avatar to the whole frame — the way out of a bad crop. */
  resetCrop(): void {
    const item = this.avatarItem;
    if (!item) return;
    this.updateItem(item.id, { x: 50, y: 50, w: 100, h: 100 });
  }

  // ------------------------------------------------------------- editing

  setBackground(background: SceneBackground): void {
    this.spec.background = background;
    this.applyBackground();
    this.emit();
  }

  addText(): TextItem {
    const item: TextItem = {
      id: newId(),
      kind: 'text',
      text: '텍스트',
      x: 50,
      y: 20,
      band: 'front',
      size: 48,
      color: '#ffffff',
      bold: true,
      shadow: true,
    };
    this.spec.items.push(item);
    this.renderItem(item);
    this.select(item.id);
    this.emit();
    return item;
  }

  addImage(url: string): ImageItem {
    const item: ImageItem = {
      id: newId(),
      kind: 'image',
      url,
      x: 78,
      y: 75,
      width: 22,
      band: 'front',
    };
    this.spec.items.push(item);
    this.renderItem(item);
    this.select(item.id);
    this.emit();
    return item;
  }

  updateItem(
    id: string,
    patch: Partial<Omit<TextItem, 'kind'> & Omit<ImageItem, 'kind'> & Omit<AvatarItem, 'kind'>>,
  ): void {
    const item = this.spec.items.find((entry) => entry.id === id);
    if (!item) return;

    const movedBand = 'band' in patch && patch.band !== (item as { band?: string }).band;
    // A plate appearing or vanishing adds or removes a node, which styling
    // cannot do.
    const platedChanged =
      item.kind === 'avatar' && 'plate' in patch && (patch.plate === null) !== (item.plate === null);
    Object.assign(item, patch);

    // Moving between bands means moving the node, and reordering means redoing
    // the sequence. At 60 items a full re-render is free and keeps "later item
    // on top" honest without bookkeeping.
    if (movedBand || platedChanged) {
      this.renderAll();
    } else {
      const el = this.elements.get(id);
      if (el) this.styleItem(el, item);
    }
    this.emit();
  }

  removeItem(id: string): void {
    this.spec.items = this.spec.items.filter((entry) => entry.id !== id);
    this.elements.get(id)?.remove();
    this.elements.delete(id);
    if (this.selectedId === id) this.select(null);
    this.emit();
  }

  /** Clears overlays and background but keeps the avatar — it is not decoration. */
  clear(): void {
    const avatar = this.avatarItem;
    const next = emptyScene();
    if (avatar) next.items = [avatar];
    this.load(next);
    this.emit();
  }

  select(id: string | null): void {
    this.selectedId = id;
    for (const [itemId, el] of this.elements) {
      el.classList.toggle('selected', itemId === id);
    }
    this.onSelect?.(this.selected);
  }

  // ------------------------------------------------------------- rendering

  private renderAll(): void {
    this.bands.back.innerHTML = '';
    this.bands.front.innerHTML = '';
    if (this.bands.edit) this.bands.edit.innerHTML = '';
    this.elements.clear();
    this.plates.clear();
    this.applyBackground();
    for (const item of this.spec.items) this.renderItem(item);
  }

  private renderItem(item: SceneItem): void {
    // The avatar is pixels in the WebGL canvas, not a DOM node. It still needs to
    // be selectable and draggable, so it gets a grip in the edit band and nothing
    // else — the rect itself is handed to Stage by main.ts.
    if (item.kind === 'avatar') {
      this.renderAvatarPlate(item);
      this.renderAvatarGrip(item);
      return;
    }

    let el: HTMLElement;
    if (item.kind === 'text') {
      el = document.createElement('div');
      el.className = 'scene-item scene-text';
    } else {
      const img = document.createElement('img');
      img.className = 'scene-item scene-image';
      img.draggable = false;
      el = img;
    }
    el.hidden = item.hidden === true;
    this.styleItem(el, item);
    this.bindDrag(el, item.id);
    this.bands[item.band].appendChild(el);
    this.elements.set(item.id, el);
  }

  /**
   * The avatar's outline. Purely decorative — `pointer-events: none`.
   *
   * The grip is in the topmost band and a full-frame avatar's grip covers the
   * entire stage, so anything grabbable here would shadow every text and image
   * in the scene and make a migrated v1 scene uneditable. Instead the avatar is
   * hit-tested against its rect by the stage-level handler, which runs only
   * after the real items have declined the click.
   */
  /**
   * The avatar's backing plate: a flat fill drawn inside its rect only.
   *
   * A DOM div in the back band, not a WebGL clear colour — the band machinery
   * already positions and rounds rectangles, and a clear colour would fill the
   * whole canvas rather than the rect.
   */
  private renderAvatarPlate(item: AvatarItem): void {
    if (item.plate === null) return;
    const plate = document.createElement('div');
    plate.className = 'scene-plate';
    plate.hidden = item.hidden === true;
    plate.style.background = item.plate;
    plate.style.borderRadius = `${item.radius}%`;
    this.styleItem(plate, item);
    this.bands.back.appendChild(plate);
    this.plates.set(item.id, plate);
  }

  private renderAvatarGrip(item: AvatarItem): void {
    if (!this.bands.edit || !this.cropping) return;
    const grip = document.createElement('div');
    grip.className = 'scene-grip scene-avatar-grip';
    grip.hidden = item.hidden === true;
    for (const corner of CORNERS) {
      const handle = document.createElement('div');
      handle.className = `crop-handle crop-${corner}`;
      grip.appendChild(handle);
    }
    this.styleItem(grip, item);
    this.bands.edit.appendChild(grip);
    this.elements.set(item.id, grip);
  }

  /** Pointer position as a percentage of the stage. Null if it has no size. */
  private pctOf(event: { clientX: number; clientY: number }): { x: number; y: number } | null {
    const rect = this.stageEl.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return {
      x: ((event.clientX - rect.left) / rect.width) * 100,
      y: ((event.clientY - rect.top) / rect.height) * 100,
    };
  }

  /** Is this point inside the avatar's rect? Percentages, so resolution-free. */
  private hitsAvatar(event: { clientX: number; clientY: number }, item: AvatarItem): boolean {
    const p = this.pctOf(event);
    if (!p) return false;
    return Math.abs(p.x - item.x) <= item.w / 2 && Math.abs(p.y - item.y) <= item.h / 2;
  }

  /** Which corner handle the pointer is on, if any. Measured in px, not %. */
  private hitsCorner(event: { clientX: number; clientY: number }, item: AvatarItem): Corner | null {
    const rect = this.stageEl.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    // A percentage tolerance would make the grab zone tall and thin on a wide
    // stage. The handle is drawn in pixels, so it is hit-tested in pixels.
    const left = rect.left + ((item.x - item.w / 2) / 100) * rect.width;
    const right = rect.left + ((item.x + item.w / 2) / 100) * rect.width;
    const top = rect.top + ((item.y - item.h / 2) / 100) * rect.height;
    const bottom = rect.top + ((item.y + item.h / 2) / 100) * rect.height;

    const nearX = Math.abs(event.clientX - left) <= HANDLE_GRAB ? 'w' : Math.abs(event.clientX - right) <= HANDLE_GRAB ? 'e' : null;
    const nearY = Math.abs(event.clientY - top) <= HANDLE_GRAB ? 'n' : Math.abs(event.clientY - bottom) <= HANDLE_GRAB ? 's' : null;
    return nearX && nearY ? (`${nearY}${nearX}` as Corner) : null;
  }

  /**
   * Writes a rect onto the avatar and pushes it out live.
   *
   * `onChange` on every move rather than only on release: the rect drives the
   * WebGL viewport, so without it the outline would slide away from the pixels
   * it is supposed to be framing.
   */
  private applyRect(item: AvatarItem, x: number, y: number, w: number, h: number): void {
    item.w = Math.min(100, Math.max(MIN_RECT, w));
    item.h = Math.min(100, Math.max(MIN_RECT, h));
    item.x = clampPct(x);
    item.y = clampPct(y);
    const el = this.elements.get(item.id);
    if (el) this.styleItem(el, item);
    this.onChange?.();
  }

  /** Drags one corner; the opposite corner stays put. */
  private beginResize(event: PointerEvent, item: AvatarItem, corner: Corner): void {
    event.preventDefault();
    const anchorX = corner.includes('w') ? item.x + item.w / 2 : item.x - item.w / 2;
    const anchorY = corner.startsWith('n') ? item.y + item.h / 2 : item.y - item.h / 2;

    const move = (ev: PointerEvent) => {
      const p = this.pctOf(ev);
      if (!p) return;
      const x = clampPct(p.x);
      const y = clampPct(p.y);
      this.applyRect(item, (anchorX + x) / 2, (anchorY + y) / 2, Math.abs(x - anchorX), Math.abs(y - anchorY));
    };
    this.trackDrag(move);
  }

  /**
   * Draws a fresh rect from nothing, the way a photo crop tool does.
   *
   * The avatar renders inside the rect as it grows, so the drag is the preview.
   * A drag too small to be deliberate is treated as a stray click and the old
   * rect comes back — otherwise a mis-click would shrink the performer to a dot.
   */
  private beginMarquee(event: PointerEvent, item: AvatarItem): void {
    event.preventDefault();
    const start = this.pctOf(event);
    if (!start) return;
    const previous = { x: item.x, y: item.y, w: item.w, h: item.h };
    let drawn = false;

    const move = (ev: PointerEvent) => {
      const p = this.pctOf(ev);
      if (!p) return;
      const x = clampPct(p.x);
      const y = clampPct(p.y);
      const w = Math.abs(x - start.x);
      const h = Math.abs(y - start.y);
      drawn = w >= MIN_RECT && h >= MIN_RECT;
      this.applyRect(item, (start.x + x) / 2, (start.y + y) / 2, w, h);
    };
    this.trackDrag(move, () => {
      if (!drawn) this.applyRect(item, previous.x, previous.y, previous.w, previous.h);
    });
  }

  /** Shared pointer capture: move until release, then persist once. */
  private trackDrag(move: (event: PointerEvent) => void, done?: () => void): void {
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      done?.();
      this.emit();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  private styleItem(el: HTMLElement, item: SceneItem): void {
    el.style.left = `${item.x}%`;
    el.style.top = `${item.y}%`;

    if (item.kind === 'avatar') {
      el.style.width = `${item.w}%`;
      el.style.height = `${item.h}%`;
      // The plate shares the rect, so it follows the same styling pass rather
      // than needing every caller to remember it.
      const plate = this.plates.get(item.id);
      if (plate && plate !== el) {
        plate.style.left = el.style.left;
        plate.style.top = el.style.top;
        plate.style.width = el.style.width;
        plate.style.height = el.style.height;
        plate.style.borderRadius = `${item.radius}%`;
        if (item.plate !== null) plate.style.background = item.plate;
        plate.hidden = item.hidden === true;
      }
      return;
    }

    if (item.kind === 'text') {
      // textContent, never innerHTML: scene JSON arrives from URLs and files.
      el.textContent = item.text;
      const scale = (this.stageEl.clientHeight || DESIGN_HEIGHT) / DESIGN_HEIGHT;
      el.style.fontSize = `${item.size * scale}px`;
      el.style.color = item.color;
      el.style.fontWeight = item.bold ? '700' : '400';
      el.style.textShadow = item.shadow ? '0 2px 8px rgba(0,0,0,0.75)' : 'none';
    } else {
      (el as HTMLImageElement).src = item.url;
      el.style.width = `${item.width}%`;
    }
  }

  private positionAll(): void {
    for (const item of this.spec.items) {
      const el = this.elements.get(item.id);
      if (el) this.styleItem(el, item);
    }
  }

  private applyBackground(): void {
    const background = this.spec.background;
    // The BACK band, not the stage element: the background must sit behind the
    // avatar but in front of nothing, and the stage itself has to stay
    // transparent for OBS to composite the whole frame.
    const target = this.bands.back.style;
    if (background.type === 'color') {
      target.background = background.color;
    } else if (background.type === 'image') {
      // The URL was sanitized on the way in; quotes/backslashes are stripped.
      target.background = `center / cover no-repeat url("${background.url}")`;
    } else {
      target.background = '';
    }
  }

  private bindDrag(el: HTMLElement, id: string): void {
    if (!this.editable) return;

    el.addEventListener('pointerdown', (event) => {
      // Ctrl/Cmd-drag belongs to the camera, which listens on #stage. Bubble
      // instead of swallowing so panning stays reachable over any item.
      if (event.ctrlKey || event.metaKey) return;
      event.stopPropagation();
      this.beginDrag(event, id);
    });
  }

  /** Selects `id` and moves it with the pointer until release. */
  private beginDrag(event: PointerEvent, id: string): void {
    event.preventDefault();
    this.select(id);

    const rect = this.stageEl.getBoundingClientRect();
    const item = this.spec.items.find((entry) => entry.id === id);
    const el = this.elements.get(id);
    if (!item || !el || rect.width === 0) return;

    // Grab offset, so the item does not jump its centre to the cursor. It also
    // makes dragging a full-frame avatar a no-op rather than a violent snap.
    const dx = item.x - ((event.clientX - rect.left) / rect.width) * 100;
    const dy = item.y - ((event.clientY - rect.top) / rect.height) * 100;

    const move = (ev: PointerEvent) => {
      item.x = clampPct(((ev.clientX - rect.left) / rect.width) * 100 + dx);
      item.y = clampPct(((ev.clientY - rect.top) / rect.height) * 100 + dy);
      this.styleItem(el, item);
      // The avatar's rect drives the WebGL viewport, so it has to follow the
      // drag live — the grip alone would slide off the pixels it represents.
      if (item.kind === 'avatar') this.onChange?.();
    };
    this.trackDrag(move);
  }

  private emit(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.spec));
    } catch {
      // Storage full or private mode; the scene still works, it just won't persist.
    }
    this.onChange?.();
  }
}

// ---------------------------------------------------------------- validation

/**
 * Whitelist validation for scene JSON arriving from URLs, files, or another
 * tab. Rendering uses textContent so script injection is off the table; this
 * guards shape, bounds, and URL schemes instead.
 */
export function sanitizeScene(raw: unknown): SceneSpec | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const input = raw as Record<string, unknown>;

  const version = asNumber(input['version'], 1);
  const background = sanitizeBackground(input['background']);
  const itemsRaw = Array.isArray(input['items']) ? input['items'] : [];
  const items: SceneItem[] = [];
  let hasAvatar = false;

  for (const entry of itemsRaw.slice(0, 60)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const it = entry as Record<string, unknown>;
    const base = {
      id: typeof it['id'] === 'string' ? it['id'].slice(0, 32) : newId(),
      x: clampPct(asNumber(it['x'], 50)),
      y: clampPct(asNumber(it['y'], 50)),
      band: it['band'] === 'back' ? ('back' as const) : ('front' as const),
      ...(it['hidden'] === true ? { hidden: true } : {}),
    };
    if (it['kind'] === 'text') {
      items.push({
        ...base,
        kind: 'text',
        text: typeof it['text'] === 'string' ? it['text'].slice(0, 500) : '',
        size: Math.min(200, Math.max(8, asNumber(it['size'], 48))),
        color: sanitizeColor(it['color']) ?? '#ffffff',
        bold: it['bold'] === true,
        shadow: it['shadow'] !== false,
      });
    } else if (it['kind'] === 'image') {
      const url = sanitizeUrl(it['url']);
      if (url) {
        items.push({
          ...base,
          kind: 'image',
          url,
          width: Math.min(100, Math.max(2, asNumber(it['width'], 20))),
        });
      }
    } else if (it['kind'] === 'avatar') {
      // One avatar, first wins. The rounded-corner mask is a CSS mask on the one
      // canvas, so a second is a constraint enforced by data rather than hope.
      if (hasAvatar) continue;
      hasAvatar = true;
      const framing = it['framing'];
      items.push({
        id: base.id,
        x: base.x,
        y: base.y,
        ...(base.hidden ? { hidden: true } : {}),
        kind: 'avatar',
        w: Math.min(100, Math.max(5, asNumber(it['w'], 100))),
        h: Math.min(100, Math.max(5, asNumber(it['h'], 100))),
        framing: framing === 'head' || framing === 'full' ? framing : 'bust',
        panX: clampRange(asNumber(it['panX'], 0), -5, 5),
        panY: clampRange(asNumber(it['panY'], 0), -5, 5),
        zoom: clampRange(asNumber(it['zoom'], 1), 0.25, 6),
        radius: Math.min(50, Math.max(0, asNumber(it['radius'], 0))),
        plate: sanitizeColor(it['plate']),
      });
    }
  }

  /*
   * v1 → v2. A v1 scene had no avatar row because the avatar WAS the canvas —
   * absence meant "fills the frame". Synthesising that makes every link already
   * pasted into someone's OBS render exactly as it did before.
   */
  if (!hasAvatar) items.unshift(fullFrameAvatar());
  void version;

  return { version: SCENE_VERSION, background, items };
}

/**
 * Strips keys equal to their defaults before serialising.
 *
 * Lossless by construction: `sanitizeScene` fills every default back in on the
 * way out, so anything omitted here is restored identically. This is what keeps
 * the injected avatar row at roughly 40 bytes instead of 180 — headroom the
 * shared URL needs, since a scene rides in the hash.
 */
export function compact(spec: SceneSpec): unknown {
  const items = spec.items.map((item) => {
    const out: Record<string, unknown> = { kind: item.kind, id: item.id };
    if (item.x !== 50) out['x'] = round(item.x);
    if (item.y !== 50) out['y'] = round(item.y);
    if (item.hidden) out['hidden'] = true;
    if (item.kind !== 'avatar' && item.band !== 'front') out['band'] = item.band;

    if (item.kind === 'text') {
      out['text'] = item.text;
      if (item.size !== 48) out['size'] = round(item.size);
      if (item.color !== '#ffffff') out['color'] = item.color;
      if (item.bold) out['bold'] = true;
      if (!item.shadow) out['shadow'] = false;
    } else if (item.kind === 'image') {
      out['url'] = item.url;
      if (item.width !== 20) out['width'] = round(item.width);
    } else {
      if (item.w !== 100) out['w'] = round(item.w);
      if (item.h !== 100) out['h'] = round(item.h);
      if (item.framing !== 'bust') out['framing'] = item.framing;
      if (item.panX !== 0) out['panX'] = round(item.panX);
      if (item.panY !== 0) out['panY'] = round(item.panY);
      if (item.zoom !== 1) out['zoom'] = round(item.zoom);
      if (item.radius !== 0) out['radius'] = round(item.radius);
      if (item.plate) out['plate'] = item.plate;
    }
    return out;
  });

  const out: Record<string, unknown> = { version: SCENE_VERSION, items };
  if (spec.background.type !== 'none') out['background'] = spec.background;
  return out;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function clampRange(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sanitizeBackground(raw: unknown): SceneBackground {
  if (typeof raw !== 'object' || raw === null) return { type: 'none' };
  const bg = raw as Record<string, unknown>;
  if (bg['type'] === 'color') {
    const color = sanitizeColor(bg['color']);
    if (color) return { type: 'color', color };
  }
  if (bg['type'] === 'image') {
    const url = sanitizeUrl(bg['url']);
    if (url) return { type: 'image', url };
  }
  return { type: 'none' };
}

function sanitizeColor(raw: unknown): string | null {
  return typeof raw === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(raw) ? raw : null;
}

export function sanitizeUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const url = raw.replace(/["\\]/g, '');
  if (/^https?:\/\//.test(url) || /^data:image\//.test(url)) return url;
  // Root-relative paths resolve against the deploy base, or every one of them
  // 404s the moment the app is hosted under a subpath.
  if (url.startsWith('/')) return withBase(url);
  return null;
}

function asNumber(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
}

function clampPct(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// Base64url that survives non-ASCII text (scene text is frequently Korean).
function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(encoded: string): string {
  const binary = atob(encoded.replaceAll('-', '+').replaceAll('_', '/'));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}
