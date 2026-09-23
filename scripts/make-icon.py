"""Regenerate Windows and PNG icons from the Pi Desktop mark (requires Pillow)."""

from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "packages" / "desktop" / "build"
SIZE = 1024


def lerp(a: int, b: int, t: float) -> int:
    return round(a + (b - a) * t)


def color(start: tuple[int, int, int], end: tuple[int, int, int], t: float) -> tuple[int, int, int, int]:
    return (*(lerp(a, b, t) for a, b in zip(start, end)), 255)


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    scale = SIZE / 512
    mask = Image.new("L", (SIZE, SIZE), 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.rounded_rectangle((24, 24, 1000, 1000), radius=216, fill=255)

    background = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    bg_draw = ImageDraw.Draw(background)
    for y in range(SIZE):
        bg_draw.line((0, y, SIZE, y), fill=color((52, 48, 129), (23, 23, 41), y / SIZE))
    background.putalpha(mask)
    draw = ImageDraw.Draw(background)
    draw.rounded_rectangle((26, 26, 998, 998), radius=214, outline=(119, 116, 176, 140), width=4)

    mark = Image.new("L", (SIZE, SIZE), 0)
    mark_draw = ImageDraw.Draw(mark)
    mark_draw.rectangle((246, 336, 778, 434), fill=255)
    mark_draw.rectangle((314, 410, 416, 770), fill=255)
    mark_draw.ellipse((314, 770 - 86, 416, 856), fill=255)
    mark_draw.rectangle((646, 410, 748, 770), fill=255)
    mark_draw.ellipse((646, 770 - 86, 748, 856), fill=255)

    mark_color = Image.new("RGBA", (SIZE, SIZE))
    mark_color_draw = ImageDraw.Draw(mark_color)
    for y in range(SIZE):
        mark_color_draw.line((0, y, SIZE, y), fill=color((157, 248, 232), (90, 210, 237), y / SIZE))
    background.paste(mark_color, (0, 0), mark)
    draw = ImageDraw.Draw(background)
    draw.ellipse((710, 696, 830, 816), fill=(255, 179, 106, 255))

    icon = background.resize((512, 512), Image.Resampling.LANCZOS)
    icon.save(OUTPUT / "icon.png")
    icon.save(OUTPUT / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])


if __name__ == "__main__":
    main()
