/* SnapScroll — 拼接與編碼（offscreen document）
 *
 * service worker 沒有 DOM、沒有 canvas、沒有 URL.createObjectURL，
 * 所以「把一幀一幀的截圖拼成一張長圖、再編成 PNG / JPEG / PDF」這件事
 * 全部發生在這裡。
 *
 * 設計上有兩個關鍵決定：
 *
 * 1. **不建一整張超大畫布。**
 *    一張 1200 × 60000 的長圖是 7200 萬像素，光點陣圖就 288 MB，還要同時
 *    留著來源 ImageBitmap。這裡改成用「軌道（tile）」——按 y 把輸出切成若干
 *    條，每條一張小畫布，逐幀畫進相交的軌道，滿了就編碼、釋放。所以記憶體
 *    峰值取決於單條的高度，而不是整張圖的高度。
 *
 * 2. **PDF 的軌道高度直接等於頁高。**
 *    PDF 的每一頁就是一張 JPEG，所以讓軌道跟頁對齊，每一頁只做一次 JPEG
 *    編碼，沒有二次解碼、沒有額外失真。JPEG 位元組再以 /DCTDecode 原封不動
 *    嵌進 PDF。
 */
(function () {
  'use strict';

  var PROTO = globalThis.SnapScrollProtocol;
  var LIMITS = globalThis.SnapScrollLimits;
  var MATH = globalThis.SnapScrollStitchMath;
  var PAGINATE = globalThis.SnapScrollPaginate;
  var PDFW = globalThis.SnapScrollPdfWriter;

  var MIME = {
    png: 'image/png',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    pdf: 'image/jpeg'
  };

  var session = null;

  /* ── 生命週期 ───────────────────────────────────────────────────── */

  function releaseTiles(s) {
    if (!s || !s.tiles) return;
    s.tiles.forEach(function (t) {
      if (t.url) {
        try { URL.revokeObjectURL(t.url); } catch (e) { /* 已釋放 */ }
        t.url = null;
      }
      if (t.canvas) {
        /* 明確把尺寸歸零：只把參考丟掉，記憶體要等 GC，這裡即時還回去 */
        t.canvas.width = 0;
        t.canvas.height = 0;
        t.canvas = null;
      }
      t.ctx = null;
      t.blob = null;
    });
    s.tiles = [];
  }

  function resetSession() {
    if (session) releaseTiles(session);
    session = null;
  }

  /* ── 畫布 ───────────────────────────────────────────────────────── */

  function createCanvas(width, height) {
    var w = Math.max(1, Math.round(width));
    var h = Math.max(1, Math.round(height));
    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    if (canvas.width !== w || canvas.height !== h) {
      throw new Error('畫布尺寸被瀏覽器拒絕：' + w + '×' + h);
    }
    var ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('無法取得 2D 繪圖上下文');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    if (ctx.getImageData && !ctx.getImageData(0, 0, 1, 1)) {
      throw new Error('畫布無法寫入像素');
    }
    return { canvas: canvas, ctx: ctx };
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise(function (resolve, reject) {
      var done = false;
      function fail(msg) {
        if (done) return;
        done = true;
        reject(new Error(msg));
      }
      try {
        canvas.toBlob(function (blob) {
          if (done) return;
          if (!blob) {
            /* toBlob 對超限的畫布不會拋錯，只會回傳 null——這裡把它變成看得懂的錯誤 */
            fail('畫布編碼失敗：尺寸 ' + canvas.width + '×' + canvas.height + ' 超出瀏覽器上限');
            return;
          }
          done = true;
          resolve(blob);
        }, type, quality);
      } catch (e) {
        fail(String((e && e.message) || e));
      }
    });
  }

  function dataUrlToBitmap(dataUrl) {
    return fetch(dataUrl)
      .then(function (res) { return res.blob(); })
      .then(function (blob) { return createImageBitmap(blob); });
  }

  function blobToBytes(blob) {
    return blob.arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
  }

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result)); };
      reader.onerror = function () { reject(reader.error || new Error('讀取縮圖失敗')); };
      reader.readAsDataURL(blob);
    });
  }

  /* 縮圖：只覆蓋長圖頂端一段，最寬 320、最高 640，比例不變。
   * 存成 data URL 回傳，讓 service worker 能直接塞進歷史記錄，
   * 不必處理 blob URL 的生命週期。 */
  function makeThumb(s) {
    var targetW = 320;
    var scale = targetW / s.outputWidth;
    var thumbH = Math.max(1, Math.round(s.outputHeight * scale));
    var maxH = 640;
    if (thumbH > maxH) {
      scale = maxH / s.outputHeight;
      thumbH = maxH;
    }
    var tw = Math.max(1, Math.round(s.outputWidth * scale));

    var made = createCanvas(tw, thumbH);
    var cursor = 0;
    for (var i = 0; i < s.tiles.length && cursor < thumbH; i++) {
      var tile = s.tiles[i];
      var top = Math.round(tile.y0 * scale);
      if (top >= thumbH) break;
      var h = Math.min(Math.round(tile.height * scale), thumbH - top);
      var srcH = Math.max(1, Math.round(h / scale));
      made.ctx.drawImage(tile.canvas, 0, 0, tile.width, Math.min(srcH, tile.height), 0, top, tw, h);
      cursor = top + h;
    }
    return canvasToBlob(made.canvas, 'image/jpeg', 0.72)
      .then(blobToDataUrl)
      .catch(function () { return null; });
  }

  /* ── 軌道規劃 ───────────────────────────────────────────────────── */

  /* 依輸出型態決定要把結果切成幾條、每條多高。
   * 像素輸出用 limits 的分片策略；PDF 則直接對齊分頁。 */
  function planTiles(s) {
    if (s.outputKind === 'pdf') {
      var plan = PAGINATE.planPages({
        imageWidth: s.outputWidth,
        imageHeight: s.outputHeight,
        paper: s.pdf.paper,
        orientation: s.pdf.orientation,
        marginPt: s.pdf.marginPt,
        mode: s.pdf.mode,
        keepPageSize: s.pdf.keepPageSize
      });
      s.pdfPlan = plan;
      s.tiles = plan.pages.map(function (page, i) {
        var made = createCanvas(s.outputWidth, page.sh);
        return {
          index: i,
          y0: page.sy,
          y1: page.sy + page.sh,
          height: page.sh,
          width: s.outputWidth,
          canvas: made.canvas,
          ctx: made.ctx,
          page: page,
          blob: null,
          url: null
        };
      });
      s.tileMode = plan.mode;
      s.downgraded = plan.downgraded || null;
      return;
    }

    var cls = LIMITS.classify(s.outputWidth, s.outputHeight);
    s.limitsInfo = cls;
    if (cls.mode === 'invalid') throw new Error('沒有可輸出的內容');

    var specs = cls.mode === 'single'
      ? [{ y: 0, h: s.outputHeight }]
      : cls.slices;

    s.tiles = specs.map(function (spec, i) {
      var made = createCanvas(s.outputWidth, spec.h);
      return {
        index: i,
        y0: spec.y,
        y1: spec.y + spec.h,
        height: spec.h,
        width: s.outputWidth,
        canvas: made.canvas,
        ctx: made.ctx,
        page: null,
        blob: null,
        url: null
      };
    });
    s.tileMode = cls.mode;
  }

  function ensureTilesCover(s, pixelBottom) {
    /* 軌道是預先規劃好的；這裡只在理論上會發生的「幀超出規劃高度」時補一條，
     * 避免畫面被靜默裁掉。 */
    if (!s.tiles.length) return;
    var last = s.tiles[s.tiles.length - 1];
    if (pixelBottom <= last.y1) return;
    var extra = pixelBottom - last.y1;
    if (s.outputHeight > 0) extra = Math.min(extra, s.outputHeight);
    var made = createCanvas(s.outputWidth, extra);
    s.tiles.push({
      index: s.tiles.length,
      y0: last.y1,
      y1: last.y1 + extra,
      height: extra,
      width: s.outputWidth,
      canvas: made.canvas,
      ctx: made.ctx,
      page: null,
      blob: null,
      url: null
    });
  }

  /* ── 主流程 ─────────────────────────────────────────────────────── */

  function begin(payload) {
    resetSession();
    var p = payload || {};
    var mode = p.mode === 'region' ? 'region' : 'full';

    session = {
      jobId: p.jobId,
      mode: mode,
      outputKind: p.format === 'pdf' ? 'pdf' : 'image',
      format: p.format || 'png',
      quality: typeof p.quality === 'number' ? p.quality : 0.92,
      viewportWidth: Math.max(1, Math.round(p.viewportWidth || 1)),
      viewportHeight: Math.max(1, Math.round(p.viewportHeight || 1)),
      cssWidth: Math.max(1, Math.round(mode === 'region' ? (p.regionWidth || 1) : (p.pageWidth || 1))),
      cssHeight: Math.max(1, Math.round(mode === 'region' ? (p.regionHeight || 1) : (p.pageHeight || 1))),
      pdf: p.pdf || { paper: 'a4', orientation: 'portrait', marginPt: 36, mode: 'fit-width', keepPageSize: true },
      meta: p.meta || {},
      scale: 0,
      outputWidth: 0,
      outputHeight: 0,
      tiles: [],
      frameCount: 0,
      planned: false
    };

    return { ok: true, jobId: session.jobId };
  }

  function drawFrame(payload) {
    var s = session;
    if (!s) throw new Error('沒有進行中的擷取工作');

    return dataUrlToBitmap(payload.dataUrl).then(function (bitmap) {
      try {
        if (!s.planned) {
          s.scale = MATH.computeScale(bitmap.width, s.viewportWidth);
          var size = MATH.canvasSizeFor(s.cssWidth, s.cssHeight, s.scale);
          s.outputWidth = size.width;
          s.outputHeight = size.height;
          planTiles(s);
          s.planned = true;
        }

        var frame = payload.frame || {};
        var rect = s.mode === 'region'
          ? MATH.regionDrawRect(frame, s.scale, s.outputWidth)
          : MATH.frameDrawRect(frame, s.scale, s.outputWidth);

        /* 手動滾動模式可能滾得比原本量到的高度還深，輸出高度要跟著長 */
        var needed = rect.dy + rect.dh;
        ensureTilesCover(s, needed);
        if (needed > s.outputHeight) s.outputHeight = needed;

        /* 這一幀「真的」能提供多少內容？
         * 抓回來的圖可能比我們量到的視口矮（模擬裝置指標、混合 DPI、
         * 或瀏覽器把高度取整時都會發生）。先算清楚實際可用的高度，
         * 再拿它去畫，並且把結果回報給上層——上層要靠這個數字校正
         * 後續每一幀的推進量，否則每一幀都會漏掉一截、接縫處留白。 */
        var availableSrcPx = Math.max(0, bitmap.height - rect.sy);
        var usableSrc = Math.min(rect.sh, availableSrcPx);
        var usableDst = Math.min(rect.dh, availableSrcPx);
        var contentHeightCss = usableSrc / s.scale;

        for (var i = 0; i < s.tiles.length; i++) {
          var tile = s.tiles[i];
          var top = Math.max(rect.dy, tile.y0);
          var bottom = Math.min(rect.dy + usableDst, tile.y1);
          if (bottom <= top) continue;

          var srcTop = rect.sy + (top - rect.dy);
          var height = bottom - top;
          if (srcTop >= bitmap.height) continue;
          if (srcTop + height > bitmap.height) height = bitmap.height - srcTop;
          if (height <= 0) continue;

          tile.ctx.drawImage(
            bitmap,
            rect.sx, srcTop, rect.sw, height,
            rect.dx, top - tile.y0, rect.dw, height
          );
        }

        var coveredTo = (frame.coveredBefore || 0) + contentHeightCss;
        if (!s.maxCoveredTo || coveredTo > s.maxCoveredTo) s.maxCoveredTo = coveredTo;

        s.frameCount++;
        return {
          ok: true,
          index: frame.index,
          scale: s.scale,
          outputWidth: s.outputWidth,
          outputHeight: s.outputHeight,
          tiles: s.tiles.length,
          frames: s.frameCount,
          contentHeightPx: contentHeightCss,
          coveredTo: coveredTo
        };
      } finally {
        if (bitmap.close) bitmap.close();
      }
    });
  }

  function encodeAll(s) {
    var mime = MIME[s.format] || 'image/png';
    var quality = s.format === 'png' ? undefined : s.quality;
    var chain = Promise.resolve();

    s.tiles.forEach(function (tile) {
      chain = chain.then(function () {
        return canvasToBlob(tile.canvas, mime, quality).then(function (blob) {
          tile.blob = blob;
        });
      });
    });
    return chain;
  }

  /* 把輸出裁到「真的被覆蓋過」的高度。
   * 最後一幀常常沒填滿，留著下面那條白邊只是在成品上留一條瑕疵；
   * 手動滾動模式更是常常只覆蓋了頁面的一部分。 */
  function trimToCovered(s) {
    if (!s.maxCoveredTo || s.maxCoveredTo <= 0) return;
    var height = Math.max(1, Math.round(s.maxCoveredTo * s.scale));
    if (height >= s.outputHeight) return;

    var keep = [];
    for (var i = 0; i < s.tiles.length; i++) {
      var tile = s.tiles[i];
      if (tile.y0 >= height) {
        tile.canvas.width = 0;
        tile.canvas.height = 0;
        continue;
      }
      if (tile.y1 > height) {
        var h = height - tile.y0;
        var made = createCanvas(s.outputWidth, h);
        if (made.ctx && tile.canvas) {
          made.ctx.drawImage(tile.canvas, 0, 0, tile.width, h, 0, 0, s.outputWidth, h);
        }
        tile.canvas.width = 0;
        tile.canvas.height = 0;
        tile.canvas = made.canvas;
        tile.ctx = made.ctx;
        tile.height = h;
        tile.y1 = height;
      }
      keep.push(tile);
    }
    s.tiles = keep;
    s.outputHeight = height;
  }

  function finish(payload) {
    var s = session;
    if (!s) throw new Error('沒有進行中的擷取工作');
    if (!s.planned) throw new Error('還沒有任何畫面被擷取');

    var p = payload || {};
    if (p.meta) s.meta = p.meta;
    trimToCovered(s);

    return encodeAll(s)
      .then(function () { return makeThumb(s); })
      .then(function (thumb) {
        return (s.outputKind === 'pdf' ? buildPdfFiles(s) : buildImageFiles(s)).then(function (res) {
          res.thumb = thumb;
          return res;
        });
      });
  }

  function buildImageFiles(s) {
    return Promise.all(s.tiles.map(function (tile) {
      tile.url = URL.createObjectURL(tile.blob);
      return blobToBytes(tile.blob).then(function (bytes) {
        return {
          index: tile.index,
          url: tile.url,
          bytes: bytes.length,
          width: tile.width,
          height: tile.height,
          y0: tile.y0
        };
      });
    })).then(function (files) {
      return {
        ok: true,
        kind: 'image',
        format: s.format,
        files: files,
        scale: s.scale,
        outputWidth: s.outputWidth,
        outputHeight: s.outputHeight,
        tileMode: s.tileMode,
        limits: s.limitsInfo || null,
        frames: s.frameCount
      };
    });
  }

  function buildPdfFiles(s) {
    var plan = s.pdfPlan;
    var chain = Promise.resolve();
    var pages = [];

    s.tiles.forEach(function (tile) {
      chain = chain.then(function () {
        return blobToBytes(tile.blob).then(function (bytes) {
          pages.push({
            jpeg: bytes,
            pixelWidth: tile.canvas.width,
            pixelHeight: tile.canvas.height,
            pageWidth: tile.page.pageWidth,
            pageHeight: tile.page.pageHeight,
            drawX: tile.page.drawX,
            drawY: tile.page.drawY,
            drawWidth: tile.page.drawWidth,
            drawHeight: tile.page.drawHeight
          });
        });
      });
    });

    return chain.then(function () {
      var meta = {
        title: s.meta.title || 'SnapScroll',
        subject: s.meta.subject || s.meta.url || '',
        author: s.meta.author || '',
        creator: s.meta.creator || 'SnapScroll',
        producer: 'SnapScroll',
        date: new Date()
      };
      var bytes = PDFW.buildPdf({ pages: pages, meta: meta });
      var check = PDFW.verifyPdf(bytes);
      if (!check.ok) {
        throw new Error('產出的 PDF 未通過自檢：' + check.errors.join('；'));
      }
      var blob = new Blob([bytes], { type: 'application/pdf' });
      var url = URL.createObjectURL(blob);
      s.tiles[0].url = url;
      return {
        ok: true,
        kind: 'pdf',
        format: 'pdf',
        files: [{
          index: 0,
          url: url,
          bytes: bytes.length,
          width: s.outputWidth,
          height: s.outputHeight,
          pages: pages.length
        }],
        pageCount: pages.length,
        pageMode: plan ? plan.mode : 'fit-width',
        downgraded: plan ? plan.downgraded : null,
        scale: s.scale,
        outputWidth: s.outputWidth,
        outputHeight: s.outputHeight,
        frames: s.frameCount
      };
    });
  }

  /* ── 能力探測 ───────────────────────────────────────────────────── */

  function canvasUsable(w, h) {
    try {
      var made = createCanvas(w, h);
      var ctx = made.ctx;
      ctx.fillStyle = '#010203';
      ctx.fillRect(0, 0, 2, 2);
      var data = ctx.getImageData(0, 0, 1, 1).data;
      var ok = data[0] === 1 && data[1] === 2 && data[2] === 3;
      made.canvas.width = 0;
      made.canvas.height = 0;
      return ok;
    } catch (e) {
      return false;
    }
  }

  /* 二分找出這台機器上實際可用的最大面積。
   * 刻意不寫死數字：不同 GPU、不同旗標、不同版本的可用上限都不同，
   * 與其相信文件，不如當場量。 */
  function probe() {
    var result = {
      maxSideProbe: {},
      maxArea: 0,
      likelySingleMax: 0
    };
    [16384, 32767, 65535].forEach(function (side) {
      result.maxSideProbe[side] = canvasUsable(side, 1) && canvasUsable(1, side);
    });

    var lo = 1000000;
    var hi = 800000000;
    if (!canvasUsable(2000, Math.floor(lo / 2000))) lo = 0;
    /* 先確認上界不可用，再二分 */
    while (lo < hi) {
      var mid = Math.floor((lo + hi + 1) / 2);
      var w = 2000;
      var h = Math.max(1, Math.floor(mid / w));
      if (canvasUsable(w, h) && w * h >= mid * 0.9) lo = mid;
      else hi = mid - 1;
    }
    result.maxArea = lo;
    result.likelySingleMax = lo;
    return result;
  }

  /* ── 訊息 ───────────────────────────────────────────────────────── */

  function handle(type, payload) {
    switch (type) {
      case PROTO.MSG.OS_PING:
        return { ready: true };

      case PROTO.MSG.OS_BEGIN:
        return begin(payload);

      case PROTO.MSG.OS_FRAME:
        return drawFrame(payload);

      case PROTO.MSG.OS_FINISH:
        return finish(payload);

      case PROTO.MSG.OS_ABORT:
        resetSession();
        return { ok: true };

      case PROTO.MSG.OS_PROBE:
        return probe();

      default:
        throw new Error('未知指令：' + type);
    }
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!PROTO.isFor(msg, PROTO.TO.OFFSCREEN)) return false;
    var out;
    try {
      out = handle(msg.type, msg.payload);
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
      return false;
    }
    if (out && typeof out.then === 'function') {
      out.then(
        function (value) { sendResponse(value); },
        function (err) { sendResponse({ ok: false, error: String((err && err.message) || err) }); }
      );
      return true;
    }
    sendResponse(out);
    return false;
  });
})();
