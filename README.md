# Warcraft III MPQ to MDX to GLB Conversion Pipeline

## Project Overview

This repository contains tools for extracting Warcraft III models, textures, and audio from game archives, custom campaigns, and custom maps, then converting MDX models into GLB files.

The pipeline consists of two main scripts:

1. **`src/scan_mpqs.py`** — Discovers Warcraft III archives and extracts model, texture, and optionally audio assets while preserving their archive directory structure.
2. **`src/convert-models.ts`** — Converts MDX models into GLB files, including their available textures and animations. It can also be used with custom MDX files.

The extraction tool supports standard MPQ archives, custom campaigns, and custom maps. Campaign extraction includes scanning and extracting embedded mission maps.

## Features

### Asset extraction

- Extracts `.mdx` and `.mdl` model files.
- Extracts `.blp`, `.dds`, and `.tga` textures.
- Optionally extracts `.wav` and `.mp3` audio files.
- Supports extracting every archive entry with `--include-all`.
- Supports standard Warcraft III `.mpq` archives.
- Supports custom campaign `.w3n` files.
- Supports standalone `.w3m` and `.w3x` maps.
- Scans embedded `.w3m` and `.w3x` maps inside campaigns.
- Keeps campaign-level assets separate from individual mission-map assets.
- Preserves archive paths and directory structures.
- Generates a detailed JSON extraction manifest.
- Calculates SHA-256 hashes for extracted files.
- Provides verbose output for debugging.

### Model conversion

- Converts MDX models to GLB.
- Resolves available BLP textures.
- Preserves model animations.
- Supports custom MDX files.
- Generates a conversion report.

## Requirements and Dependencies

### Extraction

- Python 3.10 or newer.
- `mpqcli`, a StormLib-based MPQ command-line tool.

The `mpqcli` executable must be available in your system PATH, or its location must be supplied using `--mpqcli`.

### Conversion

- Node.js 20 or newer.
- Project npm dependencies.
- `tsx` for executing the TypeScript conversion script.

## Installation and Setup

Clone the repository:

```bash
git clone https://github.com/LayeredQuack/wc3-mdx-to-gbl.git
cd wc3-mdx-to-gbl
```

Install the Node.js dependencies:

```bash
npm install
```

Verify Python:

```bash
python --version
```

Verify that `mpqcli` is available:

```bash
mpqcli --help
```

If `mpqcli` is installed outside your PATH, specify its full location when running the extraction script.

## Extracting Warcraft III Assets (`scan_mpqs.py`)

The extraction script recursively searches an input directory for supported Warcraft III archives.

Supported archive formats:

| Extension | Archive type |
|---|---|
| `.mpq` | Standard Warcraft III archive |
| `.w3n` | Custom campaign |
| `.w3m` | Warcraft III map |
| `.w3x` | Warcraft III expansion/custom map |

When a campaign is encountered, the script extracts its campaign-level assets and scans its embedded mission maps. Assets from individual maps are kept separate from campaign-level assets.

### Basic usage

```bash
python src/scan_mpqs.py \
  "/path/to/Warcraft-III" \
  "./wc3_extracts"
```

This searches the Warcraft III installation directory, extracts supported assets, and writes the results under the specified output directory.

### Recommended usage: include audio

To extract models, textures, and audio:

```bash
python src/scan_mpqs.py \
  "/path/to/Warcraft-III" \
  "./wc3_extracts" \
  --include-audio \
  --verbose
```

The `--include-audio` option adds `.wav` and `.mp3` files to the default extraction formats.

### Extract everything

To extract all archive entries, regardless of file extension:

```bash
python src/scan_mpqs.py \
  "/path/to/Warcraft-III" \
  "./wc3_extracts_all" \
  --include-all \
  --verbose
```

`--include-all` takes precedence over the normal extension filters. It does not require `--include-audio`.

### Arguments and options

| Argument | Description |
|---|---|
| `input_dir` | Directory recursively searched for supported archives. |
| `output_dir` | Output root where extracted files and the manifest are written. |
| `--mpqcli` | Path or executable name for `mpqcli`. Defaults to `mpqcli`. |
| `--include-audio` | Also extract `.wav` and `.mp3` files. |
| `--include-all` | Extract all archive entries, regardless of extension. |
| `--overwrite` | Allow extraction into existing per-archive output directories. |
| `--verbose` | Display the commands being executed and additional extraction details. |

See all available options:

```bash
python src/scan_mpqs.py --help
```

### Default extraction formats

Without additional options, the script extracts:

- `.mdx`
- `.mdl`
- `.blp`
- `.dds`
- `.tga`

With `--include-audio`, it also extracts:

- `.wav`
- `.mp3`

With `--include-all`, all archive entries are selected.

### Output organization

Each source archive receives its own output directory. A short SHA-256 hash is appended to the directory name to prevent naming collisions.

For campaigns, campaign-level assets and embedded mission maps are organized separately.

Example:

```text
wc3_extracts/
├── extracted/
│   ├── war3_<hash>/
│   ├── war3x_<hash>/
│   ├── DotA v6.76c_<hash>/
│   ├── DemoCampaign_<hash>/
│   │   ├── campaign_assets/
│   │   └── maps/
│   │       ├── Demo03_<hash>/
│   │       ├── Demo04_<hash>/
│   │       └── Demo05_<hash>/
│   └── Warcraft 1 Remake - orcs_<hash>/
│       ├── campaign_assets/
│       └── maps/
│           ├── Finale_<hash>/
│           └── Introduzione_<hash>/
└── mpq_extraction_manifest.json
```

The exact directory names and number of maps depend on the source archives.

### Campaign extraction

Campaign archives (`.w3n`) can contain both shared campaign assets and individual mission maps.

The scanner processes these separately:

- `campaign_assets/` contains assets stored directly in the campaign archive.
- `maps/` contains assets extracted from the embedded `.w3m` and `.w3x` mission maps.

This is important because a campaign's models, textures, and audio may be distributed between its campaign archive and individual missions.

### Extraction manifest

The script generates:

```text
mpq_extraction_manifest.json
```

The manifest records extraction information, including:

- Source archive names and paths.
- Archive SHA-256 hashes.
- Output directories.
- Extraction status.
- Number of entries listed and selected.
- Extracted file paths.
- Extracted file sizes.
- SHA-256 hashes of extracted files.
- MDX model counts.
- Texture counts.
- Audio counts.
- Extraction errors and missing files.

Campaign and nested-map processing information is also recorded so that extracted assets can be traced back to their source.

### Overwrite behavior

By default, the script skips an archive when its corresponding output directory already exists.

Use `--overwrite` to allow extraction into existing output directories:

```bash
python src/scan_mpqs.py \
  "/path/to/Warcraft-III" \
  "./wc3_extracts" \
  --include-audio \
  --overwrite
```

### Verbose output

Use `--verbose` to display the `mpqcli` commands and additional extraction information.

For example, to scan only a campaign directory:

```bash
python src/scan_mpqs.py \
  "/path/to/Warcraft-III/Campaigns" \
  "./campaign_extracts" \
  --include-audio \
  --verbose
```

Replace `/path/to/Warcraft-III` with the location of your own Warcraft III installation.

## Converting MDX Models to GLB (`convert-models.ts`)

The conversion script reads MDX files and produces GLB files containing the model, available textures, and animations.

### Basic usage

```bash
npx tsx src/convert-models.ts \
  "./wc3_extracts/extracted"
```

By default, converted models are written to:

```text
converted-glb/
```

### Specify an output directory

Use `--out` to choose where converted GLB files are written:

```bash
npx tsx src/convert-models.ts \
  "./wc3_extracts/extracted" \
  --out "./wc3_glb"
```

### Specify a texture search root

Use `--texture-root` to specify the directory used to discover and resolve textures.

```bash
npx tsx src/convert-models.ts \
  "./wc3_extracts/extracted" \
  --out "./wc3_glb" \
  --texture-root "./wc3_extracts/extracted"
```

If `--texture-root` is not specified, the input directory is used as the default texture search root.

### Conversion arguments

| Argument | Description |
|---|---|
| `input_dir` | Directory containing MDX files to convert. |
| `--out` | Output directory for generated GLB files. Defaults to `converted-glb`. |
| `--texture-root` | Root directory used for texture discovery and resolution. Defaults to the input directory. |

### Texture discovery and resolution

The converter builds a texture index from the texture search root and uses it to locate textures referenced by MDX models.

For the best results:

- Keep extracted textures available alongside the extracted models.
- Preserve the original archive directory structure.
- Use the extraction root as the texture search root when converting a complete extraction.
- Ensure that required BLP textures are available to the converter.

### Conversion reports

The converter generates:

```text
conversion_report.txt
```

The report is written into the conversion output directory and contains information about the conversion results.

## Recommended Workflow

A typical workflow is:

1. Locate the Warcraft III installation directory.
2. Run `scan_mpqs.py` to extract models, textures, and audio.
3. Include audio if unit sounds, dialogue, or music are needed.
4. Allow the scanner to process campaign mission maps.
5. Use the extraction root as the input directory for the converter.
6. Run `convert-models.ts`.
7. Inspect the resulting GLB files in Blender or another glTF-compatible application.

### Complete example

The following commands demonstrate a complete extraction and conversion workflow on Linux.

**Step 1: Extract Warcraft III assets**

```bash
python src/scan_mpqs.py \
  "/path/to/Warcraft-III" \
  "./wc3_extracts" \
  --include-audio \
  --verbose
```

**Step 2: Convert extracted MDX models to GLB**

```bash
npx tsx src/convert-models.ts \
  "./wc3_extracts/extracted" \
  --out "./wc3_glb" \
  --texture-root "./wc3_extracts/extracted"
```

**Step 3: Inspect the output**

```bash
ls "./wc3_glb"
```

Open the resulting GLB files in Blender or another compatible viewer.

## Output Files and Reports

A typical extraction and conversion workflow produces:

| Output | Description |
|---|---|
| `extracted/` | Extracted models, textures, and optionally audio. |
| `mpq_extraction_manifest.json` | Archive and extracted-file metadata, hashes, counts, and errors. |
| `converted-glb/` or `wc3_glb/` | Converted GLB models. |
| `conversion_report.txt` | Model conversion results and diagnostics. |

The actual output directory names depend on the paths supplied when running the scripts.

## Troubleshooting

### `mpqcli` not found

Verify that `mpqcli` is installed and available:

```bash
which mpqcli
mpqcli --help
```

If necessary, specify its full path:

```bash
python src/scan_mpqs.py \
  "/path/to/Warcraft-III" \
  "./wc3_extracts" \
  --mpqcli /path/to/mpqcli
```

### No assets extracted

- Verify that the input directory contains supported archive files.
- Check that the archive is readable by `mpqcli`.
- Review the extraction manifest for archive errors or missing entries.
- Remember that the default filter only selects the supported model and texture formats. Use `--include-audio` for audio or `--include-all` for every archive entry.

### Existing output directories are skipped

Use `--overwrite` if you intend to extract into existing output directories.

### Campaign maps are missing

Check the verbose output for campaign-map scanning messages. Review the manifest to identify maps that failed to extract or could not be opened.

### Models have missing textures

- Verify that the referenced BLP files were extracted.
- Preserve the extracted directory structure.
- Check the texture search root supplied to `convert-models.ts`.
- Review the conversion report for texture-resolution diagnostics.

### Conversion errors

- Verify that Node.js and the project dependencies are installed.
- Confirm that the input directory contains MDX files.
- Review `conversion_report.txt` for details about failed conversions.

## Notes and Limitations

- Extraction relies on `mpqcli` for archive listing and extraction.
- The scanner does not modify the original MPQ, campaign, or map archives.
- Audio extraction copies audio files; it does not convert or identify their contents.
- Custom maps may use numbered filenames such as `File00000161.mdx` or `File00000781.mp3`. These names are preserved as stored in the archive.
- Some archives may contain protected or unusual content that cannot be extracted successfully.
- Extracting an asset does not guarantee that every model dependency or texture reference will be resolved during GLB conversion.

---

## License and Usage

Use extracted Warcraft III assets in accordance with the applicable game, modding, and asset-distribution permissions. This project provides tools for extracting and converting files; it does not grant ownership or redistribution rights to the extracted assets.