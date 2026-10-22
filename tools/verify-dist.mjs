/* SnapScroll — 發佈包驗證
 *
 *   node tools/verify-dist.mjs [zip 路徑]
 *
 * 不依賴任何套件，也不解壓到磁碟：直接讀 zip 中央目錄，把包當唯讀檔案系統，
 * 驗「這個包能不能被 Chrome 載入」的五個前提。任何一項不過就非零退出，
 * 讓 CI 紅燈，而不是等使用者解壓後才發現少檔。
 *
 * 報告同時寫入 dist/verify-report.txt（不進版本庫）。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  devFileLeaks,
  manifestRefs,
  importScriptsOf,
  htmlRefsOf
} from './lib/publish-rules.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'dist');

const manifestOnDisk = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const zipPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(DIST, `snapscroll-${manifestOnDisk.version}.zip`);

/* ── ZIP 讀取 ───────────────────────────────────────────────────── */

function readZip(buf) {
  const EOCD_SIG = 0x06054b50;
  const CENTRAL_SIG = 0x02014b50;

  let eocd = -1;
  const floor = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('找不到 EOCD，不是合法 zip');

  const total = buf.readUInt16LE(eocd + 10);
  let cursor = buf.readUInt32LE(eocd + 16);
  const entries = new Map();

  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(cursor) !== CENTRAL_SIG) {
      throw new Error(`中央目錄第 ${i} 項簽章錯誤`);
    }
    const method = buf.readUInt16LE(cursor + 10);
    const compSize = buf.readUInt32LE(cursor + 20);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');

    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    const data = method === 0 ? raw : zlib.inflateRawSync(raw);

    entries.set(name, data);
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/* ── 檢查 ───────────────────────────────────────────────────────── */

const report = [];
const failures = [];

function check(label, fn) {
  try {
    const detail = fn();
    report.push(`PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    report.push(`FAIL  ${label} — ${err.message}`);
    failures.push(label);
  }
}

function need(condition, message) {
  if (!condition) throw new Error(message);
}

let entries;
let order;
try {
  const buf = fs.readFileSync(zipPath);
  entries = readZip(buf);
  order = [...entries.keys()];
  report.push(`INFO  目標 ${path.relative(ROOT, zipPath)} · ${(buf.length / 1024).toFixed(1)} KB`);
  report.push(`INFO  條目數 ${entries.size}`);
} catch (err) {
  console.error(`讀取失敗：${err.message}`);
  process.exit(1);
}

const manifest = JSON.parse(entries.get('manifest.json').toString('utf8'));

check('manifest.json 是第一個項目', () => {
  need(order[0] === 'manifest.json', `第一個是 ${order[0]}`);
  return 'Chrome 側檢查會先讀它';
});

check('manifest 格式', () => {
  need(manifest.manifest_version === 3, `manifest_version = ${manifest.manifest_version}`);
  need(/^\d+\.\d+(\.\d+){0,2}$/.test(manifest.version), `version 格式異常：${manifest.version}`);
  need(!manifest.default_locale || entries.has(`_locales/${manifest.default_locale}/messages.json`),
    `default_locale ${manifest.default_locale} 目錄不存在`);
  return `v${manifest.version} · MV${manifest.manifest_version} · ${manifest.default_locale}`;
});

check('版本一致', () => {
  need(manifest.version === pkg.version, `manifest ${manifest.version} ≠ package.json ${pkg.version}`);
  return manifest.version;
});

check('manifest 引用齊全', () => {
  const refs = manifestRefs(manifest);
  const missing = refs.filter(ref => !entries.has(ref));
  need(missing.length === 0, `缺少 ${missing.join('、')}`);
  return `${refs.length} 項全部命中`;
});

check('無開發檔案', () => {
  const leaked = devFileLeaks(order);
  need(leaked.length === 0, `混入 ${leaked.join('、')}`);
  return 'tools/ tests/ fixtures/ .github/ 與點檔案皆不在包內';
});

check('service worker 依賴齊全', () => {
  const swPath = manifest.background?.service_worker;
  if (!swPath) return '無 service worker，跳過';
  const source = entries.get(swPath).toString('utf8');
  const refs = [...new Set(importScriptsOf(source))];
  const missing = refs
    .map(ref => ref.replace(/^\/+/, ''))
    .filter(ref => !entries.has(ref));
  need(missing.length === 0, `缺少 ${missing.join('、')}`);
  return `${refs.length} 個 importScripts 目標全部命中`;
});

check('頁面資源齊全', () => {
  let scanned = 0;
  let refs = 0;
  for (const [name, data] of entries) {
    if (!name.endsWith('.html')) continue;
    scanned++;
    const dir = path.posix.dirname(name);
    for (const ref of htmlRefsOf(data.toString('utf8'))) {
      refs++;
      const resolved = path.posix.normalize(path.posix.join(dir, ref));
      need(entries.has(resolved), `${name} 引用的 ${ref} 不在包裡`);
    }
  }
  return `${scanned} 個 HTML · ${refs} 個引用全部命中`;
});

/* ── 輸出 ───────────────────────────────────────────────────────── */

const text = [
  `SnapScroll 發佈包驗證 · ${new Date().toISOString()}`,
  ...report,
  '',
  failures.length === 0 ? '結果：全部通過' : `結果：${failures.length} 項失敗 — ${failures.join('、')}`
].join('\n');

console.log(text);
try {
  fs.mkdirSync(DIST, { recursive: true });
  fs.writeFileSync(path.join(DIST, 'verify-report.txt'), text + '\n');
} catch {
  /* 唯讀環境下不擋流程，stdout 已經有完整報告 */
}

process.exit(failures.length === 0 ? 0 : 1);
