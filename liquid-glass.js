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
// refraction offset (and highlight) at a point that is sd px from the outline (negative inside), with outward
// normal (onx, ony); m is the size the bezel and the thickness scale with
function opticsAt(sd, onx, ony, m, P, wantHi) {
  const e = Math.max(-sd, 0);
  const w = Math.max(P.bezel * m, 0.5);
  const t = Math.min(e / w, 1), omt = 1 - t;
  const base = Math.max(1 - Math.pow(omt, P.curve), 1e-5);
  const h = Math.pow(base, 1 / P.curve);
  const dhdt = Math.pow(base, 1 / P.curve - 1) * Math.pow(omt, P.curve - 1);
  const T = P.refract * 0.9 * m;
  const slope = Math.min(dhdt / w * T, 8);
  const inv = 1 / Math.hypot(slope, 1);
  const nx = onx * slope * inv, ny = ony * slope * inv, nz = inv;
  const eta = 1 / P.ior;
  const k = 1 - eta * eta * (1 - nz * nz);
  const c = eta * nz - Math.sqrt(Math.max(k, 0));
  const tz = -eta + c * nz;
  const depth = T * (P.gap + (1 - P.gap) * h);
  const f = depth / Math.max(-tz, 0.15);
  if (!wantHi) return { dx: c * nx * f, dy: c * ny * f, hi: 0 };
  const ld = onx * LX + ony * LY;
  const side = Math.pow(Math.max(ld, 0), 1.5) + 0.6 * Math.pow(Math.max(-ld, 0), 1.5);
  const fres = Math.pow(1 - nz, 5) * (0.3 + 0.7 * side);
  const rimLine = Math.exp(-e / 1.1);
  const rimSoft = Math.exp(-e / (m * 0.1));
  const hi = P.spec * (0.9 * rimLine * (0.22 + 0.78 * side) + 0.3 * fres +
    0.42 * blinnJS(nx, ny, nz, LX, LY) + 0.18 * blinnJS(nx, ny, nz, -LX, -LY) + 0.05 * rimSoft * side);
  return { dx: c * nx * f, dy: c * ny * f, hi };
}
function lensOptics(px, py, G, P) {
  const s = boxSd(px, py, G.hw, G.hh, G.r);
  const o = opticsAt(s.sd, s.nx, s.ny, G.m, P, true);
  o.sd = s.sd;
  return o;
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
uniform vec4 uFuseTint[8];   // that neighbour's CSS background colour (straight alpha)
uniform vec4 uFuseOpt[8];    // that neighbour's bezel, thickness, curve, spec
uniform vec4 uFuseOpt2[8];   // that neighbour's shadow, ior, gap
uniform int uFuseN;
uniform vec4 uTintSelf;      // this glass's CSS background colour
uniform float uOwnTint;      // 1 while this glass hosts the backplate: its CSS background is off, painted here
uniform float uBlend, uPress;
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

// smooth union with the fused neighbours (polynomial smin: shapes only start to melt within uBlend px).
// Mirrored on the CPU by UnionField, which builds the shared backplate's refraction map
float unionSd(vec2 p, float sdSelf, inout vec2 n, inout float mE, inout vec4 tint, inout vec4 opt, inout vec4 opt2) {
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
    tint = mix(uFuseTint[i], tint, h);
    opt = mix(uFuseOpt[i], opt, h);     // glass with different optics melts smoothly too
    opt2 = mix(uFuseOpt2[i], opt2, h);
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
  float bridge = 0.0;          // part of this pixel that no glass box (and so no element background) covers
  float share = 1.0;           // how much of this pixel this glass draws (fused glass splits the merged shape)
  float ownCov = clamp(0.5 - sdSelf * uDpr, 0.0, 1.0);
  vec4 tintE = uTintSelf;
  vec4 opt = vec4(uBezel, uThick, uK, uSpec);   // optics, blended across bridges while fused
  vec4 opt2 = vec4(uShadow, uIor, uGap, 0.0);
  if (uFuseN > 0) {
    // who draws this pixel: own interior is ours; an overlap belongs to the glass painted lowest, so the
    // highlights sit under the content of every glass in the stack; outside every box, the nearest glass
    // draws the bridge. The page behind the merged shape comes from the shared backplate element.
    // The share is soft (a 2 css px ramp) and the shares of neighbouring canvases add up to 1: each canvas has
    // its own pixel grid, so a hard yes/no would leave a seam of double (or no) highlight and shadow
    float wIn = 1.0, wOut = 1.0;
    float uncovered = clamp(0.5 + sdSelf * uDpr, 0.0, 1.0);
    for (int i = 0; i < 8; i++) {
      if (i >= uFuseN) break;
      vec2 nj;
      float sj = rrSd(p - uFuse[i].xy, uFuse[i].zw, uFuseR[i], nj);
      float outJ = clamp(0.5 + sj * 0.5, 0.0, 1.0);
      if (uFuseTop[i] < 0.5) wIn *= outJ;                         // inside a glass painted lower: that one draws
      wOut *= outJ * clamp(0.5 + (sj - sdSelf) * 0.5, 0.0, 1.0);    // outside every box: the nearest draws
      uncovered *= clamp(0.5 + sj * uDpr, 0.0, 1.0);
    }
    float inSelf = clamp(0.5 - sdSelf * 0.5, 0.0, 1.0);
    share = inSelf * wIn + (1.0 - inSelf) * wOut;
    if (share <= 0.0) { o = vec4(0.0); return; }
    sd = unionSd(p, sdSelf, outward, mE, tintE, opt, opt2);
    bridge = uncovered;
  }

  // the drop shadow's size follows the (blended) size of the glass, as shadowGeom() does on the CPU
  vec3 shG = uFuseN > 0 ? vec3(min(mE * 0.12, 10.0), min(mE * 0.2, 16.0), min(mE * 0.04, 4.0)) : uShadowGeom;
  vec2 ps = p - vec2(0.21, 1.0) * shG.x;
  vec2 sn;
  float mS = m;
  vec4 tS = vec4(0.0), oS = vec4(0.0), oS2 = vec4(0.0);
  float sds = boxSd(ps, sn);
  if (uFuseN > 0) sds = unionSd(ps, sds, sn, mS, tS, oS, oS2);
  sds += shG.z;
  float sig = shG.y;
  float sh = opt2.x * (1.0 + 0.7 * uPress) * (0.6 * (1.0 - smoothstep(-sig, sig * 1.2, sds)) + 0.4 * (1.0 - smoothstep(-sig, sig * 3.6, sds)));

  float aa = clamp(0.5 - sd * uDpr, 0.0, 1.0);
  if (aa <= 0.0) { o = vec4(0.0, 0.0, 0.0, sh) * share; return; }

  m = mE;
  float e = max(-sd, 0.0);
  float w = max(opt.x * m, 0.5);
  float t = clamp(e / w, 0.0, 1.0);
  float omt = 1.0 - t;
  float base = max(1.0 - pow(omt, opt.z), 1e-5);
  float h = pow(base, 1.0 / opt.z);
  float dhdt = pow(base, 1.0 / opt.z - 1.0) * pow(omt, opt.z - 1.0);
  float T = opt.y * m;
  float slope = min(dhdt / w * T, 8.0);
  vec3 N = normalize(vec3(outward * slope, 1.0));
  vec3 Tr = refract(vec3(0.0, 0.0, -1.0), N, 1.0 / opt2.y);
  float depth = T * (opt2.z + (1.0 - opt2.z) * h);
  vec2 d = Tr.xy / max(-Tr.z, 0.15) * depth;

  // the refracting rim comes from the snapshot; inside it the live page shows through (CSS backdrop-filter)
  float rim = 1.0 - smoothstep(0.55, 1.0, t);
  if (uNative > 0.5) rim = 0.0;   // native engine: the browser refracts, we add light and shadow
  float holeRim = 0.0;
  vec3 col = vec3(0.0);
  if (rim > 0.001) {
    float bm = mix(0.35, 1.0, t);   // refraction stays crisp right at the edge
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
    // where the snapshot knows nothing, drop the refraction and let the live page show through
    float rk = rim * smoothstep(0.35, 0.95, known);
    holeRim = rim - rk;
    rim = rk;
  }

  float ld = dot(outward, uLight);
  float side = pow(max(ld, 0.0), 1.5) + 0.6 * pow(max(-ld, 0.0), 1.5);
  float fres = pow(1.0 - N.z, 5.0) * (0.3 + 0.7 * side);
  float rimLine = exp(-e / 1.1);
  float rimSoft = exp(-e / (m * 0.10));
  float hi = opt.w * (0.9 * rimLine * (0.22 + 0.78 * side) + 0.3 * fres
           + 0.42 * blinn(N, uLight) + 0.18 * blinn(N, -uLight) + 0.05 * rimSoft * side);
  // no refraction over holes: a plain glassmorphism bevel stands in for it
  hi += holeRim * opt.w * (0.30 * (1.0 - t) * (0.45 + 0.55 * side) + 0.35 * rimLine);
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
  // a bridge has no element under it to carry the CSS background colour, so it is painted here (and so is
  // this glass's own background while it hosts the backplate, which would otherwise filter it)
  vec4 tintP = vec4(tintE.rgb * tintE.a, tintE.a) * bridge + vec4(uTintSelf.rgb * uTintSelf.a, uTintSelf.a) * ownCov * uOwnTint;
  over += tintP * (1.0 - over.a);
  vec4 lens = mix(over, vec4(mix(col * (1.0 - kd), vec3(1.0), hiT), 1.0), rim);
  o = (lens * aa + vec4(0.0, 0.0, 0.0, sh) * (1.0 - aa)) * share;
}`;

const UNIFORMS = ['uSnap', 'uHaloTex', 'uSnapSize', 'uCenterSnap', 'uCanvasPx', 'uHalf', 'uLight', 'uTouch', 'uShadowGeom', 'uA',
  'uSnapScale', 'uDpr', 'uRad', 'uPad', 'uBezel', 'uK', 'uThick', 'uIor', 'uGap', 'uDisp', 'uFrost', 'uSpec',
  'uTint', 'uSat', 'uDim', 'uShadow', 'uTouchAmt', 'uHalo', 'uGlyphDark', 'uNative', 'uOther', 'uOtherR', 'uOtherN',
  'uFuse', 'uFuseR', 'uFuseTop', 'uFuseTint', 'uFuseOpt', 'uFuseOpt2', 'uFuseN', 'uTintSelf', 'uOwnTint', 'uBlend', 'uPress'];

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
  // every copy out of the shared canvas copies its whole drawing buffer, so it should not keep the size of the
  // largest glass ever drawn (a panel opened and closed again): after 2 s of being much bigger than every glass
  // on screen (w x h, device px) it shrinks to that. Never below it, so it does not reallocate back and forth
  endFrame(w, h, now) {
    if (!w || !h || this.canvas.width * this.canvas.height <= w * h * 1.5) { this.bigSince = 0; return; }
    if (!this.bigSince) this.bigSince = now;
    else if (now - this.bigSince > 2000) { this.canvas.width = w; this.canvas.height = h; this.bigSince = 0; }
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
    const fc = this.fuseCBuf || (this.fuseCBuf = new Float32Array(32));
    const fo = this.fuseOBuf || (this.fuseOBuf = new Float32Array(32));
    const fo2 = this.fuseO2Buf || (this.fuseO2Buf = new Float32Array(32));
    const sA = g.frameScale();
    for (let i = 0; i < fuse.length; i++) {
      const o = fuse[i];
      fa[i * 4] = (o.frame.cx - f.cx) / sA; fa[i * 4 + 1] = (o.frame.cy - f.cy) / sA;
      const so = o.frameScale() / sA;   // the neighbour's layout box, in this glass's local px (as Plate.update sees it)
      fa[i * 4 + 2] = o.geom.hw * so; fa[i * 4 + 3] = o.geom.hh * so;
      fr[i] = Math.min(o.geom.r * so, fa[i * 4 + 2], fa[i * 4 + 3]);
      ft[i] = g.paintsBelow(o) ? 1 : 0;
      fc.set(o.tint, i * 4);
      const Q = o.p;
      fo[i * 4] = Q.bezel; fo[i * 4 + 1] = Q.refract * 0.9; fo[i * 4 + 2] = Q.curve; fo[i * 4 + 3] = Q.spec;
      fo2[i * 4] = Q.shadow; fo2[i * 4 + 1] = Q.ior; fo2[i * 4 + 2] = Q.gap; fo2[i * 4 + 3] = 0;
    }
    gl.uniform4fv(U.uFuse, fa);
    gl.uniform1fv(U.uFuseR, fr);
    gl.uniform1fv(U.uFuseTop, ft);
    gl.uniform4fv(U.uFuseTint, fc);
    gl.uniform4fv(U.uFuseOpt, fo);
    gl.uniform4fv(U.uFuseOpt2, fo2);
    gl.uniform1i(U.uFuseN, fuse.length);
    gl.uniform4fv(U.uTintSelf, g.tint);
    gl.uniform1f(U.uOwnTint, g.bgHold ? 1 : 0);
    gl.uniform1f(U.uBlend, g.blendK());
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
    const go = () => {
      this.timer = 0;
      // a capture blocks the main thread for a while (and Safari has no requestIdleCallback): not while a
      // pointer is down, unless the drag goes on for more than 1.5 s
      const now = performance.now();
      if (this.M.pointers.size) {
        if (!this.heldSince) this.heldSince = now;
        if (now - this.heldSince < 1500) { this.timer = setTimeout(go, 250); return; }
      }
      this.heldSince = 0;
      this.waiting = true;
      // run when the main thread is idle, so a capture never lands in the middle of a drag frame
      if (global.requestIdleCallback) global.requestIdleCallback(() => this.run(), { timeout: 400 });
      else this.run();
    };
    this.timer = setTimeout(go, delay);
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

// how much to darken, as a function of linear luminance (so white keeps 3:1)
const NEED_TABLE = (() => {
  const v = [];
  for (let i = 0; i <= 32; i++) {
    const L = i / 32;
    v.push(L <= 0.3 ? '0' : (1 - Math.pow(0.3 / L, 1 / 2.2)).toFixed(4));
  }
  return v.join(' ');
})();

// ------------------------------------------------------------------ SVG filters (native engine)
// edge refraction: the map's R/G channels hold the offset to sample from, three displacements give dispersion
const FILTER_CORE = `
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
  </feComponentTransfer>`;
// one glass with contrast: 'halo': darken around the glyphs drawn by opts.mask, as much as the backdrop needs.
// Only built into the filter while it is on (otherwise it would be eight full-size passes multiplying by 1)
const FILTER_HALO = `
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
// shared backplate of fused glass: the map's B channel is the merged outline, everything outside it is cut away
const FILTER_MASK = `
  <feColorMatrix in="map" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 1 0 0" result="cov"/>
  <feComposite in="glass" in2="cov" operator="in"/>`;

function makeFilter(M, id, tail) {
  const f = document.createElementNS(SVGNS, 'filter');
  f.setAttribute('id', id);
  f.setAttribute('filterUnits', 'userSpaceOnUse');
  f.setAttribute('primitiveUnits', 'userSpaceOnUse');
  f.setAttribute('color-interpolation-filters', 'sRGB');
  f.setAttribute('x', '0'); f.setAttribute('y', '0');
  f.innerHTML = FILTER_CORE + tail;
  M.defs().appendChild(f);
  return f;
}
function setFilterState(f, w, h, url, scale, P) {
  const q = (sel) => f.querySelector(sel);
  for (const el of [f, q('.map')]) { el.setAttribute('width', w); el.setAttribute('height', h); }
  q('.map').setAttribute('href', url);
  q('.dr').setAttribute('scale', (scale * (1 - P.disp)).toFixed(3));
  q('.dg').setAttribute('scale', scale.toFixed(3));
  q('.db').setAttribute('scale', (scale * (1 + P.disp)).toFixed(3));
  q('.blur').setAttribute('stdDeviation', P.frost.toFixed(2));
  q('.sat').setAttribute('values', String(P.sat));
  f.querySelectorAll('.dim').forEach((n) => n.setAttribute('slope', (1 - P.dim).toFixed(3)));
}

// CSS colour -> [r, g, b, a] in 0..1 (anything the canvas understands; unknown -> transparent)
const colorCache = new Map();
let colorCtx = null;
const RGBA_RE = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/;
function parseColor(str) {
  let c = colorCache.get(str);
  if (c) return c;
  let m = RGBA_RE.exec(str || '');
  if (!m && str) {
    colorCtx = colorCtx || document.createElement('canvas').getContext('2d');
    colorCtx.fillStyle = '#010203';
    colorCtx.fillStyle = str;
    const v = colorCtx.fillStyle;
    if (v[0] === '#' && (v !== '#010203' || /^#010203$/i.test(str))) m = [0, parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16)];
    else m = RGBA_RE.exec(v);
  }
  c = m ? [m[1] / 255, m[2] / 255, m[3] / 255, m[4] == null ? 1 : /%$/.test(m[4]) ? parseFloat(m[4]) / 100 : +m[4]] : [0, 0, 0, 0];
  if (colorCache.size > 256) colorCache.clear();
  colorCache.set(str, c);
  return c;
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
    this.plate = null;         // shared backplate while fused with other glass
    this.press = 0;
    this.layer = '';
    this.pageScale = 1;
    this.solid = false;
    this.clips = false;
    this.bgColor = '';
    this.tint = new Float32Array(4);   // CSS background colour, painted on the bridges while fused
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
    this.ro = new ResizeObserver((es) => {
      // the exact (fractional) border box, for telling a transform's scale from offsetWidth's rounding
      const b = es[0] && es[0].borderBoxSize && es[0].borderBoxSize[0];
      if (b) { this.boxW = b.inlineSize; this.boxH = b.blockSize; }
      this.geom = null; this.dirty = true;
    });
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
    const T = this.touch;
    // nothing to redraw while the light stays off, or when it moves by less than 1/64 px
    if (Math.abs(amt - T.amt) < 1e-3 && ((amt < 1e-3 && T.amt < 1e-3) || (Math.abs(x - T.x) < 0.016 && Math.abs(y - T.y) < 0.016))) return;
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
      // the pointer is kept in page coordinates and placed on the glass where the glass is drawn this frame
      // (stepLight), so the light stays under the finger while the glass is dragged
      const st = this.ptr = { over: false, down: false, cx: 0, cy: 0 };
      const pos = (e) => { st.cx = e.clientX; st.cy = e.clientY; };
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
  // the light, after measureFrame: it sits where the pointer is on the glass as drawn this frame
  stepLight(dt) {
    const st = this.ptr;
    if (!st) return;
    const target = st.down ? 1 : st.over ? 0.45 : 0;
    let a = this.touch.amt + (target - this.touch.amt) * (1 - Math.exp(-dt * (target > this.touch.amt ? 14 : 5)));
    if (Math.abs(a - target) < 0.003) a = target;
    this.setLight(a, st.cx - this.frame.cx, st.cy - this.frame.cy);
  }
  // the press, before measureFrame: its scale is part of where the glass is this frame
  stepPress(dt) {
    const st = this.ptr;
    if (!st) return;
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
        // follows from the first move; the 4 px only decide whether this was a tap (then it goes back)
        pointermove: (e) => {
          if (e.pointerId !== d.id) return;
          const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
          if (!d.moved && Math.hypot(dx, dy) >= 4) d.moved = true;
          d.x = d.bx + dx; d.y = d.by + dy;
          el.style.translate = `${d.x}px ${d.y}px`;
        },
        pointerup: (e) => {
          if (e.pointerId !== d.id) return;
          d.id = -1; el.style.cursor = 'grab';
          if (!d.moved && (d.x !== d.bx || d.y !== d.by)) { d.x = d.bx; d.y = d.by; el.style.translate = `${d.x}px ${d.y}px`; }
        },
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
  // (disp too: the merged shape is refracted by one filter with one dispersion)
  material() { const P = this.p; return [P.frost, P.sat, P.tint, P.dim, P.disp].join(','); }

  // fusing needs a shared backplate that sits under both: siblings (same clip and stacking context), both
  // drawn as plain opaque boxes (no hidden or fading glass, no rotation or uneven scale)
  fusesWith(o) {
    return this.p.merge && o.p.merge && this.solid && o.solid && o.el.parentElement === this.el.parentElement &&
      o.layer === this.layer && this.material() === o.material() && this.gapTo(o) < Math.min(this.p.blend, o.p.blend);
  }

  // page px per local css px of this element (its own and its ancestors' transforms and scale)
  frameScale() { return this.pageScale || 1; }
  // how far the smooth union reaches, local css px (the bridges must fit on the canvas around the element)
  blendK() { return Math.max(1, Math.min(this.p.blend, this.geom.pad * 1.6)); }

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

  // While this glass hosts a backplate, its CSS background colour is painted under the plate and would be
  // filtered by it: switch it off (restored exactly afterwards) and let the canvas paint the same colour
  holdBackground(on) {
    if (on === !!this.bgHold) return;
    const st = this.el.style;
    if (on) {
      if (!(this.tint[3] > 0) || getComputedStyle(this.el).backgroundImage !== 'none') return;
      this.bgHold = { value: st.getPropertyValue('background-color'), prio: st.getPropertyPriority('background-color') };
      st.setProperty('background-color', 'transparent', 'important');
    } else {
      st.setProperty('background-color', this.bgHold.value, this.bgHold.prio);
      this.bgHold = null;
    }
    this.dirty = true;
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
    this.backdropOn = !this.plate;   // while fused, the shared backplate is the backdrop
    if (eng === 'native') this.buildNative();
    else {
      this.removeFilter();
      this.applyBackdrop();
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      if (eng === 'css' || !this.M.renderer) this.paintOverlayCPU();
    }
  }

  removeFilter() {
    if (this.filters) { for (const f of this.filters) f.remove(); this.filters = null; }
    this.nativeMap = null;
  }

  buildNative() {
    const G = this.geom, P = this.p, dpr = this.M.dpr;
    // displacement map over the element box
    const sc = Math.min(dpr, 600 / Math.max(G.w, G.h));
    const nw = Math.max(8, Math.round(G.w * sc)), nh = Math.max(8, Math.round(G.h * sc));
    const mc = document.createElement('canvas');
    mc.width = nw; mc.height = nh;
    const mctx = mc.getContext('2d', { willReadFrequently: true });
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
        const s = boxSd(lx, ly, G.hw, G.hh, G.r);
        if (s.sd > 0.5) continue;
        const o = opticsAt(s.sd, s.nx, s.ny, G.m, P, false);
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
    this.nativeMap = { url: mc.toDataURL(), scale };
    this.commitNative();
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

  // The SVG filter exists twice. A change is written into the copy that is not on screen and backdrop-filter
  // is then pointed at it, so Chrome rebuilds the filter at once and the element never shows a frame
  // without (or with a half-updated) backdrop.
  commitNative() {
    if (!this.nativeMap || !this.geom) return;
    const G = this.geom, P = this.p;
    if (!this.filters) { this.filters = [makeFilter(this.M, this.id + 'a', ''), makeFilter(this.M, this.id + 'b', '')]; this.fi = 0; }
    const f = this.filters[this.fi ^ 1];
    const on = !!(P.contrast === 'halo' && this.haloCanvas && P.glyphDark < 0.5);
    if ((f.getAttribute('data-halo') === '1') !== on) { f.innerHTML = FILTER_CORE + (on ? FILTER_HALO : ''); f.setAttribute('data-halo', on ? '1' : '0'); }
    setFilterState(f, G.w, G.h, this.nativeMap.url, this.nativeMap.scale, P);
    if (on) {
      const halo = f.querySelector('.halo');
      halo.setAttribute('width', G.w); halo.setAttribute('height', G.h);
      if (halo.getAttribute('href') !== this.haloUrl) halo.setAttribute('href', this.haloUrl);
      f.querySelectorAll('.fac').forEach((n) => n.setAttribute('slope', '-1'));
    }
    this.fi ^= 1;
    this.applyBackdrop();
  }

  applyNativeHalo() { if (this.filters) this.commitNative(); }

  // pass 1 of every frame: where is the glass, what layer is it on
  measureFrame() {
    this.visible = false;
    if (!this.ensureGeom()) return false;
    const r = this.el.getBoundingClientRect();
    if (!r.width && !r.height) return false;   // hidden this frame; its ResizeObserver resets geom later
    const cs = getComputedStyle(this.el);
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    let A = [1, 0, 0, 1];
    if (cs.transform && cs.transform !== 'none') {
      const mm = new DOMMatrixReadOnly(cs.transform);
      A = [mm.a, mm.b, mm.c, mm.d];
    }
    this.frame.cx = cx; this.frame.cy = cy; this.frame.A = A;
    const sx = r.width / (this.boxW || this.geom.w), sy = r.height / (this.boxH || this.geom.h);
    this.pageScale = (sx + sy) / 2 || 1;
    this.solid = cs.visibility === 'visible' && +cs.opacity >= 0.999 && Math.abs(A[1]) < 1e-3 && Math.abs(A[2]) < 1e-3 &&
      Math.abs(sx - sy) <= 0.002 * Math.max(sx, sy);
    this.clips = cs.overflowX !== 'visible' || cs.overflowY !== 'visible' || /paint|strict|content/.test(cs.contain || '') ||
      (cs.clipPath && cs.clipPath !== 'none');
    if (!this.bgHold && cs.backgroundColor !== this.bgColor) { this.bgColor = cs.backgroundColor; this.tint.set(parseColor(this.bgColor)); }
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
    // only the snapshot engine samples the page; fused glass in the native engine is refracted live by the
    // shared backplate, the canvas adds light, shadow and the bridges' background colour
    const useSnap = eng === 'snapshot' && !!(snap && snap.uploaded);
    if (eng === 'snapshot' && !useSnap) return false;
    const f = this.frame;
    const rk = (o) => [o.rect.left, o.rect.top, o.rect.width, o.rect.height].map((v) => v.toFixed(1)).join(',') + o.bgColor;
    const key = [eng, this.press.toFixed(3), this.bgColor, this.bgHold ? 'h' : '',
      useSnap ? [f.cx.toFixed(2), f.cy.toFixed(2), global.scrollX, global.scrollY, snap.version].join(',') : '',
      useSnap ? f.A.map((v) => v.toFixed(4)).join(',') : '',
      this.fuse.length ? rk(this) + ':' + this.fuse.map(rk).join(';') : '', useSnap ? this.others.map(rk).join(';') : ''].join('|');
    if (!this.dirty && key === this.key) return false;
    this.key = key;
    this.dirty = false;
    R.draw(this, useSnap ? snap : null, eng === 'native');
    return true;
  }

  // the element's own backdrop is switched off while a shared backplate shows the page under the merged shape
  setBackdrop(on) {
    if (this.backdropOn === on) return;
    this.backdropOn = on;
    this.applyBackdrop();
  }
  applyBackdrop() {
    const bf = !this.backdropOn ? 'none' : this.M.engine === 'native' && this.filters ? `url(#${this.filters[this.fi].id})` : this.cssBackdrop();
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

// ------------------------------------------------------------------ shared backplate of fused glass
// While glass is fused, one extra element painted right under the group shows the page through the whole
// merged shape, and the glass elements switch their own backdrop off (otherwise the upper glass would filter
// the lower one a second time and every box would keep its own inner edge).
//   native    SVG backdrop filter whose refraction map is built from the merged outline
//   snapshot  the glass's CSS backdrop filter, clipped to the merged outline (the canvases draw the rim)
// Either way it is the live page that gets filtered: nothing behind the glass changes when it fuses, and
// fusing never needs a page snapshot. The glass canvases still draw highlights, shadow and bridge colour.

// The merged outline as a field over the plate, in plate px. at() computes it the way the glass that draws
// that pixel does in the shader (ownership test, then unionSd() over that glass's own neighbours), so the
// backplate and the highlights line up exactly. Members are given in paint order.
class UnionField {
  constructor(D) {
    const N = this.N = D.length, F = () => new Float64Array(N);
    this.cx = F(); this.cy = F(); this.ax = F(); this.ay = F(); this.r = F(); this.m = F(); this.k = F();
    this.sd = F(); this.nx = F(); this.ny = F();
    this.P = D.map((d) => d.P);
    this.opt = D.map((d) => [d.P.bezel, d.P.refract, d.P.curve, d.P.ior, d.P.gap]);
    this.uP = { bezel: 0, refract: 0, curve: 0, ior: 0, gap: 0, spec: 1 };   // optics at the last point
    this.nb = D.map((d) => Int32Array.from(d.nb.map((e) => D.indexOf(e))));
    D.forEach((d, i) => {
      this.cx[i] = d.cx; this.cy[i] = d.cy; this.ax[i] = d.hw - d.r; this.ay[i] = d.hh - d.r;
      this.r[i] = d.r; this.m[i] = d.m; this.k[i] = d.k;
    });
    this.kMax = Math.max(...this.k);
    this.usd = 0; this.unx = 0; this.uny = 0; this.um = 0; this.uo = 0;
  }
  // signed distance and outward normal of every member's rounded box (rrSd() in the shader); returns the min
  boxes(x, y) {
    let best = Infinity;
    for (let i = 0; i < this.N; i++) {
      const lx = x - this.cx[i], ly = y - this.cy[i];
      const qx = (lx < 0 ? -lx : lx) - this.ax[i], qy = (ly < 0 ? -ly : ly) - this.ay[i];
      let s, nx = 0, ny = 1;
      if (qx > 0 && qy > 0) { const lo = Math.sqrt(qx * qx + qy * qy); s = lo - this.r[i]; nx = qx / lo; ny = qy / lo; }
      else if (qx > qy) { s = qx - this.r[i]; nx = 1; ny = 0; }
      else s = qy - this.r[i];
      this.sd[i] = s; this.nx[i] = lx < 0 ? -nx : nx; this.ny[i] = ly < 0 ? -ny : ny;
      if (s < best) best = s;
    }
    return best;
  }
  at(x, y) {
    this.boxes(x, y);
    let inside = -1, near = 0;
    for (let i = 0; i < this.N; i++) {
      if (this.sd[i] < 0 && inside < 0) inside = i;   // an overlap belongs to the lowest glass
      if (this.sd[i] < this.sd[near] - 1e-3) near = i;   // ties go to the lower glass, as in the shader
    }
    const o = inside >= 0 ? inside : near, k = this.k[o], nb = this.nb[o];
    let sd = this.sd[o], nx = this.nx[o], ny = this.ny[o], m = this.m[o];
    const oo = this.opt[o];
    let b = oo[0], rf = oo[1], cv = oo[2], io = oo[3], gp = oo[4];
    for (let q = 0; q < nb.length; q++) {
      const j = nb[q], sj = this.sd[j];
      let h = 0.5 + 0.5 * (sj - sd) / k;
      h = h < 0 ? 0 : h > 1 ? 1 : h;
      sd = sj + (sd - sj) * h - k * h * (1 - h);
      const ux = this.nx[j] + (nx - this.nx[j]) * h + 1e-5, uy = this.ny[j] + (ny - this.ny[j]) * h + 1e-5;
      const il = 1 / Math.sqrt(ux * ux + uy * uy);
      nx = ux * il; ny = uy * il;
      m = this.m[j] + (m - this.m[j]) * h;
      const oj = this.opt[j];   // optics melt like the shape (as in the shader)
      b = oj[0] + (b - oj[0]) * h; rf = oj[1] + (rf - oj[1]) * h; cv = oj[2] + (cv - oj[2]) * h;
      io = oj[3] + (io - oj[3]) * h; gp = oj[4] + (gp - oj[4]) * h;
    }
    const uP = this.uP;
    uP.bezel = b; uP.refract = rf; uP.curve = cv; uP.ior = io; uP.gap = gp;
    this.usd = sd; this.unx = nx; this.uny = ny; this.um = m; this.uo = o;
    return sd;
  }
  // over a disc of radius rad around (x, y): 1 = certainly outside by more than out, -1 = certainly deeper
  // than inn inside, 0 = look at every pixel. The union only differs from the closest box where two boxes are
  // within k of each other, so blocks away from the joints are decided from the boxes alone
  classify(x, y, rad, out, inn) {
    const mn = this.boxes(x, y), kMax = this.kMax;
    let close = 0;
    for (let i = 0; i < this.N; i++) if (this.sd[i] - rad < mn + rad + kMax) close++;
    const drop = close > 1 ? kMax * 0.25 * (close - 1) : 0;
    if (mn - rad - drop > out) return 1;
    if (mn + rad < -inn) return -1;
    return 0;
  }
}
// outline of the region f < 0 (grid of nx * ny values, step gs px) as SVG path data, for fill-rule evenodd.
// Marching squares; crossing points are keyed by grid edge: horizontal 2 * node, vertical 2 * node + 1
function contourPath(f, nx, ny, gs) {
  const link = new Map();
  const add = (a, b) => {
    let l = link.get(a); if (!l) link.set(a, l = []); l.push(b);
    l = link.get(b); if (!l) link.set(b, l = []); l.push(a);
  };
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const n = j * nx + i;
      const a = f[n] < 0, b = f[n + 1] < 0, c = f[n + nx + 1] < 0, d = f[n + nx] < 0;   // tl tr br bl
      if (a === b && b === c && c === d) continue;
      const T = 2 * n, R = 2 * (n + 1) + 1, B = 2 * (n + nx), L = 2 * n + 1;
      const cut = [];
      if (a !== b) cut.push(T);
      if (b !== c) cut.push(R);
      if (c !== d) cut.push(B);
      if (d !== a) cut.push(L);
      if (cut.length === 2) { add(cut[0], cut[1]); continue; }
      // saddle: the centre decides whether the two inside corners connect
      const mid = (f[n] + f[n + 1] + f[n + nx + 1] + f[n + nx]) / 4 < 0;
      if (mid === a) { add(T, R); add(B, L); } else { add(T, L); add(R, B); }
    }
  }
  const at = (key) => {
    const n = key >> 1, i = n % nx, j = (n - i) / nx;
    if (key & 1) { const t = f[n] / (f[n] - f[n + nx]); return ((i * gs).toFixed(2) + ' ' + ((j + t) * gs).toFixed(2)); }
    const t = f[n] / (f[n] - f[n + 1]); return (((i + t) * gs).toFixed(2) + ' ' + (j * gs).toFixed(2));
  };
  const seen = new Set();
  let out = '';
  for (const start of link.keys()) {
    if (seen.has(start)) continue;
    let prev = -1, cur = start, first = true;
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur);
      out += (first ? 'M' : 'L') + at(cur);
      first = false;
      const l = link.get(cur);
      const next = l[0] !== prev ? l[0] : l[1];
      prev = cur; cur = next;
    }
    out += 'Z';
  }
  return out || 'M0 0Z';
}

let plateUid = 0;
class Plate {
  constructor(M, anchor) {
    this.M = M;
    this.anchor = anchor;
    this.id = 'lgp' + (++plateUid);
    this.el = document.createElement('div');
    this.el.setAttribute('data-lg-ignore', '');
    this.el.setAttribute('aria-hidden', 'true');
    this.filters = null; this.fi = 0;
    this.place();
  }

  // Inside the lowest glass of the group, right after its canvas and under it (z-index -2 in the glass's own
  // stacking context): painted after everything below the group and before every member's content, clipped,
  // scrolled and transformed with the glass, and without adding an element among the page's own children.
  // The glass's backdrop-filter is off while it is fused, so it is not a backdrop root for the plate.
  place() {
    const a = this.anchor;
    this.el.style.cssText = 'all:initial;display:block;margin:0;padding:0;border:0;box-sizing:border-box;pointer-events:none;' +
      'position:absolute;z-index:-2;left:0;top:0;width:0;height:0;';
    a.el.insertBefore(this.el, a.canvas.nextSibling);
    a.holdBackground(true);
    this.tx = 0; this.ty = 0; this.w = -1; this.h = -1; this.key = ''; this.bf = '';
    this.measure();
  }
  inPlace() { return this.el.parentNode === this.anchor.el; }

  // pass 1: where the plate's own origin is on the page (it is positioned with a translate from there), in
  // the glass's local css px (s = page px per local px)
  measure() {
    const r = this.el.getBoundingClientRect(), s = this.anchor.frameScale();
    this.ox = r.left - this.tx * s; this.oy = r.top - this.ty * s;
  }

  update(members) {
    const native = this.M.engine === 'native';
    // members in page px; the plate covers their bounding box plus room for what the smooth union adds
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const D = members.map((g) => {
      const s = g.frameScale(), G = g.geom, hw = G.hw * s, hh = G.hh * s, cx = g.frame.cx, cy = g.frame.cy;
      x0 = Math.min(x0, cx - hw); y0 = Math.min(y0, cy - hh); x1 = Math.max(x1, cx + hw); y1 = Math.max(y1, cy + hh);
      return { g, cx, cy, hw, hh, r: Math.min(G.r * s, hw, hh), m: Math.min(hw, hh), k: g.blendK() * s, P: g.p, sd: 0, nx: 0, ny: 0, nb: null };
    });
    let grow = 0;
    for (const d of D) {
      d.nb = d.g.fuse.map((o) => D.find((e) => e.g === o)).filter(Boolean);
      grow = Math.max(grow, d.k * 0.25 * Math.max(1, d.nb.length));
    }
    grow += 2;
    x0 -= grow; y0 -= grow; x1 += grow; y1 += grow;
    // from here on in the plate's own units: the lowest glass's local css px, from the plate's top left
    const s = this.anchor.frameScale();
    const W = Math.ceil((x1 - x0) / s), H = Math.ceil((y1 - y0) / s);
    for (const d of D) {
      d.cx = (d.cx - x0) / s; d.cy = (d.cy - y0) / s;
      d.hw /= s; d.hh /= s; d.r /= s; d.m /= s; d.k /= s;
    }

    // follows the glass every frame; the outline is only rebuilt when the glass moved relative to each other
    const tx = Math.round((x0 - this.ox) / s * 100) / 100, ty = Math.round((y0 - this.oy) / s * 100) / 100;
    if (tx !== this.tx || ty !== this.ty) { this.tx = tx; this.ty = ty; this.el.style.transform = `translate(${tx}px, ${ty}px)`; }
    if (W !== this.w || H !== this.h) { this.w = W; this.h = H; this.el.style.width = W + 'px'; this.el.style.height = H + 'px'; }
    const key = [native ? 'n' : 's', W, H].concat(D.map((d) =>
      [d.cx, d.cy, d.hw, d.hh, d.r, d.k].map((v) => v.toFixed(2)).join(',') + '/' + d.nb.map((e) => D.indexOf(e)).join('.') +
      '/' + OPTICAL.map((n) => d.P[n]).join(','))).join('|');
    if (key !== this.key) {
      this.key = key;
      const t0 = performance.now();
      if (native) this.buildMap(D, W, H); else this.buildClip(D, W, H);
      const st = this.M.stats;
      st.plateBuilds++;
      st.plateMs = st.plateMs ? st.plateMs * 0.8 + (performance.now() - t0) * 0.2 : performance.now() - t0;
    }
    const bf = native ? (this.filters ? `url(#${this.filters[this.fi].id})` : 'none') : members[0].cssBackdrop();
    if (bf !== this.bf) { this.bf = bf; this.el.style.backdropFilter = bf; this.el.style.webkitBackdropFilter = bf; }
  }

  // native: refraction map of the merged outline (R/G offset, B coverage), written into the filter copy that
  // is not on screen and swapped in by update()
  buildMap(D, W, H) {
    const M = this.M;
    // one map px per css px: the offsets are smooth and get filtered when scaled, a denser map looks the same
    // (measured at dpr 2: max difference 25/255 on 0.03 % of the pixels) and costs four times as much
    const sc = Math.min(1, 1400 / Math.max(W, H), Math.sqrt(1e6 / (W * H)));
    const nw = Math.max(8, Math.round(W * sc)), nh = Math.max(8, Math.round(H * sc));
    const sx = W / nw, sy = H / nh, px = (sx + sy) / 2;
    const c = this.mapCanvas || (this.mapCanvas = document.createElement('canvas'));
    if (c.width !== nw) c.width = nw;
    if (c.height !== nh) c.height = nh;
    // a CPU canvas: the map only goes through putImageData and toDataURL, a GPU one would upload and read back
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const img = ctx.createImageData(nw, nh), data = img.data;
    const U = new UnionField(D);
    let bez = 0, mMax = 0;
    for (const d of D) { bez = Math.max(bez, d.P.bezel); mMax = Math.max(mMax, d.m); }
    const inner = Math.max(bez * mMax, 0.5) + px;
    // flat glass is offset 0 (128) with the coverage in B; offsets (css px) are kept for the bezel band only
    const u32 = new Uint32Array(data.buffer), le = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
    const OUT = le ? 0xff008080 : 0x808000ff, IN = le ? 0xffff8080 : 0x8080ffff;
    u32.fill(OUT);
    const band = [], bdx = [], bdy = [];
    let maxD = 0.5;
    // 8x8 blocks that are clearly outside, or clearly inside the bezel, need no per-pixel work
    for (let by = 0; by < nh; by += 8) {
      const bh = Math.min(8, nh - by);
      for (let bx = 0; bx < nw; bx += 8) {
        const bw = Math.min(8, nw - bx);
        const kind = U.classify((bx + bw / 2) * sx, (by + bh / 2) * sy, 0.5 * Math.hypot(bw * sx, bh * sy), px, inner);
        if (kind === 1) continue;
        for (let j = by; j < by + bh; j++) {
          if (kind === -1) { u32.fill(IN, j * nw + bx, j * nw + bx + bw); continue; }
          for (let i = bx; i < bx + bw; i++) {
            const sd = U.at((i + 0.5) * sx, (j + 0.5) * sy);
            const a = 0.5 - sd / px;
            if (a <= 0) continue;
            const k = j * nw + i;
            data[k * 4 + 2] = a >= 1 ? 255 : Math.round(255 * a);
            const P = U.uP;
            if (-sd >= Math.max(P.bezel * U.um, 0.5)) continue;   // past the bezel the glass is flat
            const o = opticsAt(sd, U.unx, U.uny, U.um, P, false);
            band.push(k); bdx.push(o.dx); bdy.push(o.dy);
            const ad = Math.max(Math.abs(o.dx), Math.abs(o.dy));
            if (ad > maxD) maxD = ad;
          }
        }
      }
    }
    const scale = maxD * 2.02;
    for (let q = 0; q < band.length; q++) {
      const o = band[q] * 4;
      data[o] = Math.round(255 * clamp(0.5 + bdx[q] / scale, 0, 1));
      data[o + 1] = Math.round(255 * clamp(0.5 + bdy[q] / scale, 0, 1));
    }
    ctx.putImageData(img, 0, 0);
    if (!this.filters) { this.filters = [makeFilter(M, this.id + 'a', FILTER_MASK), makeFilter(M, this.id + 'b', FILTER_MASK)]; this.fi = 0; }
    setFilterState(this.filters[this.fi ^ 1], W, H, c.toDataURL(), scale, D[0].P);
    this.fi ^= 1;
  }

  // snapshot: clip the CSS backdrop to the merged outline (vector, so it updates in the same frame everywhere)
  buildClip(D, W, H) {
    let mMin = Infinity;
    for (const d of D) mMin = Math.min(mMin, d.m);
    const gs = clamp(mMin / 8, 0.75, 2);
    const nx = Math.ceil(W / gs) + 1, ny = Math.ceil(H / gs) + 1;
    const f = new Float32Array(nx * ny), U = new UnionField(D);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const v = U.at(i * gs, j * gs);
        f[j * nx + i] = i === 0 || j === 0 || i === nx - 1 || j === ny - 1 ? Math.max(v, 1e-3) : v;
      }
    }
    const clip = `path(evenodd, '${contourPath(f, nx, ny, gs)}')`;
    this.el.style.clipPath = clip;
    this.el.style.webkitClipPath = clip;
  }

  destroy() {
    this.el.remove();
    this.anchor.holdBackground(false);
    if (this.filters) for (const f of this.filters) f.remove();
    this.filters = null;
  }
}

// ------------------------------------------------------------------ manager (one per page)
class Manager {
  constructor() {
    this.cfg = Object.assign({}, CONFIG);
    this.glasses = [];
    this.map = new WeakMap();
    this.started = false;
    this.stats = {
      engine: '', glasses: 0, captures: 0, lastCaptureMs: 0, captureOnlyMs: 0, uploadMs: 0, renderMs: 0,
      snapW: 0, snapH: 0, scale: 0, live: 0, holes: 0, error: '', parts: null, plates: 0, plateBuilds: 0, plateMs: 0, rafMs: 0, inputFrames: 0,
    };
    this.plates = new Map();   // lowest glass of a fused group -> its shared backplate
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.dpr = Math.min(global.devicePixelRatio || 1, 2);
    this.renderer = null;
    try { this.renderer = new Renderer(); } catch (err) { this.glError = String(err.message || err); }
    if (this.renderer) this.watchContext(this.renderer.canvas);
    this.capturer = new Capturer(this);
    this.snap = null; this.snapVersion = 0;
    this.lum = null;
    this.liveAt = new WeakMap();
    this.scratch = document.createElement('canvas');
    this.engine = this.resolve(this.cfg.engine);
    this.stats.engine = this.engine;
    this.watch();
    this.tick = this.tick.bind(this);
    this.lastTick = performance.now();
    this.pumped = false; this.pumpT = 0; this.pumpWall = 0; this.rafDt = 0; this.lastRafT = 0;
    this.hookRaf();
    this.rafId = this.raf(this.tick);
    this.watchThrottle();
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
    this.dropPlates();
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
    const pl = this.plates.get(g);
    if (pl) { pl.destroy(); this.plates.delete(g); }
    this.glasses = this.glasses.filter((x) => x !== g);
    if (this.map.get(g.el) === g) this.map.delete(g.el);
  }

  wantsCapture() {
    if (this.cfg.capturer === 'modern-screenshot' && !global.modernScreenshot) return false;
    if (!this.glasses.length) return false;
    if (this.engine === 'snapshot') return true;
    return this.glasses.some((g) => g.p.adaptive);
  }
  // the page as a texture: only the snapshot engine samples it (fused glass is refracted by the live backplate)
  needsTexture() { return !!this.renderer && this.engine === 'snapshot'; }

  dropPlates() {
    for (const pl of this.plates.values()) pl.destroy();
    this.plates = new Map();
    for (const g of this.glasses) g.plate = null;
  }

  // The backplate lives inside the lowest glass of the group, so it must not be clipped there, and nothing
  // may be painted between the members over their area (it would show through the upper ones unfrosted)
  plateFits(members) {
    const first = members[0], last = members[members.length - 1];
    if (first.clips) return false;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const m of members) { const r = m.rect; x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top); x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom); }
    const layerZ = (z) => (z === 'auto' || z === '0' ? 0 : +z);
    const z = layerZ(getComputedStyle(first.el).zIndex);
    const inGroup = new Set(members.map((m) => m.el));
    for (let n = first.el.nextElementSibling; n && n !== last.el; n = n.nextElementSibling) {
      if (inGroup.has(n)) continue;
      const cs = getComputedStyle(n);
      // painted with the positioned layer: positioned, or a stacking context of its own
      const layered = cs.position !== 'static' || +cs.opacity < 1 || cs.transform !== 'none' || cs.filter !== 'none' ||
        cs.isolation === 'isolate' || cs.zIndex !== 'auto';
      if (!layered || layerZ(cs.zIndex) !== z || cs.display === 'none' || cs.visibility !== 'visible') continue;
      const r = n.getBoundingClientRect();
      if (r.right > x0 && r.left < x1 && r.bottom > y0 && r.top < y1) return false;
    }
    return true;
  }

  // pass 2b: fused glass forms groups (connected through g.fuse); each group gets one backplate
  updatePlates() {
    const next = new Map(), seen = new Set();
    for (const g of this.glasses) g.plate = null;
    for (const g of this.glasses) {
      if (!g.fuse.length || seen.has(g)) continue;
      const members = [], stack = [g];
      seen.add(g);
      while (stack.length) {
        const x = stack.pop();
        members.push(x);
        for (const o of x.fuse) if (!seen.has(o)) { seen.add(o); stack.push(o); }
      }
      members.sort((a, b) => (a.paintsBelow(b) ? -1 : 1));
      if (!this.plateFits(members)) {
        // no backplate can sit under all of them: they stay separate pieces of glass
        for (const m of members) {
          for (const o of m.fuse) if (m.overlaps(o.rect) && m.others.length < 8) m.others.push(o);
          m.fuse = [];
        }
        continue;
      }
      const anchor = members[0];
      let pl = this.plates.get(anchor);
      if (pl && !pl.inPlace()) { pl.destroy(); pl = null; }
      if (!pl) pl = new Plate(this, anchor);
      next.set(anchor, pl);
      for (const m of members) m.plate = pl;
      pl.update(members);
    }
    for (const [a, pl] of this.plates) if (next.get(a) !== pl) pl.destroy();
    this.plates = next;
    this.fusing = next.size > 0;
    this.stats.plates = next.size;
    for (const g of this.glasses) if (g.geom) g.setBackdrop(!g.plate);   // unmeasured glass has no backdrop yet
  }

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
    this.pointers = new Set();
    const up = (e) => this.pointers.delete(e.pointerId);
    global.addEventListener('pointerdown', (e) => this.pointers.add(e.pointerId), true);
    global.addEventListener('pointerup', up, true);
    global.addEventListener('pointercancel', up, true);
    global.addEventListener('blur', () => this.pointers.clear());
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
      const over = this.glasses.filter((g) => g.visible && g.overlaps(r));
      if (!over.length) continue;
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
        for (const g of over) g.dirty = true;   // only glass over this layer has to redraw
        n++;
      } catch (err) { /* cross-origin media cannot be read */ }
    }
    return n;
  }

  // The frame's work has to run after the page's own requestAnimationFrame callbacks, which may move glass:
  // otherwise the backplate and the snapshot sampling trail such glass by a frame. requestAnimationFrame is
  // wrapped so that whenever a page callback runs after the SDK in a frame, the SDK's frame is redone right
  // there and its next callback is re-queued behind the page's, so from the next frame on it simply runs last.
  // (A post-layout ResizeObserver hook would need a layout change every frame, which makes Chrome re-damage
  // and re-composite most of the screen.)
  hookRaf() {
    const raf = global.requestAnimationFrame.bind(global), caf = global.cancelAnimationFrame.bind(global);
    const M = this;
    this.raf = raf;
    // page callbacks waiting for a frame, by the id the page got (the browser's id of the first request);
    // nid is the browser request it currently waits on (a pointer-driven frame can push it back, see pump)
    const pending = this.pendingRaf = new Map();
    const run = (p, t) => {
      pending.delete(p.id);
      try { p.cb(t); } finally {
        // a page callback ran after the SDK in this frame (it was queued later): redo the glass right now,
        // and queue the SDK's next tick behind whatever this callback just queued
        if (M.tickT === t && M.rafId) {
          caf(M.rafId);
          M.rafId = raf(M.tick);
          try { M.rerun(t); } catch (err) { console.warn('[LiquidGlass]', err); }
        }
      }
    };
    const fire = (p) => (t) => {
      if (pending.get(p.id) !== p) return;
      if (M.isPumped()) { p.nid = raf(fire(p)); return; }   // this rendering update already ran it
      run(p, Math.max(t, M.pumpT));
    };
    global.requestAnimationFrame = function requestAnimationFrame(cb) {
      if (typeof cb !== 'function') return raf(cb);
      const p = { cb, id: 0, nid: 0 };
      p.id = p.nid = raf(fire(p));
      pending.set(p.id, p);
      return p.id;
    };
    global.cancelAnimationFrame = function cancelAnimationFrame(id) {
      const p = pending.get(id);
      if (p) { pending.delete(id); caf(p.nid); } else caf(id);
    };
    this.runPending = (t) => {
      for (const p of Array.from(pending.values())) if (pending.get(p.id) === p) { caf(p.nid); run(p, t); }
    };
  }

  // WebKit (Safari, and every browser on iOS / iPadOS) runs requestAnimationFrame at half rate in a cross-origin
  // frame until the user taps or clicks in it, and a touch drag does not count (bugs.webkit.org/show_bug.cgi?id=170534,
  // /show_bug.cgi?id=213344): an embedded page drags at 30 fps although the screen still updates at 60. While
  // that throttle is on, each pointermove runs one frame itself (the page's queued callbacks, then the glass),
  // at most once per rendering update: a 1px sentinel resized with each such frame tells, through a
  // ResizeObserver, when the update has been rendered. Nothing changes while the pointer is still, outside
  // cross-origin frames, in Chromium, or once a tap has lifted the throttle.
  isPumped() { return this.pumped && performance.now() - this.pumpWall < 100; }

  watchThrottle() {
    let xframe = false;
    try { xframe = global.top !== global && !global.top.location.href; } catch (err) { xframe = true; }
    if (!xframe || IS_CHROMIUM || typeof ResizeObserver === 'undefined') return;
    const s = document.createElement('div');
    s.setAttribute('data-lg-ignore', '');
    s.setAttribute('aria-hidden', 'true');
    s.style.cssText = 'all:initial;display:block;position:fixed;left:0;top:0;width:1px;height:1px;visibility:hidden;pointer-events:none;contain:strict;';
    document.documentElement.appendChild(s);
    new ResizeObserver(() => { this.pumped = false; }).observe(s);
    let w = 1;
    // bubble phase on window: the page's own handlers (and the SDK's drag) have already moved things
    global.addEventListener('pointermove', () => {
      if (this.isPumped() || !(this.rafDt > 24) || !s.isConnected) return;
      const t = Math.max(performance.now(), this.pumpT);
      this.pumped = true; this.pumpT = t; this.pumpWall = performance.now();
      w = 3 - w; s.style.width = w + 'px';
      this.stats.inputFrames++;
      this.runPending(t);
      try { this.frame(t); } catch (err) { console.warn('[LiquidGlass]', err); }
    }, { passive: true });
  }

  // a page callback ran after this frame's glass work: redo it, but only if that callback moved some glass
  rerun(t) {
    for (const g of this.glasses) {
      if (!g.rect || !g.el.isConnected) continue;
      const r = g.el.getBoundingClientRect(), o = g.rect;
      if (r.left !== o.left || r.top !== o.top || r.width !== o.width || r.height !== o.height) { this.frame(t); return; }
    }
  }

  tick(now) {
    const d = now - this.lastRafT;
    this.lastRafT = now;
    if (d > 0 && d < 250) this.rafDt = this.rafDt ? this.rafDt * 0.8 + d * 0.2 : d;
    this.stats.rafMs = this.rafDt;
    this.tickT = now;
    this.rafId = this.raf(this.tick);
    if (this.isPumped()) return;   // a pointer-driven frame already ran in this rendering update
    this.frame(now);
  }

  frame(now) {
    const dt = Math.min(0.05, Math.max(0, (now - this.lastTick) / 1000));
    this.lastTick = now;
    for (const g of this.glasses.slice()) if (!g.el.isConnected) g.destroy();
    const t0 = performance.now();
    // pass 1: positions and layers
    for (const g of this.glasses) g.stepPress(dt);
    for (const g of this.glasses) { g.measureFrame(); g.stepLight(dt); }
    for (const pl of this.plates.values()) pl.measure();
    // pass 2: who fuses with whom (same layer, closer than blend), who just overlaps (a hole). Fusing needs
    // the WebGL highlights; in the snapshot engine also the snapshot the rim is refracted from
    const canFuse = !!this.renderer && !this.contextLost &&
      (this.engine === 'native' || (this.engine === 'snapshot' && !!(this.snap && this.snap.uploaded)));
    const cand = new Map();
    for (const g of this.glasses) {
      g.fuse = []; g.others = [];
      if (!g.visible) continue;
      const c = [];
      for (const o of this.glasses) {
        if (o === g || !o.visible) continue;
        if (canFuse && g.fusesWith(o)) c.push(o);
        else if (g.overlaps(o.rect) && g.others.length < 8) g.others.push(o);
      }
      // at most 8 neighbours (the shader's limit): the nearest ones, kept only when the choice is mutual, so
      // every glass knows each neighbour that draws next to it
      if (c.length > 8) c.sort((a, b) => g.gapTo(a) - g.gapTo(b));
      cand.set(g, c);
    }
    for (const [g, c] of cand) {
      for (const o of c) {
        const back = cand.get(o);
        if (c.indexOf(o) < 8 && back.indexOf(g) < 8) g.fuse.push(o);
        else if (g.overlaps(o.rect) && g.others.length < 8) g.others.push(o);
      }
    }
    this.updatePlates();
    const live = this.patchLive(now);
    // pass 3: draw what changed
    let drew = 0;
    if (!this.contextLost) for (const g of this.glasses) if (g.render(this.snap)) drew++;
    if (drew) {
      let w = 0, h = 0;
      for (const g of this.glasses) if (g.visible) { w = Math.max(w, g.canvas.width); h = Math.max(h, g.canvas.height); }
      this.renderer.endFrame(w, h, now);
    }
    const cost = performance.now() - t0;
    if (drew || live) this.stats.renderMs = this.stats.renderMs * 0.9 + cost * 0.1;
    this.stats.live = live;
    this.stats.glasses = this.glasses.length;
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
