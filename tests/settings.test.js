/**
 * 設定收斂測試
 *
 *   node --test tests/settings.test.js
 *
 * normalize() 是整支擴充唯一信任邊界：設定來自 storage.local，而 storage
 * 可以被使用者手動改、被舊版本寫壞、被別人的備份檔覆蓋。這裡測的是
 * 「餵它任何垃圾，出來的都還是合法設定」——不丟錯、不缺欄位、不越界。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const S = require('../common/settings.js');

/* ── 預設值 ─────────────────────────────────────────────────────────── */

test('空輸入補齊全部預設值，且不共用物件參照', () => {
  const a = S.normalize();
  const b = S.normalize(null);
  assert.deepEqual(a, S.normalize(S.DEFAULTS));
  assert.equal(a.format, 'png');
  assert.equal(a.mode, 'full');
  assert.equal(a.quality, 0.92);
  assert.equal(a.maxPageHeight, 120000);
  assert.equal(a.keepHistory, 20);
  assert.equal(a.pdf.paper, 'a4');

  /* pdf 是巢狀物件，最容易被整個共用出去：改一個設定就污染 DEFAULTS */
  a.pdf.paper = 'a3';
  assert.equal(b.pdf.paper, 'a4');
  assert.equal(S.DEFAULTS.pdf.paper, 'a4');
});

test('非物件輸入一律當成空物件處理', () => {
  ['x', 42, true, [], null, undefined].forEach((raw) => {
    assert.deepEqual(S.normalize(raw), S.normalize({}), String(raw));
  });
});

/* ── 列舉 ───────────────────────────────────────────────────────────── */

test('列舉欄位：大小寫不敏感，非法值回預設', () => {
  assert.equal(S.normalize({ format: 'PNG' }).format, 'png');
  assert.equal(S.normalize({ format: 'webp' }).format, 'webp');
  assert.equal(S.normalize({ format: 'gif' }).format, 'png');
  assert.equal(S.normalize({ mode: 'REGION' }).mode, 'region');
  assert.equal(S.normalize({ mode: 'fullscreen' }).mode, 'full');
  assert.equal(S.normalize({ captureFormat: 'Jpeg' }).captureFormat, 'jpeg');
  assert.equal(S.normalize({ captureFormat: 'webp' }).captureFormat, 'auto');
});

/* ── 數值 ───────────────────────────────────────────────────────────── */

test('數值欄位夾在區間內，不接受 NaN 與 Infinity', () => {
  assert.equal(S.normalize({ quality: 0 }).quality, 0.3);
  assert.equal(S.normalize({ quality: 9 }).quality, 1);
  assert.equal(S.normalize({ quality: NaN }).quality, 0.92);
  /* Infinity 不是「無窮大的畫質」而是垃圾輸入：非有限數一律回預設 */
  assert.equal(S.normalize({ quality: Infinity }).quality, 0.92);
  assert.equal(S.normalize({ quality: -Infinity }).quality, 0.92);

  assert.equal(S.normalize({ maxPageHeight: 1 }).maxPageHeight, 1000);
  assert.equal(S.normalize({ maxPageHeight: 1e9 }).maxPageHeight, 1000000);
  assert.equal(S.normalize({ keepHistory: -5 }).keepHistory, 0);
  assert.equal(S.normalize({ keepHistory: 999 }).keepHistory, 200);
  assert.equal(S.normalize({ retryLimit: 31 }).retryLimit, 30);
  assert.equal(S.normalize({ frameDelayMs: 6000 }).frameDelayMs, 5000);
  assert.equal(S.normalize({ startDelayMs: -1 }).startDelayMs, 0);
  assert.equal(S.normalize({ pdf: { marginPt: 200 } }).pdf.marginPt, 144);
});

test('純數字字串會被收斂成數字，非數字字串回預設', () => {
  assert.equal(S.normalize({ quality: '0.5' }).quality, 0.5);
  assert.equal(S.normalize({ frameDelayMs: '300' }).frameDelayMs, 300);
  assert.equal(S.normalize({ quality: 'abc' }).quality, 0.92);
  /* Number('') === 0，所以空字串會落到下限而不是回預設 */
  assert.equal(S.normalize({ quality: '' }).quality, 0.3);
});

/* ── 布林 ───────────────────────────────────────────────────────────── */

test('布林欄位只認 true / false / "true" / "false"', () => {
  assert.equal(S.normalize({ hideFixed: false }).hideFixed, false);
  assert.equal(S.normalize({ hideFixed: 'false' }).hideFixed, false);
  assert.equal(S.normalize({ hideFixed: 'true' }).hideFixed, true);
  /* 1 與 'yes' 不是布林：回預設 true，而不是被當成 true 或 false */
  assert.equal(S.normalize({ hideOwnOverlay: 1 }).hideOwnOverlay, true);
  assert.equal(S.normalize({ showOverlay: 'yes' }).showOverlay, true);
});

/* ── 字串 ───────────────────────────────────────────────────────────── */

test('檔名樣板：空白回預設，過長截到 200', () => {
  assert.equal(S.normalize({ filenameTemplate: '   ' }).filenameTemplate, S.DEFAULTS.filenameTemplate);
  assert.equal(S.normalize({ filenameTemplate: 123 }).filenameTemplate, S.DEFAULTS.filenameTemplate);
  const long = 'x'.repeat(500);
  assert.equal(S.normalize({ filenameTemplate: long }).filenameTemplate.length, 200);
  assert.equal(S.normalize({ folder: long }).folder.length, 120);
  assert.equal(S.normalize({ folder: '  shots  ' }).folder, 'shots');
  assert.equal(S.normalize({ folder: '' }).folder, '');
});

/* ── 差異比對 ───────────────────────────────────────────────────────── */

test('diffFromDefaults：預設值回空陣列，改動逐欄列出', () => {
  assert.deepEqual(S.diffFromDefaults(S.DEFAULTS), []);
  assert.deepEqual(S.diffFromDefaults({}), []);
  assert.deepEqual(S.diffFromDefaults({ quality: 0.5 }), ['quality']);
  assert.deepEqual(S.diffFromDefaults({ quality: 0.5, format: 'pdf' }).sort(), ['format', 'quality']);
  /* 巢狀欄位要帶前綴，否則 UI 分不出 pdf.mode 與 mode */
  assert.deepEqual(S.diffFromDefaults({ pdf: { mode: 'single' } }), ['pdf.mode']);
});

/* ── 抓幀格式 ───────────────────────────────────────────────────────── */

test('captureFormatFor：PNG 目標抓 PNG，其餘抓 JPEG', () => {
  assert.equal(S.captureFormatFor({ format: 'png' }), 'png');
  assert.equal(S.captureFormatFor({ format: 'jpeg' }), 'jpeg');
  assert.equal(S.captureFormatFor({ format: 'webp' }), 'jpeg');
  /* PDF 最終是嵌入點陣圖，抓幀階段不必用無損 PNG */
  assert.equal(S.captureFormatFor({ format: 'pdf' }), 'jpeg');
  /* 明確指定就照指定，不受 format 影響 */
  assert.equal(S.captureFormatFor({ format: 'png', captureFormat: 'jpeg' }), 'jpeg');
  assert.equal(S.captureFormatFor({ format: 'webp', captureFormat: 'png' }), 'png');
});

test('captureQualityFor：只在 JPEG 下有效，且不能超過 1', () => {
  assert.equal(S.captureQualityFor({ format: 'png' }), undefined);
  assert.equal(S.captureQualityFor({ format: 'jpeg', quality: 0.92 }), 0.98);
  assert.equal(S.captureQualityFor({ format: 'jpeg', quality: 1 }), 1);
  assert.equal(S.captureQualityFor({ format: 'jpeg', quality: 0.3 }), 0.36);
});

/* ── store ──────────────────────────────────────────────────────────── */

test('createStore 無 storage 時退回記憶體，save 之後 load 讀得到', async () => {
  const store = S.createStore(null);
  assert.equal((await store.load()).quality, 0.92);

  await store.save({ quality: 0.5, format: 'jpeg' });
  const loaded = await store.load();
  assert.equal(loaded.quality, 0.5);
  assert.equal(loaded.format, 'jpeg');
  /* 存進去的東西同樣要過 normalize */
  assert.equal(loaded.keepHistory, 20);

  await store.reset();
  assert.equal((await store.load()).quality, 0.92);
});

test('createStore 有 storage 時讀寫同一個 key，且寫入的是收拾過的版本', async () => {
  const area = {};
  area.get = (key, cb) => cb({ [key]: area.__value });
  area.set = (payload, cb) => {
    area.__key = Object.keys(payload)[0];
    area.__value = payload[area.__key];
    cb();
  };

  const store = S.createStore(area);
  assert.equal((await store.load()).quality, 0.92);

  await store.save({ quality: 99 });
  assert.equal(area.__key, S.STORAGE_KEY);
  assert.equal(area.__value.quality, 1);
  assert.equal((await store.load()).quality, 1);
});
