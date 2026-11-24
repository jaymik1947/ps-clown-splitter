#!/usr/bin/env python3
"""Minimal PSD layer-tree dumper (no external deps).

Reads only the header + layer records of a .psd / .psb and prints the layer
tree with names (Pascal + Unicode 'luni'), bounds, visibility, masks and
section dividers. Channel pixel data is never read.
"""
import struct
import sys


class Reader:
    def __init__(self, fh):
        self.f = fh

    def read(self, n):
        b = self.f.read(n)
        if len(b) != n:
            raise EOFError("unexpected EOF")
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

    def u64(self):
        return struct.unpack(">Q", self.read(8))[0]

    def skip(self, n):
        self.f.seek(n, 1)


MODE_NAMES = {
    0: "Bitmap", 1: "Grayscale", 2: "Indexed", 3: "RGB", 4: "CMYK",
    7: "Multichannel", 8: "Duotone", 9: "Lab",
}
SECTION_NAMES = {0: "normal", 1: "group-open", 2: "group-closed", 3: "group-end"}


def parse_pascal_name(r):
    n = r.u8()
    raw = r.read(n)
    pad = (4 - ((n + 1) % 4)) % 4
    if pad:
        r.skip(pad)
    return raw


def main(path):
    fh = open(path, "rb")
    r = Reader(fh)

    sig = r.read(4)
    if sig not in (b"8BPS",):
        raise SystemExit("not a PSD: %r" % sig)
    version = r.u16()
    r.skip(6)
    channels = r.u16()
    height = r.u32()
    width = r.u32()
    depth = r.u16()
    mode = r.u16()

    print("== header ==")
    print("  version   : %d (%s)" % (version, "PSB" if version == 2 else "PSD"))
    print("  size      : %d x %d" % (width, height))
    print("  channels  : %d" % channels)
    print("  bit depth : %d" % depth)
    print("  color mode: %s (%d)" % (MODE_NAMES.get(mode, "?"), mode))

    r.skip(r.u32())          # color mode data
    r.skip(r.u32())          # image resources

    lm_len = r.u32()
    lm_end = fh.tell() + lm_len
    li_len = r.u32()
    li_end = fh.tell() + li_len

    count = r.i16()
    negative = count < 0
    count = abs(count)
    print("\n== layers: %d (first-alpha-is-transparency=%s) ==" % (count, negative))

    records = []
    for idx in range(count):
        top, left, bottom, right = r.i32(), r.i32(), r.i32(), r.i32()
        nch = r.u16()
        chs = []
        for _ in range(nch):
            cid = r.i16()
            clen = r.u64() if version == 2 else r.u32()
            chs.append((cid, clen))
        bsig = r.read(4)
        bkey = r.read(4)
        opacity = r.u8()
        clipping = r.u8()
        flags = r.u8()
        r.skip(1)
        extra_len = r.u32()
        extra_end = fh.tell() + extra_len

        has_mask = False
        mlen = r.u32()
        if mlen:
            has_mask = True
            r.skip(mlen)
        r.skip(r.u32())      # blending ranges

        raw_name = parse_pascal_name(r)

        uname = None
        sect = 0
        lyid = None
        clbl = None
        blocks = []
        while fh.tell() + 12 <= extra_end:
            sig2 = r.read(4)
            if sig2 not in (b"8BIM", b"8B64"):
                break
            key = r.read(4)
            blen = r.u32()
            bstart = fh.tell()
            data = r.read(blen)
            blocks.append(key.decode("latin-1", "replace"))
            if key == b"luni" and len(data) >= 4:
                slen = struct.unpack(">I", data[:4])[0]
                uname = data[4:4 + slen * 2].decode("utf-16-be", "replace")
            elif key == b"lsct" and len(data) >= 4:
                sect = struct.unpack(">I", data[:4])[0]
            elif key == b"lyid" and len(data) >= 4:
                lyid = struct.unpack(">I", data[:4])[0]
            elif key == b"lclr" and len(data) >= 8:
                clbl = struct.unpack(">H", data[2:4])[0]
            if blen % 2 == 1:
                r.skip(1)
            if fh.tell() < bstart + blen:
                fh.seek(bstart + blen)
        fh.seek(extra_end)

        records.append(dict(
            name=raw_name.decode("utf-8", "replace").strip("\x00"),
            uname=uname, sect=sect, lyid=lyid, mask=has_mask,
            box=(left, top, right, bottom),
            w=right - left, h=bottom - top,
            flags=flags, opacity=opacity, blend=bkey.decode("latin-1", "replace"),
            chans=[c[0] for c in chs], blocks=blocks,
        ))

    # ---- build tree ----
    root = []
    stack = [root]
    for rec in records:
        if rec["sect"] == 3:
            if len(stack) > 1:
                stack.pop()
        elif rec["sect"] in (1, 2):
            grp = dict(rec)
            grp["children"] = []
            stack[-1].append(grp)
            stack.append(grp["children"])
        else:
            stack[-1].append(rec)

    def dump(nodes, indent=0):
        pad = "  " * indent
        for n in reversed(nodes):
            hidden = "" if (n["flags"] & 0x02) else "  [HIDDEN]"
            nm = n.get("uname") or n["name"]
            sec = SECTION_NAMES.get(n["sect"], "")
            extra = []
            if sec and sec != "normal":
                extra.append(sec)
            if n["mask"]:
                extra.append("mask")
            if n["opacity"] != 255:
                extra.append("op=%d" % n["opacity"])
            if n["blend"] not in ("norm",):
                extra.append("blend=%s" % n["blend"].strip())
            if n["lyid"] is not None:
                extra.append("id=%d" % n["lyid"])
            info = ("  <" + ", ".join(extra) + ">") if extra else ""
            print("%s- %r  %dx%d @(%d,%d)%s%s" % (
                pad, nm, n["w"], n["h"], n["box"][0], n["box"][1], hidden, info))
            if n.get("children"):
                dump(n["children"], indent + 1)

    print()
    dump(root)
    print("\n== record order (file order: bottom -> top) ==")
    for i, rec in enumerate(records):
        print("  %2d  %-28r sect=%s %dx%d" % (
            i, rec.get("uname") or rec["name"], rec["sect"], rec["w"], rec["h"]))

    extra = li_end - fh.tell()
    if extra > 0:
        print("\n(trailing layer-info bytes: %d)" % extra)


if __name__ == "__main__":
    main(sys.argv[1])
