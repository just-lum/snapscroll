/**
 * 規模上限測試
 *
 *   node --test tests/limits.test.js
 *
 * 這裡測的是「會不會做到一半爆掉」：單張畫布裝不下的時候，
 * 有沒有乖乖切成可輸出的片段、有沒有誠實告訴使用者做不到。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const L = require('../engine/limits.js');

/* ── 單張畫布判定 ───────────────────────────────────────────────────── */

test('一般長截圖（1440 × 8000）可以單張輸出', () => {
  assert.equal(L.isSingleCanvasSafe(1440, 8000), true);
});

test('單邊超標就判定不安全', () => {
  assert.equal(L.isSingleCanvasSafe(1200, L.MAX_SIDE + 1), false);
  assert.equal(L.isSingleCanvasSafe(L.MAX_SIDE + 1, 1200), false);
});

test('總面積超標就判定不安全', () => {
  const h = Math.floor(L.SAFE_AREA / 1200) + 100;
  assert.equal(L.isSingleCanvasSafe(1200, h), false);
});

test('零或負尺寸不安全', () => {
  assert.equal(L.isSingleCanvasSafe(0, 100), false);
  assert.equal(L.isSingleCanvasSafe(100, -5), false);
  assert.equal(L.isSingleCanvasSafe(NaN, 100), false);
});

/* ── 分片 ───────────────────────────────────────────────────────────── */

test('planSlices：切片無縫接續且剛好蓋滿', () => {
  const slices = L.planSlices(1200, 250000);
  assert.ok(slices.length > 1);
  let cursor = 0;
  for (const s of slices) {
    assert.equal(s.y, cursor);
    assert.ok(s.h >= 1);
    cursor += s.h;
  }
  assert.equal(cursor, 250000);
});

test('planSlices：每一片都符合單張畫布限制', () => {
  const width = 1080;
  for (const slice of L.planSlices(width, 400000)) {
    assert.equal(L.isSingleCanvasSafe(width, slice.h), true);
  }
});

test('planSlices：一般尺寸不需要切', () => {
  assert.deepEqual(L.planSlices(1440, 8000), [{ y: 0, h: 8000 }]);
});

test('planSlices：空尺寸回傳空陣列', () => {
  assert.deepEqual(L.planSlices(0, 1000), []);
  assert.deepEqual(L.planSlices(1000, 0), []);
});

/* ── 任務分級 ───────────────────────────────────────────────────────── */

test('classify：一般長頁面 → single', () => {
  const r = L.classify(1440, 8000);
  assert.equal(r.mode, 'single');
  assert.equal(r.sliceCount, 1);
  assert.equal(r.pixels, 1440 * 8000);
});

test('classify：超長頁面 → sliced，並說明觸發原因', () => {
  const r = L.classify(1200, 40000);
  assert.equal(r.mode, 'sliced');
  assert.ok(r.sliceCount > 1);
  assert.equal(r.reason, 'area');
});

test('classify：遠超硬上限 → oversize（只能走 PDF）', () => {
  const r = L.classify(2000, 200000);
  assert.equal(r.mode, 'oversize');
  assert.equal(r.reason, 'hard-area');
  assert.equal(r.slices.length, 0);
});

test('classify：像素數遠超硬上限 → oversize', () => {
  const r = L.classify(200, 6000000);
  assert.equal(r.mode, 'oversize');
  assert.equal(r.reason, 'hard-area');
});

test('分片數上限是防禦性檢查：面積硬上限總會先觸發', () => {
  /* 任何會切出超過 MAX_SLICES 片的尺寸，都已經先撞上 HARD_AREA。
   * 這道欄杆實務上碰不到，留著是防止未來改常量時出現漏洞。 */
  const r = L.classify(200, 6000000);
  assert.notEqual(r.reason, 'too-many-slices');
  assert.ok(L.MAX_SLICES >= 10);
});

test('classify：空尺寸 → invalid，而不是假裝成功', () => {
  assert.equal(L.classify(0, 0).mode, 'invalid');
});

/* ── 頁高擇優 ───────────────────────────────────────────────────────── */

test('pickPageHeight：三個來源取最大', () => {
  const r = L.pickPageHeight([
    { source: 'document', value: 8000 },
    { source: 'body', value: 1200 },
    { source: 'inner', value: 0 }
  ]);
  assert.equal(r.source, 'document');
  assert.equal(r.value, 8000);
});

test('pickPageHeight：捲動在 body 上時要選 body', () => {
  /* html 被 overflow:hidden 鎖住時，documentElement.scrollHeight 可能只有
   * 一屏，真正的高度在 body 上。只認 document 就會把整頁量成一屏。 */
  const r = L.pickPageHeight([
    { source: 'document', value: 900 },
    { source: 'body', value: 15000 },
    { source: 'inner', value: 0 }
  ]);
  assert.equal(r.source, 'body');
  assert.equal(r.value, 15000);
});

test('pickPageHeight：內層容器最長時選它', () => {
  const r = L.pickPageHeight([
    { source: 'document', value: 900 },
    { source: 'body', value: 900 },
    { source: 'inner', value: 7200 }
  ]);
  assert.equal(r.source, 'inner');
  assert.equal(r.value, 7200);
});

test('pickPageHeight：壞值與負值不會蓋掉好值', () => {
  const r = L.pickPageHeight([
    { source: 'document', value: NaN },
    { source: 'body', value: -5 },
    { source: 'inner', value: 3000 }
  ]);
  assert.equal(r.source, 'inner');
  assert.equal(r.value, 3000);
});

test('pickPageHeight：空輸入回傳 none / 0，而不是丟錯', () => {
  assert.deepEqual(L.pickPageHeight([]), { source: 'none', value: 0 });
  assert.deepEqual(L.pickPageHeight(null), { source: 'none', value: 0 });
});

test('pickPageHeight：全部一樣高時保留第一個', () => {
  const r = L.pickPageHeight([
    { source: 'document', value: 900 },
    { source: 'body', value: 900 }
  ]);
  assert.equal(r.source, 'document');
  assert.equal(r.value, 900);
});

/* ── 能不能捲動：四種結論必須分開 ───────────────────────────────────── */

test('classifyScrollability：有範圍且實測成功 → scrollable', () => {
  const r = L.classifyScrollability({
    depth: 6000, canScroll: true, viewportHeight: 860,
    documentHeight: 7000, bodyHeight: 7000, innerHeight: 0, offscreenBottom: 0
  });
  assert.equal(r.verdict, 'scrollable');
  assert.equal(r.reason, 'depth');
});

test('classifyScrollability：有範圍但滾不動 → blocked（被腳本接管）', () => {
  const r = L.classifyScrollability({
    depth: 6000, canScroll: false, viewportHeight: 860,
    documentHeight: 7000, bodyHeight: 7000, innerHeight: 0, offscreenBottom: 7000
  });
  assert.equal(r.verdict, 'blocked');
  assert.equal(r.reason, 'locked');
});

test('classifyScrollability：只有一屏 → no-content（不是故障，別嚇人）', () => {
  /* 這正是使用者截圖上那組數字：1254 的視口、1254 的內容。 */
  const r = L.classifyScrollability({
    depth: 0, canScroll: false, viewportHeight: 1254,
    documentHeight: 1254, bodyHeight: 1254, innerHeight: 0, offscreenBottom: 1254
  });
  assert.equal(r.verdict, 'no-content');
  assert.equal(r.reason, 'single-screen');
});

test('classifyScrollability：內容在視口底下卻沒有原生範圍 → non-native', () => {
  /* transform / canvas 驅動的假捲動：scrollHeight 恆等於視口高，
   * 但元素確實排在視口下方。 */
  const r = L.classifyScrollability({
    depth: 0, canScroll: false, viewportHeight: 900,
    documentHeight: 900, bodyHeight: 900, innerHeight: 0, offscreenBottom: 5000
  });
  assert.equal(r.verdict, 'non-native');
  assert.equal(r.reason, 'content-below-viewport');
});

test('classifyScrollability：高度來源說很高卻量不到範圍 → blocked（自相矛盾）', () => {
  const r = L.classifyScrollability({
    depth: 0, canScroll: false, viewportHeight: 900,
    documentHeight: 8000, bodyHeight: 8000, innerHeight: 0, offscreenBottom: 0
  });
  assert.equal(r.verdict, 'blocked');
  assert.equal(r.reason, 'height-without-range');
});

test('classifyScrollability：depth 剛好等於門檻（8）不算能捲', () => {
  const r = L.classifyScrollability({
    depth: 8, canScroll: false, viewportHeight: 900,
    documentHeight: 900, bodyHeight: 900
  });
  assert.equal(r.verdict, 'no-content');
});

test('classifyScrollability：offscreen 剛好等於 1.5 倍視口不算 non-native', () => {
  const r = L.classifyScrollability({
    depth: 0, canScroll: false, viewportHeight: 900,
    documentHeight: 900, bodyHeight: 900, offscreenBottom: 1350
  });
  assert.equal(r.verdict, 'no-content');
});

test('classifyScrollability：PDF 檢視器要單獨一檔，不能混進 no-content', () => {
  /* Chrome 內建 PDF 檢視器的外層 document 同樣「沒有可捲動範圍」，
   * 但原因完全不同：內容是外掛畫的，DOM 裡根本沒有東西可以捲。
   * 混為一談只會讓人以為工具壞了。 */
  const r = L.classifyScrollability({
    isPdfViewer: true,
    depth: 0, canScroll: false, viewportHeight: 836,
    documentHeight: 836, bodyHeight: 0, innerHeight: 0, offscreenBottom: 0
  });
  assert.equal(r.verdict, 'pdf-viewer');
  assert.equal(r.reason, 'plugin-rendered');
});

test('classifyScrollability：PDF 判定優先於其他所有判定', () => {
  const withDepth = L.classifyScrollability({
    isPdfViewer: true, depth: 5000, canScroll: true, viewportHeight: 836
  });
  assert.equal(withDepth.verdict, 'pdf-viewer');

  const withOffscreen = L.classifyScrollability({
    isPdfViewer: true, depth: 0, canScroll: false, viewportHeight: 836, offscreenBottom: 9000
  });
  assert.equal(withOffscreen.verdict, 'pdf-viewer');

  const locked = L.classifyScrollability({
    isPdfViewer: true, depth: 5000, canScroll: false, viewportHeight: 836
  });
  assert.equal(locked.verdict, 'pdf-viewer');
});

test('classifyScrollability：isPdfViewer 為 false 時不影響原本判定', () => {
  const r = L.classifyScrollability({
    isPdfViewer: false, depth: 0, canScroll: false, viewportHeight: 836,
    documentHeight: 836, bodyHeight: 0, offscreenBottom: 0
  });
  assert.equal(r.verdict, 'no-content');
});

test('classifyScrollability：缺值與 null 不會讓判定爆掉', () => {
  assert.equal(L.classifyScrollability({}).verdict, 'no-content');
  assert.equal(L.classifyScrollability(null).verdict, 'no-content');
  assert.equal(L.classifyScrollability(undefined).verdict, 'no-content');
});

test('classifyScrollability：負值與 NaN 被當成 0', () => {
  const r = L.classifyScrollability({
    depth: -100, canScroll: true, viewportHeight: NaN,
    documentHeight: -1, bodyHeight: NaN, offscreenBottom: 'abc'
  });
  assert.equal(r.verdict, 'no-content');
});

/* ── 提示文字 ───────────────────────────────────────────────────────── */

test('describe：正常情況給 ok 等級', () => {
  const r = L.describe(1440, 8000, 'png');
  assert.equal(r.level, 'ok');
  assert.match(r.text, /1440 × 8000/);
});

test('describe：需要分片時講清楚會切幾張', () => {
  const r = L.describe(1200, 40000, 'png');
  assert.equal(r.level, 'warn');
  assert.match(r.text, /切成 \d+ 張/);
  assert.match(r.text, /PDF 不受影響/);
});

test('describe：做不到時建議改用 PDF', () => {
  const r = L.describe(2000, 200000, 'png');
  assert.equal(r.level, 'error');
  assert.match(r.text, /請改用 PDF/);
});

/* ── 雜項 ───────────────────────────────────────────────────────────── */

test('formatBytes：可讀的容量', () => {
  assert.equal(L.formatBytes(0), '0 B');
  assert.equal(L.formatBytes(512), '512 B');
  assert.equal(L.formatBytes(2048), '2 KB');
  assert.equal(L.formatBytes(5 * 1024 * 1024), '5 MB');
  assert.equal(L.formatBytes(1.5 * 1024 * 1024 * 1024), '1.5 GB');
});

test('estimatePeakBytes：包含主畫布與來源點陣圖兩份', () => {
  assert.equal(L.estimatePeakBytes(1000, 1000), 1000 * 1000 * 4 * 2);
});

test('PDF 單頁上限常數維持在 14400pt（200 英吋）', () => {
  assert.equal(L.MAX_PDF_PAGE_PT, 14400);
});
