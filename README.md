# Warcraft III MPQ to MDX to GLB Conversion Pipeline

## Project Overview

This repository contains scripts for extracting 3D models, textures, and animations from Warcraft III MPQ archives and converting them into GLB files. The pipeline consists of two main scripts:

1. `scan_mpqs.py`: Discovers and extracts `.mdx`, `.mdl`, `.blp`, `.dds`, and `.tga` assets from MPQ archives while preserving archive paths.
2. `convert-models.ts`: Reads each extracted MDX file and writes a GLB file containing the model, textures, and animations. Also works on custom MDX files

## Features

- Extracts `.mdx`, `.mdl`, `.blp`, `.dds`, and `.tga` assets from MPQ archives.
- Converts extracted MDX files to GLB format.
- Preserves archive paths during extraction.
- Generates a detailed extraction manifest.
- Provides verbose output for debugging.

## Requirements and Dependencies

- Python 3.10+.
- Node.js 20+ and a TypeScript runner such as `tsx` for the TypeScript script.

Install/use these dependencies only from sources approved for your environment.

## Installation / Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/wc3-mdx-to-glb.git
   cd wc3-mdx-to-glb
   ```

2. Install Node.js dependencies:
   ```bash
   npm install
   ```

3. Ensure Python 3.10+ is installed on your system.

## Extracting Warcraft III Assets (`scan_mpqs.py`)

The `scan_mpqs.py` script extracts assets from MPQ archives. It no longer relies on external MPQ command-line tools.

### Usage

```bash
python src/scan_mpqs.py \
  "$HOME/Games/WC3 Install/Warcraft III" \
  "$HOME/Games/WC3 Install/Mods/wc3_extracts"
```

### Arguments

- `input_dir`: Directory recursively searched for `*.mpq` files.
- `output_dir`: Output root; each archive gets a separate folder.
- `--include-all`: Extract all archive files, not only MDX/MDL/BLP/DDS/TGA.
- `--overwrite`: Allow writing into existing per-archive output folders.
- `--verbose`: Enable verbose output.

### How Extracted Files are Organized

- `wc3_output/extracted/...`: MDX, MDL, BLP, DDS, and TGA assets.
- `wc3_output/mpq_extraction_manifest.json`: Archive/file hash and extraction record.

### Which Asset Formats are Included by Default

By default, the script extracts `.mdx`, `.mdl`, `.blp`, `.dds`, and `.tga` assets.

### How to Include All Archive Entries

Use the `--include-all` option to extract all files from the archives.

### How Overwrite Behavior Works

By default, the script will not overwrite existing output folders. Use the `--overwrite` option to allow overwriting.

### How Verbose Output Works

Use the `--verbose` option to enable verbose output for debugging.

### What Information is Recorded in the Extraction Manifest

The manifest includes information about each archive, such as:
- Archive name
- SHA-256 hash
- Output path
- Status
- Extracted files
- MDX and texture counts

### How the Script Handles Invalid Archives or Non-MPQ Files

The script skips invalid archives or non-MPQ files and records the status in the manifest.

## Converting MDX Models to GLB (`convert-models.ts`)

The `convert-models.ts` script converts extracted MDX files to GLB format.

### Usage

```bash
npx tsx src/convert-models.ts tester/
```

### Arguments

- `input_dir`: Directory containing extracted MDX files.
- `--out`: Output directory for GLB files (default: `converted-glb`).

### Required Runtime and Dependencies

- Node.js 20+.
- `tsx` installed globally or locally.

### How to Specify the Input Directory

Specify the directory containing the extracted MDX files.

### Where Converted GLB Files are Written

Converted GLB files are written to the specified output directory (default: `converted-glb`).

### How the Texture Search Root is Determined

The texture search root is determined by the `--texture-root` option. If not specified, it defaults to the input directory.

### How BLP Textures are Discovered and Resolved

BLP textures are discovered and resolved using the texture index built from the texture search root.

### How Users Should Organize Extracted Textures

Users should organize extracted textures in a directory structure that the converter can find them. The texture search root should point to the root directory containing the textures.

### How Conversion Reports are Generated

Conversion reports are generated and saved to `conversion_report.txt` in the output directory.

## Recommended Workflow

1. Locate the Warcraft III installation directory.
2. Run `scan_mpqs.py` to extract the relevant model and texture assets.
3. Use the extracted assets as the input/test directory for conversion.
4. Run `convert-models.ts`.
5. Find the resulting GLB files in the conversion output directory.
6. Inspect the results in Blender or another glTF-compatible application.

Example workflow using realistic Linux paths:

```bash
# Step 1: Extract assets
python src/scan_mpqs.py \
  "$HOME/Games/WC3 Install/Warcraft III" \
  "$HOME/Games/WC3 Install/Mods/wc3_extracts"

# Step 2: Convert MDX models to GLB
npx tsx src/convert-models.ts \
  "$HOME/Games/WC3 Install/Mods/wc3_extracts/extracted" \
  --out "$HOME/Games/WC3 Install/Mods/wc3_glb"
```

## Output Files and Reports

- `wc3_output/extracted/...`: Extracted assets.
- `wc3_output/mpq_extraction_manifest.json`: Extraction manifest.
- `conversion_report.txt`: Conversion report.

## Troubleshooting

- Ensure that the input directories and file paths are correct.
- Verify that all required dependencies are installed.
- Check the extraction and conversion logs for any errors or warnings.

---

This update reflects the current state of the project and provides accurate documentation for users to follow the extraction and conversion workflows.
