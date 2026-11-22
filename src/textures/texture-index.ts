/**
 * Path-aware BLP texture indexing and resolution for Warcraft III MDX models.
 *
 * Handles exact path matches, suffix matches, basename matches, archive
 * proximity ranking, and a conservative fuzzy fallback. Does not decode
 * image data — that lives in blp-decoder.ts.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { TextureIndex, FuzzyTextureCandidate } from '../types/conversion';

/**
 * Tokenize a filename while retaining useful CamelCase boundaries.
 * Examples: WC2Grunt.blp -> [grunt], WC2_Grunt.blp -> [grunt],
 * Shockwave_Ice1.blp -> [shockwave, ice].
 */
export function tokenizeAssetName(value: string): string[] {
  const base = path.posix.basename(value.replace(/\\/g, '/'))
    .replace(/\.(blp|mdx)$/i, '');
  const separated = base
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([A-Za-z])/g, '$1 $2');
  return [...new Set(separated.toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length >= 3))];
}

export function normalizeAssetPath(value: string): string {
  const slashed = value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
  return path.posix.normalize(slashed).replace(/^\.\//, '').toLowerCase();
}

export function buildTextureIndex(root: string): TextureIndex {
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

/**
 * A conservative final fallback for legacy/custom assets whose MDX names a
 * texture "WC2Grunt.blp" while the extracted file is called "Grunt.blp".
 * This never silently picks among equally plausible atlases. For path-bearing
 * references, the candidate must have a matching parent-directory suffix
 * (e.g. Textures/...). This prevents accidental UI/effect texture matches.
 */
export function resolveFuzzyTexture(
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

export function resolveTexture(
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
 * Resolve MDX replaceable texture slots to an extracted Warcraft III texture.
 * ReplaceableId 1 is TeamColor; ReplaceableId 2 is TeamGlow. The selected
 * index is a deliberate static preview choice (default 00/red), because the
 * runtime game normally chooses this from the owning player's color.
 */
export function resolveReplaceableTexture(
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
