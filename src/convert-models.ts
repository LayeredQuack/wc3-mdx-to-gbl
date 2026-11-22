/**
 * MDX → glTF batch converter entry point.
 *
 * Reads CLI arguments, builds the texture index, discovers models, runs
 * convertOne() for each, and prints the final report. All heavy lifting lives
 * in the specialized modules under conversion/, textures/, materials/, etc.
 */

import * as fs from 'fs';
import * as path from 'path';

import { ModelConversionReporter } from './reporting/conversion-reporter';
import { getFilesRecursive } from './io/file-discovery';
import { buildTextureIndex } from './textures/texture-index';
import { convertOne } from './conversion/convert-model';

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
