import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, type VRM, type VRM0Meta, type VRM1Meta } from '@pixiv/three-vrm';

/**
 * VRM license metadata, normalised across the 0.x and 1.0 specs.
 *
 * We surface this rather than ignoring it. A site that accepts other people's
 * models has to respect their terms, and the VRM community cares about this a
 * lot more than most tools acknowledge.
 */
export interface AvatarLicense {
  specVersion: '0' | '1';
  name: string | null;
  authors: string[];
  licenseUrl: string | null;
  /** VRM 0.x licence enum (`CC_BY`, `Redistribution_Prohibited`, …). Null on 1.0. */
  licenseName: string | null;
  /** Who is allowed to use this avatar at all. */
  avatarPermission: string | null;
  /** Commercial-use terms, verbatim from the file. */
  commercialUsage: string | null;
  /** Whether the file demands visible credit. When true we render it. */
  creditRequired: boolean;
  modification: string | null;
  /** True when metadata says only the author may use the model. */
  authorOnly: boolean;
}

export interface LoadedAvatar {
  vrm: VRM;
  license: AvatarLicense;
  morphs: MorphIndex;
}

/**
 * Lookup for raw glTF morph targets by name fragment.
 *
 * VRoid exports carry ~57 morph targets on the face mesh but bind only 14 of
 * them to VRM expression presets — and the presets contain no eyebrows at all.
 * That is why VRoid models have frozen brows in most tools. Reaching the
 * `Fcl_BRW_*` morphs directly is a legitimate use of glTF morph targets, and it
 * is the cheapest visible quality win available to us.
 */
export class MorphIndex {
  private readonly entries: { mesh: THREE.Mesh; index: number; name: string }[] = [];

  constructor(root: THREE.Object3D) {
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      const dictionary = mesh.morphTargetDictionary;
      if (!dictionary) return;
      for (const [name, index] of Object.entries(dictionary)) {
        this.entries.push({ mesh, index, name });
      }
    });
  }

  /** Every morph whose name contains `fragment` (case-insensitive). */
  find(fragment: string): { mesh: THREE.Mesh; index: number }[] {
    const needle = fragment.toLowerCase();
    return this.entries
      .filter((entry) => entry.name.toLowerCase().includes(needle))
      .map(({ mesh, index }) => ({ mesh, index }));
  }

  get names(): string[] {
    return this.entries.map((entry) => entry.name);
  }

  get size(): number {
    return this.entries.length;
  }
}

export async function loadAvatar(source: string | ArrayBuffer): Promise<LoadedAvatar> {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));

  const gltf =
    typeof source === 'string'
      ? await loader.loadAsync(source)
      : await loader.parseAsync(source, '');

  const vrm = gltf.userData.vrm as VRM | undefined;
  if (!vrm) {
    throw new Error('That file loaded as glTF but carries no VRM extension.');
  }

  // Trim data three.js will never use, and merge skeletons so the whole avatar
  // is one draw call per material instead of one per primitive.
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.combineSkeletons(gltf.scene);

  // VRM 0.x models face +Z, VRM 1.0 models face -Z. Without this a 0.x avatar
  // shows you the back of its head — the single most common 0.x/1.0 bug, and
  // the reason both fixtures are kept in the repo.
  VRMUtils.rotateVRM0(vrm);

  // Parts of a VRM routinely sit outside the bounding volume three.js computes
  // for them (hair springs, skirt bones), so per-object culling pops.
  vrm.scene.traverse((object) => {
    object.frustumCulled = false;
  });

  return {
    vrm,
    license: readLicense(vrm),
    morphs: new MorphIndex(vrm.scene),
  };
}

const UNKNOWN_LICENSE: AvatarLicense = {
  specVersion: '1',
  name: null,
  authors: [],
  licenseUrl: null,
  licenseName: null,
  avatarPermission: null,
  commercialUsage: null,
  creditRequired: false,
  modification: null,
  authorOnly: false,
};

/**
 * Normalises 0.x and 1.0 metadata onto one shape.
 *
 * The two specs express permissions differently and neither maps cleanly onto
 * the other, so the derivations below are documented rather than clever:
 * VRM 0.x has no credit field and no modification field, but its Creative
 * Commons enum encodes both — `CC_BY*` means attribution is required, and an
 * `_ND` suffix means no derivatives.
 */
function readLicense(vrm: VRM): AvatarLicense {
  const meta = vrm.meta;
  if (!meta) return UNKNOWN_LICENSE;

  if (meta.metaVersion === '0') {
    return fromVRM0(meta);
  }
  return fromVRM1(meta);
}

function fromVRM0(meta: VRM0Meta): AvatarLicense {
  const license = meta.licenseName ?? null;
  return {
    specVersion: '0',
    name: meta.title ?? null,
    authors: meta.author ? [meta.author] : [],
    licenseUrl: meta.otherLicenseUrl ?? meta.otherPermissionUrl ?? null,
    licenseName: license,
    avatarPermission: meta.allowedUserName ?? null,
    commercialUsage: meta.commercialUssageName ?? null,
    // CC_BY, CC_BY_NC, CC_BY_ND, ... all require attribution.
    creditRequired: license?.startsWith('CC_BY') ?? false,
    // No dedicated field; NoDerivatives in the CC enum is the closest signal.
    modification: license?.includes('_ND') ? 'prohibited' : null,
    authorOnly: meta.allowedUserName === 'OnlyAuthor',
  };
}

function fromVRM1(meta: VRM1Meta): AvatarLicense {
  return {
    specVersion: '1',
    name: meta.name ?? null,
    authors: meta.authors ?? [],
    licenseUrl: meta.licenseUrl ?? meta.otherLicenseUrl ?? null,
    licenseName: null,
    avatarPermission: meta.avatarPermission ?? null,
    commercialUsage: meta.commercialUsage ?? null,
    creditRequired: meta.creditNotation === 'required',
    modification: meta.modification ?? null,
    authorOnly: meta.avatarPermission === 'onlyAuthor',
  };
}
