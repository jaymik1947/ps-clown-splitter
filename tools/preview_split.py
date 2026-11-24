#!/usr/bin/env python3
"""Render what the panel should produce, as a contact sheet PNG.

For each detected clown block it composites rgba * (pixel belongs to block)
over a checkerboard, so the split boundaries can be inspected without Photoshop.
"""
import struct
import sys
import zlib

sys.path.insert(0, "tools")
from sim_cluster import load_layers, decode_planes, cluster  # noqa: E402


def write_png(path, w, h, rgb):
    raw = bytearray()
    stride = w * 3
    for y in range(h):
        raw.append(0)
        raw += rgb[y * stride:(y + 1) * stride]

    def chunk(typ, data):
        return (struct.pack(">I", len(data)) + typ + data +
                struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF))

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 6))
    png += chunk(b"IEND", b"")
    open(path, "wb").write(png)


def main(psd, out):
    fh, layers, w, h = load_layers(psd)
    clown = next(l for l in layers if l["name"].strip().lower() == "clown")
    rgba = next(l for l in layers if l["name"].strip().lower() == "rgba")
    cp = decode_planes(fh, clown, w, h)
    rp = decode_planes(fh, rgba, w, h)

    res, sampled, step = cluster(cp, rp, w, h, 12, 0.05)
    blocks = [c for c in res if not c["frag"]]
    print("blocks:", [("#%02X%02X%02X" % (c["r"], c["g"], c["b"]), round(c["pct"], 3)) for c in blocks])

    CR_, CG_, CB_ = cp[0], cp[1], cp[2]
    RR_, RG_, RB_, RA_ = rp[0], rp[1], rp[2], rp[-1]

    CELL = 400
    COLS = 3
    ROWS = (len(blocks) + COLS - 1) // COLS
    W, H = CELL * COLS, CELL * ROWS
    canvas = bytearray(W * H * 3)
    for y in range(H):
        for x in range(W):
            cb = 62 if ((x // 16 + y // 16) % 2 == 0) else 82
            k = (y * W + x) * 3
            canvas[k] = canvas[k + 1] = canvas[k + 2] = cb

    sc = w / float(CELL)

    for bi, blk in enumerate(blocks):
        fz = max(2, min(30, int(min(blk["near"], 999) * 0.45)))
        cx = (bi % COLS) * CELL
        cy = (bi // COLS) * CELL
        hit = 0
        sr = sg = sb = 0
        print("  cell %d  #%02X%02X%02X fuzz=%d  origin=(%d,%d)" % (
            bi, blk["r"], blk["g"], blk["b"], fz, cx, cy))
        for oy in range(CELL):
            sy = int(oy * sc)
            if sy >= h:
                sy = h - 1
            crow = sy * w
            drow = ((cy + oy) * W + cx) * 3
            for ox in range(CELL):
                sx = int(ox * sc)
                if sx >= w:
                    sx = w - 1
                i = crow + sx
                dr = CR_[i] - blk["r"]
                dg = CG_[i] - blk["g"]
                db = CB_[i] - blk["b"]
                if dr * dr + dg * dg + db * db <= fz * fz:
                    a = RA_[i] / 255.0
                    r0, g0, b0 = RR_[i], RG_[i], RB_[i]
                    if a > 0.05:
                        hit += 1
                        sr += r0
                        sg += g0
                        sb += b0
                else:
                    a = 0.0
                    r0 = g0 = b0 = 0
                # checkerboard
                cb = 62 if ((ox // 16 + oy // 16) % 2 == 0) else 82
                k = drow + ox * 3
                canvas[k] = int(r0 * a + cb * (1 - a))
                canvas[k + 1] = int(g0 * a + cb * (1 - a))
                canvas[k + 2] = int(b0 * a + cb * (1 - a))
        # 描边，标明每个 cell 的归属
        for ox in range(CELL):
            for yy in (0, CELL - 1):
                k = ((cy + yy) * W + cx + ox) * 3
                canvas[k] = canvas[k + 1] = canvas[k + 2] = 255
        for oy in range(CELL):
            for xx in (0, CELL - 1):
                k = ((cy + oy) * W + cx + xx) * 3
                canvas[k] = canvas[k + 1] = canvas[k + 2] = 255
        if hit:
            print("     opaque hits %6d  avg rgb(%3d,%3d,%3d)" % (
                hit, sr // hit, sg // hit, sb // hit))
        else:
            print("     opaque hits      0  (empty)")

    write_png(out, W, H, canvas)
    print("wrote", out, W, "x", H)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
