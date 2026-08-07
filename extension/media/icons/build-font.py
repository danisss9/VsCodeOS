#!/usr/bin/env python3
"""Generate vscodeos-icons.woff, the shell's own icon font.

VS Code's codicon set has no power symbol - the closest thing in all 753 names
is `circle-slash`, a "no entry" sign - so the tray's power button draws its
glyph from this font instead, registered through `contributes.icons` in
package.json. VS Code accepts woff, woff2 or ttf there.

The glyph is IEC 5009: a ring broken at the top with a vertical bar rising
through the gap. It is drawn to codicon's own metrics so it sits level with the
`$(plug)` and `$(volume)` glyphs beside it in the status bar:

    units per em   300  (a 16 px icon box, so 18.75 units = 1 px)
    ascender       300, descender 0
    advance width  300
    stroke         19 units, ~1 px, matching codicon's outlines
    bounding box   x 24..276, y 14..286, optically centred on (150, 150)

Arcs are approximated with quadratic Beziers in 15 degree steps, which puts the
worst-case radial error at 0.005 units - four thousandths of a pixel.

Run after changing anything above; the woff is committed, so a normal build
never needs this script or Python at all:

    pip install fonttools brotli
    python3 extension/media/icons/build-font.py
"""

from __future__ import annotations

import math
from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

UPM = 300
CENTER_X = 150.0
RING_CENTER_Y = 140.0
STROKE = 19.0
R_OUT = 126.0
R_IN = R_OUT - STROKE
R_MID = (R_OUT + R_IN) / 2
CAP = STROKE / 2

# Half-width of the gap at 12 o'clock. The bar subtends about 5 degrees at the
# inner radius, so 21 leaves a clear 1 px of daylight on either side of it.
GAP_HALF_DEG = 21.0

BAR_BOTTOM = 145.0   # centreline; the round cap reaches 9.5 further down
BAR_TOP = 276.5      # ...and 9.5 further up, to 286, clear of the ring at 266

STEP_DEG = 15.0      # maximum sweep of a single quadratic segment

# 2024-01-01, in the seconds-since-1904 that TrueType's head table counts in.
EPOCH = 1704067200 + 2082844800


def arc(pen_points: list, cx: float, cy: float, radius: float,
        start_deg: float, end_deg: float) -> None:
    """Append a circular arc as (off-curve, on-curve) quadratic segments.

    The control point of a segment sits where the two end tangents meet, at
    radius / cos(half the sweep) - the standard quadratic arc approximation.
    """
    sweep = end_deg - start_deg
    steps = max(1, math.ceil(abs(sweep) / STEP_DEG))
    delta = sweep / steps
    half = math.radians(delta / 2)
    control_radius = radius / math.cos(half)

    for i in range(steps):
        a0 = math.radians(start_deg + delta * i)
        a1 = math.radians(start_deg + delta * (i + 1))
        mid = (a0 + a1) / 2
        pen_points.append(((cx + control_radius * math.cos(mid),
                            cy + control_radius * math.sin(mid)), False))
        pen_points.append(((cx + radius * math.cos(a1),
                            cy + radius * math.sin(a1)), True))


def broken_ring() -> list:
    """The ring: outer edge round, a round cap, the inner edge back, a cap."""
    start = 90 + GAP_HALF_DEG
    end = 90 - GAP_HALF_DEG + 360

    points: list = []
    # Outer edge, anticlockwise from one side of the gap to the other.
    points.append(((CENTER_X + R_OUT * math.cos(math.radians(start)),
                    RING_CENTER_Y + R_OUT * math.sin(math.radians(start))), True))
    arc(points, CENTER_X, RING_CENTER_Y, R_OUT, start, end)

    # Round the end: a half turn about the point on the centreline, taking the
    # outline from the outer edge round to the inner one.
    end_x = CENTER_X + R_MID * math.cos(math.radians(end))
    end_y = RING_CENTER_Y + R_MID * math.sin(math.radians(end))
    arc(points, end_x, end_y, CAP, end, end + 180)

    # Inner edge, back the way we came.
    arc(points, CENTER_X, RING_CENTER_Y, R_IN, end, start)

    # ...and round the start the same way.
    start_x = CENTER_X + R_MID * math.cos(math.radians(start))
    start_y = RING_CENTER_Y + R_MID * math.sin(math.radians(start))
    arc(points, start_x, start_y, CAP, start + 180, start + 360)

    return points


def bar() -> list:
    """The vertical stroke: a stadium, drawn anticlockwise like the ring."""
    points: list = [((CENTER_X + CAP, BAR_BOTTOM), True),
                    ((CENTER_X + CAP, BAR_TOP), True)]
    arc(points, CENTER_X, BAR_TOP, CAP, 0, 180)
    points.append(((CENTER_X - CAP, BAR_BOTTOM), True))
    arc(points, CENTER_X, BAR_BOTTOM, CAP, 180, 360)
    return points


def draw(pen: TTGlyphPen, contour: list) -> None:
    """Feed one closed contour of (point, on_curve) pairs to a TrueType pen."""
    pen.moveTo(contour[0][0])
    segment: list = []
    for point, on_curve in contour[1:]:
        segment.append(point)
        if on_curve:
            if len(segment) == 1:
                pen.lineTo(segment[0])
            else:
                pen.qCurveTo(*segment)
            segment = []
    if segment:
        pen.qCurveTo(*segment, None)
    pen.closePath()


def main() -> None:
    pen = TTGlyphPen(None)
    draw(pen, broken_ring())
    draw(pen, bar())
    power = pen.glyph()

    blank = TTGlyphPen(None).glyph()

    builder = FontBuilder(UPM, isTTF=True)
    builder.setupGlyphOrder(['.notdef', 'power'])
    builder.setupCharacterMap({0xE000: 'power'})
    builder.setupGlyf({'.notdef': blank, 'power': power})

    # A glyph's left side bearing has to be its own xMin: rasterisers phase the
    # outline by the difference between the two, so getting this wrong slides
    # the icon sideways rather than failing outright.
    glyf = builder.font['glyf']
    builder.setupHorizontalMetrics({
        name: (UPM, getattr(glyf[name], 'xMin', 0)) for name in ('.notdef', 'power')
    })
    builder.setupHorizontalHeader(ascent=UPM, descent=0, lineGap=0)
    builder.setupNameTable({
        'familyName': 'VS Code OS Icons',
        'styleName': 'Regular',
        'psName': 'VSCodeOSIcons-Regular',
        'version': '1.0',
        'copyright': 'MIT licensed, part of VS Code OS',
    })
    builder.setupOS2(sTypoAscender=UPM, sTypoDescender=0, sTypoLineGap=0,
                     usWinAscent=UPM, usWinDescent=0, achVendID='VSOS')
    # Format 2.0, so the file names its own glyph and stays inspectable.
    builder.setupPost(keepGlyphNames=True)

    # head stamps the build time by default, which would make every run produce
    # a different binary for the same glyph. Pin it, so re-running this script
    # after an unrelated edit shows up as no diff at all.
    head = builder.font['head']
    head.created = head.modified = EPOCH

    builder.font.flavor = 'woff'
    out = Path(__file__).with_name('vscodeos-icons.woff')
    builder.save(out)
    print(f'{out} ({out.stat().st_size} bytes)')


if __name__ == '__main__':
    main()
