/**
 * Clown Splitter - CEP 面板逻辑
 *
 * 分工：
 *   本文件：读像素（canvas）、聚类颜色、驱动 UI
 *   jsx：   所有 PS 操作
 *
 * 为什么绕这一圈：
 *   ExtendScript 没有读像素的 API（colorSamplers 逐点采样太慢），
 *   所以让 jsx 把图层用「最近邻」缩到 ~768px 存成临时 PNG，
 *   面板用 canvas 一次性拿 ImageData，几十万像素秒读。
 */

(function () {
  'use strict';

  /* ============================================================
     桥
     ============================================================ */

  var CEP = window.__adobe_cep__;

  function evalScript(code) {
    return new Promise(function (resolve, reject) {
      if (!CEP || !CEP.evalScript) {
        reject(new Error('CEP 运行时不可用。请从 PS 菜单「窗口 > 扩展」打开本面板。'));
        return;
      }
      CEP.evalScript(code, function (res) {
        if (typeof res !== 'string') {
          reject(new Error('引擎无返回'));
          return;
        }
        if (res.indexOf('EvalScript error') === 0 || res === 'EvalScript error.') {
          reject(new Error('脚本执行失败，检查 jsx 是否加载'));
          return;
        }
        if (res.indexOf('ERR:') === 0) {
          reject(new Error(res.slice(4)));
          return;
        }
        resolve(res);
      });
    });
  }

  function evalJSON(code) {
    return evalScript(code).then(function (s) {
      var o;
      try { o = JSON.parse(s); } catch (e) { throw new Error('返回数据解析失败: ' + s.slice(0, 80)); }
      if (!o.ok) throw new Error(o.msg || '未知错误');
      return o;
    });
  }

  // 字符串参数 -> JS 字面量。非 ASCII 转 \uXXXX，避免 evalScript 传中文时乱码
  function jsStr(s) {
    return JSON.stringify(String(s)).replace(/[\u0080-\uffff]/g, function (c) {
      var h = c.charCodeAt(0).toString(16);
      while (h.length < 4) h = '0' + h;
      return '\\u' + h;
    });
  }

  /* ============================================================
     引擎热重载
     CEP 的 ScriptPath 只在 PS 启动时加载一次，改 jsx 就得重启 PS。
     这里每次打开面板主动 $.evalFile 一遍，改完只需关掉面板重开。
     ============================================================ */

  function reloadEngine() {
    return new Promise(function (resolve) {
      var ext = '';
      try { ext = CEP.getSystemPath('extension'); } catch (e) { ext = ''; }
      if (!ext) { resolve(false); return; }
      var p = String(ext).replace(/^file:\/\/\//i, '').replace(/\//g, '\\');
      p = p.replace(/\\+$/, '');
      var jsx = p + '\\host\\jsx\\clownSplitter.jsx';
      evalScript('$.evalFile(new File(' + jsStr(jsx) + '))')
        .then(function () { resolve(true); })
        .catch(function () { resolve(false); });
    });
  }

  /* ============================================================
     状态 & DOM
     ============================================================ */

  var STATE = {
    docId: null,
    layers: [],
    picked: [],
    busy: false,
    docW: 0,
    docH: 0
  };

  var FRAG_RUN = 2.0;
  var FRAG_PCT = 1.5;

  function $(id) { return document.getElementById(id); }

  function log(msg, tone) {
    var box = $('log');
    var line = document.createElement('div');
    line.className = 'logline' + (tone ? ' ' + tone : '');
    line.textContent = msg;
    box.appendChild(line);
    while (box.childNodes.length > 500) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }

  function clearLog() { $('log').innerHTML = ''; }

  function h2(n) {
    n = Math.round(n);
    if (n < 0) n = 0;
    if (n > 255) n = 255;
    var s = n.toString(16).toUpperCase();
    return s.length === 1 ? '0' + s : s;
  }

  function rgbHex(r, g, b) { return '#' + h2(r) + h2(g) + h2(b); }

  function safeName(s) {
    return String(s).replace(/[\\\/:*?"<>|\r\n\t]/g, '_').slice(0, 190);
  }

  /* ============================================================
     图层
     ============================================================ */

  function fillSelect(sel, layers) {
    var keep = sel.value;
    sel.innerHTML = '';
    if (!layers.length) {
      var o = document.createElement('option');
      o.value = '';
      o.textContent = '（没有可用图层）';
      sel.appendChild(o);
      return;
    }
    for (var i = 0; i < layers.length; i++) {
      var l = layers[i];
      var op = document.createElement('option');
      op.value = String(l.id);
      op.textContent = l.path + (l.visible ? '' : '  [隐藏]');
      sel.appendChild(op);
    }
    if (keep) {
      for (var j = 0; j < sel.options.length; j++) {
        if (sel.options[j].value === keep) { sel.value = keep; return; }
      }
    }
  }

  function autoMatch(layers) {
    var clown = null, rgba = null, i;
    for (i = 0; i < layers.length; i++) {
      if (/clown/i.test(layers[i].name)) { clown = layers[i]; break; }
    }
    if (!clown) {
      for (i = 0; i < layers.length; i++) {
        if (/clown/i.test(layers[i].path)) { clown = layers[i]; break; }
      }
    }
    var pool = [];
    for (i = 0; i < layers.length; i++) {
      var l = layers[i];
      if (/clown/i.test(l.name)) continue;
      if (clown && l.id === clown.id) continue;
      pool.push(l);
    }
    var tries = [/^rgba$/i, /rgba/i, /beauty/i, /^rgb$/i, /render/i];
    for (var t = 0; t < tries.length && !rgba; t++) {
      for (i = 0; i < pool.length; i++) {
        if (tries[t].test(pool[i].name)) { rgba = pool[i]; break; }
      }
    }
    return { clown: clown, rgba: rgba };
  }

  function refreshLayers(verbose) {
    return evalJSON('CS.scanLayers()').then(function (info) {
      STATE.docW = info.docW || 0;
      STATE.docH = info.docH || 0;
      STATE.layers = info.layers || [];
      STATE.docId = info.docName;

      fillSelect($('clownSel'), STATE.layers);
      fillSelect($('rgbaSel'), STATE.layers);

      var m = autoMatch(STATE.layers);
      if (m.clown) $('clownSel').value = String(m.clown.id);
      if (m.rgba) $('rgbaSel').value = String(m.rgba.id);

      if (verbose) {
        log('文档：' + info.docName + '  ·  ' + STATE.docW + '×' + STATE.docH +
            '  ·  图层 ' + STATE.layers.length + ' 个');
        if (m.clown) log('clown → ' + m.clown.path + (m.clown.visible ? '' : '  (隐藏)'));
        else log('没找到名字含 clown 的图层，请手动选择', 'warn');
        if (m.rgba) log('rgba  → ' + m.rgba.path + (m.rgba.visible ? '' : '  (隐藏)'));
        else log('没找到名字含 rgba 的图层，请手动选择', 'warn');
      }
      return info;
    });
  }

  /* ============================================================
     读图：jsx 导出 PNG -> canvas -> ImageData
     ============================================================ */

  function canvasFromImage(img) {
    var cv = document.createElement('canvas');
    cv.width = img.width;
    cv.height = img.height;
    var ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0);
    var d = ctx.getImageData(0, 0, cv.width, cv.height);
    return { w: cv.width, h: cv.height, data: d.data };
  }

  function readViaBase64(path) {
    return new Promise(function (resolve, reject) {
      try {
        var enc = (window.cep && window.cep.encoding) ? window.cep.encoding.Base64 : 'Base64';
        var r = window.cep.fs.readFile(path, enc);
        if (r.err !== 0) { reject(new Error('读取临时图失败 err=' + r.err)); return; }
        var img = new Image();
        img.onload = function () {
          try { resolve(canvasFromImage(img)); } catch (e) { reject(e); }
        };
        img.onerror = function () { reject(new Error('临时图解码失败')); };
        img.src = 'data:image/png;base64,' + r.data;
      } catch (e) {
        reject(e);
      }
    });
  }

  function loadImageData(path) {
    return new Promise(function (resolve, reject) {
      var url = 'file:///' + encodeURI(String(path).replace(/\\/g, '/'));
      var img = new Image();
      img.onload = function () {
        try {
          resolve(canvasFromImage(img));
        } catch (e) {
          // file:// 之间的 canvas 污染，退回 base64
          readViaBase64(path).then(resolve, reject);
        }
      };
      img.onerror = function () {
        readViaBase64(path).then(resolve, reject);
      };
      img.src = url;
    });
  }

  /* ============================================================
     聚类
     ============================================================ */

  function edgeSamples(px) {
    var w = px.w, h = px.h, d = px.data, out = [];
    var N = 8;
    for (var i = 0; i <= N; i++) {
      var xx = Math.round((w - 1) * i / N);
      var yy = Math.round((h - 1) * i / N);
      var pts = [[xx, 0], [xx, h - 1], [0, yy], [w - 1, yy]];
      for (var k = 0; k < pts.length; k++) {
        var x = Math.max(0, Math.min(w - 1, pts[k][0]));
        var y = Math.max(0, Math.min(h - 1, pts[k][1]));
        var idx = (y * w + x) * 4;
        out.push([d[idx], d[idx + 1], d[idx + 2]]);
      }
    }
    return out;
  }

  // 判断 (x,y) 是不是色块内部（3x3 邻域同色）。
  // 魔棒要点在实心位置，点在抗锯齿边缘会选得残缺。
  // 缩略图上 3x3 约等于原图 7px，映射回去有 ±2px 误差也仍然安全。
  function isInterior(d, w, h, x, y, r, g, b) {
    if (x < 1 || y < 1 || x > w - 2 || y > h - 2) return false;
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        var i = ((y + dy) * w + (x + dx)) * 4;
        var dr = d[i] - r, dg = d[i + 1] - g, db = d[i + 2] - b;
        if (dr * dr + dg * dg + db * db > 400) return false;
      }
    }
    return true;
  }

  // 在簇的 bbox 内找一个实心点。
  // 不能在采样循环里找：扫描顺序遇到的第一个点永远在色块上边缘。
  function findInteriorPoint(d, w, h, r, g, b, minX, maxX, minY, maxY) {
    var x0 = Math.max(1, minX), x1 = Math.min(w - 2, maxX);
    var y0 = Math.max(1, minY), y1 = Math.min(h - 2, maxY);
    for (var y = y0; y <= y1; y++) {
      var row = y * w;
      for (var x = x0; x <= x1; x++) {
        var i = (row + x) * 4;
        var dr = d[i] - r, dg = d[i + 1] - g, db = d[i + 2] - b;
        if (dr * dr + dg * dg + db * db > 400) continue;
        if (isInterior(d, w, h, x, y, r, g, b)) return [x, y];
      }
    }
    return null;
  }

  function clusterColors(px, rgbaPx, merge, minPct) {
    var w = px.w, h = px.h, d = px.data;
    var bins = Object.create(null);
    var sampled = 0;
    var x, y, i, r, g, b, a, key, e;

    for (y = 0; y < h; y++) {
      var row = y * w;
      for (x = 0; x < w; x++) {
        i = (row + x) * 4;
        a = d[i + 3];
        if (a < 8) continue;
        r = d[i]; g = d[i + 1]; b = d[i + 2];
        key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
        e = bins[key];
        if (!e) {
          bins[key] = {
            n: 1, r: r, g: g, b: b, lastX: x, runs: 1, cur: 1, runMax: 1,
            fx: x, fy: y, gx: -1, gy: -1,
            minX: x, maxX: x, minY: y, maxY: y
          };
        } else {
          e.n++; e.r += r; e.g += g; e.b += b;
          if (e.lastX === x - 1) { e.cur++; } else { e.runs++; e.cur = 1; }
          if (e.cur > e.runMax) e.runMax = e.cur;
          e.lastX = x;
          if (x < e.minX) e.minX = x;
          if (x > e.maxX) e.maxX = x;
          if (y < e.minY) e.minY = y;
          if (y > e.maxY) e.maxY = y;
        }
        sampled++;
      }
    }

    var arr = [];
    for (var k in bins) {
      var bin = bins[k];
      bin.r = bin.r / bin.n;
      bin.g = bin.g / bin.n;
      bin.b = bin.b / bin.n;
      arr.push(bin);
    }
    arr.sort(function (p, q) { return q.n - p.n; });

    var m2 = merge * merge;
    var clusters = [];
    for (i = 0; i < arr.length; i++) {
      var cc = arr[i];
      var host = null;
      for (var j = 0; j < clusters.length; j++) {
        var cl = clusters[j];
        var dr = cc.r - cl.r, dg = cc.g - cl.g, db = cc.b - cl.b;
        if (dr * dr + dg * dg + db * db <= m2) { host = cl; break; }
      }
      if (host) {
        host.n += cc.n;
        host.runs += cc.runs;
        if (cc.runMax > host.runMax) host.runMax = cc.runMax;
        if (cc.minX < host.minX) host.minX = cc.minX;
        if (cc.maxX > host.maxX) host.maxX = cc.maxX;
        if (cc.minY < host.minY) host.minY = cc.minY;
        if (cc.maxY > host.maxY) host.maxY = cc.maxY;
      } else {
        clusters.push({
          r: cc.r, g: cc.g, b: cc.b,
          n: cc.n, runs: cc.runs, runMax: cc.runMax,
          fx: cc.fx, fy: cc.fy, gx: -1, gy: -1,
          minX: cc.minX, maxX: cc.maxX, minY: cc.minY, maxY: cc.maxY,
          seen: 0, dark: 0
        });
      }
    }

    // 第二遍：这个色块在 rgba 上到底有没有内容
    if (rgbaPx && rgbaPx.w === w && rgbaPx.h === h) {
      var ad = rgbaPx.data;
      for (y = 0; y < h; y++) {
        var row2 = y * w;
        for (x = 0; x < w; x++) {
          i = (row2 + x) * 4;
          r = d[i]; g = d[i + 1]; b = d[i + 2];
          var hit = -1, bestD = 1600;
          for (var m = 0; m < clusters.length; m++) {
            var c2 = clusters[m];
            var r2 = r - c2.r, g2 = g - c2.g, b2 = b - c2.b;
            var dd = r2 * r2 + g2 * g2 + b2 * b2;
            if (dd < bestD) { bestD = dd; hit = m; }
          }
          if (hit < 0) continue;
          clusters[hit].seen++;
          if (ad[i + 3] < 8) clusters[hit].dark++;
        }
      }
    }

    // 给每个簇找一个实心取样点（魔棒要用）
    for (i = 0; i < clusters.length; i++) {
      var ck = clusters[i];
      var pt = findInteriorPoint(d, w, h, ck.r, ck.g, ck.b,
                                 ck.minX, ck.maxX, ck.minY, ck.maxY);
      if (pt) { ck.gx = pt[0]; ck.gy = pt[1]; }
    }

    var edges = edgeSamples(px);
    var minCount = Math.max(6, sampled * (minPct / 100));
    var out = [];

    for (i = 0; i < clusters.length; i++) {
      var c = clusters[i];
      if (c.n < minCount) continue;

      var rr = Math.round(c.r), gg = Math.round(c.g), bb = Math.round(c.b);
      var isEdge = false;
      for (var q = 0; q < edges.length; q++) {
        var er = rr - edges[q][0], eg = gg - edges[q][1], eb = bb - edges[q][2];
        if (er * er + eg * eg + eb * eb < 400) { isEdge = true; break; }
      }

      var pct = (c.n / sampled) * 100;
      var avgRun = c.runs > 0 ? c.n / c.runs : c.n;
      var darkRatio = c.seen > 0 ? c.dark / c.seen : 0;

      out.push({
        r: rr, g: gg, b: bb,
        pct: pct,
        edge: isEdge,
        avgRun: avgRun,
        darkRatio: darkRatio,
        frag: avgRun < FRAG_RUN && pct < FRAG_PCT,
        empty: c.seen > 20 && darkRatio > 0.95 && pct < 5,
        gx: c.gx, gy: c.gy, fx: c.fx, fy: c.fy,
        near: 999
      });
    }

    out.sort(function (p, q) { return q.pct - p.pct; });
    recalcNear(out);
    return { colors: out, sampled: sampled, w: w, h: h };
  }

  function recalcNear(list) {
    var solid = [];
    for (var i = 0; i < list.length; i++) {
      if (!list[i].frag && !list[i].empty) solid.push(list[i]);
    }
    for (var a = 0; a < list.length; a++) {
      var best = Infinity;
      for (var b = 0; b < solid.length; b++) {
        if (solid[b] === list[a]) continue;
        var dr = list[a].r - solid[b].r;
        var dg = list[a].g - solid[b].g;
        var db = list[a].b - solid[b].b;
        var dd = Math.sqrt(dr * dr + dg * dg + db * db);
        if (dd < best) best = dd;
      }
      list[a].near = best === Infinity ? 999 : best;
    }
  }

  /* ============================================================
     设置
     ============================================================ */

  function currentSettings() {
    return {
      mode: $('modeSel').value,
      tolerance: Number($('fuzz').value),
      merge: Number($('merge').value),
      shift: Number($('shrink').value),
      minPct: Number($('minPct').value) / 100,
      contiguous: $('optContig').checked,
      antialias: $('optAA').checked,
      group: $('optGroup').checked,
      hideClown: $('optHideClown').checked
    };
  }

  /* ============================================================
     分析
     ============================================================ */

  function doAnalyze() {
    if (STATE.busy) return;
    var clownId = Number($('clownSel').value);
    if (!clownId) { log('先选择一个 clown 图层', 'err'); return; }

    var s = currentSettings();
    setBusy(true, '分析中…');
    clearLog();

    var clownPath = null;

    refreshLayers(false)
      .then(function (info) {
        // 扫描可能会自动改选中项，这里重新取一次
        clownId = Number($('clownSel').value) || clownId;
        if (!clownId) throw new Error('clown 图层无效，请重新扫描');

        if (!/rgb/i.test(info.mode)) throw new Error('文档不是 RGB 模式：' + info.mode);
        if (String(info.depth).indexOf('EIGHT') < 0 && String(info.depth).indexOf('8') < 0) {
          log('当前位深 ' + info.depth + '，Color Range 在 16/32 位下色值会偏', 'warn');
          log('建议先执行 图像 > 模式 > 8 位/通道', 'warn');
        }

        var maxSize = 768;
        var px = Math.max(info.docW || 0, info.docH || 0);
        if (px && px < maxSize) maxSize = px;

        log('导出 clown 缩略图（' + maxSize + 'px，最近邻）…');
        return evalScript('CS.exportPreview(' + clownId + ',' + maxSize + ',' + jsStr('clown') + ')');
      })
      .then(function (path) {
        clownPath = path;
        log('clown → ' + path);
        return loadImageData(path);
      })
      .then(function (clownPx) {
        var rgbaId = Number($('rgbaSel').value);
        if (!rgbaId || rgbaId === clownId) {
          log('没选 rgba，跳过空块检测', 'warn');
          return { clownPx: clownPx, rgbaPx: null };
        }
        var maxSize = Math.max(clownPx.w, clownPx.h);
        return evalScript('CS.exportPreview(' + rgbaId + ',' + maxSize + ',' + jsStr('rgba') + ')')
          .then(function (p2) {
            log('rgba  → ' + p2);
            return loadImageData(p2);
          })
          .then(function (rgbaPx) {
            return { clownPx: clownPx, rgbaPx: rgbaPx };
          })
          .catch(function (e) {
            log('rgba 导出失败，跳过空块检测：' + e.message, 'warn');
            return { clownPx: clownPx, rgbaPx: null };
          });
      })
      .then(function (pair) {
        var res = clusterColors(pair.clownPx, pair.rgbaPx, s.merge, s.minPct);

        // 魔棒要点在色块实心处：把缩略图坐标按比例映射回文档坐标
        var imgW = res.w || pair.clownPx.w;
        var imgH = res.h || pair.clownPx.h;
        var sx = STATE.docW ? STATE.docW / imgW : 1;
        var sy = STATE.docH ? STATE.docH / imgH : 1;

        STATE.picked = [];
        var noPoint = 0;
        for (var i = 0; i < res.colors.length; i++) {
          var c = res.colors[i];
          var onInterior = c.gx >= 0;
          var px0 = onInterior ? c.gx : c.fx;
          var py0 = onInterior ? c.gy : c.fy;
          if (!onInterior) noPoint++;

          STATE.picked.push({
            r: c.r, g: c.g, b: c.b,
            pct: c.pct, edge: c.edge, frag: c.frag, empty: c.empty,
            avgRun: c.avgRun, darkRatio: c.darkRatio, near: c.near,
            docX: Math.round(px0 * sx + sx / 2),
            docY: Math.round(py0 * sy + sy / 2),
            pointReliable: onInterior,
            checked: !c.edge && !c.frag && !c.empty,
            name: ''
          });
        }

        renderColors();

        var checked = 0;
        for (i = 0; i < STATE.picked.length; i++) if (STATE.picked[i].checked) checked++;
        var skipped = STATE.picked.length - checked;

        log('采样 ' + res.sampled + ' 点，检出 ' + STATE.picked.length + ' 个色块');
        log('自动勾选 ' + checked + ' 个；跳过 ' + skipped + ' 个（背景 / 过渡带 / 空块）',
            checked ? 'ok' : 'warn');
        if (noPoint) {
          log('有 ' + noPoint + ' 个色块没找到实心取样点，魔棒可能选得不完整', 'warn');
        }

        var risky = 0;
        for (i = 0; i < STATE.picked.length; i++) {
          var cc = STATE.picked[i];
          if (!cc.frag && !cc.edge && !cc.empty && cc.near < 30) risky++;
        }
        if (risky) log('有 ' + risky + ' 个色块和邻居距离 < 30，容差别调太高', 'warn');

        syncRunBtn();
      })
      .catch(function (e) {
        log('分析失败：' + e.message, 'err');
      })
      .then(function () {
        setBusy(false);
      });
  }

  /* ============================================================
     生成
     ============================================================ */

  function doGenerate() {
    if (STATE.busy) return;

    var chosen = [];
    for (var i = 0; i < STATE.picked.length; i++) {
      if (STATE.picked[i].checked) chosen.push(STATE.picked[i]);
    }
    if (!chosen.length) { log('没有勾选任何色块', 'err'); return; }

    var clownId = Number($('clownSel').value);
    var rgbaId = Number($('rgbaSel').value);
    if (!clownId || !rgbaId) { log('clown 和 rgba 图层都要选', 'err'); return; }
    if (clownId === rgbaId) { log('clown 和 rgba 不能是同一层', 'err'); return; }

    var s = currentSettings();
    // 面积小的先做，最后归档的在组内最上面 => 组内自上而下按面积从大到小
    chosen.sort(function (a, b) { return a.pct - b.pct; });

    setBusy(true, '生成中…');
    clearLog();

    var groupId = -1;
    var clownWasVisible = true;
    var rgbaWasVisible = true;
    var ok = 0, fail = 0;

    evalScript('CS.beginSplit(' + clownId + ',' + rgbaId + ',' + jsStr('Clown Split') + ',' + (s.group ? 'true' : 'false') + ')')
      .then(function (s1) {
        var b = JSON.parse(s1);
        if (!b.ok) throw new Error(b.msg);
        groupId = b.groupId;
        clownWasVisible = b.clownWasVisible !== false;
        rgbaWasVisible = b.rgbaWasVisible !== false;
        log('分组：' + (groupId > 0 ? 'Clown Split  (#' + groupId + ')' : '不分组'));

        // 串行跑，进度能实时刷
        var chain = Promise.resolve();
        chosen.forEach(function (c, idx) {
          chain = chain.then(function () {
            var cfg = {
              clownId: clownId,
              rgbaId: rgbaId,
              groupId: groupId,
              mode: s.mode,
              x: c.docX,
              y: c.docY,
              tolerance: s.tolerance,
              contiguous: s.contiguous,
              antialias: s.antialias,
              r: c.r, g: c.g, b: c.b,
              name: c.name || '',
              near: c.near,
              shift: s.shift
            };
            return evalScript('CS.splitOne(' + jsStr(JSON.stringify(cfg)) + ')').then(function (s2) {
              var r = JSON.parse(s2);
              var label = c.name || rgbHex(c.r, c.g, c.b);
              if (r.ok) {
                ok++;
                log('(' + (idx + 1) + '/' + chosen.length + ') ' + r.name +
                    '  ' + (r.mode === 'wand' ? '魔棒' : '色彩范围') + ' ' + r.tol +
                    '  选区 ' + r.selW + '×' + r.selH, 'ok');
              } else {
                fail++;
                log('(' + (idx + 1) + '/' + chosen.length + ') ' + label + ' 失败：' + r.msg, 'err');
              }
            });
          });
        });
        return chain;
      })
      .then(function () {
        return evalScript('CS.endSplit(' + clownId + ',' + rgbaId + ',' +
          (s.hideClown ? 1 : 0) + ',' + (clownWasVisible ? 1 : 0) + ',' + (rgbaWasVisible ? 1 : 0) + ')');
      })
      .then(function () {
        log('完成：成功 ' + ok + ' 层，失败 ' + fail + ' 层', ok ? 'ok' : 'warn');
      })
      .catch(function (e) {
        log('执行中断：' + e.message, 'err');
      })
      .then(function () {
        setBusy(false);
        refreshLayers(false).catch(function () {});
      });
  }

  /* ============================================================
     列表
     ============================================================ */

  function renderColors() {
    var box = $('colorList');
    box.innerHTML = '';

    if (!STATE.picked.length) {
      var d = document.createElement('div');
      d.className = 'empty';
      d.textContent = '没检出有效色块。调低「最小面积」或调大「合并近色」再试。';
      box.appendChild(d);
      return;
    }

    STATE.picked.forEach(function (c, i) {
      var row = document.createElement('div');
      row.className = 'crow';

      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'c-chk';
      cb.checked = c.checked;
      cb.addEventListener('change', function () {
        STATE.picked[i].checked = cb.checked;
        syncRunBtn();
      });

      var sw = document.createElement('div');
      sw.className = 'c-sw';
      sw.style.backgroundColor = 'rgb(' + c.r + ',' + c.g + ',' + c.b + ')';

      var meta = document.createElement('div');
      meta.className = 'c-meta';

      var m1 = document.createElement('div');
      m1.className = 'm1';
      m1.textContent = rgbHex(c.r, c.g, c.b) + '   ' + c.pct.toFixed(2) + '%';

      var m2 = document.createElement('div');
      m2.className = 'm2';
      var tags = [];
      if (c.empty) tags.push({ cls: 'tag', text: '空块' });
      if (c.edge) tags.push({ cls: 'tag', text: '背景' });
      if (c.frag) tags.push({ cls: 'tag', text: '过渡带' });
      if (!c.frag && !c.edge && !c.empty) {
        if (c.near < 30) tags.push({ cls: 'tag bad', text: '近色 ' + Math.round(c.near) });
        else tags.push({ cls: 'tag dim', text: '邻距 ' + Math.round(c.near) });
      }
      tags.forEach(function (t) {
        var sp = document.createElement('span');
        sp.className = t.cls;
        sp.textContent = t.text;
        m2.appendChild(sp);
      });

      meta.appendChild(m1);
      meta.appendChild(m2);

      var nm = document.createElement('input');
      nm.type = 'text';
      nm.className = 'c-name';
      nm.placeholder = rgbHex(c.r, c.g, c.b);
      nm.value = c.name || '';
      nm.addEventListener('input', function () {
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
    var n = 0;
    for (var i = 0; i < STATE.picked.length; i++) if (STATE.picked[i].checked) n++;
    var btn = $('runBtn');
    btn.disabled = STATE.busy || n === 0;
    btn.textContent = n ? '② 生成图层（' + n + '）' : '② 生成图层';
  }

  function setBusy(v, msg) {
    STATE.busy = v;
    var analyze = $('analyzeBtn');
    analyze.disabled = v;
    $('scanBtn').disabled = v;
    analyze.textContent = (v && msg) ? msg : '① 分析色块';
    if (v) $('runBtn').disabled = true;
    else syncRunBtn();
  }

  /* ============================================================
     初始化
     ============================================================ */

  function bindSlider(id, outId, fmt) {
    var el = $(id);
    var out = $(outId);
    function apply() { out.textContent = fmt(Number(el.value)); }
    el.addEventListener('input', apply);
    el.addEventListener('change', apply);
    apply();
  }

  function doScan() {
    if (STATE.busy) return;
    refreshLayers(true).then(function () {
      log('已重新扫描', 'ok');
    }).catch(function (e) {
      log(e.message, 'warn');
    });
  }

  bindSlider('fuzz', 'fuzzOut', function (v) { return String(v); });
  bindSlider('merge', 'mergeOut', function (v) { return String(v); });
  bindSlider('shrink', 'shrinkOut', function (v) { return v > 0 ? '+' + v : String(v); });
  bindSlider('minPct', 'minOut', function (v) { return (v / 100).toFixed(2) + '%'; });

  $('scanBtn').addEventListener('click', doScan);
  $('analyzeBtn').addEventListener('click', doAnalyze);
  $('runBtn').addEventListener('click', doGenerate);

  $('clownSel').addEventListener('change', function () {
    STATE.picked = [];
    renderColors();
    syncRunBtn();
  });

  reloadEngine()
    .then(function (hot) {
      if (hot) log('引擎已热重载（用的是磁盘上最新的 jsx）');
      return evalJSON('CS.ping()');
    })
    .then(function (r) {
      log('引擎就绪  v' + r.version + '  ·  PS ' + r.ps);
      return refreshLayers(true);
    })
    .then(function () {
      log('参数不用动，直接点「分析色块」。', 'ok');
    })
    .catch(function (e) {
      log('初始化失败：' + e.message, 'err');
      log('确认扩展已装到 CEP\\extensions 下，且 PS 已重启过。', 'warn');
    });

})();
