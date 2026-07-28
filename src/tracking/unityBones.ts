/**
 * Unity `HumanBodyBones` names (what VMC sends) to VRM humanoid bone names
 * (what three-vrm's normalized rig exposes).
 *
 * For almost every bone this is just lowercasing the first letter. The thumbs
 * are not: Unity names the three thumb joints Proximal/Intermediate/Distal
 * while VRM 1.0 names them Metacarpal/Proximal/Distal. The words overlap but
 * refer to different joints, so a naive lowercase mapping silently shifts every
 * thumb by one joint — the thumb ends up bending at the wrong knuckle and the
 * fingertip never moves at all.
 */
const THUMB_OVERRIDES: Record<string, string> = {
  LeftThumbProximal: 'leftThumbMetacarpal',
  LeftThumbIntermediate: 'leftThumbProximal',
  LeftThumbDistal: 'leftThumbDistal',
  RightThumbProximal: 'rightThumbMetacarpal',
  RightThumbIntermediate: 'rightThumbProximal',
  RightThumbDistal: 'rightThumbDistal',
};

/** Bones VMC may send that have no VRM humanoid equivalent worth applying. */
const IGNORED = new Set(['LastBone']);

export function unityBoneToVRM(name: string): string | null {
  if (IGNORED.has(name)) return null;

  const override = THUMB_OVERRIDES[name];
  if (override) return override;

  if (name.length === 0) return null;
  return name[0]!.toLowerCase() + name.slice(1);
}
