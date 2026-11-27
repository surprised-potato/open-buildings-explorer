"""Publish public/data/ to the `data` branch as a single commit (replacing the previous one).

The Pages workflow combines main (app) with this branch (data). Force-pushing one commit keeps the
repository from growing by ~0.7 GB on every refresh; GitHub drops the old copy when it garbage-collects.
Checks before pushing: total size under the Pages limit and no single file over GitHub's 100 MB limit.
Run: uv run python scripts/publish_data.py [--dry-run]
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DATA = REPO / "public" / "data"
PAGES_LIMIT_MB = 1000
FILE_LIMIT_MB = 100


def git(*args: str, cwd: Path) -> str:
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    files = [p for p in DATA.rglob("*") if p.is_file()]
    total = sum(p.stat().st_size for p in files) / 1e6
    big = [(str(p.relative_to(DATA)), round(p.stat().st_size / 1e6)) for p in files if p.stat().st_size / 1e6 > FILE_LIMIT_MB]
    print(f"{len(files):,} files, {total:.0f} MB")
    if big:
        raise SystemExit(f"Files over {FILE_LIMIT_MB} MB (GitHub rejects them): {big}")
    if total > PAGES_LIMIT_MB * 0.95:
        raise SystemExit(f"{total:.0f} MB is too close to the {PAGES_LIMIT_MB} MB Pages limit (the app adds a few MB)")
    if args.dry_run:
        return 0
    remote = git("remote", "get-url", "origin", cwd=REPO)
    with tempfile.TemporaryDirectory(prefix="data_branch_") as tmp:
        work = Path(tmp)
        git("init", "-q", "-b", "data", cwd=work)
        shutil.copytree(DATA, work / "data")
        (work / "README.md").write_text("Generated data for the Pages site (scripts/publish_data.py). Replaced on every refresh.\n")
        git("add", "-A", cwd=work)
        git("-c", "user.name=pipeline", "-c", "user.email=pipeline@localhost", "commit", "-q", "-m", "Data snapshot", cwd=work)
        git("remote", "add", "origin", remote, cwd=work)
        subprocess.run(["git", "push", "-f", "origin", "data"], cwd=work, check=True)
    print("Pushed the data branch; the Pages workflow deploys it.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
