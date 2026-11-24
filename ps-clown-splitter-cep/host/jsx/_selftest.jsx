#target photoshop

// ============================================================
//  Clown Splitter 引擎自检
//
//  用法：先打开一个 PSD，然后
//        PS 菜单  文件 > 脚本 > 浏览…  选这个文件
//
//  只做三件事：建临时文档、试颜色范围、试加蒙版。
//  不改原文档的任何像素，图层和选区都会还原。
// ============================================================

(function () {

    var out = [];
    function add(s) { out.push(s); }

    add("=== Clown Splitter 自检 ===");
    add("PS " + app.version + "  /  " + $.os);

    if (app.documents.length === 0) {
        add("");
        add("!! 请先打开一个 PSD 再运行本自检");
        alert(out.join("\n"));
        return;
    }

    var doc = app.activeDocument;
    var oldDialogs = app.displayDialogs;
    app.displayDialogs = DialogModes.NO;

    add("文档: " + doc.name);
    add("尺寸: " + Math.round(doc.width.as("px")) + " x " + Math.round(doc.height.as("px")) +
        "   位深: " + doc.bitsPerChannel);

    // ---------- 1. 新建临时文档（导出缩略图要用） ----------
    var tmp = null;
    try {
        tmp = app.documents.add(
            doc.width, doc.height, doc.resolution, "selftest_tmp",
            NewDocumentMode.RGB, DocumentFill.TRANSPARENT, 1,
            BitsPerChannelType.EIGHT
        );
        add("[1] documents.add ....... OK   " +
            Math.round(tmp.width.as("px")) + "x" + Math.round(tmp.height.as("px")));
        tmp.close(SaveOptions.DONOTSAVECHANGES);
        tmp = null;
        app.activeDocument = doc;
    } catch (e) {
        add("[1] documents.add ....... FAIL " + e.message);
        try { if (tmp) tmp.close(SaveOptions.DONOTSAVECHANGES); } catch (e1) {}
        try { app.activeDocument = doc; } catch (e2) {}
    }

    // ---------- 2. string ID 是否可用 ----------
    try {
        add("[2] stringID(colorRange) = " + stringIDToTypeID("colorRange"));
        add("    stringID(colors)     = " + stringIDToTypeID("colors"));
    } catch (e) {
        add("[2] stringIDToTypeID .... FAIL " + e.message);
    }

    // ---------- 3. 最近邻缩放 + 存 PNG ----------
    var f = null;
    try {
        var probe = null;
        for (var i = 0; i < doc.layers.length; i++) {
            var L = doc.layers[i];
            if (L.typename === "ArtLayer" && L.kind === LayerKind.NORMAL) { probe = L; break; }
        }
        if (!probe) {
            add("[3] 缩略图导出 ........ SKIP (没找到普通像素层)");
        } else {
            doc.activeLayer = probe;
            var t2 = app.documents.add(doc.width, doc.height, doc.resolution, "selftest_tmp2",
                NewDocumentMode.RGB, DocumentFill.TRANSPARENT, 1, BitsPerChannelType.EIGHT);
            app.activeDocument = doc;
            probe.duplicate(t2);
            app.activeDocument = t2;
            t2.resizeImage(UnitValue(256, "px"), UnitValue(256, "px"), null, ResampleMethod.NEARESTNEIGHBOR);
            f = new File(Folder.temp.fsName + "/clownsplit_selftest.png");
            var po = new PNGSaveOptions();
            po.interlaced = false;
            t2.saveAs(f, po, true, Extension.LOWERCASE);
            t2.close(SaveOptions.DONOTSAVECHANGES);
            app.activeDocument = doc;
            add("[3] 缩略图导出 ......... OK   " + f.fsName);
            add("    (文件存在: " + f.exists + ", " + (f.exists ? f.length : 0) + " bytes)");
        }
    } catch (e) {
        add("[3] 缩略图导出 ......... FAIL " + e.message);
        try { app.activeDocument = doc; } catch (e3) {}
    }

    // ---------- 4. 颜色范围 ----------
    var selOK = false;
    try {
        var d = new ActionDescriptor();
        var c = new ActionDescriptor();
        c.putDouble(stringIDToTypeID("red"), 255);
        c.putDouble(stringIDToTypeID("grain"), 0);
        c.putDouble(stringIDToTypeID("blue"), 0);
        d.putObject(stringIDToTypeID("colors"), stringIDToTypeID("RGBColor"), c);
        d.putInteger(stringIDToTypeID("fuzziness"), 30);
        executeAction(stringIDToTypeID("colorRange"), d, DialogModes.NO);
        selOK = true;
        var hasSel = true;
        try { var b = doc.selection.bounds; } catch (e4) { hasSel = false; }
        add("[4] colorRange(string) .. OK   选区=" + (hasSel ? "有" : "空"));
        try { doc.selection.deselect(); } catch (e5) {}
    } catch (e) {
        add("[4] colorRange(string) .. FAIL " + e.message);
        try { doc.selection.deselect(); } catch (e6) {}
    }

    // 退路：老 char ID
    if (!selOK) {
        try {
            var d2 = new ActionDescriptor();
            d2.putInteger(charIDToTypeID("Fzns"), 30);
            var c2 = new ActionDescriptor();
            c2.putDouble(charIDToTypeID("Rd  "), 255);
            c2.putDouble(charIDToTypeID("Grn "), 0);
            c2.putDouble(charIDToTypeID("Bl  "), 0);
            d2.putObject(charIDToTypeID("Mnm "), charIDToTypeID("RGBC"), c2);
            executeAction(charIDToTypeID("ClrR"), d2, DialogModes.NO);
            add("[4b] colorRange(char) .... OK   退回老写法可用");
            try { doc.selection.deselect(); } catch (e7) {}
        } catch (e) {
            add("[4b] colorRange(char) .... FAIL " + e.message);
        }
    }

    // ---------- 4c. 魔棒点选（主要取样方式） ----------
    try {
        var mw = new ActionDescriptor();
        var mwRef = new ActionReference();
        mwRef.putProperty(charIDToTypeID("Chnl"), charIDToTypeID("fsel"));
        mw.putReference(charIDToTypeID("null"), mwRef);
        var ptD = new ActionDescriptor();
        ptD.putUnitDouble(charIDToTypeID("Hrzn"), charIDToTypeID("#Pxl"),
            Math.round(doc.width.as("px") / 2));
        ptD.putUnitDouble(charIDToTypeID("Vrtc"), charIDToTypeID("#Pxl"),
            Math.round(doc.height.as("px") / 2));
        mw.putObject(charIDToTypeID("T   "), charIDToTypeID("Pnt "), ptD);
        mw.putInteger(charIDToTypeID("Tlrn"), 32);
        mw.putBoolean(charIDToTypeID("AntA"), true);
        mw.putBoolean(charIDToTypeID("Cntg"), false);
        executeAction(charIDToTypeID("setd"), mw, DialogModes.NO);
        var hasSel2 = true;
        try { var bb = doc.selection.bounds; } catch (e10) { hasSel2 = false; }
        add("[4c] 魔棒点选 .......... OK   选区=" + (hasSel2 ? "有" : "空(点上可能是透明)"));
        try { doc.selection.deselect(); } catch (e11) {}
    } catch (e) {
        add("[4c] 魔棒点选 .......... FAIL " + e.message);
        try { doc.selection.deselect(); } catch (e12) {}
    }

    // ---------- 5. 建选区 + 通过拷贝的图层（真正的抠图动作） ----------
    try {
        var base = null;
        for (var j = 0; j < doc.layers.length; j++) {
            var L2 = doc.layers[j];
            if (L2.typename === "ArtLayer" && L2.kind === LayerKind.NORMAL) { base = L2; break; }
        }
        if (!base) {
            add("[5] 通过拷贝的图层 ..... SKIP (没找到普通像素层)");
        } else {
            doc.activeLayer = base;
            base.visible = true;
            doc.selection.selectAll();
            var before = doc.layers.length;
            executeAction(charIDToTypeID("CpTL"), undefined, DialogModes.NO);
            var after = doc.layers.length;
            var nl = doc.activeLayer;
            add("[5] 通过拷贝的图层 ..... " + (after > before ? "OK" : "FAIL") +
                "   新层=" + nl.name + "  层数 " + before + "->" + after);
            if (after > before && nl !== base) nl.remove();
            try { doc.selection.deselect(); } catch (e8) {}
        }
    } catch (e) {
        add("[5] 通过拷贝的图层 ..... FAIL " + e.message);
        try { doc.selection.deselect(); } catch (e9) {}
    }

    app.displayDialogs = oldDialogs;

    add("");
    add("把以上内容整段发回来即可定位问题。");

    alert(out.join("\n"));

})();
