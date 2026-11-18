# Warcraft III MPQ → GLB Conversion Pipeline

## Purpose

These scripts implement a batch asset pipeline for extracting 3D models, textures, and animations from Warcraft III MPQ archives and converting them into GLB files. The pipeline consists of two main scripts:

1. `scan_mpqs.py`: Discovers and extracts `.mdx`, `.mdl`, `.blp`, `.dds`, and `.tga` assets from MPQ archives while preserving archive paths.
2. `convert-models.ts`: Reads each extracted MDX file and writes a GLB file containing the model, textures, and animations.

## Prerequisites

- Python 3.10+.
- `mpqtool` (`ceres-mpqtool`) installed and on `PATH`. Its documented `extract` operation accepts an archive, an output directory, and a glob filter. It is built for MPQ archives, including Warcraft III assets.
- Node.js 20+ and a TypeScript runner such as `tsx` for the TypeScript script.

Install/use these dependencies only from sources approved for your environment.

## 1. Extract models and textures from all MPQs

```bash
python scan_mpqs.py /path/to/mpq_directory ./wc3_output
```

The output includes:

- `wc3_output/extracted/...`: MDX, MDL, BLP, DDS, and TGA assets.
- `wc3_output/mpq_extraction_manifest.json`: archive/file hash and extraction record.

### CLI Arguments for `scan_mpqs.py`

- `input_dir`: Directory recursively searched for `*.mpq` files.
- `output_dir`: Output root; each archive gets a separate folder.
- `--mpqtool`: Path/name of `mpqtool` executable (default: `mpqtool`).
- `--include-all`: Extract all archive files, not only MDX/MDL/BLP/DDS/TGA.
- `--overwrite`: Allow writing into existing per-archive output folders.
- `--verbose`: Enable verbose output.

### Example Commands

```bash
# Basic usage
python scan_mpqs.py /path/to/mpq_directory ./wc3_output

# Using a custom mpqtool path
python scan_mpqs.py /path/to/mpq_directory ./wc3_output --mpqtool /path/to/mpqtool

# Extract all files and overwrite existing output folders
python scan_mpqs.py /path/to/mpq_directory ./wc3_output --include-all --overwrite
```

## 2. Convert MDX files to GLB

```bash
npx tsx convert-models.ts ./wc3_output/extracted --out ./wc3_output/glb
```

### CLI Arguments for `convert-models.ts`

- `input_dir`: Directory containing extracted MDX files.
- `--out`: Output directory for GLB files (default: `converted-glb`).

### Example Commands

```bash
# Basic usage
npx tsx convert-models.ts ./wc3_output/extracted --out ./wc3_output/glb

# Using a custom output directory
npx tsx convert-models.ts ./wc3_output/extracted --out ./custom_output
```

## Operational Limits

- An MPQ may contain no usable filename list, or an MDX can reference textures stored in another MPQ. The extractor cannot reconstruct unavailable paths or files.
- Preserve extracted directory paths. MDX texture references are normally path-based.
- The scripts do not determine entitlement, license, or redistribution rights for source assets.

