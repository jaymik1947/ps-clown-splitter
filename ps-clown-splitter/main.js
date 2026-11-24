/**
 * Clown Splitter - Photoshop UXP panel
 *
 * KeyShot 输出的分层 PSD：
 *   Render Passes
 *     ├ clown   (每个材质一个纯色)
 *     └ rgba    (带 alpha 的成品图)
 *
 * 本面板按 clown 的色块，把 rgba 拆成每个材质一个带蒙版的图层。
 *
 * 关键实现约束（已在真实 KeyShot PSD 上验证）：
 *  - clown / rgba 在 KeyShot 输出里默认是隐藏的，必须先 show 才能取样。
 *  - clown 的 alpha 全为 255，背景是纯黑，且黑背景的像素数与 rgba 的透明区
 *    完全一致，所以蒙版与 alpha 天然对齐，不需要羽化。
 *  - clown 里存在大量边缘过渡色（1846 个唯一色里绝大多数是这种），
 *    必须靠「面积 + 平均连续段长度」把真正的材质块和过渡带区分开。
 *  - KeyShot 自动 clown 的相邻色有时太接近，所以每个颜色单独算容差：
 *    取「到最近邻真实色块距离」的 45%，避免串色。
 */

const ps = require("photoshop");
const app = ps.app;
const core = ps.core;
const action = ps.action;
const imaging = ps.imaging;
const batchPlay = action.batchPlay;

const STATE = {
  docId: null,
  layers: [],
  picked: [],
  busy: false
};

const FRAG_RUN = 2.0;     // 平均连续段长度低于此值 => 过渡带/碎片
const FRAG_PCT = 1.5;     // 且面积占比低于此值

/* ------------------------------------------------------------------ */
/* DOM                                                                 */
/* ------------------------------------------------------------------ */

function $(id) {
  return document.getElementById(id);
}

function log(msg, tone) {
  const box = $("log");
  const line = document.createElement("div");
  line.className = "logline" + (tone ? " " + tone : "");
  line.textContent = msg;
  box.appendChild(line);
  while (box.childNodes.length > 500) {
    box.removeChild(box.firstChild);
  }
  box.scrollTop = box.scrollHeight;
}

function clearLog() {
  $("log").innerHTML = "";
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function errMsg(e) {
  if (!e) return "未知错误";
  if (typeof e === "string") return e;
  return e.message || String(e);
}

function h2(n) {
  n = Math.round(n);
  if (n < 0) n = 0;
  if (n > 255) n = 255;
  const s = n.toString(16).toUpperCase();
  return s.length === 1 ? "0" + s : s;
}

function rgbHex(r, g, b) {
  return "#" + h2(r) + h2(g) + h2(b);
}

function safeName(s) {
  return String(s).replace(/[\\\/:*?"<>|\r\n\t]/g, "_").slice(0, 200);
}

function abs(n) {
  return n < 0 ? -n : n;
}

async function bp(descs, opts) {
  const list = descs.map(function (d) {
    if (!d._options) d._options = { dialogMode: "dontDisplay" };
    return d;
  });
  return batchPlay(list, Object.assign({ synchronousExecution: false }, opts || {}));
}

/* ------------------------------------------------------------------ */
/* 图层                                                                */
/* ------------------------------------------------------------------ */

async function getLayerTree() {
  const res = await bp([{
    _obj: "get",
    _target: [
      { _property: "layerTree" },
      { _ref: "document", _enum: "ordinal", _value: "targetEnum" }
    ]
  }]);
  const first = res && res[0];
  if (!first) return null;
  return first.layerTree || first;
}

function collectLayers(node, parentPath, out) {
  const kids = node._children || [];
  const name = node.name ? String(node.name) : "(未命名)";
  const path = parentPath ? parentPath + " / " + name : name;
  if (kids.length > 0) {
    for (let i = 0; i < kids.length; i++) {
      collectLayers(kids[i], path, out);
    }
  } else {
    out.push({
      id: node.layerID,
      name: name,
      path: path,
      visible: node.visible !== false
    });
  }
}

function fillSelect(sel, layers) {
  const keep = sel.value;
  sel.innerHTML = "";
  if (!layers.length) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = "（没有可用图层）";
    sel.appendChild(o);
    return;
  }
  layers.forEach(function (l) {
    const o = document.createElement("option");
    o.value = String(l.id);
    o.textContent = l.path + (l.visible ? "" : "  [隐藏]");
    sel.appendChild(o);
  });
  if (keep) {
    const opts = sel.getElementsByTagName("option");
    for (let i = 0; i < opts.length; i++) {
      if (opts[i].value === keep) {
        sel.value = keep;
        return;
      }
    }
  }
}

function autoMatch(layers) {
  let clown = null;
  let rgba = null;
  let i;
  for (i = 0; i < layers.length; i++) {
    if (/clown/i.test(layers[i].name)) { clown = layers[i]; break; }
  }
  if (!clown) {
    for (i = 0; i < layers.length; i++) {
      if (/clown/i.test(layers[i].path)) { clown = layers[i]; break; }
    }
  }
  const pool = layers.filter(function (l) {
    return !/clown/i.test(l.name) && !(clown && l.id === clown.id);
  });
  const tries = [/^rgba$/i, /rgba/i, /beauty/i, /^rgb$/i, /render/i];
  for (let t = 0; t < tries.length && !rgba; t++) {
    for (i = 0; i < pool.length; i++) {
      if (tries[t].test(pool[i].name)) { rgba = pool[i]; break; }
    }
  }
  return { clown: clown, rgba: rgba };
}

async function refreshLayers(verbose) {
  if (!app.documents || app.documents.length === 0) {
    throw new Error("请先打开一个 PSD");
  }
  const doc = app.activeDocument;
  const tree = await getLayerTree();
  const out = [];
  if (tree) collectLayers(tree, "", out);
  STATE.docId = doc.id;
  STATE.layers = out;

  fillSelect($("clownSel"), out);
  fillSelect($("rgbaSel"), out);

  const m = autoMatch(out);
  if (m.clown) $("clownSel").value = String(m.clown.id);
  if (m.rgba) $("rgbaSel").value = String(m.rgba.id);

  if (verbose) {
    log("文档：" + (doc.title || "(未命名)") + "  ·  图层 " + out.length + " 个");
    if (m.clown) log("clown → " + m.clown.path + (m.clown.visible ? "" : "  (隐藏)"));
    else log("没找到名字含 clown 的图层，请手动选择", "warn");
    if (m.rgba) log("rgba  → " + m.rgba.path + (m.rgba.visible ? "" : "  (隐藏)"));
    else log("没找到名字含 rgba 的图层，请手动选择", "warn");
  }
  return out;
}

async function selectLayerById(id) {
  await bp([{
    _obj: "select",
    _target: [{ _ref: "layer", _id: id }]
  }]);
}

async function activeLayerId() {
  const res = await bp([{
    _obj: "get",
    _target: [
      { _property: "layerID" },
      { _ref: "layer", _enum: "ordinal", _value: "targetEnum" }
    ]
  }]);
  return res && res[0] ? res[0].layerID : null;
}

async function deselect() {
  await bp([{
    _obj: "set",
    _target: [{ _property: "selection", _ref: "document" }],
    to: { _enum: "ordinal", _value: "none" }
  }]);
}

async function hasSelection() {
  const res = await bp([{
    _obj: "get",
    _target: [
      { _property: "selection" },
      { _ref: "document", _enum: "ordinal", _value: "targetEnum" }
    ]
  }]);
  const r = res && res[0];
  return !!(r && r.selection);
}

async function showLayer(id) {
  await bp([{ _obj: "show", _target: [{ _ref: "layer", _id: id }] }]);
}

async function hideLayer(id) {
  await bp([{ _obj: "hide", _target: [{ _ref: "layer", _id: id }] }]);
}

async function docInfo() {
  const res = await bp([
    {
      _obj: "get",
      _target: [
        { _property: "mode" },
        { _ref: "document", _enum: "ordinal", _value: "targetEnum" }
      ]
    },
    {
      _obj: "get",
      _target: [
        { _property: "depth" },
        { _ref: "document", _enum: "ordinal", _value: "targetEnum" }
      ]
    }
  ]);
  const mode = res[0] && res[0].mode ? String(res[0].mode._value || res[0].mode) : "";
  const depth = res[1] && res[1].depth ? String(res[1].depth._value || res[1].depth) : "";
  return { mode: mode, depth: depth };
}

/* ------------------------------------------------------------------ */
/* 颜色分析                                                            */
/* ------------------------------------------------------------------ */

async function readLayerPixels(layerId, applyAlpha) {
  const doc = app.activeDocument;
  const src = await imaging.getPixels({
    document: doc,
    layerID: layerId,
    componentSize: 8,
    applyAlpha: !!applyAlpha,
    colorSpace: "RGB"
  });
  const img = src.imageData;
  const w = img.width;
  const h = img.height;
  const comps = img.components;
  const buf = await img.getData({ chunky: true });
  if (img.dispose) img.dispose();
  if (src.dispose) src.dispose();
  return { w: w, h: h, comps: comps, buf: buf };
}

function edgeSamples(px) {
  const w = px.w;
  const h = px.h;
  const c = px.comps;
  const buf = px.buf;
  const out = [];
  const N = 8;
  for (let i = 0; i <= N; i++) {
    const xx = Math.round((w - 1) * i / N);
    const yy = Math.round((h - 1) * i / N);
    const pts = [[xx, 0], [xx, h - 1], [0, yy], [w - 1, yy]];
    for (let k = 0; k < pts.length; k++) {
      const x = Math.max(0, Math.min(w - 1, pts[k][0]));
      const y = Math.max(0, Math.min(h - 1, pts[k][1]));
      const idx = (y * w + x) * c;
      out.push([buf[idx], buf[idx + 1], buf[idx + 2]]);
    }
  }
  return out;
}

function clusterColors(px, rgbaPx, merge, minPct) {
  const w = px.w;
  const h = px.h;
  const c = px.comps;
  const buf = px.buf;
  const total = w * h;
  const step = Math.max(1, Math.round(Math.sqrt(total / 262144)));

  const bins = new Map();
  let sampled = 0;

  for (let y = 0; y < h; y += step) {
    const row = y * w;
    for (let x = 0; x < w; x += step) {
      const i = (row + x) * c;
      const r = buf[i];
      const g = buf[i + 1];
      const b = buf[i + 2];
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      let e = bins.get(key);
      if (e === undefined) {
        bins.set(key, { n: 1, r: r, g: g, b: b, lastX: x, runs: 1, cur: 1, runMax: 1 });
      } else {
        e.n++;
        e.r += r;
        e.g += g;
        e.b += b;
        if (e.lastX === x - step) {
          e.cur++;
        } else {
          e.runs++;
          e.cur = 1;
        }
        if (e.cur > e.runMax) e.runMax = e.cur;
        e.lastX = x;
      }
      sampled++;
    }
  }

  // bin -> 候选色（保留主导 bin 的均值，不因为合并而漂移）
  const arr = [];
  bins.forEach(function (e) {
    e.r = e.r / e.n;
    e.g = e.g / e.n;
    e.b = e.b / e.n;
    arr.push(e);
  });
  arr.sort(function (a, b) { return b.n - a.n; });

  const m2 = merge * merge;
  const clusters = [];
  for (let i = 0; i < arr.length; i++) {
    const cc = arr[i];
    let host = null;
    for (let j = 0; j < clusters.length; j++) {
      const cl = clusters[j];
      const dr = cc.r - cl.r;
      const dg = cc.g - cl.g;
      const db = cc.b - cl.b;
      if (dr * dr + dg * dg + db * db <= m2) { host = cl; break; }
    }
    if (host) {
      host.n += cc.n;
      host.runs += cc.runs;
      if (cc.runMax > host.runMax) host.runMax = cc.runMax;
    } else {
      clusters.push({
        r: cc.r, g: cc.g, b: cc.b,
        n: cc.n, runs: cc.runs, runMax: cc.runMax
      });
    }
  }

  // 第二遍：判断每个色块在 rgba 上到底有没有可见内容。
  // rgba 用 applyAlpha=true 读，透明区被预乘成纯黑，
  // 所以「整块几乎全黑」== 这个材质在成品图上被遮挡 / 在画外 / 是透明的。
  if (rgbaPx && rgbaPx.w === w && rgbaPx.h === h && clusters.length) {
    const rb = rgbaPx.buf;
    const rc = rgbaPx.comps;
    for (let y = 0; y < h; y += step) {
      const row = y * w;
      for (let x = 0; x < w; x += step) {
        const i = (row + x) * c;
        const r = buf[i];
        const g = buf[i + 1];
        const b = buf[i + 2];
        let hit = -1;
        let bestD = 1600; // 40^2，超过就认为不属于任何色块（边缘混色）
        for (let k = 0; k < clusters.length; k++) {
          const cl = clusters[k];
          const dr = r - cl.r;
          const dg = g - cl.g;
          const db = b - cl.b;
          const d = dr * dr + dg * dg + db * db;
          if (d < bestD) { bestD = d; hit = k; }
        }
        if (hit < 0) continue;
        const cl = clusters[hit];
        cl.seen = (cl.seen || 0) + 1;
        const j = (row + x) * rc;
        if (rb[j] < 3 && rb[j + 1] < 3 && rb[j + 2] < 3) {
          cl.dark = (cl.dark || 0) + 1;
        }
      }
    }
  }

  const edges = edgeSamples(px);
  const minCount = Math.max(6, sampled * (minPct / 100));
  const out = [];

  for (let i = 0; i < clusters.length; i++) {
    const cl = clusters[i];
    if (cl.n < minCount) continue;
    const r = Math.round(cl.r);
    const g = Math.round(cl.g);
    const b = Math.round(cl.b);
    let isEdge = false;
    for (let k = 0; k < edges.length; k++) {
      const dr = r - edges[k][0];
      const dg = g - edges[k][1];
      const db = b - edges[k][2];
      if (dr * dr + dg * dg + db * db < 400) { isEdge = true; break; }
    }
    const pct = (cl.n / sampled) * 100;
    const avgRun = cl.runs > 0 ? cl.n / cl.runs : cl.n;
    const seen = cl.seen || 0;
    const darkRatio = seen ? (cl.dark || 0) / seen : 0;
    out.push({
      r: r, g: g, b: b,
      pct: pct,
      edge: isEdge,
      avgRun: avgRun,
      maxRun: cl.runMax,
      darkRatio: darkRatio,
      frag: avgRun < FRAG_RUN && pct < FRAG_PCT,
      empty: seen > 20 && darkRatio > 0.95 && pct < 5,
      near: 999
    });
  }

  out.sort(function (a, b) { return b.pct - a.pct; });
  recalcNear(out);
  return { colors: out, sampled: sampled, step: step };
}

/** 相邻色距离：只和「真实色块」比较，过渡带碎片不参与，否则容差会被压死。 */
function recalcNear(list) {
  const solid = list.filter(function (c) { return !c.frag && !c.empty; });
  for (let i = 0; i < list.length; i++) {
    let best = Infinity;
    for (let j = 0; j < solid.length; j++) {
      if (solid[j] === list[i]) continue;
      const dr = list[i].r - solid[j].r;
      const dg = list[i].g - solid[j].g;
      const db = list[i].b - solid[j].b;
      const d = Math.sqrt(dr * dr + dg * dg + db * db);
      if (d < best) best = d;
    }
    list[i].near = best === Infinity ? 999 : best;
  }
}

/* ------------------------------------------------------------------ */
/* 选区 / 生成                                                         */
/* ------------------------------------------------------------------ */

async function colorRangePick(r, g, b, fuzz) {
  await bp([{
    _obj: "colorRange",
    colors: { _obj: "RGBColor", red: r, grain: g, blue: b },
    fuzziness: fuzz,
    colorModel: "RGBColor"
  }]);
}

async function nudgeSelection(delta) {
  if (!delta) return;
  if (delta < 0) {
    await bp([{
      _obj: "expand",
      by: { _unit: "pixelsUnit", _value: abs(delta) }
    }]);
  } else {
    await bp([{
      _obj: "contract",
      by: { _unit: "pixelsUnit", _value: delta }
    }]);
  }
}

function currentSettings() {
  return {
    fuzzCap: Number($("fuzz").value),
    merge: Number($("merge").value),
    shift: Number($("shrink").value),
    minPct: Number($("minPct").value) / 100,
    group: $("optGroup").checked,
    hideClown: $("optHideClown").checked
  };
}

/* ------------------------------------------------------------------ */
/* 动作：分析                                                          */
/* ------------------------------------------------------------------ */

async function doAnalyze() {
  if (STATE.busy) return;
  const clownId = Number($("clownSel").value);
  if (!clownId) {
    log("先选择一个 clown 图层", "err");
    return;
  }
  if (!app.documents || app.documents.length === 0) {
    log("请先打开一个 PSD", "err");
    return;
  }

  const s = currentSettings();
  setBusy(true, "分析中…");
  clearLog();

  try {
    const info = await docInfo();
    if (info.mode && !/rgb/i.test(info.mode)) {
      log("当前文档不是 RGB 模式（" + info.mode + "），无法按颜色取样", "err");
      setBusy(false);
      return;
    }
    if (info.depth && info.depth !== "eight") {
      log("当前文档位深是 " + info.depth + "，Color Range 在 16/32 位下色值会偏差。", "warn");
      log("建议先执行 图像 > 模式 > 8 位/通道，再运行本面板。", "warn");
    }

    const lay = STATE.layers.filter(function (l) { return l.id === clownId; })[0];
    if (lay && !lay.visible) {
      // KeyShot 输出的 clown / rgba 默认是隐藏的，隐藏层取不到颜色
      await core.executeAsModal(async function () {
        await showLayer(clownId);
      }, { commandName: "显示 clown 图层" });
      lay.visible = true;
      log("clown 原本是隐藏的，已自动显示", "warn");
    }

    const px = await readLayerPixels(clownId, false);
    log("clown 像素 " + px.w + "×" + px.h + "，通道 " + px.comps);

    // 读 rgba 用于「空块」判定：clown 里有颜色，但成品图上这块其实是透明/被挡住的
    let rgbaPx = null;
    const rgbaId = Number($("rgbaSel").value);
    if (rgbaId && rgbaId !== clownId) {
      const rl = STATE.layers.filter(function (l) { return l.id === rgbaId; })[0];
      const wasHidden = rl && !rl.visible;
      try {
        if (wasHidden) {
          await core.executeAsModal(async function () {
            await showLayer(rgbaId);
          }, { commandName: "临时显示 rgba" });
        }
        rgbaPx = await readLayerPixels(rgbaId, true);
        log("rgba 像素 " + rgbaPx.w + "×" + rgbaPx.h + "，用于空块检测");
      } catch (e) {
        log("读 rgba 失败，跳过空块检测：" + errMsg(e), "warn");
      } finally {
        if (wasHidden) {
          try {
            await core.executeAsModal(async function () {
              await hideLayer(rgbaId);
            }, { commandName: "恢复隐藏 rgba" });
          } catch (e2) {}
        }
      }
    }

    const res = clusterColors(px, rgbaPx, s.merge, s.minPct);
    STATE.picked = res.colors.map(function (c) {
      const copy = Object.assign({}, c);
      copy.checked = !c.edge && !c.frag && !c.empty;
      copy.name = "";
      return copy;
    });

    renderColors();

    const normal = STATE.picked.filter(function (c) { return c.checked; }).length;
    const skipped = STATE.picked.length - normal;
    log("采样 " + res.sampled + " 点（步长 " + res.step + "），检出 " + STATE.picked.length + " 个色块");
    log("已自动勾选 " + normal + " 个；跳过 " + skipped + " 个（背景 / 过渡带 / 空块）",
        normal ? "ok" : "warn");

    const risky = STATE.picked.filter(function (c) {
      return !c.frag && !c.edge && !c.empty && c.near < 30;
    });
    if (risky.length) {
      log("注意：有 " + risky.length + " 个色块和邻居距离 < 30，容差会被自动收紧", "warn");
    }

    syncRunBtn();
  } catch (e) {
    log("分析失败：" + errMsg(e), "err");
  } finally {
    setBusy(false);
  }
}

/* ------------------------------------------------------------------ */
/* 动作：生成                                                          */
/* ------------------------------------------------------------------ */

async function doGenerate() {
  if (STATE.busy) return;
  const chosen = STATE.picked.filter(function (c) { return c.checked; });
  if (!chosen.length) {
    log("没有勾选任何色块", "err");
    return;
  }

  const clownId = Number($("clownSel").value);
  const rgbaId = Number($("rgbaSel").value);
  if (!clownId || !rgbaId) {
    log("clown 和 rgba 图层都要选", "err");
    return;
  }
  if (clownId === rgbaId) {
    log("clown 和 rgba 不能是同一层", "err");
    return;
  }

  if (!app.documents || app.documents.length === 0) {
    log("请先打开一个 PSD", "err");
    return;
  }
  const doc = app.activeDocument;
  if (STATE.docId !== null && doc.id !== STATE.docId) {
    log("文档已切换，请重新分析", "err");
    return;
  }

  const s = currentSettings();
  // 面积小的先做，最后生成的在组内最上面 => 组内自上而下按面积从大到小
  const list = chosen.slice().sort(function (a, b) { return a.pct - b.pct; });

  setBusy(true, "生成中…");
  let ok = 0;
  let fail = 0;

  try {
    const rgbaLayerInfo = STATE.layers.filter(function (l) { return l.id === rgbaId; })[0];
    const rgbaWasHidden = !!(rgbaLayerInfo && !rgbaLayerInfo.visible);

    await core.executeAsModal(async function () {
      await showLayer(clownId);
      // 隐藏层上做「通过拷贝的图层」，不同版本行为不一致，先打开
      if (rgbaWasHidden) await showLayer(rgbaId);

      let groupId = null;
      if (s.group) {
        await deselect();
        await bp([{ _obj: "make", _target: [{ _ref: "layerSection" }] }]);
        await bp([{
          _obj: "set",
          _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
          to: { _obj: "layer", name: "Clown Split" }
        }]);
        groupId = await activeLayerId();
        if (groupId) {
          // KeyShot 的 Render Passes 组会把新层压在中间，直接提到文档最顶层
          await bp([{
            _obj: "move",
            _target: [{ _ref: "layer", _id: groupId }],
            to: { _ref: "layer", _enum: "ordinal", _value: "front" }
          }]);
        } else {
          log("分组创建失败，改为不分组输出", "warn");
        }
      }

      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        const label = safeName(c.name && c.name.trim() ? c.name.trim() : rgbHex(c.r, c.g, c.b));
        const fuzz = Math.max(2, Math.min(s.fuzzCap, Math.floor(c.near * 0.45)));
        log("(" + (i + 1) + "/" + list.length + ") " + label +
            "  rgb(" + c.r + "," + c.g + "," + c.b + ")  容差 " + fuzz);

        try {
          await deselect();
          await selectLayerById(clownId);
          await colorRangePick(c.r, c.g, c.b, fuzz);

          if (!(await hasSelection())) {
            log("    没选中像素，跳过", "warn");
            fail++;
            await deselect();
            continue;
          }
          await nudgeSelection(s.shift);

          await selectLayerById(rgbaId);
          // copyToLayer = 通过拷贝的图层：选区内的像素直接生成新层
          await bp([{ _obj: "copyToLayer" }]);
          const newId = await activeLayerId();
          if (newId) {
            await showLayer(newId);
            await bp([{
              _obj: "set",
              _target: [{ _ref: "layer", _id: newId }],
              to: { _obj: "layer", name: label }
            }]);
            await selectLayerById(newId);
          }

          if (groupId) {
            await bp([{
              _obj: "move",
              _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
              to: { _ref: "layer", _id: groupId }
            }]);
          }
          ok++;
          await deselect();
        } catch (e) {
          fail++;
          log("    失败：" + errMsg(e), "err");
          try { await deselect(); } catch (e2) {}
        }
      }

      try { await deselect(); } catch (e3) {}
      if (rgbaWasHidden) {
        try { await hideLayer(rgbaId); } catch (e4) {}
      }
      if (s.hideClown) {
        try { await hideLayer(clownId); } catch (e5) {}
      }
    }, { commandName: "Clown 分层" });

    log("完成：成功 " + ok + " 层，失败 " + fail + " 层", ok ? "ok" : "warn");
  } catch (e) {
    log("执行中断：" + errMsg(e), "err");
  } finally {
    setBusy(false);
    try { await refreshLayers(false); } catch (e5) {}
  }
}

/* ------------------------------------------------------------------ */
/* 列表 UI                                                             */
/* ------------------------------------------------------------------ */

function renderColors() {
  const box = $("colorList");
  box.innerHTML = "";

  if (!STATE.picked.length) {
    const d = document.createElement("div");
    d.className = "empty";
    d.textContent = "点「① 分析色块」扫描 clown 的颜色。";
    box.appendChild(d);
    return;
  }

  STATE.picked.forEach(function (c, i) {
    const row = document.createElement("div");
    row.className = "crow";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "c-chk";
    cb.checked = c.checked;
    cb.addEventListener("change", function () {
      STATE.picked[i].checked = cb.checked;
      syncRunBtn();
    });

    const sw = document.createElement("div");
    sw.className = "c-sw";
    sw.style.backgroundColor = "rgb(" + c.r + "," + c.g + "," + c.b + ")";

    const meta = document.createElement("div");
    meta.className = "c-meta";

    const m1 = document.createElement("div");
    m1.className = "m1";
    m1.textContent = rgbHex(c.r, c.g, c.b) + "   " + c.pct.toFixed(2) + "%";

    const m2 = document.createElement("div");
    m2.className = "m2";
    const tags = [];
    if (c.empty) tags.push({ cls: "tag", text: "空块" });
    if (c.edge) tags.push({ cls: "tag", text: "背景" });
    if (c.frag) tags.push({ cls: "tag", text: "过渡带" });
    if (!c.frag && !c.edge && !c.empty) {
      if (c.near < 30) {
        tags.push({ cls: "tag bad", text: "近色 " + Math.round(c.near) });
      } else {
        tags.push({ cls: "tag dim", text: "邻距 " + Math.round(c.near) });
      }
    }
    tags.forEach(function (t) {
      const sp = document.createElement("span");
      sp.className = t.cls;
      sp.textContent = t.text;
      m2.appendChild(sp);
    });

    meta.appendChild(m1);
    meta.appendChild(m2);

    const nm = document.createElement("input");
    nm.type = "text";
    nm.className = "c-name";
    nm.placeholder = rgbHex(c.r, c.g, c.b);
    nm.value = c.name || "";
    nm.addEventListener("input", function () {
      STATE.picked[i].name = nm.value;
    });

    row.appendChild(cb);
    row.appendChild(sw);
    row.appendChild(meta);
    row.appendChild(nm);
    box.appendChild(row);
  });
}

function syncRunBtn() {
  const n = STATE.picked.filter(function (c) { return c.checked; }).length;
  const btn = $("runBtn");
  btn.disabled = STATE.busy || n === 0;
  btn.textContent = n ? "② 生成图层（" + n + "）" : "② 生成图层";
}

function setBusy(v, msg) {
  STATE.busy = v;
  const analyze = $("analyzeBtn");
  const run = $("runBtn");
  const scan = $("scanBtn");
  analyze.disabled = v;
  scan.disabled = v;
  analyze.textContent = v && msg ? msg : "① 分析色块";
  if (v) {
    run.disabled = true;
  } else {
    syncRunBtn();
  }
}

/* ------------------------------------------------------------------ */
/* 初始化                                                              */
/* ------------------------------------------------------------------ */

function bindSlider(id, outId, fmt) {
  const el = $(id);
  const out = $(outId);
  const apply = function () {
    out.textContent = fmt(Number(el.value));
  };
  el.addEventListener("input", apply);
  el.addEventListener("change", apply);
  apply();
}

async function doScan() {
  if (STATE.busy) return;
  try {
    await refreshLayers(true);
    log("已重新扫描", "ok");
  } catch (e) {
    log(errMsg(e), "warn");
  }
}

(function init() {
  bindSlider("fuzz", "fuzzOut", function (v) { return String(v); });
  bindSlider("merge", "mergeOut", function (v) { return String(v); });
  bindSlider("shrink", "shrinkOut", function (v) {
    return v > 0 ? "+" + v : String(v);
  });
  bindSlider("minPct", "minOut", function (v) {
    return (v / 100).toFixed(2) + "%";
  });

  $("scanBtn").addEventListener("click", doScan);
  $("analyzeBtn").addEventListener("click", doAnalyze);
  $("runBtn").addEventListener("click", doGenerate);

  $("clownSel").addEventListener("change", function () {
    STATE.picked = [];
    renderColors();
    syncRunBtn();
  });

  (async function boot() {
    try {
      await refreshLayers(true);
      log("参数不用动，直接点「分析色块」。", "ok");
    } catch (e) {
      log(errMsg(e), "warn");
    }
  })();
})();
