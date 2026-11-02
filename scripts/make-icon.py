"""Regenerate Windows and PNG icons from the icon master (requires Pillow).

Source: packages/desktop/build/icon-source.png — a 1024px RGBA master derived
from the neon-terminal icon concept. Editing the artwork means replacing that
master, not this script.
"""

from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "packages" / "desktop" / "build"
MASTER = BUILD / "icon-source.png"
ICO_SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]


def main() -> None:
    master = Image.open(MASTER).convert("RGBA")
    icon = master.resize((512, 512), Image.Resampling.LANCZOS)
    icon.save(BUILD / "icon.png")
    icon.save(BUILD / "icon.ico", sizes=ICO_SIZES)
    print(BUILD / "icon.png")
    print(BUILD / "icon.ico")


if __name__ == "__main__":
    main()
