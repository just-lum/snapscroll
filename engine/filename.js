/* SnapScroll — 檔名模板
 *
 * 下載回來的檔案叫 `capture-2025-01-01-12-00-00.png` 的話，三天後就没人知道
 * 那是哪一頁。所以讓模板自己決定，例如：
 *   {date}_{host}_{title}
 *   → 2025-01-14_docs.example.com_安裝指南
 *
 * 麻煩的地方在 Windows：`< > : " / \ | ? *` 一律非法，結尾的點和空格會被
 * 系統默默吃掉（於是 `.png` 變成沒有副檔名），CON/PRN/AUX/NUL/COM1… 這些
 * 裝置名連帶副檔名都不能用。這裡一次處理乾淨。
 *
 * 全部是純函式，不碰 DOM。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SnapScrollFilename = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var ILLEGAL = /[<>:"/\\|?*]/g;
  var CONTROL = /[\u0000-\u001f\u007f]/g;
  var ZERO_WIDTH = /[\u200b-\u200d\ufeff]/g;
  var RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
  /* 至少要留下一個「實字」（字母、數字或非 ASCII 字元）。
   * 只由底線與符號組成的檔名技術上合法，但 `___.png` 這種東西沒有任何
   * 辨識價值——寧可退回 capture。 */
  var SUBSTANCE = /[0-9A-Za-z\u00c0-\uffff]/;

  var DEFAULT_TEMPLATE = '{date}_{host}_{title}';
  var MAX_SEGMENT = 120;

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function dateParts(d) {
    var t = d instanceof Date ? d : new Date();
    var y = t.getFullYear();
    var mo = pad2(t.getMonth() + 1);
    var da = pad2(t.getDate());
    var ho = pad2(t.getHours());
    var mi = pad2(t.getMinutes());
    var se = pad2(t.getSeconds());
    return {
      date: y + '-' + mo + '-' + da,
      time: ho + '-' + mi + '-' + se,
      datetime: y + '-' + mo + '-' + da + '_' + ho + '-' + mi + '-' + se,
      stamp: '' + y + mo + da + ho + mi + se
    };
  }

  function hostOf(url) {
    var s = String(url || '');
    var m = /^[a-z]+:\/\/([^/?#]+)/i.exec(s);
    var host = m ? m[1] : s;
    host = host.split('@').pop();
    host = host.split(':')[0];
    return host.replace(/^www\./i, '');
  }

  /* 單一段落（不含路徑分隔）的清洗 */
  function sanitize(name, maxLen) {
    var s = String(name == null ? '' : name);
    s = s.replace(CONTROL, '');
    s = s.replace(ZERO_WIDTH, '');
    s = s.replace(ILLEGAL, '_');
    s = s.replace(/\s+/g, ' ');
    s = s.trim();
    s = s.replace(/^[.\s]+/, '');
    s = s.replace(/[.\s]+$/, '');
    if (!s || !SUBSTANCE.test(s)) s = 'capture';
    if (RESERVED.test(s)) s = '_' + s;

    var limit = maxLen > 0 ? maxLen : MAX_SEGMENT;
    if (s.length > limit) {
      s = s.slice(0, limit).replace(/[.\s]+$/, '');
      if (!s) s = 'capture';
    }
    return s;
  }

  /* 資料夾路徑：逐段清洗，丟掉空段 */
  function sanitizeFolder(folder) {
    var s = String(folder == null ? '' : folder).replace(/\\/g, '/');
    var parts = s.split('/').map(function (p) { return p.trim(); }).filter(Boolean);
    if (!parts.length) return '';
    return parts.map(function (p) { return sanitize(p, 64); }).join('/');
  }

  /* 展開模板。認不得的佔位符原樣保留——這樣使用者一眼就看得出自己打錯了，
   * 而不是拿到一個莫名其妙被清空的檔名。 */
  function renderName(template, ctx) {
    var c = ctx || {};
    var now = c.now instanceof Date ? c.now : new Date();
    var parts = dateParts(now);
    var map = {
      title: c.title || 'page',
      host: c.host || hostOf(c.url) || 'page',
      url: c.url || '',
      date: parts.date,
      time: parts.time,
      datetime: parts.datetime,
      stamp: parts.stamp,
      mode: c.mode || 'full',
      format: String(c.format || 'png').toLowerCase(),
      index: c.index == null ? '' : String(c.index),
      width: c.width == null ? '' : String(c.width),
      height: c.height == null ? '' : String(c.height),
      w: c.width == null ? '' : String(c.width),
      h: c.height == null ? '' : String(c.height),
      part: c.part == null ? '' : String(c.part)
    };

    return String(template == null || template === '' ? DEFAULT_TEMPLATE : template)
      .replace(/\{(\w+)\}/g, function (whole, key) {
        return Object.prototype.hasOwnProperty.call(map, key) ? String(map[key]) : whole;
      });
  }

  /* 完整檔名：展開模板 → 清洗 → 補副檔名（模板裡已經寫了就不重複加）
   * 分片輸出時建議先展開佔位符再加後綴，避免 `part-01` 被清洗掉。 */
  function buildFilename(opts) {
    var o = opts || {};
    var ext = String(o.ext || 'png').replace(/^\./, '').toLowerCase();
    var base = renderName(o.template, o.ctx);
    var suffix = String(o.suffix || '');

    base = base + suffix;
    base = sanitize(base);

    var lower = base.toLowerCase();
    if (lower.slice(-(ext.length + 1)) === '.' + ext) return base;

    /* 保留副檔名不被長度截斷 */
    if (base.length + ext.length + 1 > MAX_SEGMENT) {
      base = sanitize(base, MAX_SEGMENT - ext.length - 1);
    }
    return base + '.' + ext;
  }

  /* 分片檔名前綴：page.png → page_part-01.png */
  function buildSliceFilename(opts, index, total) {
    var width = String(total || 1).length < 2 ? 2 : String(total).length;
    var num = String(index + 1);
    while (num.length < width) num = '0' + num;
    return buildFilename({
      template: opts && opts.template,
      ctx: opts && opts.ctx,
      ext: opts && opts.ext,
      suffix: '_part-' + num
    });
  }

  /* 給 chrome.downloads 的相對路徑（可含子資料夾） */
  function buildPath(opts) {
    var folder = sanitizeFolder(opts && opts.folder);
    var name = buildFilename(opts);
    return folder ? folder + '/' + name : name;
  }

  return {
    DEFAULT_TEMPLATE: DEFAULT_TEMPLATE,
    MAX_SEGMENT: MAX_SEGMENT,
    sanitize: sanitize,
    sanitizeFolder: sanitizeFolder,
    hostOf: hostOf,
    dateParts: dateParts,
    renderName: renderName,
    buildFilename: buildFilename,
    buildSliceFilename: buildSliceFilename,
    buildPath: buildPath
  };
});
