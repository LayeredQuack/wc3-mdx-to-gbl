import * as fs from 'fs';
import * as path from 'path';
import { parseMDX, decodeBLP, getBLPImageData } from 'war3-model';
import { PNG } from 'pngjs';
import { Document, NodeIO, Primitive } from '@gltf-transform/core';

interface ConversionRecord {
  filePath: string;
  bytes: number;
  status: 'success' | 'skipped' | 'error';
  errorMsg?: string;
}

class ModelConversionReporter {
  private successCount = 0;
  private skippedCount = 0;
  private errorCount = 0;
  private records: ConversionRecord[] = [];

  public logSuccess(filePath: string, bytes: number): void {
    this.successCount++;
    this.records.push({ filePath, bytes, status: 'success' });
  }

  public logSkipped(filePath: string, reason: string): void {
    this.skippedCount++;
    console.warn(`[Skipped] ${reason}: ${filePath}`);
    this.records.push({ filePath, bytes: 0, status: 'skipped' });
  }

  public logError(filePath: string, errorMsg: string): void {
    this.errorCount++;
    console.error(`[Error] Failed to convert ${filePath}: ${errorMsg}`);
    this.records.push({ filePath, bytes: 0, status: 'error', errorMsg });
  }

  public generateReport(inputDir: string, outputDir: string): string {
    let report = '\n========================================\n';
    report += '         MODEL CONVERSION REPORT        \n';
    report += '========================================\n';
    report += `Timestamp           : ${new Date().toISOString()}\n`;
    report += `Input Directory     : ${inputDir}\n`;
    report += `Output Directory    : ${outputDir}\n`;
    report += `Total Successful    : ${this.successCount}\n`;
    report += `Total Skipped       : ${this.skippedCount}\n`;
    report += `Total Errors        : ${this.errorCount}\n`;
    report += '----------------------------------------\n';

    if (this.records.length > 0) {
      report += '\nProcessed Files Sample:\n';
      this.records.slice(0, 10).forEach((rec) => {
        report += `  [${rec.status.toUpperCase()}] ${rec.filePath} (${rec.bytes} bytes)\n`;
      });
      if (this.records.length > 10) {
        report += `  ... and ${this.records.length - 10} more files.\n`;
      }
    }
    report += '\n========================================\n';
    return report;
  }
}

// ── Texture Indexing & Resolution ──────────────────────────────────────────
interface TextureIndex {
  fullRel: Map<string, string>;
  byBase: Map<string, string[]>;
  byTop: Map<string, Map<string, string>>;
}

function buildTextureIndex(root: string): TextureIndex {
  const fullRel = new Map<string, string>();
  const byBase = new Map<string, string[]>();
  const byTop = new Map<string, Map<string, string>>();

  function walk(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      if (!e.name.toLowerCase().endsWith('.blp')) continue;

      const rel = path.relative(root, full).split(path.sep).join('/');
      const base = e.name.toLowerCase();
      const top = rel.split('/')[0].toLowerCase();

      fullRel.set(rel.toLowerCase(), full);

      if (!byBase.has(base)) byBase.set(base, []);
      byBase.get(base)!.push(full);

      if (!byTop.has(top)) byTop.set(top, new Map());
      const tm = byTop.get(top)!;
      tm.set(base, full);
      tm.set(base.replace(/\.blp$/i, ''), full);
    }
  }
  walk(root);
  return { fullRel, byBase, byTop };
}

function rankTexturePath(absPath: string): number {
  const lower = absPath.replace(/\\/g, '/').toLowerCase();
  if (lower.includes('/war3patch')) return 0;
  if (lower.includes('/war3x')) return 1;
  if (lower.includes('/war3_') || lower.includes('/war3/')) return 2;
  return 10;
}

function pickBest(paths: string[]): string {
  return paths.slice().sort((a, b) => rankTexturePath(a) - rankTexturePath(b))[0];
}

function resolveTexture(texPath: string | undefined, index: TextureIndex, mdxRelPath?: string): string | null {
  if (!texPath || !texPath.trim()) return null;
  const normalized = texPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const lower = normalized.toLowerCase();
  const base = path.basename(lower);
  const baseNoExt = base.replace(/\.blp$/i, '');

  if (index.fullRel.has(lower)) return index.fullRel.get(lower)!;

  if (mdxRelPath) {
    const top = mdxRelPath.split('/')[0].toLowerCase();
    const topMap = index.byTop.get(top);
    if (topMap) {
      if (topMap.has(base)) return topMap.get(base)!;
      if (topMap.has(baseNoExt)) return topMap.get(baseNoExt)!;
      const underTop = `${top}/${lower}`;
      if (index.fullRel.has(underTop)) return index.fullRel.get(underTop)!;
    }
  }

  const hits = index.byBase.get(base) || [];
  if (hits.length) return pickBest(hits);

  return null;
}

function blpToPngBuffer(blpPath: string): Buffer {
  const raw = fs.readFileSync(blpPath);
  const blp = decodeBLP(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  const img = getBLPImageData(blp, 0);
  const png = new PNG({ width: img.width, height: img.height });
  for (let i = 0; i < img.data.length; i++) png.data[i] = img.data[i];
  return PNG.sync.write(png);
}

/** WC3 Z-up → glTF Y-up: (x,y,z) → (x, z, -y) */
function wc3ToGltfVec3(src: ArrayLike<number>): Float32Array {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    out[i] = src[i];
    out[i + 1] = src[i + 2];
    out[i + 2] = -src[i + 1];
  }
  return out;
}

/** WC3 Rotation Quaternion conversion to glTF axis layout */
function wc3ToGltfQuat(src: ArrayLike<number>): Float32Array {
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
function wc3ToGltfScale(src: ArrayLike<number>): Float32Array {
  return new Float32Array([src[0], src[2], src[1]]);
}

interface MdxAnimationKey {
  Frame: number;
  Vector: ArrayLike<number>;
}

interface MdxAnimationTrack {
  LineType?: number;
  GlobalSeqId?: number;
  Keys?: MdxAnimationKey[];
}

type GltfTransformPath = 'translation' | 'rotation' | 'scale';
type GltfAccessorType = 'VEC3' | 'VEC4';
type GltfInterpolation = 'STEP' | 'LINEAR';

/**
 * MDX line types: DontInterp=0, Linear=1, Hermite=2, Bezier=3.
 * Stage 1 maps the first two exactly. Hermite/Bezier are temporarily sampled
 * linearly; their tangent-aware conversion is deliberately reserved for Stage 3.
 */
function getGltfInterpolation(
  track: MdxAnimationTrack,
  warn: (message: string) => void
): GltfInterpolation {
  switch (track.LineType) {
    case 0:
      return 'STEP';
    case 1:
    case undefined:
      return 'LINEAR';
    case 2:
      warn('MDX Hermite interpolation found; exported as LINEAR for Stage 1 (tangent support is pending)');
      return 'LINEAR';
    case 3:
      warn('MDX Bezier interpolation found; exported as LINEAR for Stage 1 (tangent support is pending)');
      return 'LINEAR';
    default:
      warn(`Unknown MDX interpolation type ${track.LineType}; exported as LINEAR`);
      return 'LINEAR';
  }
}

/**
 * Export one MDX transform track into a glTF animation channel.
 * war3-model exposes animation tracks as { Keys: [{ Frame, Vector, ... }] }.
 */
function addMdxAnimationTrack(
  doc: Document,
  buffer: ReturnType<Document['createBuffer']>,
  animation: ReturnType<Document['createAnimation']>,
  targetNode: ReturnType<Document['createNode']>,
  track: MdxAnimationTrack | undefined,
  sequenceStart: number,
  sequenceEnd: number,
  globalSequenceCount: number,
  targetPath: GltfTransformPath,
  accessorType: GltfAccessorType,
  componentCount: 3 | 4,
  convert: (value: ArrayLike<number>) => ArrayLike<number>,
  accessorName: string,
  warn: (message: string) => void
): boolean {
  if (!track?.Keys?.length) return false;

  // Global-sequence tracks run on their own clock, not the active sequence clock.
  // Some parsers expose the MDX no-global-sequence sentinel as 0xFFFFFFFF,
  // while others normalize it to -1/undefined. Only treat an in-range ID as valid.
  const globalSeqId = track.GlobalSeqId;
  if (
    typeof globalSeqId === 'number' &&
    Number.isInteger(globalSeqId) &&
    globalSeqId >= 0 &&
    globalSeqId !== 0xFFFFFFFF
  ) {
    if (globalSeqId < globalSequenceCount) {
      warn(`Global-sequence track (${globalSeqId}) on ${accessorName} skipped; global-sequence support is pending`);
    } else {
      warn(`Track ${accessorName} references missing global sequence ${globalSeqId}; track skipped`);
    }
    return false;
  }

  // A Map both sorts frames and guarantees strictly increasing glTF input times.
  // If an MDX file repeats a frame, keep the last key at that frame.
  const keysByFrame = new Map<number, MdxAnimationKey>();
  let duplicateFrameCount = 0;

  for (const key of track.Keys) {
    if (!Number.isFinite(key.Frame)) continue;
    if (key.Frame < sequenceStart || key.Frame > sequenceEnd) continue;
    if (keysByFrame.has(key.Frame)) duplicateFrameCount++;
    keysByFrame.set(key.Frame, key);
  }

  if (duplicateFrameCount > 0) {
    warn(`${duplicateFrameCount} duplicate animation frame(s) on ${accessorName}; last key at each frame retained`);
  }

  const sortedKeys = [...keysByFrame.values()].sort((a, b) => a.Frame - b.Frame);
  if (sortedKeys.length === 0) return false;

  const samples: Array<{ frame: number; values: number[] }> = [];
  let invalidKeyCount = 0;
  let invalidQuaternionCount = 0;

  for (const key of sortedKeys) {
    if (!key.Vector || key.Vector.length < componentCount) {
      invalidKeyCount++;
      continue;
    }

    const converted = convert(key.Vector);
    const values = Array.from({ length: componentCount }, (_, i) => Number(converted[i]));
    if (!values.every(Number.isFinite)) {
      invalidKeyCount++;
      continue;
    }

    // glTF requires normalized quaternion values.
    if (targetPath === 'rotation') {
      const length = Math.hypot(values[0], values[1], values[2], values[3]);
      if (length > 1e-8) {
        for (let i = 0; i < 4; i++) values[i] /= length;
      } else {
        values[0] = 0;
        values[1] = 0;
        values[2] = 0;
        values[3] = 1;
        invalidQuaternionCount++;
      }
    }

    samples.push({ frame: key.Frame, values });
  }

  if (invalidKeyCount > 0) {
    warn(`${invalidKeyCount} malformed keyframe(s) on ${accessorName} were skipped`);
  }
  if (invalidQuaternionCount > 0) {
    warn(`${invalidQuaternionCount} zero-length quaternion(s) on ${accessorName} replaced with identity`);
  }
  if (samples.length === 0) return false;

  const times = new Float32Array(samples.length);
  const values = new Float32Array(samples.length * componentCount);

  samples.forEach((sample, sampleIndex) => {
    // Warcraft III MDX animation frames are milliseconds; glTF uses seconds.
    times[sampleIndex] = (sample.frame - sequenceStart) / 1000.0;
    for (let component = 0; component < componentCount; component++) {
      values[sampleIndex * componentCount + component] = sample.values[component];
    }
  });

  const input = doc.createAccessor(`${accessorName}_time`)
    .setType('SCALAR')
    .setArray(times)
    .setBuffer(buffer);

  const output = doc.createAccessor(`${accessorName}_values`)
    .setType(accessorType)
    .setArray(values)
    .setBuffer(buffer);

  const sampler = doc.createAnimationSampler(`${accessorName}_sampler`)
    .setInput(input)
    .setOutput(output)
    .setInterpolation(getGltfInterpolation(track, warn));

  const channel = doc.createAnimationChannel(`${accessorName}_channel`)
    .setTargetNode(targetNode)
    .setTargetPath(targetPath)
    .setSampler(sampler);

  animation.addSampler(sampler);
  animation.addChannel(channel);
  return true;
}

function getFilesRecursive(dir: string, ext: string, fileList: string[] = []): string[] {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      getFilesRecursive(fullPath, ext, fileList);
    } else if (fullPath.toLowerCase().endsWith(ext)) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

// ── Standalone Conversion Pipeline ────────────────────────────────────────
async function convertOne(mdxAbsPath: string, relPath: string, textureIndex: TextureIndex, outDir: string): Promise<string> {
  const buf = fs.readFileSync(mdxAbsPath);
  const model = parseMDX(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

  const doc = new Document();
  const buffer = doc.createBuffer();

  // Textures
  const textureSlots: (ReturnType<Document['createTexture']> | null)[] = [];
  const textures = model.Textures || [];
  for (const t of textures) {
    const resolved = resolveTexture(t.Image, textureIndex, relPath);
    if (!resolved) {
      textureSlots.push(null);
      continue;
    }
    try {
      const pngBuf = blpToPngBuffer(resolved);
      const tex = doc
        .createTexture(path.basename(resolved, '.blp'))
        .setMimeType('image/png')
        .setImage(new Uint8Array(pngBuf));
      textureSlots.push(tex);
    } catch {
      textureSlots.push(null);
    }
  }

  // Materials
  const materials = model.Materials || [];
  const gltfMaterials: ReturnType<Document['createMaterial']>[] = [];
  for (let mi = 0; mi < materials.length; mi++) {
    const mat = materials[mi];
    const layer = (mat.Layers && mat.Layers[0]) || null;
    const gmat = doc.createMaterial(`mat_${mi}`);
    gmat.setMetallicFactor(0);
    gmat.setRoughnessFactor(1);

    if (layer) {
      const texId = typeof layer.TextureID === 'number' ? layer.TextureID : 0;
      const tex = textureSlots[texId] ?? null;
      if (tex) gmat.setBaseColorTexture(tex);
      const fm = layer.FilterMode ?? 0;
      if (fm === 1) gmat.setAlphaMode('MASK').setAlphaCutoff(0.75);
      else if (fm >= 2) gmat.setAlphaMode('BLEND');
    }
    gltfMaterials.push(gmat);
  }
  if (!gltfMaterials.length) {
    gltfMaterials.push(doc.createMaterial('default').setMetallicFactor(0).setRoughnessFactor(1));
  }

  // Bones & Nodes
  const bones = model.Bones || [];
  const helpers = model.Helpers || [];
  const allNodes = [...bones, ...helpers];
  const nodeByObjectId = new Map<number, ReturnType<Document['createNode']>>();

  for (const n of allNodes) {
    const gnode = doc.createNode(n.Name || `node_${n.ObjectId}`);
    nodeByObjectId.set(n.ObjectId, gnode);

    // Keep glTF's neutral local TRS defaults here. MDX animated TRS values are
    // exported as sequence channels below. Pivot-aware bind-pose reconstruction
    // is intentionally handled in Stage 2 rather than guessed in Stage 1.
  }

  for (const n of allNodes) {
    const gnode = nodeByObjectId.get(n.ObjectId)!;
    if (n.Parent != null && n.Parent >= 0) {
      const parent = nodeByObjectId.get(n.Parent);
      if (parent) parent.addChild(gnode);
    }
  }

  // Skin Setup
  let skin: ReturnType<Document['createSkin']> | null = null;
  if (bones.length > 0) {
    skin = doc.createSkin('Armature');
    for (const b of bones) {
      const jn = nodeByObjectId.get(b.ObjectId);
      if (jn) skin.addJoint(jn);
    }
    const ibmData = new Float32Array(bones.length * 16);
    for (let i = 0; i < bones.length; i++) {
      ibmData[i * 16 + 0] = 1;
      ibmData[i * 16 + 5] = 1;
      ibmData[i * 16 + 10] = 1;
      ibmData[i * 16 + 15] = 1;
    }
    skin.setInverseBindMatrices(
      doc.createAccessor('IBM').setType('MAT4').setArray(ibmData).setBuffer(buffer)
    );
  }

  // Geosets
  const geosets = model.Geosets || [];
  const meshNodes: ReturnType<Document['createNode']>[] = [];
  const jointIndex = new Map<number, number>();
  bones.forEach((b, i) => jointIndex.set(b.ObjectId, i));

  for (let gi = 0; gi < geosets.length; gi++) {
    const g = geosets[gi];
    const positions = g.Vertices;
    const normals = g.Normals;
    const uvs = g.TVertices && g.TVertices.length > 0 ? g.TVertices[0] : null;
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

    if (uvs && uvs.length === vertCount * 2) {
      const flipped = new Float32Array(uvs.length);
      for (let i = 0; i < vertCount; i++) {
        flipped[i * 2] = uvs[i * 2];
        flipped[i * 2 + 1] = 1 - uvs[i * 2 + 1];
      }
      prim.setAttribute(
        'TEXCOORD_0',
        doc.createAccessor(`uv_${gi}`).setType('VEC2').setArray(flipped).setBuffer(buffer)
      );
    }

    if (skin && g.VertexGroup && g.Groups && g.Groups.length > 0) {
      const joints = new Uint16Array(vertCount * 4);
      const weights = new Float32Array(vertCount * 4);
      for (let v = 0; v < vertCount; v++) {
        const groupIdx = g.VertexGroup[v];
        const boneIds = g.Groups[groupIdx] || [];
        const nInf = Math.min(boneIds.length, 4);
        let wSum = 0;
        for (let k = 0; k < nInf; k++) {
          const jIdx = jointIndex.get(boneIds[k]);
          if (jIdx != null) {
            joints[v * 4 + k] = jIdx;
            weights[v * 4 + k] = 1;
            wSum += 1;
          }
        }
        if (wSum > 0) {
          for (let k = 0; k < 4; k++) weights[v * 4 + k] /= wSum;
        } else {
          weights[v * 4] = 1;
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
    }

    const matId = Math.min(g.MaterialID ?? 0, gltfMaterials.length - 1);
    prim.setMaterial(gltfMaterials[matId]);
    prim.setMode(Primitive.Mode.TRIANGLES);

    const mesh = doc.createMesh(`geoset_${gi}`).addPrimitive(prim);
    const meshNode = doc.createNode(`mesh_${gi}`).setMesh(mesh);
    if (skin) meshNode.setSkin(skin);
    meshNodes.push(meshNode);
  }

  // ── Stage 1: Sequence / Animation Extraction ──────────────────────────────
  // war3-model exposes node tracks as AnimVector objects with Keys[] and
  // key.Vector values. Do not treat tracks as arrays of Frame/Values fields.
  const sequences = model.Sequences || [];
  const globalSequences = model.GlobalSequences || [];
  let exportedAnimationClips = 0;
  let exportedAnimationChannels = 0;
  const emittedAnimationWarnings = new Set<string>();

  const warnAnimation = (message: string): void => {
    if (emittedAnimationWarnings.has(message)) return;
    emittedAnimationWarnings.add(message);
    console.warn(`[Animation Warning] ${relPath}: ${message}`);
  };

  console.log(`[Animation] ${relPath}: ${sequences.length} sequence(s), ${globalSequences.length} global sequence(s), ${allNodes.length} animated node(s)`);

  for (let si = 0; si < sequences.length; si++) {
    const seq = sequences[si];
    const interval = seq.Interval;
    const seqStart = Number(interval?.[0] ?? 0);
    const seqEnd = Number(interval?.[1] ?? 0);

    if (!Number.isFinite(seqStart) || !Number.isFinite(seqEnd) || seqEnd <= seqStart) {
      warnAnimation(`Sequence ${seq.Name || si} has an invalid interval [${seqStart}, ${seqEnd}] and was skipped`);
      continue;
    }

    const animName = seq.Name || `Anim_${si}`;
    const animation = doc.createAnimation(animName);
    let channelCount = 0;

    for (const n of allNodes) {
      const gnode = nodeByObjectId.get(n.ObjectId);
      if (!gnode) continue;

      const prefix = `anim${si}_node${n.ObjectId}`;

      if (addMdxAnimationTrack(
        doc, buffer, animation, gnode,
        n.Translation as MdxAnimationTrack | undefined,
        seqStart, seqEnd, globalSequences.length, 'translation', 'VEC3', 3,
        wc3ToGltfVec3, `${prefix}_translation`, warnAnimation
      )) channelCount++;

      if (addMdxAnimationTrack(
        doc, buffer, animation, gnode,
        n.Rotation as MdxAnimationTrack | undefined,
        seqStart, seqEnd, globalSequences.length, 'rotation', 'VEC4', 4,
        wc3ToGltfQuat, `${prefix}_rotation`, warnAnimation
      )) channelCount++;

      if (addMdxAnimationTrack(
        doc, buffer, animation, gnode,
        n.Scaling as MdxAnimationTrack | undefined,
        seqStart, seqEnd, globalSequences.length, 'scale', 'VEC3', 3,
        wc3ToGltfScale, `${prefix}_scale`, warnAnimation
      )) channelCount++;
    }

    if (channelCount > 0) {
      exportedAnimationClips++;
      exportedAnimationChannels += channelCount;
      console.log(`[Animation]   ${animName}: ${channelCount} channel(s), ${((seqEnd - seqStart) / 1000).toFixed(3)}s`);
    } else {
      console.warn(`[Animation]   ${animName}: 0 usable transform channels; empty clip omitted`);
      animation.dispose();
    }
  }

  if (sequences.length > 0 && exportedAnimationChannels === 0) {
    console.warn(`[Animation] ${relPath}: sequences exist, but no bone/helper transform channels were exported. Check whether tracks contain Keys in the sequence intervals or use global sequences.`);
  }
  console.log(`[Animation] ${relPath}: exported ${exportedAnimationClips} clip(s), ${exportedAnimationChannels} channel(s)`);

  // Scene
  const scene = doc.createScene(model.Info?.Name || 'Scene');
  for (const n of allNodes.filter(n => n.Parent == null || n.Parent < 0)) {
    const gn = nodeByObjectId.get(n.ObjectId);
    if (gn) scene.addChild(gn);
  }
  for (const mn of meshNodes) scene.addChild(mn);
  doc.getRoot().setDefaultScene(scene);

  // Output GLB
  const outRel = relPath.replace(/\.mdx$/i, '.glb');
  const outAbs = path.join(outDir, outRel);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });

  const io = new NodeIO();
  const glbBytes = await io.writeBinary(doc);
  fs.writeFileSync(outAbs, Buffer.from(glbBytes));

  return outAbs;
}

// ── Main Execution ──────────────────────────────────────────────────────────
async function runStandaloneConversion() {
  const args = process.argv.slice(2);
  let inputDirArg = './wc3_extracts';
  let outputDirArg = 'converted-glb';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--output' && i + 1 < args.length) {
      outputDirArg = args[++i];
    } else if (arg.startsWith('--output=')) {
      outputDirArg = arg.substring(9);
    } else if (!arg.startsWith('-')) {
      inputDirArg = arg;
    }
  }

  const inputDir = path.resolve(inputDirArg);
  const outputDir = path.resolve(outputDirArg);
  const reporter = new ModelConversionReporter();

  if (!fs.existsSync(inputDir)) {
    console.error(`Input directory does not exist: ${inputDir}`);
    return;
  }

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  console.log('Indexing BLP textures...');
  const textureIndex = buildTextureIndex(inputDir);

  console.log(`Scanning for .mdx files in: ${inputDir}...`);
  const mdxFiles = getFilesRecursive(inputDir, '.mdx');
  console.log(`Found ${mdxFiles.length} MDX model(s) to process.\n`);

  for (let i = 0; i < mdxFiles.length; i++) {
    const filePath = mdxFiles[i];
    const relPath = path.relative(inputDir, filePath);

    try {
      const glbPath = await convertOne(filePath, relPath, textureIndex, outputDir);
      const stats = fs.statSync(glbPath);
      reporter.logSuccess(path.relative(outputDir, glbPath), stats.size);
    } catch (err: any) {
      reporter.logError(relPath, err.message || String(err));
    }
  }

  const finalReport = reporter.generateReport(inputDir, outputDir);
  console.log(finalReport);
  fs.writeFileSync('conversion_report.txt', finalReport, 'utf-8');
  console.log('Saved conversion report to: conversion_report.txt');
}

if (require.main === module) {
  runStandaloneConversion();
}