import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';

export type Framing = 'bust' | 'head' | 'full';

/**
 * The render surface: camera, lights, and the transparent canvas that OBS reads.
 *
 * Everything visual lives in this scene graph — avatar, background, and later
 * props and effects. That single-graph property is the whole point of the
 * product: a donation alert and the avatar's reaction are the same frame, not
 * two programs that have never heard of each other.
 */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  private readonly timer = new THREE.Timer();
  private readonly container: HTMLElement;
  private backdrop: THREE.Mesh | null = null;

  /** Framing computed from the model, before the user's manual adjustment. */
  private baseHeight = 1.3;
  private baseDistance = 2;

  /** Manual view adjustment: Ctrl-drag pans, wheel zooms. */
  private readonly view = { panX: 0, panY: 0, zoom: 1 };

  constructor(container: HTMLElement) {
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      // OBS's browser source composites the canvas itself; premultiplied alpha
      // is what CEF expects, and skipping it produces dark fringes on hair.
      premultipliedAlpha: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(28, 1, 0.1, 30);
    this.camera.position.set(0, 1.35, 1.6);

    // MToon reads a key light plus ambient. Anything harsher than this flattens
    // the toon ramp and makes VRoid models look plastic.
    const key = new THREE.DirectionalLight(0xffffff, 1.9);
    key.position.set(0.6, 1.6, 1.4);
    this.scene.add(key);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.75));

    // Hooks the Page Visibility API so a hidden tab does not accumulate one
    // enormous delta and fling the spring bones when it comes back — which is
    // exactly what happens to an OBS browser source on scene switches.
    this.timer.connect(document);

    // Size eagerly for the common case where layout already exists, then keep
    // observing. The observer alone is not enough: its callbacks are delivered
    // as part of the frame lifecycle, so a tab that starts with frames
    // suspended would sit at the 300x150 canvas default until it resumes.
    this.resize();

    // A ResizeObserver rather than a window resize listener: it catches
    // container resizes that never touch the window — notably OBS setting its
    // own browser-source dimensions — and covers the case where the constructor
    // ran before layout existed.
    new ResizeObserver(() => this.resize()).observe(container);

    this.bindViewControls();
  }

  /** Seconds since the previous frame, for spring bones and filters. */
  tick(): number {
    this.timer.update();
    return this.timer.getDelta();
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Frames the avatar from its own proportions rather than fixed distances.
   *
   * The scale reference is the head-to-hips length, which every humanoid rig has
   * and which no amount of stylisation breaks. Distance is then solved from the
   * field of view to fit the requested vertical span, so tall, short, and chibi
   * models all get the same composition — and, critically, the same headroom.
   * Hardcoded distances cropped the top of the head on anything but an average
   * build.
   */
  frame(vrm: VRM, mode: Framing = 'bust'): void {
    const head = vrm.humanoid?.getNormalizedBoneNode('head');
    const hips = vrm.humanoid?.getNormalizedBoneNode('hips');
    if (!head) return;

    const headPosition = new THREE.Vector3();
    head.getWorldPosition(headPosition);

    const hipPosition = new THREE.Vector3();
    if (hips) hips.getWorldPosition(hipPosition);

    // Torso length as a scale proxy; guard against a degenerate rig.
    const scale = Math.max(0.15, headPosition.y - hipPosition.y);

    // Generous: the head bone sits at roughly ear height, and hair goes well
    // above the skull. Under-estimating this is exactly what clipped the crown.
    const crown = headPosition.y + scale * 0.55;

    const spans: Record<Framing, { bottom: number; fov: number }> = {
      head: { bottom: headPosition.y - scale * 0.35, fov: 24 },
      bust: { bottom: headPosition.y - scale * 1.15, fov: 28 },
      full: { bottom: hipPosition.y - scale * 1.9, fov: 32 },
    };

    const { bottom, fov } = spans[mode];
    const span = (crown - bottom) * 1.06;

    this.camera.fov = fov;
    this.baseHeight = (crown + bottom) / 2;
    this.baseDistance = span / 2 / Math.tan((fov * Math.PI) / 360);
    this.updateCamera();
  }

  /**
   * Fired when the operator finishes moving or zooming the view.
   *
   * Composition belongs to the host, so it has to travel — to the copied URL and,
   * when broadcasting, to every viewer.
   */
  onViewChange: ((view: { panX: number; panY: number; zoom: number }) => void) | null = null;

  /** Manual view state, so an OBS URL can reproduce the operator's composition. */
  getView(): { panX: number; panY: number; zoom: number } {
    return { ...this.view };
  }

  setView(view: Partial<{ panX: number; panY: number; zoom: number }>): void {
    if (Number.isFinite(view.panX)) this.view.panX = view.panX!;
    if (Number.isFinite(view.panY)) this.view.panY = view.panY!;
    if (Number.isFinite(view.zoom) && view.zoom! > 0) this.view.zoom = view.zoom!;
    this.updateCamera();
  }

  resetView(): void {
    this.view.panX = 0;
    this.view.panY = 0;
    this.view.zoom = 1;
    this.updateCamera();
  }

  private updateCamera(): void {
    const height = this.baseHeight + this.view.panY;
    this.camera.position.set(this.view.panX, height, this.baseDistance / this.view.zoom);
    this.camera.lookAt(this.view.panX, height, 0);
    this.camera.updateProjectionMatrix();
  }

  /**
   * Ctrl-drag to pan, wheel to zoom.
   *
   * Ctrl is required so a future click-to-interact scene does not fight the
   * camera for plain drags.
   *
   * Bound to the STAGE, not the canvas. Once the avatar became a scene item it
   * gained an edit grip that sits over the canvas — a full-frame avatar's grip
   * covers it entirely — so canvas-bound listeners would never fire again. The
   * grip lets modifier gestures bubble instead of swallowing them.
   */
  private bindViewControls(): void {
    const surface = this.container;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    surface.addEventListener('pointerdown', (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      dragging = true;
      lastX = event.clientX;
      lastY = event.clientY;
      surface.setPointerCapture(event.pointerId);
      event.preventDefault();
    });

    surface.addEventListener('pointermove', (event) => {
      if (!dragging) return;

      // Convert pixels to world units at the subject's depth, so a drag moves the
      // avatar exactly as far as the cursor regardless of zoom.
      const distance = this.baseDistance / this.view.zoom;
      const worldPerPixel =
        (2 * distance * Math.tan((this.camera.fov * Math.PI) / 360)) /
        Math.max(1, surface.clientHeight);

      // The camera moves opposite the cursor so the avatar appears to follow it.
      this.view.panX -= (event.clientX - lastX) * worldPerPixel;
      this.view.panY += (event.clientY - lastY) * worldPerPixel;
      lastX = event.clientX;
      lastY = event.clientY;
      this.updateCamera();
    });

    const endDrag = (event: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      if (surface.hasPointerCapture(event.pointerId)) {
        surface.releasePointerCapture(event.pointerId);
      }
      // Fired at the end of the gesture, not per move: the composition matters
      // once the operator has finished placing it.
      this.emitViewChange();
    };
    surface.addEventListener('pointerup', endDrag);
    surface.addEventListener('pointercancel', endDrag);

    surface.addEventListener(
      'wheel',
      (event) => {
        // Scrolling over an overlay is aimed at the overlay, not the camera.
        // Grips are exempt — a grip IS the avatar's stand-in.
        if ((event.target as HTMLElement | null)?.closest?.('.scene-item')) return;
        event.preventDefault();
        const factor = Math.exp(-event.deltaY * 0.0015);
        this.view.zoom = Math.min(6, Math.max(0.25, this.view.zoom * factor));
        this.updateCamera();
        // A wheel gesture has no end event, so trail it.
        if (this.wheelSettle !== null) clearTimeout(this.wheelSettle);
        this.wheelSettle = window.setTimeout(() => {
          this.wheelSettle = null;
          this.emitViewChange();
        }, 200);
      },
      { passive: false },
    );
  }

  private wheelSettle: number | null = null;

  private emitViewChange(): void {
    this.onViewChange?.(this.getView());
  }

  /** Sets a flat image backdrop, or clears it when passed null. */
  async setBackdrop(url: string | null): Promise<void> {
    if (this.backdrop) {
      this.scene.remove(this.backdrop);
      this.backdrop.geometry.dispose();
      (this.backdrop.material as THREE.Material).dispose();
      this.backdrop = null;
    }
    if (!url) return;

    const texture = await new THREE.TextureLoader().loadAsync(url);
    texture.colorSpace = THREE.SRGBColorSpace;
    const aspect = texture.image.width / texture.image.height;
    const height = 4;

    this.backdrop = new THREE.Mesh(
      new THREE.PlaneGeometry(height * aspect, height),
      new THREE.MeshBasicMaterial({ map: texture, depthWrite: false }),
    );
    this.backdrop.position.set(0, 1.2, -2.2);
    this.scene.add(this.backdrop);
  }

  private resize(): void {
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }
}
