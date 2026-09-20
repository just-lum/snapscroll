/* SnapScroll — 擷取歷史（IndexedDB）
 *
 * 為什麼不用 chrome.storage：storage.local 的預設配額是 10 MB，
 * 一張長截圖就吃光了。IndexedDB 可以存 Blob，而且量大時瀏覽器會把資料
 * 落到磁碟，不會全部壓在記憶體裡。
 *
 * 資料分成兩張表：
 *   captures — 每筆的摘要（標題、尺寸、時間、縮圖）。列表只讀這張，
 *              所以即使存了幾十張長圖，開歷史面板也不會把大圖全拉進記憶體。
 *   files    — 實際的圖片 Blob，按 captureId 關聯。
 *
 * 這個模組同時被 service worker（儲存）與結果頁（讀取、下載）使用。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SnapScrollHistory = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DB_NAME = 'snapscroll';
  var DB_VERSION = 1;
  var CAPTURES = 'captures';
  var FILES = 'files';

  function request(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('IndexedDB 操作失敗')); };
    });
  }

  function openDb() {
    return new Promise(function (resolve, reject) {
      var req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        reject(e);
        return;
      }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(CAPTURES)) {
          var captures = db.createObjectStore(CAPTURES, { keyPath: 'id' });
          captures.createIndex('createdAt', 'createdAt');
        }
        if (!db.objectStoreNames.contains(FILES)) {
          var files = db.createObjectStore(FILES, { keyPath: 'key' });
          files.createIndex('captureId', 'captureId');
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('無法開啟資料庫')); };
      req.onblocked = function () { reject(new Error('資料庫被其他頁面鎖住')); };
    });
  }

  function createHistory(opts) {
    var options = opts || {};
    var defaultLimit = options.limit || 20;
    var dbPromise = null;

    function db() {
      if (!dbPromise) dbPromise = openDb();
      return dbPromise;
    }

    function withStore(names, mode, work) {
      return db().then(function (database) {
        return new Promise(function (resolve, reject) {
          var tx = database.transaction(names, mode);
          var stores = names.map(function (n) { return tx.objectStore(n); });
          var out;
          try {
            out = work(stores, tx);
          } catch (e) {
            reject(e);
            return;
          }
          tx.oncomplete = function () { resolve(out); };
          tx.onerror = function () { reject(tx.error || new Error('交易失敗')); };
          tx.onabort = function () { reject(tx.error || new Error('交易被中止')); };
        });
      });
    }

    /* record = {
     *   id, createdAt, title, url, format, kind, mode,
     *   outputWidth, outputHeight, pageCount, frames, thumb,
     *   files: [{ name, bytes, blob }]
     * } */
    function add(record) {
      var r = record || {};
      var id = r.id || ('cap-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6));
      var files = r.files || [];

      var summary = {
        id: id,
        createdAt: r.createdAt || Date.now(),
        title: r.title || 'page',
        url: r.url || '',
        format: r.format || 'png',
        kind: r.kind || 'image',
        mode: r.mode || 'full',
        outputWidth: r.outputWidth || 0,
        outputHeight: r.outputHeight || 0,
        pageCount: r.pageCount || null,
        frames: r.frames || 0,
        fileCount: files.length,
        bytes: files.reduce(function (n, f) { return n + (f.bytes || 0); }, 0),
        thumb: r.thumb || null
      };

      return withStore([CAPTURES, FILES], 'readwrite', function (stores) {
        var captures = stores[0];
        var fileStore = stores[1];
        captures.put(summary);
        files.forEach(function (file, i) {
          fileStore.put({
            key: id + ':' + i,
            captureId: id,
            index: i,
            name: file.name || ('part-' + (i + 1)),
            bytes: file.bytes || (file.blob ? file.blob.size : 0),
            blob: file.blob
          });
        });
      }).then(function () { return id; });
    }

    function list(limit) {
      var cap = limit == null ? defaultLimit : limit;
      return withStore([CAPTURES], 'readonly', function (stores) {
        return request(stores[0].getAll());
      }).then(function (items) {
        var sorted = (items || []).sort(function (a, b) { return b.createdAt - a.createdAt; });
        return cap > 0 ? sorted.slice(0, cap) : sorted;
      });
    }

    function get(id) {
      return withStore([CAPTURES, FILES], 'readonly', function (stores) {
        return Promise.all([
          request(stores[0].get(id)),
          request(stores[1].index('captureId').getAll(id))
        ]);
      }).then(function (pair) {
        var summary = pair[0];
        if (!summary) return null;
        var files = (pair[1] || []).sort(function (a, b) { return a.index - b.index; });
        return { summary: summary, files: files };
      });
    }

    function remove(id) {
      return withStore([CAPTURES, FILES], 'readwrite', function (stores) {
        stores[0].delete(id);
        return request(stores[1].index('captureId').getAllKeys(id)).then(function (keys) {
          (keys || []).forEach(function (k) { stores[1].delete(k); });
        });
      }).then(function () { return true; });
    }

    function clear() {
      return withStore([CAPTURES, FILES], 'readwrite', function (stores) {
        stores[0].clear();
        stores[1].clear();
      }).then(function () { return true; });
    }

    /* 只保留最近 N 筆，其餘連同檔案一起刪掉。
     * 沒有這一步，歷史會無聲地長到把使用者的磁碟吃掉。 */
    function prune(limit) {
      var cap = limit == null ? defaultLimit : limit;
      if (cap <= 0) return clear().then(function () { return 0; });

      return list(0).then(function (items) {
        var extra = items.slice(cap);
        if (!extra.length) return 0;
        return extra.reduce(function (chain, item) {
          return chain.then(function () { return remove(item.id); });
        }, Promise.resolve()).then(function () { return extra.length; });
      });
    }

    return {
      add: add,
      list: list,
      get: get,
      remove: remove,
      clear: clear,
      prune: prune,
      DB_NAME: DB_NAME
    };
  }

  return {
    createHistory: createHistory,
    DB_NAME: DB_NAME,
    DB_VERSION: DB_VERSION
  };
});
