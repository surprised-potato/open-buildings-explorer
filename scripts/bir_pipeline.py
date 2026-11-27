"""Separate pipeline for BIR zonal values (kept out of the main province run).

BIR publishes zonal values as one Excel workbook per Revenue District Office, in layouts that vary, from
https://www.bir.gov.ph/zonal-values; they cannot be downloaded or parsed unattended. To add an LGU:
  1. save its RDO workbook under data/bir_zonal/
  2. add a "bir" entry to the LGU in regions/negros-occidental.json
     {"xls": "data/bir_zonal/<file>.xls", "rdo": 77, "sheet_marker": "<DO number>", "target_city": "<city name in the sheet>",
      "source": "...", "department_order": "...", "effectivity": "YYYY-MM-DD"}
  3. run:  npm run bir -- --place <slug>      (or --all)

For each place this reruns the main pipeline's zonal and building-values stages (land values per barangay
and per building), offline. Without arguments it lists which LGUs have a workbook and which do not.
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from place import REPO_ROOT, all_places  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    who = ap.add_mutually_exclusive_group()
    who.add_argument("--place", action="append")
    who.add_argument("--all", action="store_true", help="every place that has a workbook")
    args = ap.parse_args()

    places = all_places()
    with_bir = [p for p in places if p.setting("bir")]
    if not (args.place or args.all):
        print("LGUs with a BIR workbook:")
        for p in with_bir:
            xls = REPO_ROOT / p.setting("bir")["xls"]
            print(f"  {p.slug:<20} {xls.name}{'' if xls.exists() else '  (file missing!)'}")
        missing = [p.slug for p in places if not p.setting("bir")]
        print(f"Without one ({len(missing)}): {', '.join(missing)}")
        return 0
    targets = with_bir if args.all else [p for p in places if p.slug in args.place]
    failed = []
    for p in targets:
        if not p.setting("bir"):
            print(f"{p.slug}: no 'bir' entry in the registry; see this script's help")
            failed.append(p.slug)
            continue
        cmd = [sys.executable, str(REPO_ROOT / "scripts" / "pipeline.py"), "--place", p.slug, "--offline",
               "--only", "zonal,building-values", "--force"]
        if subprocess.run(cmd, cwd=REPO_ROOT).returncode != 0:
            failed.append(p.slug)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
