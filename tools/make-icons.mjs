/* SnapScroll — 產生擴充功能圖示
 *
 *   node tools/make-icons.mjs
 *
 * 為什麼不直接放四個 PNG 進版控：圖示是從程式碼畫出來的，改配色或改形狀
 * 只要動這裡的常數，四個尺寸一次重生成，不會出現「16 版還在用舊顏色」。
 *
 * 零依賴：PNG 是手寫的（IHDR / IDAT / IEND + zlib deflate），
 * 圓角與線條用 SDF 求覆蓋率做抗鋸齒。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT_DIR = path.join(ROOT, 'icons');

const SIZES = [16, 32, 48, 128];

/* 主色：青 → 綠，和介面的強調色一致 */
const COLOR_A = [56, 189, 248];
const COLOR_B = [52, 211, 153];
const INK = [6, 32, 44];

/* ── CRC32（Node 20.15+ 內建，否則自己算）───────────────────────── */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32Manual(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  return crc32Manual(buf);
}

/* ── PNG 寫入 ───────────────────────────────────────────────────── */

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const name = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([length, name, data, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

/* ── 繪圖 ───────────────────────────────────────────────────────── */

function clamp01(v) {
  return v < 0 ? 0 : (v > 1 ? 1 : v);
}

/* 圓角矩形的有號距離場：負值在內部 */
function roundedRectSdf(px, py, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(px - cx) - (halfW - radius);
  const dy = Math.abs(py - cy) - (halfH - radius);
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.min(Math.max(dx, dy), 0) + Math.sqrt(ax * ax + ay * ay) - radius;
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)
  ];
}

function blend(dst, offset, color, alpha) {
  if (alpha <= 0) return;
  const a = clamp01(alpha);
  const inv = 1 - a;
  dst[offset] = Math.round(dst[offset] * inv + color[0] * a);
  dst[offset + 1] = Math.round(dst[offset + 1] * inv + color[1] * a);
  dst[offset + 2] = Math.round(dst[offset + 2] * inv + color[2] * a);
  dst[offset + 3] = Math.round(dst[offset + 3] * inv + 255 * a);
}

/* 三條短線：一張「長頁」的意象 */
const BARS = [
  { x0: 0.26, x1: 0.74, y: 0.295 },
  { x0: 0.26, x1: 0.56, y: 0.455 },
  { x0: 0.26, x1: 0.68, y: 0.615 }
];

function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const pad = Math.max(0.5, size * 0.055);
  const radius = size * 0.235;
  const halfW = (size - pad * 2) / 2;
  const halfH = (size - pad * 2) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const barH = Math.max(1, size * 0.072);
  const aa = Math.max(0.6, size * 0.02);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;

      const d = roundedRectSdf(px, py, cx, cy, halfW, halfH, radius);
      const plate = clamp01(0.5 - d / aa);
      if (plate <= 0) continue;

      const offset = (y * size + x) * 4;
      const t = clamp01((px + py) / (size * 2));
      const bg = mix(COLOR_A, COLOR_B, t);
      blend(rgba, offset, bg, plate);

      for (const bar of BARS) {
        const barCy = size * bar.y + barH / 2;
        const barHalf = (size * (bar.x1 - bar.x0)) / 2;
        const barCx = size * (bar.x0 + (bar.x1 - bar.x0) / 2);
        const bd = roundedRectSdf(px, py, barCx, barCy, barHalf, barH / 2, barH / 2);
        const ink = clamp01(0.5 - bd / aa);
        if (ink > 0) blend(rgba, offset, INK, ink * 0.82 * plate);
      }
    }
  }
  return rgba;
}

/* ── 主程式 ─────────────────────────────────────────────────────── */

fs.mkdirSync(OUT_DIR, { recursive: true });

for (const size of SIZES) {
  const file = path.join(OUT_DIR, `icon${size}.png`);
  const png = encodePng(size, size, renderIcon(size));
  fs.writeFileSync(file, png);
  console.log(`icon${size}.png  ${png.length} bytes  ${size}×${size}`);
}

console.log(`\n圖示已輸出到 ${path.relative(ROOT, OUT_DIR)}\\`);
