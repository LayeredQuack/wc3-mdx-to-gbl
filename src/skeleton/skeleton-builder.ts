/**
 * Construct the glTF node hierarchy, pivots, bones, inverse bind matrices,
 * and skin from MDX skeleton data.
 */

import { Document } from '@gltf-transform/core';
import { wc3ToGltfVec3 } from '../geometry/coordinate-conversion';

/**
 * Get a node's MDX model-space pivot. war3-model normally exposes PivotPoint
 * directly on the node; PivotPoints is retained as a compatibility fallback.
 */
export function getMdxNodePivot(node: any, model: any): Float32Array {
  const direct = node?.PivotPoint;
  const indexed = model?.PivotPoints?.[node?.ObjectId];
  const valid = (v: any): boolean =>
    !!v && v.length >= 3 && Number.isFinite(Number(v[0])) &&
    Number.isFinite(Number(v[1])) && Number.isFinite(Number(v[2]));

  if (valid(direct)) {
    const directVec = [Number(direct[0]), Number(direct[1]), Number(direct[2])];
    const indexedVec = valid(indexed)
      ? [Number(indexed[0]), Number(indexed[1]), Number(indexed[2])]
      : null;
    // Some parser/model variants leave Node.PivotPoint zeroed while retaining
    // the PIVT table. Prefer a non-zero indexed pivot in that case.
    const directIsZero = directVec.every(v => Math.abs(v) < 1e-8);
    const indexedIsNonZero = !!indexedVec && indexedVec.some(v => Math.abs(v) >= 1e-8);
    const chosen = directIsZero && indexedIsNonZero ? indexedVec! : directVec;
    return new Float32Array(chosen);
  }

  if (valid(indexed)) {
    return new Float32Array([Number(indexed[0]), Number(indexed[1]), Number(indexed[2])]);
  }

  return new Float32Array([0, 0, 0]);
}

/** Subtract two 3D vectors, returning a fresh vector. */
export function subtractVec3(a: ArrayLike<number>, b: ArrayLike<number>): Float32Array {
  return new Float32Array([
    Number(a[0]) - Number(b[0]),
    Number(a[1]) - Number(b[1]),
    Number(a[2]) - Number(b[2])
  ]);
}

/**
 * Build a glTF inverse-bind matrix for a joint whose bind-pose world transform
 * is a pure translation to its MDX pivot. glTF MAT4 accessors are column-major.
 */
export function writeInversePivotMatrix(
  target: Float32Array,
  offset: number,
  pivotGltf: ArrayLike<number>
): void {
  target[offset + 0] = 1;
  target[offset + 5] = 1;
  target[offset + 10] = 1;
  target[offset + 12] = -Number(pivotGltf[0]);
  target[offset + 13] = -Number(pivotGltf[1]);
  target[offset + 14] = -Number(pivotGltf[2]);
  target[offset + 15] = 1;
}

export interface SkeletonBuildResult {
  nodeByObjectId: Map<number, ReturnType<Document['createNode']>>;
  pivotByObjectId: Map<number, Float32Array>;
  localPivotByObjectId: Map<number, Float32Array>;
  allNodes: any[];
  skin: ReturnType<Document['createSkin']> | null;
  bones: any[];
  helpers: any[];
}

/**
 * Build the full MDX node hierarchy (bones + helpers + other nodes) and
 * optional skin with pivot-derived inverse bind matrices.
 */
export function buildSkeleton(
  doc: Document,
  buffer: ReturnType<Document['createBuffer']>,
  model: any,
  relPath: string
): SkeletonBuildResult {
  const bones = model.Bones || [];
  const helpers = model.Helpers || [];
  // war3-model stores every MDX object node (bones, helpers, attachments,
  // emitters, lights, event objects, etc.) in model.Nodes indexed by ObjectId.
  // Use that complete list so a bone whose parent is not itself a Bone/Helper
  // retains the correct ancestor chain and can still receive transform tracks.
  const parsedNodes = Array.isArray(model.Nodes)
    ? model.Nodes.filter((n: any) => !!n && Number.isInteger(n.ObjectId))
    : [];
  const allNodes = parsedNodes.length > 0 ? parsedNodes : [...bones, ...helpers];
  const nodeByObjectId = new Map<number, ReturnType<Document['createNode']>>();
  const pivotByObjectId = new Map<number, Float32Array>();
  const localPivotByObjectId = new Map<number, Float32Array>();

  for (const n of allNodes) {
    const pivot = getMdxNodePivot(n, model);
    pivotByObjectId.set(n.ObjectId, pivot);

    // glTF's ordinary node hierarchy always inherits parent TRS. MDX can
    // selectively disable translation, rotation, or scale inheritance; those
    // flags need a dedicated proxy/baked-transform strategy and are reported
    // rather than silently treated as equivalent.
    const flags = Number(n.Flags ?? 0);
    const noInherit: string[] = [];
    if (flags & 0x1) noInherit.push('translation');
    if (flags & 0x2) noInherit.push('rotation');
    if (flags & 0x4) noInherit.push('scale');
    if (noInherit.length > 0) {
      console.warn(`[Skeleton Warning] ${relPath}: node ${n.ObjectId} (${n.Name || 'unnamed'}) disables parent ${noInherit.join('/')} inheritance; Stage 2 currently uses standard glTF parent inheritance for this node`);
    }
  }

  let missingParentCount = 0;
  for (const n of allNodes) {
    const gnode = doc.createNode(n.Name || `node_${n.ObjectId}`);
    nodeByObjectId.set(n.ObjectId, gnode);

    const pivot = pivotByObjectId.get(n.ObjectId)!;
    const parentPivot = n.Parent != null && n.Parent >= 0
      ? pivotByObjectId.get(n.Parent)
      : undefined;

    // MDX pivot positions are model-space coordinates. Convert them to local
    // offsets relative to the parent's pivot; root nodes use their model pivot.
    // This makes the bind-pose world transform of each node T(pivot).
    if (n.Parent != null && n.Parent >= 0 && !parentPivot) missingParentCount++;
    const localPivotMdx = parentPivot ? subtractVec3(pivot, parentPivot) : pivot;
    const localPivotGltf = wc3ToGltfVec3(localPivotMdx);
    localPivotByObjectId.set(n.ObjectId, localPivotGltf);
    gnode.setTranslation([localPivotGltf[0], localPivotGltf[1], localPivotGltf[2]]);
  }

  for (const n of allNodes) {
    const gnode = nodeByObjectId.get(n.ObjectId)!;
    if (n.Parent != null && n.Parent >= 0) {
      const parent = nodeByObjectId.get(n.Parent);
      if (parent) parent.addChild(gnode);
    }
  }

  const nonZeroPivotCount = [...pivotByObjectId.values()].filter(
    p => Math.abs(p[0]) > 1e-8 || Math.abs(p[1]) > 1e-8 || Math.abs(p[2]) > 1e-8
  ).length;
  console.log(`[Skeleton] ${relPath}: ${bones.length} bone(s), ${helpers.length} helper(s), ${nonZeroPivotCount} non-zero pivot(s)`);
  if (missingParentCount > 0) {
    console.warn(`[Skeleton Warning] ${relPath}: ${missingParentCount} node(s) reference a parent ObjectId absent from model.Nodes; those nodes were rooted at their model-space pivot`);
  }
  if (model.BindPoses?.length) {
    console.warn(`[Skeleton Warning] ${relPath}: ${model.BindPoses.length} BPOS bind-pose record(s) detected; this Stage 2 path currently reconstructs classic pivot bind poses and does not yet decode Reforged BPOS matrices`);
  }

  // Skin setup. The inverse bind matrix is the inverse of the bind-pose world
  // transform. With MDX's pivot hierarchy, that rest transform is T(pivot).
  let skin: ReturnType<Document['createSkin']> | null = null;
  if (bones.length > 0) {
    skin = doc.createSkin('Armature');
    for (const b of bones) {
      const jn = nodeByObjectId.get(b.ObjectId);
      if (jn) skin.addJoint(jn);
    }

    const ibmData = new Float32Array(bones.length * 16);
    for (let i = 0; i < bones.length; i++) {
      const pivotMdx = pivotByObjectId.get(bones[i].ObjectId) || new Float32Array([0, 0, 0]);
      const pivotGltf = wc3ToGltfVec3(pivotMdx);
      writeInversePivotMatrix(ibmData, i * 16, pivotGltf);
    }
    skin.setInverseBindMatrices(
      doc.createAccessor('IBM').setType('MAT4').setArray(ibmData).setBuffer(buffer)
    );
    console.log(`[Skeleton] ${relPath}: generated ${bones.length} pivot-derived inverse bind matrix/matrices`);
  }

  return {
    nodeByObjectId,
    pivotByObjectId,
    localPivotByObjectId,
    allNodes,
    skin,
    bones,
    helpers,
  };
}

/**
 * Pick the highest bone joint in the hierarchy for malformed-group fallback,
 * walking through non-bone ancestors such as Helpers.
 */
export function findRootBoneIndex(bones: any[], jointIndex: Map<number, number>, allNodes: any[]): number {
  for (let bi = 0; bi < bones.length; bi++) {
    let parentId = bones[bi].Parent;
    let hasBoneAncestor = false;
    const visited = new Set<number>();
    while (parentId != null && parentId >= 0 && !visited.has(parentId)) {
      visited.add(parentId);
      if (jointIndex.has(parentId)) {
        hasBoneAncestor = true;
        break;
      }
      const parentNode = allNodes.find(n => n.ObjectId === parentId);
      if (!parentNode) break;
      parentId = parentNode.Parent;
    }
    if (!hasBoneAncestor) return bi;
  }
  return 0;
}
