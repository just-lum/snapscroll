/* SnapScroll — 畫布與任務規模上限
 *
 * 為什麼需要這一層：`captureVisibleTab` 拼出來的長圖不是「想做多大就多大」。
 * Chromium 的 canvas 有兩個獨立的天花板——
 *   1. 單邊上限（width/height 任一超標就整張畫布失效）
 *   2. 總面積上限（Skia 內部 2^28 像素的硬限制）
 * 超標時 `toBlob()` 不會拋錯，而是靜默回傳 null，非常難查。
 *
 * 這裡的常量刻意取「一定安全」的值而不是最大值：不同 GPU/驅動的實際可用尺寸
 * 有差異，與其貼著上限賭一把，不如早一點降級成分片輸出。真正的上限仍由
 * offscreen 端的運行時探測（probeCanvasSupport）動態確認。
 *
 * 全部是純函式，不碰 DOM、不呼叫 chrome.*，因此能在 Node 測試裡直接跑。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SnapScrollLimits = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* 保守的單邊上限。Chromium 桌面實測可到 65535，但歷史上 32767 / 16384
   * 都出現過，取 32767 是「不必探測也不會踩雷」的值。 */
  var MAX_SIDE = 32767;

  /* 安全面積 ≈ 480 MB 的 RGBA 點陣圖。超過這個數量級，拼接期間的兩張
   * 大畫布加上 ImageBitmap 峰值很容易把 renderer 逼到 OOM。 */
  var SAFE_AREA = 120000000;

  /* Skia 的硬上限（2^28）。超過必定失敗，僅作為最後一道欄杆。 */
  var HARD_AREA = 268435456;

  /* 分片數上限：避免一個 20 萬像素高的頁面切出上千個檔把使用者淹沒。 */
  var MAX_SLICES = 40;

  /* 少於這個像素數的捲動距離就當成「不能捲」——瀏覽器對捲動位置取整、
   * 以及亞像素版面都可能造成 ±1~2px 的假位移。 */
  var SCROLL_MIN_DEPTH = 8;

  /* 內容底端超過視口這個倍數，就認為「頁面明明有更多東西在下面」 */
  var OFFSCREEN_FACTOR = 1.5;

  /* 某個高度來源超過視口這個倍數，卻量不到捲動距離 → 矛盾 */
  var HEIGHT_CONFLICT_FACTOR = 1.2;

  /* PDF 單頁的物理上限（Acrobat 系列限制 200 英吋 = 14400pt）。
   * 超過就要從「單頁長圖」降級成「分頁」模式。 */
  var MAX_PDF_PAGE_PT = 14400;

  function isPositiveInt(n) {
    return typeof n === 'number' && isFinite(n) && n > 0;
  }

  function toInt(n, fallback) {
    var v = Math.floor(Number(n));
    return isFinite(v) && v > 0 ? v : (fallback || 0);
  }

  /* 單張畫布能不能安全裝下這個尺寸 */
  function isSingleCanvasSafe(width, height) {
    var w = toInt(width, 0);
    var h = toInt(height, 0);
    if (!w || !h) return false;
    if (w > MAX_SIDE || h > MAX_SIDE) return false;
    return w * h <= SAFE_AREA;
  }

  /* 把一張 (width × height) 的長圖切成若干橫條，每條都能安全放進 canvas。
   * 回傳 [{ y, h }]，y 以圖片像素為單位，由上往下。 */
  function planSlices(width, height, maxArea, maxSide) {
    var w = toInt(width, 0);
    var h = toInt(height, 0);
    var area = isPositiveInt(maxArea) ? maxArea : SAFE_AREA;
    var side = isPositiveInt(maxSide) ? maxSide : MAX_SIDE;
    if (!w || !h) return [];

    var rowHeight = Math.floor(area / w);
    if (!isFinite(rowHeight) || rowHeight < 1) rowHeight = 1;
    if (rowHeight > side) rowHeight = side;

    var slices = [];
    for (var y = 0; y < h; y += rowHeight) {
      slices.push({ y: y, h: Math.min(rowHeight, h - y) });
    }
    return slices;
  }

  /* 給一張長圖判定輸出策略。
   *   single  — 一張圖直接輸出
   *   sliced  — 切成多個檔案（part-01.png …）
   *   oversize— 連分片都超保護上限，只允許走 PDF（PDF 逐頁寫入，不受畫布限制）
   */
  function classify(width, height) {
    var w = toInt(width, 0);
    var h = toInt(height, 0);
    if (!w || !h) {
      return { mode: 'invalid', slices: [], sliceCount: 0, pixels: 0, reason: 'empty', width: w, height: h };
    }
    var pixels = w * h;

    if (isSingleCanvasSafe(w, h)) {
      return { mode: 'single', slices: [{ y: 0, h: h }], sliceCount: 1, pixels: pixels, reason: 'ok', width: w, height: h };
    }
    if (pixels > HARD_AREA) {
      return {
        mode: 'oversize',
        slices: [],
        sliceCount: 0,
        pixels: pixels,
        reason: 'hard-area',
        width: w,
        height: h,
        hardArea: HARD_AREA,
        maxSide: MAX_SIDE
      };
    }
    var slices = planSlices(w, h);
    if (slices.length > MAX_SLICES) {
      return {
        mode: 'oversize',
        slices: [],
        sliceCount: slices.length,
        pixels: pixels,
        reason: 'too-many-slices',
        width: w,
        height: h,
        hardArea: HARD_AREA,
        maxSide: MAX_SIDE
      };
    }
    return {
      mode: 'sliced',
      slices: slices,
      sliceCount: slices.length,
      pixels: pixels,
      reason: w > MAX_SIDE ? 'width' : 'area',
      width: w,
      height: h,
      hardArea: HARD_AREA,
      maxSide: MAX_SIDE
    };
  }

  /* 判斷「這一頁到底能不能捲動」，並且把「不能」細分成三種完全不同的情況。
   *
   * 以前這三種被壓成同一句「滾不動」，等於什麼都沒說：
   *
   *   scrollable  能滾，只是還沒開始
   *   blocked     有可捲動範圍，實際卻滾不動（被腳本接管、被 CSS 鎖住）
   *   non-native  完全沒有原生可捲動範圍，但內容明明在視口底下
   *               （transform / canvas 驅動的假捲動，原生截圖路徑取不到）
   *   no-content  這一頁本來就只有一屏——那就不是缺陷，任何工具都只能截一屏
   *
   * 最後一種最容易被誤判成「壞掉了」，所以它必須跟其他三種分開講。
   */
  function classifyScrollability(input) {
    var i = input || {};
    var depth = Math.max(0, Number(i.depth) || 0);
    var viewport = Math.max(1, Number(i.viewportHeight) || 1);
    var canScroll = !!i.canScroll;

    var maxSource = Math.max(
      Number(i.documentHeight) || 0,
      Number(i.bodyHeight) || 0,
      Number(i.innerHeight) || 0
    );
    var offscreenBottom = Math.max(0, Number(i.offscreenBottom) || 0);

    /* PDF 檢視器要排在最前面判定：它的外層 document 同樣「沒有可捲動範圍」，
     * 但原因和「這一頁只有一屏」完全不同——內容是被外掛渲染的，DOM 裡根本
     * 沒有東西可以捲。混為一談只會讓人以為是工具壞了。 */
    if (i.isPdfViewer) {
      return { verdict: 'pdf-viewer', reason: 'plugin-rendered', depth: depth };
    }

    if (depth > SCROLL_MIN_DEPTH) {
      return canScroll
        ? { verdict: 'scrollable', reason: 'depth', depth: depth }
        : { verdict: 'blocked', reason: 'locked', depth: depth };
    }

    /* 下面是「沒有原生可捲動範圍」的幾種情形，必須分開。 */
    if (maxSource > viewport * HEIGHT_CONFLICT_FACTOR) {
      /* 某個高度來源說它很高，卻量不到任何可捲動距離——自相矛盾，
       * 通常是容器被鎖住或高度是算出來的假值。 */
      return { verdict: 'blocked', reason: 'height-without-range', depth: depth };
    }

    if (offscreenBottom > viewport * OFFSCREEN_FACTOR) {
      /* 內容明明排在視口下面，卻完全沒有原生可捲動範圍：
       * 這是 transform / canvas 之類的非原生捲動。 */
      return { verdict: 'non-native', reason: 'content-below-viewport', depth: depth };
    }

    return { verdict: 'no-content', reason: 'single-screen', depth: depth };
  }

  /* 從多個來源裡挑出「這一頁到底有多長」。
   *
   * 不同網站把滾動交給不同的元素：多數是 documentElement，有些是 body
   * （html 被 overflow:hidden 鎖住），還有些是頁面裡某個 overflow:auto 的
   * 主容器。只認其中一個，就會在別的頁面上把一整頁量成一小段——然後
   * 「整頁截圖」只截到一屏，而且不會報錯。
   *
   * 所以三個都量，取最大的那個，並且把勝出的來源一起回報，
   * 讓診斷資訊能說清楚「這個高度是從哪裡來的」。
   */
  function pickPageHeight(sources) {
    var bestSource = 'none';
    var bestValue = 0;
    var list = sources || [];
    for (var i = 0; i < list.length; i++) {
      var item = list[i] || {};
      var value = Math.max(0, Math.floor(Number(item.value) || 0));
      if (value > bestValue) {
        bestValue = value;
        bestSource = String(item.source || 'unknown');
      }
    }
    return { source: bestSource, value: bestValue };
  }

  /* 粗估記憶體峰值（bytes）：主畫布 + 一個 ImageBitmap 的 RGBA 點陣圖。
   * 只用於 UI 提示，不用於硬判定。 */
  function estimatePeakBytes(width, height) {
    var pixels = toInt(width, 0) * toInt(height, 0);
    if (!pixels) return 0;
    return pixels * 4 * 2;
  }

  function formatBytes(bytes) {
    var n = Number(bytes);
    if (!isFinite(n) || n <= 0) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB'];
    var i = 0;
    while (n >= 1024 && i < units.length - 1) {
      n = n / 1024;
      i++;
    }
    return (i === 0 ? n : Math.round(n * 10) / 10) + ' ' + units[i];
  }

  /* 人類可讀的規模說明，直接餵給 UI 的提示條 */
  function describe(width, height, format) {
    var info = classify(width, height);
    var fmt = String(format || 'png').toUpperCase();
    if (info.mode === 'invalid') {
      return { level: 'error', text: '沒有可擷取的內容。' };
    }
    var dim = info.width + ' × ' + info.height + ' px';
    var mem = formatBytes(estimatePeakBytes(info.width, info.height));
    if (info.mode === 'single') {
      return { level: 'ok', text: dim + '，預估記憶體峰值 ' + mem + '。' };
    }
    if (info.mode === 'sliced') {
      return {
        level: 'warn',
        text: dim + ' 超出單張畫布上限（' + info.reason + '），' + fmt + ' 將切成 ' + info.sliceCount + ' 張輸出；PDF 不受影響。'
      };
    }
    return {
      level: 'error',
      text: dim + ' 遠超瀏覽器畫布上限，' + fmt + ' 無法輸出，請改用 PDF。'
    };
  }

  return {
    MAX_SIDE: MAX_SIDE,
    SAFE_AREA: SAFE_AREA,
    HARD_AREA: HARD_AREA,
    MAX_SLICES: MAX_SLICES,
    MAX_PDF_PAGE_PT: MAX_PDF_PAGE_PT,
    SCROLL_MIN_DEPTH: SCROLL_MIN_DEPTH,
    OFFSCREEN_FACTOR: OFFSCREEN_FACTOR,
    HEIGHT_CONFLICT_FACTOR: HEIGHT_CONFLICT_FACTOR,
    isSingleCanvasSafe: isSingleCanvasSafe,
    classifyScrollability: classifyScrollability,
    pickPageHeight: pickPageHeight,
    planSlices: planSlices,
    classify: classify,
    estimatePeakBytes: estimatePeakBytes,
    formatBytes: formatBytes,
    describe: describe
  };
});
