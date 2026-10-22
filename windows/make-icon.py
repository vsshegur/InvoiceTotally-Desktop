#!/usr/bin/env python3
"""Produce the Vipul Workplace Windows shortcut icon using only Python stdlib.

Keep the internal icon filename InvoiceTotally.ico for backwards-compatible updates.
No downloaded font/images or system-dependent rendering engine is required.
"""
import math
import struct
import sys
import zlib

SIZE = 256


def segment(x, y, a, b, c, d, width):
    vx, vy = c - a, d - b
    t = max(0, min(1, ((x - a) * vx + (y - b) * vy) / (vx * vx + vy * vy)))
    dist = math.hypot(x - (a + t * vx), y - (b + t * vy))
    return max(0, min(1, width / 2 + 0.6 - dist))


def pixel(x, y):
    # Rounded-square charcoal background; alpha outside its border.
    a, b = max(0, 40 - x, x - 215), max(0, 40 - y, y - 215)
    corner = math.hypot(a, b)
    alpha = max(0, min(1, 40.6 - corner)) if a or b else 1
    grad = (x * 0.55 + y * 0.45) / SIZE
    rgb = [int(22 + 4 * grad), int(49 + 19 * grad), int(66 + 14 * grad)]
    # Subtle upper edge highlight.
    if 39 < y < 47 and 45 < x < 211:
        rgb = [32, 68, 83]
    # Two interlocked letters, white VW with orange lower accent.
    white = 0
    # V has two strokes; W has four.
    strokes = [
        (43, 87, 75, 166), (75, 166, 108, 87),
        (126, 87, 142, 166), (142, 166, 165, 116),
        (165, 116, 185, 166), (185, 166, 211, 87)
    ]
    for i, (x1, y1, x2, y2) in enumerate(strokes):
        white = max(white, segment(x, y, x1, y1, x2, y2, 14 if i < 2 else 13))
    for i in range(3):
        rgb[i] = int(rgb[i] * (1 - white) + (244, 250, 249)[i] * white)
    orange = 1 if 56 < x < 200 and 192 < y < 200 else 0
    if orange:
        rgb = [255, 138, 50]
    return bytes((*rgb, int(255 * alpha)))


def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)


def main(path):
    raw = b"".join(b"\x00" + b"".join(pixel(x, y) for x in range(SIZE)) for y in range(SIZE))
    png = (b"\x89PNG\r\n\x1a\n" +
           chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0)) +
           chunk(b"IDAT", zlib.compress(raw, 8)) + chunk(b"IEND", b""))
    # ICO directory: 256px indicated as 0, 32-bit PNG image at byte offset 22.
    ico = struct.pack("<HHHBBBBHHII", 0, 1, 1, 0, 0, 0, 0, 1, 32, len(png), 22) + png
    with open(path, "wb") as out:
        out.write(ico)


if __name__ == "__main__":
    main(sys.argv[1])
