/* SnapScroll — 打包成可上傳的 zip
 *
 *   node tools/package.mjs
 *
 * 產出 dist/snapscroll-<version>.zip，內容就是擴充功能的根目錄。
 * 自己寫 ZIP 是因為這個專案不對外依賴任何套件，而 ZIP 的格式本身不複雜：
 * 本地檔頭 + 資料 + 中央目錄 + EOCD，四段而已。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'dist');

const EXCLUDE_DIRS = new Set([
  'node_modules', 'dist', '.git', '.github', '.vscode', '.idea',
  '__pycache__', 'out', '.tmp'
]);

const EXCLUDE_FILES = new Set([
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', '.DS_Store', 'Thumbs.db'
]);

/* 開發用、不進 zip 的路徑前綴（相對於專案根） */
const EXCLUDE_PREFIXES = [
  'tools/e2e',
  'fixtures/',
  'tests/'
];

/* ── CRC32 ──────────────────────────────────────────────────────── */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ── 收集檔案 ───────────────────────────────────────────────────── */

function collect(dir, base, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    const relative = base ? `${base}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      if (EXCLUDE_PREFIXES.some(prefix => (relative + '/').startsWith(prefix))) continue;
      collect(absolute, relative, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (EXCLUDE_FILES.has(entry.name)) continue;
    if (EXCLUDE_PREFIXES.some(prefix => relative.startsWith(prefix))) continue;
    if (entry.name.startsWith('~$')) continue;

    out.push({ name: relative, data: fs.readFileSync(absolute) });
  }
  return out;
}

/* ── ZIP 寫入 ───────────────────────────────────────────────────── */

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function buildZip(files) {
  const now = new Date();
  const { time, day } = dosDateTime(now);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const crc = crc32(file.data);
    const deflated = zlib.deflateRawSync(file.data, { level: 9 });
    const useDeflate = deflated.length < file.data.length;
    const method = useDeflate ? 8 : 0;
    const body = useDeflate ? deflated : file.data;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);      // version needed
    local.writeUInt16LE(0x0800, 6);  // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);     // version made by
    central.writeUInt16LE(20, 6);     // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);     // extra
    central.writeUInt16LE(0, 32);     // comment
    central.writeUInt16LE(0, 34);     // disk
    central.writeUInt16LE(0, 36);     // internal attrs
    central.writeUInt32LE(0, 38);     // external attrs
    central.writeUInt32LE(offset, 42);

    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

/* ── 主程式 ─────────────────────────────────────────────────────── */

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const files = collect(ROOT, '', []);

/* manifest 一定要在 zip 的第一個項目，Chrome 的檢查工具會先讀它 */
files.sort((a, b) => {
  if (a.name === 'manifest.json') return -1;
  if (b.name === 'manifest.json') return 1;
  return a.name.localeCompare(b.name);
});

fs.mkdirSync(DIST, { recursive: true });
const outFile = path.join(DIST, `snapscroll-${manifest.version}.zip`);
const zip = buildZip(files);
fs.writeFileSync(outFile, zip);

const totalRaw = files.reduce((n, f) => n + f.data.length, 0);
console.log(`打包完成：${path.relative(ROOT, outFile)}`);
console.log(`  檔案 ${files.length} 個 · 原始 ${(totalRaw / 1024).toFixed(1)} KB · 壓縮後 ${(zip.length / 1024).toFixed(1)} KB`);
console.log(`  版本 ${manifest.version}`);

for (const f of files.slice(0, 12)) console.log(`   · ${f.name}`);
if (files.length > 12) console.log(`   · … 其餘 ${files.length - 12} 個`);
