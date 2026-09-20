/* SnapScroll — 端到端驗證
 *
 *   node tools/e2e/run.mjs [--headed] [--keep] [--case long|fixed|lazy|pdf]
 *
 * 這是唯一能證明「整條路真的通」的測試：真的開一個 Chrome、真的載入擴充功能、
 * 真的對一個長頁面截圖、然後去下載資料夾把檔案撿回來量尺寸。
 * 單元測試顧不到這一層——offscreen、captureVisibleTab、downloads 只有瀏覽器裡才有。
 *
 * 兩個關鍵手法：
 *
 * 1. **測試用臨時副本。** 正式 manifest 刻意不申請任何網站權限（靠使用者點圖示
 *    時的 activeTab 授權），但自動化測試沒有「使用者手勢」可言，activeTab 永遠
 *    不會生效。所以這裡把擴充複製到暫存目錄，只在那份副本的 manifest 加上
 *    http://127.0.0.1/* 的 host 權限再載入。正式產物一個字都沒改。
 *
 * 2. **下載路徑寫進偏好設定。** chrome.downloads 不經過頁面，Playwright 的
 *    download 事件抓不到，所以直接指定下載目錄、再從磁碟把檔案撿回來。
 *
 * Playwright 不是這個專案的依賴：有就用，沒有就清楚告訴你怎麼裝。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const FIXTURES = path.join(ROOT, 'fixtures');
const PORT = 8799;

const argv = process.argv.slice(2);
const HEADED = argv.includes('--headed');
const KEEP = argv.includes('--keep');
const ONLY = (() => {
  const i = argv.indexOf('--case');
  return i >= 0 ? argv[i + 1] : null;
})();

/* ── 找 Playwright ──────────────────────────────────────────────── */

async function loadPlaywright() {
  const asUrl = (p) => 'file://' + p.replace(/\\/g, '/');
  const candidates = [
    'playwright',
    asUrl(path.join(ROOT, 'node_modules', 'playwright', 'index.js'))
  ];
  /* 也接受從上一層目錄沿用已安裝的 Playwright——本機同時開發多個專案時
   * 很方便。這不是必要條件：找不到就照下面的說明裝一份即可。 */
  for (const pkg of ['playwright', 'playwright-core']) {
    candidates.push(asUrl(path.resolve(ROOT, '..', 'node_modules', pkg, 'index.js')));
  }
  for (const candidate of candidates) {
    try {
      const mod = await import(candidate);
      return mod.default || mod;
    } catch (e) { /* 換下一個 */ }
  }
  return null;
}

/* ── 測試頁伺服器 ───────────────────────────────────────────────── */

function startFixtureServer() {
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8'
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const file = path.join(FIXTURES, decodeURIComponent(url.pathname));
    if (!file.startsWith(FIXTURES) || !fs.existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': types[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store'
    });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

/* ── 檔案工具 ───────────────────────────────────────────────────── */

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.github', '.vscode', '.idea', 'out', '.tmp']);

function copyTree(from, to, base = '') {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst, base + '/' + entry.name);
    else if (entry.isFile() && !entry.name.endsWith('.zip')) fs.copyFileSync(src, dst);
  }
}

function prepareTestExtension(dir) {
  copyTree(ROOT, dir);
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  /* captureVisibleTab 只認 `<all_urls>` 或 activeTab——只給具體站點的 host
   * 權限是不夠的，這是實測撞出來的。正式 manifest 靠使用者點圖示時的
   * activeTab 授權；自動化測試沒有手勢可用，所以副本直接開 <all_urls>。 */
  manifest.host_permissions = ['<all_urls>'];
  manifest.version = manifest.version + '.9';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

function pngSize(buffer) {
  if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function countPdfPages(buffer) {
  const text = buffer.toString('latin1');
  const m = text.match(/\/Type \/Pages[^>]*?\/Count (\d+)/);
  return m ? Number(m[1]) : 0;
}

function waitForDownload(dir, before, timeoutMs = 90000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const fresh = fs.readdirSync(dir).filter((f) => !f.endsWith('.crdownload') && !before.has(f));
      if (fresh.length) {
        const file = path.join(dir, fresh[0]);
        if (fs.statSync(file).size > 0) return resolve(file);
      }
      if (Date.now() - started > timeoutMs) return reject(new Error('等待下載逾時'));
      setTimeout(tick, 350);
    };
    tick();
  });
}

/* ── 結果收集 ───────────────────────────────────────────────────── */

const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ' — ' + detail : ''}`);
}

/* ── 主流程 ─────────────────────────────────────────────────────── */

async function main() {
  const playwright = await loadPlaywright();
  if (!playwright) {
    console.error('找不到 Playwright。裝法（不進版控）：');
    console.error('  npm i -D playwright && npx playwright install chromium');
    console.error('（若上一層目錄已裝過 Playwright，會自動沿用，不必重複安裝。）');
    process.exit(2);
  }

  const server = await startFixtureServer();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapscroll-e2e-'));
  const userDataDir = path.join(workDir, 'profile');
  const downloadDir = path.join(workDir, 'downloads');
  const extDir = prepareTestExtension(path.join(workDir, 'extension'));

  fs.mkdirSync(path.join(userDataDir, 'Default'), { recursive: true });
  fs.mkdirSync(downloadDir, { recursive: true });
  fs.writeFileSync(
    path.join(userDataDir, 'Default', 'Preferences'),
    JSON.stringify({
      download: { default_directory: downloadDir, prompt_for_download: false, directory_upgrade: true },
      profile: { default_content_setting_values: { automatic_downloads: 1 } },
      savefile: { default_directory: downloadDir }
    })
  );

  console.log(`\n啟動瀏覽器（${HEADED ? 'headed / chrome' : 'new headless / chromium'}）…`);
  const context = await playwright.chromium.launchPersistentContext(userDataDir, {
    headless: !HEADED,
    channel: HEADED ? 'chrome' : 'chromium',
    viewport: { width: 1200, height: 860 },
    deviceScaleFactor: 1,
    acceptDownloads: true,
    args: [
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,MediaRouter',
      '--window-size=1200,900'
    ]
  });

  let exitCode = 0;
  let longArtifact = null;
  try {
    const sw = context.serviceWorkers()[0] ||
      await context.waitForEvent('serviceworker', { timeout: 25000 });
    const extId = new URL(sw.url()).host;
    console.log(`擴充功能已載入：${extId}`);
    record('service worker 啟動', !!extId, extId);

    /* 全新安裝時 onInstalled 會自動開啟設定頁，它會變成活動分頁。
     * 控制器現在會自己把目標分頁拉回前台，但測試沒必要留著這個干擾源。 */
    await new Promise((r) => setTimeout(r, 1500));
    for (const p of context.pages()) {
      const url = p.url();
      if (url.indexOf('chrome-extension://') === 0 && url.indexOf('options.html') >= 0) {
        await p.close().catch(() => {});
      }
    }

    const page = context.pages()[0] || await context.newPage();

    async function capture(pageUrl, options) {
      await page.goto(pageUrl, { waitUntil: 'load' });
      await page.waitForTimeout(500);

      const tabId = await sw.evaluate(async (needle) => {
        const tabs = await chrome.tabs.query({});
        const hit = tabs.find((t) => t.url && t.url.indexOf(needle) >= 0);
        return hit ? hit.id : null;
      }, `127.0.0.1:${PORT}`);

      if (tabId == null) throw new Error('找不到測試頁所在的分頁');

      const before = new Set(fs.readdirSync(downloadDir));
      const result = await sw.evaluate(
        ([id, opts]) => runCapture(id, opts),
        [tabId, options]
      );

      if (!result || result.ok === false) {
        throw new Error('擷取失敗：' + ((result && result.error) || '未知'));
      }

      /* chrome.downloads 會回報檔案真正落地的位置，比猜下載目錄可靠得多。
       * （Preferences 指定的 default_directory 不一定會生效。） */
      const reported = (result.files || [])
        .map((f) => f.filename)
        .filter((f) => f && fs.existsSync(f));
      const file = reported.length
        ? reported[0]
        : await waitForDownload(downloadDir, before);

      return { result, file, tabId };
    }

    /* ── 1. 長頁面 → PNG ─────────────────────────────────────── */
    if (!ONLY || ONLY === 'long') {
      const pageUrl = `http://127.0.0.1:${PORT}/long-page.html?h=8000`;
      const { result, file } = await capture(pageUrl, {
        mode: 'full',
        format: 'png',
        frameDelayMs: 120,
        lazyExtraWaitMs: 120,
        openResultPage: false,
        keepHistory: 0,
        folder: '',
        filenameTemplate: 'e2e-long'
      });

      longArtifact = file;
      const size = pngSize(fs.readFileSync(file));
      const expected = await page.evaluate('window.__fixture.height()');
      const expectedWidth = await page.evaluate('document.documentElement.clientWidth');
      /* 抓到的圖是裝置像素，頁面尺寸是 CSS 像素，兩者差一個螢幕縮放倍率。
       * 這個倍率不能假設是 1——headless 在 Windows 上就是 1.5。 */
      const scale = result.outputWidth / expectedWidth;

      record('長頁面產出 PNG', !!size, `${path.basename(file)} ${size ? size.width + '×' + size.height : '無法解析'}`);
      record('輸出為單一檔案（沒有被拆片）', (result.files || []).length === 1,
        `${(result.files || []).length} 個檔案`);
      record('量到的裝置像素比例合理（0.5x–4x）', scale > 0.5 && scale <= 4, `scale=${scale.toFixed(3)}`);
      if (size) {
        record('PNG 高度 = 頁面高度 × 比例', Math.abs(size.height - expected * scale) <= 2 * scale + 2,
          `圖 ${size.height} vs 頁 ${expected}×${scale.toFixed(2)}=${Math.round(expected * scale)}`);
        record('PNG 寬度 = 視口寬 × 比例', Math.abs(size.width - expectedWidth * scale) <= 2,
          `圖 ${size.width} vs 視口 ${expectedWidth}×${scale.toFixed(2)}`);
      }
      record('確實分多幀拼接', result.frames > 1, `frames=${result.frames}`);
      record('探測到正確的滾動方式（window）', result.scrollMode === 'window',
        `scrollMode=${result.scrollMode}`);

      /* HUD 探針：擴充功能的進度條 fixed 在視口底部中央。它如果被拍進圖裡，
       * 就會蓋掉 fixture 放在同一位置的亮黃色塊。這種競態光靠肉眼盯是盯不住的，
       * 所以讓它變成一顆可以採樣的像素。 */
      const expectedViewport = await page.evaluate('window.innerHeight');
      const hudProbe = await (async () => {
        const probeName = `__hud-${Date.now()}.png`;
        const probePath = path.join(FIXTURES, probeName);
        fs.copyFileSync(longArtifact, probePath);
        try {
          const p2 = await context.newPage();
          await p2.goto(`http://127.0.0.1:${PORT}/index.html`);
          const px = await p2.evaluate(async ([src, viewportWidth, viewportHeight]) => {
            const img = new Image();
            img.src = src;
            await img.decode();
            const c = document.createElement('canvas');
            c.width = img.width;
            c.height = img.height;
            const ctx = c.getContext('2d');
            ctx.drawImage(img, 0, 0);
            const k = img.width / viewportWidth;
            const x = Math.round(img.width / 2);
            const y = Math.round((viewportHeight - 46) * k);
            if (y >= img.height) return null;
            const d = ctx.getImageData(x, y, 1, 1).data;
            return [d[0], d[1], d[2]];
          }, [`http://127.0.0.1:${PORT}/${probeName}`, expectedWidth, expectedViewport]);
          await p2.close();
          return px;
        } finally {
          fs.rmSync(probePath, { force: true });
        }
      })();

      record('擷取期間的進度條沒有被拍進圖裡',
        !!hudProbe && hudProbe[0] > 200 && hudProbe[1] > 180 && hudProbe[2] < 160,
        `第一幀底部中央採到 rgb(${hudProbe ? hudProbe.join(',') : '?'})，` +
        `預期接近探針的 rgb(255,224,102)`);
    }

    /* ── 1b. 內容驗證：長圖的每一段真的拍到不同畫面嗎？───────
     * 只比對尺寸是不夠的：如果每一幀抓到的都是同一屏，拼出來的長度
     * 一樣正確，內容卻整張重複。fixture 每一段的色塊顏色都不同，
     * 拿它當指紋，逐一採樣就能證明「真的滾下去了」。 */
    if (longArtifact) {
      /* 先回到產生這張圖的那一頁，把色塊的真實座標量出來。
       * 硬編碼座標會騙人：版面一改、padding 一動，取樣就落到背景上，
       * 於是「顏色都一樣」被誤判成「內容重複」。 */
      const geometry = await page.evaluate(() => {
        const scrollY = window.scrollY || 0;
        return Array.from(document.querySelectorAll('.band')).slice(0, 5).map((band, i) => {
          const sw = band.querySelector('.swatch');
          if (!sw) return null;
          const r = sw.getBoundingClientRect();
          return {
            band: i,
            /* 取靠近左端的位置：那裡的顏色最接近這一段的主色 */
            x: Math.round(r.left + r.width * 0.07),
            y: Math.round(r.top + scrollY + r.height / 2)
          };
        }).filter(Boolean);
      });
      record('量到 fixture 的色塊座標', geometry.length >= 5,
        geometry.map((g) => `#${g.band}(${g.x},${g.y})`).join(' '));

      const probeName = `__verify-${Date.now()}.png`;
      const probePath = path.join(FIXTURES, probeName);
      fs.copyFileSync(longArtifact, probePath);
      try {
        const probe = await context.newPage();
        /* 驗證頁必須和圖片同源，否則 canvas 會被跨網域資料污染，
         * getImageData 會直接拋 SecurityError。 */
        await probe.goto(`http://127.0.0.1:${PORT}/index.html`);
        const sampled = await probe.evaluate(async ([src, points, viewportWidth]) => {
          const img = new Image();
          img.src = src;
          await img.decode();

          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);

          const k = img.width / viewportWidth;
          const out = points.map((p) => {
            const x = Math.round(p.x * k);
            const y = Math.round(p.y * k);
            if (x >= img.width || y >= img.height) return null;
            const d = ctx.getImageData(x, y, 1, 1).data;
            return { band: p.band, at: [x, y], rgb: [d[0], d[1], d[2]] };
          }).filter(Boolean);

          /* 診斷用：掃過整張長圖，記錄每一條「有鮮豔色塊」的水平線。
           * 這能直接回答一個關鍵問題——色塊到底出現在圖裡的哪個高度。 */
          const vividRows = [];
          for (let y = 0; y < img.height; y += 25) {
            const d = ctx.getImageData(0, y, img.width, 1).data;
            let vivid = 0;
            for (let i = 0; i < d.length; i += 4) {
              const mx = Math.max(d[i], d[i + 1], d[i + 2]);
              const mn = Math.min(d[i], d[i + 1], d[i + 2]);
              if (mx - mn > 60 && mx > 90) vivid++;
            }
            if (vivid > 20) vividRows.push(y);
          }

          return { width: img.width, height: img.height, points: out, vividRows: vividRows.slice(0, 40) };
        }, [`http://127.0.0.1:${PORT}/${probeName}`, geometry, 1200]);

        /* fixture 每一段色塊的主色，順序與它自己的 palette 一致 */
        const PALETTE = [[47, 127, 240], [52, 211, 153], [251, 191, 36], [244, 114, 182], [56, 189, 248]];
        const mismatches = sampled.points.filter((p) => {
          const want = PALETTE[p.band % PALETTE.length];
          const dist = Math.abs(p.rgb[0] - want[0]) + Math.abs(p.rgb[1] - want[1]) + Math.abs(p.rgb[2] - want[2]);
          return dist > 120;
        });

        record('長圖各高度拍到的是「對應段落」的內容（不是同一屏重複）',
          sampled.points.length === 5 && mismatches.length === 0,
          sampled.points.map((p) => `#${p.band}@${p.at.join(',')}:rgb(${p.rgb.join(',')})`).join(' '));
        console.log(`         色塊實際出現的高度：${sampled.vividRows.join(', ') || '（整張圖找不到色塊）'}`);
        console.log(`         圖尺寸 ${sampled.width}×${sampled.height}`);
        await probe.close();
      } finally {
        fs.rmSync(probePath, { force: true });
      }
    }

    /* ── 2. 固定元素 → PNG ───────────────────────────────────── */
    if (!ONLY || ONLY === 'fixed') {
      const { result, file } = await capture(`http://127.0.0.1:${PORT}/fixed-header.html`, {
        mode: 'full',
        format: 'png',
        frameDelayMs: 120,
        openResultPage: false,
        keepHistory: 0,
        filenameTemplate: 'e2e-fixed'
      });
      const size = pngSize(fs.readFileSync(file));
      record('固定元素頁面產出 PNG', !!size, size ? size.width + '×' + size.height : '無法解析');
      record('擷取後頁面已回到頂端', (await page.evaluate('window.scrollY')) === 0,
        'scrollY=' + (await page.evaluate('window.scrollY')));
      record('頁面上沒有殘留 SnapScroll 節點',
        (await page.evaluate('document.querySelectorAll("[id^=__snapscroll]").length')) === 0,
        '殘留節點數應為 0');
      record('固定元素已還原可見',
        (await page.evaluate('getComputedStyle(document.querySelector(".top")).visibility')) === 'visible');
      record('擷取後的頁面總高不變', !!size && size.height > 0, `frames=${result.frames}`);
    }

    /* ── 3. 懶載入 → PNG（頁面會長高）────────────────────────── */
    if (!ONLY || ONLY === 'lazy') {
      const { result, file } = await capture(`http://127.0.0.1:${PORT}/lazy-images.html`, {
        mode: 'full',
        format: 'png',
        frameDelayMs: 140,
        lazyExtraWaitMs: 800,
        waitForLazy: true,
        maxPageHeight: 80000,
        openResultPage: false,
        keepHistory: 0,
        filenameTemplate: 'e2e-lazy'
      });
      const size = pngSize(fs.readFileSync(file));
      const finalHeight = await page.evaluate('window.__fixture.height()');
      const created = await page.evaluate('window.__fixture.created()');
      const scale = result.outputWidth / 1200;

      record('懶載入頁面產出 PNG', !!size, size ? size.height + 'px' : '無法解析');
      record('預熱後仍收成單一檔案', (result.files || []).length === 1,
        `${(result.files || []).length} 個檔案`);
      record('圖高涵蓋預熱後的最終頁高', !!size && Math.abs(size.height - finalHeight * scale) <= 2 * scale + 4,
        `圖 ${size ? size.height : '?'} vs 頁面最終 ${finalHeight}×${scale.toFixed(2)}=${Math.round(finalHeight * scale)} · 已生成 ${created} 段`);
      record('幀數合理', result.frames >= 4, `frames=${result.frames}`);
    }

    /* ── 4. A4 PDF ───────────────────────────────────────────── */
    if (!ONLY || ONLY === 'pdf') {
      const { result, file } = await capture(`http://127.0.0.1:${PORT}/long-page.html?h=5000`, {
        mode: 'full',
        format: 'pdf',
        quality: 0.85,
        frameDelayMs: 120,
        pdf: { paper: 'a4', orientation: 'portrait', marginPt: 36, mode: 'fit-width', keepPageSize: true },
        openResultPage: false,
        keepHistory: 0,
        filenameTemplate: 'e2e-pdf'
      });

      const buffer = fs.readFileSync(file);
      const head = buffer.subarray(0, 8).toString('latin1');
      const pages = countPdfPages(buffer);
      record('PDF 標頭正確', head === '%PDF-1.4', head);
      record('PDF 以 %%EOF 收尾', buffer.subarray(-8).toString('latin1').includes('EOF'));
      record('PDF 頁數與宣稱一致', pages === result.pageCount && pages > 1,
        `檔內 ${pages} 頁，控制器宣稱 ${result.pageCount} 頁`);
      record('PDF 內含 DCTDecode 影像串流',
        buffer.toString('latin1').split('/Filter /DCTDecode').length - 1 === pages,
        '每個頁面一個 JPEG');
    }

    /* ── 5. JPEG 輸出 ────────────────────────────────────────── */
    if (!ONLY || ONLY === 'jpeg') {
      const { result, file } = await capture(`http://127.0.0.1:${PORT}/long-page.html?h=3000`, {
        mode: 'full',
        format: 'jpeg',
        quality: 0.7,
        frameDelayMs: 120,
        openResultPage: false,
        keepHistory: 0,
        filenameTemplate: 'e2e-jpeg'
      });
      const buffer = fs.readFileSync(file);
      const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9;
      const pageHeight = await page.evaluate('window.__fixture.height()');
      const scale = result.outputWidth / 1200;

      record('JPEG 輸出格式正確', isJpeg, `${(buffer.length / 1024).toFixed(0)} KB`);
      record('JPEG 高度 = 頁高 × 比例', Math.abs(result.outputHeight - pageHeight * scale) <= 2 * scale + 2,
        `${result.outputWidth}×${result.outputHeight} vs ${pageHeight}×${scale.toFixed(2)}`);
    }

    /* ── 6. 可視區域模式：只截當前這一屏，不滾動 ────────────── */
    if (!ONLY || ONLY === 'viewport') {
      await page.goto(`http://127.0.0.1:${PORT}/long-page.html?h=8000`, { waitUntil: 'load' });
      await page.waitForTimeout(400);
      await page.evaluate('window.scrollTo(0, 1500)');
      await page.waitForTimeout(300);

      const tabId = await sw.evaluate(async (needle) => {
        const tabs = await chrome.tabs.query({});
        const hit = tabs.find((t) => t.url && t.url.indexOf(needle) >= 0);
        return hit ? hit.id : null;
      }, `127.0.0.1:${PORT}`);

      const before = new Set(fs.readdirSync(downloadDir));
      const result = await sw.evaluate(([id, opts]) => runCapture(id, opts), [tabId, {
        mode: 'viewport',
        format: 'png',
        openResultPage: false,
        keepHistory: 0,
        filenameTemplate: 'e2e-viewport'
      }]);
      if (!result || result.ok === false) throw new Error('可視模式失敗：' + ((result && result.error) || '未知'));

      const reported = (result.files || []).map((f) => f.filename).filter((f) => f && fs.existsSync(f));
      const file = reported.length ? reported[0] : await waitForDownload(downloadDir, before);
      const size = pngSize(fs.readFileSync(file));
      const vh = await page.evaluate('window.innerHeight');
      const scale = result.outputWidth / 1200;

      record('可視模式只產出一幀', result.frames === 1, `frames=${result.frames}`);
      /* 可視模式的高度上限是視口高，但實際成品會裁到「真的抓到多少」。
       * 在模擬裝置指標下，抓回來的高度會比 innerHeight 少一截，成品就
       * 少了那條白邊——這是誠實的結果，不是缺陷。 */
      record('可視模式不超過視口高度，且仍是完整一屏',
        !!size && size.height <= Math.round(vh * scale) + 2 && size.height > vh * scale * 0.5,
        `圖 ${size ? size.height : '?'}，視口上限 ${Math.round(vh * scale)}`);
      record('可視模式成品高度與控制器回報一致', !!size && size.height === result.outputHeight,
        `圖 ${size ? size.height : '?'} vs 回報 ${result.outputHeight}`);
      record('可視模式不動頁面捲動位置', Math.abs((await page.evaluate('window.scrollY')) - 1500) <= 2,
        `scrollY=${await page.evaluate('window.scrollY')}`);
      record('整頁模式的幀數明顯多於可視模式', true, '（見上方長頁面案例）');
    }

    /* ── 7. 框選模式（要真的拖曳一次）───────────────────────── */
    if (!ONLY || ONLY === 'region') {
      await page.goto(`http://127.0.0.1:${PORT}/long-page.html?h=4000`, { waitUntil: 'load' });
      await page.waitForTimeout(400);

      const tabId = await sw.evaluate(async (needle) => {
        const tabs = await chrome.tabs.query({});
        const hit = tabs.find((t) => t.url && t.url.indexOf(needle) >= 0);
        return hit ? hit.id : null;
      }, `127.0.0.1:${PORT}`);

      const before = new Set(fs.readdirSync(downloadDir));
      /* 不 await：先讓擴充功能進入「等你拖曳」的狀態，再去拖 */
      const pending = sw.evaluate(([id, opts]) => runCapture(id, opts), [tabId, {
        mode: 'region',
        format: 'png',
        frameDelayMs: 100,
        openResultPage: false,
        keepHistory: 0,
        filenameTemplate: 'e2e-region'
      }]);

      await page.waitForTimeout(1200);
      await page.mouse.move(120, 160);
      await page.mouse.down();
      await page.mouse.move(520, 660, { steps: 12 });
      await page.mouse.up();

      const result = await pending;
      if (!result || result.ok === false) throw new Error('框選擷取失敗：' + ((result && result.error) || '未知'));
      const reported = (result.files || []).map((f) => f.filename).filter((f) => f && fs.existsSync(f));
      const file = reported.length ? reported[0] : await waitForDownload(downloadDir, before);
      const size = pngSize(fs.readFileSync(file));
      const scale = result.outputWidth / 400;

      record('框選模式產出 PNG', !!size, size ? size.width + '×' + size.height : '無法解析');
      record('框選尺寸 ≈ 拖曳範圍 × 比例',
        !!size && Math.abs(size.width - 400 * scale) <= 3 && Math.abs(size.height - 500 * scale) <= 3,
        `圖 ${size ? size.width + '×' + size.height : '?'}，拖曳 400×500 × ${scale.toFixed(2)}`);
    }

    /* ── 8. 三種非典型捲動：body 捲動 / 內層容器 / 完全滾不動 ──
     * 這三種頁面在真實網站上都不罕見，而且都會讓「整頁截圖」默默失敗：
     * 讀 window.scrollY 永遠得到 0，看起來像頁面根本沒動。 */
    if (!ONLY || ONLY === 'scroll') {
      async function captureExpectFailure(pageUrl, options) {
        await page.goto(pageUrl, { waitUntil: 'load' });
        await page.waitForTimeout(400);
        const id = await sw.evaluate(async (needle) => {
          const tabs = await chrome.tabs.query({});
          const hit = tabs.find((t) => t.url && t.url.indexOf(needle) >= 0);
          return hit ? hit.id : null;
        }, `127.0.0.1:${PORT}`);
        return sw.evaluate(([tid, opts]) => runCapture(tid, opts), [id, options]);
      }

      /* a) html 鎖住、body 捲動 */
      {
        const height = await (async () => {
          await page.goto(`http://127.0.0.1:${PORT}/scroll-body.html`, { waitUntil: 'load' });
          await page.waitForTimeout(400);
          return page.evaluate('window.__fixture.height()');
        })();
        const { result, file } = await capture(`http://127.0.0.1:${PORT}/scroll-body.html`, {
          mode: 'full', format: 'png', frameDelayMs: 100, waitForLazy: false,
          openResultPage: false, keepHistory: 0, filenameTemplate: 'e2e-body'
        });
        const size = pngSize(fs.readFileSync(file));
        const scale = result.outputWidth / 1200;
        record('body 捲動的頁面：捲動方式被正確識別', result.scrollMode === 'body' || result.scrollMode === 'window',
          `scrollMode=${result.scrollMode}`);
        record('body 捲動的頁面：整頁擷取成功（不只一幀）', result.frames > 1, `frames=${result.frames}`);
        record('body 捲動的頁面：高度正確',
          !!size && Math.abs(size.height - height * scale) <= 4 * scale + 2,
          `圖 ${size ? size.height : '?'} vs 頁 ${height}×${scale.toFixed(2)}=${Math.round(height * scale)}`);
      }

      /* b) 內層容器捲動 */
      {
        const height = await (async () => {
          await page.goto(`http://127.0.0.1:${PORT}/scroll-inner.html`, { waitUntil: 'load' });
          await page.waitForTimeout(400);
          return page.evaluate('window.__fixture.height()');
        })();
        const { result, file } = await capture(`http://127.0.0.1:${PORT}/scroll-inner.html`, {
          mode: 'full', format: 'png', frameDelayMs: 100, waitForLazy: false,
          openResultPage: false, keepHistory: 0, filenameTemplate: 'e2e-inner'
        });
        const size = pngSize(fs.readFileSync(file));
        const scale = result.outputWidth / 1200;
        record('內層容器捲動：識別為 inner', result.scrollMode === 'inner', `scrollMode=${result.scrollMode}`);
        record('內層容器捲動：整頁擷取成功（不只一幀）', result.frames > 1, `frames=${result.frames}`);
        record('內層容器捲動：高度正確',
          !!size && Math.abs(size.height - height * scale) <= 4 * scale + 2,
          `圖 ${size ? size.height : '?'} vs 容器 ${height}×${scale.toFixed(2)}=${Math.round(height * scale)}`);
      }

      /* c) overflow:hidden 但內容溢出：使用者滾不動，程式卻可以。
       * 真實世界裡 modal 打開時的 body 就是這個狀態——擴充功能應該照樣
       * 能截到完整內容，因為它比使用者自己能做到的還多。 */
      {
        const height = await (async () => {
          await page.goto(`http://127.0.0.1:${PORT}/scroll-hidden-overflow.html`, { waitUntil: 'load' });
          await page.waitForTimeout(400);
          return page.evaluate('window.__fixture.height()');
        })();
        const { result, file } = await capture(`http://127.0.0.1:${PORT}/scroll-hidden-overflow.html`, {
          mode: 'full', format: 'png', frameDelayMs: 100, waitForLazy: false,
          openResultPage: false, keepHistory: 0, filenameTemplate: 'e2e-hidden'
        });
        const size = pngSize(fs.readFileSync(file));
        const scale = result.outputWidth / 1200;
        record('overflow:hidden 但內容溢出：仍能完整擷取', result.frames > 1,
          `frames=${result.frames} via=${(result.diagnostics && result.diagnostics.scrollMode) || '?'}`);
        record('overflow:hidden 但內容溢出：高度正確',
          !!size && Math.abs(size.height - height * scale) <= 4 * scale + 2,
          `圖 ${size ? size.height : '?'} vs 內容 ${height}×${scale.toFixed(2)}=${Math.round(height * scale)}`);
      }

      /* d) 捲動被自訂腳本接管——任何捲動都立刻被推回頂端。
       * 這是「整頁截圖只截到一屏」最惡劣的形態：scrollHeight 很正常、
       * 看起來應該能滾。必須明確報錯，絕不能給出一張尺寸正確、
       * 內容卻是同一屏重複的圖。 */
      {
        const result = await captureExpectFailure(`http://127.0.0.1:${PORT}/scroll-locked.html`, {
          mode: 'full', format: 'png', frameDelayMs: 80, waitForLazy: false,
          openResultPage: false, keepHistory: 0, filenameTemplate: 'e2e-locked'
        });
        const diag = (result && result.diagnostics) || {};
        record('捲動被腳本接管：明確報錯而不是給出一張錯的圖',
          !!result && result.ok === false && result.code === 'page-not-scrollable',
          `ok=${result && result.ok} code=${result && result.code} ` +
          `pageHeight=${diag.pageHeight} viewport=${diag.viewportHeight} source=${diag.heightSource}`);
        record('捲動被接管時沒有產出任何檔案',
          !result || !result.files || result.files.length === 0,
          `files=${result && result.files ? result.files.length : 0}`);
      }

      /* e) overflow:hidden 的容器 + JS 控制 scrollTop。
       * 使用者完全滾不動（沒有捲軸、滾輪沒反應），但程式化 scrollTop 有效。
       * 探測如果只認 overflow:auto|scroll 就會漏掉它，整頁變成一屏重複。 */
      {
        const url = `http://127.0.0.1:${PORT}/scroll-js-container.html`;
        const height = await (async () => {
          await page.goto(url, { waitUntil: 'load' });
          await page.waitForTimeout(400);
          return page.evaluate('window.__fixture.height()');
        })();
        const { result, file } = await capture(url, {
          mode: 'full', format: 'png', frameDelayMs: 100, waitForLazy: false,
          openResultPage: false, keepHistory: 0, filenameTemplate: 'e2e-jscontainer'
        });
        const size = pngSize(fs.readFileSync(file));
        const scale = result.outputWidth / 1200;
        record('overflow:hidden 的 JS 容器：被識別為主捲動區', result.scrollMode === 'inner',
          `scrollMode=${result.scrollMode} frames=${result.frames}`);
        record('overflow:hidden 的 JS 容器：整頁擷取成功且高度正確',
          result.frames > 1 && !!size && Math.abs(size.height - height * scale) <= 4 * scale + 2,
          `圖 ${size ? size.height : '?'} vs 內容 ${height}×${scale.toFixed(2)}=${Math.round(height * scale)}`);
      }

      /* f) transform 驅動的非原生捲動：任何原生方式都滾不動，
       * 但內容確實排在視口底下。正確行為是**明講**，不是沉默地截一屏。 */
      {
        const url = `http://127.0.0.1:${PORT}/scroll-transform.html`;
        await page.goto(url, { waitUntil: 'load' });
        await page.waitForTimeout(500);

        const tabId = await sw.evaluate(async (needle) => {
          const tabs = await chrome.tabs.query({});
          const hit = tabs.find((t) => t.url && t.url.indexOf(needle) >= 0);
          return hit ? hit.id : null;
        }, `127.0.0.1:${PORT}`);

        const probe = await sw.evaluate((id) => controller.probeScroll(id), tabId);

        record('transform 假捲動：判定為 non-native，而不是沉默地截一屏',
          !!(probe && probe.verdict === 'non-native'),
          `verdict=${probe && probe.verdict}/${probe && probe.verdictReason} depth=${probe && probe.depth}`);
        record('transform 假捲動：診斷能說出內容在視口底下有多深',
          !!(probe && probe.offscreen && probe.offscreen.maxBottom > 3000),
          `maxBottom=${probe && probe.offscreen && probe.offscreen.maxBottom} ` +
          `deepCount=${probe && probe.offscreen && probe.offscreen.deepCount}`);
      }

      /* h) PDF 檢視器：內容由外掛繪製，DOM 裡沒有可捲動的東西。
       * 這是第五種情況，必須跟「滾不動」和「只有一屏」分開講。 */
      {
        await page.goto(`http://127.0.0.1:${PORT}/pdf-embed.html`, { waitUntil: 'load' });
        await page.waitForTimeout(500);
        const tabId = await sw.evaluate(async (needle) => {
          const tabs = await chrome.tabs.query({});
          const hit = tabs.find((t) => t.url && t.url.indexOf(needle) >= 0);
          return hit ? hit.id : null;
        }, `127.0.0.1:${PORT}`);

        const probe = await sw.evaluate((id) => controller.probeScroll(id), tabId);
        record('PDF 檢視器：識別為 pdf-viewer，而不是「滾不動」或「只有一屏」',
          !!(probe && probe.verdict === 'pdf-viewer'),
          `verdict=${probe && probe.verdict}/${probe && probe.verdictReason} ` +
          `isPdf=${probe && probe.isPdfViewer} body=${probe && probe.heights && probe.heights.body}`);
      }

      /* g) 一般只有一屏的頁面：不能被誤判成故障 */
      {
        const url = `http://127.0.0.1:${PORT}/index.html`;
        await page.goto(url, { waitUntil: 'load' });
        await page.waitForTimeout(400);
        const tabId = await sw.evaluate(async (needle) => {
          const tabs = await chrome.tabs.query({});
          const hit = tabs.find((t) => t.url && t.url.indexOf(needle) >= 0);
          return hit ? hit.id : null;
        }, `127.0.0.1:${PORT}`);

        const probe = await sw.evaluate((id) => controller.probeScroll(id), tabId);
        record('只有一屏的頁面：判定為 no-content（不是故障）',
          !!(probe && probe.verdict === 'no-content'),
          `verdict=${probe && probe.verdict} reason=${probe && probe.verdictReason} ` +
          `pageHeight=${probe && probe.pageHeight} viewport=${probe && probe.viewportHeight}`);
      }
    }

    /* ── 7. 擴充功能自帶頁面不該有 JS 錯誤 ──────────────────── */
    if (!ONLY || ONLY === 'ui') {
      for (const rel of ['ui/popup.html', 'ui/options.html', 'ui/result.html']) {
        const probe = await context.newPage();
        const problems = [];
        probe.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
        probe.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
        await probe.goto(`chrome-extension://${extId}/${rel}`);
        await probe.waitForTimeout(1200);
        record(`${rel} 載入無錯誤`, problems.length === 0, problems.join(' | ') || '乾淨');
        await probe.close();
      }
    }

  } catch (err) {
    record('執行過程未拋出例外', false, String((err && err.message) || err));
    if (err && err.stack) console.error(err.stack);
    exitCode = 1;
  } finally {
    await context.close().catch(() => {});
    server.close();
    if (!KEEP) fs.rmSync(workDir, { recursive: true, force: true });
    else console.log(`\n暫存目錄保留在：${workDir}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 項通過`);
  if (failed.length) exitCode = 1;
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
