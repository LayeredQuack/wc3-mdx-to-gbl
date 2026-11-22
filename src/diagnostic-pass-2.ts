#!/usr/bin/env npx tsx
/**
 * Second-Pass Texture Pipeline Diagnostics
 * 
 * Objective: Identify exactly where source MDX data stops matching generated GLB
 * 
 * CRITICAL RULES:
 * 1. Do NOT modify convert-models.ts
 * 2. Do NOT modify existing geometry, skeleton, skinning, inverse-bind, pivot, or animation
 * 3. Do NOT refactor existing conversion code
 * 4. Do NOT overwrite existing GLB files or diagnostic outputs
 * 5. All generated files go to diagnostic output directory
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseMDX, decodeBLP, getBLPImageData } from 'war3-model';
import { PNG } from 'pngjs';
import { Document, NodeIO } from '@gltf-transform/core';

// Configuration
const TESTER_DIR = './tester';
const DIAGNOSTIC_OUTPUT_DIR = './diagnostic-pass-2';
const NORMAL_MATCHING_MODE = true;
const STRICT_MATCHING_MODE = false;

interface DiagnosticConfig {
  modelPath: string;
  textureRoot: string;
  outputDir: string;
  matchingMode: boolean;
}

interface TextureEntry {
  index: number;
  image: string | null;
  replaceableId: number;
  flags: number;
}

interface MaterialLayer {
  materialIndex: number;
  layerIndex: number;
  textureId: number;
  coordId: number;
  filterMode: number;
  alpha: any;
  shading: number;
  tvertexAnimId?: number;
}

interface GeosetInfo {
  index: number;
  materialId: number;
  vertexCount: number;
  triangleCount: number;
  uvSetCount: number;
  uvSetLengths: number[];
  uvMin: [number, number, number];
  uvMax: [number, number, number];
}

interface TextureResolution {
  originalPath: string | null;
  normalizedPath: string | null;
  resolvedPath: string | null;
  resolutionMethod: 'exact' | 'mdx-relative' | 'suffix' | 'basename' | 'fuzzy' | 'none';
  fallbackUsed: boolean;
  fileSize: number;
  sha256?: string;
  decodeSuccess: boolean;
  decodedWidth?: number;
  decodedHeight?: number;
}

interface DiagnosticResult {
  modelPath: string;
  fileHash: string;
  geosetCount: number;
  materialCount: number;
  textureCount: number;
  blpCount: number;
  textures: TextureEntry[];
  materials: MaterialLayer[][];
  geosets: GeosetInfo[];
  textureResolutions: TextureResolution[];
  mappingTable: Array<{
    geosetIndex: number;
    materialId: number;
    layerIndex: number;
    textureId: number;
    textureEntry: TextureEntry | null;
    resolvedPath: string | null;
    coordId: number;
  }>;
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = require('crypto').createHash('sha256');
    const readStream = fs.createReadStream(filePath);
    
    readStream.on('data', () => {});
    readStream.on('end', () => resolve(hash.digest('hex')));
    readStream.on('error', reject);
  });
}

function normalizePath(value: string): string {
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

function buildTextureIndex(root: string): {
  fullRel: Map<string, string>;
  byBase: Map<string, string[]>;
  bySuffix: Map<string, string[]>;
  allBlps: string[];
} {
  const fullRel = new Map<string, string>();
  const byBase = new Map<string, string[]>();
  const bySuffix = new Map<string, string[]>();
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

      const rel = normalizePath(path.relative(root, full));
      fullRel.set(rel, full);
      allBlps.push(full);
      addToIndex(byBase, path.posix.basename(rel), full);
      
      const parts = rel.split('/');
      for (let i = 0; i < parts.length; i++) {
        addToIndex(bySuffix, parts.slice(i).join('/'), full);
      }
    }
  }

  walk(root);
  return { fullRel, byBase, bySuffix, allBlps };
}

function describeAlpha(alpha: any): string {
  if (typeof alpha === 'number') return `static ${alpha}`;
  if (alpha && typeof alpha === 'object') {
    const keys = Array.isArray(alpha.Keys) ? alpha.Keys : [];
    return `track LineType=${alpha.LineType ?? '?'} GlobalSeqId=${alpha.GlobalSeqId ?? 'none'} keys=${keys.length}`;
  }
  return 'unspecified';
}

async function runDiagnostic(config: DiagnosticConfig): Promise<DiagnosticResult> {
  console.log(`\n=== DIAGNOSTIC RUN ===`);
  console.log(`Model: ${path.basename(config.modelPath)}`);
  console.log(`Texture root: ${config.textureRoot}`);
  console.log(`Matching mode: ${config.matchingMode ? 'NORMAL' : 'STRICT'}`);
  
  const raw = fs.readFileSync(config.modelPath);
  const model = parseMDX(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  const blps = walkBlps(config.textureRoot);
  
  const { fullRel, byBase, bySuffix } = buildTextureIndex(config.textureRoot);
  
  console.log(`Textures: ${(model.Textures ?? []).length}`);
  console.log(`Materials: ${(model.Materials ?? []).length}`);
  console.log(`Geosets: ${(model.Geosets ?? []).length}`);
  console.log(`BLP files indexed: ${blps.length}`);

  // Phase 2: Dump original MDX texture and material data
  console.log('\n=== PHASE 2: ORIGINAL MDX DATA ===');
  
  const textures: TextureEntry[] = (model.Textures ?? []).map((texture: any, index: number) => ({
    index,
    image: String(texture?.Image ?? null),
    replaceableId: Number(texture?.ReplaceableId ?? 0),
    flags: Number(texture?.Flags ?? 0),
  }));

  const materials: MaterialLayer[][] = [];
  for (let mi = 0; mi < (model.Materials ?? []).length; mi++) {
    const material = model.Materials[mi];
    const layers = Array.isArray(material?.Layers) ? material.Layers : [];
    const layerData: MaterialLayer[] = layers.map((layer: any, li: number) => ({
      materialIndex: mi,
      layerIndex: li,
      textureId: Number(layer?.TextureID ?? 0),
      coordId: Number(layer?.CoordId ?? 0),
      filterMode: Number(layer?.FilterMode ?? 0),
      alpha: layer?.Alpha,
      shading: Number(layer?.Shading ?? 0),
      tvertexAnimId: Number(layer?.TVertexAnimId ?? -1),
    }));
    materials.push(layerData);
  }

  const geosets: GeosetInfo[] = [];
  for (let gi = 0; gi < (model.Geosets ?? []).length; gi++) {
    const g = model.Geosets[gi];
    const positions = g.Vertices;
    const indices = g.Faces;
    const uvSets: ArrayLike<number>[] = Array.isArray(g.TVertices) ? g.TVertices : [];
    
    if (!positions || !indices || positions.length < 3) continue;
    const vertCount = positions.length / 3;

    let uvMin: [number, number, number] = [Infinity, Infinity, Infinity];
    let uvMax: [number, number, number] = [-Infinity, -Infinity, -Infinity];

    for (let i = 0; i < vertCount; i++) {
      const u = Number(positions[i * 3]);
      const v = Number(positions[i * 3 + 1]);
      uvMin = [Math.min(uvMin[0], u), Math.min(uvMin[1], v), uvMin[2]];
      uvMax = [Math.max(uvMax[0], u), Math.max(uvMax[1], v), uvMax[2]];
    }

    const uvSetLengths: number[] = [];
    for (let uvIndex = 0; uvIndex < uvSets.length; uvIndex++) {
      const uvs = uvSets[uvIndex];
      if (uvs && uvs.length > 0) {
        uvSetLengths.push(uvs.length);
      }
    }

    geosets.push({
      index: gi,
      materialId: Number(g.MaterialID ?? 0),
      vertexCount: vertCount,
      triangleCount: Math.floor((indices?.length ?? 0) / 3),
      uvSetCount: uvSets.length,
      uvSetLengths,
      uvMin,
      uvMax,
    });
  }

  // Phase 3: Trace every texture resolution
  console.log('\n=== PHASE 3: TEXTURE RESOLUTION ===');
  
  const textureResolutions: TextureResolution[] = [];
  for (let ti = 0; ti < textures.length; ti++) {
    const texEntry = textures[ti];
    let resolvedPath: string | null = null;
    let resolutionMethod: TextureResolution['resolutionMethod'] = 'none';
    let fallbackUsed = false;

    if (texEntry.image) {
      const normalized = normalizePath(texEntry.image);
      
      // Exact match
      const exact = fullRel.get(normalized);
      if (exact) {
        resolvedPath = exact;
        resolutionMethod = 'exact';
      } else {
        // MDX-relative paths
        const modelDir = path.posix.dirname(config.modelPath);
        const besideModel = normalizePath(path.posix.join(modelDir, normalized));
        const archiveHit = fullRel.get(besideModel) || fullRel.get(`${besideModel}.blp`);
        if (archiveHit) {
          resolvedPath = archiveHit;
          resolutionMethod = 'mdx-relative';
        } else {
          // Suffix matching
          const suffixHits = bySuffix.get(normalized) || [];
          if (suffixHits.length > 0) {
            resolvedPath = suffixHits[0];
            resolutionMethod = 'suffix';
          } else {
            // Basename fallback
            const baseHits = byBase.get(path.posix.basename(normalized)) || [];
            if (baseHits.length > 0) {
              resolvedPath = baseHits[0];
              resolutionMethod = 'basename';
              fallbackUsed = true;
            }
          }
        }
      }
    }

    const fileSize = resolvedPath ? fs.statSync(resolvedPath).size : 0;
    const decodeSuccess = resolvedPath ? false : null; // Will be checked later

    textureResolutions.push({
      originalPath: texEntry.image || null,
      normalizedPath: normalizePath(texEntry.image || ''),
      resolvedPath,
      resolutionMethod,
      fallbackUsed,
      fileSize,
      decodeSuccess,
    });
  }

  // Phase 4: Export resolved BLP files independently
  console.log('\n=== PHASE 4: BLP DECODING ===');
  
  const decodedTextures: Array<{ path: string; pngPath: string }> = [];
  for (let ti = 0; ti < textureResolutions.length; ti++) {
    const res = textureResolutions[ti];
    if (!res.resolvedPath) continue;

    try {
      const raw = fs.readFileSync(res.resolvedPath);
      const arrayBuffer = raw.buffer.slice(
        raw.byteOffset,
        raw.byteOffset + raw.byteLength
      );
      const blp = decodeBLP(arrayBuffer);
      const image = getBLPImageData(blp, 0);

      const width = Number(image.width);
      const height = Number(image.height);
      
      const expectedBytes = width * height * 4;
      if (!image.data || image.data.length !== expectedBytes) {
        throw new Error(`Invalid pixel data length`);
      }

      const png = new PNG({ width, height });
      for (let i = 0; i < expectedBytes; i++) {
        png.data[i] = image.data[i];
      }
      const pngBuf = PNG.sync.write(png);

      const outDir = path.join(config.outputDir, 'decoded-textures');
      fs.mkdirSync(outDir, { recursive: true });
      const outName = path.basename(res.resolvedPath, '.blp') + '.png';
      const outPath = path.join(outDir, outName);
      fs.writeFileSync(outPath, pngBuf);

      decodedTextures.push({ path: res.resolvedPath, pngPath: outPath });
    } catch (error: any) {
      console.warn(`Decode failed for ${res.resolvedPath}: ${error.message}`);
    }
  }

  // Phase 5: Trace geoset-to-material-to-texture assignments
  console.log('\n=== PHASE 5: GEOSET/MATERIAL/TEXTURE MAPPING ===');
  
  const mappingTable = [];
  for (let gi = 0; gi < geosets.length; gi++) {
    const g = geosets[gi];
    const rawMatId = Number(g.MaterialID ?? 0);
    const matId = Math.max(0, Math.min(rawMatId, materials.length - 1));
    
    const materialLayers = materials[matId] || [];
    for (let li = 0; li < materialLayers.length; li++) {
      const layer = materialLayers[li];
      const textureEntry = textures[layer.textureId] || null;
      
      mappingTable.push({
        geosetIndex: gi,
        materialId: matId,
        layerIndex: li,
        textureId: layer.textureId,
        textureEntry,
        resolvedPath: textureResolutions[layer.textureId]?.resolvedPath || null,
        coordId: layer.coordId,
      });
    }
  }

  // Phase 6: Verify UV coordinate handling (would need GLB output for full verification)
  console.log('\n=== PHASE 6: UV COORDINATE HANDLING ===');
  console.log(`UV sets per geoset documented in mapping table`);

  const result = {
    modelPath: config.modelPath,
    fileHash: 'pending', // Will be computed after reading file
    geosetCount: geosets.length,
    materialCount: materials.length,
    textureCount: textures.length,
    blpCount: blps.length,
    textures,
    materials,
    geosets,
    textureResolutions,
    mappingTable,
  };

  return result;
}

async function main() {
  const args = process.argv.slice(2);
  let modelPath = '';
  let matchingMode = NORMAL_MATCHING_MODE;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--strict') {
      matchingMode = STRICT_MATCHING_MODE;
    } else if (!args[i].startsWith('-')) {
      modelPath = args[i];
    }
  }

  if (!modelPath) {
    console.error('Usage: npx tsx diagnostic-pass-2.ts <model.mdx> [--strict]');
    process.exit(2);
  }

  // Create output directory
  fs.mkdirSync(DIAGNOSTIC_OUTPUT_DIR, { recursive: true });
  
  const config: DiagnosticConfig = {
    modelPath,
    textureRoot: path.join(TESTER_DIR),
    outputDir: DIAGNOSTIC_OUTPUT_DIR,
    matchingMode,
  };

  try {
    const result = await runDiagnostic(config);
    
    // Compute file hash
    const raw = fs.readFileSync(result.modelPath);
    result.fileHash = require('crypto').createHash('sha256')
      .update(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
      .digest('hex');

    // Save diagnostic results
    const reportPath = path.join(DIAGNOSTIC_OUTPUT_DIR, `${path.basename(result.modelPath, '.mdx')}-diagnostic.json`);
    fs.writeFileSync(reportPath, JSON.stringify(result, null, 2));
    
    console.log(`\n=== DIAGNOSTIC COMPLETE ===`);
    console.log(`Report saved to: ${reportPath}`);
    console.log(`Decoded textures in: ${path.join(DIAGNOSTIC_OUTPUT_DIR, 'decoded-textures')}`);

  } catch (error: any) {
    console.error(`Diagnostic failed: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
