/* SnapScroll — 拼接座標換算
 *
 * 這裡處理的是長截圖最常見的一類 bug：接縫錯位、整張圖被拉長或壓扁。
 * 根源都是把 CSS px 當成圖片 px 用了。
 *
 * `captureVisibleTab` 給回來的圖，尺寸是「裝置像素」——它等於
 *   CSS 視口寬 × devicePixelRatio × 瀏覽器縮放
 * 而 devicePixelRatio 本身已經含了頁面縮放，瀏覽器的「頁面縮放」又會再乘一次。
 * 所以唯一可靠的做法是量出來：scale = image.width / 視口 CSS 寬。
 * 不要去猜 dpr，1.25、1.5、110% 這些值在真實環境裡都會出現。
 *
 * 另一件事是捨入。逐幀累加 `clipHeight * scale` 會產生漂移，十幾幀之後
 * 就會差出一個像素的橫線。這裡改成「先算出這一幀的上下邊界，再相減」，
 * 讓每一幀的目標位置對齊同一個基準，捨入誤差不會累積。
 *
 * 全部是純函式，不碰 DOM。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SnapScrollStitchMath = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function num(v, fallback) {
    var n = Number(v);
    return isFinite(n) ? n : (fallback || 0);
  }

  function clamp(v, lo, hi) {
    var n = num(v, lo);
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
  }

  /* 量出圖片像素 / CSS 像素的比例。取不到就退回 1，至少不會把圖拉壞。 */
  function computeScale(imageWidth, viewportWidth) {
    var iw = num(imageWidth, 0);
    var vw = num(viewportWidth, 0);
    if (!(iw > 0) || !(vw > 0)) return 1;
    var s = iw / vw;
    if (!isFinite(s) || s <= 0) return 1;
    /* 極端值通常代表視口量測失敗，寧可當 1 倍 */
    if (s < 0.1 || s > 16) return 1;
    return s;
  }

  /* 這一幀在目標畫布上的落點（整頁拼接用）。
   * frame 來自 scroll-plan 的 step()：{clipY, clipHeight, coveredBefore}，單位 CSS px。
   * 回傳 drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh) 的九個參數。 */
  function frameDrawRect(frame, scale, imageWidth) {
    var s = num(scale, 1) || 1;
    var iw = Math.max(1, Math.round(num(imageWidth, 1)));
    var clipY = Math.max(0, num(frame && frame.clipY, 0));
    var clipH = Math.max(0, num(frame && frame.clipHeight, 0));
    var covered = Math.max(0, num(frame && frame.coveredBefore, 0));

    var sy = Math.round(clipY * s);
    var syEnd = Math.round((clipY + clipH) * s);
    var dy = Math.round(covered * s);
    var dyEnd = Math.round((covered + clipH) * s);

    var sh = syEnd - sy;
    var dh = dyEnd - dy;
    if (sh < 1) sh = 1;
    if (dh < 1) dh = 1;
    if (sy + sh > iw * 0 + iw) { /* 不裁剪來源寬度，寬度本來就等於畫面寬 */ }

    return { sx: 0, sy: sy, sw: iw, sh: sh, dx: 0, dy: dy, dw: iw, dh: dh };
  }

  /* 選區／元素截圖的落點：frame 來自 scroll-plan 的 planRegionFrames()，
   * 帶 {srcY, srcH, dstY}（全部 CSS px，相對於各幀與結果圖）。 */
  function regionDrawRect(frame, scale, imageWidth) {
    var s = num(scale, 1) || 1;
    var iw = Math.max(1, Math.round(num(imageWidth, 1)));
    var srcY = Math.max(0, num(frame && frame.srcY, 0));
    var srcH = Math.max(0, num(frame && frame.srcH, 0));
    var dstY = Math.max(0, num(frame && frame.dstY, 0));

    var sy = Math.round(srcY * s);
    var syEnd = Math.round((srcY + srcH) * s);
    var dy = Math.round(dstY * s);
    var dyEnd = Math.round((dstY + srcH) * s);

    var sh = syEnd - sy;
    var dh = dyEnd - dy;
    if (sh < 1) sh = 1;
    if (dh < 1) dh = 1;

    return { sx: 0, sy: sy, sw: iw, sh: sh, dx: 0, dy: dy, dw: iw, dh: dh };
  }

  /* 目標畫布的像素尺寸 */
  function canvasSizeFor(width, height, scale) {
    var s = num(scale, 1) || 1;
    return {
      width: Math.max(1, Math.round(num(width, 1) * s)),
      height: Math.max(1, Math.round(num(height, 1) * s)),
      scale: s
    };
  }

  /* 等比縮放塞進一個框（UI 預覽用） */
  function fitRect(srcW, srcH, boxW, boxH) {
    var w = Math.max(1, num(srcW, 1));
    var h = Math.max(1, num(srcH, 1));
    var bw = Math.max(1, num(boxW, 1));
    var bh = Math.max(1, num(boxH, 1));
    var k = Math.min(bw / w, bh / h);
    return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)), scale: k };
  }

  /* 把矩形限制在畫布內（選區拖到邊界外時用） */
  function cropRect(rect, bounds) {
    var x = Math.floor(num(rect && rect.x, 0));
    var y = Math.floor(num(rect && rect.y, 0));
    var w = Math.floor(num(rect && rect.width, 0));
    var h = Math.floor(num(rect && rect.height, 0));
    var bw = Math.floor(num(bounds && bounds.width, 0));
    var bh = Math.floor(num(bounds && bounds.height, 0));

    var x1 = clamp(x, 0, bw);
    var y1 = clamp(y, 0, bh);
    var x2 = clamp(x + w, 0, bw);
    var y2 = clamp(y + h, 0, bh);
    return { x: x1, y: y1, width: Math.max(0, x2 - x1), height: Math.max(0, y2 - y1) };
  }

  /* 由兩個拖曳端點組出正規化的矩形（左上拖到右下，或反過來） */
  function rectFromPoints(a, b) {
    var x1 = num(a && a.x, 0);
    var y1 = num(a && a.y, 0);
    var x2 = num(b && b.x, 0);
    var y2 = num(b && b.y, 0);
    return {
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1)
    };
  }

  /* 把 CSS px 的長度換成圖片 px */
  function toImagePx(cssPx, scale) {
    return Math.round(num(cssPx, 0) * (num(scale, 1) || 1));
  }

  return {
    clamp: clamp,
    computeScale: computeScale,
    frameDrawRect: frameDrawRect,
    regionDrawRect: regionDrawRect,
    canvasSizeFor: canvasSizeFor,
    fitRect: fitRect,
    cropRect: cropRect,
    rectFromPoints: rectFromPoints,
    toImagePx: toImagePx
  };
});
