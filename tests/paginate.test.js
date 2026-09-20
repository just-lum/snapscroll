/**
 * PDF 分頁測試
 *
 *   node --test tests/paginate.test.js
 *
 * 這裡測的是「印出來對不對」：一頁裝多少、切在哪、頁數多少、
 * 超過 PDF 單頁物理上限時有沒有乖乖降級。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const PG = require('../engine/paginate.js');
const LIMITS = require('../engine/limits.js');

test('A4 直式尺寸正確（pt）', () => {
  const p = PG.resolvePaper({ paper: 'a4' });
  assert.equal(Math.round(p.widthPt), 595);
  assert.equal(Math.round(p.heightPt), 842);
});

test('橫向只是把長短邊對調', () => {
  const p = PG.resolvePaper({ paper: 'a4', orientation: 'landscape' });
  assert.equal(Math.round(p.widthPt), 842);
  assert.equal(Math.round(p.heightPt), 595);
});

test('自訂紙張尺寸不會小於 72pt', () => {
  const p = PG.resolvePaper({ paper: 'custom', customSize: { widthPt: 10, heightPt: 20 } });
  assert.ok(p.widthPt >= 72 && p.heightPt >= 72);
});

test('fit-width：長圖切成多頁，每頁維持 A4 尺寸', () => {
  const plan = PG.planPages({
    imageWidth: 1200,
    imageHeight: 20000,
    paper: 'a4',
    marginPt: 36,
    mode: 'fit-width'
  });

  // 可用寬 = 595.276 - 72 = 523.276pt；縮放 = 523.276 / 1200
  // 可用高 = 841.89 - 72 = 769.89pt；一頁裝 769.89 / 0.4360633 ≈ 1765.6 px
  assert.equal(plan.rowHeightPx, 1765);
  assert.equal(plan.pageCount, Math.ceil(20000 / 1765));
  assert.equal(plan.pageCount, 12);

  for (const page of plan.pages) {
    assert.equal(page.pageWidth, PG.PAPERS.a4.widthPt);
    assert.equal(page.pageHeight, PG.PAPERS.a4.heightPt, 'keepPageSize 預設要統一頁高');
    assert.equal(page.drawX, 36);
    assert.equal(page.drawY, 36);
    assert.equal(page.sx, 0);
    assert.equal(page.sw, 1200);
  }

  // 切片要無縫接續且剛好蓋完整張圖
  let cursor = 0;
  for (const page of plan.pages) {
    assert.equal(page.sy, cursor);
    cursor += page.sh;
  }
  assert.equal(cursor, 20000);
});

test('fit-width：最後一頁只切剩下的部分', () => {
  const plan = PG.planPages({ imageWidth: 1200, imageHeight: 20000, marginPt: 36 });
  const last = plan.pages[plan.pages.length - 1];
  assert.equal(last.sh, 20000 - 11 * plan.rowHeightPx);
  assert.equal(last.sh, 585);
  assert.ok(last.drawHeight < plan.contentHeightPt);
});

test('keepPageSize:false 時最後一頁縮到內容高度', () => {
  const plan = PG.planPages({
    imageWidth: 1200,
    imageHeight: 20000,
    marginPt: 36,
    keepPageSize: false
  });
  const last = plan.pages[plan.pages.length - 1];
  assert.ok(Math.abs(last.pageHeight - (last.drawHeight + 72)) < 0.001);
});

test('短頁面只會有一頁', () => {
  const plan = PG.planPages({ imageWidth: 1200, imageHeight: 800, marginPt: 36 });
  assert.equal(plan.pageCount, 1);
  assert.equal(plan.pages[0].sh, 800);
});

test('single 模式：短長圖放進單一超高頁面', () => {
  const plan = PG.planPages({ imageWidth: 1200, imageHeight: 10000, mode: 'single' });
  assert.equal(plan.pageCount, 1);
  assert.equal(plan.mode, 'single');
  assert.equal(plan.pages[0].pageHeight, 10000 * PG.CSS_PX_TO_PT);
  assert.equal(plan.downgraded, null);
});

test('single 模式：超過 14400pt 物理上限時自動降級並說明原因', () => {
  const plan = PG.planPages({ imageWidth: 1200, imageHeight: 40000, marginPt: 36, mode: 'single' });
  assert.equal(plan.mode, 'fit-width', '應降級成 fit-width');
  assert.ok(plan.downgraded);
  assert.equal(plan.downgraded.reason, 'page-too-long');
  assert.equal(plan.downgraded.limitPt, LIMITS.MAX_PDF_PAGE_PT);
  assert.ok(plan.downgraded.requestedPt > LIMITS.MAX_PDF_PAGE_PT);
  assert.ok(plan.pageCount > 1);
});

test('fit-page：整張圖縮進一頁並居中', () => {
  const plan = PG.planPages({
    imageWidth: 1200,
    imageHeight: 600,
    paper: 'a4',
    marginPt: 20,
    mode: 'fit-page'
  });
  assert.equal(plan.pageCount, 1);
  const page = plan.pages[0];
  assert.ok(page.drawWidth <= plan.contentWidthPt + 0.001);
  assert.ok(page.drawHeight <= plan.contentHeightPt + 0.001);
  assert.ok(page.drawX >= 20 && page.drawY >= 20);
});

test('橫向紙張會裝得更少（頁數變多）', () => {
  const portrait = PG.planPages({ imageWidth: 1200, imageHeight: 20000, paper: 'a4' });
  const landscape = PG.planPages({ imageWidth: 1200, imageHeight: 20000, paper: 'a4', orientation: 'landscape' });
  assert.ok(landscape.pageCount > portrait.pageCount);
});

test('Letter / Legal / A3 都解得出來且頁數合理', () => {
  for (const id of ['letter', 'legal', 'a3', 'tabloid']) {
    const plan = PG.planPages({ imageWidth: 1000, imageHeight: 9000, paper: id });
    assert.ok(plan.pageCount >= 1, id);
    assert.ok(plan.paper.widthPt > 100, id);
    assert.equal(plan.pages.length, plan.pageCount);
  }
});

test('未知紙張 ID 退回 A4，不丟錯', () => {
  const plan = PG.planPages({ imageWidth: 1000, imageHeight: 1000, paper: 'no-such-paper' });
  assert.equal(plan.paper.id, 'a4');
});

test('極端寬圖不會算出 0 高度的一頁', () => {
  const plan = PG.planPages({ imageWidth: 100000, imageHeight: 5000, marginPt: 0 });
  assert.ok(plan.rowHeightPx >= 1);
  assert.ok(plan.pageCount >= 1);
  assert.ok(plan.pages.every(p => p.sh >= 1));
});

test('頁數超過保護上限時截斷並標記', () => {
  const plan = PG.planPages({ imageWidth: 100, imageHeight: 10000000, marginPt: 0 });
  assert.equal(plan.pageCount, PG.MAX_PAGES);
  assert.equal(plan.truncated, true);
  assert.ok(plan.requestedPageCount > PG.MAX_PAGES);
  assert.equal(plan.downgraded.reason, 'too-many-pages');
});

test('estimatePageCount 與 planPages 一致', () => {
  const opts = { imageWidth: 1200, imageHeight: 20000, paper: 'a4', marginPt: 36 };
  assert.equal(PG.estimatePageCount(opts), PG.planPages(opts).pageCount);
});

test('CSS px 到 pt 的換算常數是 0.75', () => {
  assert.equal(PG.CSS_PX_TO_PT, 0.75);
});
