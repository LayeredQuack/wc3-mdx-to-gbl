/**
 * Shared animation-related types for MDX → glTF export.
 */

export interface MdxAnimationKey {
  Frame: number;
  Vector: ArrayLike<number>;
}

export interface MdxAnimationTrack {
  LineType?: number;
  GlobalSeqId?: number;
  Keys?: MdxAnimationKey[];
}

export type GltfTransformPath = 'translation' | 'rotation' | 'scale';
export type GltfAccessorType = 'VEC3' | 'VEC4';
export type GltfInterpolation = 'STEP' | 'LINEAR';
