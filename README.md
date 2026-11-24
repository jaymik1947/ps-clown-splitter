# PS Clown Splitter

把 KeyShot 渲染的分层 PSD，按 clown pass 的色块自动拆成「每个材质一个图层」。

KeyShot 在渲染输出里勾选 **Clown pass** + **Add to PSD**，会得到这样的结构：

```
Render Passes
  ├ clown      每个材质一个纯色
  ├ normals
  ├ diffuse
  ├ reflection
  ├ ...
  └ rgba       带 alpha 的成品图
```

这个面板读 `clown` 的颜色区块，逐个在 `rgba` 上建选区、抠图，输出一个 `Clown Split` 组，每个材质一层。

## 两个版本

| 目录 | 形态 | 状态 |
|---|---|---|
| `ps-clown-splitter-cep/` | CEP 面板（HTML + ExtendScript） | **主线**，支持魔棒取样 |
| `ps-clown-splitter/` | UXP 面板（PS 2023+） | 保留，取样仅支持色彩范围 |

## 安装（CEP 版）

1. 把 `ps-clown-splitter-cep` 整个目录放到
   `%APPDATA%\Adobe\CEP\extensions\com.clownsplit.cep`
   或者直接双击目录里的 `install.bat`
2. **完全退出** Photoshop 再打开（CEP 扩展只在启动时扫描）
3. 菜单 **窗口 > 扩展 > Clown 分层**

未签名扩展需要开调试模式，`install.bat` 会自动设置：

```
HKCU\Software\Adobe\CSXS.9  ~  CSXS.14   PlayerDebugMode = 1  (REG_SZ)
```

## 使用

1. 打开 KeyShot 输出的分层 PSD
2. 面板会自动匹配 `clown` 和 `rgba`（不对就手动选）
3. 点 **① 分析色块** —— 列出检出的颜色，背景 / 过渡带 / 空块默认不勾选
4. 需要的话改图层名、调容差
5. 点 **② 生成图层**

日志会逐色打印实际选区尺寸，可以据此判断取样是否正常：

```
(1/4) #FF0000  魔棒 32  选区 523×1488
(2/4) #FF0087  魔棒 32  选区 589×1522
```

## 参数

| 参数 | 说明 |
|---|---|
| 取样 | 魔棒（推荐）/ 色彩范围 |
| 容差 | 魔棒 0–120。clown 是纯色，10–20 通常够；边缘有渐变再往上调 |
| 连续 | 默认**关**。同一材质在画面上分成几块时必须关，否则只会选到点中的那一块 |
| 抗锯齿 | 默认开 |
| 合并近色 | 聚类时把色距小于该值的量化档合并；色块被拆成几块时调大 |
| 边缘偏移 | 选区扩展 / 收缩 −3 ~ +3 px |
| 最小面积 | 小于该占比的色块不列出 |

## 实现要点

### 为什么要在 PS 外面算颜色

ExtendScript 没有读像素的 API——`colorSamplers` 逐点采样，几十万点要跑几分钟。
所以流程是：引擎把图层用**最近邻**缩到 ≤768px 存成临时 PNG，面板用 canvas 一次读 `ImageData`，在 Chromium 里跑聚类。

`ResampleMethod.NEARESTNEIGHBOR` 必须开。双线性插值会在色块边缘造出一堆假颜色，聚类直接崩。

### 魔棒的取样点怎么定

魔棒要点在坐标上，色彩范围只需要颜色值。所以分析时对每个色块：

1. 记录色块的 bbox
2. 聚类完成后在 bbox 内找 **3×3 邻域同色**的实心点
3. 按 `文档尺寸 / 缩略图尺寸` 映射回文档坐标

不能在采样循环里顺便找：扫描顺序遇到的第一个命中点永远在色块**上边缘**，连 20% 面积的大色块都会因此找不到实心点。

### 真实 KeyShot PSD 上踩过的坑

- `clown` 和 `rgba` **默认是隐藏的**，取样前必须打开，否则取不到颜色
- clown 的背景是纯黑，它占的像素数与 rgba 的透明区**完全一致**（实测 76.323% vs 76.323%），所以抠出来的边缘天然对齐，不需要羽化
- clown 里混着大量边缘过渡色（1920×1920 的图能有 1800+ 个唯一色），得靠「面积 + 平均连续段长度」把真实材质块筛出来，光看面积会被骗

## 验证工具

`tools/` 下是纯 Python 的离线验证脚本，不需要 Photoshop，全部只用标准库：

```bash
python tools/parse_psd.py     test.psd        # 打印 PSD 图层树（手写解析，无依赖）
python tools/dump_clown.py    test.psd clown  # 解码某层 RLE 像素，输出颜色直方图
python tools/sim_cluster.py   test.psd        # 复现面板的聚类与选区模拟
python tools/sim_wand.py      test.psd        # 验证魔棒取样点的映射精度
python tools/preview_split.py test.psd out.png  # 生成抠图结果 contact sheet
```

`sim_wand.py` 会直接告诉你每个色块的取样点映射回原图后色差是多少，为 0 才算对。

## 自检

面板加载不起来时，在 PS 里 **文件 > 脚本 > 浏览** 选
`host/jsx/_selftest.jsx`，它会逐项验 `documents.add` 参数、stringID 可用性、
缩略图导出、色彩范围、魔棒、通过拷贝的图层。不改原文档像素，图层和选区都会还原。

## 限制

- 文档必须是 **8-bit RGB**
- CEP 扩展只在 PS 启动时注册，首次安装必须重启 PS
- 改 jsx 不用重启：面板启动时会 `$.evalFile` 热重载

## License

MIT
