"""Derive the sign-in page's supporting image from the client's desktop artwork.

    python3 brand/derive_login.py          (from solarcms-frontend/)

Reads `public/ability-cms-desktop-3840x2160.jpg` — the client's file, never
modified — and writes `public/ability-cms-desktop-edge.png` (1 x 2160): the
artwork's right-edge colour, row by row, blurred vertically into a smooth
gradient.

The page fits the artwork to the window's *height* so the logo and the footer
are never cropped; on a window wider than 16:9 the artwork's right edge fades
into this strip, repeated across the remaining width. Each row is the **median
of the rightmost 80 columns** (so a thin line crossing the edge counts for
nothing), and the strip is then blurred so the forest, the dashboard picture
and the waves along that edge become bands of colour rather than stripes.

The client's 1920 x 1080 and 3840 x 2160 files and the 1080 x 1920 mobile file
are all served as they are. Re-run after replacing the desktop source; never
hand-edit the output.
"""

from pathlib import Path
from statistics import median

from PIL import Image, ImageFilter

HERE = Path(__file__).resolve().parent
PUBLIC = HERE.parent / "public"
SOURCE = PUBLIC / "ability-cms-desktop-3840x2160.jpg"
EDGE = PUBLIC / "ability-cms-desktop-edge.png"

EDGE_COLUMNS = 80
BLUR_ROWS = 60


def edge_strip(image: Image.Image) -> Image.Image:
    width, height = image.size
    strip = Image.new("RGB", (1, height))
    for y in range(height):
        pixels = [image.getpixel((x, y)) for x in range(width - EDGE_COLUMNS, width)]
        strip.putpixel(
            (0, y),
            tuple(int(median(p[channel] for p in pixels)) for channel in range(3)),
        )
    # Blur along the column only: widen, blur, take the middle column back.
    wide = strip.resize((9, height), Image.Resampling.NEAREST)
    return wide.filter(ImageFilter.GaussianBlur(BLUR_ROWS)).crop((4, 0, 5, height))


def main() -> None:
    image = Image.open(SOURCE).convert("RGB")
    edge_strip(image).save(EDGE, optimize=True)
    print(f"wrote {EDGE.relative_to(HERE.parent)} ({EDGE.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
