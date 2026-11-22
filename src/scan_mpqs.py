#!/usr/bin/env python3
"""Extract Warcraft III model assets from every MPQ below a directory.

Requires mpqcli, a StormLib-based MPQ command-line tool.

The script lists archive entries, filters them by extension, and passes
the selected filenames to mpqcli through stdin. It does not modify archives.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys

from datetime import datetime, timezone
from pathlib import Path, PurePosixPath


ASSET_EXTS = {".mdx", ".mdl", ".blp", ".dds", ".tga"}


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
    """Convert an MPQ entry name into its expected extracted filesystem path."""

    normalized = archive_name.replace("\\", "/")
    relative = PurePosixPath(normalized)

    # Reject absolute paths and traversal entries.
    if relative.is_absolute() or ".." in relative.parts:
        return None

    return dest.joinpath(*relative.parts)


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Extract MDX/texture assets from every MPQ below INPUT_DIR."
    )

    ap.add_argument(
        "input_dir",
        type=Path,
        help="Directory recursively searched for *.mpq files",
    )
    ap.add_argument(
        "output_dir",
        type=Path,
        help="Output root; each archive gets a separate folder",
    )
    ap.add_argument(
        "--mpqcli",
        default="mpqcli",
        help="Path/name of mpqcli executable (default: mpqcli)",
    )
    ap.add_argument(
        "--include-all",
        action="store_true",
        help="Extract all archive files, not only MDX/MDL/BLP/DDS/TGA",
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

    archives = sorted(
        p
        for p in args.input_dir.rglob("*")
        if p.is_file() and p.suffix.lower() == ".mpq"
    )

    args.output_dir.mkdir(parents=True, exist_ok=True)

    manifest: dict = {
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "input_dir": str(args.input_dir.resolve()),
        "archives_found": len(archives),
        "extraction_tool": "mpqcli",
        "archives": [],
    }

    for ordinal, archive in enumerate(archives, 1):
        rel = archive.relative_to(args.input_dir)

        archive_sha256 = sha256_file(archive)
        digest = archive_sha256[:12]

        # The suffix avoids collisions when two folders contain archive names alike.
        dest = args.output_dir / "extracted" / rel.with_suffix("")
        dest = dest.parent / f"{dest.name}_{digest}"

        entry = {
            "archive": str(rel),
            "sha256": archive_sha256,
            "output": str(dest.relative_to(args.output_dir)),
            "status": "pending",
        }

        print(f"[{ordinal}/{len(archives)}] {rel}")

        # Some Warcraft III installations contain AVI videos with .mpq
        # extensions. Detect RIFF files and skip them instead of reporting
        # misleading MPQ extraction errors.
        with archive.open("rb") as f:
            signature = f.read(4)

        if signature == b"RIFF":
            entry.update(
                status="skipped_non_mpq",
                detected_format="RIFF/AVI",
                signature_hex=signature.hex(),
                message="File has a RIFF signature and is not an MPQ archive.",
            )
            print("  Skipped: RIFF/AVI file, not an MPQ archive.")
            manifest["archives"].append(entry)
            continue

        if dest.exists() and not args.overwrite:
            entry.update(
                status="skipped_existing",
                message="Use --overwrite to permit extraction to an existing folder.",
            )
            manifest["archives"].append(entry)
            continue

        dest.mkdir(parents=True, exist_ok=True)

        # First enumerate the archive entries.
        listing = run(
            [mpqcli_exe, "list", "--all", str(archive)],
            args.verbose,
        )

        if listing.returncode != 0:
            entry.update(
                status="list_error",
                tool_messages=[
                    {
                        "stage": "list",
                        "returncode": listing.returncode,
                        "stdout": listing.stdout[-2000:],
                        "stderr": listing.stderr[-2000:],
                    }
                ],
            )

            manifest["archives"].append(entry)
            continue

        archive_entries = [
            line.rstrip("\r\n")
            for line in listing.stdout.splitlines()
            if line.rstrip("\r\n")
        ]

        # Filter the archive listing in Python.
        if args.include_all:
            selected_entries = archive_entries
        else:
            selected_entries = [
                name
                for name in archive_entries
                if PurePosixPath(name.replace("\\", "/")).suffix.lower()
                in ASSET_EXTS
            ]

        entry["listed_entries"] = len(archive_entries)
        entry["selected_entries"] = len(selected_entries)

        if not selected_entries:
            entry.update(
                status="no_assets",
                extracted_files=0,
                mdx_count=0,
                texture_count=0,
                files=[],
                message="No matching archive entries were found.",
            )

            manifest["archives"].append(entry)
            continue

        # mpqcli accepts "-" to read filenames from stdin.
        extract_input = "\n".join(selected_entries) + "\n"

        extraction = run(
            [
                mpqcli_exe,
                "extract",
                str(archive),
                "--output",
                str(dest),
                "-",
            ],
            args.verbose,
            input_text=extract_input,
        )

        # Check which requested entries actually appeared on disk.
        missing_entries = []
        invalid_entries = []

        for name in selected_entries:
            expected_path = archive_path_to_output(dest, name)

            if expected_path is None:
                invalid_entries.append(name)
            elif not expected_path.is_file():
                missing_entries.append(name)

        # Collect extracted files using the original reporting rules.
        files = []

        for p in sorted(x for x in dest.rglob("*") if x.is_file()):
            if args.include_all or p.suffix.lower() in ASSET_EXTS:
                files.append(
                    {
                        "path": p.relative_to(dest).as_posix(),
                        "bytes": p.stat().st_size,
                        "sha256": sha256_file(p),
                    }
                )

        failures = []

        if extraction.returncode != 0:
            failures.append(
                {
                    "stage": "extract",
                    "returncode": extraction.returncode,
                    "stdout": extraction.stdout[-2000:],
                    "stderr": extraction.stderr[-2000:],
                }
            )

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

        if failures:
            status = "partial" if files else "extract_error"
        else:
            status = "ok" if files else "extract_error"

        entry.update(
            status=status,
            extracted_files=len(files),
            mdx_count=sum(
                x["path"].lower().endswith(".mdx") for x in files
            ),
            texture_count=sum(
                Path(x["path"]).suffix.lower() in {".blp", ".dds", ".tga"}
                for x in files
            ),
            files=files,
        )

        if failures:
            entry["tool_messages"] = failures

        manifest["archives"].append(entry)

    out = args.output_dir / "mpq_extraction_manifest.json"

    out.write_text(
        json.dumps(manifest, indent=2),
        encoding="utf-8",
    )

    print(f"Wrote {out}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
