/**
 * Turn MDX geosets into glTF geometry, primitives, skinning attributes,
 * and mesh nodes.
 */

import { Document, Primitive } from '@gltf-transform/core';
import { wc3ToGltfVec3 } from './coordinate-conversion';
import { findRootBoneIndex } from '../skeleton/skeleton-builder';

export interface GeosetBuildContext {
  doc: Document;
  buffer: ReturnType<Document['createBuffer']>;
  relPath: string;
  skin: ReturnType<Document['createSkin']> | null;
  bones: any[];
  allNodes: any[];
  layerMaterialsByMaterial: ReturnType<Document['createMaterial']>[][];
  warnTexture: (message: string) => void;
}

/**
 * Build all geoset mesh nodes for a model and return them for scene attachment.
 */
export function buildGeosets(
  model: any,
  ctx: GeosetBuildContext
): ReturnType<Document['createNode']>[] {
  const { doc, buffer, relPath, skin, bones, allNodes, layerMaterialsByMaterial, warnTexture } = ctx;
  const geosets = model.Geosets || [];
  const meshNodes: ReturnType<Document['createNode']>[] = [];
  const jointIndex = new Map<number, number>();
  bones.forEach((b, i) => jointIndex.set(b.ObjectId, i));

  for (let gi = 0; gi < geosets.length; gi++) {
    const g = geosets[gi];
    const positions = g.Vertices;
    const normals = g.Normals;
    const uvSets: ArrayLike<number>[] = Array.isArray(g.TVertices) ? g.TVertices : [];
    const indices = g.Faces;

    if (!positions || !indices || positions.length < 3) continue;
    const vertCount = positions.length / 3;

    const prim = doc
      .createPrimitive()
      .setAttribute(
        'POSITION',
        doc.createAccessor(`pos_${gi}`).setType('VEC3').setArray(wc3ToGltfVec3(positions)).setBuffer(buffer)
      )
      .setIndices(
        doc.createAccessor(`idx_${gi}`).setType('SCALAR').setArray(new Uint16Array(indices)).setBuffer(buffer)
      );

    if (normals && normals.length === positions.length) {
      prim.setAttribute(
        'NORMAL',
        doc.createAccessor(`norm_${gi}`).setType('VEC3').setArray(wc3ToGltfVec3(normals)).setBuffer(buffer)
      );
    }

    const validUvSetIndices = new Set<number>();
    for (let uvIndex = 0; uvIndex < uvSets.length; uvIndex++) {
      const uvs = uvSets[uvIndex];
      if (!uvs || uvs.length !== vertCount * 2) {
        console.warn(`[Texture Warning] ${relPath} geoset ${gi}: UV set ${uvIndex} has ${uvs?.length ?? 0} values; expected ${vertCount * 2}; set skipped`);
        continue;
      }
      const flipped = new Float32Array(uvs.length);
      for (let i = 0; i < vertCount; i++) {
        // war3-model already yields glTF-compatible UVs (V=0 at top).
        // Do not invert V; a previous 1-v flip was the source of the
        // scrambled texture mapping on ForestTroll and similar models.
        flipped[i * 2]     = Number(uvs[i * 2]);
        flipped[i * 2 + 1] = Number(uvs[i * 2 + 1]);
      }

      prim.setAttribute(
        `TEXCOORD_${uvIndex}`,
        doc.createAccessor(`uv_${gi}_${uvIndex}`).setType('VEC2').setArray(flipped).setBuffer(buffer)
      );
      validUvSetIndices.add(uvIndex);
    }

    let hasSkinningAttributes = false;
    if (skin && g.VertexGroup && g.Groups && g.Groups.length > 0) {
      const joints = new Uint16Array(vertCount * 4);
      const weights = new Float32Array(vertCount * 4);
      const rootBoneIndex = findRootBoneIndex(bones, jointIndex, allNodes);
      let invalidGroupReferences = 0;
      let invalidBoneReferences = 0;
      let fallbackVertexCount = 0;
      let truncatedInfluenceGroups = 0;

      for (let v = 0; v < vertCount; v++) {
        const groupIdx = Number(g.VertexGroup[v]);
        const boneIds = Number.isInteger(groupIdx) ? (g.Groups[groupIdx] || []) : [];
        if (!g.Groups[groupIdx]) invalidGroupReferences++;
        if (boneIds.length > 4) truncatedInfluenceGroups++;

        const nInf = Math.min(boneIds.length, 4);
        let wSum = 0;
        let validSlot = 0;
        for (let k = 0; k < nInf; k++) {
          // Classic MDX MATS entries refer to node ObjectIds, not glTF joint indices.
          const jIdx = jointIndex.get(Number(boneIds[k]));
          if (jIdx != null) {
            joints[v * 4 + validSlot] = jIdx;
            weights[v * 4 + validSlot] = 1;
            wSum += 1;
            validSlot++;
          } else {
            invalidBoneReferences++;
          }
        }

        if (wSum > 0) {
          for (let k = 0; k < 4; k++) weights[v * 4 + k] /= wSum;
        } else {
          // Preserve a valid, normalized influence but make the fallback visible
          // in diagnostics instead of silently masking malformed group data.
          joints[v * 4] = rootBoneIndex;
          weights[v * 4] = 1;
          fallbackVertexCount++;
        }
      }

      prim.setAttribute(
        'JOINTS_0',
        doc.createAccessor(`joints_${gi}`).setType('VEC4').setArray(joints).setBuffer(buffer)
      );
      prim.setAttribute(
        'WEIGHTS_0',
        doc.createAccessor(`weights_${gi}`).setType('VEC4').setArray(weights).setBuffer(buffer)
      );
      hasSkinningAttributes = true;

      if (invalidGroupReferences > 0 || invalidBoneReferences > 0 || fallbackVertexCount > 0 || truncatedInfluenceGroups > 0) {
        console.warn(
          `[Skin Warning] ${relPath} geoset ${gi}: ${invalidGroupReferences} invalid vertex-group reference(s), ` +
          `${invalidBoneReferences} unresolved bone ObjectId reference(s), ${fallbackVertexCount} fallback vertex/vertices, ` +
          `${truncatedInfluenceGroups} group(s) with more than four influences`
        );
      }
    }

    if (g.SkinWeights && g.SkinWeights.length > 0) {
      console.warn(`[Skin Warning] ${relPath} geoset ${gi}: Reforged SkinWeights data is present but not yet decoded; this Stage 2 converter currently uses classic VertexGroup/Groups skinning`);
    }

    const rawMatId = Number(g.MaterialID ?? 0);
    const matId = Number.isInteger(rawMatId) && rawMatId >= 0 && rawMatId < layerMaterialsByMaterial.length
      ? rawMatId
      : 0;
    if (matId !== rawMatId) {
      warnTexture(`geoset ${gi} references invalid MaterialID ${rawMatId}; material 0 fallback used`);
    }

    const geosetLayers = layerMaterialsByMaterial[matId] || layerMaterialsByMaterial[0];
    const requestedCoordIds = geosetLayers
      .map((material) => Number((material.getExtras() as any)?.warcraft3?.coordId ?? 0));
    for (const coordId of requestedCoordIds) {
      if (!validUvSetIndices.has(coordId)) {
        warnTexture(`geoset ${gi} uses material UV set ${coordId}, but that UV set is not available on this geoset; available sets: ${[...validUvSetIndices].join(', ') || '(none)'}`);
      }
    }
    console.log(`[Texture] ${relPath}: geoset ${gi}, MaterialID=${matId}, UV sets=[${[...validUvSetIndices].join(', ')}], material passes=${geosetLayers.length}`);

    prim.setMode(Primitive.Mode.TRIANGLES);
    const mesh = doc.createMesh(`geoset_${gi}`);
    geosetLayers.forEach((layerMaterial, layerPassIndex) => {
      // A material's layers are rendered in order on the same geoset. Reuse
      // the exact same geometry/skin accessors for each pass.
      const layerPrimitive = layerPassIndex === 0
        ? prim
        : prim.clone() as ReturnType<Document['createPrimitive']>;
      layerPrimitive.setMaterial(layerMaterial);
      mesh.addPrimitive(layerPrimitive);
    });

    const meshNode = doc.createNode(`mesh_${gi}`).setMesh(mesh);
    if (skin && hasSkinningAttributes) meshNode.setSkin(skin);
    meshNodes.push(meshNode);
  }

  return meshNodes;
}
