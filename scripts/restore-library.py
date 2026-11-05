#!/usr/bin/env python3
"""Restore and verify the read-only legacy corpus; standard library only."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile


def sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def safe_path(root: Path, relative: str) -> Path:
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError(f"Manifest path escapes repository: {relative}")
    return path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    root = args.repository.resolve()
    manifest = json.loads((root / "data/library-manifest.json").read_text(encoding="utf-8"))
    for entry in manifest["files"]:
        path = safe_path(root, entry["path"])
        if not path.is_file() or path.stat().st_size != entry["bytes"] or sha(path) != entry["sha256"]:
            raise RuntimeError(f"Packaged file is absent or changed: {entry['path']}")
    database = manifest["database"]
    target = safe_path(root, database["restored_path"])
    if target.exists():
        if not target.is_file() or sha(target) != database["original_sha256"]:
            raise RuntimeError("Existing database differs; move it aside explicitly before restoring. It was not overwritten.")
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(prefix=".restore-", suffix=".sqlite", dir=target.parent)
        os.close(descriptor)
        temporary = Path(temporary_name)
        try:
            with gzip.open(safe_path(root, database["compressed_path"]), "rb") as source, temporary.open("wb") as output:
                shutil.copyfileobj(source, output, 1024 * 1024)
            if temporary.stat().st_size != database["original_bytes"] or sha(temporary) != database["original_sha256"]:
                raise RuntimeError("Restored database failed its original byte/hash check")
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
    with sqlite3.connect(":memory:") as probe:
        probe.execute("CREATE VIRTUAL TABLE fts5_check USING fts5(text)")
    with sqlite3.connect(target.as_uri() + "?mode=ro", uri=True) as connection:
        if connection.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise RuntimeError("SQLite quick_check failed")
        counts = {table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                  for table in ("sources", "units", "unit_search")}
    print(json.dumps({"status": "verified", "packaged_files_checked": len(manifest["files"]),
                      "restored_database_sha256": sha(target), "database_counts": counts}, indent=2))


if __name__ == "__main__":
    main()
