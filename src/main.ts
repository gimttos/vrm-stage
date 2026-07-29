import { VRMUtils, type VRM } from '@pixiv/three-vrm';
import './ui/styles.css';

import { withBase } from './basePath';
import { applyModeClass, readMode, sceneEditable } from './mode';
import { Stage, type Framing } from './stage/Stage';
import { loadAvatar, type AvatarLicense, type LoadedAvatar } from './stage/AvatarLoader';
import { AvatarDriver, type DriverConfig } from './driver/AvatarDriver';
import { WebcamSource } from './tracking/WebcamSource';
import { VMCSource } from './tracking/VMCSource';
import { RemoteSource } from './tracking/RemoteSource';
import type { TrackingSource } from './tracking/TrackingSource';
import { RoomPublisher } from './net/RoomPublisher';
import { parseRoomMessage, type PerformConfig } from './net/protocol';
import {
  createRoom,
  endBroadcast,
  loadStoredRoom,
  roomSocketUrl,
  storeRoom,
  uploadModel,
  type RoomCredentials,
} from './net/rooms';
import { getModel, putModel } from './storage/modelStore';
import { EMOTIONS, Panel } from './ui/panel';
import { SceneManager } from './scene/SceneManager';
import type { PoseFrame } from './types';

/** Key the current model is cached under so an OBS URL can point at it. */
const IDB_KEY = 'last';
const IDB_REF = `idb:${IDB_KEY}`;

const params = new URLSearchParams(location.search);
const mode = readMode(params);
applyModeClass(mode);

/**
 * Whether this page instance drives the camera.
 *
 * A camera can only belong to one window at a time, so with an editor tab and an
 * OBS source open together one of them has to yield. This used to be hardcoded
 * as "never in OBS mode", which meant a real browser source rendered a static
 * avatar forever — spring bones and hotkeys, no head or hands. Now it is a
 * choice that travels in the URL.
 */
let trackInThisWindow = params.get('track') !== '0';

const stageRoot = must<HTMLElement>('#stage');
const uiRoot = must<HTMLElement>('#ui');

const stage = new Stage(stageRoot);
const driver = new AvatarDriver();
const config: DriverConfig = driver.config;

// The scene document: background + overlay items, one shared frame with the
// avatar. Only the compositor edits it; live output and the rig bench display it.
const sceneManager = new SceneManager(stageRoot, sceneEditable(mode));

let avatar: LoadedAvatar | null = null;
let source: TrackingSource | null = null;
let trackingWanted = false;

/** Dev-only synthetic frame override, so the rig can be tested without a camera. */
let debugFrame: PoseFrame | null = null;
let sourceKind: SourceKind = (params.get('source') as SourceKind) ?? 'webcam';

type SourceKind = 'webcam' | 'vmc' | 'remote';

/** Room this page watches, when it is a viewer. */
const watchRoomId = params.get('room');

/** Host credentials, when this page is the one performing. */
let room: RoomCredentials | null = null;
let publisher: RoomPublisher | null = null;

/**
 * True when this page only receives a performance.
 *
 * A viewer never constructs a `WebcamSource`, so there is no code path on which
 * it could open a camera or drive the avatar — read-only is structural here, and
 * enforced again by the room, which drops anything a subscriber sends.
 */
const isViewer = sourceKind === 'remote' && watchRoomId !== null;

/**
 * How the current avatar can be referred to in a URL. A dropped file has no
 * addressable URL of its own, so it is cached in IndexedDB and referenced as
 * `idb:last` — without this the copied OBS URL would open an empty scene.
 */
let modelRef: string | null = null;

let creditVisible = params.get('credit') !== '0';

const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.accept = '.vrm,model/gltf-binary';
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) void openFile(file);
});

const panel = new Panel(
  uiRoot,
  config,
  {
    onPickFile: () => fileInput.click(),
    onLoadFixture: (path) => void openUrl(path),
    onToggleTracking: () => void toggleTracking(),
    onConfigChange: (patch) => {
      Object.assign(config, patch);
      driver.resetFilters();
      if ('pitchOffset' in patch || 'yawOffset' in patch || 'rollOffset' in patch) {
        saveCalibration();
      }
      scheduleConfigBroadcast();
    },
    onFramingChange: (next) => {
      // Into the scene, not a local variable: framing is part of the layout the
      // link has to reproduce. `updateItem` emits, which syncs and broadcasts.
      const item = sceneManager.avatarItem;
      if (item) sceneManager.updateItem(item.id, { framing: next });
    },
    onSourceChange: (kind) => {
      sourceKind = kind as SourceKind;
      // Restart so the change takes effect immediately rather than at the next
      // manual toggle.
      if (trackingWanted) {
        void (async () => {
          await toggleTracking();
          await toggleTracking();
        })();
      }
    },
    onCopyLiveUrl: () => void copyLiveUrl(),
    onStartBroadcast: () => void startBroadcast(),
    onStopBroadcast: () => void stopBroadcast(),
    onCopyWatchLink: () => void copyWatchLink(),
    onTrackInThisWindowChange: (enabled) => {
      trackInThisWindow = enabled;
      if (enabled && !trackingWanted) void toggleTracking();
      else if (!enabled && trackingWanted) void toggleTracking();
    },
    onHandConfigChange: (patch) => {
      Object.assign(driver.hands.config, patch);
      driver.hands.reset();
      scheduleConfigBroadcast();
    },
    onBodyConfigChange: (patch) => {
      const wantsBody = 'torso' in patch;
      Object.assign(driver.body.config, patch);
      driver.body.reset();
      scheduleConfigBroadcast();
      // The pose detector is created at start(), so enabling it mid-session has
      // to restart the source rather than quietly do nothing.
      if (wantsBody && sourceKind === 'webcam' && trackingWanted) void restartTracking();
    },
    onCropModeChange: (on) => {
      sceneManager.setCropMode(on);
      panel.setNotice(
        on
          ? '크롭 모드 — 빈 곳을 드래그해 아바타 영역을 그리세요.'
          : '크롭 모드를 껐습니다.',
      );
    },
    onResetView: () => {
      // Through the scene, or the reset would be undone by the next sync.
      const item = sceneManager.avatarItem;
      if (item) sceneManager.updateItem(item.id, { panX: 0, panY: 0, zoom: 1 });
      else stage.resetView();
      panel.setNotice('구도를 초기화했습니다.');
      scheduleConfigBroadcast();
    },
    onEmotion: (name) => chooseEmotion(name),
    onCopySceneLink: () => void copySceneLink(),
    onCalibrate: () => {
      if (driver.calibrate()) {
        panel.syncSliders();
        saveCalibration();
        scheduleConfigBroadcast();
        panel.setNotice('현재 자세를 정면으로 설정했습니다.');
      } else {
        panel.setNotice('얼굴이 잡히지 않았습니다 — 트래킹을 켜고 다시 시도하세요.');
      }
    },
    onResetCalibration: () => {
      driver.resetCalibration();
      panel.syncSliders();
      saveCalibration();
      scheduleConfigBroadcast();
      panel.setNotice('보정을 초기화했습니다.');
    },
    onCreditVisibilityChange: (visible) => {
      creditVisible = visible;
      panel.setCreditVisible(visible);
    },
  },
  driver.hands.config,
  driver.body.config,
  sceneManager,
  { creditVisible, sourceKind, mode, trackInThisWindow },
);

panel.setTrackingState('off');
panel.setCreditVisible(creditVisible);

// Ctrl-drag and wheel change the composition, which lives in the avatar row —
// so the gesture writes back into the scene and travels with the link.
stage.onViewChange = (view) => {
  const item = sceneManager.avatarItem;
  if (item) sceneManager.updateItem(item.id, view);
};

sceneManager.onSelect = (item) => panel.renderInspector(item);
sceneManager.onChange = () => {
  syncAvatar();
  const encoded = sceneManager.serialize();
  emotionChannel?.postMessage({ type: 'scene', encoded });
  // BroadcastChannel only reaches tabs in this browser; the room reaches OBS's
  // separate CEF instance and every remote viewer.
  publisher?.send({ type: 'scene', encoded });
};

/** The framing mode the camera is currently solved for, to avoid re-framing. */
let framedAs: Framing | null = null;

/**
 * Pushes the avatar row onto the Stage: where it draws, how it is cropped, and
 * the operator's composition inside it.
 *
 * The scene is the single source of truth for all three. Everything that can
 * change them — dragging the grip, the inspector, a preset, an incoming scene
 * from the host — goes through the scene and arrives here.
 */
function syncAvatar(): void {
  const item = sceneManager.avatarItem;
  if (!item) return;

  // The scene positions by centre; the Stage takes a top-left corner.
  stage.setAvatarRect(
    { x: item.x - item.w / 2, y: item.y - item.h / 2, w: item.w, h: item.h },
    item.radius,
  );

  if (avatar && item.framing !== framedAs) {
    stage.frame(avatar.vrm, item.framing);
    framedAs = item.framing;
  }

  stage.setView({ panX: item.panX, panY: item.panY, zoom: item.zoom });
  panel.setFraming(item.framing);
  panel.syncCropControls();
}

// Scene load priority: URL hash (self-contained — survives into a real OBS
// browser source, which is a separate browser sharing no storage with Chrome),
// then localStorage for same-browser continuity.
{
  const hashMatch = /[#&]s=([A-Za-z0-9_-]+)/.exec(location.hash);
  const fromHash = hashMatch ? SceneManager.parseEncoded(hashMatch[1]!) : null;
  if (fromHash) sceneManager.load(fromHash);
  else sceneManager.loadFromStorage();
  applyAvatarParams();
  syncAvatar();
}

async function copySceneLink(): Promise<void> {
  const url = new URL(location.href);
  url.hash = sceneManager.isEmpty ? '' : `s=${sceneManager.serialize()}`;
  const text = url.toString();
  try {
    await navigator.clipboard.writeText(text);
    panel.setNotice(
      text.length > 8000
        ? '링크를 복사했지만 이미지 때문에 매우 깁니다 — 작은 이미지를 권합니다.'
        : '씬 링크를 복사했습니다. 이 씬이 누구에게나 그대로 열립니다.',
    );
  } catch {
    panel.showError('복사 실패 — 주소창의 URL을 직접 복사하세요.');
  }
}

// ---------------------------------------------------------------- avatar I/O

async function openFile(file: File): Promise<void> {
  try {
    panel.showError(null);
    const buffer = await file.arrayBuffer();

    // Cache before parsing: loadAvatar consumes the buffer via the glTF parser,
    // and a copy kept here is what makes the model reachable from OBS.
    await putModel(IDB_KEY, file.name, buffer.slice(0));
    modelRef = IDB_REF;

    await mount(await loadAvatar(buffer));
  } catch (error) {
    panel.showError(describe(error));
  }
}

async function openUrl(url: string): Promise<void> {
  try {
    panel.showError(null);

    if (url.startsWith('idb:')) {
      const stored = await getModel(url.slice(4));
      if (!stored) {
        panel.showError('저장된 모델이 없습니다 — 이 브라우저에서 VRM을 한 번 열어주세요.');
        return;
      }
      modelRef = url;
      await mount(await loadAvatar(stored.buffer));
      return;
    }

    // `?model=/models/foo.vrm` is the documented way to feed a model to OBS,
    // which has its own empty IndexedDB. Root-relative paths must go through the
    // deploy base or they break under a subpath host.
    modelRef = url;
    await mount(await loadAvatar(withBase(url)));
  } catch (error) {
    panel.showError(describe(error));
  }
}

async function mount(next: LoadedAvatar): Promise<void> {
  if (avatar) {
    stage.scene.remove(avatar.vrm.scene);
    VRMUtils.deepDispose(avatar.vrm.scene);
  }

  avatar = next;
  stage.scene.add(next.vrm.scene);
  // A new model invalidates the measurement, not the layout: force a re-frame,
  // then let the scene reapply rect, crop and composition on top.
  framedAs = null;
  syncAvatar();
  driver.attach(next.vrm, next.morphs, stage.scene);

  panel.setDropzoneVisible(false);
  panel.setLicense(next.license);
  panel.setCreditVisible(creditVisible);
  warnIfRestricted(next.license);

  // Auto-start in every mode, including live — this is the fix for a real OBS
  // browser source rendering a frozen avatar. `?track=0` is the opt-out.
  if (trackInThisWindow && !trackingWanted) await toggleTracking();
}

function warnIfRestricted(license: AvatarLicense): void {
  if (license.authorOnly) {
    console.info(
      '[vrm-stage] This model is marked author-only. Fine if it is yours; not redistributable.',
    );
  }
}

// ---------------------------------------------------------------- tracking

async function toggleTracking(): Promise<void> {
  if (trackingWanted) {
    trackingWanted = false;
    await source?.stop();
    source = null;
    panel.setTrackingState('off');
    return;
  }

  trackingWanted = true;
  panel.setTrackingState('starting');
  try {
    source = makeSource();
    await source.start();
    panel.setTrackingState('on');
    panel.setNotice(source.info.detail);
    panel.showError(null);
  } catch (error) {
    trackingWanted = false;
    source = null;
    panel.setTrackingState('off');
    panel.showError(`트래킹을 시작할 수 없습니다 — ${describe(error)}${cameraBusyHint(error)}`);
  }
}

/** Stops and restarts tracking, for changes that only take effect at start(). */
async function restartTracking(): Promise<void> {
  if (!trackingWanted) return;
  await toggleTracking();
  await toggleTracking();
}

function makeSource(): TrackingSource {
  if (isViewer) {
    const remote = new RemoteSource(roomSocketUrl(watchRoomId!));
    remote.onText = (raw) => applyRoomMessage(raw);
    remote.onClose = (reason) => panel.showError(reason);
    return remote;
  }
  if (sourceKind === 'vmc') return new VMCSource();
  // The third detector only spins up when something actually consumes it.
  const wantsBody = driver.body.config.torso;
  return new WebcamSource(undefined, true, wantsBody);
}

/**
 * Now that every mode auto-starts tracking, "another window already has the
 * camera" is the likeliest failure. Chrome reports it as NotReadableError or
 * TrackStartError, which on its own tells the operator nothing actionable.
 */
function cameraBusyHint(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  if (name !== 'NotReadableError' && name !== 'TrackStartError' && name !== 'AbortError') return '';
  return (
    '\n다른 창이 카메라를 쓰고 있는 것 같습니다. ' +
    '한쪽에서 「이 창에서 트래킹 실행」을 끄거나 URL에 track=0을 붙이세요.'
  );
}

// ---------------------------------------------------------------- broadcast room

/**
 * Applies room traffic on a viewer.
 *
 * Poses arrive as binary and are handled by `RemoteSource`; this is everything
 * else — the scene, the host's expression, and which model to load. `state` is
 * the snapshot a late joiner gets on connect so it renders immediately instead of
 * waiting for the host to next change something.
 */
function applyRoomMessage(raw: string): void {
  const message = parseRoomMessage(raw);
  if (!message) return;

  switch (message.type) {
    case 'scene':
      loadEncodedScene(message.encoded);
      break;
    case 'emotion':
      driver.forceEmotion(message.name);
      panel.setActiveEmotion(message.name);
      break;
    case 'model':
      loadRoomModel(message.url);
      break;
    case 'config':
      applyPerformConfig(message.config);
      break;
    case 'state':
      // Config before model: mount() frames using `framing`, so adopting it
      // first avoids a visible re-frame on load.
      applyPerformConfig(message.config);
      if (message.scene) loadEncodedScene(message.scene);
      driver.forceEmotion(message.emotion);
      panel.setActiveEmotion(message.emotion);
      loadRoomModel(message.model);
      break;
    case 'ended':
      // The host stopped and the model is gone; hold the last pose rather than
      // snapping to neutral, and stop pretending to receive a performance.
      panel.setNotice('방송이 종료되었습니다.');
      void source?.stop();
      break;
    case 'error':
      panel.showError(message.message);
      break;
    default:
      break;
  }
}

/**
 * Adopts a scene that arrived from elsewhere — the host's room, or another tab.
 *
 * `load` deliberately does not emit (loading is not editing, and echoing it back
 * to the host would be a feedback loop), so the sync the emit would have done
 * has to happen here. Without it a viewer renders the host's overlays at the
 * host's positions but keeps the avatar full-frame.
 */
function loadEncodedScene(encoded: string): void {
  const spec = SceneManager.parseEncoded(encoded);
  if (!spec) return;
  sceneManager.load(spec);
  syncAvatar();
}

function loadRoomModel(url: string | null): void {
  if (!url || url === modelRef) return;
  void openUrl(url);
}

/** Keys a viewer will copy from a host's config. Anything else on the wire is ignored. */
const DRIVER_KEYS = [
  'mirror',
  'invertPitch',
  'invertYaw',
  'invertRoll',
  'headGain',
  'pitchOffset',
  'yawOffset',
  'rollOffset',
  'neckShare',
  'brows',
  'gaze',
  'invertGaze',
] as const;
const HAND_KEYS = [
  'fingers',
  'arms',
  'armReach',
  'invertCurl',
  'wrist',
  'invertArmY',
  'invertArmZ',
  'invertArmX',
] as const;
const BODY_KEYS = ['torso', 'gain', 'invertSway'] as const;

function performConfig(): PerformConfig {
  const driverConfig: Record<string, number | boolean> = {};
  for (const key of DRIVER_KEYS) driverConfig[key] = config[key];

  const handConfig: Record<string, number | boolean> = {};
  for (const key of HAND_KEYS) handConfig[key] = driver.hands.config[key];

  const bodyConfig: Record<string, number | boolean> = {};
  for (const key of BODY_KEYS) bodyConfig[key] = driver.body.config[key];

  return {
    driver: driverConfig,
    hands: handConfig,
    body: bodyConfig,
  };
}

/**
 * Adopts the host's presentation settings.
 *
 * Applied in memory only — never persisted, or a viewer's own calibration would
 * be overwritten by whoever they last watched.
 */
function applyPerformConfig(incoming: unknown): void {
  if (typeof incoming !== 'object' || incoming === null) return;
  const source = incoming as Partial<PerformConfig>;

  if (source.driver && typeof source.driver === 'object') {
    for (const key of DRIVER_KEYS) {
      const value = source.driver[key];
      if (typeof config[key] === 'boolean' && typeof value === 'boolean') {
        (config[key] as boolean) = value;
      } else if (typeof config[key] === 'number' && typeof value === 'number') {
        if (Number.isFinite(value)) (config[key] as number) = value;
      }
    }
  }

  if (source.hands && typeof source.hands === 'object') {
    for (const key of HAND_KEYS) {
      const value = source.hands[key];
      const current = driver.hands.config[key];
      if (typeof current === 'boolean' && typeof value === 'boolean') {
        (driver.hands.config[key] as boolean) = value;
      } else if (typeof current === 'number' && typeof value === 'number') {
        if (Number.isFinite(value)) (driver.hands.config[key] as number) = value;
      }
    }
  }

  if (source.body && typeof source.body === 'object') {
    for (const key of BODY_KEYS) {
      const value = source.body[key];
      const current = driver.body.config[key];
      if (typeof current === 'boolean' && typeof value === 'boolean') {
        (driver.body.config[key] as boolean) = value;
      } else if (typeof current === 'number' && typeof value === 'number') {
        if (Number.isFinite(value)) (driver.body.config[key] as number) = value;
      }
    }
  }

  // Framing and composition are deliberately absent: they live in the avatar
  // row, so they arrive with the scene instead. That is the better channel —
  // the room retains the scene for late joiners, but not the config.

  driver.resetFilters();
}

/**
 * Sends the host's settings, coalesced.
 *
 * Slider drags fire per input event; without this a single adjustment would emit
 * dozens of messages.
 */
let configSendTimer: number | null = null;
function scheduleConfigBroadcast(): void {
  if (!publisher || configSendTimer !== null) return;
  configSendTimer = window.setTimeout(() => {
    configSendTimer = null;
    publisher?.send({ type: 'config', config: performConfig() });
  }, 150);
}

/**
 * Starts broadcasting: mints a room, puts the model where viewers can fetch it,
 * and begins publishing frames.
 *
 * The model upload is unavoidable — viewers render locally, so they need the
 * file. It is also why the viewer link needs no `model` parameter: the room
 * retains the URL and hands it to every joiner.
 */
async function startBroadcast(): Promise<void> {
  try {
    panel.showError(null);
    panel.setNotice('방을 만들고 있습니다…');

    const credentials = room ?? (await createRoom());
    room = credentials;
    storeRoom(credentials);

    publisher = new RoomPublisher(credentials.roomId, credentials.hostKey);
    publisher.onViewers = (count) => panel.setViewers(count);
    publisher.onClose = (reason) => {
      publisher = null;
      panel.setRoom(null, 0);
      panel.showError(reason);
    };
    await publisher.start();

    // Settings first: viewers decode uncorrected frames, so without these the
    // avatar sits at a different angle than the host sees.
    publisher.send({ type: 'config', config: performConfig() });

    const modelUrl = await ensureModelPublished();
    if (modelUrl) publisher.send({ type: 'model', url: modelUrl });
    if (!sceneManager.isEmpty) {
      publisher.send({ type: 'scene', encoded: sceneManager.serialize() });
    }

    panel.setRoom(credentials.roomId, publisher.viewers);
    panel.setNotice('방송 중입니다. 시청 링크를 복사해 OBS와 시청자에게 쓰세요.');
  } catch (error) {
    publisher = null;
    panel.setRoom(null, 0);
    panel.showError(`방송을 시작할 수 없습니다 — ${describe(error)}`);
  }
}

async function stopBroadcast(): Promise<void> {
  publisher?.stop();
  publisher = null;
  panel.setRoom(null, 0);

  try {
    // Deletes the uploaded model server-side. Rooms are ephemeral, and an
    // author-only avatar should stop being fetchable once it stops being needed.
    if (room && uploadedModel) await endBroadcast(room);
    uploadedModel = null;
    panel.setNotice('방송을 멈추고 올렸던 모델을 지웠습니다.');
  } catch (error) {
    panel.showError(`방송은 멈췄지만 모델 삭제에 실패했습니다 — ${describe(error)}`);
  }
}

/**
 * The model URL we uploaded for viewers, if any.
 *
 * Tracked separately from `modelRef` for two reasons: we must only ever delete a
 * file we put there ourselves, and after a delete the URL is dead — so a restart
 * has to upload again rather than hand viewers a 404.
 */
let uploadedModel: string | null = null;

/** Makes the current model fetchable by viewers, who render it locally. */
async function ensureModelPublished(): Promise<string | null> {
  if (uploadedModel) return uploadedModel;

  // A host-provided URL is already reachable and is not ours to delete later.
  if (modelRef && !modelRef.startsWith('idb:')) return modelRef;

  const stored = await getModel(IDB_KEY);
  if (!stored) return null;

  panel.setNotice('시청자가 받을 모델을 올리는 중…');
  uploadedModel = await uploadModel(stored.name.replace(/\.vrm$/i, ''), stored.buffer);
  return uploadedModel;
}

/** OBS and remote viewers use the identical link: both are room subscribers. */
async function copyWatchLink(): Promise<void> {
  if (!room) {
    panel.showError('먼저 방송을 시작하세요.');
    return;
  }

  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('mode', 'live');
  url.searchParams.set('source', 'remote');
  url.searchParams.set('room', room.roomId);
  if (!creditVisible) url.searchParams.set('credit', '0');

  const text = url.toString();
  try {
    await navigator.clipboard.writeText(text);
    panel.setNotice('시청 링크를 복사했습니다. OBS 브라우저 소스에도 이 링크를 씁니다.');
  } catch {
    panel.showError(`복사 실패 — 직접 사용하세요: ${text}`);
  }
}

// ---------------------------------------------------------------- live output

async function copyLiveUrl(): Promise<void> {
  const url = new URL(location.href);
  url.search = '';
  url.searchParams.set('mode', 'live');
  url.searchParams.set('source', sourceKind);
  if (modelRef) url.searchParams.set('model', modelRef);
  if (!creditVisible) url.searchParams.set('credit', '0');

  // If this window owns the camera, the live one must not fight it for the
  // device — and vice versa.
  if (!trackInThisWindow) url.searchParams.set('track', '0');

  // Calibration is per-seat, so it has to travel with the URL or the OBS view
  // reverts to the raised-chin pose the operator just corrected.
  if (config.pitchOffset) url.searchParams.set('pitch', config.pitchOffset.toFixed(4));
  if (config.yawOffset) url.searchParams.set('yaw', config.yawOffset.toFixed(4));
  if (config.rollOffset) url.searchParams.set('roll', config.rollOffset.toFixed(4));

  // Framing and the hand-composed view are NOT query params any more — they are
  // in the avatar row of the scene below, so there is one copy rather than two
  // that can disagree.

  // The scene rides along in the hash so a real OBS browser source — a separate
  // browser with none of our storage — reproduces it from the URL alone.
  if (!sceneManager.isEmpty) url.hash = `s=${sceneManager.serialize()}`;

  const text = url.toString();
  try {
    await navigator.clipboard.writeText(text);
    panel.setNotice(
      modelRef
        ? 'URL을 복사했습니다. OBS 브라우저 소스에 붙여넣으세요.'
        : 'URL을 복사했지만 모델이 없습니다 — VRM을 먼저 여세요.',
    );
    panel.showError(null);
  } catch {
    panel.showError(`복사 실패 — 직접 사용하세요: ${text}`);
  }
}

// ---------------------------------------------------------------- emotions

/**
 * The editor tab and the OBS browser source are separate page instances, so a
 * hotkey pressed here would never reach the stream without this channel. Every
 * same-origin instance hears the change and mirrors it.
 */
const emotionChannel = 'BroadcastChannel' in window ? new BroadcastChannel('vrm-stage') : null;

if (emotionChannel) {
  emotionChannel.onmessage = (event: MessageEvent) => {
    const data = event.data as { type?: string; name?: string | null; encoded?: string };
    if (data?.type === 'emotion') {
      driver.forceEmotion(data.name ?? null);
      panel.setActiveEmotion(data.name ?? null);
    } else if (data?.type === 'scene' && typeof data.encoded === 'string') {
      // Live scene edits from the editor tab. load() does not emit, so this
      // cannot echo back and loop.
      loadEncodedScene(data.encoded);
    }
  };
}

function chooseEmotion(name: string | null): void {
  const resolved = driver.toggleEmotion(name);
  panel.setActiveEmotion(resolved);
  emotionChannel?.postMessage({ type: 'emotion', name: resolved });
  publisher?.send({ type: 'emotion', name: resolved });
}

window.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement | null;
  if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;

  // Scene selection owns Delete, and owns Escape while something is selected.
  const selected = sceneManager.selected;
  if (selected && event.key === 'Delete') {
    sceneManager.removeItem(selected.id);
    return;
  }
  if (selected && event.key === 'Escape') {
    sceneManager.select(null);
    return;
  }

  const index = '123456'.indexOf(event.key);
  if (index >= 0) {
    chooseEmotion(EMOTIONS[index]![0]);
  } else if (event.key === '0' || event.key === 'Escape') {
    chooseEmotion(null);
  }
});

// ---------------------------------------------------------------- drag & drop

window.addEventListener('dragover', (event) => {
  event.preventDefault();
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', () => document.body.classList.remove('dragging'));
window.addEventListener('drop', (event) => {
  event.preventDefault();
  document.body.classList.remove('dragging');
  const file = event.dataTransfer?.files?.[0];
  if (file) void openFile(file);
});

// ---------------------------------------------------------------- render loop

let debugAccumulator = 0;

function animate(): void {
  requestAnimationFrame(animate);

  const delta = stage.tick();
  const vrm: VRM | undefined = avatar?.vrm;
  const frame = debugFrame ?? source?.read() ?? null;

  if (vrm) {
    // Spring bones need every frame even when tracking is off, otherwise hair
    // freezes mid-swing the moment the camera stops.
    driver.update(vrm, frame, delta);
  }

  // Publishes only new captures — `read()` repeats the same frame between them.
  publisher?.publish(frame);

  stage.render();

  debugAccumulator += delta;
  if (debugAccumulator > 0.1) {
    debugAccumulator = 0;
    panel.setDebug(driver.debug);
  }
}

animate();

/*
 * Rig sign regression test. Axis signs have been the single largest source of
 * churn here, so the check that catches them lives in the repo rather than in
 * whoever last debugged it: see `src/dev/rigProbe.ts`.
 *
 * Dev-only in both senses — the import is stripped from production builds, and
 * the fixtures it loads are served only by the dev middleware.
 */
if (import.meta.env.DEV && params.get('selftest') === '1') {
  void (async () => {
    const { runRigProbe, renderRigProbe } = await import('./dev/rigProbe');
    panel.setNotice('리그 부호 회귀 테스트 실행 중… (모델 2개 로드)');
    try {
      renderRigProbe(await runRigProbe(), uiRoot);
    } catch (error) {
      panel.showError(`셀프테스트 실패 — ${describe(error)}`);
    }
  })();
}

// Test seam: lets an automated session (or a curious person in devtools) inject
// PoseFrames and inspect the result numerically. Dev builds only.
if (import.meta.env.DEV) {
  Object.defineProperty(window, '__stage', {
    value: {
      stage,
      driver,
      get avatar() {
        return avatar;
      },
      /**
       * The live tracking source. Exposed because `driver.debug` only advances
       * inside the render loop, so a headless check cannot tell "no frames
       * arriving" from "no frames being rendered" without reading the source.
       */
      get source() {
        return source;
      },
      get publisher() {
        return publisher;
      },
      setDebugFrame(frame: PoseFrame | null) {
        debugFrame = frame;
      },
      scene: sceneManager,
    },
  });
}

// ---------------------------------------------------------------- startup

applyCalibrationParams();

// Reusing the stored room keeps hostship across reloads instead of orphaning
// viewers on a room nobody publishes to any more.
room = loadStoredRoom();

const modelParam = params.get('model');
if (isViewer) {
  // A viewer must connect BEFORE it has a model: the room is what tells it which
  // model to load. Waiting for `mount()` to start tracking would deadlock, since
  // mount needs a model that only the room can name.
  void toggleTracking();
  if (modelParam) void openUrl(modelParam);
} else if (modelParam) {
  void openUrl(modelParam);
} else if (mode === 'live') {
  // A live URL without a model is almost always a stale copy; fall back to
  // whatever this browser last loaded rather than rendering nothing.
  void openUrl(IDB_REF);
}

const CALIBRATION_KEY = 'vrm-stage:calibration';

/**
 * Calibration is per-seat and survives reloads: URL params win (an OBS source
 * must render exactly what was copied), otherwise the last local calibration is
 * restored so the editor does not reset to a raised chin on every refresh.
 */
function applyCalibrationParams(): void {
  // A viewer must NOT apply its own saved calibration — that would correct a
  // stranger's face with numbers measured for this machine's webcam. The host's
  // settings arrive over the room instead.
  if (isViewer) return;

  const stored = readStoredCalibration();
  if (stored) Object.assign(config, stored);

  for (const [param, key] of [
    ['pitch', 'pitchOffset'],
    ['yaw', 'yawOffset'],
    ['roll', 'rollOffset'],
  ] as const) {
    const raw = params.get(param);
    if (raw === null) continue;
    const value = Number(raw);
    if (Number.isFinite(value)) config[key] = value;
  }
  panel.syncSliders();
}

/**
 * Applies the legacy `?framing/px/py/zoom` params over the loaded scene.
 *
 * These used to be the only home for composition; now the avatar row owns it.
 * They are still READ, so links copied before that change still open the way
 * they were arranged — but they are no longer WRITTEN, so there is exactly one
 * place a reader has to look, and no way for the hash and the query string to
 * disagree about framing.
 *
 * Patched directly rather than through `updateItem` because this runs during
 * startup, before there is anything to broadcast to.
 */
function applyAvatarParams(): void {
  const item = sceneManager.avatarItem;
  if (!item) return;

  const framing = params.get('framing');
  if (framing === 'bust' || framing === 'head' || framing === 'full') {
    item.framing = framing;
  }

  const numbers: [string, 'panX' | 'panY' | 'zoom'][] = [
    ['px', 'panX'],
    ['py', 'panY'],
    ['zoom', 'zoom'],
  ];
  for (const [param, key] of numbers) {
    const raw = params.get(param);
    if (raw === null) continue;
    const value = Number(raw);
    if (Number.isFinite(value) && (key !== 'zoom' || value > 0)) item[key] = value;
  }
}

function readStoredCalibration(): Partial<DriverConfig> | null {
  try {
    const raw = localStorage.getItem(CALIBRATION_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;

    const result: Partial<DriverConfig> = {};
    for (const key of ['pitchOffset', 'yawOffset', 'rollOffset'] as const) {
      const value = (parsed as Record<string, unknown>)[key];
      if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
    }
    return result;
  } catch {
    return null;
  }
}

function saveCalibration(): void {
  try {
    localStorage.setItem(
      CALIBRATION_KEY,
      JSON.stringify({
        pitchOffset: config.pitchOffset,
        yawOffset: config.yawOffset,
        rollOffset: config.rollOffset,
      }),
    );
  } catch {
    // Private browsing or a full quota — calibration just will not persist.
  }
}

// ---------------------------------------------------------------- helpers

function must<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Missing required element: ${selector}`);
  return node;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
