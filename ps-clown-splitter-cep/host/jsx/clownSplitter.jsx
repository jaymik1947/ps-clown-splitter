// ============================================================
//  Clown Splitter - ExtendScript 引擎 (CEP)
//
//  注意：本文件刻意不写 #target photoshop。
//  面板启动时会用 $.evalFile 重新加载它（热重载），
//  带 #target 的脚本在 evalFile 下会报错。
//  CEP 的 ScriptPath 预加载也不需要 #target。
//
//  KeyShot 输出的分层 PSD：
//    Render Passes
//      ├ clown   (每个材质一个纯色)
//      └ rgba    (带 alpha 的成品图)
//
//  分工：
//    面板（Chromium）负责读像素、聚类颜色
//    本文件负责所有 PS 操作：导出缩小图、按色取样、抠图、归档
//
//  关键约束（已在真实 KeyShot PSD 上验证）：
//    - clown / rgba 默认是隐藏的，取样前必须打开
//    - clown 背景是纯黑，其像素数与 rgba 透明区完全一致 -> 蒙版天然对齐
//    - clown 里有大量边缘过渡色，靠面积 + 平均连续段长度筛掉
// ============================================================

var CS = CS || {};

CS.VERSION = "1.0.0";

// ------------------------------------------------------------
//  基础工具
// ------------------------------------------------------------

CS.err = function (e) {
    if (!e) return "未知错误";
    var m = e.message ? String(e.message) : String(e);
    if (e.line) m += "  @line " + e.line;
    return m;
};

CS.quote = function (s) {
    s = String(s);
    s = s.replace(/\\/g, "\\\\");
    s = s.replace(/"/g, '\\"');
    s = s.replace(/\r/g, "\\r");
    s = s.replace(/\n/g, "\\n");
    s = s.replace(/\t/g, "\\t");
    s = s.replace(/[\u0000-\u001f]/g, "");
    // 非 ASCII 一律转 \uXXXX，避免 evalScript 传输中文时编码错乱
    s = s.replace(/[\u0080-\uffff]/g, function (c) {
        var h = c.charCodeAt(0).toString(16);
        while (h.length < 4) h = "0" + h;
        return "\\u" + h;
    });
    return '"' + s + '"';
};

CS.stringify = function (v) {
    if (v === null || v === undefined) return "null";
    var t = typeof v;
    if (t === "number") return isFinite(v) ? String(v) : "0";
    if (t === "boolean") return v ? "true" : "false";
    if (t === "string") return CS.quote(v);
    var i, k;
    if (v instanceof Array) {
        var a = [];
        for (i = 0; i < v.length; i++) a.push(CS.stringify(v[i]));
        return "[" + a.join(",") + "]";
    }
    var p = [];
    for (k in v) {
        if (v.hasOwnProperty(k) && typeof v[k] !== "function") {
            p.push(CS.quote(k) + ":" + CS.stringify(v[k]));
        }
    }
    return "{" + p.join(",") + "}";
};

CS.parse = function (s) {
    return eval("(" + s + ")");
};

CS.hex = function (n) {
    n = Math.round(n);
    if (n < 0) n = 0;
    if (n > 255) n = 255;
    var s = n.toString(16).toUpperCase();
    return s.length < 2 ? "0" + s : s;
};

CS.safeName = function (s) {
    s = String(s).replace(/[\\\/:*?"<>|\r\n\t]/g, "_");
    if (s.length > 190) s = s.substring(0, 190);
    if (!s || s.length === 0) s = "layer";
    return s;
};

// ------------------------------------------------------------
//  图层查找
// ------------------------------------------------------------

CS.findById = function (root, id) {
    var target = Number(id);
    var stack = [root];
    var guard = 0;
    while (stack.length > 0 && guard < 5000) {
        guard++;
        var c = stack.pop();
        var layers = null;
        try { layers = c.layers; } catch (e) { layers = null; }
        if (!layers) continue;
        for (var i = 0; i < layers.length; i++) {
            var l = layers[i];
            if (Number(l.id) === target) return l;
            if (l.typename === "LayerSet") stack.push(l);
        }
    }
    return null;
};

CS.scanLayers = function () {
    try {
        if (app.documents.length === 0) {
            return CS.stringify({ ok: false, msg: "没有打开的文档" });
        }
        var doc = app.activeDocument;
        var out = [];
        var walk = function (container, path) {
            var layers = container.layers;
            for (var i = 0; i < layers.length; i++) {
                var l = layers[i];
                var p = path ? (path + " / " + l.name) : String(l.name);
                if (l.typename === "LayerSet") {
                    walk(l, p);
                } else {
                    out.push({
                        id: Number(l.id),
                        name: String(l.name),
                        path: p,
                        visible: l.visible !== false
                    });
                }
            }
        };
        walk(doc, "");
        return CS.stringify({
            ok: true,
            docName: String(doc.name),
            docW: Number(doc.width.as("px")),
            docH: Number(doc.height.as("px")),
            depth: String(doc.bitsPerChannel),
            mode: String(doc.mode),
            layers: out
        });
    } catch (e) {
        return CS.stringify({ ok: false, msg: CS.err(e) });
    }
};

// ------------------------------------------------------------
//  导出缩小预览图（供面板用 canvas 读像素）
//  必须用最近邻缩放，否则插值会造出一堆假颜色
// ------------------------------------------------------------

CS.exportPreview = function (layerId, maxSize, tag) {
    var srcDoc = null;
    var tmp = null;
    var oldDialogs = app.displayDialogs;
    try {
        if (app.documents.length === 0) return "ERR:没有打开的文档";
        srcDoc = app.activeDocument;
        var lyr = CS.findById(srcDoc, layerId);
        if (!lyr) return "ERR:找不到图层 " + layerId;

        app.displayDialogs = DialogModes.NO;

        var prevVis = lyr.visible;
        if (!prevVis) lyr.visible = true;
        srcDoc.activeLayer = lyr;

        // 保持宽高比缩放，避免拉伸导致 avgRun 判据失真
        var dw = Number(srcDoc.width.as("px"));
        var dh = Number(srcDoc.height.as("px"));
        var scale = maxSize / Math.max(dw, dh);
        if (scale > 1) scale = 1;
        var tw = Math.round(dw * scale);
        var th = Math.round(dh * scale);
        if (tw < 1) tw = 1;
        if (th < 1) th = 1;

        // 注意 documents.add 的第 4 个参数是 name，不是 mode
        tmp = app.documents.add(
            srcDoc.width, srcDoc.height, srcDoc.resolution, "clownsplit_tmp",
            NewDocumentMode.RGB, DocumentFill.TRANSPARENT, 1,
            BitsPerChannelType.EIGHT
        );

        app.activeDocument = srcDoc;
        lyr.duplicate(tmp);

        app.activeDocument = tmp;
        tmp.resizeImage(
            UnitValue(tw, "px"), UnitValue(th, "px"),
            null, ResampleMethod.NEARESTNEIGHBOR
        );

        var f = new File(Folder.temp.fsName + "/clownsplit_" + tag + ".png");
        var opts = new PNGSaveOptions();
        opts.interlaced = false;
        tmp.saveAs(f, opts, true, Extension.LOWERCASE);

        tmp.close(SaveOptions.DONOTSAVECHANGES);
        tmp = null;

        app.activeDocument = srcDoc;
        lyr.visible = prevVis;
        app.displayDialogs = oldDialogs;

        return f.fsName;
    } catch (e) {
        try { if (tmp) tmp.close(SaveOptions.DONOTSAVECHANGES); } catch (e2) {}
        try { if (srcDoc) app.activeDocument = srcDoc; } catch (e3) {}
        try { app.displayDialogs = oldDialogs; } catch (e4) {}
        return "ERR:" + CS.err(e);
    }
};

// ------------------------------------------------------------
//  色彩范围取样
//  先试 string ID（就是 UXP batchPlay 那套），失败再退到老 char ID
// ------------------------------------------------------------

// ------------------------------------------------------------
//  取样：魔棒 / 色彩范围
//
//  魔棒是首选：clown 是纯色块，魔棒按点取样，边界比色彩范围干净，
//  容差 / 连续 / 抗锯齿三个参数都能直接对应 PS 工具栏。
// ------------------------------------------------------------

// 魔棒点选：x,y 是文档坐标
function magicWandSelect(x, y, tolerance, antialias, contiguous) {
    var d = new ActionDescriptor();
    var r = new ActionReference();
    r.putProperty(charIDToTypeID("Chnl"), charIDToTypeID("fsel"));
    d.putReference(charIDToTypeID("null"), r);

    var p = new ActionDescriptor();
    p.putUnitDouble(charIDToTypeID("Hrzn"), charIDToTypeID("#Pxl"), x);
    p.putUnitDouble(charIDToTypeID("Vrtc"), charIDToTypeID("#Pxl"), y);
    d.putObject(charIDToTypeID("T   "), charIDToTypeID("Pnt "), p);

    d.putInteger(charIDToTypeID("Tlrn"), tolerance);
    d.putBoolean(charIDToTypeID("AntA"), !!antialias);
    d.putBoolean(charIDToTypeID("Cntg"), !!contiguous);

    executeAction(charIDToTypeID("setd"), d, DialogModes.NO);
}

CS.rangeMode = "";

function selectColorRange(r, g, b, fuzz) {
    if (CS.rangeMode !== "char") {
        try {
            var d = new ActionDescriptor();
            var c = new ActionDescriptor();
            c.putDouble(stringIDToTypeID("red"), r);
            c.putDouble(stringIDToTypeID("grain"), g);
            c.putDouble(stringIDToTypeID("blue"), b);
            d.putObject(stringIDToTypeID("colors"), stringIDToTypeID("RGBColor"), c);
            d.putInteger(stringIDToTypeID("fuzziness"), fuzz);
            d.putString(stringIDToTypeID("colorModel"), "RGBColor");
            executeAction(stringIDToTypeID("colorRange"), d, DialogModes.NO);
            CS.rangeMode = "string";
            return;
        } catch (e) {
            if (CS.rangeMode === "string") throw e;
            CS.rangeMode = "char";
        }
    }

    var d2 = new ActionDescriptor();
    d2.putInteger(charIDToTypeID("Fzns"), fuzz);
    var c2 = new ActionDescriptor();
    c2.putDouble(charIDToTypeID("Rd  "), r);
    c2.putDouble(charIDToTypeID("Grn "), g);
    c2.putDouble(charIDToTypeID("Bl  "), b);
    d2.putObject(charIDToTypeID("Mnm "), charIDToTypeID("RGBC"), c2);
    executeAction(charIDToTypeID("ClrR"), d2, DialogModes.NO);
}

function nudgeSelection(shift) {
    var d = new ActionDescriptor();
    d.putUnitDouble(charIDToTypeID("By  "), charIDToTypeID("#Pxl"), Math.abs(shift));
    executeAction(charIDToTypeID(shift < 0 ? "Expn" : "Cntc"), d, DialogModes.NO);
}

function safeDeselect(doc) {
    try { doc.selection.deselect(); } catch (e) {}
}

function hasSelection(doc) {
    try {
        var b = doc.selection.bounds;
        return !!b;
    } catch (e) {
        return false;
    }
}

function selectionSize(doc) {
    try {
        var b = doc.selection.bounds;
        var w = Math.round(b[2].as("px") - b[0].as("px"));
        var h = Math.round(b[3].as("px") - b[1].as("px"));
        if (w < 0) w = 0;
        if (h < 0) h = 0;
        return { w: w, h: h };
    } catch (e) {
        return { w: 0, h: 0 };
    }
}

// ------------------------------------------------------------
//  分层主流程（逐色调用，面板可以显示进度）
//
//  每一步做的就是手工流程：
//    1. 在 clown 上按颜色建选区（色彩范围）
//    2. 切到 rgba
//    3. 通过拷贝的图层 —— 选区内的像素直接变成新图层
// ------------------------------------------------------------

CS.beginSplit = function (clownId, rgbaId, groupName, makeGroup) {
    try {
        if (app.documents.length === 0) {
            return CS.stringify({ ok: false, msg: "没有打开的文档" });
        }
        var doc = app.activeDocument;
        var clown = CS.findById(doc, clownId);
        if (!clown) return CS.stringify({ ok: false, msg: "找不到 clown 图层" });

        // clown 必须可见，色彩范围才能取到它的颜色
        var clownPrev = clown.visible;
        if (!clownPrev) clown.visible = true;

        // rgba 也临时打开：隐藏层上做拷贝图层，不同版本行为不一致
        var rgbaPrev = true;
        var rgba = CS.findById(doc, rgbaId);
        if (rgba) {
            rgbaPrev = rgba.visible;
            if (!rgbaPrev) rgba.visible = true;
        }

        var groupId = -1;
        if (makeGroup) {
            doc.activeLayer = clown;
            var g = doc.layerSets.add();
            g.name = groupName || "Clown Split";
            g.move(doc, ElementPlacement.PLACEATBEGINNING);
            groupId = Number(g.id);
        }

        CS.rangeMode = "";
        return CS.stringify({
            ok: true,
            groupId: groupId,
            clownWasVisible: clownPrev,
            rgbaWasVisible: rgbaPrev
        });
    } catch (e) {
        return CS.stringify({ ok: false, msg: CS.err(e) });
    }
};

CS.splitOne = function (json) {
    try {
        var cfg = CS.parse(json);
        var doc = app.activeDocument;
        var clown = CS.findById(doc, cfg.clownId);
        var rgba = CS.findById(doc, cfg.rgbaId);
        if (!clown) return CS.stringify({ ok: false, msg: "clown 图层丢失" });
        if (!rgba) return CS.stringify({ ok: false, msg: "rgba 图层丢失" });

        var label = CS.safeName(
            cfg.name && String(cfg.name).length > 0
                ? cfg.name
                : ("#" + CS.hex(cfg.r) + CS.hex(cfg.g) + CS.hex(cfg.b))
        );
        var usingWand = (cfg.mode !== "range");

        safeDeselect(doc);

        // ---- 1. 在 clown 上建选区：魔棒（首选）或色彩范围 ----
        doc.activeLayer = clown;

        var modeUsed = usingWand ? "wand" : "range";
        var usedTol = 0;

        if (modeUsed === "wand") {
            var dw = Math.round(doc.width.as("px"));
            var dh = Math.round(doc.height.as("px"));
            var wx = Number(cfg.x);
            var wy = Number(cfg.y);
            if (!(wx >= 0) || !(wy >= 0)) {
                return CS.stringify({ ok: false, msg: "没有有效的取样点" });
            }
            if (wx > dw - 1) wx = dw - 1;
            if (wy > dh - 1) wy = dh - 1;

            usedTol = Math.round(Number(cfg.tolerance));
            if (!(usedTol >= 0)) usedTol = 32;
            if (usedTol > 255) usedTol = 255;

            magicWandSelect(wx, wy, usedTol, cfg.antialias !== false, cfg.contiguous === true);
        } else {
            usedTol = Math.round(Number(cfg.tolerance));
            if (!(usedTol >= 1)) usedTol = 30;
            if (usedTol > 200) usedTol = 200;
            selectColorRange(cfg.r, cfg.g, cfg.b, usedTol);
        }

        if (!hasSelection(doc)) {
            return CS.stringify({ ok: false, msg: "没选中像素（" + modeUsed + " 容差 " + usedTol + "）" });
        }

        if (cfg.shift !== 0 && cfg.shift !== undefined) {
            try { nudgeSelection(cfg.shift); } catch (e1) {}
        }

        var box = selectionSize(doc);

        // ---- 2. 切到 rgba，用选区抠图 ----
        doc.activeLayer = rgba;
        // CpTL = 通过拷贝的图层：选区内的像素直接生成新层
        executeAction(charIDToTypeID("CpTL"), undefined, DialogModes.NO);

        var nl = doc.activeLayer;
        nl.name = label;
        nl.visible = true;

        // ---- 3. 归档 ----
        if (cfg.groupId && Number(cfg.groupId) > 0) {
            var g = CS.findById(doc, cfg.groupId);
            if (g) nl.move(g, ElementPlacement.INSIDE);
        }

        safeDeselect(doc);

        return CS.stringify({
            ok: true,
            name: label,
            mode: modeUsed,
            tol: usedTol,
            selW: box.w,
            selH: box.h
        });
    } catch (e) {
        return CS.stringify({ ok: false, msg: CS.err(e) });
    }
};

CS.endSplit = function (clownId, rgbaId, hideClown, clownPrev, rgbaPrev) {
    try {
        var doc = app.activeDocument;
        safeDeselect(doc);

        var rgba = CS.findById(doc, rgbaId);
        if (rgba) rgba.visible = (rgbaPrev !== 0 && rgbaPrev !== false);

        var clown = CS.findById(doc, clownId);
        if (clown) clown.visible = hideClown ? false : (clownPrev !== 0 && clownPrev !== false);

        return CS.stringify({ ok: true });
    } catch (e) {
        return CS.stringify({ ok: false, msg: CS.err(e) });
    }
};

// ------------------------------------------------------------
//  环境自检
// ------------------------------------------------------------

CS.ping = function () {
    try {
        return CS.stringify({
            ok: true,
            version: CS.VERSION,
            ps: String(app.version),
            docs: app.documents.length
        });
    } catch (e) {
        return CS.stringify({ ok: false, msg: CS.err(e) });
    }
};
