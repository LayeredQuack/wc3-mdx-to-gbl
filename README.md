# Warcraft III MPQ → MDX information extraction scripts

## Purpose

These scripts implement the first two stages of a batch asset pipeline:

1. `scan_mpqs.py` discovers every `.mpq` below an input directory and extracts Warcraft III MDX/MDL models and common texture formats while preserving archive paths.
2. `convert-model.ts` reads each extracted MDX and writes a JSON representation of core mesh, texture-reference, skeleton, and animation-track information.

They deliberately do **not** create GLB files yet. The JSON output is an auditable intermediate representation for a subsequent MDX → GLB writer.

## 1. Prerequisites

- Python 3.10+.
- `mpqtool` (`ceres-mpqtool`) installed and on `PATH`. Its documented `extract` operation accepts an archive, an output directory, and a glob filter. It is built for MPQ archives, including Warcraft III assets.
- Node.js 20+ and a TypeScript runner such as `tsx` for the TypeScript script.

Install/use these dependencies only from sources approved for your environment.

## 2. Extract models and textures from all MPQs

```bash
python scan_mpqs.py /path/to/mpq_directory ./wc3_output
```

The output includes:

- `wc3_output/extracted/...`: MDX, MDL, BLP, DDS, and TGA assets.
- `wc3_output/mpq_extraction_manifest.json`: archive/file hash and extraction record.

To invoke a particular executable:

```bash
python scan_mpqs.py /path/to/mpq_directory ./wc3_output --mpqtool /path/to/mpqtool
```

Use `--include-all` only when you want every archive file. Use `--overwrite` only after reviewing existing extraction output.

## 3. Extract MDX information as JSON

```bash
npx tsx extract_mdx_info.ts ./wc3_output/extracted --out ./wc3_output/mdx-json
```

Add `--raw` to include the raw binary payload of every top-level MDX chunk as Base64. This produces large JSON files but retains exact chunk data for fields not semantically decoded.

## What the MDX script extracts directly

For Classic-style MDX data, the script extracts:

- model header and format version;
- sequence names, intervals, flags, movement speed, rarity, sync point, and extents;
- texture references and replaceable-texture IDs;
- geosets: positions, normals, triangle indices, vertex groups, matrices, material/selection data, extents, and UV sets;
- bones, helpers, attachments, hierarchy IDs, transform tracks, and common animation interpolation data;
- global-sequence durations and pivot points.

It inventories all remaining top-level chunks. It is intentionally conservative with Reforged-specific fields: unparsed tails and/or full raw chunks should be retained for the GLB conversion stage rather than guessed.

## Operational limits

- An MPQ may contain no usable filename list, or an MDX can reference textures stored in another MPQ. The extractor cannot reconstruct unavailable paths or files.
- Preserve extracted directory paths. MDX texture references are normally path-based.
- `--raw` JSON can be much larger than the source MDX because Base64 increases size.
- The scripts do not determine entitlement, license, or redistribution rights for source assets.
