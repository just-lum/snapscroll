/* SnapScroll — 下載
 *
 * MV3 的 service worker 裡沒有 DOM，所以 `URL.createObjectURL` 不存在，
 * 沒辦法自己造 blob URL 來下載。做法是讓 offscreen document 把圖編好、
 * 造好 blob URL，再把那串 URL 交給這裡下載——同一個擴充 origin，
 * downloads API 取得到。
 *
 * 另外 `chrome.downloads.download` 對「檔名已存在」的處理要明確指定，
 * 預設值是 uniquify（自動加 (1)），這比默默覆蓋使用者既有檔案安全。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SnapScrollDownload = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DEFAULT_TIMEOUT_MS = 120000;

  function download(opts) {
    var options = opts || {};
    return new Promise(function (resolve, reject) {
      if (!options.url) {
        reject(new Error('下載失敗：沒有來源網址'));
        return;
      }
      var spec = {
        url: options.url,
        saveAs: !!options.saveAs,
        conflictAction: options.conflictAction || 'uniquify'
      };
      if (options.filename) spec.filename = options.filename;

      try {
        chrome.downloads.download(spec, function (downloadId) {
          var err = chrome.runtime.lastError;
          if (err) {
            reject(new Error(err.message || '下載被拒絕'));
            return;
          }
          if (downloadId === undefined) {
            reject(new Error('下載沒有回傳識別碼'));
            return;
          }
          resolve(downloadId);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  /* 等一個下載真正落地（或失敗）。
   * blob URL 必須在下載完成後才能 revoke——提早放掉會得到一個 0 位元組的檔案。 */
  function waitForFinish(downloadId, timeoutMs) {
    var limit = timeoutMs || DEFAULT_TIMEOUT_MS;
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        chrome.downloads.onChanged.removeListener(onChanged);
        reject(new Error('下載逾時'));
      }, limit);

      function cleanup() {
        clearTimeout(timer);
        chrome.downloads.onChanged.removeListener(onChanged);
      }

      function onChanged(delta) {
        if (delta.id !== downloadId || !delta.state) return;
        if (settled) return;
        if (delta.state.current === 'complete') {
          settled = true;
          cleanup();
          resolve({ downloadId: downloadId, state: 'complete' });
        } else if (delta.state.current === 'interrupted') {
          settled = true;
          cleanup();
          var why = delta.error && delta.error.current ? delta.error.current : 'interrupted';
          reject(new Error('下載被中斷：' + why));
        }
      }

      chrome.downloads.onChanged.addListener(onChanged);
    });
  }

  /* 下載並等它完成，最後回傳實際落地路徑 */
  function downloadAndWait(opts) {
    return download(opts).then(function (id) {
      return waitForFinish(id, opts && opts.timeoutMs).then(function () {
        return new Promise(function (resolve) {
          chrome.downloads.search({ id: id }, function (items) {
            var item = items && items[0];
            resolve({
              downloadId: id,
              filename: item && item.filename ? item.filename : null,
              bytes: item && item.fileSize ? item.fileSize : null,
              url: item && item.url ? item.url : (opts && opts.url)
            });
          });
        });
      });
    });
  }

  return {
    download: download,
    waitForFinish: waitForFinish,
    downloadAndWait: downloadAndWait
  };
});
