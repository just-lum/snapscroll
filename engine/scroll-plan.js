/* SnapScroll — 滾動計劃
 *
 * 長截圖的骨頭是「每一幀該滾到哪、這一幀的哪一段要留下來」。
 * 弄錯這裡的結果是：接縫處少一條線（空洞）或多一條重複的內容（鬼影）。
 *
 * 規則很單純但邊界很囉唆：
 *   - 視口高 h，頁面高 H。能滾到的最大位置是 maxScroll = H - h。
 *   - 前面每一幀從 y = 0, h, 2h… 開始，整幀都用。
 *   - 最後一幀一定滾到底（y = maxScroll），它和前面已覆蓋的區間會重疊，
 *     所以只取「還沒被覆蓋的那一段」——這也是為什麼每幀都帶 clipY / clipHeight。
 *   - 頁面在截圖途中可能因為懶載入長高，所以除了靜態規劃，也提供逐幀推
 *     進的 walker，讓呼叫方每幀回報最新的 pageHeight。
 *
 * 全部是純函式，不碰 DOM。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SnapScrollScrollPlan = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* 防呆：理論上不會跑這麼多幀，真的跑到就代表高度計算出了問題 */
  var MAX_FRAMES = 20000;

  function toInt(n, fallback) {
    var v = Math.floor(Number(n));
    return isFinite(v) ? v : (fallback || 0);
  }

  /* 單步推進：給定「已覆蓋到哪」與視口高，算出下一幀。
   *
   *   state = { covered, viewportHeight, pageHeight }
   *   → null（已經覆蓋完整頁）
   *   → { y, clipY, clipHeight, coveredBefore, coveredAfter, actualScrollY }
   *
   * 單位一律是 CSS px（頁面座標），像素換算交給 stitch-math.js。
   */
  function step(state) {
    var h = Math.max(1, toInt(state && state.viewportHeight, 1));
    var H = Math.max(0, toInt(state && state.pageHeight, 0));
    var covered = Math.max(0, toInt(state && state.covered, 0));

    if (H <= 0) return null;
    if (covered >= H) return null;

    /* 這一幀「打算」滾到哪：照理是已覆蓋處再往下推一整個視口。
     * 但頁面底部不允許再滾，所以要鉗到 maxScroll。 */
    var maxScroll = Math.max(0, H - h);
    var planned = covered;
    var actualScrollY = Math.min(planned, maxScroll);

    var frameTop = actualScrollY;
    var frameBottom = Math.min(actualScrollY + h, H);

    /* 幀內要保留的區段：從「已覆蓋」之後開始，到幀底為止 */
    var keepFrom = Math.max(frameTop, covered);
    var clipY = keepFrom - frameTop;
    var clipHeight = frameBottom - keepFrom;

    if (clipHeight <= 0) return null;

    return {
      y: actualScrollY,
      clipY: clipY,
      clipHeight: clipHeight,
      coveredBefore: covered,
      coveredAfter: frameBottom,
      pageHeight: H,
      viewportHeight: h
    };
  }

  /* 靜態規劃：頁面高度已知時，一次算出全部幀。 */
  function planFrames(opts) {
    var h = Math.max(1, toInt(opts && opts.viewportHeight, 1));
    var H = Math.max(0, toInt(opts && opts.pageHeight, 0));
    var frames = [];
    var covered = 0;
    var guard = 0;

    while (guard++ < MAX_FRAMES) {
      var f = step({ covered: covered, viewportHeight: h, pageHeight: H });
      if (!f) break;
      f.index = frames.length;
      frames.push(f);
      covered = f.coveredAfter;
    }
    return frames;
  }

  /* 逐幀 walker：頁面高度會在截圖途中變動（懶載入、無限滾動）時用它。
   * 呼叫方每幀把最新的 pageHeight 丟進來，walker 會自己修正剩下的計劃。 */
  function createWalker(opts) {
    var h = Math.max(1, toInt(opts && opts.viewportHeight, 1));
    var H = Math.max(0, toInt(opts && opts.pageHeight, 0));
    /* 允許「已經覆蓋了多少」帶進來：第一幀抓完之後才量得到真正的可用高度，
     * 那時要用新的視口高重建 walker，並且不能把第一幀覆蓋過的區段再拍一次。 */
    var covered = Math.max(0, toInt(opts && opts.covered, 0));
    var index = 0;
    var finished = false;

    return {
      next: function (latestPageHeight) {
        var newH = toInt(latestPageHeight, 0);
        /* 只接受「長高」：縮短通常代表頁面重排，硬跟會撕裂已拼接的內容。
         * 但長高必須能喚醒一個「已經走完」的 walker——懶載入的內容往往要滾
         * 下去之後才把頁面撐高，只看第一屏的高度會少截一大段。 */
        if (newH > H) H = newH;

        var f = step({ covered: covered, viewportHeight: h, pageHeight: H });
        if (!f) {
          finished = true;
          return null;
        }
        f.index = index++;
        covered = f.coveredAfter;
        /* 每次重新判定，而不是一旦完成就鎖死——長高之後它還要能再動起來 */
        finished = covered >= H;
        return f;
      },
      get covered() { return covered; },
      get pageHeight() { return H; },
      get viewportHeight() { return h; },
      get done() { return finished; },
      get totalFrames() { return index; },
      /* 進度只反映「已覆蓋 / 目前已知高度」，遇到無限滾動會停在 99% 附近，
       * 這是誠實的：真的不知道還有多長。 */
      get progress() {
        if (H <= 0) return 1;
        return Math.min(1, covered / H);
      }
    };
  }

  /* 捲動有沒有真的到位？
   *
   * 這一個判斷是「整頁截圖有沒有真的滾下去」的唯一證據。少了它，一個
   * 滾不動的頁面會被安安靜靜地拍完十幾幀，最後給你一張尺寸完全正確、
   * 內容卻是同一屏重複的圖——最糟的那種失敗，因為它看起來像成功。
   *
   * 容許幾個像素：瀏覽器對捲動位置取整、以及亞像素版面都可能造成 ±1~2px。
   */
  function isScrollSettled(expectedY, actualY, tolerance) {
    /* 缺值要當成「不知道」，不能當成 0——`Number(null) === 0` 會讓
     * 「沒量到位置」被誤判成「停在頂端，一切正常」。 */
    if (expectedY == null || actualY == null) return false;
    var t = tolerance == null ? 4 : Math.max(0, Number(tolerance) || 0);
    var e = Number(expectedY);
    var a = Number(actualY);
    if (!isFinite(e) || !isFinite(a)) return false;
    return Math.abs(a - e) <= t;
  }

  /* 覆蓋完整性檢查：把算出來的幀拼起來，是否剛好蓋滿 0..H 且不重疊？
   * 測試靠它；執行期在收尾時也跑一次，當作最後一道自檢。 */
  function verifyFrames(frames, pageHeight, viewportHeight) {
    var H = toInt(pageHeight, 0);
    var h = Math.max(1, toInt(viewportHeight, 1));
    var cursor = 0;
    var gaps = [];
    var overlaps = [];
    var list = frames || [];

    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      var from = f.coveredBefore;
      var to = f.coveredAfter;
      if (from > cursor) gaps.push({ index: i, from: cursor, to: from });
      if (from < cursor) overlaps.push({ index: i, from: from, to: cursor });
      cursor = Math.max(cursor, to);
    }
    return {
      ok: gaps.length === 0 && overlaps.length === 0 && list.length > 0 && cursor === H,
      covered: cursor,
      expected: H,
      gaps: gaps,
      overlaps: overlaps,
      frameCount: list.length,
      frameHeightOk: list.every(function (f) { return f.clipHeight > 0 && f.clipY >= 0; }),
      maxScrollRespected: list.every(function (f) { return f.y <= Math.max(0, H - h); })
    };
  }

  /* 選區／元素截圖：不必拼接整頁，只要掃過覆蓋 rect 的那幾幀。
   * 回傳 [{ y, srcY, srcH, dstY }] —— 滾到 y，從幀內 srcY 處取 srcH 高，貼到結果圖 dstY。 */
  function planRegionFrames(rect, viewportHeight, pageHeight) {
    var h = Math.max(1, toInt(viewportHeight, 1));
    var H = Math.max(0, toInt(pageHeight, 0));
    var top = Math.max(0, Math.floor(Number(rect && rect.y) || 0));
    var height = Math.max(0, Math.floor(Number(rect && rect.height) || 0));
    var bottom = Math.min(top + height, H);
    var frames = [];

    if (height <= 0 || bottom <= top) return frames;

    var maxScroll = Math.max(0, H - h);
    /* 選區若整個落在第一屏裡就別滾了：滾動會觸發懶載入與動畫，
     * 白白改變頁面狀態，還可能讓目標元素跑位。 */
    var y = bottom <= h ? 0 : Math.min(top, maxScroll);
    var guard = 0;

    while (guard++ < MAX_FRAMES) {
      var from = Math.max(y, top);
      var to = Math.min(y + h, bottom);
      if (to > from) {
        frames.push({ y: y, srcY: from - y, srcH: to - from, dstY: from - top });
        if (to >= bottom) break;
      }
      if (y >= maxScroll) break;
      var nextY = y + h;
      y = nextY > maxScroll ? maxScroll : nextY;
    }
    return frames;
  }

  return {
    MAX_FRAMES: MAX_FRAMES,
    step: step,
    planFrames: planFrames,
    createWalker: createWalker,
    isScrollSettled: isScrollSettled,
    verifyFrames: verifyFrames,
    planRegionFrames: planRegionFrames
  };
});
