/**
 * Where MediaPipe's WASM and models come from.
 *
 * Centralised for two reasons. First, these paths must be built from
 * `import.meta.env.BASE_URL` — hardcoding `/mediapipe/...` in a source file is
 * exactly what makes hosting under a subpath impossible. Second, a broadcast
 * must not depend on someone else's CDN having a good day, so self-hosted is the
 * default and the CDN is only an opt-in debugging escape hatch.
 *
 * The self-hosted files are produced by:
 *  - WASM   → the `vrm-stage:mediapipe-assets` plugin in `vite.config.ts`
 *  - models → `scripts/fetch-models.mjs`, run by `predev` / `prebuild`
 */

import { basePath } from '../basePath';

const CDN_WASM_ROOT = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';
const CDN_MODEL_ROOT = 'https://storage.googleapis.com/mediapipe-models';

const CDN_MODELS = {
  face: `${CDN_MODEL_ROOT}/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
  hand: `${CDN_MODEL_ROOT}/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`,
  pose: `${CDN_MODEL_ROOT}/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`,
} as const;

export type ModelName = keyof typeof CDN_MODELS;

/** True when `?mp=cdn` asks us to bypass the vendored copies. */
function cdnRequested(): boolean {
  try {
    return new URLSearchParams(location.search).get('mp') === 'cdn';
  } catch {
    return false;
  }
}

/** Root passed to `FilesetResolver.forVisionTasks`. */
export function wasmRoot(): string {
  return cdnRequested() ? CDN_WASM_ROOT : `${basePath()}mediapipe/wasm`;
}

export function modelUrl(name: ModelName): string {
  return cdnRequested()
    ? CDN_MODELS[name]
    : `${basePath()}mediapipe/models/${name}_landmarker.task`;
}

/** For diagnostics — the panel and logs say which source is live. */
export function assetSource(): 'self-hosted' | 'cdn' {
  return cdnRequested() ? 'cdn' : 'self-hosted';
}
