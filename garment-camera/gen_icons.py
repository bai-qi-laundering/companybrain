#!/usr/bin/env python3
"""Stdlib-only home-screen icons for the garment-camera tablet page.

Theme green matches tablet.html (--pre / theme-color #0f8a42). Glyph is a
white shirt on a hanger so it still reads at 32px. No third-party assets.
"""
import math
import struct
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
GREEN = (0x0F, 0x8A, 0x42)
WHITE = (0xFF, 0xFF, 0xFF)

# Chunky hanger + shirt in design space (0..1, y down).
_HOOK = (0.50, 0.20, 0.100, 0.048)  # cx, cy, outer r, inner r
_NECK = ((0.50, 0.285), (0.50, 0.355), 0.038)
_ARM_L = ((0.50, 0.34), (0.15, 0.50), 0.046)
_ARM_R = ((0.50, 0.34), (0.85, 0.50), 0.046)
_BAR = ((0.16, 0.50), (0.84, 0.50), 0.034)
_SHIRT = (
    (0.30, 0.49),
    (0.12, 0.50),
    (0.14, 0.62),
    (0.28, 0.58),
    (0.30, 0.80),
    (0.70, 0.80),
    (0.72, 0.58),
    (0.86, 0.62),
    (0.88, 0.50),
    (0.70, 0.49),
    (0.62, 0.53),
    (0.56, 0.60),
    (0.50, 0.63),
    (0.44, 0.60),
    (0.38, 0.53),
)


def _dist_seg(px, py, ax, ay, bx, by):
    abx, aby = bx - ax, by - ay
    apx, apy = px - ax, py - ay
    ab2 = abx * abx + aby * aby
    if ab2 <= 0:
        t = 0.0
    else:
        t = (apx * abx + apy * aby) / ab2
        if t < 0:
            t = 0.0
        elif t > 1:
            t = 1.0
    dx = px - (ax + abx * t)
    dy = py - (ay + aby * t)
    return dx * dx + dy * dy


def _in_poly(x, y, poly):
    inside = False
    j = len(poly) - 1
    for i, (xi, yi) in enumerate(poly):
        xj, yj = poly[j]
        if (yi > y) != (yj > y):
            denom = (yj - yi) or 1e-12
            if x < (xj - xi) * (y - yi) / denom + xi:
                inside = not inside
        j = i
    return inside


def _glyph(x, y):
    cx, cy, outer, inner = _HOOK
    dx, dy = x - cx, y - cy
    d2 = dx * dx + dy * dy
    if inner * inner <= d2 <= outer * outer:
        ang = math.atan2(dy, dx)
        # Leave a gap at the bottom so the ring reads as a hook.
        gap = ang - (math.pi / 2)
        gap = (gap + math.pi) % (2 * math.pi) - math.pi
        if abs(gap) >= 0.62:
            return True
    (ax, ay), (bx, by), rad = _NECK
    if _dist_seg(x, y, ax, ay, bx, by) <= rad * rad:
        return True
    for seg in (_ARM_L, _ARM_R, _BAR):
        (ax, ay), (bx, by), rad = seg
        if _dist_seg(x, y, ax, ay, bx, by) <= rad * rad:
            return True
    return _in_poly(x, y, _SHIRT)


def _sample(u, v, scale):
    """Return RGB. scale < 1 keeps the glyph inside the maskable safe zone."""
    x = 0.5 + (u - 0.5) / scale
    y = 0.5 + (v - 0.5) / scale
    if x < -0.05 or x > 1.05 or y < -0.05 or y > 1.05:
        return GREEN
    if _glyph(x, y):
        return WHITE
    return GREEN


def _render(size, scale, ss=3):
    big = size * ss
    acc_r = [0] * (size * size)
    acc_g = [0] * (size * size)
    acc_b = [0] * (size * size)
    for by in range(big):
        v = (by + 0.5) / big
        row = by // ss
        for bx in range(big):
            u = (bx + 0.5) / big
            r, g, b = _sample(u, v, scale)
            i = row * size + (bx // ss)
            acc_r[i] += r
            acc_g[i] += g
            acc_b[i] += b
    n = ss * ss
    out = bytearray(size * size * 3)
    for i in range(size * size):
        o = i * 3
        out[o] = acc_r[i] // n
        out[o + 1] = acc_g[i] // n
        out[o + 2] = acc_b[i] // n
    return bytes(out)


def _png(width, height, rgb):
    raw = bytearray()
    stride = width * 3
    for y in range(height):
        raw.append(0)
        raw.extend(rgb[y * stride:(y + 1) * stride])

    def chunk(tag, data):
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', crc)

    ihdr = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(bytes(raw), 9)) + chunk(b'IEND', b'')


def _ico(images):
    """images: list of (size, png_bytes) for sizes < 256."""
    count = len(images)
    header = struct.pack('<HHH', 0, 1, count)
    offset = 6 + 16 * count
    entries = bytearray()
    blobs = bytearray()
    for size, blob in images:
        entries += struct.pack('<BBBBHHII', size, size, 0, 0, 1, 32, len(blob), offset)
        offset += len(blob)
        blobs += blob
    return bytes(header + entries + blobs)


def main():
    any_master = _render(512, scale=1.0, ss=3)
    mask_master = _render(512, scale=0.78, ss=3)
    outputs = {
        'icon-512.png': _png(512, 512, any_master),
        'icon-maskable-512.png': _png(512, 512, mask_master),
        'icon-192.png': _png(192, 192, _render(192, scale=1.0, ss=4)),
        'apple-touch-icon.png': _png(180, 180, _render(180, scale=1.0, ss=4)),
        'favicon-32.png': _png(32, 32, _render(32, scale=1.0, ss=6)),
    }
    fav16 = _png(16, 16, _render(16, scale=1.0, ss=8))
    outputs['favicon.ico'] = _ico([(32, outputs['favicon-32.png']), (16, fav16)])
    for name, blob in outputs.items():
        dest = HERE / name
        dest.write_bytes(blob)
        print('%s %d bytes' % (dest.name, len(blob)))


if __name__ == '__main__':
    main()
