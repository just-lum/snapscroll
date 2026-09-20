/**
 * 拼接座標測試
 *
 *   node --test tests/stitch-math.test.js
 *
 * 這裡測的是「像素有沒有對上」：裝置像素比例、每幀落點、捨入漂移、選區裁剪。
 * 長截圖看起來「中間有一條 1px 的線」或者「整體被拉長」，責任都在這支模組。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const M = require('../engine/stitch-math.js');
const SP = require('../engine/scroll-plan.js');

/* ── 比例量測 ───────────────────────────────────────────────────────── */

test('computeScale：一般 dpr = 2', () => {
  assert.equal(M.computeScale(1920, 960), 2);
});

test('computeScale：小數縮放 1.25 / 1.5', () => {
  assert.equal(M.computeScale(1250, 1000), 1.25);
  assert.equal(M.computeScale(1500, 1000), 1.5);
});

test('computeScale：量不到就退回 1，不把圖拉壞', () => {
  assert.equal(M.computeScale(0, 960), 1);
  assert.equal(M.computeScale(1920, 0), 1);
  assert.equal(M.computeScale(null, undefined), 1);
  assert.equal(M.computeScale(99999, 100), 1, '離譜到不可能是真的比例');
});

/* ── 整頁拼接落點 ───────────────────────────────────────────────────── */

test('frameDrawRect：連續兩幀首尾相接，無空隙也無重疊', () => {
  const frames = SP.planFrames({ pageHeight: 2000, viewportHeight: 1000 });
  const scale = 2; // dpr 2
  const a = M.frameDrawRect(frames[0], scale, 1920);
  const b = M.frameDrawRect(frames[1], scale, 1920);

  assert.equal(a.dy, 0);
  assert.equal(a.dh, 2000);
  assert.equal(b.dy, 2000, '第二幀必須緊接在第一幀底部');
  assert.equal(a.dy + a.dh, b.dy, '接縫必須是零');
  assert.equal(a.sw, 1920);
  assert.equal(a.dw, 1920, '來源與目標等寬，不能縮放');
});

test('frameDrawRect：末幀裁切區仍對齊同一個基準（無累積漂移）', () => {
  const frames = SP.planFrames({ pageHeight: 2501, viewportHeight: 1000 });
  const scale = 1.5;
  let expectTop = 0;
  for (const f of frames) {
    const r = M.frameDrawRect(f, scale, 1500);
    assert.equal(r.dy, expectTop, '每一幀的目標頂端要接上前一幀的底部');
    expectTop = r.dy + r.dh;
  }
  assert.equal(expectTop, Math.round(2501 * scale));
});

test('frameDrawRect：非整數比例下總高度不漂移（20 幀壓力測試）', () => {
  const vh = 613;
  const pageHeight = vh * 20 + 7;
  const frames = SP.planFrames({ pageHeight: pageHeight, viewportHeight: vh });
  const scale = 1.25;
  let cursor = 0;
  let maxDrift = 0;
  for (const f of frames) {
    const r = M.frameDrawRect(f, scale, Math.round(1200 * scale));
    maxDrift = Math.max(maxDrift, Math.abs(r.dy - cursor));
    cursor = r.dy + r.dh;
  }
  assert.ok(maxDrift <= 1, `接縫漂移應 ≤ 1px，實得 ${maxDrift}`);
  assert.equal(cursor, Math.round(pageHeight * scale));
});

test('frameDrawRect：縮放比例缺失時當作 1，不產生 0 高影格', () => {
  const r = M.frameDrawRect({ clipY: 0, clipHeight: 500, coveredBefore: 0 }, 0, 1200);
  assert.equal(r.dh, 500);
  assert.equal(r.sh, 500);
  assert.ok(r.sh >= 1);
});

/* ── 選區落點 ───────────────────────────────────────────────────────── */

test('regionDrawRect：多幀拼出連續的選區圖', () => {
  const frames = SP.planRegionFrames({ x: 0, y: 900, width: 800, height: 2500 }, 1000, 8000);
  const scale = 2;
  let cursor = 0;
  for (const f of frames) {
    const r = M.regionDrawRect(f, scale, 1600);
    assert.equal(r.dy, cursor);
    assert.equal(r.dh, r.sh, '來源與目標高度應一致');
    cursor = r.dy + r.dh;
  }
  assert.equal(cursor, 2500 * scale);
});

/* ── 畫布尺寸 ───────────────────────────────────────────────────────── */

test('canvasSizeFor：整頁畫布尺寸隨比例放大', () => {
  assert.deepEqual(M.canvasSizeFor(1200, 5000, 2), { width: 2400, height: 10000, scale: 2 });
  assert.deepEqual(M.canvasSizeFor(1200, 5000, 1), { width: 1200, height: 5000, scale: 1 });
});

test('canvasSizeFor：極小或缺失值不會產生 0 尺寸畫布', () => {
  const r = M.canvasSizeFor(0, 0, 1);
  assert.ok(r.width >= 1 && r.height >= 1);
});

/* ── 工具函式 ───────────────────────────────────────────────────────── */

test('fitRect：等比縮進預覽框', () => {
  const r = M.fitRect(1200, 6000, 400, 300);
  assert.equal(r.width, 60);
  assert.equal(r.height, 300);
});

test('cropRect：裁到畫布內，負座標歸零', () => {
  const r = M.cropRect({ x: -50, y: 20, width: 200, height: 200 }, { width: 100, height: 100 });
  assert.deepEqual(r, { x: 0, y: 20, width: 100, height: 80 });
});

test('rectFromPoints：反向拖曳也能得到正規化矩形', () => {
  const r = M.rectFromPoints({ x: 300, y: 400 }, { x: 100, y: 150 });
  assert.deepEqual(r, { x: 100, y: 150, width: 200, height: 250 });
});

test('toImagePx：CSS 長度換成圖片像素', () => {
  assert.equal(M.toImagePx(120, 2), 240);
  assert.equal(M.toImagePx(120, 1.25), 150);
});

test('clamp：邊界與 NaN', () => {
  assert.equal(M.clamp(5, 0, 10), 5);
  assert.equal(M.clamp(-5, 0, 10), 0);
  assert.equal(M.clamp(50, 0, 10), 10);
  assert.equal(M.clamp('abc', 2, 10), 2);
});
