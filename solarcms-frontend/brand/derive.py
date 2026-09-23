"""Derive the app's brand assets from the logo Ability Automation supplied.

    python3 -m venv /tmp/brand && /tmp/brand/bin/pip install pillow
    /tmp/brand/bin/python brand/derive.py

Writes `src/assets/brand/ability-{logo,mark}{,-reversed}.png` and
`public/favicon.png`. Re-run it rather than editing those files by hand.

⚠ The source is a 430×122 raster, opaque on a light-grey plate (#F2F3F5), with
no dark-ground version. Everything below exists to work around that, and all of
it becomes unnecessary the day the client sends a vector original and their own
reversed artwork — ask for both. Until then:

**Matting.** The plate cannot simply be keyed out: a colour-to-alpha against a
light ground turns the navy lettering into 86%-opaque black, which is exact on
the plate and wrong on anything else. Each pixel is instead explained as
`plate + a·(k − plate)` for the brand colour `k` whose line through the plate it
sits closest to, which recovers the real colour at a partial alpha along every
anti-aliased edge. A pixel no line explains — the gradient inside the A, a
navy/teal blend inside a letter — is foreground and opaque.

**Reversal.** Navy on a dark ground disappears, so the dark-theme variant lifts
the navy lettering to a light ink and leaves every chromatic colour (the orange
arrow, the teal swoosh and circuit, the peak's gradient) exactly as drawn. The
deep navy is used twice in the original, and only one use is lettering: it
shades the A's right leg where it passes behind the swoosh (lifted, slightly
dimmer than the rest, so the overlap still reads) and it is the dark foot of the
teal peak inside the A (a gradient — left alone). A dark region lying under the
cyan peak is its foot; any other is lettering.

This is our derivation, not the client's artwork. It is faithful to every
chromatic pixel and changes only the lettering's lightness.
"""

from __future__ import annotations

import colorsys
from collections import deque
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
SOURCE = HERE / "ability-logo-source.png"
ASSETS = HERE.parent / "src" / "assets" / "brand"
PUBLIC = HERE.parent / "public"

PLATE = (242, 243, 245)
# Sampled from the source: the median of each region, not a guess at intent.
PALETTE = {
    "navy": (33, 38, 59),  # the wordmark
    "deep": (15, 29, 56),  # the shade on the A, and the foot of the peak
    "orange": (240, 144, 55),  # the arrow, the i-dots, the tagline rules
    "teal": (57, 126, 146),  # the swoosh and the circuit traces
    "cyan": (98, 188, 200),  # the peak inside the A
    "cyan2": (124, 204, 212),  # its lightest step
}
LIGHT_INK = (238, 240, 245)  # the reversed lettering
LIGHT_SHADE = (206, 211, 224)  # the reversed shade on the A's leg

Pixel = tuple[int, int]
Colour = tuple[int, int, int]


def _sub(a: tuple, b: tuple) -> tuple:
    return tuple(x - y for x, y in zip(a, b))


def _dot(a: tuple, b: tuple) -> float:
    return sum(x * y for x, y in zip(a, b))


def matte(im: Image.Image) -> dict[Pixel, tuple[str, Colour, float]]:
    """Every non-plate pixel as (which brand colour, its colour, its alpha)."""
    out: dict[Pixel, tuple[str, Colour, float]] = {}
    for y in range(im.height):
        for x in range(im.width):
            p = im.getpixel((x, y))
            d = _sub(p, PLATE)
            if _dot(d, d) < 36:
                continue
            best = None
            for name, k in PALETTE.items():
                v = _sub(k, PLATE)
                a = max(0.0, min(1.0, _dot(d, v) / _dot(v, v)))
                r = _sub(p, tuple(PLATE[i] + a * v[i] for i in range(3)))
                residual = _dot(r, r) ** 0.5
                if best is None or residual < best[0]:
                    best = (residual, name, a)
            residual, name, a = best
            if residual < 14:
                out[(x, y)] = (name, PALETTE[name], a)
            else:
                out[(x, y)] = ("mix", p, 1.0)
    return out


def lettering_shade(cls: dict[Pixel, tuple[str, Colour, float]]) -> set[Pixel]:
    """The deep-navy pixels that are lettering rather than the peak's foot."""

    def darkish(xy: Pixel) -> bool:
        name, fg, _ = cls[xy]
        if name == "deep":
            return True
        return name == "mix" and max(fg) < 90 and max(fg) - min(fg) < 60

    cyan = [xy for xy, c in cls.items() if c[0] in ("cyan", "cyan2")]
    peak_left = min(x for x, _ in cyan)
    peak_right = max(x for x, _ in cyan)
    peak_top = min(y for _, y in cyan)

    seen: set[Pixel] = set()
    lift: set[Pixel] = set()
    for start in cls:
        if start in seen or not darkish(start):
            continue
        component, queue = [], deque([start])
        seen.add(start)
        while queue:
            cx, cy = queue.popleft()
            component.append((cx, cy))
            for n in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                if n in cls and n not in seen and darkish(n):
                    seen.add(n)
                    queue.append(n)
        xs = [c[0] for c in component]
        ys = [c[1] for c in component]
        under_peak = (
            min(xs) <= peak_right + 3 and max(xs) >= peak_left - 3 and max(ys) >= peak_top
        )
        if not under_peak:
            lift.update(component)
    return lift


def reversed_colour(name: str, fg: Colour, lifted: bool) -> Colour:
    if name == "navy":
        return LIGHT_INK
    if lifted:
        return LIGHT_SHADE
    if name == "mix" and max(fg) - min(fg) < 40:
        lightness = colorsys.rgb_to_hls(*(c / 255 for c in fg))[1]
        if lightness < 0.6:
            # A navy/grey blend inside a letter: lift it along the same line.
            t = max(0.0, min(1.0, (lightness - 0.13) / 0.47))
            return tuple(round(LIGHT_INK[i] * (1 - t) + 110 * t) for i in range(3))
    return fg


def symbol_only(img: Image.Image, right: int, top_limit: int) -> Image.Image:
    """The A, its swoosh, arrow and circuit — without the wordmark or tagline.

    The swoosh's lower curve shares rows with the tagline, so a rectangle cannot
    separate them: keep only the shapes that reach above the tagline.
    """
    alpha = img.getchannel("A")
    width, height = min(right, img.width), img.height
    keep: set[Pixel] = set()
    seen: set[Pixel] = set()
    for sy in range(height):
        for sx in range(width):
            if (sx, sy) in seen or alpha.getpixel((sx, sy)) == 0:
                continue
            component, queue = [], deque([(sx, sy)])
            seen.add((sx, sy))
            while queue:
                x, y = queue.popleft()
                component.append((x, y))
                for nx in (x - 1, x, x + 1):
                    for ny in (y - 1, y, y + 1):
                        n = (nx, ny)
                        if (
                            0 <= nx < width
                            and 0 <= ny < height
                            and n not in seen
                            and alpha.getpixel(n) > 0
                        ):
                            seen.add(n)
                            queue.append(n)
            if min(y for _, y in component) < top_limit:
                keep.update(component)
    out = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    for xy in keep:
        out.putpixel(xy, img.getpixel(xy))
    return out


def symbol_bounds(img: Image.Image) -> tuple[int, int]:
    """Where the symbol ends and where the tagline begins, measured."""
    alpha = img.getchannel("A")

    def filled(x: int, y: int) -> bool:
        return alpha.getpixel((x, y)) > 40

    # Beside the wordmark, the tagline is the bottom band of rows and the
    # wordmark the band above it, with empty rows between.
    mid = img.width // 2
    y = img.height - 1
    while not any(filled(x, y) for x in range(mid, img.width)):
        y -= 1
    while any(filled(x, y) for x in range(mid, img.width)):
        y -= 1
    tagline_top = y + 1

    # Above the tagline, the first empty column after the symbol starts is the
    # gap before the "B".
    x = 0
    while not any(filled(x, y) for y in range(tagline_top)):
        x += 1
    while any(filled(x, y) for y in range(tagline_top)):
        x += 1
    return x, tagline_top


def favicon(mark: Image.Image, size: int = 64, pad: int = 4) -> Image.Image:
    """The symbol on its own plate colour, so it reads in a light or dark tab."""
    scale = 4
    plate = Image.new("RGBA", (size * scale, size * scale), (0, 0, 0, 0))
    ImageDraw.Draw(plate).rounded_rectangle(
        (0, 0, size * scale - 1, size * scale - 1), radius=14 * scale, fill=(*PLATE, 255)
    )
    plate = plate.resize((size, size), Image.LANCZOS)
    fitted = mark.copy()
    fitted.thumbnail((size - 2 * pad, size - 2 * pad), Image.LANCZOS)
    plate.alpha_composite(fitted, ((size - fitted.width) // 2, (size - fitted.height) // 2))
    return plate


def main() -> None:
    im = Image.open(SOURCE).convert("RGB")
    cls = matte(im)
    lift = lettering_shade(cls)

    light = Image.new("RGBA", im.size, (0, 0, 0, 0))
    dark = Image.new("RGBA", im.size, (0, 0, 0, 0))
    for xy, (name, fg, a) in cls.items():
        alpha = round(a * 255)
        light.putpixel(xy, (*fg, alpha))
        dark.putpixel(xy, (*reversed_colour(name, fg, xy in lift), alpha))

    left, top, right, bottom = light.getbbox()
    box = (max(0, left - 2), max(0, top - 2), min(im.width, right + 2), min(im.height, bottom + 2))
    light, dark = light.crop(box), dark.crop(box)

    symbol_right, tagline_top = symbol_bounds(light)
    mark = symbol_only(light, symbol_right, tagline_top)
    mark_dark = symbol_only(dark, symbol_right, tagline_top)
    mark_box = mark.getbbox()
    mark, mark_dark = mark.crop(mark_box), mark_dark.crop(mark_box)

    ASSETS.mkdir(parents=True, exist_ok=True)
    light.save(ASSETS / "ability-logo.png", optimize=True)
    dark.save(ASSETS / "ability-logo-reversed.png", optimize=True)
    mark.save(ASSETS / "ability-mark.png", optimize=True)
    mark_dark.save(ASSETS / "ability-mark-reversed.png", optimize=True)
    favicon(mark).save(PUBLIC / "favicon.png", optimize=True)
    print(f"logo {light.size}, symbol {mark.size}, written to {ASSETS} and {PUBLIC}")


if __name__ == "__main__":
    main()
