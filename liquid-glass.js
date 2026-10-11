/*!
 * liquid-glass.js · 液态玻璃 SDK v1.0.0
 *
 * 用法一：HTML 里声明（之后动态插入的元素也会自动生效，元素被移除时自动释放）
 *   <div data-liquid-glass>…</div>                          默认预设 clear
 *   <div data-liquid-glass="regular">…</div>                 预设：clear / regular / frosted / dark / lens / auto
 *   <div data-liquid-glass="dim: 0.2; bezel: 0.08">…</div>   直接写参数
 *   <div data-liquid-glass='{"preset":"dark","pointer":true}'>…</div>
 *
 * 用法二：JS
 *   const glass = LiquidGlass.create(el, { preset: 'regular', dim: 0.15 });
 *   glass.set({ dim: 0.3 });
 *   glass.destroy();
 *
 * 全局设置（可选，放在页面脚本最前面）
 *   LiquidGlass.config({ engine: 'auto', captureScale: 0.5 });
 *
 * 形状取元素自己的 border-radius；想给玻璃加颜色，直接给元素写半透明的 CSS background。
 *
 * 引擎（默认自动选择）
 *   native    Chromium：backdrop-filter + SVG 位移滤镜，浏览器实时折射页面
 *   snapshot  其他浏览器：页面快照 + WebGL 画边缘折射，中间用 CSS 模糊显示实时页面。
 *             快照拍不到的区域（iframe、video、跨域图片、无限循环的 CSS 动画、[data-lg-hole]）
 *             会被挖空：玻璃经过时直接显示实时内容，边缘不折射，只保留玻璃高光
 *   css       兜底：只有 CSS 毛玻璃和高光
 *
 * 页面标记
 *   [data-lg-ignore]  不进快照（自己的浮层、控制面板等 position: fixed 的东西）
 *   [data-lg-live]    canvas / video：快照引擎下每帧直接写进纹理
 *   [data-lg-hole]    在快照里挖空
 *
 * 可滚动的面板：把 data-liquid-glass 放在外层，滚动放在内层（玻璃的画布是元素的子节点）。
 */
(function (global) {
'use strict';
if (global.LiquidGlass && global.LiquidGlass.version) return;

const VERSION = '1.0.0';
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const LX = -0.5, LY = -0.866;               // light from the upper left, screen space (y down)
const SVGNS = 'http://www.w3.org/2000/svg';
const ua = navigator.userAgent;
const IS_CHROMIUM = !!(navigator.userAgentData && navigator.userAgentData.brands &&
  navigator.userAgentData.brands.some((b) => /Chromium/.test(b.brand))) || /\bChrome\/\d+/.test(ua);

const PRESETS = {
  clear:   { frost: 1, sat: 1.16, tint: 0.018, dim: 0 },
  regular: { frost: 6, sat: 1.5, tint: 0.05, dim: 0 },
  frosted: { frost: 14, sat: 1.6, tint: 0.09, dim: 0 },
  dark:    { frost: 8, sat: 1.35, tint: 0, dim: 0.35 },
  lens:    { frost: 0, sat: 1.1, tint: 0.01, dim: 0, bezel: 1, refract: 0.85, disp: 0.18, curve: 2 },   // magnifier
};
// 'auto' follows the system colour scheme: dark when the OS is dark, regular otherwise
const darkMQ = global.matchMedia ? global.matchMedia('(prefers-color-scheme: dark)') : null;
function presetFor(name) {
  if (name === 'auto') return darkMQ && darkMQ.matches ? 'dark' : 'regular';
  return PRESETS[name] ? name : 'clear';
}
const DEFAULTS = {
  preset: 'clear',
  dim: 0,           // 变暗比例 0..1：玻璃自身带一层压暗滤镜
  bezel: 0.06,      // 折射带宽度，占短边一半的比例
  refract: 0.45,    // 玻璃厚度
  curve: 2.6,       // 边缘曲率（2 圆弧，4 超椭圆）
  disp: 0.12,       // 色散
  frost: 1,         // 磨砂，css px
  sat: 1.16,        // 饱和度
  tint: 0.018,      // 提亮
  spec: 1,          // 高光强度
  shadow: 0.3,      // 投影
  ior: 1.5,
  gap: 0.32,
  pointer: false,   // 指针下方跟随一团柔光
  button: false,    // 按钮手感：悬停提亮，按下微缩、阴影加深（自带 pointer 柔光）
  draggable: false, // 可以直接拖动（不改 transform，用 CSS translate）
  merge: true,      // 同一层（相同 z-index、相同定位方式）、同一种材质的玻璃靠近时融合成一块
  blend: 24,        // 开始融合的距离，px
  contrast: 'off',  // 'off' | 'halo'：在 mask 画出的图形周围按背景亮度补暗边
  mask: null,       // (ctx, w, h) => void，用白色画出玻璃里的图形
  glyphDark: 0,     // 0..1，图形是深色时 halo 改为提亮
  adaptive: false,  // 维护 glass.luminance（玻璃下方页面的平均亮度，线性 0..1）
};
const OPTICAL = ['dim', 'bezel', 'refract', 'curve', 'disp', 'frost', 'sat', 'tint', 'spec', 'shadow', 'ior', 'gap'];
const CONFIG = {
  engine: 'auto',           // 'auto' | 'native' | 'snapshot' | 'css'
  captureScale: 0.5,        // 快照分辨率（相对 css px）
  lumScale: 0.15,           // native 引擎下只为亮度拍快照时的分辨率
  minCaptureInterval: 250,  // 两次截图的最小间隔，ms
  capturer: 'fast',         // 'fast'（内置）| 'modern-screenshot'（需要全局 modernScreenshot）
  embedFonts: false,
  liveFps: 30,
  auto: true,               // 自动接管 [data-liquid-glass]
};

function isSandbox(node) {
  return node && node.nodeType === 1 && node.tagName === 'IFRAME' && /^__SANDBOX__/.test(node.id || '');
}
function isIgnored(node) {
  if (isSandbox(node)) return true;
  const el = node && (node.nodeType === 1 ? node : node.parentElement);
  return !el || !!el.closest('[data-lg-ignore],[data-lg-glass],[data-liquid-glass]');
}
function mutationMatters(r) {
  if (isIgnored(r.target)) return false;
  if (r.type === 'childList') {
    const nodes = [...r.addedNodes, ...r.removedNodes];
    if (nodes.length && nodes.every((n) => isIgnored(n))) return false;
  }
  return true;
}
function resolveOptions(user) {
  const preset = presetFor(user.preset);
  return Object.assign({}, DEFAULTS, PRESETS[preset], user, { preset: user.preset === 'auto' ? 'auto' : preset });
}
function parseAttr(v) {
  v = (v || '').trim();
  if (!v) return {};
  if (v[0] === '{') {
    try { return JSON.parse(v); } catch (err) { console.warn('[LiquidGlass] bad data-liquid-glass JSON:', v); return {}; }
  }
  if (PRESETS[v] || v === 'auto') return { preset: v };
  const o = {};
  for (const part of v.split(';')) {
    const i = part.indexOf(':');
    if (i < 0) { const k = part.trim(); if (PRESETS[k] || k === 'auto') o.preset = k; continue; }
    const k = part.slice(0, i).trim(), val = part.slice(i + 1).trim();
    if (!k) continue;
    o[k] = val === 'true' ? true : val === 'false' ? false : (val !== '' && !isNaN(+val) ? +val : val);
  }
  return o;
}

// ------------------------------------------------------------------ optics (CPU copy of the shader)
function boxSd(px, py, hw, hh, r) {
  const qx = Math.abs(px) - (hw - r), qy = Math.abs(py) - (hh - r);
  const mx = Math.max(qx, 0), my = Math.max(qy, 0);
  const lo = Math.hypot(mx, my);
  const sd = lo + Math.min(Math.max(qx, qy), 0) - r;
  let nx, ny;
  if (qx > 0 && qy > 0) { nx = mx / lo; ny = my / lo; }
  else if (qx > qy) { nx = 1; ny = 0; } else { nx = 0; ny = 1; }
  return { sd, nx: px < 0 ? -nx : nx, ny: py < 0 ? -ny : ny };
}
function blinnJS(nx, ny, nz, lx, ly) {
  let Lx = lx * 0.75, Ly = ly * 0.75, Lz = 0.66;
  let il = 1 / Math.hypot(Lx, Ly, Lz); Lx *= il; Ly *= il; Lz *= il;
  let Hx = Lx, Hy = Ly, Hz = Lz + 1;
  il = 1 / Math.hypot(Hx, Hy, Hz); Hx *= il; Hy *= il; Hz *= il;
  return Math.pow(Math.max(nx * Hx + ny * Hy + nz * Hz, 0), 110);
}
function lensOptics(px, py, G, P) {
  const s = boxSd(px, py, G.hw, G.hh, G.r);
  const e = Math.max(-s.sd, 0);
  const w = Math.max(P.bezel * G.m, 0.5);
  const t = Math.min(e / w, 1), omt = 1 - t;
  const base = Math.max(1 - Math.pow(omt, P.curve), 1e-5);
  const h = Math.pow(base, 1 / P.curve);
  const dhdt = Math.pow(base, 1 / P.curve - 1) * Math.pow(omt, P.curve - 1);
  const T = P.refract * 0.9 * G.m;
  const slope = Math.min(dhdt / w * T, 8);
  const inv = 1 / Math.hypot(slope, 1);
  const nx = s.nx * slope * inv, ny = s.ny * slope * inv, nz = inv;
  const eta = 1 / P.ior;
  const k = 1 - eta * eta * (1 - nz * nz);
  const c = eta * nz - Math.sqrt(Math.max(k, 0));
  const tz = -eta + c * nz;
  const depth = T * (P.gap + (1 - P.gap) * h);
  const f = depth / Math.max(-tz, 0.15);
  const ld = s.nx * LX + s.ny * LY;
  const side = Math.pow(Math.max(ld, 0), 1.5) + 0.6 * Math.pow(Math.max(-ld, 0), 1.5);
  const fres = Math.pow(1 - nz, 5) * (0.3 + 0.7 * side);
  const rimLine = Math.exp(-e / 1.1);
  const rimSoft = Math.exp(-e / (G.m * 0.1));
  const hi = P.spec * (0.9 * rimLine * (0.22 + 0.78 * side) + 0.3 * fres +
    0.42 * blinnJS(nx, ny, nz, LX, LY) + 0.18 * blinnJS(nx, ny, nz, -LX, -LY) + 0.05 * rimSoft * side);
  return { sd: s.sd, dx: c * nx * f, dy: c * ny * f, hi };
}
// the drop shadow stays small on big panels
function shadowGeom(m) { return { off: Math.min(m * 0.12, 10), sig: Math.min(m * 0.2, 16), grow: Math.min(m * 0.04, 4) }; }
function shadowAlpha(px, py, G, P) {
  const S = G.sh;
  const s = boxSd(px - S.off * 0.21, py - S.off, G.hw, G.hh, G.r).sd + S.grow;
  return P.shadow * (0.6 * (1 - smooth(-S.sig, S.sig * 1.2, s)) + 0.4 * (1 - smooth(-S.sig, S.sig * 3.6, s)));
}

// ------------------------------------------------------------------ WebGL (snapshot rim, and light/shadow for native)
const VS = `#version 300 es
in vec2 a;
void main() { gl_Position = vec4(a, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float;
uniform sampler2D uSnap, uHaloTex;
uniform vec2 uSnapSize, uCenterSnap, uCanvasPx, uHalf, uLight, uTouch;
uniform vec3 uShadowGeom;
uniform mat2 uA;
uniform float uSnapScale, uDpr, uRad, uPad, uBezel, uK, uThick, uIor, uGap, uDisp, uFrost, uSpec,
              uTint, uSat, uDim, uShadow, uTouchAmt, uHalo, uGlyphDark, uNative;
uniform vec4 uOther[8];      // other glass panels overlapping this one: centre.xy, half size.zw (snapshot px)
uniform float uOtherR[8];
uniform int uOtherN;
uniform vec4 uFuse[8];       // same-layer neighbours fused with this glass: centre offset.xy, half size.zw (local css px)
uniform float uFuseR[8];
uniform float uFuseTop[8];   // 1 when that neighbour is painted above this glass
uniform int uFuseN;
uniform float uBlend, uHasSnap, uPress;
out vec4 o;

// other glass is not in the snapshot; treat it like a hole so the rim never shows what is underneath it
float otherCover(vec2 sp) {
  for (int i = 0; i < 8; i++) {
    if (i >= uOtherN) break;
    vec2 q = abs(sp - uOther[i].xy) - (uOther[i].zw - uOtherR[i]);
    if (length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uOtherR[i] < 0.0) return 1.0;
  }
  return 0.0;
}
vec4 tap(vec2 sp) {
  vec4 s = texture(uSnap, sp / uSnapSize);
  if (uOtherN > 0) s.a *= 1.0 - otherCover(sp);
  return s;
}
// element-local css px -> snapshot px (follows the element's CSS transform)
vec2 toSnap(vec2 local) { return uCenterSnap + (uA * local) * uSnapScale; }

// page colour behind a local point. .a = how much of it the snapshot actually knows:
// holes (iframes, videos, cross-origin images, infinite animations) are transparent in the snapshot
vec4 bg(vec2 local, float bm) {
  vec2 sp = toSnap(local);
  float blur = uFrost * uSnapScale * bm;
  vec4 s0 = tap(sp);
  if (blur < 0.35) return s0;
  vec3 acc = s0.rgb * s0.a;
  float wa = s0.a, ws = 1.0;
  for (int i = 0; i < 16; i++) {
    float fi = float(i) + 0.5;
    float r = sqrt(fi / 16.0) * blur * 1.6;
    float an = fi * 2.399963;
    float w = exp(-r * r / (blur * blur * 1.4));
    vec4 s = tap(sp + vec2(cos(an), sin(an)) * r);
    acc += s.rgb * s.a * w; wa += s.a * w; ws += w;
  }
  return vec4(acc / max(wa, 1e-4), wa / ws);
}

float rrSd(vec2 p, vec2 hf, float rad, out vec2 n) {
  vec2 q = abs(p) - (hf - rad);
  vec2 m = max(q, 0.0);
  float lo = length(m);
  float sd = lo + min(max(q.x, q.y), 0.0) - rad;
  vec2 nn = (q.x > 0.0 && q.y > 0.0) ? m / max(lo, 1e-4) : (q.x > q.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0));
  n = vec2(p.x < 0.0 ? -nn.x : nn.x, p.y < 0.0 ? -nn.y : nn.y);
  return sd;
}
float boxSd(vec2 p, out vec2 n) { return rrSd(p, uHalf, uRad, n); }

// smooth union with the fused neighbours (polynomial smin: shapes only start to melt within uBlend px)
float unionSd(vec2 p, float sdSelf, inout vec2 n, inout float mE) {
  float sd = sdSelf;
  float k = max(uBlend, 1.0);
  for (int i = 0; i < 8; i++) {
    if (i >= uFuseN) break;
    vec2 nj;
    float sj = rrSd(p - uFuse[i].xy, uFuse[i].zw, uFuseR[i], nj);
    float h = clamp(0.5 + 0.5 * (sj - sd) / k, 0.0, 1.0);
    sd = mix(sj, sd, h) - k * h * (1.0 - h);
    n = normalize(mix(nj, n, h) + vec2(1e-5));
    mE = mix(min(uFuse[i].z, uFuse[i].w), mE, h);
  }
  return sd;
}

float blinn(vec3 N, vec2 l) {
  vec3 L = normalize(vec3(l * 0.75, 0.66));
  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
  return pow(max(dot(N, H), 0.0), 110.0);
}

void main() {
  vec2 px = vec2(gl_FragCoord.x, uCanvasPx.y - gl_FragCoord.y) / uDpr;
  vec2 p = px - uPad - uHalf;
  float m = min(uHalf.x, uHalf.y);
  vec2 outward;
  float sdSelf = boxSd(p, outward);
  float sd = sdSelf, mE = m;
  bool opaque = false;
  if (uFuseN > 0) {
    // who draws this pixel: own interior is ours; an overlap belongs to the glass painted lowest, so the
    // backplate sits under the content of every glass in the stack; outside every box, the nearest glass
    // draws the bridge
    bool belowOther = false, inOther = false, closer = false;
    for (int i = 0; i < 8; i++) {
      if (i >= uFuseN) break;
      vec2 nj;
      float sj = rrSd(p - uFuse[i].xy, uFuse[i].zw, uFuseR[i], nj);
      if (sj < 0.0) { inOther = true; if (uFuseTop[i] < 0.5) belowOther = true; }
      if (sj < sdSelf) closer = true;
    }
    bool own = sdSelf < 0.0 ? !(inOther && belowOther) : (!inOther && !closer);
    if (!own) { o = vec4(0.0); return; }
    sd = unionSd(p, sdSelf, outward, mE);
    // shared backplate: while glass is fused, the whole merged shape is drawn as one opaque piece of
    // glass from the snapshot, so material and lighting match everywhere and no inner edges remain
    opaque = uHasSnap > 0.5;
  }

  vec2 ps = p - vec2(0.21, 1.0) * uShadowGeom.x;
  vec2 sn;
  float mS = m;
  float sds = boxSd(ps, sn);
  if (uFuseN > 0) sds = unionSd(ps, sds, sn, mS);
  sds += uShadowGeom.z;
  float sig = uShadowGeom.y;
  float sh = uShadow * (1.0 + 0.7 * uPress) * (0.6 * (1.0 - smoothstep(-sig, sig * 1.2, sds)) + 0.4 * (1.0 - smoothstep(-sig, sig * 3.6, sds)));

  float aa = clamp(0.5 - sd * uDpr, 0.0, 1.0);
  if (aa <= 0.0) { o = vec4(0.0, 0.0, 0.0, sh); return; }

  m = mE;
  float e = max(-sd, 0.0);
  float w = max(uBezel * m, 0.5);
  float t = clamp(e / w, 0.0, 1.0);
  float omt = 1.0 - t;
  float base = max(1.0 - pow(omt, uK), 1e-5);
  float h = pow(base, 1.0 / uK);
  float dhdt = pow(base, 1.0 / uK - 1.0) * pow(omt, uK - 1.0);
  float T = uThick * m;
  float slope = min(dhdt / w * T, 8.0);
  vec3 N = normalize(vec3(outward * slope, 1.0));
  vec3 Tr = refract(vec3(0.0, 0.0, -1.0), N, 1.0 / uIor);
  float depth = T * (uGap + (1.0 - uGap) * h);
  vec2 d = Tr.xy / max(-Tr.z, 0.15) * depth;

  // the refracting rim comes from the snapshot; inside it the live page shows through (CSS backdrop-filter)
  float rim = opaque ? 1.0 : 1.0 - smoothstep(0.55, 1.0, t);
  if (uNative > 0.5 && !opaque) rim = 0.0;   // native engine: the browser refracts, we add light and shadow
  float holeRim = 0.0;
  vec3 col = vec3(0.0);
  if (rim > 0.001) {
    float bm = opaque ? 1.0 : mix(0.35, 1.0, t);   // refraction stays crisp right at the edge
    vec4 sG = bg(p + d, bm);
    float known = sG.a;
    col = sG.rgb;
    if (uDisp > 0.001) {
      vec4 sR = bg(p + d * (1.0 - uDisp), bm);
      vec4 sB = bg(p + d * (1.0 + uDisp), bm);
      col = vec3(sR.r, sG.g, sB.b);
      known = min(known, min(sR.a, sB.a));
    }
    float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = clamp(mix(vec3(l), col, uSat), 0.0, 1.0) * (1.0 - uDim);
    if (opaque) {
      col = mix(vec3(0.55) * (1.0 - uDim), col, known);   // nothing known here: neutral glass
    } else {
      // where the snapshot knows nothing, drop the refraction and let the live page show through
      float rk = rim * smoothstep(0.35, 0.95, known);
      holeRim = rim - rk;
      rim = rk;
    }
  }

  float ld = dot(outward, uLight);
  float side = pow(max(ld, 0.0), 1.5) + 0.6 * pow(max(-ld, 0.0), 1.5);
  float fres = pow(1.0 - N.z, 5.0) * (0.3 + 0.7 * side);
  float rimLine = exp(-e / 1.1);
  float rimSoft = exp(-e / (m * 0.10));
  float hi = uSpec * (0.9 * rimLine * (0.22 + 0.78 * side) + 0.3 * fres
           + 0.42 * blinn(N, uLight) + 0.18 * blinn(N, -uLight) + 0.05 * rimSoft * side);
  // no refraction over holes: a plain glassmorphism bevel stands in for it
  hi += holeRim * uSpec * (0.30 * (1.0 - t) * (0.45 + 0.55 * side) + 0.35 * rimLine);
  vec2 dt = p - uTouch;
  hi += uTouchAmt * 0.12 * exp(-dot(dt, dt) / (m * m * 0.9)) + uPress * 0.04;
  hi = clamp(hi + uTint, 0.0, 1.0);

  // content-aware contrast: darken (light glyphs) or lighten (dark glyphs) only what is missing
  float kd = 0.0, kl = 0.0;
  if (uHalo > 0.0) {
    float hm = texture(uHaloTex, (p + uHalf) / (2.0 * uHalf)).r * uHalo;
    if (hm > 0.002) {
      vec2 c0 = toSnap(p + d);
      float rr = max(m * 0.06 * uSnapScale, 1.0);
      vec4 s1 = tap(c0), s2 = tap(c0 + vec2(rr, 0.0)), s3 = tap(c0 - vec2(rr, 0.0)), s4 = tap(c0 + vec2(0.0, rr)), s5 = tap(c0 - vec2(0.0, rr));
      float ka = s1.a + s2.a + s3.a + s4.a + s5.a;
      vec3 loc = (s1.rgb * s1.a + s2.rgb * s2.a + s3.rgb * s3.a + s4.rgb * s4.a + s5.rgb * s5.a) / max(ka, 1e-4);
      loc = mix(loc * (1.0 - uDim), vec3(1.0), uTint);
      float L = dot(pow(loc, vec3(2.2)), vec3(0.2126, 0.7152, 0.0722));
      float known = ka * 0.2;
      kd = known * hm * (1.0 - pow(min(1.0, 0.30 / max(L, 1e-4)), 1.0 / 2.2)) * (1.0 - uGlyphDark);
      kl = known * hm * clamp((0.16 - L) / (1.0 - L), 0.0, 1.0) * uGlyphDark;
    }
  }
  float hiT = 1.0 - (1.0 - hi) * (1.0 - kl);
  vec4 over = vec4(vec3(hiT), 1.0 - (1.0 - kd) * (1.0 - hiT));   // premultiplied, over the live page
  vec4 lens = mix(over, vec4(mix(col * (1.0 - kd), vec3(1.0), hiT), 1.0), rim);
  o = lens * aa + vec4(0.0, 0.0, 0.0, sh) * (1.0 - aa);
}`;

const UNIFORMS = ['uSnap', 'uHaloTex', 'uSnapSize', 'uCenterSnap', 'uCanvasPx', 'uHalf', 'uLight', 'uTouch', 'uShadowGeom', 'uA',
  'uSnapScale', 'uDpr', 'uRad', 'uPad', 'uBezel', 'uK', 'uThick', 'uIor', 'uGap', 'uDisp', 'uFrost', 'uSpec',
  'uTint', 'uSat', 'uDim', 'uShadow', 'uTouchAmt', 'uHalo', 'uGlyphDark', 'uNative', 'uOther', 'uOtherR', 'uOtherN',
  'uFuse', 'uFuseR', 'uFuseTop', 'uFuseN', 'uBlend', 'uHasSnap', 'uPress'];

class Renderer {
  constructor(canvas) {
    this.canvas = canvas || document.createElement('canvas');
    if (!canvas) { this.canvas.width = 4; this.canvas.height = 4; }
    const gl = this.gl = this.canvas.getContext('webgl2', {
      alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error('WebGL2 is not available');
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.U = {};
    for (const n of UNIFORMS) this.U[n] = gl.getUniformLocation(prog, n);
    gl.uniform1i(this.U.uSnap, 0);
    gl.uniform1i(this.U.uHaloTex, 1);
    this.snapTex = this.makeTex();
    this.blackTex = this.makeTex();
    gl.bindTexture(gl.TEXTURE_2D, this.blackTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;
    this.snapW = 1; this.snapH = 1;
  }
  makeTex() {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    // no mipmaps: generating them is the slow part on weak GPUs, the shader blurs with taps instead
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  setSnapshot(src) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.snapTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    this.snapW = src.width; this.snapH = src.height;
  }
  patch(x, y, src) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.snapTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, gl.RGBA, gl.UNSIGNED_BYTE, src);
  }
  haloTexture(src, old) {
    const gl = this.gl;
    const t = old || this.makeTex();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.activeTexture(gl.TEXTURE0);
    return t;
  }
  draw(g, snap, native) {
    const gl = this.gl, U = this.U, P = g.p, G = g.geom, f = g.frame;
    const cw = g.canvas.width, ch = g.canvas.height;
    if (this.canvas.width < cw || this.canvas.height < ch) {
      this.canvas.width = Math.max(this.canvas.width, cw);
      this.canvas.height = Math.max(this.canvas.height, ch);
    }
    gl.viewport(0, 0, cw, ch);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, cw, ch);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, g.haloTex || this.blackTex);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, snap ? this.snapTex : this.blackTex);
    gl.uniform2f(U.uSnapSize, snap ? this.snapW : 1, snap ? this.snapH : 1);
    gl.uniform2f(U.uCenterSnap, snap ? (f.cx + global.scrollX - snap.ox) * snap.scale : 0, snap ? (f.cy + global.scrollY - snap.oy) * snap.scale : 0);
    gl.uniform2f(U.uCanvasPx, cw, ch);
    gl.uniform2f(U.uHalf, G.hw, G.hh);
    gl.uniform2f(U.uLight, LX, LY);
    gl.uniform2f(U.uTouch, g.touch.x, g.touch.y);
    gl.uniform3f(U.uShadowGeom, G.sh.off, G.sh.sig, G.sh.grow);
    gl.uniformMatrix2fv(U.uA, false, f.A);
    gl.uniform1f(U.uSnapScale, snap ? snap.scale : 1);
    gl.uniform1f(U.uDpr, cw / g.cssW);
    gl.uniform1f(U.uRad, G.r);
    gl.uniform1f(U.uPad, G.pad);
    gl.uniform1f(U.uBezel, P.bezel);
    gl.uniform1f(U.uK, P.curve);
    gl.uniform1f(U.uThick, P.refract * 0.9);
    gl.uniform1f(U.uIor, P.ior);
    gl.uniform1f(U.uGap, P.gap);
    gl.uniform1f(U.uDisp, P.disp);
    gl.uniform1f(U.uFrost, P.frost);
    gl.uniform1f(U.uSpec, P.spec);
    gl.uniform1f(U.uTint, P.tint);
    gl.uniform1f(U.uSat, P.sat);
    gl.uniform1f(U.uDim, P.dim);
    gl.uniform1f(U.uShadow, P.shadow);
    gl.uniform1f(U.uTouchAmt, g.touch.amt);
    // the native engine does the halo inside its SVG filter
    gl.uniform1f(U.uHalo, !native && snap && P.contrast === 'halo' && g.haloTex ? 1 : 0);
    gl.uniform1f(U.uGlyphDark, P.glyphDark);
    gl.uniform1f(U.uNative, native ? 1 : 0);
    const others = snap ? g.others : [];
    const oa = this.otherBuf || (this.otherBuf = new Float32Array(32));
    const orr = this.otherRBuf || (this.otherRBuf = new Float32Array(8));
    for (let i = 0; i < others.length; i++) {
      const r = others[i].rect, k = snap.scale;
      oa[i * 4] = (r.left + r.width / 2 + global.scrollX - snap.ox) * k;
      oa[i * 4 + 1] = (r.top + r.height / 2 + global.scrollY - snap.oy) * k;
      oa[i * 4 + 2] = r.width / 2 * k; oa[i * 4 + 3] = r.height / 2 * k;
      orr[i] = Math.min(others[i].geom.r * k, r.width / 2 * k, r.height / 2 * k);
    }
    gl.uniform4fv(U.uOther, oa);
    gl.uniform1fv(U.uOtherR, orr);
    gl.uniform1i(U.uOtherN, others.length);
    // fused neighbours, in this glass's local css px
    const fuse = g.fuse;
    const fa = this.fuseBuf || (this.fuseBuf = new Float32Array(32));
    const fr = this.fuseRBuf || (this.fuseRBuf = new Float32Array(8));
    const ft = this.fuseTBuf || (this.fuseTBuf = new Float32Array(8));
    const sA = Math.sqrt(Math.abs(f.A[0] * f.A[3] - f.A[1] * f.A[2])) || 1;
    for (let i = 0; i < fuse.length; i++) {
      const o = fuse[i];
      fa[i * 4] = (o.frame.cx - f.cx) / sA; fa[i * 4 + 1] = (o.frame.cy - f.cy) / sA;
      fa[i * 4 + 2] = o.rect.width / 2 / sA; fa[i * 4 + 3] = o.rect.height / 2 / sA;
      fr[i] = Math.min(o.geom.r, fa[i * 4 + 2], fa[i * 4 + 3]);
      ft[i] = g.paintsBelow(o) ? 1 : 0;
    }
    gl.uniform4fv(U.uFuse, fa);
    gl.uniform1fv(U.uFuseR, fr);
    gl.uniform1fv(U.uFuseTop, ft);
    gl.uniform1i(U.uFuseN, fuse.length);
    gl.uniform1f(U.uBlend, Math.min(P.blend, G.pad * 1.6));
    gl.uniform1f(U.uHasSnap, snap ? 1 : 0);
    gl.uniform1f(U.uPress, g.press || 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    g.ctx.clearRect(0, 0, cw, ch);
    g.ctx.drawImage(this.canvas, 0, this.canvas.height - ch, cw, ch, 0, 0, cw, ch);
  }
}

// ------------------------------------------------------------------ page snapshots
const LUM_W = 64;
// Built-in capturer: clone the DOM as-is, ship the page's own style sheets alongside it inside an
// SVG <foreignObject>, and let the browser lay it out and paint it. No per-node getComputedStyle.
function rewriteSelector(sel) {
  return sel.split(',').map((part) => part
    .replace(/(^|[\s>+~(])(:root|html)(?=$|[\s>+~:.#[)])/g, '$1.lg-html')
    .replace(/(^|[\s>+~(])body(?=$|[\s>+~:.#[)])/g, '$1.lg-body')).join(',');
}
function rulesText(rules) {
  let out = '';
  for (const r of rules) {
    if (r.type === 1) out += rewriteSelector(r.selectorText) + '{' + r.style.cssText + '}';
    else if (r.type === 4) out += '@media ' + r.media.mediaText + '{' + rulesText(r.cssRules) + '}';
    else if (r.type === 12) out += '@supports ' + r.conditionText + '{' + rulesText(r.cssRules) + '}';
    else out += r.cssText;
  }
  return out;
}
function collectCss() {
  let out = '';
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch (err) { continue; }   // cross-origin sheet, unreadable
    out += rulesText(rules);
  }
  return out;
}
const imgCache = new Map();
function imageUrl(img) {
  const src = img.currentSrc || img.src || '';
  if (!src || /^data:/.test(src)) return src;
  if (imgCache.has(src)) return imgCache.get(src);
  let url = '';
  try {
    if (img.complete && img.naturalWidth) {
      const k = Math.min(1, 1024 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      url = c.toDataURL('image/webp', 0.85);
    }
  } catch (err) { url = ''; }   // cross-origin without CORS: becomes a hole
  if (url || img.complete) imgCache.set(src, url);
  return url;
}
function placeholderFor(src) {
  const cs = getComputedStyle(src), r = src.getBoundingClientRect();
  const ph = document.createElement('div');
  ph.setAttribute('style', `display:${cs.display === 'inline' ? 'inline-block' : cs.display};width:${r.width}px;height:${r.height}px;` +
    `border-radius:${cs.borderRadius};margin:${cs.margin};vertical-align:${cs.verticalAlign};`);
  return ph;
}
// areas the snapshot cannot show truthfully; they are cut out (alpha 0) so the live page shows instead
function collectHoles(ox, oy, unreadable) {
  const out = [];
  const add = (el, grow) => {
    if (!el || isIgnored(el)) return;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const k = grow || 0;
    out.push({
      x: r.left + global.scrollX - ox - r.width * k, y: r.top + global.scrollY - oy - r.height * k,
      w: r.width * (1 + 2 * k), h: r.height * (1 + 2 * k),
      r: k ? 0 : parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0,
    });
  };
  document.body.querySelectorAll('iframe,embed,object,video:not([data-lg-live]),[data-lg-hole]').forEach((el) => { if (!isSandbox(el)) add(el); });
  for (const el of unreadable) add(el);
  if (document.getAnimations) {
    for (const a of document.getAnimations()) {
      if (a.playState !== 'running' || !a.effect) continue;
      const t = a.effect.target;
      if (!t || t.nodeType !== 1) continue;
      const tm = a.effect.getComputedTiming && a.effect.getComputedTiming();
      if (!tm || isFinite(tm.endTime)) continue;     // finite ones are re-captured while they run
      const box = t.closest('[data-lg-hole]');
      if (box) continue;                             // already cut out as a whole
      add(t, 0.25);
    }
  }
  return out;
}
function punchHoles(canvas, holes, scale) {
  if (!holes.length) return;
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = '#000';
  for (const h of holes) {
    ctx.beginPath();
    if (h.r && ctx.roundRect) ctx.roundRect(h.x * scale, h.y * scale, h.w * scale, h.h * scale, h.r * scale);
    else ctx.rect(h.x * scale, h.y * scale, h.w * scale, h.h * scale);
    ctx.fill();
  }
  ctx.restore();
}
async function fastCapture(M, scale, W, H, unreadable) {
  const T0 = performance.now();
  const body = document.body, html = document.documentElement;
  const root = document.createElement('div');
  for (const a of html.attributes) root.setAttribute(a.name, a.value);
  root.setAttribute('class', ((html.getAttribute('class') || '') + ' lg-html').trim());
  root.setAttribute('style', (html.getAttribute('style') || '') + `;width:${W}px;min-height:${H}px;margin:0;`);
  const style = document.createElement('style');
  style.textContent = collectCss();
  root.appendChild(style);

  const clone = body.cloneNode(true);
  const SEL = 'canvas,video,img,input,textarea,select,[data-lg-glass]';
  const src = body.querySelectorAll(SEL), dst = clone.querySelectorAll(SEL);
  for (let i = 0; i < src.length && i < dst.length; i++) {
    const a = src[i], b = dst[i];
    if (a.hasAttribute('data-lg-glass')) { b.style.visibility = 'hidden'; continue; }
    if (isIgnored(a)) continue;
    const tag = a.tagName;
    if (tag === 'CANVAS') {
      let rep = null;
      if (!a.hasAttribute('data-lg-live')) {
        try {
          rep = document.createElement('img');
          rep.src = a.toDataURL();
          rep.setAttribute('style', placeholderFor(a).getAttribute('style'));
        } catch (err) { rep = null; unreadable.push(a); }
      }
      b.replaceWith(rep || placeholderFor(a));   // live layers get patched in every frame anyway
    } else if (tag === 'VIDEO') {
      b.replaceWith(placeholderFor(a));
    } else if (tag === 'IMG') {
      const u = imageUrl(a);
      b.removeAttribute('srcset'); b.removeAttribute('loading');
      if (u) b.setAttribute('src', u);
      else { b.removeAttribute('src'); if (a.currentSrc || a.src) unreadable.push(a); }
    } else if (tag === 'INPUT') {
      if (a.type === 'checkbox' || a.type === 'radio') { if (a.checked) b.setAttribute('checked', ''); else b.removeAttribute('checked'); }
      else b.setAttribute('value', a.value);
    } else if (tag === 'TEXTAREA') {
      b.textContent = a.value;
    } else if (tag === 'SELECT') {
      const ao = a.options, bo = b.options;
      for (let k = 0; k < ao.length && k < bo.length; k++) { if (ao[k].selected) bo[k].setAttribute('selected', ''); else bo[k].removeAttribute('selected'); }
    }
  }
  clone.querySelectorAll('[data-lg-ignore],script,noscript,style,link,template').forEach((n) => n.remove());
  clone.querySelectorAll('iframe').forEach((n) => { if (isSandbox(n)) n.remove(); });
  const bdiv = document.createElement('div');
  for (const a of clone.attributes) bdiv.setAttribute(a.name, a.value);
  bdiv.setAttribute('class', ((clone.getAttribute('class') || '') + ' lg-body').trim());
  while (clone.firstChild) bdiv.appendChild(clone.firstChild);
  root.appendChild(bdiv);

  const T1 = performance.now();
  const xhtml = new XMLSerializer().serializeToString(root);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><foreignObject x="0" y="0" width="100%" height="100%">${xhtml}</foreignObject></svg>`;
  const img = new Image();
  img.decoding = 'sync';
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await new Promise((res, rej) => {
    const fail = () => rej(new Error('snapshot SVG failed to load'));
    if (img.decode) img.decode().then(res, () => { if (img.complete && img.naturalWidth) res(); else { img.onload = res; img.onerror = fail; } });
    else { img.onload = res; img.onerror = fail; }
  });
  const T2 = performance.now();
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(W * scale)); canvas.height = Math.max(1, Math.round(H * scale));
  const ctx = canvas.getContext('2d');
  const paint = () => { ctx.fillStyle = M.bg; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(img, 0, 0, canvas.width, canvas.height); };
  paint();
  // WebKit and Gecko sometimes paint images inside foreignObject only on the second draw
  if (!IS_CHROMIUM) { await new Promise((r) => setTimeout(r, 120)); paint(); }
  // tiny copy for the luminance grid, rasterised straight from the SVG (no read-back of the big canvas)
  const lc = document.createElement('canvas');
  lc.width = LUM_W; lc.height = Math.max(1, Math.round(LUM_W * H / W));
  const lctx = lc.getContext('2d', { willReadFrequently: true });
  lctx.fillStyle = M.bg; lctx.fillRect(0, 0, lc.width, lc.height);
  lctx.drawImage(img, 0, 0, lc.width, lc.height);
  canvas.lumCanvas = lc;
  M.stats.parts = { clone: Math.round(T1 - T0), decode: Math.round(T2 - T1), paint: Math.round(performance.now() - T2), svgKB: Math.round(svg.length / 1024) };
  return canvas;
}

async function captureBody(M, scale) {
  const body = document.body;
  const rect = body.getBoundingClientRect();
  const width = Math.ceil(rect.width);
  const height = Math.ceil(Math.max(rect.height, body.scrollHeight));
  const lim = M.renderer ? M.renderer.maxTex * 0.98 : 4096;
  scale = Math.min(scale, lim / width, lim / height);
  let bgc = getComputedStyle(body).backgroundColor;
  if (!bgc || bgc === 'transparent' || /rgba\(.*,\s*0\)$/.test(bgc)) bgc = getComputedStyle(document.documentElement).backgroundColor;
  if (!bgc || bgc === 'transparent' || /rgba\(.*,\s*0\)$/.test(bgc)) bgc = '#ffffff';
  const ox = rect.left + global.scrollX, oy = rect.top + global.scrollY;
  M.bg = bgc;
  const unreadable = [];
  let canvas;
  if (M.cfg.capturer !== 'modern-screenshot') {
    canvas = await fastCapture(M, scale, width, height, unreadable);
  } else {
    const ms = global.modernScreenshot;
    if (!ms || !ms.domToCanvas) throw new Error('modernScreenshot is not loaded');
    const opts = {
      scale, width, height, backgroundColor: bgc,
      font: M.cfg.embedFonts ? undefined : false,
      timeout: 4000,
      filter: (n) => !(n.nodeType === 1 && n.hasAttribute('data-lg-ignore')),
      onCloneEachNode: (c) => { if (c.nodeType === 1 && c.hasAttribute('data-lg-glass')) c.style.visibility = 'hidden'; },
    };
    const key = [scale.toFixed(4), width, height, bgc].join('|');
    if (ms.createContext && (!M.msCtx || M.msKey !== key)) {
      if (M.msCtx && ms.destroyContext) { try { ms.destroyContext(M.msCtx); } catch (err) { /* ignore */ } }
      M.msCtx = await ms.createContext(body, opts);
      M.msKey = key;
    }
    canvas = M.msCtx ? await ms.domToCanvas(M.msCtx) : await ms.domToCanvas(body, opts);
  }
  const sc = canvas.width / width;
  const holes = collectHoles(ox, oy, unreadable);
  punchHoles(canvas, holes, sc);
  M.stats.holes = holes.length;
  return { canvas, ox, oy, scale: sc, w: canvas.width, h: canvas.height, cssW: width, cssH: height };
}

class Capturer {
  constructor(M) {
    this.M = M;
    this.busy = false; this.queued = false; this.timer = 0; this.waiting = false; this.next = 0;
  }
  request() {
    if (!this.M.wantsCapture()) return;
    if (this.busy) { this.queued = true; return; }
    if (this.timer || this.waiting) return;
    const delay = Math.max(16, this.next - performance.now());
    this.timer = setTimeout(() => {
      this.timer = 0;
      this.waiting = true;
      // run when the main thread is idle, so a capture never lands in the middle of a drag frame
      if (global.requestIdleCallback) global.requestIdleCallback(() => this.run(), { timeout: 400 });
      else this.run();
    }, delay);
  }
  async run() {
    this.waiting = false;
    if (!this.M.wantsCapture()) return;
    this.busy = true;
    const M = this.M, st = M.stats;
    const t0 = performance.now();
    try {
      const scale = M.needsTexture() ? M.cfg.captureScale : M.cfg.lumScale;
      const snap = await captureBody(M, scale);
      const t1 = performance.now();
      M.onSnapshot(snap);
      st.captureOnlyMs = t1 - t0;
      st.uploadMs = performance.now() - t1;
      st.error = '';
    } catch (err) {
      st.error = String((err && err.message) || err);
      console.warn('[LiquidGlass] capture failed:', err);
    }
    const dt = performance.now() - t0;
    st.lastCaptureMs = dt;
    st.captures++;
    this.next = performance.now() + Math.max(M.cfg.minCaptureInterval, dt * 4);
    this.busy = false;
    if (this.queued) { this.queued = false; this.request(); }
  }
}

// ------------------------------------------------------------------ one glass element
let uid = 0;
class Glass {
  constructor(M, el, opts) {
    this.M = M;
    this.el = el;
    this.id = 'lg' + (++uid);
    this.user = Object.assign({}, opts || {});
    this.p = resolveOptions(this.user);
    this.touch = { amt: 0, x: 0, y: 0 };
    this.ptr = null;
    this.frame = { cx: 0, cy: 0, A: [1, 0, 0, 1] };
    this.others = [];
    this.fuse = [];
    this.press = 0;
    this.layer = '';
    this.geom = null;
    this.key = '';
    this.dirty = true;
    this.luminance = null;
    this.haloTex = null; this.haloCanvas = null; this.haloUrl = '';
    this.saved = {
      position: el.style.position, isolation: el.style.isolation, backgroundImage: el.style.backgroundImage,
      backdropFilter: el.style.backdropFilter, webkitBackdropFilter: el.style.webkitBackdropFilter,
      translate: el.style.translate, scale: el.style.scale, touchAction: el.style.touchAction, cursor: el.style.cursor,
    };
    el.setAttribute('data-lg-glass', '');
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    el.style.isolation = 'isolate';
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('data-lg-ignore', '');
    this.canvas.setAttribute('aria-hidden', 'true');
    Object.assign(this.canvas.style, { position: 'absolute', zIndex: '-1', pointerEvents: 'none', display: 'block', margin: '0' });
    el.insertBefore(this.canvas, el.firstChild);
    this.ctx = this.canvas.getContext('2d');
    this.ro = new ResizeObserver(() => { this.geom = null; this.dirty = true; });
    this.ro.observe(el);
    this.bindPointer();
    this.bindDrag();
  }

  /** current resolved options (copy) */
  get options() { return Object.assign({}, this.p); }

  /** change options; only what changed is rebuilt */
  set(opts) {
    const prev = this.p;
    Object.assign(this.user, opts || {});
    this.p = resolveOptions(this.user);
    const changed = (k) => prev[k] !== this.p[k];
    if (changed('mask')) this.buildHalo();
    if (changed('pointer') || changed('button')) this.bindPointer();
    if (changed('draggable')) this.bindDrag();
    if (changed('adaptive') && this.p.adaptive) this.M.capturer.request();
    this.dirty = true;
    if (OPTICAL.some(changed)) this.rebuildEngine();
    else if (this.M.engine === 'native') this.applyNativeHalo();
    return this;
  }

  /** soft light under a point: amount 0..1, x / y in px from the element centre */
  setLight(amt, x, y) {
    if (Math.abs(amt - this.touch.amt) < 1e-3 && x === this.touch.x && y === this.touch.y) return;
    this.touch.amt = amt; this.touch.x = x; this.touch.y = y;
    this.dirty = true;
    const G = this.geom;
    if (this.M.engine === 'css' || !this.M.renderer) {
      this.el.style.backgroundImage = amt > 0.01 && G
        ? `radial-gradient(circle at ${(G.hw + x).toFixed(1)}px ${(G.hh + y).toFixed(1)}px, rgba(255,255,255,${(amt * 0.16).toFixed(3)}), rgba(255,255,255,0) ${Math.round(G.m * 1.3)}px)`
        : this.saved.backgroundImage;
    }
  }
  setTouch(amt, x, y) { this.setLight(amt, x, y); }

  /** redraw the halo mask after the shapes in opts.mask changed */
  updateMask() { this.buildHalo(); this.dirty = true; if (this.M.engine === 'native') this.applyNativeHalo(); }

  bindPointer() {
    const on = !!(this.p.pointer || this.p.button);
    if (on && !this.ptr) {
      const st = this.ptr = { over: false, down: false, x: 0, y: 0 };
      const pos = (e) => { const r = this.el.getBoundingClientRect(); st.x = e.clientX - (r.left + r.width / 2); st.y = e.clientY - (r.top + r.height / 2); };
      st.h = {
        pointerenter: (e) => { st.over = true; pos(e); },
        pointermove: pos,
        pointerleave: () => { st.over = false; st.down = false; },
        pointerdown: (e) => { st.down = true; pos(e); },
        pointerup: () => { st.down = false; },
        pointercancel: () => { st.down = false; },
      };
      for (const k in st.h) this.el.addEventListener(k, st.h[k], { passive: true });
    } else if (!on && this.ptr) {
      for (const k in this.ptr.h) this.el.removeEventListener(k, this.ptr.h[k]);
      this.ptr = null;
      this.setLight(0, 0, 0);
    }
  }
  stepPointer(dt) {
    const st = this.ptr;
    if (!st) return;
    const target = st.down ? 1 : st.over ? 0.45 : 0;
    let a = this.touch.amt + (target - this.touch.amt) * (1 - Math.exp(-dt * (target > this.touch.amt ? 14 : 5)));
    if (Math.abs(a - target) < 0.003) a = target;
    this.setLight(a, st.x, st.y);
    if (this.p.button) {
      const pt = st.down && !(this.drag && this.drag.moved) ? 1 : 0;
      let pr = this.press + (pt - this.press) * (1 - Math.exp(-dt * 18));
      if (Math.abs(pr - pt) < 0.002) pr = pt;
      if (pr !== this.press) {
        this.press = pr; this.dirty = true;
        this.el.style.scale = pr > 0.001 ? String(1 - 0.03 * pr) : this.saved.scale;
      }
    }
  }

  // built-in dragging: moves the element with the CSS translate property, leaves transform alone
  bindDrag() {
    const on = !!this.p.draggable;
    if (on && !this.dragH) {
      const el = this.el;
      const d = this.drag = { id: -1, x: 0, y: 0, sx: 0, sy: 0, bx: 0, by: 0, moved: false };
      const cur = (el.style.translate || '').split(/\s+/).map(parseFloat);
      d.x = cur[0] || 0; d.y = cur[1] || 0;
      el.style.touchAction = 'none';
      if (!el.style.cursor) el.style.cursor = 'grab';
      this.dragH = {
        pointerdown: (e) => {
          if (e.button !== 0) return;
          // controls inside the glass keep working; dragging starts on the glass itself
          const ctl = e.target.closest('a,button,input,textarea,select,label,[contenteditable],[data-lg-nodrag]');
          if (ctl && ctl !== el && el.contains(ctl)) return;
          d.id = e.pointerId; d.sx = e.clientX; d.sy = e.clientY; d.bx = d.x; d.by = d.y; d.moved = false;
          try { el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
          el.style.cursor = 'grabbing';
        },
        pointermove: (e) => {
          if (e.pointerId !== d.id) return;
          const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
          if (!d.moved && Math.hypot(dx, dy) < 4) return;
          d.moved = true;
          d.x = d.bx + dx; d.y = d.by + dy;
          el.style.translate = `${d.x}px ${d.y}px`;
        },
        pointerup: (e) => { if (e.pointerId === d.id) { d.id = -1; el.style.cursor = 'grab'; } },
        pointercancel: (e) => { if (e.pointerId === d.id) { d.id = -1; el.style.cursor = 'grab'; } },
        // a drag never counts as a click on whatever is under the pointer
        click: (e) => { if (d.moved) { e.stopPropagation(); e.preventDefault(); d.moved = false; } },
      };
      for (const k in this.dragH) el.addEventListener(k, this.dragH[k], k === 'click');
    } else if (!on && this.dragH) {
      for (const k in this.dragH) this.el.removeEventListener(k, this.dragH[k], k === 'click');
      this.dragH = null; this.drag = null;
      this.el.style.touchAction = this.saved.touchAction; this.el.style.cursor = this.saved.cursor;
    }
  }

  // glass only melts into glass of the same material, otherwise the joint would show a seam
  material() { const P = this.p; return [P.frost, P.sat, P.tint, P.dim].join(','); }

  // true when this glass is painted before (under) the other one; same z-index => document order
  paintsBelow(o) {
    return !!(this.el.compareDocumentPosition(o.el) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  measure() {
    const el = this.el;
    const w = el.offsetWidth, h = el.offsetHeight;
    if (!w || !h) return null;
    const cs = getComputedStyle(el);
    const raw = cs.borderTopLeftRadius || '0';
    let r = parseFloat(raw) || 0;
    if (/%/.test(raw)) r = r / 100 * Math.min(w, h);
    const hw = w / 2, hh = h / 2;
    r = clamp(r, 0, Math.min(hw, hh));
    const m = Math.min(hw, hh);
    const sh = shadowGeom(m);
    const pad = Math.ceil(sh.off + sh.sig * 3.6 + 2);
    return { w, h, hw, hh, r, m, sh, pad, bl: el.clientLeft, bt: el.clientTop };
  }

  layoutCanvas() {
    const G = this.geom, dpr = this.M.dpr;
    this.cssW = G.w + G.pad * 2; this.cssH = G.h + G.pad * 2;
    const cw = Math.max(2, Math.round(this.cssW * dpr)), ch = Math.max(2, Math.round(this.cssH * dpr));
    if (this.canvas.width !== cw) this.canvas.width = cw;
    if (this.canvas.height !== ch) this.canvas.height = ch;
    Object.assign(this.canvas.style, {
      left: -(G.pad + G.bl) + 'px', top: -(G.pad + G.bt) + 'px',
      width: this.cssW + 'px', height: this.cssH + 'px',
    });
  }

  ensureGeom() {
    if (this.geom) return true;
    const G = this.measure();
    if (!G) return false;
    this.geom = G;
    this.layoutCanvas();
    this.buildHalo();
    this.rebuildEngine();
    return true;
  }

  // soft mask around whatever the app draws in opts.mask; used by the contrast scrim
  buildHalo() {
    const G = this.geom;
    if (!G || !this.p.mask) { this.haloCanvas = null; this.haloUrl = ''; return; }
    const s = Math.min(2, 320 / Math.max(G.w, G.h));
    const cw = Math.max(8, Math.round(G.w * s)), ch = Math.max(8, Math.round(G.h * s));
    const c = this.haloCanvas || document.createElement('canvas');
    c.width = cw; c.height = ch;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.clearRect(0, 0, G.w, G.h);
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#fff';
    this.p.mask(ctx, G.w, G.h);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const img = ctx.getImageData(0, 0, cw, ch);
    const a = new Float32Array(cw * ch);
    for (let i = 0; i < a.length; i++) a[i] = img.data[i * 4 + 3] / 255;
    const sigma = Math.max(2, G.m * 0.056) * s;
    const r = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
    const tmp = new Float32Array(a.length);
    for (let pass = 0; pass < 3; pass++) { boxBlurH(a, tmp, cw, ch, r); boxBlurV(tmp, a, cw, ch, r); }
    for (let i = 0; i < a.length; i++) {
      const v = Math.round(255 * clamp(a[i] * 2.6, 0, 1));
      img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    this.haloCanvas = c;
    this.haloUrl = c.toDataURL();
    if (this.M.renderer) this.haloTex = this.M.renderer.haloTexture(c, this.haloTex);
  }

  cssBackdrop() {
    const P = this.p;
    return [P.frost > 0.05 ? `blur(${P.frost.toFixed(2)}px)` : '', `saturate(${P.sat})`, P.dim > 0.001 ? `brightness(${(1 - P.dim).toFixed(3)})` : '']
      .filter(Boolean).join(' ');
  }

  rebuildEngine() {
    if (!this.geom) return;
    this.key = '';
    this.dirty = true;
    const eng = this.M.engine;
    if (eng === 'native') this.buildNative();
    else {
      this.removeFilter();
      const bf = this.cssBackdrop();
      this.el.style.backdropFilter = bf;
      this.el.style.webkitBackdropFilter = bf;
      this.backdropOn = true;
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      if (eng === 'css' || !this.M.renderer) this.paintOverlayCPU();
    }
  }

  removeFilter() {
    if (this.filter) { this.filter.remove(); this.filter = null; }
  }

  buildNative() {
    const G = this.geom, P = this.p, dpr = this.M.dpr;
    // displacement map over the element box
    const sc = Math.min(dpr, 600 / Math.max(G.w, G.h));
    const nw = Math.max(8, Math.round(G.w * sc)), nh = Math.max(8, Math.round(G.h * sc));
    const mc = document.createElement('canvas');
    mc.width = nw; mc.height = nh;
    const mctx = mc.getContext('2d');
    const map = mctx.createImageData(nw, nh);
    const dx = new Float32Array(nw * nh), dy = new Float32Array(nw * nh);
    let maxD = 0.5;
    // only the bezel refracts: skip the flat middle
    const band = P.bezel * G.m + 1;
    for (let j = 0; j < nh; j++) {
      const ly = (j + 0.5) / sc - G.hh;
      for (let i = 0; i < nw; i++) {
        const lx = (i + 0.5) / sc - G.hw;
        if (Math.abs(lx) < G.hw - band - G.r && Math.abs(ly) < G.hh - band - G.r) continue;
        const o = lensOptics(lx, ly, G, P);
        if (o.sd > 0.5) continue;
        const k = j * nw + i;
        dx[k] = o.dx; dy[k] = o.dy;
        maxD = Math.max(maxD, Math.abs(o.dx), Math.abs(o.dy));
      }
    }
    const scale = maxD * 2.02;
    for (let k = 0; k < nw * nh; k++) {
      map.data[k * 4] = Math.round(255 * clamp(0.5 + dx[k] / scale, 0, 1));
      map.data[k * 4 + 1] = Math.round(255 * clamp(0.5 + dy[k] / scale, 0, 1));
      map.data[k * 4 + 2] = 128;
      map.data[k * 4 + 3] = 255;
    }
    mctx.putImageData(map, 0, 0);
    // highlights and shadow: WebGL when available (see update), otherwise once on the CPU
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.M.renderer) this.paintOverlayCPU();
    this.buildNativeFilter(mc, scale);
  }

  paintOverlayCPU() {
    const G = this.geom, P = this.p;
    const cw = this.canvas.width, ch = this.canvas.height, k = cw / this.cssW;
    const img = this.ctx.createImageData(cw, ch);
    for (let j = 0; j < ch; j++) {
      const ly = (j + 0.5) / k - G.pad - G.hh;
      for (let i = 0; i < cw; i++) {
        const lx = (i + 0.5) / k - G.pad - G.hw;
        const sd = boxSd(lx, ly, G.hw, G.hh, G.r).sd;
        const aa = clamp(0.5 - sd * k, 0, 1);
        let hiA = 0;
        if (aa > 0) {
          const e = -sd;
          // the flat middle only carries the tint
          hiA = (e > P.bezel * G.m + 3 ? P.tint : clamp(lensOptics(lx, ly, G, P).hi + P.tint, 0, 1)) * aa;
        }
        const sh = aa < 1 ? shadowAlpha(lx, ly, G, P) * (1 - aa) : 0;
        const A = hiA + sh;
        if (A <= 0.002) continue;
        const o = (j * cw + i) * 4;
        const g = Math.round(255 * hiA / A);
        img.data[o] = g; img.data[o + 1] = g; img.data[o + 2] = g; img.data[o + 3] = Math.round(255 * Math.min(1, A));
      }
    }
    this.ctx.putImageData(img, 0, 0);
  }

  buildNativeFilter(mc, scale) {
    const G = this.geom, P = this.p;
    if (!this.filter) {
      const f = document.createElementNS(SVGNS, 'filter');
      f.setAttribute('id', this.id);
      f.setAttribute('filterUnits', 'userSpaceOnUse');
      f.setAttribute('primitiveUnits', 'userSpaceOnUse');
      f.setAttribute('color-interpolation-filters', 'sRGB');
      f.innerHTML = `
        <feGaussianBlur class="blur" in="SourceGraphic" stdDeviation="1" result="blur"/>
        <feImage class="map" x="0" y="0" preserveAspectRatio="none" result="map"/>
        <feDisplacementMap class="dr" in="blur" in2="map" xChannelSelector="R" yChannelSelector="G" result="dr"/>
        <feDisplacementMap class="dg" in="blur" in2="map" xChannelSelector="R" yChannelSelector="G" result="dg"/>
        <feDisplacementMap class="db" in="blur" in2="map" xChannelSelector="R" yChannelSelector="G" result="db"/>
        <feColorMatrix in="dr" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="r"/>
        <feColorMatrix in="dg" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="g"/>
        <feColorMatrix in="db" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="b"/>
        <feComposite in="r" in2="g" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="rg"/>
        <feComposite in="rg" in2="b" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="rgb"/>
        <feColorMatrix class="sat" in="rgb" type="saturate" values="1.16" result="satd"/>
        <feComponentTransfer in="satd" result="glass">
          <feFuncR class="dim" type="linear" slope="1" intercept="0"/>
          <feFuncG class="dim" type="linear" slope="1" intercept="0"/>
          <feFuncB class="dim" type="linear" slope="1" intercept="0"/>
        </feComponentTransfer>
        <feGaussianBlur in="glass" stdDeviation="5" result="gb"/>
        <feComponentTransfer in="gb" result="glin">
          <feFuncR type="gamma" amplitude="1" exponent="2.2" offset="0"/>
          <feFuncG type="gamma" amplitude="1" exponent="2.2" offset="0"/>
          <feFuncB type="gamma" amplitude="1" exponent="2.2" offset="0"/>
        </feComponentTransfer>
        <feColorMatrix in="glin" type="matrix" values="0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0 0 0 1 0" result="lum"/>
        <feComponentTransfer in="lum" result="need">
          <feFuncR type="table" tableValues="${NEED_TABLE}"/>
          <feFuncG type="table" tableValues="${NEED_TABLE}"/>
          <feFuncB type="table" tableValues="${NEED_TABLE}"/>
        </feComponentTransfer>
        <feImage class="halo" x="0" y="0" preserveAspectRatio="none" result="halo"/>
        <feComposite in="need" in2="halo" operator="arithmetic" k1="1" k2="0" k3="0" k4="0" result="dh"/>
        <feComponentTransfer in="dh" result="fac">
          <feFuncR class="fac" type="linear" slope="0" intercept="1"/>
          <feFuncG class="fac" type="linear" slope="0" intercept="1"/>
          <feFuncB class="fac" type="linear" slope="0" intercept="1"/>
          <feFuncA type="linear" slope="0" intercept="1"/>
        </feComponentTransfer>
        <feComposite in="glass" in2="fac" operator="arithmetic" k1="1" k2="0" k3="0" k4="0"/>`;
      this.M.defs().appendChild(f);
      this.filter = f;
    }
    const f = this.filter;
    const q = (sel) => f.querySelector(sel);
    for (const el of [f, q('.map'), q('.halo')]) { el.setAttribute('width', G.w); el.setAttribute('height', G.h); }
    f.setAttribute('x', '0'); f.setAttribute('y', '0');
    q('.map').setAttribute('href', mc.toDataURL());
    q('.dr').setAttribute('scale', (scale * (1 - P.disp)).toFixed(3));
    q('.dg').setAttribute('scale', scale.toFixed(3));
    q('.db').setAttribute('scale', (scale * (1 + P.disp)).toFixed(3));
    q('.blur').setAttribute('stdDeviation', P.frost.toFixed(2));
    q('.sat').setAttribute('values', String(P.sat));
    f.querySelectorAll('.dim').forEach((n) => n.setAttribute('slope', (1 - P.dim).toFixed(3)));
    this.applyNativeHalo();
    const bf = `url(#${this.id})`;
    this.el.style.backdropFilter = 'none';
    this.el.style.webkitBackdropFilter = 'none';
    // re-apply on the next frame so Chrome re-reads the updated filter
    this.backdropOn = true;
    requestAnimationFrame(() => {
      if (this.M.engine !== 'native' || !this.filter || !this.backdropOn) return;
      this.el.style.backdropFilter = bf;
      this.el.style.webkitBackdropFilter = bf;
    });
  }

  applyNativeHalo() {
    if (!this.filter) return;
    const on = this.p.contrast === 'halo' && this.haloCanvas && this.p.glyphDark < 0.5;
    const halo = this.filter.querySelector('.halo');
    if (this.haloUrl && halo.getAttribute('href') !== this.haloUrl) halo.setAttribute('href', this.haloUrl);
    this.filter.querySelectorAll('.fac').forEach((n) => n.setAttribute('slope', on ? '-1' : '0'));
  }

  // pass 1 of every frame: where is the glass, what layer is it on
  measureFrame() {
    this.visible = false;
    if (!this.ensureGeom()) return false;
    const r = this.el.getBoundingClientRect();
    const cs = getComputedStyle(this.el);
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    let A = [1, 0, 0, 1];
    if (cs.transform && cs.transform !== 'none') {
      const mm = new DOMMatrixReadOnly(cs.transform);
      A = [mm.a, mm.b, mm.c, mm.d];
    }
    this.frame.cx = cx; this.frame.cy = cy; this.frame.A = A;
    this.rect = r;
    this.layer = (cs.position === 'fixed' ? 'f' : 'n') + '|' + cs.zIndex;
    if (this.p.adaptive) this.luminance = this.M.luminanceAt(cx, cy, this.geom.hw * 0.8, this.geom.hh * 0.8);
    const pad = this.geom.pad;
    this.visible = !(r.right < -pad || r.bottom < -pad || r.left > global.innerWidth + pad || r.top > global.innerHeight + pad);
    return true;
  }

  // gap between the two boxes (ignores the corner radius, so it errs on the near side)
  gapTo(o) {
    const a = this.rect, b = o.rect;
    const dx = Math.max(0, Math.max(a.left, b.left) - Math.min(a.right, b.right));
    const dy = Math.max(0, Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom));
    return Math.hypot(dx, dy);
  }

  // pass 3: draw if anything that affects the pixels changed
  render(snap) {
    if (!this.geom || !this.visible) return false;
    const eng = this.M.engine, R = this.M.renderer;
    if (eng === 'css' || !R) return false;            // static CPU overlay
    const hasSnap = !!(snap && snap.uploaded);
    if (eng === 'snapshot' && !hasSnap) return false;
    const useSnap = hasSnap && (eng === 'snapshot' || this.fuse.length > 0);
    const f = this.frame;
    const rk = (o) => [o.rect.left, o.rect.top, o.rect.width, o.rect.height].map((v) => v.toFixed(1)).join(',');
    const key = [eng, this.press.toFixed(3),
      useSnap ? [f.cx.toFixed(2), f.cy.toFixed(2), global.scrollX, global.scrollY, snap.version, this.M.liveVersion].join(',') : '',
      useSnap ? f.A.map((v) => v.toFixed(4)).join(',') : '',
      this.fuse.map(rk).join(';'), useSnap ? this.others.map(rk).join(';') : ''].join('|');
    if (!this.dirty && key === this.key) return false;
    this.key = key;
    this.dirty = false;
    // while fused, the canvas paints the whole merged shape; the element's own backdrop would filter the
    // content of the glass underneath a second time
    this.setBackdrop(!(useSnap && this.fuse.length));
    R.draw(this, useSnap ? snap : null, eng === 'native');
    return true;
  }

  setBackdrop(on) {
    if (this.backdropOn === on) return;
    this.backdropOn = on;
    const bf = !on ? 'none' : this.M.engine === 'native' && this.filter ? `url(#${this.id})` : this.cssBackdrop();
    this.el.style.backdropFilter = bf;
    this.el.style.webkitBackdropFilter = bf;
  }

  overlaps(rect) {
    const r = this.rect, G = this.geom;
    if (!r || !G) return false;
    const pad = G.pad;
    return rect.right > r.left - pad && rect.left < r.right + pad && rect.bottom > r.top - pad && rect.top < r.bottom + pad;
  }

  /** remove the glass and restore the element */
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.ptr) { for (const k in this.ptr.h) this.el.removeEventListener(k, this.ptr.h[k]); this.ptr = null; }
    if (this.dragH) { for (const k in this.dragH) this.el.removeEventListener(k, this.dragH[k], k === 'click'); this.dragH = null; }
    this.ro.disconnect();
    this.removeFilter();
    this.canvas.remove();
    this.el.removeAttribute('data-lg-glass');
    Object.assign(this.el.style, this.saved);
    this.M.forget(this);
  }
}

function boxBlurH(src, dst, w, h, r) {
  const iarr = 1 / (r + r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[row + clamp(x, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      dst[row + x] = acc * iarr;
      acc += src[row + Math.min(x + r + 1, w - 1)] - src[row + Math.max(x - r, 0)];
    }
  }
}
function boxBlurV(src, dst, w, h, r) {
  const iarr = 1 / (r + r + 1);
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += src[clamp(y, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = acc * iarr;
      acc += src[Math.min(y + r + 1, h - 1) * w + x] - src[Math.max(y - r, 0) * w + x];
    }
  }
}

// how much to darken, as a function of linear luminance (so white keeps 3:1)
const NEED_TABLE = (() => {
  const v = [];
  for (let i = 0; i <= 32; i++) {
    const L = i / 32;
    v.push(L <= 0.3 ? '0' : (1 - Math.pow(0.3 / L, 1 / 2.2)).toFixed(4));
  }
  return v.join(' ');
})();

// ------------------------------------------------------------------ manager (one per page)
class Manager {
  constructor() {
    this.cfg = Object.assign({}, CONFIG);
    this.glasses = [];
    this.map = new WeakMap();
    this.started = false;
    this.stats = {
      engine: '', glasses: 0, captures: 0, lastCaptureMs: 0, captureOnlyMs: 0, uploadMs: 0, renderMs: 0,
      snapW: 0, snapH: 0, scale: 0, live: 0, holes: 0, error: '', parts: null,
    };
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.dpr = Math.min(global.devicePixelRatio || 1, 2);
    this.renderer = null;
    try { this.renderer = new Renderer(); } catch (err) { this.glError = String(err.message || err); }
    if (this.renderer) this.watchContext(this.renderer.canvas);
    this.capturer = new Capturer(this);
    this.snap = null; this.snapVersion = 0; this.liveVersion = 0;
    this.lum = null;
    this.liveAt = new WeakMap();
    this.scratch = document.createElement('canvas');
    this.engine = this.resolve(this.cfg.engine);
    this.stats.engine = this.engine;
    this.watch();
    this.tick = this.tick.bind(this);
    this.lastTick = performance.now();
    requestAnimationFrame(this.tick);
  }

  // a lost WebGL context (GPU reset, too many contexts) is rebuilt and everything redrawn
  watchContext(canvas) {
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.contextLost = true; });
    canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      try { this.renderer = new Renderer(canvas); } catch (err) { this.renderer = null; this.engine = this.resolve(this.cfg.engine); return; }
      if (this.snap) this.snap.uploaded = false;
      for (const g of this.glasses) { g.haloTex = null; g.buildHalo(); g.dirty = true; g.key = ''; }
      this.refresh();
    });
  }

  resolve(e) {
    const gl = this.started ? !!this.renderer : typeof global.WebGL2RenderingContext !== 'undefined';
    if (e === 'css') return 'css';
    if (e === 'native' && IS_CHROMIUM) return 'native';
    if (e === 'snapshot' && gl) return 'snapshot';
    return IS_CHROMIUM ? 'native' : gl ? 'snapshot' : 'css';
  }

  config(opts) {
    const prev = Object.assign({}, this.cfg);
    Object.assign(this.cfg, opts || {});
    if (!this.started) return Object.assign({}, this.cfg);
    if (prev.engine !== this.cfg.engine) this.setEngine(this.cfg.engine);
    if (prev.captureScale !== this.cfg.captureScale || prev.capturer !== this.cfg.capturer) this.refresh();
    return Object.assign({}, this.cfg);
  }

  setEngine(e) {
    this.engine = this.resolve(e);
    this.stats.engine = this.engine;
    for (const g of this.glasses) {
      if (this.engine !== 'native') g.removeFilter();
      g.el.style.backgroundImage = g.saved.backgroundImage;
      if (g.geom) g.rebuildEngine();
    }
    this.refresh();
  }

  refresh() { if (!this.started) return; this.capturer.next = 0; this.capturer.request(); }

  create(el, opts) {
    if (!(el instanceof Element)) throw new TypeError('LiquidGlass.create needs an element');
    this.start();
    const old = this.map.get(el);
    if (old) return opts ? old.set(opts) : old;
    const g = new Glass(this, el, opts);
    this.glasses.push(g);
    this.map.set(el, g);
    this.capturer.request();
    return g;
  }

  forget(g) {
    this.glasses = this.glasses.filter((x) => x !== g);
    if (this.map.get(g.el) === g) this.map.delete(g.el);
  }

  wantsCapture() {
    if (this.cfg.capturer === 'modern-screenshot' && !global.modernScreenshot) return false;
    if (!this.glasses.length) return false;
    if (this.engine === 'snapshot' || this.fusing) return true;
    return this.glasses.some((g) => g.p.adaptive);
  }
  // the page as a texture: always in the snapshot engine; in the native engine only while glass is fusing
  needsTexture() { return !!this.renderer && (this.engine === 'snapshot' || this.fusing); }

  defs() {
    if (!this.svg) {
      this.svg = document.createElementNS(SVGNS, 'svg');
      this.svg.setAttribute('width', '0'); this.svg.setAttribute('height', '0');
      this.svg.setAttribute('aria-hidden', 'true');
      this.svg.setAttribute('data-lg-ignore', '');
      this.svg.style.position = 'absolute';
      this.svg.style.left = '0'; this.svg.style.top = '0';
      document.body.appendChild(this.svg);
    }
    return this.svg;
  }

  onSnapshot(snap) {
    snap.version = ++this.snapVersion;
    this.snap = snap;
    if (this.needsTexture()) {
      this.renderer.setSnapshot(snap.canvas);
      snap.uploaded = true;
      this.liveAt = new WeakMap();
    }
    this.stats.snapW = snap.w; this.stats.snapH = snap.h; this.stats.scale = snap.scale;
    // coarse luminance grid, in document coordinates
    let c = snap.canvas.lumCanvas;
    if (!c) {
      const g = document.createElement('canvas');
      g.width = LUM_W; g.height = Math.max(1, Math.round(LUM_W * snap.h / snap.w));
      g.getContext('2d').drawImage(snap.canvas, 0, 0, g.width, g.height);
      c = g;
    }
    const lw = c.width, lh = c.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    try {
      const d = ctx.getImageData(0, 0, lw, lh).data;
      const L = new Float32Array(lw * lh);
      for (let i = 0; i < L.length; i++) {
        L[i] = 0.2126 * (d[i * 4] / 255) ** 2.2 + 0.7152 * (d[i * 4 + 1] / 255) ** 2.2 + 0.0722 * (d[i * 4 + 2] / 255) ** 2.2;
      }
      this.lum = { L, lw, lh, ox: snap.ox, oy: snap.oy, k: lw / snap.cssW };
    } catch (err) { this.lum = null; }
  }

  // average linear luminance of the page under a screen rectangle (centre, half sizes)
  luminanceAt(cx, cy, hw, hh) {
    const g = this.lum;
    if (!g) return null;
    let s = 0, n = 0;
    for (let j = -2; j <= 2; j++) {
      for (let i = -2; i <= 2; i++) {
        const x = clamp(Math.floor((cx + i * hw / 2 + global.scrollX - g.ox) * g.k), 0, g.lw - 1);
        const y = clamp(Math.floor((cy + j * hh / 2 + global.scrollY - g.oy) * g.k), 0, g.lh - 1);
        s += g.L[y * g.lw + x]; n++;
      }
    }
    return s / n;
  }

  watch() {
    const req = () => this.capturer.request();
    this.mo = new MutationObserver((recs) => { if (recs.some(mutationMatters)) req(); });
    this.mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    const onEvt = (e) => { if (!isIgnored(e.target)) req(); };
    document.addEventListener('input', onEvt, true);
    document.addEventListener('change', onEvt, true);
    document.addEventListener('load', onEvt, true);
    global.addEventListener('resize', () => {
      const d = Math.min(global.devicePixelRatio || 1, 2);
      if (d !== this.dpr) { this.dpr = d; for (const g of this.glasses) g.geom = null; }
      req();
    });
    if (document.fonts) {
      document.fonts.ready.then(req);
      if (document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', req);
    }
    try { new ResizeObserver(req).observe(document.body); } catch (err) { /* ignore */ }
    // finite CSS animations / transitions: refresh while they run (infinite ones become holes)
    if (document.getAnimations) {
      setInterval(() => {
        if (!this.wantsCapture()) return;
        const busy = document.getAnimations().some((a) => {
          if (a.playState !== 'running' || !a.effect || !a.effect.target) return false;
          if (isIgnored(a.effect.target)) return false;
          const tm = a.effect.getComputedTiming && a.effect.getComputedTiming();
          return tm && isFinite(tm.endTime);
        });
        if (busy) req();
      }, 300);
    }
  }

  // canvas / video marked data-lg-live go straight into the texture, only while a glass is over them
  patchLive(now) {
    const R = this.renderer, snap = this.snap;
    if (!R || !snap || !snap.uploaded || !this.needsTexture()) return 0;
    let n = 0;
    const minDt = 1000 / this.cfg.liveFps;
    for (const el of document.querySelectorAll('[data-lg-live]')) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (!this.glasses.some((g) => g.overlaps(r))) continue;
      const last = this.liveAt.get(el) || 0;
      if (now - last < minDt) { n++; continue; }
      this.liveAt.set(el, now);
      const x0 = Math.round((r.left + global.scrollX - snap.ox) * snap.scale);
      const y0 = Math.round((r.top + global.scrollY - snap.oy) * snap.scale);
      const w = Math.round(r.width * snap.scale), h = Math.round(r.height * snap.scale);
      const cx0 = Math.max(0, x0), cy0 = Math.max(0, y0);
      const cx1 = Math.min(snap.w, x0 + w), cy1 = Math.min(snap.h, y0 + h);
      if (cx1 <= cx0 || cy1 <= cy0) continue;
      const sc = this.scratch;
      sc.width = cx1 - cx0; sc.height = cy1 - cy0;
      const ctx = sc.getContext('2d');
      const iw = el.width || el.videoWidth || r.width, ih = el.height || el.videoHeight || r.height;
      try {
        ctx.drawImage(el, (cx0 - x0) / w * iw, (cy0 - y0) / h * ih, sc.width / w * iw, sc.height / h * ih, 0, 0, sc.width, sc.height);
        R.patch(cx0, cy0, sc);
        n++;
      } catch (err) { /* cross-origin media cannot be read */ }
    }
    if (n) this.liveVersion++;
    return n;
  }

  tick(now) {
    const dt = Math.min(0.05, Math.max(0, (now - this.lastTick) / 1000));
    this.lastTick = now;
    for (const g of this.glasses.slice()) if (!g.el.isConnected) g.destroy();
    const t0 = performance.now();
    // pass 1: positions and layers
    for (const g of this.glasses) { g.stepPointer(dt); g.measureFrame(); }
    // pass 2: who fuses with whom (same layer, closer than blend), who just overlaps (a hole)
    let fusing = false;
    for (const g of this.glasses) {
      g.fuse = []; g.others = [];
      if (!g.visible) continue;
      for (const o of this.glasses) {
        if (o === g || !o.visible) continue;
        const gap = g.gapTo(o);
        if (g.p.merge && o.p.merge && o.layer === g.layer && g.material() === o.material() && gap < Math.min(g.p.blend, o.p.blend)) {
          if (g.fuse.length < 8) g.fuse.push(o);
        } else if (g.overlaps(o.rect) && g.others.length < 8) g.others.push(o);
      }
      if (g.fuse.length) fusing = true;
    }
    if (fusing !== this.fusing) {
      this.fusing = fusing;
      if (fusing && this.engine === 'native' && !(this.snap && this.snap.uploaded && this.snap.scale >= this.cfg.captureScale * 0.9)) this.refresh();
    }
    const live = this.patchLive(now);
    // pass 3: draw what changed
    let drew = 0;
    if (!this.contextLost) for (const g of this.glasses) if (g.render(this.snap)) drew++;
    const cost = performance.now() - t0;
    if (drew || live) this.stats.renderMs = this.stats.renderMs * 0.9 + cost * 0.1;
    this.stats.live = live;
    this.stats.glasses = this.glasses.length;
    requestAnimationFrame(this.tick);
  }
}

const M = new Manager();
if (darkMQ) {
  const onScheme = () => { for (const g of M.glasses) if (g.user.preset === 'auto') g.set({}); };
  if (darkMQ.addEventListener) darkMQ.addEventListener('change', onScheme); else if (darkMQ.addListener) darkMQ.addListener(onScheme);
}

// ------------------------------------------------------------------ declarative: [data-liquid-glass]
function scan(root) {
  if (!root || root.nodeType !== 1) return;
  const list = root.matches('[data-liquid-glass]') ? [root] : [];
  for (const el of root.querySelectorAll('[data-liquid-glass]')) list.push(el);
  for (const el of list) {
    if (M.map.get(el)) continue;
    const g = M.create(el, parseAttr(el.getAttribute('data-liquid-glass')));
    g.auto = true;
  }
}
function autoInit() {
  if (!M.cfg.auto || M.autoStarted) return;
  M.autoStarted = true;
  scan(document.body);
  new MutationObserver((recs) => {
    for (const r of recs) {
      if (r.type === 'childList') {
        for (const n of r.addedNodes) if (n.nodeType === 1 && !isSandbox(n)) scan(n);
      } else if (r.type === 'attributes') {
        const el = r.target, g = M.map.get(el);
        if (el.hasAttribute('data-liquid-glass')) {
          const o = parseAttr(el.getAttribute('data-liquid-glass'));
          if (g) g.set(o); else M.create(el, o).auto = true;
        } else if (g && g.auto) g.destroy();
      }
    }
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-liquid-glass'] });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoInit);
else setTimeout(autoInit, 0);

// ------------------------------------------------------------------ public API
global.LiquidGlass = {
  version: VERSION,
  /** turn an element into glass; returns the existing glass if it already is one */
  create: (el, opts) => M.create(el, opts),
  /** the glass on an element, or null */
  get: (el) => M.map.get(el) || null,
  /** global settings: engine, captureScale, capturer, minCaptureInterval, liveFps, auto */
  config: (opts) => M.config(opts),
  /** take a fresh page snapshot now (snapshot engine) */
  refresh: () => M.refresh(),
  destroyAll: () => M.glasses.slice().forEach((g) => g.destroy()),
  get engine() { return M.started ? M.engine : M.resolve(M.cfg.engine); },
  get stats() { return Object.assign({}, M.stats); },
  get supports() { return { native: IS_CHROMIUM, snapshot: M.started ? !!M.renderer : typeof global.WebGL2RenderingContext !== 'undefined', css: true }; },
  presets: PRESETS,
  defaults: DEFAULTS,
};
})(window);
