# HTML Liquid Glass

在**普通网页**上做 iOS 风格的液态玻璃：边缘一圈折射 + 色散，中间是带磨砂 / 变暗滤镜的实时页面。
一个文件、零依赖、不需要构建，给元素加一个属性就行。玻璃可以随意拖动，背景就是真实的 DOM。

```html
<script src="liquid-glass.js"></script>

<nav data-liquid-glass="regular">…</nav>
<button data-liquid-glass="dark; button: true">播放</button>
```

在线演示：用任意静态服务器打开 `demo/index.html`（见下文「运行演示」）。

---

## 特性

- **真实 DOM 背景**：玻璃下方就是页面本身，可以拖动、滚动，背景内容随时变化。
- **只有边缘折射**：和 iOS 一样，折射只发生在边缘一圈（`bezel`，默认短边的 6%，可以调到 0），中间是普通的滤镜视图。
- **变暗比例 `dim`**：玻璃自带一层压暗滤镜，浅色背景上的白色文字也能看清。
- **六个预设**：`clear` / `regular` / `frosted` / `dark` / `lens`（放大镜）/ `auto`（跟随系统深浅色）。
- **挖空**：快照拍不到的区域（iframe、视频、跨域图片、无限循环的 CSS 动画）会被挖空。玻璃经过时直接显示实时内容，边缘不折射、只保留玻璃高光，看起来不违和。
- **融合**：同一层、同一种材质的玻璃靠近时会像液体一样逐渐连在一起；叠在一起时共用一块背板，重叠处没有内边缘。
- **按钮 / 拖动**：`button: true` 带悬停提亮和按下回弹，`draggable: true` 可以直接拖动。
- **自适应亮度**：`adaptive: true` 时 `glass.luminance` 实时给出玻璃下方页面的亮度，可以据此切换文字颜色。
- **省电**：只在内容真正变化时才重新截图和重绘。拖动、滚动只移动采样位置，零截图。

## 快速开始

### 方式一：HTML 声明

```html
<script src="liquid-glass.js"></script>

<!-- 默认预设 clear -->
<div data-liquid-glass>…</div>

<!-- 预设名 -->
<div data-liquid-glass="regular">…</div>

<!-- 预设 + 参数，用分号分隔 -->
<div data-liquid-glass="dark; dim: 0.5; bezel: 0.08; draggable: true">…</div>

<!-- 也可以写 JSON -->
<div data-liquid-glass='{"preset":"frosted","pointer":true}'>…</div>
```

之后动态插入的带 `data-liquid-glass` 的元素会自动生效；元素被移除时自动释放；修改属性值会实时更新。

形状取元素自己的 `border-radius`。想给玻璃加颜色，直接给元素写半透明的 CSS `background`。

### 方式二：JS

```js
const glass = LiquidGlass.create(document.querySelector('#panel'), {
  preset: 'regular',
  dim: 0.15,
  draggable: true,
});

glass.set({ dim: 0.3, bezel: 0.1 }); // 随时改参数
glass.destroy();                      // 还原元素
```

### 一个最小的圆形按钮

```html
<style>
  .orb { position: fixed; left: 40px; top: 40px; width: 96px; height: 96px;
         border-radius: 50%; border: 0; color: #fff; font: 600 15px system-ui; }
</style>
<button class="orb" data-liquid-glass="regular; bezel: 0.08; button: true; draggable: true">▶</button>
```

## 预设

| 预设 | 说明 |
|---|---|
| `clear` | 默认。几乎透明，轻微提亮和饱和 |
| `regular` | iOS 常规材质：中等磨砂、饱和度更高 |
| `frosted` | 重磨砂，适合大面板 |
| `dark` | 暗色材质：`dim: 0.35`，浅色页面上放白字 |
| `lens` | 放大镜：整块都是曲面（`bezel: 1`），折射更强 |
| `auto` | 系统深色模式下用 `dark`，否则用 `regular`，切换系统主题时会实时跟随 |

预设只是参数的起点，写在后面的参数会覆盖它。

## 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `preset` | `'clear'` | 见上表 |
| `dim` | `0` | 变暗比例，0..1。玻璃自身带一层压暗滤镜 |
| `bezel` | `0.06` | 折射带宽度，占短边一半的比例。0 为纯毛玻璃，1 为整块透镜 |
| `refract` | `0.45` | 玻璃厚度，越大折射越强 |
| `curve` | `2.6` | 边缘曲率：2 为圆弧，4 接近超椭圆 |
| `disp` | `0.12` | 色散（彩边） |
| `frost` | `1` | 磨砂模糊半径，CSS px |
| `sat` | `1.16` | 饱和度 |
| `tint` | `0.018` | 提亮 |
| `spec` | `1` | 高光强度 |
| `shadow` | `0.3` | 投影强度 |
| `ior` | `1.5` | 折射率 |
| `pointer` | `false` | 指针下方跟随一团柔光 |
| `button` | `false` | 按钮手感：悬停提亮，按下微缩，阴影加深 |
| `draggable` | `false` | 可以直接拖动（用 CSS `translate`，不动你的 `transform`；拖动后不会误触发 click） |
| `merge` | `true` | 允许和其他玻璃融合 |
| `blend` | `24` | 开始融合的距离，px |
| `adaptive` | `false` | 维护 `glass.luminance`（玻璃下方页面的平均亮度，线性 0..1） |
| `mask` | `null` | `(ctx, w, h) => void`，用白色画出玻璃里的图形，配合 `contrast` 使用 |
| `contrast` | `'off'` | `'halo'`：在 `mask` 画出的图形周围按背景亮度补一圈暗边 |

用 `adaptive` 切换文字颜色的例子：

```js
const g = LiquidGlass.create(el, { preset: 'clear', adaptive: true });
(function loop() {
  if (g.luminance != null) el.classList.toggle('on-light', g.luminance > 0.45);
  requestAnimationFrame(loop);
})();
```

## 全局设置

放在页面脚本最前面（可选）：

```js
LiquidGlass.config({
  engine: 'auto',          // 'auto' | 'native' | 'snapshot' | 'css'
  captureScale: 0.5,       // 快照分辨率（相对 CSS px），0.25 更省，1 更清晰
  minCaptureInterval: 250, // 两次截图的最小间隔，ms
  capturer: 'fast',        // 'fast'（内置）| 'modern-screenshot'（需要先加载 modern-screenshot）
  liveFps: 30,             // [data-lg-live] 元素的刷新帧率
  auto: true,              // 是否自动接管 [data-liquid-glass]
});
```

其他 API：

```js
LiquidGlass.get(el)        // 元素上的玻璃实例，没有则为 null
LiquidGlass.refresh()      // 立即重新截图（改了 canvas 像素等观察不到的变化时用）
LiquidGlass.destroyAll()
LiquidGlass.engine         // 当前引擎
LiquidGlass.supports       // { native, snapshot, css }
LiquidGlass.stats          // 截图次数、耗时等
LiquidGlass.presets / LiquidGlass.defaults
```

## 页面标记

| 属性 | 作用 |
|---|---|
| `data-lg-ignore` | 不进快照。用于你自己的浮层、控制面板等 `position: fixed` 的东西 |
| `data-lg-live` | 放在 `canvas` / `video` 上：快照引擎下每帧直接把它的像素写进纹理，不需要重新截图 |
| `data-lg-hole` | 在快照里挖空：玻璃经过这里时显示实时页面，边缘只有高光不折射 |

**可滚动的面板**：把 `data-liquid-glass` 放在外层，滚动放在内层（玻璃的画布是元素的子节点）。

## 工作原理

浏览器不允许 JS 读取已经渲染好的页面像素，所以有两条路：

### native 引擎（Chromium，自动选择）

`backdrop-filter: url(#svg-filter)`：根据光学模型（斯涅尔折射 + 超椭圆边缘高度场）在 CPU 上生成一张位移图，交给 `feDisplacementMap`，RGB 三个通道用不同的位移量实现色散。
**浏览器自己实时折射页面**，所以 iframe、视频、动画都是真的，不需要截图，性能最好。

### snapshot 引擎（Safari / Firefox）

1. 把页面 DOM 克隆一份，通过 SVG `foreignObject` 画进一张低分辨率 canvas（默认 0.5×），上传为 WebGL2 纹理。
2. 只有**边缘折射带**由 WebGL shader 从快照里采样、折射、色散；**中间大部分区域**仍然用 CSS `backdrop-filter` 显示实时页面。快照有一点延迟也看不出来。
3. 快照拍不到的区域会被**挖空**（透明）。shader 在挖空的地方不折射，改画一圈玻璃拟态高光。
4. 拖动、滚动只改变采样位置，不重新截图。只有 DOM 变化、表单输入、图片加载、字体加载、尺寸变化时才重拍。重拍会节流：间隔 ≥ 250ms，且 ≥ 上次截图耗时的 4 倍，放在 `requestIdleCallback` 里执行。
5. 所有玻璃共用一个 WebGL2 上下文。每块玻璃只在参数、位置或快照真正变化时才重绘。

### css 引擎（兜底）

只有 CSS 毛玻璃 + 高光，没有折射。

### 融合

每帧测量所有玻璃。满足**同一层**（定位方式和 `z-index` 相同）、**同一种材质**（`frost / sat / tint / dim` 相同）、双方都开着 `merge`、距离小于 `blend` 这几个条件时，它们会组成一组：

- shader 用多项式 smooth-min 把几个圆角矩形的距离场并成一个形状。靠近时出现液体桥，重叠时共用一块背板，重叠处没有内边缘。
- 每个像素只由一块玻璃负责绘制：自己内部归自己，重叠区归绘制顺序最靠下的那块，盒子外的桥归最近的那块。这样叠在一起也不会画两遍。
- 融合期间整块形状都从快照绘制，以保证接缝处完全一致。所以 Chromium 下一旦发生融合，也会启动截图。
- 不满足条件的玻璃互相叠在一起时，上面那块会把下面那块当作挖空区，不会重复折射。

## 运行演示

```bash
npx http-server .   # 或 python3 -m http.server
# 打开 http://localhost:8080/demo/
```

演示页包含：可拖动的圆形进度按钮（带弹簧形变）、每种预设的面板生成器、引擎 / 截图器 / 分辨率切换，以及 iframe 挖空、`data-lg-live` canvas、融合等示例。

## 限制

- 浏览器不暴露页面像素，snapshot 引擎看到的是**快照**，不是实时画面：边缘折射会比真实内容慢一拍；融合期间中间区域也来自快照。
- 快照拍不到 iframe、跨域图片、`<video>`（除非标了 `data-lg-live`）、无限循环的 CSS 动画。这些区域会自动挖空，只是没有折射。
- 跨域图片需要 `crossorigin="anonymous"` 才能进快照；网页字体默认不内嵌（`embedFonts: false`），快照里可能退回系统字体。由于只用于边缘折射，通常看不出来。
- 融合和折射几何不考虑元素的旋转和缩放（`translate` 没问题）。
- 玻璃的投影会超出元素边界，祖先元素上的 `overflow: hidden` 会把它裁掉。
- 尚未在真实的 Safari / iOS 设备上完整测试，欢迎反馈。

## 浏览器支持

| 浏览器 | 引擎 |
|---|---|
| Chrome / Edge / 其他 Chromium | `native`（实时折射） |
| Safari / Firefox | `snapshot`（WebGL2 + 快照） |
| 不支持 WebGL2 的环境 | `css` |

WebGL 上下文丢失后会自动恢复。

## 致谢

参考了 [ybouane/liquidglass](https://github.com/ybouane/liquidglass) 的若干设计：

- `button`（悬停 / 按下手感）、`floating` → 这里的 `draggable`；
- `bevelMode`（穹顶放大镜）→ 这里的 `lens` 预设；
- `img` / `canvas` / `video` 直接 `drawImage` 进快照，而不是走 DOM 序列化；
- WebGL 上下文丢失后自动恢复。

和它的区别：不要求玻璃是某个 root 的直接子元素，任意元素都能变成玻璃；所有玻璃共用一个 WebGL 上下文；Chromium 下走原生实时折射；中间区域保持实时页面而不是整块从快照渲染；快照拍不到的区域会挖空而不是显示错误内容；同层玻璃会融合。
