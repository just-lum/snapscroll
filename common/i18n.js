/* SnapScroll — 介面文字
 *
 * 走 chrome.i18n，但 HTML 裡就寫好中文原文當後備：翻譯檔缺字時畫面
 * 顯示的是看得懂的中文，而不是 `popup_mode_full` 這串 key。
 *
 * 用法：
 *   <button data-i18n="popup_capture">開始擷取</button>
 *   <button data-i18n-title="popup_options" title="設定">…</button>
 *   <option data-i18n="paper_a4">A4</option>
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SnapScrollI18n = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function hasI18n() {
    return typeof chrome !== 'undefined' && chrome.i18n && typeof chrome.i18n.getMessage === 'function';
  }

  function t(key, fallback, substitutions) {
    var value = '';
    if (hasI18n()) {
      try {
        value = chrome.i18n.getMessage(key, substitutions) || '';
      } catch (e) {
        value = '';
      }
    }
    if (value) return value;
    return fallback == null ? key : fallback;
  }

  /* 把整棵子樹裡帶 data-i18n* 的節點填上對應文字。
   * 只覆蓋「翻譯檔真的有這一條」的情況，否則保留 HTML 裡的原字。 */
  function apply(rootNode) {
    var scope = rootNode || document;
    var nodes = scope.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var key = el.getAttribute('data-i18n');
      var text = t(key, '');
      if (text) el.textContent = text;
    }

    var titled = scope.querySelectorAll('[data-i18n-title]');
    for (var j = 0; j < titled.length; j++) {
      var el2 = titled[j];
      var text2 = t(el2.getAttribute('data-i18n-title'), '');
      if (text2) el2.setAttribute('title', text2);
    }

    var placeholders = scope.querySelectorAll('[data-i18n-placeholder]');
    for (var k = 0; k < placeholders.length; k++) {
      var el3 = placeholders[k];
      var text3 = t(el3.getAttribute('data-i18n-placeholder'), '');
      if (text3) el3.setAttribute('placeholder', text3);
    }
    return scope;
  }

  function locale() {
    if (!hasI18n()) return 'zh-CN';
    try { return chrome.i18n.getUILanguage(); } catch (e) { return 'zh-CN'; }
  }

  return {
    t: t,
    apply: apply,
    locale: locale
  };
});
