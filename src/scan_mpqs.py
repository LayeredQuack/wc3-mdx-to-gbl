
#!/usr/bin/env python3
"""Extract Warcraft III assets from MPQ, W3N, W3M, and W3X archives.

Requires mpqcli, a StormLib-based MPQ command-line tool.

Supported archives:
    .mpq - Standard Warcraft III archives
    .w3n - Custom campaigns
    .w3m - Reign of Chaos maps
    .w3x - Frozen Throne maps

Campaign extraction is recursive by default: embedded W3M/W3X maps are
extracted temporarily, scanned, and their assets placed under maps/.

The script does not modify source archives.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import tempfile

from datetime import datetime, timezone
from pathlib import Path, PurePosixPath


ARCHIVE_EXTS = {".mpq", ".w3n", ".w3m", ".w3x"}
NESTED_MAP_EXTS = {".w3m", ".w3x"}

ASSET_EXTS = {".mdx", ".mdl", ".blp", ".dds", ".tga"}
AUDIO_EXTS = {".wav", ".mp3"}

TEXTURE_EXTS = {".blp", ".dds", ".tga"}


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()

    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)

    return h.hexdigest()


def run(
    cmd: list[str],
    verbose: bool,
    input_text: str | None = None,
) -> subprocess.CompletedProcess[str]:
    if verbose:
        print("+", " ".join(map(str, cmd)))

    return subprocess.run(
        cmd,
        input=input_text,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def archive_path_to_output(dest: Path, archive_name: str) -> Path | None:
    """Convert an archive entry name into a safe filesystem path."""

    normalized = archive_name.replace("\\", "/")
    relative = PurePosixPath(normalized)

    # Reject absolute paths and directory traversal entries.
    if relative.is_absolute() or ".." in relative.parts:
        return None

    return dest.joinpath(*relative.parts)


def selected_extensions(args: argparse.Namespace) -> set[str]:
    extensions = set(ASSET_EXTS)

    if args.include_audio:
        extensions.update(AUDIO_EXTS)

    return extensions


def collect_files(
    dest: Path,
    args: argparse.Namespace,
) -> list[dict]:
    """Collect extracted files and calculate their hashes."""

    files = []
    allowed_extensions = selected_extensions(args)

    for path in sorted(x for x in dest.rglob("*") if x.is_file()):
        if args.include_all or path.suffix.lower() in allowed_extensions:
            files.append(
                {
                    "path": path.relative_to(dest).as_posix(),
                    "bytes": path.stat().st_size,
                    "sha256": sha256_file(path),
                }
            )

    return files


def count_extensions(files: list[dict], extensions: set[str]) -> int:
    return sum(
        Path(item["path"]).suffix.lower() in extensions
        for item in files
    )


def extract_entries(
    mpqcli: str,
    archive: Path,
    dest: Path,
    entries: list[str],
    args: argparse.Namespace,
) -> dict:
    """Extract selected entries and report missing or invalid files."""

    valid_entries = []
    invalid_entries = []

    for name in entries:
        if archive_path_to_output(dest, name) is None:
            invalid_entries.append(name)
        else:
            valid_entries.append(name)

    failures = []

    if valid_entries:
        dest.mkdir(parents=True, exist_ok=True)

        extract_input = "\n".join(valid_entries) + "\n"

        extraction = run(
            [
                mpqcli,
                "extract",
                str(archive),
                "--output",
                str(dest),
                "-",
            ],
            args.verbose,
            input_text=extract_input,
        )

        if extraction.returncode != 0:
            failures.append(
                {
                    "stage": "extract",
                    "returncode": extraction.returncode,
                    "stdout": extraction.stdout[-2000:],
                    "stderr": extraction.stderr[-2000:],
                }
            )

        missing_entries = []

        for name in valid_entries:
            expected_path = archive_path_to_output(dest, name)

            if expected_path is None or not expected_path.is_file():
                missing_entries.append(name)

        if missing_entries:
            failures.append(
                {
                    "stage": "extract_missing_files",
                    "missing_count": len(missing_entries),
                    "missing_files": missing_entries[:50],
                    "message": (
                        "Only the first 50 missing filenames are included."
                        if len(missing_entries) > 50
                        else "Some requested files were not extracted."
                    ),
                }
            )

    if invalid_entries:
        failures.append(
            {
                "stage": "invalid_archive_paths",
                "invalid_count": len(invalid_entries),
                "invalid_files": invalid_entries[:50],
            }
        )

    files = collect_files(dest, args) if dest.exists() else []

    return {
        "files": files,
        "failures": failures,
        "valid_entries": len(valid_entries),
        "invalid_entries": len(invalid_entries),
    }


def list_archive(
    mpqcli: str,
    archive: Path,
    args: argparse.Namespace,
) -> tuple[list[str], dict | None]:
    """List archive entries using mpqcli."""

    listing = run(
        [mpqcli, "list", "--all", str(archive)],
        args.verbose,
    )

    if listing.returncode != 0:
        return [], {
            "stage": "list",
            "returncode": listing.returncode,
            "stdout": listing.stdout[-2000:],
            "stderr": listing.stderr[-2000:],
        }

    entries = [
        line.rstrip("\r\n")
        for line in listing.stdout.splitlines()
        if line.rstrip("\r\n")
    ]

    return entries, None


def select_entries(
    archive_entries: list[str],
    args: argparse.Namespace,
) -> list[str]:
    """Apply the asset/audio extension filters."""

    if args.include_all:
        return archive_entries

    allowed_extensions = selected_extensions(args)

    return [
        name
        for name in archive_entries
        if PurePosixPath(name.replace("\\", "/")).suffix.lower()
        in allowed_extensions
    ]


def process_archive(
    mpqcli: str,
    archive: Path,
    dest: Path,
    args: argparse.Namespace,
    is_campaign: bool = False,
) -> dict:
    """Extract assets from an archive and optionally process campaign maps."""

    print(f"  Scanning: {archive.name}")

    archive_entries, listing_error = list_archive(
        mpqcli,
        archive,
        args,
    )

    if listing_error:
        return {
            "status": "list_error",
            "listed_entries": 0,
            "selected_entries": 0,
            "extracted_files": 0,
            "mdx_count": 0,
            "texture_count": 0,
            "audio_count": 0,
            "files": [],
            "nested_maps": [],
            "tool_messages": [listing_error],
        }

    selected_entries = select_entries(archive_entries, args)

    # Campaign-level assets are separated from assets belonging to missions.
    asset_dest = dest / "campaign_assets" if is_campaign else dest

    direct_result = extract_entries(
        mpqcli,
        archive,
        asset_dest,
        selected_entries,
        args,
    )

    direct_files = direct_result["files"]
    failures = list(direct_result["failures"])

    nested_maps = []

    # Only campaign archives contain maps that we need to extract recursively.
    if is_campaign and not args.no_recursive_maps:
        map_entries = [
            name
            for name in archive_entries
            if PurePosixPath(name.replace("\\", "/")).suffix.lower()
            in NESTED_MAP_EXTS
        ]

        if map_entries:
            print(f"  Found {len(map_entries)} embedded campaign maps.")

        for map_name in map_entries:
            print(f"    Extracting embedded map: {map_name}")

            map_result = {
                "archive_entry": map_name,
                "status": "pending",
                "extracted_files": 0,
                "mdx_count": 0,
                "texture_count": 0,
                "audio_count": 0,
                "files": [],
            }

            if archive_path_to_output(Path("/tmp"), map_name) is None:
                map_result.update(
                    status="invalid_path",
                    message="Rejected unsafe embedded map path.",
                )
                nested_maps.append(map_result)
                failures.append(
                    {
                        "stage": "invalid_embedded_map_path",
                        "archive_entry": map_name,
                    }
                )
                continue

            # Extract the embedded map into a temporary directory.
            # Its extracted assets will go into the permanent output folder.
            with tempfile.TemporaryDirectory(
                prefix="wc3_nested_map_"
            ) as temp_name:
                temp_dest = Path(temp_name)

                nested_extract = run(
                    [
                        mpqcli,
                        "extract",
                        str(archive),
                        "--output",
                        str(temp_dest),
                        "-",
                    ],
                    args.verbose,
                    input_text=map_name + "\n",
                )

                temp_map = archive_path_to_output(
                    temp_dest,
                    map_name,
                )

                if nested_extract.returncode != 0 or (
                    temp_map is None or not temp_map.is_file()
                ):
                    map_result.update(
                        status="extract_error",
                        tool_messages=[
                            {
                                "stage": "extract_embedded_map",
                                "returncode": nested_extract.returncode,
                                "stdout": nested_extract.stdout[-2000:],
                                "stderr": nested_extract.stderr[-2000:],
                            }
                        ],
                    )
                    nested_maps.append(map_result)
                    failures.append(
                        {
                            "stage": "extract_embedded_map",
                            "archive_entry": map_name,
                        }
                    )
                    continue

                map_sha256 = sha256_file(temp_map)
                map_relative = PurePosixPath(
                    map_name.replace("\\", "/")
                )

                map_base = Path(*map_relative.parts).with_suffix("")

                map_folder_name = (
                    f"{map_base.name}_{map_sha256[:12]}"
                )

                map_dest = (
                    dest
                    / "maps"
                    / map_base.parent
                    / map_folder_name
                )

                print(f"      Scanning map: {map_relative.name}")

                map_assets = process_archive(
                    mpqcli,
                    temp_map,
                    map_dest,
                    args,
                    is_campaign=False,
                )

                map_result.update(
                    sha256=map_sha256,
                    output=map_dest.relative_to(dest).as_posix(),
                    status=map_assets["status"],
                    listed_entries=map_assets["listed_entries"],
                    selected_entries=map_assets["selected_entries"],
                    extracted_files=map_assets["extracted_files"],
                    mdx_count=map_assets["mdx_count"],
                    texture_count=map_assets["texture_count"],
                    audio_count=map_assets["audio_count"],
                    files=map_assets["files"],
                )

                if map_assets.get("tool_messages"):
                    map_result["tool_messages"] = map_assets[
                        "tool_messages"
                    ]

                nested_maps.append(map_result)

                if map_assets["status"] in {
                    "list_error",
                    "extract_error",
                    "partial",
                }:
                    failures.append(
                        {
                            "stage": "process_embedded_map",
                            "archive_entry": map_name,
                            "status": map_assets["status"],
                        }
                    )

    nested_file_count = sum(
        item["extracted_files"] for item in nested_maps
    )

    nested_mdx_count = sum(
        item["mdx_count"] for item in nested_maps
    )

    nested_texture_count = sum(
        item["texture_count"] for item in nested_maps
    )

    nested_audio_count = sum(
        item["audio_count"] for item in nested_maps
    )

    direct_mdx_count = count_extensions(direct_files, {".mdx"})
    direct_texture_count = count_extensions(direct_files, TEXTURE_EXTS)
    direct_audio_count = count_extensions(direct_files, AUDIO_EXTS)

    total_files = len(direct_files) + nested_file_count

    if failures:
        status = "partial" if total_files else "extract_error"
    elif total_files:
        status = "ok"
    else:
        status = "no_assets"

    result = {
        "status": status,
        "listed_entries": len(archive_entries),
        "selected_entries": len(selected_entries),
        "extracted_files": total_files,
        "direct_extracted_files": len(direct_files),
        "nested_extracted_files": nested_file_count,
        "mdx_count": direct_mdx_count + nested_mdx_count,
        "texture_count": direct_texture_count + nested_texture_count,
        "audio_count": direct_audio_count + nested_audio_count,
        "files": direct_files,
        "nested_maps": nested_maps,
    }

    if failures:
        result["tool_messages"] = failures

    return result


def main() -> int:
    ap = argparse.ArgumentParser(
        description=(
            "Extract Warcraft III assets from MPQ, W3N, W3M, and W3X "
            "archives."
        )
    )

    ap.add_argument(
        "input_dir",
        type=Path,
        help="Directory recursively searched for Warcraft III archives",
    )
    ap.add_argument(
        "output_dir",
        type=Path,
        help="Output root; each source archive gets a separate folder",
    )
    ap.add_argument(
        "--mpqcli",
        default="mpqcli",
        help="Path/name of mpqcli executable (default: mpqcli)",
    )
    ap.add_argument(
        "--include-all",
        action="store_true",
        help="Extract every file in each archive",
    )
    ap.add_argument(
        "--include-audio",
        action="store_true",
        help="Also extract audio files (.wav, .mp3)",
    )
    ap.add_argument(
        "--no-recursive-maps",
        action="store_true",
        help="Do not extract embedded W3M/W3X maps from W3N campaigns",
    )
    ap.add_argument(
        "--overwrite",
        action="store_true",
        help="Allow writing into existing per-archive output folders",
    )
    ap.add_argument("--verbose", action="store_true")

    args = ap.parse_args()

    if not args.input_dir.is_dir():
        ap.error(f"Not a directory: {args.input_dir}")

    mpqcli_arg = str(Path(args.mpqcli).expanduser())
    mpqcli_exe = shutil.which(mpqcli_arg)

    if mpqcli_exe is None and Path(mpqcli_arg).is_file():
        mpqcli_exe = mpqcli_arg

    if mpqcli_exe is None:
        ap.error(
            "mpqcli was not found. Install it or pass --mpqcli /path/to/mpqcli."
        )

    input_root = args.input_dir.resolve()
    output_root = args.output_dir.resolve()

    archives = sorted(
        path
        for path in input_root.rglob("*")
        if path.is_file()
        and path.suffix.lower() in ARCHIVE_EXTS
        and not (
            output_root == path.resolve()
            or output_root in path.resolve().parents
        )
    )

    args.output_dir.mkdir(parents=True, exist_ok=True)

    manifest: dict = {
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "input_dir": str(input_root),
        "archives_found": len(archives),
        "extraction_tool": "mpqcli",
        "supported_archive_extensions": sorted(ARCHIVE_EXTS),
        "include_all": args.include_all,
        "include_audio": args.include_audio,
        "recursive_campaign_maps": not args.no_recursive_maps,
        "archives": [],
    }

    for ordinal, archive in enumerate(archives, 1):
        rel = archive.relative_to(input_root)

        archive_sha256 = sha256_file(archive)
        digest = archive_sha256[:12]

        # The hash suffix prevents collisions between similarly named archives.
        dest = args.output_dir / "extracted" / rel.with_suffix("")
        dest = dest.parent / f"{dest.name}_{digest}"

        entry = {
            "archive": str(rel),
            "archive_type": archive.suffix.lower(),
            "sha256": archive_sha256,
            "output": str(dest.relative_to(args.output_dir)),
            "status": "pending",
        }

        print()
        print(f"[{ordinal}/{len(archives)}] {rel}")

        # Preserve the existing protection against AVI videos with MPQ extensions.
        if archive.suffix.lower() == ".mpq":
            with archive.open("rb") as f:
                signature = f.read(4)

            if signature == b"RIFF":
                entry.update(
                    status="skipped_non_mpq",
                    detected_format="RIFF/AVI",
                    signature_hex=signature.hex(),
                    message=(
                        "File has a RIFF signature and is not an MPQ archive."
                    ),
                )
                print("  Skipped: RIFF/AVI file, not an MPQ archive.")
                manifest["archives"].append(entry)
                continue

        if dest.exists() and not args.overwrite:
            entry.update(
                status="skipped_existing",
                message=(
                    "Use --overwrite to permit extraction to an existing folder."
                ),
            )
            print("  Skipped: output folder already exists.")
            manifest["archives"].append(entry)
            continue

        dest.mkdir(parents=True, exist_ok=True)

        result = process_archive(
            mpqcli_exe,
            archive,
            dest,
            args,
            is_campaign=archive.suffix.lower() == ".w3n",
        )

        entry.update(result)

        print(
            f"  Status: {entry['status']} | "
            f"Files: {entry['extracted_files']} | "
            f"MDX: {entry['mdx_count']} | "
            f"Textures: {entry['texture_count']} | "
            f"Audio: {entry['audio_count']}"
        )

        if entry.get("nested_maps"):
            print(
                f"  Campaign maps processed: {len(entry['nested_maps'])}"
            )

        manifest["archives"].append(entry)

    out = args.output_dir / "mpq_extraction_manifest.json"

    out.write_text(
        json.dumps(manifest, indent=2),
        encoding="utf-8",
    )

    print()
    print(f"Wrote {out}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
