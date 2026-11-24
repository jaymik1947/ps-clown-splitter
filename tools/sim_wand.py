#!/usr/bin/env python3
"""Verify the magic-wand sampling pipeline offline.

Mirrors the panel exactly:
  nearest-neighbour downscale -> 5-bit bins -> greedy merge
  -> find a 3x3 solid interior point -> map back to document coords
  -> check that the document pixel really is that block's colour.

If the mapped point lands outside the block, the wand would sample the wrong
material, so this is the one step worth proving before touching Photoshop.
"""
import sys

sys.path.insert(0, "tools")
from sim_cluster import load_layers, decode_planes  # noqa: E402

TARGET = 768
WAND_TOL = 32


def downscale(planes, w, h, size):
    """nearest neighbour, same as ResampleMethod.NEARESTNEIGHBOR."""
    scale = max(w, h) / float(size)
    if scale < 1:
        scale = 1.0
    tw = max(1, int(round(w / scale)))
    th = max(1, int(round(h / scale)))
    out = {}
    for cid, plane in planes.items():
        buf = bytearray(tw * th)
        for y in range(th):
            sy = min(h - 1, int(y * scale))
            row = sy * w
            drow = y * tw
            for x in range(tw):
                sx = min(w - 1, int(x * scale))
                buf[drow + x] = plane[row + sx]
        out[cid] = bytes(buf)
    return out, tw, th, scale


def is_interior(planes, w, h, x, y, r, g, b):
    if x < 1 or y < 1 or x > w - 2 or y > h - 2:
        return False
    R_, G_, B_ = planes[0], planes[1], planes[2]
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            j = (y + dy) * w + (x + dx)
            dr, dg, db = R_[j] - r, G_[j] - g, B_[j] - b
            if dr * dr + dg * dg + db * db > 400:
                return False
    return True


def find_interior(planes, w, h, r, g, b, minx, maxx, miny, maxy):
    R_ = planes[0]
    x0, x1 = max(1, minx), min(w - 2, maxx)
    y0, y1 = max(1, miny), min(h - 2, maxy)
    for y in range(y0, y1 + 1):
        row = y * w
        for x in range(x0, x1 + 1):
            j = row + x
            dr, dg, db = R_[j] - r, planes[1][j] - g, planes[2][j] - b
            if dr * dr + dg * dg + db * db > 400:
                continue
            if is_interior(planes, w, h, x, y, r, g, b):
                return x, y
    return -1, -1


def cluster_small(planes, w, h, merge=12, min_pct=0.05):
    R_, G_, B_ = planes[0], planes[1], planes[2]
    bins = {}
    sampled = 0
    for y in range(h):
        row = y * w
        for x in range(w):
            i = row + x
            r, g, b = R_[i], G_[i], B_[i]
            key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
            e = bins.get(key)
            if e is None:
                # n, r, g, b, lastX, runs, runMax, fx, fy, minX, maxX, minY, maxY
                bins[key] = [1, r, g, b, x, 1, 1, x, y, x, x, y, y]
            else:
                e[0] += 1
                e[1] += r
                e[2] += g
                e[3] += b
                if e[4] == x - 1:
                    e[6] += 1
                else:
                    e[5] += 1
                    e[6] = 1
                e[4] = x
                if x < e[9]:
                    e[9] = x
                if x > e[10]:
                    e[10] = x
                if y < e[11]:
                    e[11] = y
                if y > e[12]:
                    e[12] = y
            sampled += 1

    arr = [[v[0], v[1] / v[0], v[2] / v[0], v[3] / v[0],
            v[5], v[6], v[7], v[8], v[9], v[10], v[11], v[12]] for v in bins.values()]
    arr.sort(key=lambda a: -a[0])

    m2 = merge * merge
    clusters = []
    for c in arr:
        host = None
        for cl in clusters:
            dr, dg, db = c[1] - cl[1], c[2] - cl[2], c[3] - cl[3]
            if dr * dr + dg * dg + db * db <= m2:
                host = cl
                break
        if host:
            host[0] += c[0]
            host[4] += c[4]
            if c[5] > host[5]:
                host[5] = c[5]
            for k in (8, 10):
                if c[k] < host[k]:
                    host[k] = c[k]
            for k in (9, 11):
                if c[k] > host[k]:
                    host[k] = c[k]
        else:
            clusters.append(list(c))

    min_count = max(6, sampled * min_pct / 100.0)
    out = []
    for cl in clusters:
        if cl[0] < min_count:
            continue
        rr, gg, bb = int(round(cl[1])), int(round(cl[2])), int(round(cl[3]))
        gx, gy = find_interior(planes, w, h, rr, gg, bb, cl[8], cl[9], cl[10], cl[11])
        out.append(dict(
            r=rr, g=gg, b=bb,
            pct=cl[0] * 100.0 / sampled,
            avg_run=cl[0] / cl[4] if cl[4] else cl[0],
            fx=cl[6], fy=cl[7], gx=gx, gy=gy))
    out.sort(key=lambda a: -a["pct"])
    return out, sampled


def main(path):
    fh, layers, w, h = load_layers(path)
    clown = next(l for l in layers if l["name"].strip().lower() == "clown")
    cp = decode_planes(fh, clown, w, h)

    small, tw, th, scale = downscale(cp, w, h, TARGET)
    print("doc %dx%d -> thumb %dx%d  scale=%.3f" % (w, h, tw, th, scale))

    blocks, sampled = cluster_small(small, tw, th)
    SR, SG, SB = small[0], small[1], small[2]
    OR, OG, OB = cp[0], cp[1], cp[2]

    print("\n%-9s %7s  %-14s %-14s %s" % ("colour", "pct", "thumb point", "doc point", "verify"))
    bad = 0
    for c in blocks:
        interior = c["gx"] >= 0
        tx = c["gx"] if interior else c["fx"]
        ty = c["gy"] if interior else c["fy"]

        # thumb pixel actually that colour?
        tj = ty * tw + tx
        td = ((SR[tj] - c["r"]) ** 2 + (SG[tj] - c["g"]) ** 2 + (SB[tj] - c["b"]) ** 2) ** 0.5

        # map to document coordinates (pixel centre)
        dx = int(tx * scale + scale / 2.0)
        dy = int(ty * scale + scale / 2.0)
        dx = max(0, min(w - 1, dx))
        dy = max(0, min(h - 1, dy))

        oj = dy * w + dx
        od = ((OR[oj] - c["r"]) ** 2 + (OG[oj] - c["g"]) ** 2 + (OB[oj] - c["b"]) ** 2) ** 0.5

        ok = od <= WAND_TOL
        if not ok:
            bad += 1
        print("#%02X%02X%02X %6.3f%%  (%4d,%4d)%s (%4d,%4d)   thumb_d=%-5.1f doc_d=%-5.1f %s" % (
            c["r"], c["g"], c["b"], c["pct"], tx, ty,
            "*" if interior else "!", dx, dy, td, od, "OK" if ok else "MISMATCH"))

    print("\n* = 3x3 interior point, ! = fell back to first hit")
    print("wand tolerance in panel: %d" % WAND_TOL)
    print("mismatched points: %d / %d" % (bad, len(blocks)))
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
