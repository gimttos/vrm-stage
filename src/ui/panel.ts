import { withBase } from '../basePath';
import type { AvatarLicense } from '../stage/AvatarLoader';
import type { DriverConfig, DriverDebug } from '../driver/AvatarDriver';
import type { BodyRigConfig } from '../driver/bodyRig';
import type { HandRigConfig } from '../driver/handRig';
import type { AppMode } from '../mode';
import type { SceneManager } from '../scene/SceneManager';
import type { SceneItem, SceneSpec } from '../scene/sceneTypes';
import { PRESETS } from '../scene/presets';
import type { Framing } from '../stage/Stage';

/**
 * `on` means frames are actually landing on the avatar. `searching` means the
 * camera opened but nothing is being detected.
 *
 * The distinction is the whole point: the status used to flip to "추적 중" the
 * moment `start()` resolved, which only proves the camera opened and the models
 * loaded. A silent detector failure then looked identical to working tracking —
 * a live status over a motionless avatar, with nothing to tell them apart.
 */
export type TrackingState = 'off' | 'starting' | 'on' | 'searching';

type NumericKey = 'headGain' | 'neckShare' | 'pitchOffset' | 'yawOffset' | 'rollOffset';
type BooleanKey =
  | 'mirror'
  | 'invertPitch'
  | 'invertYaw'
  | 'invertRoll'
  | 'brows'
  | 'gaze'
  | 'invertGaze';

export interface PanelCallbacks {
  onPickFile(): void;
  onLoadFixture(path: string): void;
  onToggleTracking(): void;
  onConfigChange(patch: Partial<DriverConfig>): void;
  onFramingChange(framing: Framing): void;
  onCopyLiveUrl(): void;
  onCalibrate(): void;
  onResetCalibration(): void;
  onCreditVisibilityChange(visible: boolean): void;
  onSourceChange(kind: string): void;
  onHandConfigChange(patch: Partial<HandRigConfig>): void;
  onBodyConfigChange(patch: Partial<BodyRigConfig>): void;
  onResetView(): void;
  onCropModeChange(on: boolean): void;
  onApplyPreset(id: string): void;
  onEmotion(name: string): void;
  onCopySceneLink(): void;
  onTrackInThisWindowChange(enabled: boolean): void;
  onStartBroadcast(): void;
  onStopBroadcast(): void;
  onCopyWatchLink(): void;
}

/** Preset emotions, in hotkey order (1–6). */
export const EMOTIONS: [string, string][] = [
  ['neutral', '무표정'],
  ['happy', '기쁨'],
  ['angry', '화남'],
  ['sad', '슬픔'],
  ['relaxed', '편안'],
  ['surprised', '놀람'],
];

export interface PanelInitialState {
  creditVisible: boolean;
  sourceKind: string;
  mode: AppMode;
  trackInThisWindow: boolean;
}

/**
 * Which tabs each mode gets. One builder per tab, called from either set.
 *
 * Everything except the numeric debug grid is shared. The split was originally
 * sharper — hands lived only in `rig`, on the theory that finger and arm tuning
 * is one-time setup — but that reasoning was wrong in practice: 「손목 회전」 is a
 * toggle you reach for mid-session when a wrist looks twisted, and having to
 * change modes to find it is exactly the friction the tabs were meant to remove.
 *
 * Only `디버그` stays rig-only, because a live numbers readout genuinely is a
 * diagnostic surface rather than a control.
 */
const TAB_SETS: Record<AppMode, string[]> = {
  studio: ['씬', '크롭', '아바타', '트래킹', '손', '보정', '출력'],
  rig: ['트래킹', '손', '보정', '디버그', '아바타'],
  // The panel is hidden by CSS in live mode; the set only needs to be valid.
  live: ['씬', '크롭', '아바타', '트래킹', '손', '보정', '출력'],
};

export class Panel {
  private readonly dropzone: HTMLElement;
  private readonly licenseBox: HTMLElement;
  private readonly errorBox: HTMLElement;
  private readonly noticeBox: HTMLElement;
  private readonly trackButton: HTMLButtonElement;
  private readonly statusDot: HTMLElement;
  private readonly statusText: HTMLElement;
  private readonly debugCells = new Map<string, HTMLElement>();
  private readonly emotionChips = new Map<string, HTMLButtonElement>();
  private readonly tabPanes = new Map<string, HTMLElement>();
  private readonly tabButtons = new Map<string, HTMLButtonElement>();
  private inspector: HTMLElement | null = null;
  private bgColorInput: HTMLInputElement | null = null;
  private broadcastButton: HTMLButtonElement | null = null;
  private watchLinkButton: HTMLButtonElement | null = null;
  private roomStatus: HTMLElement | null = null;
  private readonly sliders = new Map<NumericKey, { input: HTMLInputElement; readout: HTMLElement }>();

  constructor(
    root: HTMLElement,
    private readonly config: DriverConfig,
    private readonly callbacks: PanelCallbacks,
    private readonly handConfig: HandRigConfig,
    private readonly bodyConfig: BodyRigConfig,
    private readonly sceneApi: SceneManager,
    private readonly initial: PanelInitialState,
  ) {
    root.innerHTML = '';

    this.dropzone = this.buildDropzone();

    this.statusDot = el('span', 'dot');
    this.statusText = el('span', '', ['정지']);
    this.trackButton = button('트래킹 시작', 'primary wide', () =>
      this.callbacks.onToggleTracking(),
    );

    this.licenseBox = el('div', 'license');
    this.errorBox = el('div', 'error hidden');
    // Lives outside the tabs: a notice fired from a callback must be readable
    // whichever tab happens to be open.
    this.noticeBox = el('p', 'notice');

    const builders: Record<string, () => HTMLElement> = {
      아바타: () => this.avatarTab(),
      크롭: () => this.cropTab(),
      트래킹: () => this.trackingTab(),
      손: () => this.handsTab(),
      보정: () => this.calibrationTab(),
      씬: () => this.sceneTab(),
      출력: () => this.outputTab(),
      디버그: () => this.debugTab(),
    };

    const names = TAB_SETS[initial.mode];
    const strip = el('div', 'tabs');
    const body = el('div', 'tab-body');

    for (const name of names) {
      const pane = builders[name]!();
      pane.classList.add('tab-pane');
      this.tabPanes.set(name, pane);
      body.append(pane);

      const tab = button(name, 'tab', () => this.showTab(name));
      this.tabButtons.set(name, tab);
      strip.append(tab);
    }

    const panel = el('div', 'panel', [
      el('h1', '', ['VRM Stage']),
      el('p', 'tagline', [
        initial.mode === 'rig' ? '리깅 벤치 — 트래킹 조정' : '아바타가 들어있는 방송 화면',
      ]),
      strip,
      body,
      this.emotionFooter(),
      this.noticeBox,
    ]);

    this.showTab(names[0]!);

    root.append(this.dropzone, panel, this.licenseBox, this.errorBox);
  }

  // ------------------------------------------------------------------- tabs

  private showTab(name: string): void {
    for (const [key, pane] of this.tabPanes) pane.classList.toggle('on', key === name);
    for (const [key, tab] of this.tabButtons) tab.classList.toggle('on', key === name);
  }

  private buildDropzone(): HTMLElement {
    const actions = el('div', 'actions');
    actions.append(button('파일 선택', 'primary', () => this.callbacks.onPickFile()));
    // The fixture models are licensed author-only / no-redistribution, so they
    // exist ONLY in local dev — they are not in the build and these buttons follow.
    if (import.meta.env.DEV) {
      actions.append(
        button('tttt.vrm (1.0)', '', () =>
          this.callbacks.onLoadFixture(withBase('/fixtures/tttt.vrm')),
        ),
        button('reee.vrm (0.x)', '', () =>
          this.callbacks.onLoadFixture(withBase('/fixtures/reee.vrm')),
        ),
      );
    }

    return el('div', 'dropzone', [
      el('div', 'big', ['VRM을 여기에 놓으세요']),
      el('div', 'sub', [
        '업로드되지 않습니다 — 파일은 브라우저 안에서만 열립니다. ',
        'VRM 0.x와 1.0 모두 지원합니다.',
      ]),
      actions,
    ]);
  }

  private emotionFooter(): HTMLElement {
    const chips = el('div', 'chips');
    EMOTIONS.forEach(([name, text], index) => {
      const chip = button(`${index + 1} ${text}`, '', () => this.callbacks.onEmotion(name));
      chip.dataset['emotion'] = name;
      chips.append(chip);
      this.emotionChips.set(name, chip);
    });
    return el('div', 'footer', [chips]);
  }

  /** The framing control, kept so an incoming scene can move it. */
  private framingSelect: HTMLSelectElement | null = null;

  /** Reflects the scene's framing, which a shared link can set. */
  setFraming(framing: Framing): void {
    if (this.framingSelect) this.framingSelect.value = framing;
  }

  private framingRow(): HTMLElement {
    const framing = select(
      [
        ['bust', '흉상'],
        ['head', '얼굴'],
        ['full', '전신'],
      ],
      'bust',
      (value) => this.callbacks.onFramingChange(value as Framing),
    );
    this.framingSelect = framing as HTMLSelectElement;
    return row([label('프레이밍'), framing]);
  }

  private avatarTab(): HTMLElement {
    const rows = [row([button('VRM 열기', 'wide', () => this.callbacks.onPickFile())])];
    // In the compositor these live in the 크롭 tab, so that "how the avatar sits
    // in the frame" has exactly one home. The rig bench has no crop tab — it
    // always renders the avatar full-frame — so it keeps them here.
    if (this.initial.mode === 'rig') {
      rows.push(
        this.framingRow(),
        row([button('시야 초기화', 'wide', () => this.callbacks.onResetView())]),
        el('p', 'hint', ['Ctrl + 드래그로 위치 이동, 휠로 확대·축소.']),
      );
    }
    return el('div', '', rows);
  }

  /**
   * Crop: where the avatar sits in the broadcast frame, and how much of it shows.
   *
   * Everything here used to be in three places — width and height in the scene
   * inspector, framing in the 아바타 tab, pan and zoom on an undiscoverable
   * Ctrl-drag. One visual result, three homes, and the shape of the rectangle
   * expressed as numbers. Now the rectangle is drawn by hand and this tab holds
   * only what a drag cannot express.
   */
  private cropTab(): HTMLElement {
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    const toggleLabel = el('label', 'toggle');
    toggleLabel.append(toggle, document.createTextNode('크롭 모드'));

    const hint = el('p', 'hint', ['']);
    const setHint = () => {
      hint.textContent = toggle.checked
        ? '빈 곳을 드래그해 영역을 그리고, 안쪽을 잡아 옮기고, 모서리로 크기를 바꿉니다. Ctrl + 드래그와 휠은 사각형 안에서 아바타의 구도를 잡습니다.'
        : '크롭 모드를 켜면 화면에서 직접 아바타 영역을 그릴 수 있습니다.';
    };
    toggle.addEventListener('change', () => {
      this.callbacks.onCropModeChange(toggle.checked);
      setHint();
    });
    setHint();

    const radius = document.createElement('input');
    radius.type = 'range';
    radius.min = '0';
    radius.max = '50';
    radius.value = '0';
    radius.addEventListener('input', () => this.patchAvatar({ radius: Number(radius.value) }));
    this.radiusInput = radius;

    const plateOn = document.createElement('input');
    plateOn.type = 'checkbox';
    const plateColor = document.createElement('input');
    plateColor.type = 'color';
    plateColor.value = '#101018';
    const applyPlate = () =>
      this.patchAvatar({ plate: plateOn.checked ? plateColor.value : null });
    plateOn.addEventListener('change', applyPlate);
    plateColor.addEventListener('input', applyPlate);
    const plateLabel = el('label', 'toggle');
    plateLabel.append(plateOn, document.createTextNode('배경판'));
    this.plateInputs = { on: plateOn, color: plateColor };

    // Says what the avatar's rectangle actually is right now. A crop is easy to
    // create by accident — in crop mode a forgotten Ctrl turns a camera pan into
    // a new rectangle — and from then on the avatar sits small in a corner,
    // which reads as "the avatar broke", not "I cropped it".
    const state = el('p', 'hint', ['']);
    this.cropState = state;

    return el('div', '', [
      row([toggleLabel]),
      hint,
      state,
      row([button('전체 화면으로', 'wide', () => this.sceneApi.resetCrop())]),
      this.framingRow(),
      row([label('모서리'), radius]),
      row([plateLabel, plateColor]),
      row([button('구도 초기화', 'wide', () => this.callbacks.onResetView())]),
    ]);
  }

  private cropState: HTMLElement | null = null;

  private radiusInput: HTMLInputElement | null = null;
  private plateInputs: { on: HTMLInputElement; color: HTMLInputElement } | null = null;

  private patchAvatar(patch: Record<string, unknown>): void {
    const item = this.sceneApi.avatarItem;
    if (item) this.sceneApi.updateItem(item.id, patch);
  }

  /** Reflects avatar values a shared link or a preset can set. */
  syncCropControls(): void {
    const item = this.sceneApi.avatarItem;
    if (!item) return;
    if (this.radiusInput) this.radiusInput.value = String(item.radius);
    if (this.plateInputs) {
      this.plateInputs.on.checked = item.plate !== null;
      if (item.plate !== null) this.plateInputs.color.value = item.plate;
    }
    if (this.cropState) {
      const full = item.w >= 99 && item.h >= 99;
      this.cropState.textContent = full
        ? '지금: 전체 화면 (크롭 없음)'
        : `지금: 화면의 ${Math.round(item.w)}% × ${Math.round(item.h)}% 로 잘려 있습니다.`;
    }
  }

  private trackingTab(): HTMLElement {
    const trackHere = document.createElement('input');
    trackHere.type = 'checkbox';
    trackHere.checked = this.initial.trackInThisWindow;
    trackHere.addEventListener('change', () =>
      this.callbacks.onTrackInThisWindowChange(trackHere.checked),
    );
    const trackHereLabel = el('label', 'toggle');
    trackHereLabel.append(trackHere, document.createTextNode('이 창에서 트래킹 실행'));

    return el('div', '', [
      row([
        label('입력'),
        select(
          [
            ['webcam', '웹캠'],
            ['vmc', 'VMC'],
          ],
          this.initial.sourceKind,
          (value) => this.callbacks.onSourceChange(value),
        ),
      ]),
      row([this.trackButton]),
      row([
        label('상태'),
        (() => {
          const status = el('span', 'status');
          status.append(this.statusDot, this.statusText);
          return status;
        })(),
      ]),
      row([trackHereLabel]),
      el('p', 'hint', [
        '카메라는 한 번에 한 창만 쓸 수 있습니다. 편집 탭과 OBS 소스를 함께 열어둘 때는 ' +
          '한쪽을 끄세요 — 끄면 복사되는 라이브 URL에 track=0으로 따라갑니다.',
      ]),
      this.toggle('좌우 미러', 'mirror'),
      this.toggle('눈썹 구동 (BRW 모프)', 'brows'),
      this.toggle('시선 추적', 'gaze'),
      this.toggle('시선 반전', 'invertGaze'),
    ]);
  }

  private handsTab(): HTMLElement {
    return el('div', '', [
      this.handToggle('손가락 트래킹', 'fingers'),
      this.handToggle('팔이 손을 따라감', 'arms'),
      this.handToggle('손목 회전', 'wrist'),
      this.handSlider('팔 이동 범위', 'armReach', 0.4, 2, 0.05),
      this.handToggle('손가락 굽힘 반전', 'invertCurl'),
      this.handToggle('팔 상하 반전', 'invertArmY'),
      this.handToggle('팔 앞뒤 반전', 'invertArmZ'),
      this.handToggle('팔 좌우 반전', 'invertArmX'),
      el('h2', '', ['상체']),
      this.bodyToggle('상체 흔들림', 'torso'),
      this.bodyToggle('상체 좌우 반전', 'invertSway'),
      this.bodySlider('상체 강도', 'gain', 0.2, 2.5, 0.05),
      el('p', 'hint', [
        '상체를 좌우로 흔들면 아바타 상체가 따라 흔들립니다. 세 번째 검출기' +
          '(PoseLandmarker)를 돌리므로 GPU 비용이 더 듭니다. 느리게 적응하는 기준선 ' +
          '대비로 측정하므로 앉은 자세를 바꿔도 몇 초 뒤에는 그 자세가 새 기준이 됩니다. ' +
          '어깨 자체는 움직이지 않습니다 — 으쓱이는 동작은 위축된 몸짓으로 읽혀서 뺐습니다.',
      ]),
      el('p', 'hint', [
        '팔은 폴 벡터 2본 IK — 팔꿈치는 항상 아래·바깥쪽 평면에서 접히므로 ' +
          '어깨가 등 뒤로 꺾일 수 없습니다. 손목이 이상하게 돌아가면 손목 회전을 끄세요. ' +
          'VMC 입력일 때는 보내는 쪽 리그를 쓰므로 이 항목은 적용되지 않습니다.',
      ]),
    ]);
  }

  private calibrationTab(): HTMLElement {
    return el('div', '', [
      el('h2', '', ['중립 자세']),
      row([button('지금 자세를 정면으로', 'primary wide', () => this.callbacks.onCalibrate())]),
      row([button('보정 초기화', 'wide', () => this.callbacks.onResetCalibration())]),
      this.slider('Pitch 미세조정', 'pitchOffset', -35, 35, 0.5, 'deg'),
      this.slider('Yaw 미세조정', 'yawOffset', -35, 35, 0.5, 'deg'),
      el('p', 'hint', [
        '웹캠이 눈높이보다 낮으면 얼굴을 아래에서 올려다보게 되어 고개가 계속 들립니다. ' +
          '앉은키가 클수록 심해집니다. 편한 자세로 정면을 본 뒤 위 버튼을 누르면 그 자세가 0이 됩니다.',
      ]),
      el('h2', '', ['축 보정']),
      this.toggle('Pitch 반전', 'invertPitch'),
      this.toggle('Yaw 반전', 'invertYaw'),
      this.toggle('Roll 반전', 'invertRoll'),
      this.slider('머리 강도', 'headGain', 0.4, 2.2, 0.05),
      this.slider('목 분배', 'neckShare', 0, 0.8, 0.05),
    ]);
  }

  /**
   * Preset buttons, each showing a diagram of the layout it applies.
   *
   * The thumbnail is drawn FROM THE SPEC — every rect item becomes a rect in an
   * SVG with the same x/y/w/h. So it cannot drift from what applying actually
   * does, and adding a preset never means drawing a picture. A real mini render
   * would need a second WebGL context per tile to show the one thing the diagram
   * already conveys: where the avatar sits.
   */
  private presetGrid(): HTMLElement {
    const grid = el('div', 'presets');
    for (const preset of PRESETS) {
      const tile = document.createElement('button');
      tile.className = 'preset';
      tile.title = preset.note;
      tile.append(
        presetThumbnail(preset.build()),
        el('span', 'preset-name', [preset.name]),
      );
      tile.addEventListener('click', () => this.callbacks.onApplyPreset(preset.id));
      grid.append(tile);
    }
    return grid;
  }

  private sceneTab(): HTMLElement {
    this.bgColorInput = document.createElement('input');
    this.bgColorInput.type = 'color';
    this.bgColorInput.value = '#14121c';
    this.bgColorInput.addEventListener('input', () => {
      this.sceneApi.setBackground({ type: 'color', color: this.bgColorInput!.value });
    });
    this.bgColorInput.style.display = 'none';

    return el('div', '', [
      el('h2', '', ['프리셋']),
      this.presetGrid(),
      el('p', 'hint', ['적용하면 지금 씬을 덮어씁니다. 배경·오버레이·아바타 위치가 모두 바뀝니다.']),
      el('h2', '', ['직접 꾸미기']),
      row([
        label('배경'),
        select(
          [
            ['none', '투명'],
            ['color', '색상'],
            ['image', '이미지'],
          ],
          'none',
          (value) => this.onBackgroundKind(value),
        ),
      ]),
      row([label('배경색'), this.bgColorInput]),
      row([
        button('+ 텍스트', '', () => this.sceneApi.addText()),
        button('+ 이미지 파일', '', () => this.pickSceneImage()),
      ]),
      (this.inspector = el('div', 'inspector')),
      row([button('씬 링크 복사', 'primary wide', () => this.callbacks.onCopySceneLink())]),
      row([
        button('내보내기', '', () => this.exportScene()),
        button('가져오기', '', () => this.importScene()),
        button('초기화', '', () => this.sceneApi.clear()),
      ]),
      el('p', 'hint', [
        '아이템은 드래그로 이동, 클릭으로 선택 후 아래에서 편집. Delete로 삭제. ' +
          '씬 링크에는 배경·아이템이 전부 담기므로 라이브 URL로도 그대로 재현됩니다.',
      ]),
    ]);
  }

  private outputTab(): HTMLElement {
    const credit = document.createElement('input');
    credit.type = 'checkbox';
    credit.checked = this.initial.creditVisible;
    credit.addEventListener('change', () =>
      this.callbacks.onCreditVisibilityChange(credit.checked),
    );
    const creditLabel = el('label', 'toggle');
    creditLabel.append(credit, document.createTextNode('라이선스 오버레이 표시'));

    this.broadcastButton = button('방송 시작', 'primary wide', () => {
      if (this.broadcasting) this.callbacks.onStopBroadcast();
      else this.callbacks.onStartBroadcast();
    });
    this.watchLinkButton = button('시청 링크 복사', 'wide', () =>
      this.callbacks.onCopyWatchLink(),
    );
    this.watchLinkButton.disabled = true;
    this.roomStatus = el('span', 'num', ['방 없음']);

    return el('div', '', [
      el('h2', '', ['방송 룸']),
      row([this.broadcastButton]),
      row([label('상태'), this.roomStatus]),
      row([this.watchLinkButton]),
      el('p', 'hint', [
        '방송을 켜면 내 움직임이 방으로 나가고, 링크를 연 사람은 그것을 볼 뿐 ' +
          '아바타를 조종할 수 없습니다(서버가 막습니다). ' +
          'OBS 브라우저 소스에도 같은 시청 링크를 쓰면 카메라를 이 창만 쓰게 되어 ' +
          '경합이 사라집니다.',
      ]),

      el('h2', '', ['직접 렌더 (룸 없이)']),
      row([button('브라우저 소스 URL 복사', 'wide', () => this.callbacks.onCopyLiveUrl())]),
      row([creditLabel]),
      el('p', 'hint', [
        'OBS가 이 기계에서 직접 트래킹하게 하는 방식입니다. 모델·보정·씬이 URL에 담깁니다. ' +
          '이 URL은 남에게 보내면 안 됩니다 — 받은 사람의 카메라로 아바타가 움직입니다.',
      ]),
    ]);
  }

  private broadcasting = false;

  /** Reflects room state: null means not broadcasting. */
  setRoom(roomId: string | null, viewers: number): void {
    this.broadcasting = roomId !== null;
    if (this.broadcastButton) {
      this.broadcastButton.textContent = roomId ? '방송 정지' : '방송 시작';
    }
    if (this.watchLinkButton) this.watchLinkButton.disabled = roomId === null;
    if (this.roomStatus) {
      this.roomStatus.textContent = roomId ? `${roomId} · 시청 ${viewers}` : '방 없음';
    }
  }

  setViewers(viewers: number): void {
    if (!this.roomStatus || !this.broadcasting) return;
    const [id] = this.roomStatus.textContent?.split(' · ') ?? [];
    this.roomStatus.textContent = `${id ?? ''} · 시청 ${viewers}`;
  }

  private debugTab(): HTMLElement {
    return el('div', '', [this.debugGrid()]);
  }

  // ---------------------------------------------------------------- public

  setDropzoneVisible(visible: boolean): void {
    this.dropzone.classList.toggle('hidden', !visible);
  }

  setTrackingState(state: TrackingState): void {
    if (state === this.trackingState) return;
    this.trackingState = state;

    this.statusDot.classList.toggle('live', state === 'on');
    this.statusDot.classList.toggle('searching', state === 'searching');
    this.statusText.textContent =
      state === 'on'
        ? '추적 중'
        : state === 'searching'
          ? '얼굴 찾는 중…'
          : state === 'starting'
            ? '준비 중…'
            : '정지';
    this.trackButton.textContent = state === 'off' ? '트래킹 시작' : '트래킹 정지';
    this.trackButton.disabled = state === 'starting';
  }

  private trackingState: TrackingState | null = null;

  setNotice(message: string): void {
    this.noticeBox.textContent = message;
  }

  /** Pushes config values back into the sliders after a programmatic change. */
  syncSliders(): void {
    for (const [key, { input, readout }] of this.sliders) {
      const raw = this.config[key];
      const shown = input.dataset['unit'] === 'deg' ? (raw * 180) / Math.PI : raw;
      input.value = shown.toFixed(2);
      readout.textContent = format(shown, input.dataset['unit'] === 'deg');
    }
  }

  setCreditVisible(visible: boolean): void {
    this.licenseBox.classList.toggle('suppressed', !visible);
  }

  setLicense(license: AvatarLicense | null): void {
    if (!license) {
      this.licenseBox.classList.remove('visible');
      return;
    }

    const author = license.authors.length > 0 ? license.authors.join(', ') : '작자 미상';
    const flags: string[] = [];
    if (license.licenseName) flags.push(license.licenseName);
    if (license.authorOnly) flags.push('저자 전용');
    if (license.commercialUsage) flags.push(`상업: ${license.commercialUsage}`);
    if (license.modification) flags.push(`개변: ${license.modification}`);

    this.licenseBox.innerHTML = '';
    this.licenseBox.append(
      el('div', '', [
        el('strong', '', [license.name ?? '이름 없는 모델']),
        ` — ${author}`,
        el('span', 'num', [`  VRM ${license.specVersion === '0' ? '0.x' : '1.0'}`]),
      ]),
    );
    if (flags.length > 0) {
      this.licenseBox.append(el('div', 'flag', [flags.join(' · ')]));
    }

    this.licenseBox.classList.toggle('required', license.creditRequired);
    this.licenseBox.classList.add('visible');
  }

  setDebug(debug: DriverDebug): void {
    const values: Record<string, string> = {
      tracked: debug.tracked ? 'yes' : 'no',
      pitch: deg(debug.pitch),
      yaw: deg(debug.yaw),
      roll: deg(debug.roll),
      blink: `${debug.blinkL.toFixed(2)} / ${debug.blinkR.toFixed(2)}`,
      mouth: debug.mouthOpen.toFixed(2),
      brow: `${debug.browUp.toFixed(2)} / ${debug.browDown.toFixed(2)}`,
      morphs: String(debug.browMorphs),
      rig: debug.rigBones > 0 ? `${debug.rigBones} bones` : '—',
      hands: debug.handBones > 0 ? `${debug.handBones} bones` : '—',
      bodyrig: debug.bodyBones > 0 ? `${debug.bodyBones} bones` : '—',
    };
    for (const [key, value] of Object.entries(values)) {
      const cell = this.debugCells.get(key);
      if (cell) cell.textContent = value;
    }
  }

  showError(message: string | null): void {
    this.errorBox.classList.toggle('hidden', message === null);
    this.errorBox.textContent = message ?? '';
  }

  setActiveEmotion(name: string | null): void {
    for (const [emotion, chip] of this.emotionChips) {
      chip.classList.toggle('on', emotion === name);
    }
  }

  // ------------------------------------------------------------- scene UI

  private onBackgroundKind(kind: string): void {
    if (this.bgColorInput) this.bgColorInput.style.display = kind === 'color' ? '' : 'none';

    if (kind === 'none') {
      this.sceneApi.setBackground({ type: 'none' });
    } else if (kind === 'color') {
      this.sceneApi.setBackground({ type: 'color', color: this.bgColorInput?.value ?? '#14121c' });
    } else if (kind === 'image') {
      this.pickImageFile((url) => this.sceneApi.setBackground({ type: 'image', url }));
    }
  }

  private pickSceneImage(): void {
    this.pickImageFile((url) => this.sceneApi.addImage(url));
  }

  /**
   * Local image → data URL, embedded straight into the scene. Self-contained is
   * the point (the scene must survive into an OBS browser source that shares no
   * storage with this browser), but data URLs live inside the share link, so
   * size is capped to keep links usable.
   */
  private pickImageFile(done: (url: string) => void): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return;
      if (file.size > 300 * 1024) {
        this.showError('이미지가 300KB를 넘습니다 — 씬 링크가 너무 길어지므로 줄여주세요.');
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') done(reader.result);
      };
      reader.readAsDataURL(file);
    });
    input.click();
  }

  renderInspector(item: SceneItem | null): void {
    const box = this.inspector;
    if (!box) return;
    box.innerHTML = '';
    if (!item) return;

    if (item.kind === 'text') {
      const textInput = document.createElement('input');
      textInput.type = 'text';
      textInput.className = 'text-input';
      textInput.value = item.text;
      textInput.addEventListener('input', () => {
        this.sceneApi.updateItem(item.id, { text: textInput.value });
      });
      box.append(row([textInput]));

      const sizeInput = document.createElement('input');
      sizeInput.type = 'range';
      sizeInput.min = '10';
      sizeInput.max = '160';
      sizeInput.value = String(item.size);
      sizeInput.addEventListener('input', () => {
        this.sceneApi.updateItem(item.id, { size: Number(sizeInput.value) });
      });
      box.append(row([label('크기'), sizeInput]));

      const colorInput = document.createElement('input');
      colorInput.type = 'color';
      colorInput.value = item.color;
      colorInput.addEventListener('input', () => {
        this.sceneApi.updateItem(item.id, { color: colorInput.value });
      });

      const boldToggle = document.createElement('input');
      boldToggle.type = 'checkbox';
      boldToggle.checked = item.bold;
      boldToggle.addEventListener('change', () => {
        this.sceneApi.updateItem(item.id, { bold: boldToggle.checked });
      });
      const boldLabel = el('label', 'toggle');
      boldLabel.append(boldToggle, document.createTextNode('굵게'));

      box.append(row([label('색'), colorInput, boldLabel]));
    } else if (item.kind === 'image') {
      const widthInput = document.createElement('input');
      widthInput.type = 'range';
      widthInput.min = '4';
      widthInput.max = '100';
      widthInput.value = String(item.width);
      widthInput.addEventListener('input', () => {
        this.sceneApi.updateItem(item.id, { width: Number(widthInput.value) });
      });
      box.append(row([label('너비'), widthInput]));
    }
    // The avatar has no inspector on purpose. Numeric width/height sliders for a
    // rectangle you can see are a worse control than the rectangle itself, so it
    // is shaped by dragging in the 크롭 tab instead.

    // The avatar is the performer, not an overlay — deleting it would leave a
    // scene with nothing to drive.
    if (item.kind !== 'avatar') {
      box.append(row([button('아이템 삭제', 'wide', () => this.sceneApi.removeItem(item.id))]));
    }
  }

  private exportScene(): void {
    const blob = new Blob([this.sceneApi.exportJson()], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'vrm-stage-scene.json';
    link.click();
    URL.revokeObjectURL(link.href);
  }

  private importScene(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return;
      void file.text().then((json) => {
        if (!this.sceneApi.importJson(json)) {
          this.showError('씬 파일을 읽을 수 없습니다 — 형식을 확인해주세요.');
        }
      });
    });
    input.click();
  }

  // ------------------------------------------------------------- controls

  private toggle(text: string, key: BooleanKey): HTMLElement {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = this.config[key];
    input.addEventListener('change', () => {
      this.callbacks.onConfigChange({ [key]: input.checked } as Partial<DriverConfig>);
    });

    const wrapper = el('label', 'toggle');
    wrapper.append(input, document.createTextNode(text));
    return row([wrapper]);
  }

  private bodyToggle(text: string, key: 'torso' | 'invertSway'): HTMLElement {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = this.bodyConfig[key];
    input.addEventListener('change', () => {
      this.callbacks.onBodyConfigChange({ [key]: input.checked } as Partial<BodyRigConfig>);
    });
    const wrapper = el('label', 'toggle');
    wrapper.append(input, document.createTextNode(text));
    return row([wrapper]);
  }

  private bodySlider(text: string, key: 'gain', min: number, max: number, step: number): HTMLElement {
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(this.bodyConfig[key]);

    const readout = el('span', 'num', [input.value]);
    input.addEventListener('input', () => {
      readout.textContent = Number(input.value).toFixed(2);
      this.callbacks.onBodyConfigChange({ [key]: Number(input.value) } as Partial<BodyRigConfig>);
    });

    const right = el('span', 'status');
    right.append(input, readout);
    return row([label(text), right]);
  }

  private handToggle(
    text: string,
    key: 'fingers' | 'arms' | 'invertCurl' | 'wrist' | 'invertArmY' | 'invertArmZ' | 'invertArmX',
  ): HTMLElement {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = this.handConfig[key];
    input.addEventListener('change', () => {
      this.callbacks.onHandConfigChange({ [key]: input.checked } as Partial<HandRigConfig>);
    });

    const wrapper = el('label', 'toggle');
    wrapper.append(input, document.createTextNode(text));
    return row([wrapper]);
  }

  private handSlider(
    text: string,
    key: 'armReach',
    min: number,
    max: number,
    step: number,
  ): HTMLElement {
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(this.handConfig[key]);

    const readout = el('span', 'num', [input.value]);
    input.addEventListener('input', () => {
      readout.textContent = Number(input.value).toFixed(2);
      this.callbacks.onHandConfigChange({ [key]: Number(input.value) } as Partial<HandRigConfig>);
    });

    const right = el('span', 'status');
    right.append(input, readout);
    return row([label(text), right]);
  }

  private slider(
    text: string,
    key: NumericKey,
    min: number,
    max: number,
    step: number,
    unit: 'raw' | 'deg' = 'raw',
  ): HTMLElement {
    const isDegrees = unit === 'deg';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.dataset['unit'] = unit;

    const initial = isDegrees ? (this.config[key] * 180) / Math.PI : this.config[key];
    input.value = String(initial);

    const readout = el('span', 'num', [format(initial, isDegrees)]);
    input.addEventListener('input', () => {
      const shown = Number(input.value);
      readout.textContent = format(shown, isDegrees);
      const stored = isDegrees ? (shown * Math.PI) / 180 : shown;
      this.callbacks.onConfigChange({ [key]: stored } as Partial<DriverConfig>);
    });

    this.sliders.set(key, { input, readout });

    const right = el('span', 'status');
    right.append(input, readout);
    return row([label(text), right]);
  }

  private debugGrid(): HTMLElement {
    const grid = el('div', 'debug');
    for (const [key, caption] of [
      ['tracked', 'tracked'],
      ['pitch', 'pitch'],
      ['yaw', 'yaw'],
      ['roll', 'roll'],
      ['blink', 'blink L/R'],
      ['mouth', 'mouth'],
      ['brow', 'brow up/dn'],
      ['morphs', 'brow morphs'],
      ['rig', 'rig source'],
      ['hands', 'hand rig'],
      ['bodyrig', 'body rig'],
    ] as const) {
      const value = el('b', '', ['—']);
      this.debugCells.set(key, value);
      grid.append(el('span', '', [caption]), value);
    }
    return grid;
  }
}

function el(tag: string, className = '', children: (Node | string)[] = []): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const child of children) {
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function row(children: (Node | string)[]): HTMLElement {
  return el('div', 'row', children);
}

function label(text: string): HTMLElement {
  return el('span', '', [text]);
}

function button(text: string, className: string, onClick: () => void): HTMLButtonElement {
  const node = document.createElement('button');
  node.textContent = text;
  if (className) node.className = className;
  node.addEventListener('click', onClick);
  return node;
}

function select(
  options: [string, string][],
  initial: string,
  onChange: (value: string) => void,
): HTMLSelectElement {
  const node = document.createElement('select');
  for (const [value, text] of options) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    node.append(option);
  }
  node.value = initial;
  node.addEventListener('change', () => onChange(node.value));
  return node;
}

function format(value: number, isDegrees: boolean): string {
  return isDegrees ? `${value.toFixed(1)}°` : value.toFixed(2);
}

function deg(radians: number): string {
  return `${((radians * 180) / Math.PI).toFixed(1)}°`;
}

/**
 * Draws a scene as a small diagram: one rect per positioned item.
 *
 * Built from the spec, so it is always what applying the preset produces. The
 * avatar gets the accent colour and a label because it is the one thing the
 * operator is really placing; text becomes a bar at its own size, which is
 * enough to read the layout at 92x52.
 */
function presetThumbnail(spec: SceneSpec): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const W = 100;
  const H = 56;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'preset-thumb');

  const rect = (x: number, y: number, w: number, h: number, fill: string, r = 1) => {
    const node = document.createElementNS(NS, 'rect');
    node.setAttribute('x', String(((x - w / 2) / 100) * W));
    node.setAttribute('y', String(((y - h / 2) / 100) * H));
    node.setAttribute('width', String((w / 100) * W));
    node.setAttribute('height', String((h / 100) * H));
    node.setAttribute('rx', String(r));
    node.setAttribute('fill', fill);
    svg.append(node);
  };

  // The frame itself: a transparent background is drawn as the checkerboard grey
  // so "composites over your game" is visible rather than implied.
  rect(50, 50, 100, 100, spec.background.type === 'color' ? spec.background.color : '#2a2438', 2);

  for (const item of spec.items) {
    if (item.hidden) continue;
    if (item.kind === 'shape') rect(item.x, item.y, item.w, item.h, item.color, 1.5);
    else if (item.kind === 'text') {
      // A text run has no height in the spec; approximate one from its size so
      // the bar reads as a title rather than a hairline.
      const h = Math.max(4, (item.size / 1080) * 100 * 1.3);
      rect(item.x, item.y, Math.min(70, item.text.length * item.size * 0.055), h, item.color, 1);
    }
  }

  const avatarItem = spec.items.find((item) => item.kind === 'avatar');
  if (avatarItem && avatarItem.kind === 'avatar') {
    if (avatarItem.plate) rect(avatarItem.x, avatarItem.y, avatarItem.w, avatarItem.h, avatarItem.plate, 2);
    rect(avatarItem.x, avatarItem.y, avatarItem.w, avatarItem.h, 'rgba(167,139,250,0.55)', 2);
  }
  return svg;
}
