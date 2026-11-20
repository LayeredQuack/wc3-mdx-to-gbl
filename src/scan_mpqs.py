#!/usr/bin/env python3
"""Extract Warcraft III model assets from every MPQ below a directory.

Requires the external `mpqtool` command from ceres-wc3/ceres-mpqtool.
It invokes mpqtool only; it does not guess archive filenames or modify archives.
"""
from __future__ import annotations
import argparse, hashlib, json, shutil, subprocess, sys
from datetime import datetime, timezone
from pathlib import Path

ASSET_EXTS = {".mdx", ".mdl", ".blp", ".dds", ".tga"}

def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()

def run(cmd: list[str], verbose: bool) -> subprocess.CompletedProcess[str]:
    if verbose:
        print("+", " ".join(map(str, cmd)))
    return subprocess.run(cmd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

def main() -> int:
    ap = argparse.ArgumentParser(description="Extract MDX/texture assets from every MPQ below INPUT_DIR.")
    ap.add_argument("input_dir", type=Path, help="Directory recursively searched for *.mpq files")
    ap.add_argument("output_dir", type=Path, help="Output root; each archive gets a separate folder")
    ap.add_argument("--mpqtool", default="mpqtool", help="Path/name of mpqtool executable (default: mpqtool)")
    ap.add_argument("--include-all", action="store_true", help="Extract all archive files, not only MDX/MDL/BLP/DDS/TGA")
    ap.add_argument("--overwrite", action="store_true", help="Allow writing into existing per-archive output folders")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    if not args.input_dir.is_dir():
        ap.error(f"Not a directory: {args.input_dir}")
    if shutil.which(args.mpqtool) is None and not Path(args.mpqtool).is_file():
        ap.error("mpqtool was not found. Install it or pass --mpqtool /path/to/mpqtool.")

    archives = sorted(p for p in args.input_dir.rglob("*") if p.is_file() and p.suffix.lower() == ".mpq")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    manifest: dict = {
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "input_dir": str(args.input_dir.resolve()),
        "archives_found": len(archives),
        "archives": [],
    }

    for ordinal, archive in enumerate(archives, 1):
        rel = archive.relative_to(args.input_dir)
        # The suffix avoids collisions when two folders contain archive names alike.
        digest = sha256_file(archive)[:12]
        dest = args.output_dir / "extracted" / rel.with_suffix("")
        dest = dest.parent / f"{dest.name}_{digest}"
        entry = {"archive": str(rel), "sha256": sha256_file(archive), "output": str(dest.relative_to(args.output_dir)), "status": "pending"}
        print(f"[{ordinal}/{len(archives)}] {rel}")
        if dest.exists() and not args.overwrite:
            entry.update(status="skipped_existing", message="Use --overwrite to permit extraction to an existing folder.")
            manifest["archives"].append(entry)
            continue
        dest.mkdir(parents=True, exist_ok=True)

        patterns = ["*"] if args.include_all else ["*.mdx", "*.mdl", "*.blp", "*.dds", "*.tga"]
        failures = []
        for pattern in patterns:
            result = run([args.mpqtool, "extract", str(archive), "--filter", pattern, "--output", str(dest)], args.verbose)
            # An MPQ without a particular extension is not considered a pipeline failure.
            if result.returncode != 0:
                failures.append({"filter": pattern, "returncode": result.returncode, "stderr": result.stderr[-2000:]})

        files = []
        for p in sorted(x for x in dest.rglob("*") if x.is_file()):
            if args.include_all or p.suffix.lower() in ASSET_EXTS:
                files.append({"path": p.relative_to(dest).as_posix(), "bytes": p.stat().st_size, "sha256": sha256_file(p)})
        entry.update(
            status="ok" if files else "no_assets_or_extract_error",
            extracted_files=len(files),
            mdx_count=sum(x["path"].lower().endswith(".mdx") for x in files),
            texture_count=sum(Path(x["path"]).suffix.lower() in {".blp", ".dds", ".tga"} for x in files),
            files=files,
        )
        if failures:
            entry["tool_messages"] = failures
        manifest["archives"].append(entry)

    out = args.output_dir / "mpq_extraction_manifest.json"
    out.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"Wrote {out}")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
