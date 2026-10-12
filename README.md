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
- **融合**：同一层、同一种材质的玻璃靠近时会像液体一样逐渐连在一起；叠在一起时重叠处没有内边缘。融合直接过滤实时页面，不截图，玻璃后面的画面也不会因为融合而改变。
- **按钮 / 拖动**：`button: true` 带悬停提亮和按下回弹，`draggable: true` 可以直接拖动。
- **自适应亮度**：`adaptive: true` 时 `glass.luminance` 实时给出玻璃下方页面的亮度，可以据此切换文字颜色。
- **省电**：只在内容真正变化时才重新截图和重绘。拖动、滚动只移动采样位置，零截图。
- **跟手**：每帧的测量和绘制排在页面自己的 `requestAnimationFrame` 回调之后，页面在动画循环里移动的玻璃当帧就画在新位置，不会慢一帧（为此 SDK 包装了 `window.requestAnimationFrame`，只调整回调顺序，行为不变）。拖动中指针柔光固定在手指下，玻璃不需要每帧重画。

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
LiquidGlass.stats          // 截图次数、耗时、融合背板、动画帧间隔（rafMs）等
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

融合背板的形状（哪里有玻璃）放在一张只用 alpha 通道的图里。Chrome 会把滤镜里的图片转换到显示器的色彩空间，在广色域屏幕（比如 Mac 的 Display P3）上彩色像素的三个通道会互相掺杂：以前形状放在位移图的蓝色通道里，表示“这里没有玻璃”的像素转换后带上约 15% 的覆盖，把整块背板矩形压暗一层。alpha 通道不参与色彩转换。

### snapshot 引擎（Safari / Firefox）

1. 把页面 DOM 克隆一份，通过 SVG `foreignObject` 画进一张低分辨率 canvas（默认 0.5×），上传为 WebGL2 纹理。快照从根元素（`<html>`）的左上角算起；`<body>` 换成一个 div 时会带上它在页面里实际的外边距（包括浏览器默认的 8px），所以快照里的排版和页面一致，采样位置不会错开。
2. 只有**边缘折射带**由 WebGL shader 从快照里采样、折射、色散；**中间大部分区域**仍然用 CSS `backdrop-filter` 显示实时页面。快照有一点延迟也看不出来。
3. 快照拍不到的区域会被**挖空**（透明）。shader 在挖空的地方不折射，改画一圈玻璃拟态高光。
4. 拖动、滚动只改变采样位置，不重新截图。只有 DOM 变化、表单输入、图片加载、字体加载、视口宽度变化时才重拍（只有高度变了，比如 iOS 地址栏收起，不重拍）。重拍会节流：间隔 ≥ 250ms，且 ≥ 上次截图耗时的 4 倍，放在 `requestIdleCallback` 里执行。截图会占住主线程一段时间，所以页面在滚动时等滚动停下再拍（最多等 10 秒；快照是按页面坐标存的，滚动不会让它过期），截到一半页面开始滚动的话，最费时的绘制那一步也等滚动停下；按着指针或页面里某个元素在滚动时最多等 1.5 秒。
5. 玻璃边缘是 JS 按 `scrollY` 画的。新版 iOS Safari 的地址栏跟着手指收起、展开的过程中（向上滚动时最明显），WebKit 为了省电只每 100 毫秒把新的滚动位置告诉页面一次（`WKWebView _updateVisibleContentRects`）：页面本身照样顺滑地滚，JS 却每秒只拿到 10 次位置，边缘看起来就卡住不动。页面里有在主线程上跑的滚动驱动动画时，WebKit 会照常每帧都告诉页面（`hasMainThreadScrollDrivenAnimations`）。所以 snapshot 引擎在 WebKit 里会放一个看不见的 1px 元素，用 `ScrollTimeline` 让它的一个自定义属性跟着页面滚动变化（自定义属性的动画不会被交给合成线程）。不支持滚动驱动动画的浏览器里没有这个元素。演示的参数面板里“滚动位置”一行会显示它是否开启，以及上一次滚动时页面每秒拿到几次新位置。
6. 所有玻璃共用一个 WebGL2 上下文。每块玻璃只在参数、在页面上的位置或快照真正变化时才重绘：跟着页面一起滚的玻璃滚动时不重绘（除非有固定的玻璃压在它上面移动），固定在屏幕上的玻璃滚动时每帧重绘。

### css 引擎（兜底）

只有 CSS 毛玻璃 + 高光，没有折射。

### 融合

每帧测量所有玻璃。满足下面这些条件时，它们会组成一组：

- **同一层**：同一个父元素下的兄弟元素，定位方式和 `z-index` 相同；
- **同一种材质**：`frost / sat / tint / dim / disp` 相同，双方都开着 `merge`，距离小于 `blend`；
- **正常显示**：可见、不透明（`opacity` 为 1），只有平移和等比缩放（旋转、不等比缩放的玻璃不融合）；
- 最下面那块玻璃没有裁剪自己的溢出（`overflow` 为 `visible`），而且这几块玻璃之间（按绘制顺序）没有同一层的其他元素压在它们的范围里，否则那个元素会在上面的玻璃里不经模糊地露出来。

- 形状：用多项式 smooth-min 把几个圆角矩形的距离场并成一个形状。靠近时出现液体桥，重叠处没有内边缘。
- **共用背板（native 引擎）**：SDK 在最下面那块玻璃里面（紧跟在它的画布后面，`z-index: -2`）放一个元素，由它显示整个融合形状下面的页面。它和玻璃一起被裁剪、滚动和变换，也不会插进页面自己的元素之间（不影响 `:first-child`、`+` 这类选择器）。玻璃元素自己的 backdrop-filter 在融合期间关掉，所以上面的玻璃不会把下面的玻璃再过滤一遍；放背板的那块玻璃的 CSS 背景色这时由它的画布来画（融合结束后原样恢复），免得被背板再过滤一次。
  - 背板是一个 SVG 背景滤镜，位移图按融合后的轮廓用同一套光学模型生成，浏览器实时折射页面。轮廓由滤镜自己裁出来，不靠 clip-path。
- **snapshot 引擎没有背板**：backdrop-filter 只有用 border-radius 裁形状时各浏览器都可靠。WebKit 把 clip-path 做成背景层父层上的遮罩，iOS 上会有一层很淡的滤镜漏到整个矩形；Chrome 干脆不按 clip-path 裁背景滤镜。所以快照引擎融合时不用背板：
  - 磨砂小于 2px、玻璃之间没有真正叠在一起：每块玻璃保留自己的圆角 backdrop-filter（实时页面），只去掉其中的压暗；压暗改由画布按融合后的形状每个像素只画一次。两块之间的连接桥下面没有元素，那里的页面由画布从快照画出来。
  - 磨砂小于 2px、有两块叠在一起：两层 backdrop-filter 会把重叠处的饱和度（和模糊）叠加一次，在下面那块的边上留一条线。所以这时整组玻璃的 backdrop-filter 关掉，只由画布画压暗：重叠处没有线，代价是叠在一起期间少了那一点饱和度提升（默认 1.16）和不到 2px 的模糊。
  - 磨砂 2px 及以上：叠在一起的两层模糊会把重叠处糊两遍，还会露出下面那块的边缘，所以这时玻璃自己的 backdrop-filter 关掉，整个融合形状由画布从快照画出来（按磨砂模糊过，快照的低分辨率看不出来），每个像素只画一次，和 native 引擎一样没有内边缘。
  - 画布之间按每个像素“谁负责”分工，交界处是 2px 的柔和过渡；下面那块在上面那块接手的地方把不透明的部分画满，免得两张画布叠起来时漏出一条缝。
- 每块玻璃的画布只比它自己大一圈投影的宽度，融合后的投影却按融合形状来算，可能伸到离得近的那块画布外面。所以分工时只把像素交给画布够得着的那块玻璃（两种引擎都是），融合处的投影不会被画布边缘切出缺口。
- 融合不截图：native 引擎全部是实时页面；快照引擎在磨砂小于 2px 时也是实时页面，只有连接桥用快照。
- 每个像素的高光和投影只由一块玻璃负责绘制：自己内部归自己，重叠区归绘制顺序最靠下的那块，盒子外的桥归最近的那块。这样叠在一起也不会画两遍。
- 桥上没有元素可以画 CSS 背景色，所以由负责的那块玻璃把（相邻玻璃之间平滑过渡的）背景色补画在桥上，带颜色的玻璃融合后颜色也是连续的。
- 只有玻璃之间的相对位置变化时才重建背板（位移图约几毫秒，按 1 个 CSS 像素一格生成）；整组一起移动、滚动时只移动背板。
- 不满足条件的玻璃互相叠在一起时，上面那块会把下面那块当作挖空区，不会重复折射。

## 运行演示

```bash
npx http-server .   # 或 python3 -m http.server
# 官网 http://localhost:8080/ ，完整演示 http://localhost:8080/demo/
```

## 官网与部署到 Cloudflare

仓库根目录就是一个能直接部署的静态站点：`index.html` 是官网首页（玻璃导航、可拖动的玻璃球、融合试玩、各种材质），`demo/` 是带参数面板的完整演示，`liquid-glass.js` 是 SDK 本身，`404.html` 是找不到页面时的玻璃卡片。

用 Cloudflare Workers（静态资源）部署，`wrangler.jsonc` 已经配好：

```bash
npx wrangler login
npx wrangler deploy
```

部署后地址是 `https://liquid-glass.<你的子域>.workers.dev`，可以在 Cloudflare 控制台给它绑定自己的域名。`.assetsignore` 里列出的文件（`.git`、`README.md`、`wrangler.jsonc` 等）不会上传；`_headers` 给 `liquid-glass.js` 加了 1 小时缓存和跨域头，别的网站也能直接引用它。

也可以用 Cloudflare Pages：在控制台连接这个 GitHub 仓库，构建命令留空，输出目录填 `/`。

> 演示最好以独立页面打开。嵌在别的网站的 iframe 里时，Safari 和 iPhone / iPad 上的浏览器在第一次轻点之前会把动画降到 30 fps（见「限制」），SDK 会改用手指移动来驱动帧。

演示页包含：可拖动的圆形进度按钮（带弹簧形变）、每种预设的面板生成器、引擎 / 截图器 / 分辨率切换，以及 iframe 挖空、`data-lg-live` canvas、融合等示例。

## 限制

- 浏览器不暴露页面像素，snapshot 引擎看到的是**快照**，不是实时画面：边缘折射会比真实内容慢一拍。
- 快照拍不到 iframe、跨域图片、`<video>`（除非标了 `data-lg-live`）、无限循环的 CSS 动画。这些区域会自动挖空，只是没有折射。
- 跨域图片需要 `crossorigin="anonymous"` 才能进快照；网页字体默认不内嵌（`embedFonts: false`），快照里可能退回系统字体。由于只用于边缘折射，通常看不出来。
- 融合和折射几何不考虑元素的旋转（`translate`、`scale` 没问题）。
- 玻璃的投影会超出元素边界，祖先元素上的 `overflow: hidden` 会把它裁掉。
- Safari 和 iOS / iPadOS 上的所有浏览器，在**跨域 iframe** 里（比如嵌在别的网站或预览窗口里），用户第一次轻点或点击之前会把 `requestAnimationFrame` 降到 30 fps，而且拖动不算点击（[WebKit 170534](https://bugs.webkit.org/show_bug.cgi?id=170534)、[213344](https://bugs.webkit.org/show_bug.cgi?id=213344)）。这时 SDK 改由指针移动驱动帧：每次 `pointermove` 先运行页面排队的动画回调，再绘制玻璃，每次屏幕刷新最多一帧，拖动仍是满帧率。不在跨域 iframe 里、Chromium、或者用户已经点过一下时，这个机制不会启用。
- native 引擎在广色域屏幕（Display P3）上的 Chrome 里，位移图的 R/G 通道也会被色彩转换掺杂，折射方向会有些偏差（x、y 互相串一点）。单块玻璃的形状和融合背板不受影响。改成只用灰度和 alpha 的编码要么精度不够、要么在强折射处出错，还没有合适的办法。
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
