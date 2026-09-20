/* SnapScroll — 長圖轉 PDF 的分頁
 *
 * 一張 1200 × 40000 的長圖要放進 PDF，有三種合理的做法，對應三種使用情境：
 *
 *   fit-width（預設）— 按紙張可用寬度等比縮放，縱向切成一頁一頁。
 *                      適合「我要列印 / 傳給別人看」，列印結果跟螢幕一致。
 *   single          — 整張長圖塞進單一超高頁面，PDF 頁面高度 = 圖高。
 *                      適合「網頁存檔」，在 PDF 閱讀器裡連續捲動閱讀。
 *                      但 PDF 單頁有 200 英吋（14400pt）的物理上限，
 *                      超過就自動退回 fit-width，不讓使用者拿到壞檔。
 *   fit-page        — 整張圖縮到一頁裡。只對短頁面合理。
 *
 * 長度的單位這裡統一用 PDF 的 pt（1pt = 1/72 英吋），
 * 而圖的座標用圖片像素。兩者之間的換算比例由紙張寬度決定。
 *
 * 全部是純函式，不碰 DOM。
 */
(function (root, factory) {
  var api = factory(
    typeof module === 'object' && module.exports ? require('./limits.js') : root.SnapScrollLimits
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SnapScrollPaginate = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (LIMITS) {
  'use strict';

  var MAX_PDF_PAGE_PT = (LIMITS && LIMITS.MAX_PDF_PAGE_PT) || 14400;
  var MAX_PAGES = 500;

  /* CSS px → pt：1 CSS px = 1/96 英吋，1pt = 1/72 英吋 */
  var CSS_PX_TO_PT = 72 / 96;

  var PAPERS = {
    a4: { id: 'a4', label: 'A4', widthPt: 595.276, heightPt: 841.89 },
    a3: { id: 'a3', label: 'A3', widthPt: 841.89, heightPt: 1190.551 },
    letter: { id: 'letter', label: 'Letter', widthPt: 612, heightPt: 792 },
    legal: { id: 'legal', label: 'Legal', widthPt: 612, heightPt: 1008 },
    tabloid: { id: 'tabloid', label: 'Tabloid', widthPt: 792, heightPt: 1224 }
  };

  function toNum(v, fallback) {
    var n = Number(v);
    return isFinite(n) ? n : fallback;
  }

  function paperList() {
    return Object.keys(PAPERS).map(function (k) { return PAPERS[k]; });
  }

  function resolvePaper(opts) {
    var o = opts || {};
    var id = String(o.paper || 'a4').toLowerCase();
    var landscape = o.orientation === 'landscape';

    if (id === 'custom' && o.customSize) {
      var cw = Math.max(72, toNum(o.customSize.widthPt, 595.276));
      var ch = Math.max(72, toNum(o.customSize.heightPt, 841.89));
      return {
        id: 'custom',
        label: 'Custom',
        widthPt: landscape ? Math.max(cw, ch) : cw,
        heightPt: landscape ? Math.min(cw, ch) : ch
      };
    }

    var p = PAPERS[id] || PAPERS.a4;
    return {
      id: p.id,
      label: p.label,
      widthPt: landscape ? p.heightPt : p.widthPt,
      heightPt: landscape ? p.widthPt : p.heightPt
    };
  }

  /* 主函式。
   * opts = {
   *   imageWidth, imageHeight,      // 圖片像素
   *   paper: 'a4'|'a3'|'letter'|'legal'|'tabloid'|'custom',
   *   orientation: 'portrait'|'landscape',
   *   marginPt: 0,
   *   mode: 'fit-width'|'single'|'fit-page',
   *   keepPageSize: true            // 是否讓每頁都維持紙張原尺寸（最後一頁底部留白）
   * }
   *
   * 回傳 { mode, pages:[...], pageCount, paper, contentWidthPt, contentHeightPt,
   *        ratio, rowHeightPx, downgraded }
   * pages 每一項 = { sx, sy, sw, sh, pageWidth, pageHeight, drawX, drawY, drawWidth, drawHeight }
   */
  function planPages(opts) {
    var o = opts || {};
    var W = Math.max(1, Math.floor(toNum(o.imageWidth, 1)));
    var H = Math.max(1, Math.floor(toNum(o.imageHeight, 1)));
    var margin = Math.max(0, toNum(o.marginPt, 0));
    var paper = resolvePaper(o);
    var mode = o.mode || 'fit-width';
    var downgraded = null;

    /* ── 單頁長圖 ─────────────────────────────────────────────── */
    if (mode === 'single') {
      var ratio = toNum(o.pxToPt, CSS_PX_TO_PT);
      if (ratio <= 0) ratio = CSS_PX_TO_PT;
      var pageW = W * ratio;
      var pageH = H * ratio;
      if (pageH <= MAX_PDF_PAGE_PT && pageW <= MAX_PDF_PAGE_PT) {
        return {
          mode: 'single',
          downgraded: null,
          pages: [{
            sx: 0, sy: 0, sw: W, sh: H,
            pageWidth: pageW, pageHeight: pageH,
            drawX: 0, drawY: 0, drawWidth: pageW, drawHeight: pageH
          }],
          pageCount: 1,
          paper: { id: 'single', label: 'Single page', widthPt: pageW, heightPt: pageH },
          ratio: ratio,
          rowHeightPx: H,
          contentWidthPt: pageW,
          contentHeightPt: pageH,
          maxPagePt: MAX_PDF_PAGE_PT
        };
      }
      /* 太長了：退回分頁模式，並把降級原因帶出去讓 UI 說明 */
      downgraded = {
        from: 'single',
        to: 'fit-width',
        reason: 'page-too-long',
        limitPt: MAX_PDF_PAGE_PT,
        requestedPt: Math.round(pageH)
      };
      mode = 'fit-width';
    }

    /* ── 整頁縮放 ─────────────────────────────────────────────── */
    var contentW = Math.max(1, paper.widthPt - margin * 2);
    var contentH = Math.max(1, paper.heightPt - margin * 2);

    if (mode === 'fit-page') {
      var k = Math.min(contentW / W, contentH / H);
      var fw = W * k;
      var fh = H * k;
      return {
        mode: 'fit-page',
        downgraded: downgraded,
        pages: [{
          sx: 0, sy: 0, sw: W, sh: H,
          pageWidth: paper.widthPt, pageHeight: paper.heightPt,
          drawX: (paper.widthPt - fw) / 2, drawY: (paper.heightPt - fh) / 2,
          drawWidth: fw, drawHeight: fh
        }],
        pageCount: 1,
        paper: paper,
        ratio: k,
        rowHeightPx: H,
        contentWidthPt: contentW,
        contentHeightPt: contentH,
        maxPagePt: MAX_PDF_PAGE_PT
      };
    }

    /* ── fit-width（預設）─────────────────────────────────────── */
    var scale = contentW / W;              // 圖片像素 → pt
    var capacityPx = contentH / scale;     // 一頁能裝多少圖片像素高
    var rowHeightPx = Math.max(1, Math.floor(capacityPx));
    if (rowHeightPx > H) rowHeightPx = H;

    var rawCount = Math.ceil(H / rowHeightPx);
    var keepPageSize = o.keepPageSize !== false;
    var pages = [];
    var count = Math.min(rawCount, MAX_PAGES);

    for (var i = 0; i < count; i++) {
      var sy = i * rowHeightPx;
      var sh = Math.min(rowHeightPx, H - sy);
      if (sh <= 0) break;
      var drawH = sh * scale;
      var pageHeight = keepPageSize ? paper.heightPt : drawH + margin * 2;
      /* 統一頁高時，內容一律從上邊界開始，底部自然留白 */
      pages.push({
        sx: 0,
        sy: sy,
        sw: W,
        sh: sh,
        pageWidth: paper.widthPt,
        pageHeight: pageHeight,
        drawX: margin,
        drawY: margin,
        drawWidth: contentW,
        drawHeight: drawH
      });
    }

    var truncated = rawCount > MAX_PAGES;
    if (truncated) {
      downgraded = downgraded || { from: 'fit-width', to: 'fit-width', reason: 'too-many-pages', limit: MAX_PAGES, requested: rawCount };
    }

    return {
      mode: 'fit-width',
      downgraded: downgraded,
      pages: pages,
      pageCount: pages.length,
      paper: paper,
      ratio: scale,
      rowHeightPx: rowHeightPx,
      contentWidthPt: contentW,
      contentHeightPt: contentH,
      truncated: truncated,
      requestedPageCount: rawCount,
      maxPages: MAX_PAGES,
      maxPagePt: MAX_PDF_PAGE_PT
    };
  }

  /* 只想知道會有幾頁（UI 即時顯示用，不做完整規劃） */
  function estimatePageCount(opts) {
    var plan = planPages(opts);
    return plan.pageCount;
  }

  return {
    PAPERS: PAPERS,
    CSS_PX_TO_PT: CSS_PX_TO_PT,
    MAX_PDF_PAGE_PT: MAX_PDF_PAGE_PT,
    MAX_PAGES: MAX_PAGES,
    paperList: paperList,
    resolvePaper: resolvePaper,
    planPages: planPages,
    estimatePageCount: estimatePageCount
  };
});
