#!/usr/bin/env npx tsx
/**
 * Inspect MDX texture slots, material-layer references, and geoset assignments.
 * Usage:
 *   npx tsx inspect-mdx-textures.ts "/path/to/grunt.mdx" "/path/to/war3_d32bf84bc0c7"
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseMDX } from 'war3-model';

function normalize(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/').toLowerCase();
}

function walkBlps(root: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) walkBlps(full, out);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.blp')) out.push(full);
  }
  return out;
}

function describeAlpha(alpha: any): string {
  if (typeof alpha === 'number') return `static ${alpha}`;
  if (alpha && typeof alpha === 'object') {
    const keys = Array.isArray(alpha.Keys) ? alpha.Keys : [];
    return `track LineType=${alpha.LineType ?? '?'} GlobalSeqId=${alpha.GlobalSeqId ?? 'none'} keys=${keys.length}`;
  }
  return 'unspecified';
}

const mdxPath = process.argv[2];
const assetRoot = process.argv[3];
if (!mdxPath || !assetRoot) {
  console.error('Usage: npx tsx inspect-mdx-textures.ts <model.mdx> <mpq-extraction-root>');
  process.exit(2);
}
if (!fs.existsSync(mdxPath) || !fs.statSync(mdxPath).isFile()) {
  console.error(`MDX file not found: ${mdxPath}`);
  process.exit(2);
}
if (!fs.existsSync(assetRoot) || !fs.statSync(assetRoot).isDirectory()) {
  console.error(`Asset root not found: ${assetRoot}`);
  process.exit(2);
}

const raw = fs.readFileSync(mdxPath);
const model = parseMDX(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
const blps = walkBlps(assetRoot);
const byRel = new Map<string, string>();
const byBase = new Map<string, string[]>();
for (const full of blps) {
  const rel = normalize(path.relative(assetRoot, full));
  byRel.set(rel, full);
  const base = path.posix.basename(rel);
  const list = byBase.get(base) ?? [];
  list.push(full);
  byBase.set(base, list);
}

console.log('\n=== MODEL ===');
console.log(`File: ${path.resolve(mdxPath)}`);
console.log(`Asset root: ${path.resolve(assetRoot)}`);
console.log(`Textures: ${(model.Textures ?? []).length}`);
console.log(`Materials: ${(model.Materials ?? []).length}`);
console.log(`Geosets: ${(model.Geosets ?? []).length}`);
console.log(`BLP files indexed: ${blps.length}`);

console.log('\n=== TEXTURE SLOTS ===');
(model.Textures ?? []).forEach((texture: any, index: number) => {
  const image = String(texture?.Image ?? '');
  const normalized = normalize(image);
  const exact = image ? byRel.get(normalized) : undefined;
  const basename = normalized ? path.posix.basename(normalized) : '';
  const candidates = basename ? (byBase.get(basename) ?? []) : [];
  console.log(`slot ${index}: Image=${JSON.stringify(image)} ReplaceableId=${texture?.ReplaceableId ?? 0} Flags=${texture?.Flags ?? 0}`);
  console.log(`  exact-in-MPQ: ${exact ? path.relative(assetRoot, exact) : 'NO'}`);
  if (!exact && candidates.length) {
    console.log(`  same-basename candidates (${candidates.length}):`);
    candidates.slice(0, 12).forEach(candidate => console.log(`    ${path.relative(assetRoot, candidate)}`));
    if (candidates.length > 12) console.log(`    ... ${candidates.length - 12} more`);
  }
});

console.log('\n=== MATERIALS / LAYERS ===');
(model.Materials ?? []).forEach((material: any, mi: number) => {
  const layers = material?.Layers ?? [];
  console.log(`material ${mi}: ${layers.length} layer(s)`);
  layers.forEach((layer: any, li: number) => {
    const textureId = Number(layer?.TextureID ?? 0);
    const slot = (model.Textures ?? [])[textureId];
    console.log(
      `  layer ${li}: TextureID=${textureId} Image=${JSON.stringify(slot?.Image ?? '')}` +
      ` ReplaceableId=${slot?.ReplaceableId ?? 0} CoordId=${layer?.CoordId ?? 0}` +
      ` FilterMode=${layer?.FilterMode ?? 0} Alpha=${describeAlpha(layer?.Alpha)}`
    );
  });
});

console.log('\n=== GEOSET -> MATERIAL / UV SETS ===');
(model.Geosets ?? []).forEach((geoset: any, gi: number) => {
  const uvSets: number[] = (geoset?.TVertices ?? []).map((uv: any) => Number(uv?.length ?? 0));
  console.log(`geoset ${gi}: MaterialID=${geoset?.MaterialID ?? 0} UV vertex counts=[${uvSets.join(', ')}] vertices=${Math.floor((geoset?.Vertices?.length ?? 0) / 3)} faces=${Math.floor((geoset?.Faces?.length ?? 0) / 3)}`);
});
