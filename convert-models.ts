import * as fs from 'fs';
import * as path from 'path';
import { parseMDX, decodeBLP, getBLPImageData } from 'war3-model';
import { PNG } from 'pngjs';
import { Document, NodeIO, Primitive } from '@gltf-transform/core';

/**
 * Stage 3 texture pass: path-aware BLP resolution, all MDX UV sets, material
 * CoordId selection, replaceable TeamColor/TeamGlow texture previews, and
 * explicit animated-alpha diagnostics. Warcraft blend modes without a direct
 * glTF equivalent are reported as approximations.
 */

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
  root: string;
  fullRel: Map<string, string>;
  byBase: Map<string, string[]>;
  bySuffix: Map<string, string[]>;
  byNameToken: Map<string, string[]>;
  allBlps: string[];
}

/**
 * Tokenize a filename while retaining useful CamelCase boundaries.
 * Examples: WC2Grunt.blp -> [grunt], WC2_Grunt.blp -> [grunt],
 * Shockwave_Ice1.blp -> [shockwave, ice].
 */
function tokenizeAssetName(value: string): string[] {
  const base = path.posix.basename(value.replace(/\\/g, '/'))
    .replace(/\.(blp|mdx)$/i, '');
  const separated = base
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([A-Za-z])/g, '$1 $2');
  return [...new Set(separated.toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length >= 3))];
}

function normalizeAssetPath(value: string): string {
  const slashed = value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
  return path.posix.normalize(slashed).replace(/^\.\//, '').toLowerCase();
}

function buildTextureIndex(root: string): TextureIndex {
  const fullRel = new Map<string, string>();
  const byBase = new Map<string, string[]>();
  const bySuffix = new Map<string, string[]>();
  const byNameToken = new Map<string, string[]>();
  const allBlps: string[] = [];

  function addToIndex(map: Map<string, string[]>, key: string, fullPath: string): void {
    const entries = map.get(key) || [];
    entries.push(fullPath);
    map.set(key, entries);
  }

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.toLowerCase().endsWith('.blp')) continue;

      const rel = normalizeAssetPath(path.relative(root, full));
      fullRel.set(rel, full);
      allBlps.push(full);
      addToIndex(byBase, path.posix.basename(rel), full);
      for (const token of tokenizeAssetName(entry.name)) {
        addToIndex(byNameToken, token, full);
      }

      // Index every path suffix (e.g. "Textures/orc.blp" and "orc.blp").
      // This lets MDX texture references match archive paths without falling
      // immediately back to an arbitrary same-basename texture.
      const parts = rel.split('/');
      for (let i = 0; i < parts.length; i++) {
        addToIndex(bySuffix, parts.slice(i).join('/'), full);
      }
    }
  }

  walk(root);
  return { root, fullRel, byBase, bySuffix, byNameToken, allBlps };
}

function rankTexturePath(assetPath: string): number {
  const lower = assetPath.replace(/\\/g, '/').toLowerCase();
  if (lower.includes('/war3patch') || lower.startsWith('war3patch')) return 0;
  if (lower.includes('/war3x') || lower.startsWith('war3x')) return 1;
  if (lower.includes('/war3_') || lower.includes('/war3/') || lower.startsWith('war3_')) return 2;
  return 10;
}

function commonPathPrefixLength(a: string, b: string): number {
  const aa = normalizeAssetPath(a).split('/').filter(Boolean);
  const bb = normalizeAssetPath(b).split('/').filter(Boolean);
  let count = 0;
  while (count < aa.length && count < bb.length && aa[count] === bb[count]) count++;
  return count;
}

function chooseTextureCandidate(
  candidates: string[],
  index: TextureIndex,
  mdxRelPath: string | undefined,
  requestedPath: string,
  warn: (message: string) => void
): string | null {
  if (candidates.length === 0) return null;

  const modelRel = normalizeAssetPath(mdxRelPath || '');
  const modelParts = modelRel.split('/').filter(Boolean);
  const modelTop = modelParts[0] || '';
  const modelDir = path.posix.dirname(modelRel);

  const ranked = candidates.map((abs) => {
    const rel = normalizeAssetPath(path.relative(index.root, abs));
    const sameTop = modelTop !== '' && rel.split('/')[0] === modelTop;
    const proximity = commonPathPrefixLength(modelDir, path.posix.dirname(rel));
    return { abs, rel, sameTop, proximity, archiveRank: rankTexturePath(rel) };
  }).sort((a, b) => {
    if (a.sameTop !== b.sameTop) return a.sameTop ? -1 : 1;
    if (a.proximity !== b.proximity) return b.proximity - a.proximity;
    if (a.archiveRank !== b.archiveRank) return a.archiveRank - b.archiveRank;
    return a.rel.localeCompare(b.rel);
  });

  if (ranked.length > 1) {
    const best = ranked[0];
    const tied = ranked.filter((candidate) =>
      candidate.sameTop === best.sameTop &&
      candidate.proximity === best.proximity &&
      candidate.archiveRank === best.archiveRank
    );
    if (tied.length > 1) {
      warn(`Ambiguous texture reference "${requestedPath}" matched ${tied.length} files; selected "${best.rel}". Other matches: ${tied.slice(1, 4).map((v) => v.rel).join(', ')}`);
    }
  }
  return ranked[0].abs;
}

function normalizedTextureStem(value: string): string {
  return path.posix.basename(normalizeAssetPath(value)).replace(/\.blp$/i, '').replace(/[^a-z0-9]/g, '');
}

function levenshteinDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const old = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      previous = old;
    }
  }
  return row[b.length];
}

interface FuzzyTextureCandidate {
  abs: string;
  rel: string;
  nameScore: number;
  contextScore: number;
  totalScore: number;
  reason: string;
}

/**
 * A conservative final fallback for legacy/custom assets whose MDX names a
 * texture "WC2Grunt.blp" while the extracted file is called "Grunt.blp".
 * This never silently picks among equally plausible atlases. For path-bearing
 * references, the candidate must have a matching parent-directory suffix
 * (e.g. Textures/...). This prevents accidental UI/effect texture matches.
 */
function resolveFuzzyTexture(
  texPath: string,
  index: TextureIndex,
  mdxRelPath: string | undefined,
  warn: (message: string) => void
): string | null {
  const requestedStem = normalizedTextureStem(texPath);
  const requestedTokens = tokenizeAssetName(texPath);
  if (requestedStem.length < 4 || requestedTokens.length === 0) return null;

  const modelRel = normalizeAssetPath(mdxRelPath || '');
  const modelParts = modelRel.split('/').filter(Boolean);
  const modelDir = modelParts.length > 1 ? path.posix.dirname(modelRel) : '.';
  const modelTop = modelParts.length > 1 ? modelParts[0] : '';
  const modelTokens = tokenizeAssetName(mdxRelPath || '');
  const requestedDir = path.posix.dirname(normalizeAssetPath(texPath));
  const hasRequestedDir = requestedDir !== '.' && requestedDir !== '';

  const pool = new Set<string>();
  for (const token of requestedTokens) {
    for (const candidate of index.byNameToken.get(token) || []) pool.add(candidate);
  }
  // Model-name tokens provide context, but are not sufficient on their own to
  // create a match. A candidate must still be lexically close to the MDX slot.

  const ranked: FuzzyTextureCandidate[] = [];
  for (const abs of pool) {
    const filename = path.basename(abs);
    const candidateStem = normalizedTextureStem(filename);
    if (candidateStem.length < 4) continue;

    let nameScore = 0;
    let reason = '';
    if (candidateStem === requestedStem) {
      nameScore = 100;
      reason = 'normalized filename equality';
    } else if (requestedTokens.includes(candidateStem)) {
      nameScore = 94;
      reason = `filename equals requested token "${candidateStem}"`;
    } else if (requestedStem.endsWith(candidateStem) || requestedStem.startsWith(candidateStem)) {
      // Handles WC2Grunt -> Grunt without accepting arbitrary shared substrings.
      nameScore = 90 + Math.min(4, Math.floor((candidateStem.length / requestedStem.length) * 4));
      reason = 'filename is a complete prefix/suffix of requested texture name';
    } else {
      const distance = levenshteinDistance(requestedStem, candidateStem);
      const maxLength = Math.max(requestedStem.length, candidateStem.length);
      const similarity = 1 - distance / maxLength;
      if (similarity >= 0.84 && Math.min(requestedStem.length, candidateStem.length) >= 6) {
        nameScore = 78 + Math.round((similarity - 0.84) * 100);
        reason = `similar filename (${Math.round(similarity * 100)}% normalized similarity)`;
      }
    }
    if (nameScore < 78) continue;

    const rel = normalizeAssetPath(path.relative(index.root, abs));
    const candidateDir = path.posix.dirname(rel);
    const candidateTop = rel.split('/')[0] || '';
    const sameDirectory = candidateDir === modelDir;
    const sameTop = !!modelTop && candidateTop === modelTop;
    const commonPrefix = modelDir === '.' ? 0 : commonPathPrefixLength(modelDir, candidateDir);

    // Do not let a path such as Textures/Shockwave_Ice1.blp resolve to an
    // unrelated UI/Glues/.../Shockwave_Ice1.blp merely by filename.
    const candidateDirParts = candidateDir.split('/').filter(Boolean);
    const requestedDirParts = requestedDir.split('/').filter(Boolean);
    const hasMatchingRequestedDirSuffix = requestedDirParts.length > 0 &&
      requestedDirParts.length <= candidateDirParts.length &&
      requestedDirParts.every((part, i) =>
        part === candidateDirParts[candidateDirParts.length - requestedDirParts.length + i]
      );
    if (hasRequestedDir && !hasMatchingRequestedDirSuffix) continue;

    let contextScore = 0;
    if (sameDirectory) contextScore += 40;
    if (sameTop) contextScore += 24;
    if (hasMatchingRequestedDirSuffix) contextScore += 20;
    contextScore += Math.min(12, commonPrefix * 3);
    const candidateTokens = tokenizeAssetName(filename);
    if (candidateTokens.some(token => modelTokens.includes(token))) contextScore += 5;

    ranked.push({ abs, rel, nameScore, contextScore, totalScore: nameScore + contextScore, reason });
  }

  if (ranked.length === 0) return null;
  ranked.sort((a, b) => b.totalScore - a.totalScore || b.nameScore - a.nameScore || a.rel.localeCompare(b.rel));

  if (ranked.length > 1) {
    const first = ranked[0];
    const second = ranked[1];
    const sameStrength = first.nameScore === second.nameScore &&
      Math.abs(first.contextScore - second.contextScore) < 10;
    const insufficientMargin = first.totalScore - second.totalScore < 10;
    if (sameStrength || insufficientMargin) {
      warn(`Fuzzy texture match for "${texPath}" is ambiguous; refusing to guess. Best candidates: ${ranked.slice(0, 6).map(c => `${c.rel} (name=${c.nameScore}, context=${c.contextScore})`).join('; ')}`);
      return null;
    }
  }

  const selected = ranked[0];
  warn(`FUZZY MATCH: "${texPath}" -> "${selected.rel}" (${selected.reason}; name=${selected.nameScore}, context=${selected.contextScore}). Verify that this is the correct atlas, not merely a similarly named texture.`);
  return selected.abs;
}

function resolveTexture(
  texPath: string | undefined,
  index: TextureIndex,
  mdxRelPath?: string,
  warn: (message: string) => void = (message) => console.warn(`[Texture Warning] ${message}`),
  allowFuzzyFallback = true
): string | null {
  if (!texPath || !texPath.trim()) return null;
  const lower = normalizeAssetPath(texPath);
  const lowerWithExtension = /\.blp$/i.test(lower) ? lower : `${lower}.blp`;
  const base = path.posix.basename(lowerWithExtension);
  const modelRel = normalizeAssetPath(mdxRelPath || '');
  const modelDir = path.posix.dirname(modelRel);
  const modelTop = modelRel.split('/')[0];

  // 1. Exact path relative to the extraction root.
  const exact = index.fullRel.get(lower) || index.fullRel.get(lowerWithExtension);
  if (exact) return exact;

  // 2. Resolve relative to the MDX's own directory and top-level archive.
  if (mdxRelPath) {
    const besideModel = normalizeAssetPath(path.posix.join(modelDir, lower));
    const besideHit = index.fullRel.get(besideModel) || index.fullRel.get(`${besideModel}.blp`);
    if (besideHit) return besideHit;

    const underArchive = normalizeAssetPath(path.posix.join(modelTop, lower));
    const archiveHit = index.fullRel.get(underArchive) || index.fullRel.get(`${underArchive}.blp`);
    if (archiveHit) return archiveHit;
  }

  // 3. Match the complete referenced suffix before considering basename only.
  const suffixHits = index.bySuffix.get(lower) || index.bySuffix.get(lowerWithExtension) || [];
  if (suffixHits.length) {
    return chooseTextureCandidate(suffixHits, index, mdxRelPath, texPath, warn);
  }

  // 4. Exact-basename fallback. Path-bearing references remain protected from
  // unrelated same-name files in other branches of the extraction.
  const baseHits = index.byBase.get(base) || [];
  if (baseHits.length) {
    const sameArchiveHits = baseHits.filter((candidate) => {
      const rel = normalizeAssetPath(path.relative(index.root, candidate));
      return modelTop !== '' && rel.split('/')[0] === modelTop;
    });

    if (sameArchiveHits.length === 1) {
      const selected = sameArchiveHits[0];
      warn(`Texture "${texPath}" had no full path match; using the only same-archive filename match "${normalizeAssetPath(path.relative(index.root, selected))}"`);
      return selected;
    }

    if (!lower.includes('/') && baseHits.length === 1) return baseHits[0];

    if (lower.includes('/')) {
      const examples = baseHits.slice(0, 5).map((candidate) =>
        normalizeAssetPath(path.relative(index.root, candidate))
      );
      warn(`No safe exact-basename match for path-bearing texture "${texPath}"; ${baseHits.length} filename candidate(s) exist${examples.length ? `: ${examples.join(', ')}` : ''}`);
    } else if (sameArchiveHits.length > 1) {
      warn(`Ambiguous bare texture reference "${texPath}": ${sameArchiveHits.length} filename matches exist in archive "${modelTop}"; trying conservative fuzzy/context matching`);
    } else {
      warn(`Ambiguous bare texture reference "${texPath}": ${baseHits.length} filename matches exist outside archive "${modelTop}"; trying conservative fuzzy/context matching`);
    }
  }

  // 5. Fuzzy filename fallback (e.g. WC2Grunt.blp -> Grunt.blp). This is
  // deliberately last and always emits a warning naming the chosen BLP.
  if (allowFuzzyFallback) {
    const fuzzy = resolveFuzzyTexture(texPath, index, mdxRelPath, warn);
    if (fuzzy) return fuzzy;
  }

  return null;
}

/**
 * Decode a Warcraft III BLP texture and encode its first mip level as PNG.
 *
 * Keep this helper in the converter: texture resolution only finds the source
 * file; this function produces the PNG image bytes that glTF Transform embeds.
 */
function blpToPngBuffer(blpPath: string): Buffer {
  const raw = fs.readFileSync(blpPath);
  const arrayBuffer = raw.buffer.slice(
    raw.byteOffset,
    raw.byteOffset + raw.byteLength
  );
  const blp = decodeBLP(arrayBuffer);
  const image = getBLPImageData(blp, 0);

  const width = Number(image.width);
  const height = Number(image.height);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error(`BLP decoder returned invalid dimensions ${width}x${height}`);
  }

  const expectedBytes = width * height * 4;
  if (!image.data || image.data.length !== expectedBytes) {
    throw new Error(
      `BLP decoder returned ${image.data?.length ?? 0} pixel bytes; expected ${expectedBytes} RGBA bytes for ${width}x${height}`
    );
  }

  const png = new PNG({ width, height });
  for (let i = 0; i < expectedBytes; i++) {
    png.data[i] = image.data[i];
  }
  return PNG.sync.write(png);
}

function readStaticNumeric(value: any, fallback: number): number {
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
 * Resolve MDX replaceable texture slots to an extracted Warcraft III texture.
 * ReplaceableId 1 is TeamColor; ReplaceableId 2 is TeamGlow. The selected
 * index is a deliberate static preview choice (default 00/red), because the
 * runtime game normally chooses this from the owning player's color.
 */
function resolveReplaceableTexture(
  replaceableId: number,
  teamColorIndex: number,
  index: TextureIndex,
  mdxRelPath: string,
  warn: (message: string) => void
): string | null {
  const kind = replaceableId === 1 ? 'TeamColor' : replaceableId === 2 ? 'TeamGlow' : null;
  if (!kind) {
    warn(`unsupported ReplaceableId ${replaceableId}; no static replacement rule is defined`);
    return null;
  }

  const suffix = `${kind}${String(teamColorIndex).padStart(2, '0')}.blp`;
  const canonicalPath = `ReplaceableTextures/${kind}/${suffix}`;
  const resolved = resolveTexture(canonicalPath, index, mdxRelPath, warn);
  if (!resolved) {
    warn(`ReplaceableId ${replaceableId} requires ${canonicalPath}, but that texture was not found in the extraction root`);
  }
  return resolved;
}

/**
 * Do not mistake an animated KMTA Alpha track's first key for a static value.
 * Stage 3 has no material-animation channel export yet, so animated alpha is
 * held at 1 for the static Blender texture/material preview. Literal numeric
 * alpha values are preserved exactly. The animated track is reported and
 * retained in material extras for later material-animation work.
 */
function readMaterialAlpha(
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

function describeMaterialAlpha(value: any): string {
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

function createLayerMaterial(
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

/**
 * Get a node's MDX model-space pivot. war3-model normally exposes PivotPoint
 * directly on the node; PivotPoints is retained as a compatibility fallback.
 */
function getMdxNodePivot(node: any, model: any): Float32Array {
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
function subtractVec3(a: ArrayLike<number>, b: ArrayLike<number>): Float32Array {
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
function writeInversePivotMatrix(
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
 * The exporter maps the first two exactly. Hermite/Bezier are temporarily sampled
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
async function convertOne(
  mdxAbsPath: string,
  relPath: string,
  textureIndex: TextureIndex,
  outDir: string,
  materialLayerMode: 'stack' | 'base',
  teamColorIndex: number,
  allowFuzzyTextureFallback: boolean
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
        replaceableId, teamColorIndex, textureIndex, relPath, warnTexture
      );
      resolutionKind = `ReplaceableId ${replaceableId} (preview index ${teamColorIndex})`;
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

  // Bones & Nodes — Stage 2 pivot-aware bind-pose reconstruction.
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

  // Geosets
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
        flipped[i * 2] = Number(uvs[i * 2]);
        flipped[i * 2 + 1] = 1 - Number(uvs[i * 2 + 1]);
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
      // Pick the highest bone joint in the hierarchy for malformed-group
      // fallback, walking through non-bone ancestors such as Helpers. A bone
      // can be parented to a Helper, so checking only its immediate parent
      // would incorrectly classify it as a root joint.
      const findRootBoneIndex = (): number => {
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
      };
      const rootBoneIndex = findRootBoneIndex();
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

  // ── Animation Export (Stage 1 retained; Stage 2 pivot-aware skeleton) ─────
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

  // Scene
  const scene = doc.createScene(model.Info?.Name || 'Scene');
  for (const n of allNodes.filter(n => n.Parent == null || n.Parent < 0 || !nodeByObjectId.has(n.Parent))) {
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
  // Usage: npx tsx convert-models.ts [model-input-directory] [--texture-root BLP-search-root] [--output output-directory]
  // Fuzzy texture matching is a last-resort fallback; use --strict-texture-matching to disable it.
  // Add --diagnostic-base-layer to export only material layer 0. This isolates
  // base texture/UV assignment from multi-layer compositing while preserving the
  // default full-layer export for comparison.
  const args = process.argv.slice(2);
  let inputDirArg = './wc3_extracts';
  let outputDirArg = 'converted-glb';
  let textureRootArg: string | null = null;
  let materialLayerMode: 'stack' | 'base' = 'stack';
  // Static replacement choice for model previews. Warcraft normally selects
  // this from the owning player at runtime; 0 is the classic red preview.
  let teamColorIndex = 0;
  let allowFuzzyTextureFallback = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--output' && i + 1 < args.length) {
      outputDirArg = args[++i];
    } else if (arg === '--texture-root' && i + 1 < args.length) {
      textureRootArg = args[++i];
    } else if (arg.startsWith('--texture-root=')) {
      textureRootArg = arg.substring('--texture-root='.length);
    } else if (arg.startsWith('--output=')) {
      outputDirArg = arg.substring('--output='.length);
    } else if (arg === '--diagnostic-base-layer') {
      materialLayerMode = 'base';
    } else if (arg === '--strict-texture-matching') {
      allowFuzzyTextureFallback = false;
    } else if (arg === '--team-color-index' && i + 1 < args.length) {
      const parsed = Number.parseInt(args[++i], 10);
      if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 23) {
        teamColorIndex = parsed;
      } else {
        console.warn(`[Arguments] Invalid --team-color-index; expected 0..23, received ${args[i]}. Using 0.`);
        teamColorIndex = 0;
      }
    } else if (arg.startsWith('--team-color-index=')) {
      const parsed = Number.parseInt(arg.substring('--team-color-index='.length), 10);
      if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 23) teamColorIndex = parsed;
      else console.warn(`[Arguments] Invalid --team-color-index; using 0.`);
    } else if (!arg.startsWith('-')) {
      inputDirArg = arg;
    }
  }

  const inputDir = path.resolve(inputDirArg);
  const outputDir = path.resolve(outputDirArg);
  const textureRoot = path.resolve(textureRootArg || inputDir);
  const reporter = new ModelConversionReporter();

  if (!fs.existsSync(inputDir)) {
    console.error(`Input directory does not exist: ${inputDir}`);
    return;
  }

  if (!fs.existsSync(textureRoot) || !fs.statSync(textureRoot).isDirectory()) {
    console.error(`Texture search root does not exist or is not a directory: ${textureRoot}`);
    return;
  }

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  console.log(`Material export mode: ${materialLayerMode === 'base' ? 'diagnostic base-layer only' : 'full layer stack (approximate)'}`);
  console.log(`Replaceable texture preview: team color index ${teamColorIndex} (TeamColor/TeamGlow)`);
  console.log(`Fuzzy texture fallback: ${allowFuzzyTextureFallback ? 'enabled (ambiguous matches are refused)' : 'disabled (--strict-texture-matching)'}`);
  console.log('Indexing BLP textures recursively...');
  console.log(`Model input directory: ${inputDir}`);
  console.log(`Texture search root: ${textureRoot}`);
  const textureIndex = buildTextureIndex(textureRoot);
  console.log(`Indexed ${textureIndex.allBlps.length} BLP file(s) across ${textureRoot}`);

  console.log(`Scanning for .mdx files in: ${inputDir}...`);
  const mdxFiles = getFilesRecursive(inputDir, '.mdx');
  console.log(`Found ${mdxFiles.length} MDX model(s) to process.\n`);

  for (let i = 0; i < mdxFiles.length; i++) {
    const filePath = mdxFiles[i];
    const relPath = path.relative(inputDir, filePath);

    try {
      const glbPath = await convertOne(filePath, relPath, textureIndex, outputDir, materialLayerMode, teamColorIndex, allowFuzzyTextureFallback);
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