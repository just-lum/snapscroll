/* SnapScroll — 訊息協定
 *
 * 擴充裡同時存在四個執行環境：service worker、注入頁面的代理腳本、
 * offscreen document、UI 頁面（popup / options / result）。它們共用同一條
 * `chrome.runtime` 訊息匯流排，所以每一則訊息都要能回答「我是給誰的」。
 *
 * 這裡只放常數與兩個封裝函式，不含任何邏輯，因此 Node 測試、SW、頁面都能載入。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SnapScrollProtocol = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var FLAG = '__snapscroll';
  var VERSION = 1;

  /* 收件者 */
  var TO = {
    SW: 'sw',
    OFFSCREEN: 'offscreen',
    AGENT: 'agent',
    UI: 'ui'
  };

  /* 訊息類型 */
  var MSG = {
    /* UI → SW */
    START: 'start',
    CANCEL: 'cancel',
    FINISH_MANUAL: 'finish-manual',
    QUERY_STATE: 'query-state',
    OPEN_OPTIONS: 'open-options',
    OPEN_RESULT: 'open-result',
    PROBE_SCROLL: 'probe-scroll',

    /* SW → UI（廣播） */
    PROGRESS: 'progress',
    FINISHED: 'finished',
    FAILED: 'failed',

    /* SW → offscreen */
    OS_PING: 'os-ping',
    OS_BEGIN: 'os-begin',
    OS_FRAME: 'os-frame',
    OS_FINISH: 'os-finish',
    OS_ABORT: 'os-abort',
    OS_PROBE: 'os-probe',

    /* SW → 注入頁面的代理 */
    AG_MEASURE: 'ag-measure',
    AG_PROBE_SCROLL: 'ag-probe-scroll',
    AG_PREPARE: 'ag-prepare',
    AG_SCROLL: 'ag-scroll',
    AG_HIDE_FIXED: 'ag-hide-fixed',
    AG_OVERLAY: 'ag-overlay',
    AG_PICK: 'ag-pick',
    AG_RESTORE: 'ag-restore',
    AG_PING: 'ag-ping'
  };

  /* 任務階段（UI 用它決定顯示什麼） */
  var PHASE = {
    IDLE: 'idle',
    PREPARING: 'preparing',
    CAPTURING: 'capturing',
    STITCHING: 'stitching',
    ENCODING: 'encoding',
    DOWNLOADING: 'downloading',
    DONE: 'done',
    CANCELLED: 'cancelled',
    FAILED: 'failed'
  };

  function envelope(target, type, payload) {
    var msg = {};
    msg[FLAG] = true;
    msg.v = VERSION;
    msg.target = target;
    msg.type = type;
    msg.payload = payload === undefined ? null : payload;
    return msg;
  }

  /* offscreen / agent 都是被動端：收到別人的訊息時要能快速判斷「這是不是給我的」 */
  function isFor(message, target) {
    return !!message && message[FLAG] === true && message.target === target;
  }

  function isProtocolMessage(message) {
    return !!message && message[FLAG] === true;
  }

  /* 包成 Promise 的 sendMessage：SW 常常在等回覆，樣板碼收在這裡 */
  function send(target, type, payload) {
    return new Promise(function (resolve, reject) {
      try {
        chrome.runtime.sendMessage(envelope(target, type, payload), function (response) {
          var err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve(response);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  function sendToTab(tabId, type, payload) {
    return new Promise(function (resolve, reject) {
      try {
        chrome.tabs.sendMessage(tabId, envelope(TO.AGENT, type, payload), function (response) {
          var err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve(response);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  /* 錯誤碼：UI 拿它決定顯示哪一句話 */
  var ERR = {
    RESTRICTED_URL: 'restricted-url',
    NO_TAB: 'no-tab',
    INJECT_FAILED: 'inject-failed',
    CAPTURE_FAILED: 'capture-failed',
    OFFSCREEN_FAILED: 'offscreen-failed',
    USER_CANCELLED: 'user-cancelled',
    PAGE_CHANGED: 'page-changed',
    /* 頁面滾不動：要求滾到某個位置，實際卻留在原地。
     * 這是「整頁截圖只截到一屏」最常見的原因，必須單獨成一類。 */
    PAGE_NOT_SCROLLABLE: 'page-not-scrollable',
    /* 頁高被「高度上限」截斷。設定值只在設定頁可見，很容易忘了自己改過。 */
    HEIGHT_CAPPED: 'height-capped',
    /* 這一頁本來就只有一屏高（虛擬滾動、折疊態、需要互動才展開） */
    SINGLE_SCREEN: 'single-screen',
    UNKNOWN: 'unknown'
  };

  return {
    FLAG: FLAG,
    VERSION: VERSION,
    TO: TO,
    MSG: MSG,
    PHASE: PHASE,
    ERR: ERR,
    envelope: envelope,
    isFor: isFor,
    isProtocolMessage: isProtocolMessage,
    send: send,
    sendToTab: sendToTab
  };
});
