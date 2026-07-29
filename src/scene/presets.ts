import { SCENE_VERSION, type SceneItem, type SceneSpec } from './sceneTypes';

/**
 * Ready-made scenes.
 *
 * Presets are CODE, not data inside `SceneSpec`. Keeping the spec "one frame"
 * is what keeps the URL budget and the migration story simple; a collection
 * living inside a scene would complicate both for no gain.
 *
 * THE RULE: colour, text and geometry only. Zero binary assets.
 *
 * A preset that fetched a background image would be the MediaPipe CDN
 * dependency wearing a different hat — a broadcast that breaks when someone
 * else's host has a bad day — and it would blow the hash budget, since binary
 * assets cannot ride in a URL at any length. Obeying the rule makes every
 * preset self-hosting by construction and every preset link small.
 *
 * The palette is deliberately dark and low-saturation: these sit behind a
 * performer, and a preset that fights the avatar for attention is a preset
 * nobody keeps.
 */
export interface ScenePreset {
  id: string;
  name: string;
  /** One line, shown under the name. Says what it is FOR, not what it contains. */
  note: string;
  build(): SceneSpec;
}

const INK = '#f2f0f7';
const PANEL = '#1c1730';
const DEEP = '#120e1e';
const ACCENT = '#a78bfa';
/** Stands in for a capture or media area that a later step will fill. */
const SLOT = '#232038';

function scene(items: SceneItem[], background?: SceneSpec['background']): SceneSpec {
  return { version: SCENE_VERSION, background: background ?? { type: 'none' }, items };
}

function avatar(patch: Partial<Extract<SceneItem, { kind: 'avatar' }>> = {}) {
  return {
    id: 'avatar',
    kind: 'avatar' as const,
    x: 50,
    y: 50,
    w: 100,
    h: 100,
    framing: 'bust' as const,
    panX: 0,
    panY: 0,
    zoom: 1,
    radius: 0,
    plate: null,
    ...patch,
  };
}

function shape(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  radius = 0,
  band: 'back' | 'front' = 'back',
): SceneItem {
  return { id, kind: 'shape', x, y, w, h, color, radius, band };
}

function text(
  id: string,
  x: number,
  y: number,
  body: string,
  size: number,
  color = INK,
  bold = true,
  band: 'back' | 'front' = 'front',
): SceneItem {
  return { id, kind: 'text', x, y, text: body, size, color, bold, shadow: true, band };
}

export const PRESETS: ScenePreset[] = [
  {
    id: 'full-frame',
    name: '전체 화면',
    note: '아바타만. 배경은 투명하게 두고 OBS에서 합성합니다.',
    build: () => scene([avatar()]),
  },
  {
    id: 'corner-cam',
    name: '코너캠',
    note: '게임 화면 위에 얹는 우하단 얼굴. 배경 투명.',
    build: () =>
      scene([
        // No plate and no background: this one is meant to composite over a game
        // capture, so anything opaque would be a box sitting on the gameplay.
        avatar({ x: 84, y: 74, w: 26, h: 40, radius: 8 }),
      ]),
  },
  {
    id: 'just-chatting',
    name: '저스트 채팅',
    note: '왼쪽은 채팅·자막 자리, 오른쪽에 아바타.',
    build: () =>
      scene(
        [
          shape('panel', 27, 54, 46, 74, PANEL, 3),
          text('title', 27, 12, '오늘의 잡담', 54),
          text('sub', 27, 19, '편하게 이야기하는 시간', 24, ACCENT, false),
          avatar({ x: 76, y: 58, w: 40, h: 72 }),
        ],
        { type: 'color', color: DEEP },
      ),
  },
  {
    id: 'starting-soon',
    name: '곧 시작합니다',
    note: '방송 전 대기 화면. 큰 안내 문구와 작은 흉상.',
    build: () =>
      scene(
        [
          text('title', 50, 38, '곧 시작합니다', 92),
          text('sub', 50, 50, '잠시만 기다려 주세요', 30, ACCENT, false),
          avatar({ x: 18, y: 76, w: 26, h: 40, radius: 50, plate: PANEL }),
        ],
        { type: 'color', color: DEEP },
      ),
  },
  {
    id: 'share-screen',
    name: '화면 공유',
    note: '큰 영역은 화면·자료 자리, 아바타는 우하단 코너.',
    build: () =>
      scene(
        [
          shape('stage', 46, 46, 84, 74, SLOT, 2),
          text('label', 46, 92, '여기에 화면이나 자료를 올리세요', 22, ACCENT, false),
          avatar({ x: 86, y: 80, w: 22, h: 32, radius: 10, plate: PANEL }),
        ],
        { type: 'color', color: DEEP },
      ),
  },
  {
    id: 'watch-together',
    name: '같이 보기',
    note: '가운데 영상 자리, 우하단 아바타와 이름표.',
    build: () =>
      scene(
        [
          shape('media', 50, 44, 76, 68, SLOT, 2),
          avatar({ x: 84, y: 76, w: 24, h: 36, radius: 10, plate: PANEL }),
          shape('plate', 30, 88, 34, 10, PANEL, 30, 'front'),
          text('name', 30, 88, '함께 보는 중', 26, INK, true),
        ],
        { type: 'color', color: DEEP },
      ),
  },
];

export function findPreset(id: string): ScenePreset | null {
  return PRESETS.find((preset) => preset.id === id) ?? null;
}
