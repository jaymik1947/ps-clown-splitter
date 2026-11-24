#!/usr/bin/env python3
"""Offline simulation of the panel's clustering + colour-range picking.

Mirrors main.js exactly:
  sample stride -> 5-bit bins -> greedy merge (distance <= merge)
  -> filter by area% -> nearest-neighbour distance -> adaptive fuzziness

Decodes the real clown layer from the PSD and prints what the panel would show.
"""
import struct
import sys
import zlib
from collections import Counter

sys.path.insert(0, "tools")


class R:
    def __init__(self, fh):
        self.f = fh

    def read(self, n):
        b = self.f.read(n)
        if len(b) != n:
            raise EOFError
        return b

    def u8(self):
        return self.read(1)[0]

    def u16(self):
        return struct.unpack(">H", self.read(2))[0]

    def i16(self):
        return struct.unpack(">h", self.read(2))[0]

    def u32(self):
        return struct.unpack(">I", self.read(4))[0]

    def i32(self):
        return struct.unpack(">i", self.read(4))[0]

    def skip(self, n):
        self.f.seek(n, 1)


def unpackbits(data, expected):
    out = bytearray()
    i, n = 0, len(data)
    while i < n and len(out) < expected:
        b = data[i]
        i += 1
        if b < 128:
            cnt = b + 1
            out += data[i:i + cnt]
            i += cnt
        elif b > 128:
            out += bytes((data[i],)) * (257 - b)
            i += 1
    return bytes(out[:expected])


def load_layers(path):
    fh = open(path, "rb")
    r = R(fh)
    assert r.read(4) == b"8BPS"
    version = r.u16()
    r.skip(6)
    r.u16()
    height = r.u32()
    width = r.u32()
    r.u16()
    r.u16()
    r.skip(r.u32())
    r.skip(r.u32())
    r.u32()
    r.u32()
    count = abs(r.i16())
    layers = []
    for _ in range(count):
        box = (r.i32(), r.i32(), r.i32(), r.i32())
        nch = r.u16()
        chs = []
        for _ in range(nch):
            cid = r.i16()
            clen = struct.unpack(">Q", r.read(8))[0] if version == 2 else r.u32()
            chs.append([cid, clen])
        r.skip(8)
        r.skip(4)
        extra_len = r.u32()
        extra_end = fh.tell() + extra_len
        mlen = r.u32()
        if mlen:
            r.skip(mlen)
        r.skip(r.u32())
        nlen = r.u8()
        raw = r.read(nlen)
        pad = (4 - ((nlen + 1) % 4)) % 4
        if pad:
            r.skip(pad)
        uname = None
        while fh.tell() + 12 <= extra_end:
            if r.read(4) not in (b"8BIM", b"8B64"):
                break
            key = r.read(4)
            blen = r.u32()
            bstart = fh.tell()
            data = r.read(blen)
            if key == b"luni" and len(data) >= 4:
                slen = struct.unpack(">I", data[:4])[0]
                uname = data[4:4 + slen * 2].decode("utf-16-be", "replace")
            if fh.tell() < bstart + blen:
                fh.seek(bstart + blen)
        fh.seek(extra_end)
        layers.append(dict(name=(uname or raw.decode("utf-8", "replace")), chs=chs, box=box))

    cursor = fh.tell()
    for rec in layers:
        for ch in rec["chs"]:
            ch.append(cursor)
            cursor += ch[1]
    return fh, layers, width, height


def decode_planes(fh, rec, w, h):
    planes = {}
    for cid, clen, off in rec["chs"]:
        fh.seek(off)
        struct.unpack(">H", fh.read(2))[0]
        pass
    for cid, clen, off in rec["chs"]:
        fh.seek(off)
        comp = struct.unpack(">H", fh.read(2))[0]
        payload = fh.read(clen - 2)
        if comp == 1:
            counts = struct.unpack(">%dH" % h, payload[:2 * h])
            body = payload[2 * h:]
            rows, pos = [], 0
            for cnt in counts:
                rows.append(unpackbits(body[pos:pos + cnt], w))
                pos += cnt
            plane = b"".join(rows)
        else:
            plane = payload[:w * h]
        planes[cid] = plane
    return planes


def cluster(planes, rplanes, w, h, merge, min_pct):
    R_, G_, B_ = planes[0], planes[1], planes[2]
    total = w * h
    step = max(1, int(round(((total / 262144.0) ** 0.5))))
    bins = {}
    sampled = 0
    for y in range(0, h, step):
        row = y * w
        for x in range(0, w, step):
            i = row + x
            rr, gg, bb = R_[i], G_[i], B_[i]
            key = ((rr >> 3) << 10) | ((gg >> 3) << 5) | (bb >> 3)
            e = bins.get(key)
            if e is None:
                bins[key] = [1, rr, gg, bb, x, 1, 1]   # n,r,g,b,lastX,runs,runMax
            else:
                e[0] += 1
                e[1] += rr
                e[2] += gg
                e[3] += bb
                if e[4] == x - step:
                    e[6] = e[6] + 1
                else:
                    e[5] += 1
                    e[6] = 1
                e[4] = x
            sampled += 1
    arr = [[v[0], v[1] / v[0], v[2] / v[0], v[3] / v[0], v[5], v[6]] for v in bins.values()]
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
        else:
            clusters.append(list(c))

    # border-only probes (never the centre - the model sits there)
    edge_idx = []
    N = 8
    for i in range(N + 1):
        xx = round((w - 1) * i / N)
        yy = round((h - 1) * i / N)
        for (px_, py_) in ((xx, 0), (xx, h - 1), (0, yy), (w - 1, yy)):
            k = py_ * w + px_
            edge_idx.append((R_[k], G_[k], B_[k]))

    # 2nd pass: is this block actually visible on the rgba layer?
    A_ = rplanes[-1]
    for y in range(0, h, step):
        row = y * w
        for x in range(0, w, step):
            i = row + x
            r0, g0, b0 = R_[i], G_[i], B_[i]
            hit, best = -1, 1600
            for k, cl in enumerate(clusters):
                dr, dg, db = r0 - cl[1], g0 - cl[2], b0 - cl[3]
                d = dr * dr + dg * dg + db * db
                if d < best:
                    best, hit = d, k
            if hit < 0:
                continue
            cl = clusters[hit]
            while len(cl) < 9:
                cl.append(0)
            cl[7] += 1
            if A_[i] < 3:
                cl[8] += 1

    min_count = max(6, sampled * min_pct / 100.0)
    print("EDGE PTS:", sorted(set("#%02X%02X%02X" % e for e in edge_idx)))
    out = []
    for cl in clusters:
        if cl[0] < min_count:
            continue
        rr, gg, bb = int(round(cl[1])), int(round(cl[2])), int(round(cl[3]))
        is_edge = any((rr - e[0]) ** 2 + (gg - e[1]) ** 2 + (bb - e[2]) ** 2 < 400 for e in edge_idx)
        avg_run = cl[0] / cl[4] if cl[4] else cl[0]
        pct = cl[0] * 100.0 / sampled
        seen = cl[7] if len(cl) > 7 else 0
        dark = cl[8] if len(cl) > 8 else 0
        dark_ratio = dark / float(seen) if seen else 0.0
        out.append(dict(r=rr, g=gg, b=bb, n=cl[0], pct=pct,
                        edge=is_edge, near=1e9, avg_run=avg_run, max_run=cl[5],
                        dark_ratio=dark_ratio))
    for i, a in enumerate(out):
        for j, b in enumerate(out):
            if i == j:
                continue
            d = ((a["r"] - b["r"]) ** 2 + (a["g"] - b["g"]) ** 2 + (a["b"] - b["b"]) ** 2) ** 0.5
            if d < a["near"]:
                a["near"] = d
    out.sort(key=lambda a: -a["pct"])
    for c in out:
        c["frag"] = c["avg_run"] < 2.0 and c["pct"] < 1.5
        c["empty"] = c["dark_ratio"] > 0.95 and c["pct"] < 5
        c["checked"] = not c["frag"] and not c["edge"] and not c["empty"]
    return out, sampled, step


def main(path):
    fh, layers, w, h = load_layers(path)
    clown = next(l for l in layers if l["name"].strip().lower() == "clown")
    rgba = next(l for l in layers if l["name"].strip().lower() == "rgba")
    planes = decode_planes(fh, clown, w, h)
    rplanes = decode_planes(fh, rgba, w, h)

    for merge, minpct in ((12, 0.05), (12, 0.15), (8, 0.05)):
        res, sampled, step = cluster(planes, rplanes, w, h, merge, minpct)
        print("\n### merge=%d  minPct=%.2f%%  step=%d  samples=%d  -> %d blocks" % (
            merge, minpct, step, sampled, len(res)))
        for c in res:
            fz = max(2, min(30, int(min(c["near"], 999) * 0.45)))
            flags = []
            if c["edge"]:
                flags.append("BACKGROUND")
            if c["frag"]:
                flags.append("FRAG")
            if c["empty"]:
                flags.append("EMPTY")
            if c["checked"]:
                flags.append("<<CHECKED")
            print("  #%02X%02X%02X  %7.3f%%  near=%6.1f  fuzz=%2d  avgRun=%5.1f dark=%5.1f%%  %s" % (
                c["r"], c["g"], c["b"], c["pct"], c["near"], fz,
                c["avg_run"], c["dark_ratio"] * 100, " ".join(flags)))

    # simulate colour-range picking on the worst case settings
    res, sampled, step = cluster(planes, rplanes, w, h, 12, 0.05)
    A_all = rplanes[-1]
    opaque = sum(1 for i in range(0, w * h, 97) if A_all[i] > 0)
    print("\n### colour-range simulation (euclidean <= fuzz), full res")
    for c in res:
        fz = max(2, min(30, int(min(c["near"], 999) * 0.45)))
        hit = 0
        x0, y0, x1, y1 = w, h, -1, -1
        R_, G_, B_ = planes[0], planes[1], planes[2]
        for y in range(h):
            row = y * w
            for x in range(w):
                i = row + x
                dr = R_[i] - c["r"]
                dg = G_[i] - c["g"]
                db = B_[i] - c["b"]
                if dr * dr + dg * dg + db * db <= fz * fz:
                    hit += 1
                    if x < x0: x0 = x
                    if x > x1: x1 = x
                    if y < y0: y0 = y
                    if y > y1: y1 = y
        print("  #%02X%02X%02X fuzz=%2d -> %8d px  bbox=(%d,%d)-(%d,%d)  shape=%dx%d" % (
            c["r"], c["g"], c["b"], fz, hit, x0, y0, x1, y1,
            (x1 - x0 + 1) if x1 >= 0 else 0, (y1 - y0 + 1) if y1 >= 0 else 0))

    print("\nrgba opaque sample ratio: %.3f%%" % (opaque * 100.0 / len(range(0, w * h, 97))))


if __name__ == "__main__":
    main(sys.argv[1])
