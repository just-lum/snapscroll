/* SnapScroll — 設定
 *
 * 設定的實際存放位置由呼叫方決定（SW 用 storage.local，UI 讀同一份），
 * 這裡只負責「預設值長什麼樣」與「外部資料進來時怎麼收拾乾淨」。
 *
 * normalize() 是純函式：壞掉的設定（手動改過、版本升級遺留、別人的備份檔）
 * 一律修正成合法值而不是丟錯——使用者的瀏覽器不該因為一個壞欄位而罷工。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SnapScrollSettings = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var STORAGE_KEY = 'snapscroll.settings';

  var FORMATS = ['png', 'jpeg', 'webp', 'pdf'];
  var MODES = ['full', 'viewport', 'region', 'element', 'manual'];
  var PAPERS = ['a4', 'a3', 'letter', 'legal', 'tabloid', 'custom'];
  var PDF_MODES = ['fit-width', 'single', 'fit-page'];

  var DEFAULTS = {
    format: 'png',
    mode: 'full',

    /* 畫質：JPEG 與 WebP 共用，PDF 用它決定嵌入影像的品質 */
    quality: 0.92,

    /* 節奏 */
    startDelayMs: 0,
    frameDelayMs: 260,

    /* 畫面整理 */
    hideFixed: true,
    hideScrollbars: true,
    hideOwnOverlay: true,
    showOverlay: true,

    /* 懶載入 */
    waitForLazy: true,
    lazyExtraWaitMs: 400,
    maxPageHeight: 120000,

    /* 輸出 */
    filenameTemplate: '{date}_{host}_{title}',
    folder: '',
    openResultPage: true,

    /* PDF */
    pdf: {
      paper: 'a4',
      orientation: 'portrait',
      marginPt: 36,
      mode: 'fit-width',
      keepPageSize: true
    },

    /* 進階 */
    captureFormat: 'auto',
    retryLimit: 8,
    keepHistory: 20
  };

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function pickEnum(value, allowed, fallback) {
    var s = String(value == null ? '' : value).toLowerCase();
    return allowed.indexOf(s) >= 0 ? s : fallback;
  }

  function clampNumber(value, lo, hi, fallback) {
    var n = Number(value);
    if (!isFinite(n)) return fallback;
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
  }

  function clampBool(value, fallback) {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return fallback;
  }

  /* 把任意輸入收拾成合法設定。缺的補預設，壞的換合法值。 */
  function normalize(raw) {
    var src = isPlainObject(raw) ? raw : {};
    var d = DEFAULTS;
    var pdfSrc = isPlainObject(src.pdf) ? src.pdf : {};

    var out = {};

    out.format = pickEnum(src.format, FORMATS, d.format);
    out.mode = pickEnum(src.mode, MODES, d.mode);
    out.quality = clampNumber(src.quality, 0.3, 1, d.quality);

    out.startDelayMs = clampNumber(src.startDelayMs, 0, 60000, d.startDelayMs);
    out.frameDelayMs = clampNumber(src.frameDelayMs, 0, 5000, d.frameDelayMs);

    out.hideFixed = clampBool(src.hideFixed, d.hideFixed);
    out.hideScrollbars = clampBool(src.hideScrollbars, d.hideScrollbars);
    out.hideOwnOverlay = clampBool(src.hideOwnOverlay, d.hideOwnOverlay);
    out.showOverlay = clampBool(src.showOverlay, d.showOverlay);

    out.waitForLazy = clampBool(src.waitForLazy, d.waitForLazy);
    out.lazyExtraWaitMs = clampNumber(src.lazyExtraWaitMs, 0, 10000, d.lazyExtraWaitMs);
    out.maxPageHeight = clampNumber(src.maxPageHeight, 1000, 1000000, d.maxPageHeight);

    out.filenameTemplate = typeof src.filenameTemplate === 'string' && src.filenameTemplate.trim()
      ? src.filenameTemplate.trim().slice(0, 200)
      : d.filenameTemplate;
    out.folder = typeof src.folder === 'string' ? src.folder.trim().slice(0, 120) : d.folder;
    out.openResultPage = clampBool(src.openResultPage, d.openResultPage);

    out.pdf = {
      paper: pickEnum(pdfSrc.paper, PAPERS, d.pdf.paper),
      orientation: pickEnum(pdfSrc.orientation, ['portrait', 'landscape'], d.pdf.orientation),
      marginPt: clampNumber(pdfSrc.marginPt, 0, 144, d.pdf.marginPt),
      mode: pickEnum(pdfSrc.mode, PDF_MODES, d.pdf.mode),
      keepPageSize: clampBool(pdfSrc.keepPageSize, d.pdf.keepPageSize)
    };

    out.captureFormat = pickEnum(src.captureFormat, ['auto', 'png', 'jpeg'], d.captureFormat);
    out.retryLimit = clampNumber(src.retryLimit, 0, 30, d.retryLimit);
    out.keepHistory = clampNumber(src.keepHistory, 0, 200, d.keepHistory);

    return out;
  }

  /* 把設定疊在預設值上做一次差異比對，UI 用它顯示「已改成自訂」的欄位 */
  function diffFromDefaults(settings) {
    var s = normalize(settings);
    var changed = [];
    Object.keys(DEFAULTS).forEach(function (key) {
      if (key === 'pdf') {
        Object.keys(DEFAULTS.pdf).forEach(function (k) {
          if (s.pdf[k] !== DEFAULTS.pdf[k]) changed.push('pdf.' + k);
        });
        return;
      }
      if (s[key] !== DEFAULTS[key]) changed.push(key);
    });
    return changed;
  }

  /* 依設定決定 captureVisibleTab 要用哪種格式抓幀：
   * 目標是 PNG 就抓 PNG（無損），其他格式抓 JPEG 省記憶體與訊息流量。 */
  function captureFormatFor(settings) {
    var s = normalize(settings);
    if (s.captureFormat !== 'auto') return s.captureFormat;
    return s.format === 'png' ? 'png' : 'jpeg';
  }

  /* 抓幀品質：只在 JPEG 模式下有效 */
  function captureQualityFor(settings) {
    var s = normalize(settings);
    if (captureFormatFor(s) !== 'jpeg') return undefined;
    /* 抓幀時的品質略高於輸出品質，避免二次壓縮疊加失真 */
    return Math.min(1, Math.round((s.quality + 0.06) * 100) / 100);
  }

  /* 用某個 storage area 包一個讀寫器。
   * 沒給 area 就退回記憶體，讓測試與非擴充環境也能用。 */
  function createStore(area) {
    var fallback = {};
    var store = area && typeof area.get === 'function' ? area : null;

    return {
      load: function () {
        return new Promise(function (resolve) {
          if (!store) return resolve(normalize(fallback));
          store.get(STORAGE_KEY, function (result) {
            var raw = result && result[STORAGE_KEY];
            resolve(normalize(raw));
          });
        });
      },
      save: function (settings) {
        var clean = normalize(settings);
        return new Promise(function (resolve) {
          if (!store) {
            fallback = clean;
            return resolve(clean);
          }
          var payload = {};
          payload[STORAGE_KEY] = clean;
          store.set(payload, function () { resolve(clean); });
        });
      },
      reset: function () {
        return this.save(DEFAULTS);
      }
    };
  }

  return {
    STORAGE_KEY: STORAGE_KEY,
    FORMATS: FORMATS,
    MODES: MODES,
    PAPERS: PAPERS,
    PDF_MODES: PDF_MODES,
    DEFAULTS: DEFAULTS,
    normalize: normalize,
    diffFromDefaults: diffFromDefaults,
    captureFormatFor: captureFormatFor,
    captureQualityFor: captureQualityFor,
    createStore: createStore
  };
});
