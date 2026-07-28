import { withBase } from '../basePath';
import {
  emptyScene,
  type ImageItem,
  type SceneBackground,
  type SceneItem,
  type SceneSpec,
  type TextItem,
} from './sceneTypes';

const STORAGE_KEY = 'vrm-stage:scene';

/** Design height the text sizes are authored against. */
const DESIGN_HEIGHT = 1080;

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
  private readonly layer: HTMLElement;
  private readonly elements = new Map<string, HTMLElement>();
  private selectedId: string | null = null;

  /** Fired after any user-visible change; wired to broadcast + notices. */
  onChange: (() => void) | null = null;
  /** Fired when the selection changes; the panel renders its inspector from it. */
  onSelect: ((item: SceneItem | null) => void) | null = null;

  constructor(
    private readonly stageEl: HTMLElement,
    private readonly editable: boolean,
  ) {
    this.layer = document.createElement('div');
    this.layer.id = 'scene-layer';
    this.layer.classList.toggle('editable', editable);
    stageEl.appendChild(this.layer);

    if (editable) {
      // The layer is input-transparent (camera panning lives on the canvas), so
      // "click empty space to deselect" listens on the stage instead.
      stageEl.addEventListener('pointerdown', (event) => {
        const target = event.target as HTMLElement | null;
        if (!target?.closest('.scene-text, .scene-image')) this.select(null);
      });
    }

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

  loadFromStorage(): boolean {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const spec = sanitizeScene(JSON.parse(raw));
      if (!spec) return false;
      this.load(spec);
      return true;
    } catch {
      return false;
    }
  }

  serialize(): string {
    return toBase64Url(JSON.stringify(this.spec));
  }

  static parseEncoded(encoded: string): SceneSpec | null {
    try {
      return sanitizeScene(JSON.parse(fromBase64Url(encoded)));
    } catch {
      return null;
    }
  }

  exportJson(): string {
    return JSON.stringify(this.spec, null, 2);
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

  get isEmpty(): boolean {
    return this.spec.items.length === 0 && this.spec.background.type === 'none';
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
    const item: ImageItem = { id: newId(), kind: 'image', url, x: 78, y: 75, width: 22 };
    this.spec.items.push(item);
    this.renderItem(item);
    this.select(item.id);
    this.emit();
    return item;
  }

  updateItem(id: string, patch: Partial<Omit<TextItem, 'kind'> & Omit<ImageItem, 'kind'>>): void {
    const item = this.spec.items.find((entry) => entry.id === id);
    if (!item) return;
    Object.assign(item, patch);
    const el = this.elements.get(id);
    if (el) this.styleItem(el, item);
    this.emit();
  }

  removeItem(id: string): void {
    this.spec.items = this.spec.items.filter((entry) => entry.id !== id);
    this.elements.get(id)?.remove();
    this.elements.delete(id);
    if (this.selectedId === id) this.select(null);
    this.emit();
  }

  clear(): void {
    this.load(emptyScene());
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
    this.layer.innerHTML = '';
    this.elements.clear();
    this.applyBackground();
    for (const item of this.spec.items) this.renderItem(item);
  }

  private renderItem(item: SceneItem): void {
    let el: HTMLElement;
    if (item.kind === 'text') {
      el = document.createElement('div');
      el.className = 'scene-text';
    } else {
      const img = document.createElement('img');
      img.className = 'scene-image';
      img.draggable = false;
      el = img;
    }
    this.styleItem(el, item);
    this.bindDrag(el, item.id);
    this.layer.appendChild(el);
    this.elements.set(item.id, el);
  }

  private styleItem(el: HTMLElement, item: SceneItem): void {
    el.style.left = `${item.x}%`;
    el.style.top = `${item.y}%`;

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
    if (background.type === 'color') {
      this.stageEl.style.background = background.color;
    } else if (background.type === 'image') {
      // The URL was sanitized on the way in; quotes/backslashes are stripped.
      this.stageEl.style.background = `center / cover no-repeat url("${background.url}")`;
    } else {
      this.stageEl.style.background = '';
    }
  }

  private bindDrag(el: HTMLElement, id: string): void {
    if (!this.editable) return;

    el.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.select(id);

      const rect = this.stageEl.getBoundingClientRect();
      const item = this.spec.items.find((entry) => entry.id === id);
      if (!item || rect.width === 0) return;

      const move = (ev: PointerEvent) => {
        item.x = clampPct(((ev.clientX - rect.left) / rect.width) * 100);
        item.y = clampPct(((ev.clientY - rect.top) / rect.height) * 100);
        this.styleItem(el, item);
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        // One emit per drag, not per pixel.
        this.emit();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
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

  const background = sanitizeBackground(input['background']);
  const itemsRaw = Array.isArray(input['items']) ? input['items'] : [];
  const items: SceneItem[] = [];

  for (const entry of itemsRaw.slice(0, 60)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const it = entry as Record<string, unknown>;
    const base = {
      id: typeof it['id'] === 'string' ? it['id'].slice(0, 32) : newId(),
      x: clampPct(asNumber(it['x'], 50)),
      y: clampPct(asNumber(it['y'], 50)),
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
    }
  }

  return { version: 1, background, items };
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
