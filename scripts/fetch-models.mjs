#!/usr/bin/env node
/**
 * Fetches MediaPipe's `.task` models into `public/mediapipe/models/`.
 *
 * These are the one set of assets that is neither in `node_modules` nor small
 * enough to commit comfortably, so they are downloaded once and gitignored.
 * Two properties make that safe:
 *
 *  - Each file is pinned by SHA-256, so a build is reproducible and a swapped
 *    upstream file fails loudly instead of shipping.
 *  - `predev`/`prebuild` run this, so you cannot start or ship without them.
 *
 * Re-run manually any time: `node scripts/fetch-models.mjs [--force]`
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const OUT_DIR = path.resolve('public/mediapipe/models');

const MODELS = [
  {
    name: 'face_landmarker.task',
    url: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
    sha256: '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff',
    bytes: 3758596,
  },
  {
    name: 'hand_landmarker.task',
    url: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
    sha256: 'fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1',
    bytes: 7819105,
  },
  {
    // The `lite` variant deliberately: this is a third detector sharing the GPU
    // with the face and hand passes, and shoulders are a coarse signal that does
    // not repay a heavier model.
    name: 'pose_landmarker.task',
    url: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
    sha256: '59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a',
    bytes: 5777746,
  },
];

const force = process.argv.includes('--force');

function digest(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function existing(file, sha256) {
  if (force) return false;
  try {
    return digest(await readFile(file)) === sha256;
  } catch {
    return false;
  }
}

async function fetchModel(model) {
  const file = path.join(OUT_DIR, model.name);

  if (await existing(file, model.sha256)) {
    console.log(`  ok       ${model.name} (cached)`);
    return;
  }

  const response = await fetch(model.url);
  if (!response.ok) {
    throw new Error(`${model.name}: HTTP ${response.status} from ${model.url}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const actual = digest(buffer);
  if (actual !== model.sha256) {
    throw new Error(
      `${model.name}: SHA-256 mismatch.\n  expected ${model.sha256}\n  actual   ${actual}\n` +
        'Upstream changed the file. Verify it, then update the pin in scripts/fetch-models.mjs.',
    );
  }

  await writeFile(file, buffer);
  console.log(`  fetched  ${model.name} (${buffer.length.toLocaleString()} bytes)`);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  console.log(`MediaPipe models → ${path.relative(process.cwd(), OUT_DIR)}`);
  for (const model of MODELS) await fetchModel(model);
}

main().catch((error) => {
  console.error(`\nfetch-models failed: ${error.message}`);
  console.error(
    '\nNo network? The app can fall back to the CDN for debugging with ?mp=cdn,\n' +
      'but a self-hosted deploy needs these files present.',
  );
  process.exit(1);
});
