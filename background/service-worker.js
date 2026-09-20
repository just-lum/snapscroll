/* SnapScroll — service worker
 *
 * 這是擴充的大腦外殼：載入模組、收發訊息、維護工具列徽章、處理右鍵選單與
 * 快捷鍵，把真正的工作交給 capture-controller。
 *
 * 用 classic worker（沒有 "type": "module"）是刻意的：這樣才能用
 * importScripts 載入與 Node 測試、offscreen 頁面完全相同的 engine 檔案。
 * 一份程式碼，三個執行環境，零建置步驟。
 */

'use strict';

importScripts(
  '/engine/limits.js',
  '/engine/scroll-plan.js',
  '/engine/stitch-math.js',
  '/engine/paginate.js',
  '/engine/pdf-writer.js',
  '/engine/filename.js',
  '/common/protocol.js',
  '/common/settings.js',
  '/common/history.js',
  '/background/download.js',
  '/background/capture-controller.js'
);

var PROTO = globalThis.SnapScrollProtocol;
var SETTINGS = globalThis.SnapScrollSettings;
var HISTORY = globalThis.SnapScrollHistory;
var DOWNLOAD = globalThis.SnapScrollDownload;
var CAPTURE = globalThis.SnapScrollCapture;

var store = SETTINGS.createStore(chrome.storage.local);
var history = HISTORY.createHistory({ limit: 20 });

var lastResult = null;
var badgeTimer = null;

/* ── 徽章與廣播 ─────────────────────────────────────────────────── */

function setBadge(state) {
  if (badgeTimer) {
    clearTimeout(badgeTimer);
    badgeTimer = null;
  }
  var text = '';
  var color = '#0284c7';

  if (state.running) {
    var pct = Math.round((state.progress || 0) * 100);
    text = pct > 0 ? String(Math.min(99, pct)) : '·';
  } else if (state.phase === PROTO.PHASE.DONE) {
    text = '✓';
    color = '#16a34a';
    badgeTimer = setTimeout(function () { chrome.action.setBadgeText({ text: '' }); }, 4000);
  } else if (state.phase === PROTO.PHASE.FAILED) {
    text = '!';
    color = '#dc2626';
    badgeTimer = setTimeout(function () { chrome.action.setBadgeText({ text: '' }); }, 6000);
  }

  try {
    chrome.action.setBadgeText({ text: text });
    chrome.action.setBadgeBackgroundColor({ color: color });
    if (state.message) chrome.action.setTitle({ title: 'SnapScroll — ' + state.message });
  } catch (e) { /* 圖示可能還沒就緒 */ }
}

function broadcast(type, payload) {
  try {
    chrome.runtime.sendMessage(PROTO.envelope(PROTO.TO.UI, type, payload), function () {
      /* 沒有開著的面板會讓 lastError 亮起來，這是正常的 */
      void chrome.runtime.lastError;
    });
  } catch (e) { /* 沒有接收端 */ }
}

/* ── 控制器 ─────────────────────────────────────────────────────── */

var controller = CAPTURE.createController({
  onState: function (state) {
    setBadge(state);
    if (state.running) {
      broadcast(PROTO.MSG.PROGRESS, state);
    }
  },
  download: function (opts) {
    return DOWNLOAD.downloadAndWait(opts);
  }
});

/* ── 歷史 ───────────────────────────────────────────────────────── */

function storeHistory(result) {
  /* blob URL 在 release() 之後就失效，所以要先把它們讀成 Blob 存起來 */
  var jobs = (result.blobUrls || []).map(function (url, i) {
    return fetch(url)
      .then(function (res) { return res.blob(); })
      .then(function (blob) {
        var meta = (result.files && result.files[i]) || {};
        return { name: meta.path || ('part-' + (i + 1)), bytes: blob.size, blob: blob };
      })
      .catch(function () { return null; });
  });

  return Promise.all(jobs).then(function (files) {
    var usable = files.filter(Boolean);
    if (!usable.length) return null;
    return history.add({
      id: result.jobId,
      createdAt: Date.now(),
      title: result.meta && result.meta.title,
      url: result.meta && result.meta.url,
      format: result.format,
      kind: result.kind,
      mode: result.settings && result.settings.mode,
      outputWidth: result.outputWidth,
      outputHeight: result.outputHeight,
      pageCount: result.pageCount,
      frames: result.frames,
      thumb: result.thumb,
      files: usable
    });
  });
}

/* ── 啟動擷取 ───────────────────────────────────────────────────── */

async function activeTabId() {
  var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  var tab = tabs && tabs[0];
  return tab ? tab.id : null;
}

async function runCapture(tabId, overrides) {
  var settings = await store.load();
  var options = Object.assign({}, settings, overrides || {});

  if (tabId == null) tabId = await activeTabId();
  if (tabId == null) throw new Error('找不到使用中的分頁');

  var result;
  try {
    result = await controller.run(tabId, options);
  } catch (err) {
    var failure = {
      ok: false,
      code: (err && err.code) || PROTO.ERR.UNKNOWN,
      error: (err && err.message) || '擷取失敗'
    };
    broadcast(PROTO.MSG.FAILED, failure);
    return failure;
  }

  /* 先存歷史（此時 blob URL 還有用），再釋放 */
  try {
    await storeHistory(result);
    await history.prune(options.keepHistory);
  } catch (e) {
    /* 存歷史失敗不該讓一張已經下載好的截圖變成失敗 */
  }

  lastResult = result;
  await controller.release();

  broadcast(PROTO.MSG.FINISHED, result);

  /* 不保留歷史時就不開結果頁：那裡是從 IndexedDB 讀資料的，記錄已經被
   * prune 清掉了，開過去只會看到「找不到這筆紀錄」。 */
  if (options.openResultPage && options.keepHistory > 0 && result.files && result.files.length) {
    try {
      await chrome.tabs.create({
        url: chrome.runtime.getURL('ui/result.html?id=' + encodeURIComponent(result.jobId))
      });
    } catch (e) { /* 開不了就算了，檔案已經下載 */ }
  }

  return result;
}

/* ── 訊息路由 ───────────────────────────────────────────────────── */

async function handleMessage(msg, sender) {
  var payload = msg.payload || {};

  switch (msg.type) {
    case PROTO.MSG.START:
      /* 刻意「不等待」整個擷取流程：一次長截圖可能跑上十幾秒，
       * 而彈出面板隨時會被關掉。立刻回覆、背景繼續跑，
       * 進度從 PROGRESS / FINISHED 廣播回來。 */
      if (controller.isRunning()) {
        return { ok: false, error: '已經有一個擷取正在進行' };
      }
      runCapture(payload.tabId, payload.options).catch(function () {
        /* 失敗已經在 runCapture 內部廣播過了 */
      });
      return { ok: true, started: true };

    case PROTO.MSG.CANCEL:
      return { ok: controller.cancel(payload.reason) };

    case PROTO.MSG.FINISH_MANUAL:
      return { ok: controller.requestFinish() };

    case PROTO.MSG.QUERY_STATE:
      return { ok: true, state: controller.snapshot(), last: lastResult };

    case PROTO.MSG.OPEN_OPTIONS:
      chrome.runtime.openOptionsPage();
      return { ok: true };

    case PROTO.MSG.PROBE_SCROLL:
      try {
        var probeTabId = payload.tabId;
        if (probeTabId == null) probeTabId = await activeTabId();
        if (probeTabId == null) return { ok: false, error: '找不到使用中的分頁' };
        return await controller.probeScroll(probeTabId);
      } catch (err) {
        return {
          ok: false,
          error: String((err && err.message) || err),
          code: (err && err.code) || PROTO.ERR.UNKNOWN
        };
      }

    case PROTO.MSG.OPEN_RESULT:
      if (payload.id) {
        await chrome.tabs.create({ url: chrome.runtime.getURL('ui/result.html?id=' + encodeURIComponent(payload.id)) });
      }
      return { ok: true };

    default:
      return { ok: false, error: '未知指令：' + msg.type };
  }
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!PROTO.isProtocolMessage(msg)) return false;
  if (msg.target !== PROTO.TO.SW) return false;

  Promise.resolve()
    .then(function () { return handleMessage(msg, sender); })
    .then(
      function (result) { sendResponse(result === undefined ? { ok: true } : result); },
      function (err) {
        sendResponse({ ok: false, error: String((err && err.message) || err), code: err && err.code });
      }
    );
  return true;
});

/* ── 右鍵選單 ───────────────────────────────────────────────────── */

function buildMenus() {
  chrome.contextMenus.removeAll(function () {
    chrome.contextMenus.create({
      id: 'snapscroll-full',
      title: chrome.i18n.getMessage('menu_full_page') || 'SnapScroll：擷取整頁長截圖',
      contexts: ['page', 'frame', 'image', 'link', 'selection']
    });
    chrome.contextMenus.create({
      id: 'snapscroll-viewport',
      title: chrome.i18n.getMessage('menu_visible') || 'SnapScroll：擷取可視區域',
      contexts: ['page', 'frame', 'image', 'link', 'selection']
    });
    chrome.contextMenus.create({
      id: 'snapscroll-region',
      title: chrome.i18n.getMessage('menu_region') || 'SnapScroll：框選範圍',
      contexts: ['page', 'frame', 'image', 'link', 'selection']
    });
    chrome.contextMenus.create({
      id: 'snapscroll-element',
      title: chrome.i18n.getMessage('menu_element') || 'SnapScroll：點選元素',
      contexts: ['page', 'frame', 'image', 'link', 'selection']
    });
  });
}

chrome.runtime.onInstalled.addListener(function (details) {
  buildMenus();
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onStartup.addListener(buildMenus);

chrome.contextMenus.onClicked.addListener(function (info, tab) {
  if (!tab || tab.id === undefined) return;
  var mode = 'full';
  if (info.menuItemId === 'snapscroll-viewport') mode = 'viewport';
  else if (info.menuItemId === 'snapscroll-region') mode = 'region';
  else if (info.menuItemId === 'snapscroll-element') mode = 'element';
  else if (info.menuItemId !== 'snapscroll-full') return;

  runCapture(tab.id, { mode: mode });
});

/* ── 快捷鍵 ─────────────────────────────────────────────────────── */

chrome.commands.onCommand.addListener(async function (command) {
  if (command !== 'capture-full-page') return;
  try {
    await runCapture(null, { mode: 'full' });
  } catch (e) { /* 錯誤已經廣播出去了 */ }
});

/* 分頁關閉時取消進行中的工作，避免控制器一直等一個不存在的頁面 */
chrome.tabs.onRemoved.addListener(function (tabId) {
  var state = controller.snapshot();
  if (state.running && state.tabId === tabId) {
    controller.cancel('分頁已關閉');
  }
});
