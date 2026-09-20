/* SnapScroll — 長圖診斷工具
 *
 *   node tools/e2e/dump.mjs [--height 8000] [--case full|viewport]
 *
 * 跑一次完整擷取，然後把產出的長圖裁成幾張看得懂的縮圖丟到 tools/e2e/out/。
 * 當「尺寸對、內容感覺不對」的時候，數字再怎麼比都不如直接把圖打開看。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const FIXTURES = path.join(ROOT, 'fixtures');
const OUT = path.join(HERE, 'out');
const PORT = 8801;

const argv = process.argv.slice(2);
const heightArg = argv.indexOf('--height');
const HEIGHT = heightArg >= 0 ? Number(argv[heightArg + 1]) : 8000;

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.github', 'out', '.tmp']);

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst);
    else if (entry.isFile() && !entry.name.endsWith('.zip')) fs.copyFileSync(src, dst);
  }
}

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const file = path.join(FIXTURES, decodeURIComponent(url.pathname));
    if (!file.startsWith(FIXTURES) || !fs.existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    const type = path.extname(file) === '.html' ? 'text/html; charset=utf-8' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(PORT, '127.0.0.1', () => r(server)));
}

async function loadPlaywright() {
  const asUrl = (p) => 'file://' + p.replace(/\\/g, '/');
  for (const c of [
    'playwright',
    asUrl(path.join(ROOT, 'node_modules', 'playwright', 'index.js')),
    asUrl(path.resolve(ROOT, '..', 'node_modules', 'playwright', 'index.js')),
    asUrl(path.resolve(ROOT, '..', 'node_modules', 'playwright-core', 'index.js'))
  ]) {
    try { const m = await import(c); return m.default || m; } catch (e) { /* next */ }
  }
  return null;
}

async function main() {
  const playwright = await loadPlaywright();
  if (!playwright) {
    console.error('找不到 Playwright');
    process.exit(2);
  }

  fs.mkdirSync(OUT, { recursive: true });
  const server = await startServer();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapscroll-dump-'));
  const userDataDir = path.join(workDir, 'profile');
  const extDir = path.join(workDir, 'extension');
  copyTree(ROOT, extDir);

  const manifestPath = path.join(extDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = ['<all_urls>'];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const context = await playwright.chromium.launchPersistentContext(userDataDir, {
    headless: true,
    channel: 'chromium',
    viewport: { width: 1200, height: 860 },
    deviceScaleFactor: 1,
    args: [
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1200,900'
    ]
  });

  try {
    const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 25000 });
    const page = context.pages()[0] || await context.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/long-page.html?h=${HEIGHT}`, { waitUntil: 'load' });
    await page.waitForTimeout(500);

    const tabId = await sw.evaluate(async (needle) => {
      const tabs = await chrome.tabs.query({});
      const hit = tabs.find((t) => t.url && t.url.indexOf(needle) >= 0);
      return hit ? hit.id : null;
    }, `127.0.0.1:${PORT}`);

    const result = await sw.evaluate(([id, opts]) => runCapture(id, opts), [tabId, {
      mode: 'full',
      format: 'png',
      frameDelayMs: 120,
      openResultPage: false,
      keepHistory: 0,
      filenameTemplate: 'dump'
    }]);

    const file = (result.files || []).map((f) => f.filename).filter((f) => f && fs.existsSync(f))[0];
    if (!file) throw new Error('沒有拿到產出檔案：' + JSON.stringify(result).slice(0, 400));

    console.log(`擷取完成：${result.outputWidth}×${result.outputHeight} · ${result.frames} 幀 · 來源 ${file}`);

    const b64 = fs.readFileSync(file).toString('base64');
    const dataUrl = 'data:image/png;base64,' + b64;

    /* 用擴充功能自己的頁面來裁圖：它與圖片沒有跨網域問題嗎？
     * 有的——data URL 不算跨網域，所以直接用它最省事。 */
    const probe = await context.newPage();
    await probe.goto(`chrome-extension://${new URL(sw.url()).host}/ui/result.html`);

    const shots = await probe.evaluate(async ([src, viewportWidth]) => {
      const img = new Image();
      img.src = src;
      await img.decode();

      const k = img.width / viewportWidth;
      const out = {};

      /* 1) 整張概覽：縮到寬 320 */
      const ow = 320;
      const oh = Math.min(4000, Math.round(img.height * (ow / img.width)));
      const full = document.createElement('canvas');
      full.width = ow;
      full.height = oh;
      full.getContext('2d').drawImage(img, 0, 0, img.width, img.height, 0, 0, ow, oh);
      out.overview = full.toDataURL('image/png');

      /* 2) 頂部 0–1800 CSS px 的原始比例切片（含前三段）*/
      const cutH = Math.round(1800 * k);
      const top = document.createElement('canvas');
      top.width = img.width;
      top.height = Math.min(cutH, img.height);
      top.getContext('2d').drawImage(img, 0, 0, img.width, top.height, 0, 0, img.width, top.height);
      out.top = top.toDataURL('image/png');

      return out;
    }, [dataUrl, 1200]);

    for (const [name, dataUri] of Object.entries(shots)) {
      const target = path.join(OUT, `${name}.png`);
      fs.writeFileSync(target, Buffer.from(dataUri.split(',')[1], 'base64'));
      console.log(`  → ${target}`);
    }

    /* 順便把「色塊在頁面上的真實座標」與「圖裡量到的位置」一起印出來比較 */
    const geometry = await page.evaluate(() => {
      const scrollY = window.scrollY || 0;
      return Array.from(document.querySelectorAll('.band')).slice(0, 6).map((band, i) => {
        const sw = band.querySelector('.swatch');
        const r = sw.getBoundingClientRect();
        return { band: i, x: Math.round(r.left + r.width * 0.07), y: Math.round(r.top + scrollY + r.height / 2) };
      });
    });
    console.log('頁面上的色塊座標：' + geometry.map((g) => `#${g.band}(${g.x},${g.y})`).join(' '));
    console.log('把 (x, y) 乘上裝置像素比例，就該在圖裡的同一位置看到那個顏色。');
  } finally {
    await context.close().catch(() => {});
    server.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
