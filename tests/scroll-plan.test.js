/**
 * 滾動計劃測試
 *
 *   node --test tests/scroll-plan.test.js
 *
 * 這裡測的是「接縫對不對」：每一幀滾到哪、留哪一段、有沒有空洞或重疊。
 * 空洞會在長圖中間留下一條白線，重疊會讓某段內容出現兩次——兩者都是長截圖的
 * 經典災難，而且都是這裡的算術決定的。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const SP = require('../engine/scroll-plan.js');

/* ── 覆蓋區間 ───────────────────────────────────────────────────────── */

function coveredRanges(frames) {
  return frames.map(function (f) { return [f.coveredBefore, f.coveredAfter]; });
}

test('planFrames：頁面剛好一屏 → 單幀，不裁切', () => {
  const frames = SP.planFrames({ pageHeight: 1000, viewportHeight: 1000 });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].y, 0);
  assert.equal(frames[0].clipY, 0);
  assert.equal(frames[0].clipHeight, 1000);
});

test('planFrames：頁面不足一屏 → 單幀，仍不裁切', () => {
  const frames = SP.planFrames({ pageHeight: 420, viewportHeight: 1000 });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].clipHeight, 420);
  assert.equal(frames[0].coveredAfter, 420);
});

test('planFrames：高度是整數倍 → 每幀不留重疊', () => {
  const frames = SP.planFrames({ pageHeight: 2000, viewportHeight: 1000 });
  assert.equal(frames.length, 2);
  assert.deepEqual(coveredRanges(frames), [[0, 1000], [1000, 2000]]);
  assert.ok(frames.every(f => f.clipY === 0 && f.clipHeight === 1000));
});

test('planFrames：高度帶餘數 → 末幀滾到底再從幀內裁出尾段', () => {
  const frames = SP.planFrames({ pageHeight: 2500, viewportHeight: 1000 });
  assert.equal(frames.length, 3);
  assert.deepEqual(coveredRanges(frames), [[0, 1000], [1000, 2000], [2000, 2500]]);

  // 末幀一定停在 maxScroll，並從幀內裁掉上面已經拍過的部分
  const last = frames[2];
  assert.equal(last.y, 1500, 'scrollY 應鉗在 maxScroll = 2500 - 1000');
  assert.equal(last.clipY, 500);
  assert.equal(last.clipHeight, 500);
});

test('planFrames：餘數極小（只差 1px）時不會多截一整屏', () => {
  const frames = SP.planFrames({ pageHeight: 1001, viewportHeight: 1000 });
  assert.equal(frames.length, 2);
  assert.equal(frames[1].y, 1);
  assert.equal(frames[1].clipY, 999);
  assert.equal(frames[1].clipHeight, 1);
});

test('planFrames：零高度頁面 → 沒有任何幀', () => {
  assert.deepEqual(SP.planFrames({ pageHeight: 0, viewportHeight: 800 }), []);
});

test('planFrames：極長頁面不會爆掉（幀數可控）', () => {
  const frames = SP.planFrames({ pageHeight: 500000, viewportHeight: 900 });
  assert.ok(frames.length > 500);
  assert.ok(frames.length < 1000);
  assert.equal(frames[frames.length - 1].coveredAfter, 500000);
});

/* ── 完整性自檢 ─────────────────────────────────────────────────────── */

test('verifyFrames：各種高度都能無縫蓋滿', () => {
  const viewports = [600, 720, 900, 1080];
  const heights = [1, 599, 600, 601, 1200, 1201, 2500, 3333, 10000, 45001];
  for (const vh of viewports) {
    for (const h of heights) {
      const frames = SP.planFrames({ pageHeight: h, viewportHeight: vh });
      const report = SP.verifyFrames(frames, h, vh);
      assert.ok(report.ok, `v=${vh} h=${h} 應完整覆蓋，實得 ${JSON.stringify(report)}`);
      assert.equal(report.covered, h);
      assert.equal(report.gaps.length, 0);
      assert.equal(report.overlaps.length, 0);
      assert.ok(report.frameHeightOk);
      assert.ok(report.maxScrollRespected);
    }
  }
});

test('verifyFrames：缺幀時能指出空洞位置', () => {
  const frames = SP.planFrames({ pageHeight: 3000, viewportHeight: 1000 });
  const broken = [frames[0], frames[2]];
  const report = SP.verifyFrames(broken, 3000, 1000);
  assert.equal(report.ok, false);
  assert.equal(report.gaps.length, 1);
  assert.equal(report.gaps[0].from, 1000);
  assert.equal(report.gaps[0].to, 2000);
});

/* ── 動態高度（懶載入、無限滾動）────────────────────────────────────── */

test('createWalker：以為截完了，但頁面長高時要醒過來繼續', () => {
  const walker = SP.createWalker({ pageHeight: 1000, viewportHeight: 1000 });
  const first = walker.next(1000);
  assert.equal(first.clipHeight, 1000);
  assert.equal(walker.done, true, '按「當前已知高度」已經走完');

  // 懶載入把頁面撐高：walker 必須接受新高度繼續，否則會少截一大段
  const second = walker.next(5000);
  assert.ok(second, '頁面長高後應繼續出幀');
  assert.equal(second.coveredAfter, 2000);
  assert.equal(walker.done, false);

  const third = walker.next(5000);
  assert.equal(third.coveredAfter, 3000);
});

test('createWalker：每幀回報最新高度，逐步走完整頁', () => {
  const walker = SP.createWalker({ pageHeight: 1000, viewportHeight: 1000 });
  const frames = [];
  let feed = 1000;
  let f;
  while ((f = walker.next(feed)) !== null && frames.length < 50) {
    frames.push(f);
    // 模擬每滾一屏就又載入一批內容
    feed = Math.min(5000, feed + 1000);
  }
  assert.equal(frames.length, 5);
  assert.equal(walker.covered, 5000);
  assert.equal(walker.pageHeight, 5000);
  assert.equal(walker.progress, 1);
  assert.equal(frames[4].coveredAfter, 5000);
});

test('createWalker：可以從「已經覆蓋一段」的位置接續', () => {
  /* 第一幀抓完才知道真正能拍到多高，那時要用新的視口高重建 walker，
   * 並且把第一幀已經覆蓋的區段算進去，不能重拍。 */
  const walker = SP.createWalker({ pageHeight: 5000, viewportHeight: 800, covered: 771 });
  assert.equal(walker.covered, 771);
  assert.equal(walker.viewportHeight, 800);

  const f = walker.next(5000);
  assert.equal(f.y, 771, '要從已經覆蓋的位置繼續，而不是回到第一幀的頂端');
  assert.equal(f.coveredBefore, 771);
  assert.equal(f.coveredAfter, 1571);
});

test('createWalker：covered 預設為 0', () => {
  const walker = SP.createWalker({ pageHeight: 3000, viewportHeight: 800 });
  assert.equal(walker.covered, 0);
  assert.equal(walker.next(3000).y, 0);
});

test('createWalker：頁面變矮時不跟進（避免撕裂已拼接的內容）', () => {
  const walker = SP.createWalker({ pageHeight: 4000, viewportHeight: 1000 });
  walker.next(4000);
  walker.next(4000);
  walker.next(2000); // 頁面重排變矮，應被忽略
  assert.equal(walker.pageHeight, 4000);
});

/* ── 捲動是否真的生效 ───────────────────────────────────────────────── */

test('isScrollSettled：允許幾個像素的取整誤差', () => {
  assert.equal(SP.isScrollSettled(860, 860), true);
  assert.equal(SP.isScrollSettled(860, 858), true);
  assert.equal(SP.isScrollSettled(860, 864), true, '預設容差是 4px');
  assert.equal(SP.isScrollSettled(860, 866), false, '超出容差就要算失敗');
});

test('isScrollSettled：滾不動就是 false——這是整頁截圖的守門條件', () => {
  assert.equal(SP.isScrollSettled(1720, 0), false);
  assert.equal(SP.isScrollSettled(860, 100), false);
  assert.equal(SP.isScrollSettled(5100, 0), false);
});

test('isScrollSettled：兩邊都是 0 是合法的（頁面只有一屏）', () => {
  assert.equal(SP.isScrollSettled(0, 0), true);
});

test('isScrollSettled：非數字一律視為失敗，不猜', () => {
  assert.equal(SP.isScrollSettled(undefined, 0), false);
  assert.equal(SP.isScrollSettled(100, NaN), false);
  assert.equal(SP.isScrollSettled(null, null), false);
});

test('isScrollSettled：容差可以調', () => {
  assert.equal(SP.isScrollSettled(100, 120, 30), true);
  assert.equal(SP.isScrollSettled(100, 120, 5), false);
  assert.equal(SP.isScrollSettled(100, 100, 0), true);
});

/* ── 選區 / 元素截圖 ────────────────────────────────────────────────── */

test('planRegionFrames：範圍在單屏內 → 只掃一幀', () => {
  const frames = SP.planRegionFrames({ x: 0, y: 200, width: 500, height: 300 }, 1000, 5000);
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], { y: 0, srcY: 200, srcH: 300, dstY: 0 });
});

test('planRegionFrames：跨三屏的範圍 → 每幀貼到結果圖的正確位置', () => {
  const frames = SP.planRegionFrames({ x: 0, y: 900, width: 800, height: 2500 }, 1000, 8000);
  assert.equal(frames.length, 3, '從選區頂端開始掃，不必浪費一幀去接第一屏');
  assert.deepEqual(frames.map(f => f.y), [900, 1900, 2900]);
  assert.deepEqual(frames.map(f => f.srcH), [1000, 1000, 500]);
  assert.deepEqual(frames.map(f => f.dstY), [0, 1000, 2000]);
  // 每段來源 + 目標都要首尾相接
  let cursor = 0;
  for (const f of frames) {
    assert.equal(f.dstY, cursor);
    cursor += f.srcH;
  }
  assert.equal(cursor, 2500);
});

test('planRegionFrames：範圍貼近頁面底部 → 需滾到底再從幀內裁', () => {
  const frames = SP.planRegionFrames({ x: 0, y: 4500, width: 100, height: 500 }, 1000, 5000);
  const total = frames.reduce((n, f) => n + f.srcH, 0);
  assert.equal(total, 500);
  assert.equal(frames[frames.length - 1].y, 4000, '最後一幀滾到 maxScroll');
});

test('planRegionFrames：零面積範圍 → 不產生任何幀', () => {
  assert.deepEqual(SP.planRegionFrames({ x: 0, y: 10, width: 0, height: 0 }, 1000, 5000), []);
  assert.deepEqual(SP.planRegionFrames(null, 1000, 5000), []);
});

test('step：單步 API 與 planFrames 結果一致', () => {
  let covered = 0;
  const stepped = [];
  let f;
  while ((f = SP.step({ covered, viewportHeight: 700, pageHeight: 2500 })) !== null) {
    stepped.push(f);
    covered = f.coveredAfter;
  }
  const planned = SP.planFrames({ pageHeight: 2500, viewportHeight: 700 });
  assert.equal(stepped.length, planned.length);
  assert.deepEqual(
    stepped.map(x => [x.y, x.clipY, x.clipHeight]),
    planned.map(x => [x.y, x.clipY, x.clipHeight])
  );
});
