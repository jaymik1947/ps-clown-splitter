#!/usr/bin/env python3
"""Decode the clown-pass layer of a PSD and report its real colour histogram.

Used to validate the clustering / nearest-colour logic offline, without
Photoshop. Pure stdlib; uses numpy only if present for speed.
"""
import struct
import sys
from collections import Counter

try:
    import numpy as np
except Exception:
    np = None


class R:
    def __init__(self, fh):
        self.f = fh

    def read(self, n):
        b = self.f.read(n)
        if len(b) != n:
            raise EOFError("EOF at %d" % self.f.tell())
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
            cnt = 257 - b
            out += bytes((data[i],)) * cnt
            i += 1
    return bytes(out[:expected])


def main(path, target_name="clown"):
    fh = open(path, "rb")
    r = R(fh)
    assert r.read(4) == b"8BPS"
    version = r.u16()
    r.skip(6)
    channels = r.u16()
    height = r.u32()
    width = r.u32()
    depth = r.u16()
    mode = r.u16()
    r.skip(r.u32())
    r.skip(r.u32())
    lm_len = r.u32()
    li_len = r.u32()
    count = abs(r.i16())

    layers = []
    for _ in range(count):
        top, left, bottom, right = r.i32(), r.i32(), r.i32(), r.i32()
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
            sig2 = r.read(4)
            if sig2 not in (b"8BIM", b"8B64"):
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
        layers.append(dict(name=uname or raw.decode("utf-8", "replace"),
                           chs=chs, box=(left, top, right, bottom)))

    # channel data starts right after all layer records
    cursor = fh.tell()
    fh.seek(0, 2)
    fsize = fh.tell()
    print("channel data offset: %d  (file size %d)" % (cursor, fsize))
    target = None
    for rec in layers:
        if rec["name"].strip().lower() == target_name.lower():
            target = rec
            break
    if target is None:
        print("layer %r not found; have: %s" % (target_name, [l["name"] for l in layers]))
        return

    # materialise offsets
    for rec in layers:
        for ch in rec["chs"]:
            ch.append(cursor)
            cursor += ch[1]
        if rec is target:
            print("target channels:", [(c[0], c[1], c[2]) for c in rec["chs"]])

    l, t, rr, b = target["box"]
    w = rr - l
    h = b - t
    print("target %r box=%s  %dx%d  (doc %dx%d)" % (target["name"], target["box"], w, h, width, height))

    planes = {}
    for cid, clen, off in target["chs"]:
        fh.seek(off)
        comp = struct.unpack(">H", fh.read(2))[0]
        payload = fh.read(clen - 2)
        if comp == 1:
            counts = list(struct.unpack(">%dH" % h, payload[:2 * h]))
            body = payload[2 * h:]
            rows = []
            pos = 0
            for cnt in counts:
                rows.append(unpackbits(body[pos:pos + cnt], w))
                pos += cnt
            plane = b"".join(rows)
        else:
            plane = payload[:w * h]
        planes[cid] = plane
        print("  channel %d: compression=%d, %d bytes -> %d px" % (cid, comp, clen, len(plane)))

    R_, G_, B_ = planes.get(0), planes.get(1), planes.get(2)
    A_ = planes.get(-1)
    if R_ is None or G_ is None or B_ is None:
        print("missing RGB channels")
        return

    total = w * h
    if np is not None:
        a = (np.frombuffer(R_, np.uint8).astype(np.int64) << 16) | \
            (np.frombuffer(G_, np.uint8).astype(np.int64) << 8) | \
            np.frombuffer(B_, np.uint8)
        codes, counts = np.unique(a, return_counts=True)
        order = np.argsort(-counts)
        top = [(int(codes[i]), int(counts[i])) for i in order[:30]]
        uniq = len(codes)
    else:
        ctr = Counter(R_[i] << 16 | G_[i] << 8 | B_[i] for i in range(total))
        top = ctr.most_common(30)
        uniq = len(ctr)

    def hx(c):
        return "#%02X%02X%02X" % ((c >> 16) & 255, (c >> 8) & 255, c & 255)

    print("\nunique colours: %d   total px: %d" % (uniq, total))
    print("\n-- top colours --")
    acc = 0
    for code, cnt in top:
        acc += cnt
        rr_, gg_, bb_ = (code >> 16) & 255, (code >> 8) & 255, code & 255
        print("  %s  %9d  %6.3f%%   cum %6.2f%%   rgb(%d,%d,%d)" % (
            hx(code), cnt, cnt * 100.0 / total, acc * 100.0 / total, rr_, gg_, bb_))

    # alpha stats
    if A_:
        if np is not None:
            av = np.frombuffer(A_, np.uint8)
            print("\nalpha: min=%d max=%d  zeros=%.3f%%" % (
                av.min(), av.max(), (av == 0).sum() * 100.0 / av.size))
        else:
            zeros = sum(1 for v in A_ if v == 0)
            print("\nalpha: zeros=%.3f%%  min=%d max=%d" % (
                zeros * 100.0 / total, min(A_), max(A_)))

    # pairwise distance between the dominant blocks
    blocks = [c for c, n in top if n * 100.0 / total > 0.2]
    print("\n-- dominant blocks (>0.2%%): %d --" % len(blocks))
    worst = []
    for i in range(len(blocks)):
        for j in range(i + 1, len(blocks)):
            c1, c2 = blocks[i], blocks[j]
            d = ((((c1 >> 16) & 255) - ((c2 >> 16) & 255)) ** 2 +
                 (((c1 >> 8) & 255) - ((c2 >> 8) & 255)) ** 2 +
                 ((c1 & 255) - (c2 & 255)) ** 2) ** 0.5
            worst.append((d, hx(c1), hx(c2)))
    worst.sort()
    for d, a_, b_ in worst[:8]:
        print("  %6.1f   %s <-> %s" % (d, a_, b_))

    # corner colours (background probe)
    print("\n-- corners --")
    for nx, ny in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1), (w // 2, 0), (w // 2, h - 1)):
        i = ny * w + nx
        print("  (%4d,%4d) %s" % (nx, ny, hx((R_[i] << 16) | (G_[i] << 8) | B_[i])))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "clown")
