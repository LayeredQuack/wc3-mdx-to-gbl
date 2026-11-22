/**
 * Warcraft III coordinate / transform conversion to glTF axis conventions.
 *
 * WC3 is Z-up; glTF is Y-up.
 * Position/normal: (x, y, z) → (x, z, -y)
 * Quaternion:      (x, y, z, w) → (x, z, -y, w)
 * Scale:           (x, y, z) → (x, z, y)  (no sign flip)
 */

/** WC3 Z-up → glTF Y-up: (x,y,z) → (x, z, -y) */
export function wc3ToGltfVec3(src: ArrayLike<number>): Float32Array {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    out[i] = src[i];
    out[i + 1] = src[i + 2];
    out[i + 2] = -src[i + 1];
  }
  return out;
}

/** WC3 Rotation Quaternion conversion to glTF axis layout */
export function wc3ToGltfQuat(src: ArrayLike<number>): Float32Array {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 4) {
    const x = src[i];
    const y = src[i + 1];
    const z = src[i + 2];
    const w = src[i + 3];
    out[i] = x;
    out[i + 1] = z;
    out[i + 2] = -y;
    out[i + 3] = w;
  }
  return out;
}

/** WC3 scale → glTF scale: same axis permutation as positions, without sign change. */
export function wc3ToGltfScale(src: ArrayLike<number>): Float32Array {
  return new Float32Array([src[0], src[2], src[1]]);
}
