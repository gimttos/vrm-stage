import * as THREE from 'three';
import { withBase } from '../basePath';
import { AvatarDriver } from '../driver/AvatarDriver';
import { loadAvatar } from '../stage/AvatarLoader';
import { emptyFrame, type HandPose, type HeadPose, type PoseFrame } from '../types';

/**
 * Rig sign regression test.
 *
 * Axis signs cost this project more time than anything else. The failure mode is
 * always the same shape: a rotation that looks right on one model is mirrored on
 * another, or a hand-written probe encodes the same wrong assumption as the code
 * it is checking, so the measurement agrees with the bug.
 *
 * Two defences, and the first matters more:
 *
 *  1. THE TWO SPECS MUST AGREE. `tttt.vrm` is VRM 1.0 and `reee.vrm` is the same
 *     model exported as 0.x, whose scene `rotateVRM0` turns 180° about Y —
 *     negating every bone's local X and Z while leaving local Y and all world
 *     anatomy alone. Any code that confuses a local-axis write with a
 *     world-space target diverges here, and no baseline is needed to see it.
 *  2. Absolute values must not drift. These catch a retune nobody meant to make.
 *
 * Deliberately measured in WORLD space against directions derived from the rig's
 * own rest orientation. Reading a bone's local +Z as "the nose" is exactly the
 * mistake that once hid an inverted pitch: a 0.x face looks along local −Z, so
 * the error cancelled in the measurement and survived in the product.
 *
 * Run with `?selftest=1` in dev. Fixtures are dev-only, so this cannot ship.
 */

/** Recorded on 2026-07-28 with every inversion toggle off. */
const BASELINE: Record<string, number> = {
  pitchPlus_noseY: -0.544,
  yawPlus_noseX: -0.544,
  rollPlus_crownX: 0.544,
  armX: 0.168,
  armY: 0.309,
  armZ: 0.414,
  fistShortens: 0.048,
  idleBelowHead: 0.55,
};

/**
 * Absolute values are tied to THESE fixtures' proportions, so a different model
 * legitimately reads differently. Spec agreement is not — that must hold always.
 */
const TOLERANCE = 0.01;

const FIXTURES = [
  { label: 'VRM 1.0', url: '/fixtures/tttt.vrm' },
  { label: 'VRM 0.x', url: '/fixtures/reee.vrm' },
] as const;

type Metrics = Record<string, number>;

export interface ProbeResult {
  metrics: { label: string; spec: string; values: Metrics }[];
  rows: {
    metric: string;
    v10: number;
    v0x: number;
    baseline: number;
    specsAgree: boolean;
    matchesBaseline: boolean;
  }[];
  pass: boolean;
  failures: string[];
}

function hand(x: number, y: number, size: number, curls?: number[]): HandPose {
  return {
    curls: (curls ?? [0, 0, 0, 0, 0]) as HandPose['curls'],
    spread: 0.5,
    position: { x: 0, y: 0, z: 0 },
    size: 0,
    roll: 0,
    relative: { x, y, size },
    basis: null,
  };
}

async function measure(url: string): Promise<{ spec: string; values: Metrics }> {
  const { vrm, morphs } = await loadAvatar(withBase(url));

  // A bare scene is enough: every measurement reads bone world transforms, and
  // nothing here needs a renderer.
  const scene = new THREE.Scene();
  scene.add(vrm.scene);
  scene.updateMatrixWorld(true);

  const driver = new AvatarDriver();
  driver.attach(vrm, morphs, scene);

  const bone = (name: string): THREE.Object3D | null =>
    vrm.humanoid?.getNormalizedBoneNode(name as never) ?? null;

  const world = (name: string): THREE.Vector3 => {
    vrm.scene.updateMatrixWorld(true);
    const out = new THREE.Vector3();
    bone(name)?.getWorldPosition(out);
    return out;
  };

  // Face and crown directions in the rig's OWN rest frame, so a 180°-turned rig
  // is measured by where its face actually points rather than by an axis guess.
  const rootQuat = new THREE.Quaternion();
  vrm.scene.getWorldQuaternion(rootQuat);
  const inverse = rootQuat.clone().invert();
  const faceLocal = new THREE.Vector3(0, 0, 1).applyQuaternion(inverse);
  const crownLocal = new THREE.Vector3(0, 1, 0).applyQuaternion(inverse);

  const headDir = (local: THREE.Vector3): THREE.Vector3 => {
    const quat = new THREE.Quaternion();
    bone('head')?.getWorldQuaternion(quat);
    return local.clone().applyQuaternion(quat);
  };

  const drive = (
    frame: Partial<Pick<PoseFrame, 'hands' | 'head'>>,
    steps = 300,
  ): void => {
    for (let i = 0; i < steps; i++) {
      driver.update(
        vrm,
        {
          ...emptyFrame(),
          tracked: true,
          timestamp: performance.now() + i * 33,
          ...frame,
        } as PoseFrame,
        1 / 60,
      );
    }
    vrm.scene.updateMatrixWorld(true);
  };

  const head = (pitch: number, yaw: number, roll: number): HeadPose => ({ pitch, yaw, roll });
  const values: Metrics = {};

  // ---- head, in mirror mode, the way people actually run it ----
  driver.config.mirror = true;
  drive({ head: head(0.5, 0, 0) });
  values['pitchPlus_noseY'] = round(headDir(faceLocal).y);
  drive({ head: head(0, 0.5, 0) });
  values['yawPlus_noseX'] = round(headDir(faceLocal).x);
  drive({ head: head(0, 0, 0.5) });
  values['rollPlus_crownX'] = round(headDir(crownLocal).x);

  // ---- arms, unmirrored so the side swap does not confound the axis ----
  driver.config.mirror = false;
  drive({ hands: { left: hand(1.5, 0, 0.62), right: null } });
  values['armX'] = round(world('leftHand').x - world('leftUpperArm').x);
  drive({ hands: { left: hand(0, 1.2, 0.62), right: null } });
  values['armY'] = round(world('leftHand').y - world('leftUpperArm').y);
  drive({ hands: { left: hand(0, 0, 1.1), right: null } });
  values['armZ'] = round(world('leftHand').z - world('leftUpperArm').z);

  // ---- fingers: a fist must bring the tip TOWARD the palm ----
  drive({ hands: { left: hand(0, 0, 0.62, [1, 1, 1, 1, 1]), right: null } });
  const palm = world('leftHand');
  const fistTip = world('leftIndexDistal').distanceTo(palm);
  drive({ hands: { left: hand(0, 0, 0.62, [0, 0, 0, 0, 0]), right: null } });
  values['fistShortens'] = round(world('leftIndexDistal').distanceTo(palm) - fistTip);

  // ---- idle: untracked arms hang below the head, not in a T-pose ----
  drive({ hands: { left: null, right: null } }, 500);
  values['idleBelowHead'] = round(world('head').y - world('leftHand').y);

  scene.remove(vrm.scene);
  return { spec: vrm.meta?.metaVersion === '0' ? '0.x' : '1.0', values };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export async function runRigProbe(): Promise<ProbeResult> {
  const metrics: ProbeResult['metrics'] = [];
  for (const fixture of FIXTURES) {
    const { spec, values } = await measure(fixture.url);
    metrics.push({ label: fixture.label, spec, values });
  }

  const [first, second] = metrics;
  const rows: ProbeResult['rows'] = [];
  const failures: string[] = [];

  for (const metric of Object.keys(BASELINE)) {
    const v10 = first?.values[metric] ?? NaN;
    const v0x = second?.values[metric] ?? NaN;
    const baseline = BASELINE[metric]!;

    const specsAgree = Math.abs(v10 - v0x) <= TOLERANCE;
    const matchesBaseline = Math.abs(v10 - baseline) <= TOLERANCE;

    if (!specsAgree) {
      failures.push(`${metric}: specs disagree (1.0 ${v10} vs 0.x ${v0x})`);
    }
    if (!matchesBaseline) {
      failures.push(`${metric}: drifted from baseline (${v10}, expected ${baseline})`);
    }
    rows.push({ metric, v10, v0x, baseline, specsAgree, matchesBaseline });
  }

  return { metrics, rows, pass: failures.length === 0, failures };
}

/** Renders the result as a plain overlay; also logs a table to the console. */
export function renderRigProbe(result: ProbeResult, root: HTMLElement): void {
  console.table(result.rows);
  if (result.failures.length > 0) console.error(result.failures.join('\n'));

  const lines = [
    `rig probe: ${result.pass ? 'PASS' : 'FAIL'}`,
    '',
    'metric               VRM 1.0    VRM 0.x   baseline  specs  base',
    ...result.rows.map((row) =>
      [
        row.metric.padEnd(20),
        String(row.v10).padStart(8),
        String(row.v0x).padStart(10),
        String(row.baseline).padStart(10),
        (row.specsAgree ? 'ok' : 'FAIL').padStart(7),
        (row.matchesBaseline ? 'ok' : 'FAIL').padStart(6),
      ].join(''),
    ),
    ...(result.failures.length > 0 ? ['', ...result.failures] : []),
  ];

  const pre = document.createElement('pre');
  pre.style.cssText =
    'position:fixed;inset:24px;z-index:99;overflow:auto;padding:16px;' +
    'background:rgba(12,10,18,.96);color:#f2f0f7;font:12px ui-monospace,monospace;' +
    `border:1px solid ${result.pass ? '#34d399' : '#f87171'};border-radius:10px;white-space:pre`;
  pre.textContent = lines.join('\n');
  root.append(pre);
}
