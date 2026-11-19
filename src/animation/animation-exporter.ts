/**
 * Translate MDX animation tracks into glTF animation channels.
 */

import { Document } from '@gltf-transform/core';
import type {
  MdxAnimationKey,
  MdxAnimationTrack,
  GltfTransformPath,
  GltfAccessorType,
  GltfInterpolation,
} from '../types/animation';
import { wc3ToGltfVec3, wc3ToGltfQuat, wc3ToGltfScale } from '../geometry/coordinate-conversion';

/**
 * MDX line types: DontInterp=0, Linear=1, Hermite=2, Bezier=3.
 * The exporter maps the first two exactly. Hermite/Bezier are temporarily sampled
 * linearly; their tangent-aware conversion is deliberately reserved for Stage 3.
 */
export function getGltfInterpolation(
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
      warn('MDX Hermite interpolation found; exported as LINEAR (tangent-aware interpolation is pending)');
      return 'LINEAR';
    case 3:
      warn('MDX Bezier interpolation found; exported as LINEAR (tangent-aware interpolation is pending)');
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
export function addMdxAnimationTrack(
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
  warn: (message: string) => void,
  valueOffset?: ArrayLike<number>
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
    // glTF animation channels replace the node's base TRS value. For MDX
    // translation tracks we therefore add the static local pivot offset back
    // into every key so the joint continues to rotate around its authored pivot.
    const values = Array.from(
      { length: componentCount },
      (_, i) => Number(converted[i]) + (targetPath === 'translation' ? Number(valueOffset?.[i] ?? 0) : 0)
    );
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

export interface AnimationExportResult {
  exportedClips: number;
  exportedChannels: number;
}

/**
 * Export all MDX sequences as glTF animations for the given node set.
 */
export function exportAnimations(
  doc: Document,
  buffer: ReturnType<Document['createBuffer']>,
  model: any,
  allNodes: any[],
  nodeByObjectId: Map<number, ReturnType<Document['createNode']>>,
  localPivotByObjectId: Map<number, Float32Array>,
  relPath: string
): AnimationExportResult {
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
        wc3ToGltfVec3, `${prefix}_translation`, warnAnimation,
        localPivotByObjectId.get(n.ObjectId)
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
    console.warn(`[Animation] ${relPath}: sequences exist, but no node transform channels were exported. The model may animate non-transform properties (particle emitters, visibility, geoset/material animation), use only global sequences, or contain no transform keys in its sequence intervals.`);
  }
  console.log(`[Animation] ${relPath}: exported ${exportedAnimationClips} clip(s), ${exportedAnimationChannels} channel(s)`);

  return { exportedClips: exportedAnimationClips, exportedChannels: exportedAnimationChannels };
}
