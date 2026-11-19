/**
 * Translate MDX material layers into glTF materials.
 *
 * Receives already-resolved texture slots from the conversion pipeline.
 * Does not locate or decode texture files.
 */

import { Document } from '@gltf-transform/core';

export function readStaticNumeric(value: any, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // A few parser/model variants expose layer properties as AnimVector tracks.
  // Use the first authored key for the static GLB material and report that the
  // complete animated property is not yet exported.
  const firstValue = value?.Keys?.[0]?.Vector?.[0];
  return typeof firstValue === 'number' && Number.isFinite(firstValue)
    ? firstValue
    : fallback;
}

/**
 * Do not mistake an animated KMTA Alpha track's first key for a static value.
 * Stage 3 has no material-animation channel export yet, so animated alpha is
 * held at 1 for the static Blender texture/material preview. Literal numeric
 * alpha values are preserved exactly. The animated track is reported and
 * retained in material extras for later material-animation work.
 */
export function readMaterialAlpha(
  value: any,
  warn: (message: string) => void,
  materialIndex: number,
  layerIndex: number
): { value: number; animated: boolean; keyCount: number; firstKey?: number } {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { value: Math.max(0, Math.min(1, value)), animated: false, keyCount: 0 };
  }

  if (value && Array.isArray(value.Keys)) {
    const first = value.Keys[0]?.Vector?.[0];
    warn(`Material ${materialIndex} layer ${layerIndex}: Alpha is an animated track (${value.Keys.length} key(s)); material animation is not exported yet, so static preview alpha is set to 1 instead of sampling the first key`);
    return {
      value: 1,
      animated: true,
      keyCount: value.Keys.length,
      firstKey: typeof first === 'number' ? first : undefined,
    };
  }

  return { value: 1, animated: false, keyCount: 0 };
}

export function describeMaterialAlpha(value: any): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `static ${value}`;
  }
  if (value && Array.isArray(value.Keys)) {
    const first = value.Keys[0]?.Vector?.[0];
    const global = typeof value.GlobalSeqId === 'number' ? `, GlobalSeqId=${value.GlobalSeqId}` : '';
    return `animated track (${value.Keys.length} key(s)${global}, first=${typeof first === 'number' ? first : 'n/a'})`;
  }
  return 'default 1';
}

export function createLayerMaterial(
  doc: Document,
  materialIndex: number,
  layerIndex: number,
  layer: any,
  textures: any[],
  textureSlots: (ReturnType<Document['createTexture']> | null)[],
  warn: (message: string) => void
): ReturnType<Document['createMaterial']> | null {
  const textureId = Math.trunc(readStaticNumeric(layer?.TextureID, 0));
  if (!Number.isInteger(textureId) || textureId < 0 || textureId >= textureSlots.length) {
    warn(`Material ${materialIndex} layer ${layerIndex}: invalid or animated TextureID (${textureId}); layer omitted`);
    return null;
  }

  const texture = textureSlots[textureId];
  if (!texture) {
    const sourceTexture = textures[textureId];
    const replaceableId = Number(sourceTexture?.ReplaceableId ?? 0);
    if (replaceableId > 0) {
      warn(`Material ${materialIndex} layer ${layerIndex}: texture slot ${textureId} uses ReplaceableId ${replaceableId}; no team-color/replaceable texture has been substituted`);
    } else {
      warn(`Material ${materialIndex} layer ${layerIndex}: texture slot ${textureId} is unresolved; layer omitted`);
    }
    return null;
  }

  const coordId = Math.max(0, Math.trunc(readStaticNumeric(layer?.CoordId, 0)));
  const filterMode = Math.trunc(readStaticNumeric(layer?.FilterMode, 0));
  const alphaInfo = readMaterialAlpha(layer?.Alpha, warn, materialIndex, layerIndex);
  const alpha = alphaInfo.value;
  const shading = Math.trunc(readStaticNumeric(layer?.Shading, 0));
  const material = doc.createMaterial(`mat_${materialIndex}_layer_${layerIndex}`)
    .setMetallicFactor(0)
    .setRoughnessFactor(1)
    .setBaseColorFactor([1, 1, 1, alpha]);

  material.setBaseColorTexture(texture);
  const textureInfo = material.getBaseColorTextureInfo();
  if (textureInfo) {
    textureInfo.setTexCoord(coordId);
    const flags = Number(textures[textureId]?.Flags ?? 0);
    // MDX TextureFlags: WrapWidth=1, WrapHeight=2. glTF texture wrap enums:
    // REPEAT=10497, CLAMP_TO_EDGE=33071.
    textureInfo.setWrapS((flags & 1) !== 0 ? 10497 : 33071);
    textureInfo.setWrapT((flags & 2) !== 0 ? 10497 : 33071);
  }

  if (filterMode === 1) {
    material.setAlphaMode('MASK').setAlphaCutoff(0.75);
  } else if (filterMode >= 2) {
    material.setAlphaMode('BLEND');
    if (filterMode >= 3) {
      warn(`Material ${materialIndex} layer ${layerIndex}: Warcraft filter mode ${filterMode} is approximated with glTF alpha BLEND; additive/modulate fidelity is pending`);
    }
  } else {
    material.setAlphaMode('OPAQUE');
  }

  if ((shading & 16) !== 0) material.setDoubleSided(true);
  if ((shading & 2) !== 0) {
    warn(`Material ${materialIndex} layer ${layerIndex}: sphere environment mapping is not represented by core glTF materials`);
  }
  if (Number(layer?.TVertexAnimId ?? -1) >= 0) {
    warn(`Material ${materialIndex} layer ${layerIndex}: texture-coordinate animation ${layer.TVertexAnimId} is not yet exported; static UVs are used`);
  }
  if (layer?.TextureID && typeof layer.TextureID === 'object') {
    warn(`Material ${materialIndex} layer ${layerIndex}: animated TextureID is sampled at its first key only`);
  }
  if (layer?.Alpha && typeof layer.Alpha === 'object') {
    warn(`Material ${materialIndex} layer ${layerIndex}: animated layer alpha is sampled at its first key only`);
  }
  for (const property of ['NormalTextureID', 'ORMTextureID', 'EmissiveTextureID', 'TeamColorTextureID', 'ReflectionsTextureID']) {
    if (layer?.[property] !== undefined && layer?.[property] !== null) {
      warn(`Material ${materialIndex} layer ${layerIndex}: Reforged ${property} map is present but not yet connected to a glTF PBR texture slot`);
    }
  }

  material.setExtras({
    warcraft3: {
      materialIndex,
      layerIndex,
      textureId,
      coordId,
      filterMode,
      alpha,
      alphaAnimated: alphaInfo.animated,
      alphaKeyCount: alphaInfo.keyCount,
      alphaFirstKey: alphaInfo.firstKey ?? null,
      replaceableId: Number(textures[textureId]?.ReplaceableId ?? 0),
    },
  });
  return material;
}
