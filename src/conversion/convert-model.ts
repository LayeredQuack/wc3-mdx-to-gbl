/**
 * Central per-model conversion pipeline.
 *
 * Orchestrates texture loading, material construction, skeleton, geosets,
 * animation export, scene assembly, and GLB serialization. Does not contain
 * the detailed algorithms — those live in the specialized modules.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseMDX } from 'war3-model';
import { Document, NodeIO } from '@gltf-transform/core';

import type { TextureIndex } from '../types/conversion';
import {
  resolveTexture,
  resolveReplaceableTexture,
  getReplaceableTextureVariants,
} from '../textures/texture-index';
import { blpToPngBuffer } from '../textures/blp-decoder';
import {
  readStaticNumeric,
  describeMaterialAlpha,
  createLayerMaterial,
} from '../materials/material-builder';
import { buildSkeleton } from '../skeleton/skeleton-builder';
import { buildGeosets } from '../geometry/geoset-builder';
import { exportAnimations } from '../animation/animation-exporter';

export interface ReplaceableVariantPlan {
  selections: ReadonlyMap<number, string>;
  suffix: string;
}

/**
 * Build every combination of registered variants used by an MDX model.
 *
 * TeamColor (1) and TeamGlow (2) are deliberately excluded: their preview
 * selection remains controlled by --team-color-index.
 *
 * Models without registered replaceable variants get one default plan.
 */
export function getReplaceableVariantPlans(
  mdxAbsPath: string
): ReplaceableVariantPlan[] {
  const buf = fs.readFileSync(mdxAbsPath);
  const model = parseMDX(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  );

  const replaceableIds = [
    ...new Set(
      (model.Textures || [])
        .map((texture) => Number(texture?.ReplaceableId ?? 0))
        .filter((id) => id > 0 && id !== 1 && id !== 2)
    ),
  ]
    .filter((id) => getReplaceableTextureVariants(id).length > 0)
    .sort((a, b) => a - b);

  if (replaceableIds.length === 0) {
    return [{ selections: new Map(), suffix: '' }];
  }

  // Build the Cartesian product of the registered variants for each ID.
  let combinations: Map<number, string>[] = [new Map()];

  for (const replaceableId of replaceableIds) {
    const variants = getReplaceableTextureVariants(replaceableId);
    const next: Map<number, string>[] = [];

    for (const combination of combinations) {
      for (const variant of variants) {
        const selection = new Map(combination);
        selection.set(replaceableId, variant.name);
        next.push(selection);
      }
    }

    combinations = next;
  }

  return combinations.map((selections) => {
    const suffixParts = replaceableIds.map((replaceableId) => {
      const variantName = selections.get(replaceableId)!;

      // Keep the simple, requested suffixes for single-ID models.
      // Include IDs when multiple replaceable types are combined.
      return replaceableIds.length === 1
        ? variantName
        : `R${replaceableId}_${variantName}`;
    });

    return {
      selections,
      suffix: `_${suffixParts.join('_')}`,
    };
  });
}

export async function convertOne(
  mdxAbsPath: string,
  relPath: string,
  textureIndex: TextureIndex,
  outDir: string,
  materialLayerMode: 'stack' | 'base',
  teamColorIndex: number,
  allowFuzzyTextureFallback: boolean,
  replaceableVariants: ReadonlyMap<number, string> = new Map(),
  outputSuffix = ''
): Promise<string> {
  const buf = fs.readFileSync(mdxAbsPath);
  const model = parseMDX(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

  const doc = new Document();
  const buffer = doc.createBuffer();

  // Textures — resolve paths conservatively and preserve replaceable-texture diagnostics.
  const textureSlots: (ReturnType<Document['createTexture']> | null)[] = [];
  const textureSourcePaths: (string | null)[] = [];
  const textures = model.Textures || [];
  let resolvedTextureCount = 0;
  const warnTexture = (message: string): void => {
    console.warn(`[Texture Warning] ${relPath}: ${message}`);
  };

  for (let ti = 0; ti < textures.length; ti++) {
    const textureEntry = textures[ti];
    const replaceableId = Number(textureEntry?.ReplaceableId ?? 0);
    let resolved = textureEntry?.Image
      ? resolveTexture(textureEntry.Image, textureIndex, relPath, warnTexture, allowFuzzyTextureFallback)
      : null;
    let resolutionKind = 'image path';

    // Replaceable textures have an empty Image by design. Resolve IDs 1/2 to
    // the extracted team-color/team-glow variants for this static preview.
    if (!resolved && replaceableId > 0) {
      resolved = resolveReplaceableTexture(
        replaceableId,
        teamColorIndex,
        textureIndex,
        relPath,
        warnTexture,
        replaceableVariants.get(replaceableId)
      );
      resolutionKind = `ReplaceableId ${replaceableId}` +
        (replaceableVariants.has(replaceableId)
          ? ` (${replaceableVariants.get(replaceableId)})`
          : ` (preview index ${teamColorIndex})`);
    }

    if (!resolved) {
      textureSlots.push(null);
      textureSourcePaths.push(null);
      if (replaceableId <= 0 && textureEntry?.Image) {
        warnTexture(`texture slot ${ti} could not resolve "${textureEntry.Image}"`);
      }
      continue;
    }

    try {
      const pngBuf = blpToPngBuffer(resolved);
      const tex = doc
        .createTexture(path.basename(resolved, '.blp'))
        .setMimeType('image/png')
        .setImage(new Uint8Array(pngBuf));
      textureSlots.push(tex);
      textureSourcePaths.push(resolved);
      resolvedTextureCount++;
      console.log(
        `[Texture] ${relPath}: slot ${ti} ${resolutionKind} ` +
        `"${textureEntry.Image || ''}" -> ${path.relative(textureIndex.root, resolved)}`
      );
    } catch (error: any) {
      textureSlots.push(null);
      textureSourcePaths.push(null);
      warnTexture(`failed to decode texture slot ${ti} (${resolved}): ${error?.message || String(error)}`);
    }
  }
  console.log(`[Texture] ${relPath}: ${resolvedTextureCount}/${textures.length} texture file(s) resolved`);

  // Materials — preserve each MDX layer as an ordered glTF primitive/material
  // pass. Core glTF cannot reproduce all Warcraft blend operations exactly,
  // but this is better than silently discarding every layer after Layers[0].
  const materials = model.Materials || [];
  const layerMaterialsByMaterial: ReturnType<Document['createMaterial']>[][] = [];
  for (let mi = 0; mi < materials.length; mi++) {
    const material = materials[mi];
    const layers = Array.isArray(material?.Layers) ? material.Layers : [];
    const exportedLayers: ReturnType<Document['createMaterial']>[] = [];

    console.log(`[Material] ${relPath}: material ${mi}, ${layers.length} layer(s)`);
    if (layers.length > 1) {
      if (materialLayerMode === 'base') {
        warnTexture(`material ${mi} has ${layers.length} layers; diagnostic mode exports only layer 0 and skips ${layers.length - 1} overlay layer(s)`);
      } else {
        warnTexture(`material ${mi} has ${layers.length} layers; exporting each as an ordered geometry pass. Non-core blend modes are approximations`);
      }
    }

    // Diagnostic mode isolates UV/texture assignment from MDX layer compositing.
    // Warcraft's material layers are a blend stack, not independent opaque copies
    // of the geoset. The full stack remains available for comparison, but should
    // not be treated as a faithful final implementation until compositing is baked.
    const layerCount = materialLayerMode === 'base' ? Math.min(layers.length, 1) : layers.length;
    for (let li = 0; li < layerCount; li++) {
      const layer = layers[li];
      const textureId = Math.trunc(readStaticNumeric(layer?.TextureID, 0));
      const coordId = Math.max(0, Math.trunc(readStaticNumeric(layer?.CoordId, 0)));
      const filterMode = Math.trunc(readStaticNumeric(layer?.FilterMode, 0));
      const sourceTexture = textures[textureId];
      console.log(
        `[Material] ${relPath}: material ${mi} layer ${li}: TextureID=${textureId}, ` +
        `image="${sourceTexture?.Image || ''}", ` +
        `resolved="${textureSourcePaths[textureId] ? path.relative(textureIndex.root, textureSourcePaths[textureId]!) : '(unresolved/replaceable)'}", ` +
        `ReplaceableId=${Number(sourceTexture?.ReplaceableId ?? 0)}, CoordId=${coordId}, ` +
        `FilterMode=${filterMode}, Alpha=${describeMaterialAlpha(layer?.Alpha)}`
      );

      const gltfMaterial = createLayerMaterial(
        doc, mi, li, layer, textures, textureSlots, warnTexture
      );
      if (gltfMaterial) exportedLayers.push(gltfMaterial);
    }

    if (exportedLayers.length === 0) {
      const fallback = doc.createMaterial(`mat_${mi}_untextured`)
        .setMetallicFactor(0)
        .setRoughnessFactor(1);
      exportedLayers.push(fallback);
      if (layers.length > 0) warnTexture(`material ${mi} has no layer with a resolved texture; using an untextured fallback material`);
    }
    layerMaterialsByMaterial.push(exportedLayers);
  }
  if (layerMaterialsByMaterial.length === 0) {
    layerMaterialsByMaterial.push([
      doc.createMaterial('default').setMetallicFactor(0).setRoughnessFactor(1),
    ]);
  }

  // Bones & Nodes
  const {
    nodeByObjectId,
    localPivotByObjectId,
    allNodes,
    skin,
    bones,
  } = buildSkeleton(doc, buffer, model, relPath);

  // Geosets
  const meshNodes = buildGeosets(model, {
    doc,
    buffer,
    relPath,
    skin,
    bones,
    allNodes,
    layerMaterialsByMaterial,
    warnTexture,
  });

  // Animation
  exportAnimations(
    doc,
    buffer,
    model,
    allNodes,
    nodeByObjectId,
    localPivotByObjectId,
    relPath
  );

  // Scene
  const scene = doc.createScene(model.Info?.Name || 'Scene');
  for (const n of allNodes.filter(n => n.Parent == null || n.Parent < 0 || !nodeByObjectId.has(n.Parent))) {
    const gn = nodeByObjectId.get(n.ObjectId);
    if (gn) scene.addChild(gn);
  }
  for (const mn of meshNodes) scene.addChild(mn);
  doc.getRoot().setDefaultScene(scene);

  // Output GLB
  const outRel = relPath.replace(/\.mdx$/i, `${outputSuffix}.glb`);
  const outAbs = path.join(outDir, outRel);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });

  const io = new NodeIO();
  const glbBytes = await io.writeBinary(doc);
  fs.writeFileSync(outAbs, Buffer.from(glbBytes));

  return outAbs;
}
