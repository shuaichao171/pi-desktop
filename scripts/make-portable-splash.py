"""Compatibility entry point for the SVG-based portable splash generator."""

import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    subprocess.run(["node", str(ROOT / "scripts" / "make-portable-splash.mjs")], cwd=ROOT, check=True)


if __name__ == "__main__":
    main()
