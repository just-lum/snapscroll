/**
 * PDF 生成器測試
 *
 *   node --test tests/pdf-writer.test.js
 *
 * 這裡測的是「檔案有沒有壞」：偏移量對不對、xref 表能不能走通、JPEG 有沒有
 * 原封不動進去、中文標題會不會變亂碼。驗證方式是自己寫一個迷你 xref 檢核器
 * 去讀自己產出的檔——不引入任何 PDF 函式庫，因為這個專案本來就是要省掉它。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const PDF = require('../engine/pdf-writer.js');

/* 一個結構合法但內容假的 JPEG：PDF 不會去解它，只會照抄位元組 */
function fakeJpeg(size, marker) {
  const bytes = new Uint8Array(size);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  bytes[3] = 0xe0;
  for (let i = 4; i < size - 2; i++) bytes[i] = (marker + i) & 0xff;
  bytes[size - 2] = 0xff;
  bytes[size - 1] = 0xd9;
  return bytes;
}

function textOf(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out += (b >= 0x09 && b <= 0x7e) ? String.fromCharCode(b) : '\n';
  }
  return out;
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) >= 0) {
    count++;
    idx += needle.length;
  }
  return count;
}

function onePage(overrides = {}) {
  return Object.assign({
    jpeg: fakeJpeg(1024, 0x40),
    pixelWidth: 1200,
    pixelHeight: 1765,
    pageWidth: 595.276,
    pageHeight: 841.89,
    drawX: 36,
    drawY: 36,
    drawWidth: 523.276,
    drawHeight: 769.89
  }, overrides);
}

/* ── 結構 ───────────────────────────────────────────────────────────── */

test('單頁 PDF：標頭、xref、EOF 齊全且自洽', () => {
  const bytes = PDF.buildPdf({ pages: [onePage()], meta: { title: 'Test' } });
  const report = PDF.verifyPdf(bytes);

  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.equal(report.objects, 6, '1 catalog + 1 pages + 1 info + 頁面三件組');
  assert.equal(report.checkedEntries, 6);
});

test('多頁 PDF：每頁都有獨立的 Page / Contents / Image 物件', () => {
  const pages = [onePage(), onePage(), onePage()];
  const bytes = PDF.buildPdf({ pages });
  const text = textOf(bytes);

  assert.equal(textOf(bytes).indexOf('%PDF-1.4'), 0);
  assert.equal(countOccurrences(text, '/Type /Pages'), 1, '文件級節點只有一個');
  assert.equal(countOccurrences(text, '/Type /Page '), 3, '三個頁面物件（/Type /Pages 尾隨 s，不會被算進來）');
  assert.equal(countOccurrences(text, '/Subtype /Image'), 3);
  assert.equal(countOccurrences(text, '/Filter /DCTDecode'), 3);

  const report = PDF.verifyPdf(bytes);
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.equal(report.objects, 12);
});

test('xref 每一行剛好 20 位元組（含換行）', () => {
  const bytes = PDF.buildPdf({ pages: [onePage(), onePage()] });
  const text = textOf(bytes);
  /* 'startxref' 也含有 'xref'，所以要找獨立成行的那一個 */
  const start = text.lastIndexOf('\nxref\n') + 1;
  const lines = text.slice(start).split('\n');

  assert.equal(lines[0], 'xref');
  assert.equal(lines[1], '0 10', '兩頁 → 9 個物件 + 0 號自由物件');
  assert.equal(lines[2], '0000000000 65535 f ');
  for (let i = 3; i < 12; i++) {
    assert.equal(lines[i].length, 19, `第 ${i - 2} 條 xref 條目長度不對：${JSON.stringify(lines[i])}`);
    assert.match(lines[i], /^\d{10} \d{5} n $/);
  }
});

test('startxref 指向的位元組位置真的寫著 xref', () => {
  const bytes = PDF.buildPdf({ pages: [onePage()] });
  const text = textOf(bytes);
  const offset = parseInt(/startxref\n(\d+)/.exec(text)[1], 10);
  const at = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
  assert.equal(at, 'xref');
});

/* ── 影像串流 ───────────────────────────────────────────────────────── */

test('JPEG 位元組原封不動進入 PDF，且 /Length 完全相符', () => {
  const jpeg = fakeJpeg(5000, 0x11);
  const bytes = PDF.buildPdf({ pages: [onePage({ jpeg })] });

  const needle = '/Filter /DCTDecode /Length 5000 >>\nstream\n';
  const text = textOf(bytes);
  const idx = text.indexOf(needle);
  assert.ok(idx >= 0, '找不到影像串流標頭');

  // text 是逐位元組映射，所以 idx 同時是字元位置與位元組位置
  const streamStart = idx + needle.length;
  assert.equal(bytes[streamStart], 0xff);
  assert.equal(bytes[streamStart + 1], 0xd8);

  // 直接把 JPEG 整段比對
  let matched = true;
  for (let i = 0; i < jpeg.length; i++) {
    if (bytes[streamStart + i] !== jpeg[i]) { matched = false; break; }
  }
  assert.ok(matched, 'JPEG 內容在 PDF 裡被改動了');
});

test('二進位內容不會打亂 xref 偏移計算', () => {
  // 造一個滿是換行與特殊字元的 JPEG，最容易讓「用字串長度算偏移」的實作歪掉
  const jpeg = new Uint8Array(4096);
  for (let i = 0; i < jpeg.length; i++) jpeg[i] = [0x0a, 0x0d, 0x28, 0x29, 0x5c, 0xff][i % 6];

  const bytes = PDF.buildPdf({ pages: [onePage({ jpeg }), onePage({ jpeg })] });
  const report = PDF.verifyPdf(bytes);
  assert.equal(report.ok, true, JSON.stringify(report.errors));
});

/* ── 文字編碼 ───────────────────────────────────────────────────────── */

test('純 ASCII 標題用字面字串', () => {
  assert.equal(PDF.pdfText('Hello'), '(Hello)');
});

test('括號與反斜線會轉義', () => {
  assert.equal(PDF.pdfText('a(b)c\\d'), '(a\\(b\\)c\\\\d)');
});

test('中文標題改用 UTF-16BE 十六進位字串', () => {
  const encoded = PDF.pdfText('長截圖');
  assert.ok(encoded.startsWith('<FEFF'), '應以 BOM 開頭的十六進位字串');
  assert.ok(encoded.endsWith('>'));
  assert.ok(/^<[0-9A-F]+>$/.test(encoded));
  // 「長」= U+9577
  assert.ok(encoded.indexOf('9577') > 0);
});

test('中文標題寫進 PDF 後仍是合法的十六進位字串', () => {
  const bytes = PDF.buildPdf({ pages: [onePage()], meta: { title: '訂單 長截圖 2025' } });
  const text = textOf(bytes);
  assert.ok(/\/Title <FEFF[0-9A-F]+>/.test(text), '中文標題沒有正確編碼');
  assert.equal(PDF.verifyPdf(bytes).ok, true);
});

test('日期格式符合 PDF 規範 D:YYYYMMDDHHmmSS±HH\'mm\'', () => {
  const d = new Date(2025, 0, 14, 9, 5, 7);
  const s = PDF.pdfDate(d);
  assert.match(s, /^D:20250114090507[+-]\d{2}'\d{2}'$/);
});

/* ── 數字格式 ───────────────────────────────────────────────────────── */

test('數字不使用科學記號且去掉尾零', () => {
  assert.equal(PDF.num(595.276), '595.276');
  assert.equal(PDF.num(0), '0');
  assert.equal(PDF.num(100), '100');
  assert.equal(PDF.num(1.5), '1.5');
  assert.equal(PDF.num(1e-7), '0');
  assert.equal(PDF.num(NaN), '0');
  assert.equal(PDF.num(-0.0001), '0');
});

test('頁面尺寸與影像落點以 pt 寫入 MediaBox / cm', () => {
  const bytes = PDF.buildPdf({ pages: [onePage()] });
  const text = textOf(bytes);
  assert.ok(text.indexOf('/MediaBox [0 0 595.276 841.89]') > 0);
  assert.ok(text.indexOf('q 523.276 0 0 769.89 36 36 cm /Im0 Do Q') > 0);
});

/* ── 錯誤處理 ───────────────────────────────────────────────────────── */

test('沒有頁面時明確丟錯，而不是產出空檔', () => {
  assert.throws(() => PDF.buildPdf({ pages: [] }), /至少需要一頁/);
  assert.throws(() => PDF.buildPdf({}), /至少需要一頁/);
});

test('影像資料接受 ArrayBuffer 與普通陣列', () => {
  const jpeg = fakeJpeg(64, 0x7f);
  const fromArray = PDF.buildPdf({ pages: [onePage({ jpeg: Array.from(jpeg) })] });
  const fromBuffer = PDF.buildPdf({ pages: [onePage({ jpeg: jpeg.buffer })] });
  assert.equal(PDF.verifyPdf(fromArray).ok, true);
  assert.equal(PDF.verifyPdf(fromBuffer).ok, true);
  assert.equal(fromArray.length, fromBuffer.length);
});

test('verifyPdf 能抓出 startxref 偏移被改壞的檔案', () => {
  const bytes = PDF.buildPdf({ pages: [onePage()] });
  const text = textOf(bytes);
  const m = /startxref\n(\d+)/.exec(text);
  const valuePos = m.index + 'startxref\n'.length;
  const len = m[1].length;

  const broken = bytes.slice();
  for (let i = 0; i < len; i++) {
    broken[valuePos + i] = (i === len - 1 ? '1' : '0').charCodeAt(0); // 指向偏移 1
  }
  const report = PDF.verifyPdf(broken);
  assert.equal(report.ok, false);
  assert.ok(report.errors.length > 0);
});

test('verifyPdf 能抓出被截斷的檔案', () => {
  const bytes = PDF.buildPdf({ pages: [onePage()] });
  const truncated = bytes.slice(0, Math.floor(bytes.length / 2));
  const report = PDF.verifyPdf(truncated);
  assert.equal(report.ok, false);
});

test('100 頁的檔案仍然自洽（規模壓力）', () => {
  const pages = [];
  for (let i = 0; i < 100; i++) pages.push(onePage({ jpeg: fakeJpeg(300 + i, i) }));
  const bytes = PDF.buildPdf({ pages });
  const report = PDF.verifyPdf(bytes);
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.equal(report.objects, 303);
});
