"""Regenerate the pre-Electron portable splash bitmap (requires Pillow)."""

from math import sqrt
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "packages" / "desktop" / "build"
WIDTH, HEIGHT, SCALE = 420, 300, 2


def main() -> None:
    canvas = Image.new("RGB", (WIDTH * SCALE, HEIGHT * SCALE))
    pixels = canvas.load()
    assert pixels is not None
    for y in range(HEIGHT * SCALE):
        for x in range(WIDTH * SCALE):
            dx = (x / SCALE - WIDTH / 2) / 340
            dy = (y / SCALE - 20) / 260
            glow = max(0.0, 1.0 - sqrt(dx * dx + dy * dy))
            shade = int(22 * glow)
            pixels[x, y] = (17 + shade, 18 + shade, 22 + int(shade * 1.25))

    # Match the Electron splash: the app icon is the artwork behind the copy.
    icon_size = 390 * SCALE
    icon = Image.open(OUTPUT / "icon.png").convert("RGBA").resize(
        (icon_size, icon_size), Image.Resampling.LANCZOS
    )
    icon.putalpha(icon.getchannel("A").point(lambda alpha: round(alpha * 0.86)))
    canvas.paste(
        icon,
        ((WIDTH * SCALE - icon_size) // 2, round(HEIGHT * SCALE * 0.36 - icon_size / 2)),
        icon,
    )

    overlay = Image.new("RGBA", (1, HEIGHT * SCALE))
    stops = ((0.0, 0.10), (0.39, 0.24), (0.59, 0.74), (1.0, 1.0))
    for y in range(HEIGHT * SCALE):
        position = y / (HEIGHT * SCALE - 1)
        for (start, start_alpha), (end, end_alpha) in zip(stops, stops[1:]):
            if position <= end:
                opacity = start_alpha + (end_alpha - start_alpha) * (position - start) / (end - start)
                overlay.putpixel((0, y), (17, 18, 22, round(opacity * 255)))
                break
    overlay = overlay.resize(canvas.size, Image.Resampling.NEAREST)
    canvas = Image.alpha_composite(canvas.convert("RGBA"), overlay).convert("RGB")

    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle(
        (SCALE, SCALE, WIDTH * SCALE - SCALE - 1, HEIGHT * SCALE - SCALE - 1),
        radius=22 * SCALE,
        outline=(73, 72, 102),
        width=SCALE,
    )

    font_dir = Path("C:/Windows/Fonts")
    title_font = ImageFont.truetype(font_dir / "segoeuib.ttf", 23 * SCALE)
    body_font = ImageFont.truetype(font_dir / "msyh.ttc", 12 * SCALE)
    status_font = ImageFont.truetype(font_dir / "msyh.ttc", 11 * SCALE)

    def centered(label: str, y: int, font: ImageFont.FreeTypeFont, color: tuple[int, int, int]) -> None:
        bounds = draw.textbbox((0, 0), label, font=font)
        draw.text(
            ((WIDTH * SCALE - (bounds[2] - bounds[0])) // 2, y * SCALE - bounds[1]),
            label,
            font=font,
            fill=color,
        )

    centered("Pi Desktop", 161, title_font, (236, 236, 239))
    centered("你的本地 AI 编程工作台", 199, body_font, (196, 198, 210))
    centered("正在启动 · Starting", 238, status_font, (196, 198, 210))
    left, top, width, height = 121 * SCALE, 269 * SCALE, 178 * SCALE, 4 * SCALE
    draw.rounded_rectangle((left, top, left + width, top + height), radius=2 * SCALE, fill=(69, 71, 83))
    draw.rounded_rectangle((left, top, left + 68 * SCALE, top + height), radius=2 * SCALE, fill=(174, 186, 255))

    canvas.resize((WIDTH, HEIGHT), Image.Resampling.LANCZOS).save(
        OUTPUT / "portable-splash.bmp", format="BMP"
    )


if __name__ == "__main__":
    main()
