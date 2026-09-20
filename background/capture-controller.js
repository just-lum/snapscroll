/* SnapScroll — 擷取控制器
 *
 * 這是整個擴充的指揮部：注入頁面代理、逐幀滾動、抓畫面、交給 offscreen 拼接、
 * 收尾編碼、下載。它自己不碰像素，也不碰 DOM，只負責順序與錯誤處理。
 *
 * 三個容易做錯、這裡特別處理的地方：
 *
 * 1. **captureVisibleTab 有呼叫配額。**
 *    連續快呼會被擋下來。所以每次抓幀之間有最小間隔，失敗時指數退避重試，
 *    而不是硬撞。手動滾動模式的上限也來自同一個限制。
 *
 * 2. **不管成功、失敗還是取消，頁面都必須回到原狀。**
 *    所有對頁面的改動都走 try/finally，最後一定送 AG_RESTORE。
 *
 * 3. **service worker 會被回收。**
 *    擷取期間用一個輕量的 keepalive 心跳把 SW 釘住；任務結束就停掉，
 *    不做無謂的常駐。
 */
(function (root, factory) {
  var api = factory(
    typeof module === 'object' && module.exports ? require('../common/protocol.js') : root.SnapScrollProtocol,
    typeof module === 'object' && module.exports ? require('../common/settings.js') : root.SnapScrollSettings,
    typeof module === 'object' && module.exports ? require('../engine/scroll-plan.js') : root.SnapScrollScrollPlan,
    typeof module === 'object' && module.exports ? require('../engine/filename.js') : root.SnapScrollFilename,
    typeof module === 'object' && module.exports ? require('../engine/limits.js') : root.SnapScrollLimits
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SnapScrollCapture = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (PROTO, SETTINGS, SCROLL, FILENAME, LIMITS) {
  'use strict';

  /* 兩次 captureVisibleTab 之間的最小間隔。
   * Chrome 對這個 API 有每秒數次的配額，撞上去只會拿到錯誤，
   * 與其重試到天荒地老，不如穩穩地慢一點——反正瓶頸在頁面渲染。 */
  var MIN_CAPTURE_GAP_MS = 520;

  var KEEPALIVE_MS = 20000;

  /* 切換 HUD 可見性之後，再額外等這一小段。
   * page-agent 已經等了兩個 rAF（渲染排程），這裡補的是合成器提交的時間。 */
  var HUD_SETTLE_MS = 80;

  /* 手動滾動模式的節奏。取樣率的上限被 captureVisibleTab 的呼叫配額鎖住，
   * 所以「慢」不是設計選擇而是事實——與其假裝流暢，不如把取樣做穩，
   * 並且在使用者停手之後自己收工。 */
  var MANUAL_SAMPLE_MS = 520;
  var MANUAL_IDLE_MS = 4500;
  var MANUAL_MAX_MS = 5 * 60 * 1000;
  var MANUAL_MIN_STEP_PX = 40;

  var RESTRICTED_SCHEMES = [
    'chrome:', 'chrome-extension:', 'chrome-untrusted:', 'edge:', 'about:',
    'devtools:', 'view-source:', 'brave:', 'opera:', 'vivaldi:', 'file:'
  ];

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, Math.max(0, ms | 0)); });
  }

  function nowId() {
    return 'job-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function isCapturableUrl(url) {
    if (!url) return false;
    var lower = String(url).toLowerCase();
    for (var i = 0; i < RESTRICTED_SCHEMES.length; i++) {
      if (lower.indexOf(RESTRICTED_SCHEMES[i]) === 0) return false;
    }
    return lower.indexOf('http://') === 0 ||
      lower.indexOf('https://') === 0 ||
      lower.indexOf('ftp://') === 0 ||
      lower.indexOf('data:') === 0;
  }

  function createController(hooks) {
    var H = hooks || {};

    var state = {
      phase: PROTO.PHASE.IDLE,
      running: false,
      jobId: null,
      tabId: null,
      progress: 0,
      frameIndex: 0,
      frameCount: 0,
      message: '',
      startedAt: 0
    };

    var cancelRequested = false;
    var finishRequested = false;
    var keepAliveTimer = null;
    var lastCaptureAt = 0;
    var offscreenOpen = false;
    var manualState = null;

    function snapshot() {
      return {
        phase: state.phase,
        running: state.running,
        jobId: state.jobId,
        tabId: state.tabId,
        progress: state.progress,
        frameIndex: state.frameIndex,
        frameCount: state.frameCount,
        message: state.message,
        startedAt: state.startedAt
      };
    }

    function emit(patch) {
      Object.keys(patch).forEach(function (k) { state[k] = patch[k]; });
      if (H.onState) {
        try { H.onState(snapshot()); } catch (e) { /* 監聽者自己壞掉不影響流程 */ }
      }
    }

    function fail(code, message, detail) {
      var err = new Error(message || code);
      err.code = code;
      if (detail) err.detail = detail;
      return err;
    }

    function checkCancelled() {
      if (cancelRequested) {
        throw fail(PROTO.ERR.USER_CANCELLED, '已取消');
      }
    }

    /* ── 與各端通訊 ─────────────────────────────────────────────── */

    function agentCall(tabId, type, payload) {
      return PROTO.sendToTab(tabId, type, payload).then(function (res) {
        if (!res) throw new Error('頁面沒有回應');
        if (res.ok === false) throw new Error(res.error || '頁面操作失敗');
        return res.data;
      });
    }

    function offscreenCall(type, payload) {
      return PROTO.send(PROTO.TO.OFFSCREEN, type, payload).then(function (res) {
        if (!res) throw new Error('影像處理端沒有回應');
        if (res.ok === false) throw new Error(res.error || '影像處理失敗');
        return res;
      });
    }

    async function ensureOffscreen() {
      if (offscreenOpen) return;
      var has = await chrome.offscreen.hasDocument();
      if (!has) {
        await chrome.offscreen.createDocument({
          url: 'offscreen/offscreen.html',
          reasons: ['BLOBS'],
          justification: '拼接截圖畫布並編碼成 PNG / JPEG / WebP / PDF；service worker 沒有 DOM 與 canvas。'
        });
      }
      offscreenOpen = true;
      /* 等它把監聽器註冊起來 */
      for (var i = 0; i < 20; i++) {
        try {
          var pong = await offscreenCall(PROTO.MSG.OS_PING, {});
          if (pong && pong.ready) return;
        } catch (e) { /* 還沒準備好，再試 */ }
        await sleep(60);
      }
      throw fail(PROTO.ERR.OFFSCREEN_FAILED, '影像處理端啟動逾時');
    }

    async function closeOffscreen() {
      if (!offscreenOpen) return;
      offscreenOpen = false;
      try {
        var has = await chrome.offscreen.hasDocument();
        if (has) await chrome.offscreen.closeDocument();
      } catch (e) { /* 已經關了 */ }
    }

    /* ── 心跳 ───────────────────────────────────────────────────── */

    function startKeepAlive() {
      stopKeepAlive();
      keepAliveTimer = setInterval(function () {
        try {
          chrome.runtime.getPlatformInfo(function () { void chrome.runtime.lastError; });
        } catch (e) { /* SW 正在收尾 */ }
      }, KEEPALIVE_MS);
    }

    function stopKeepAlive() {
      if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
      }
    }

    /* ── 注入 ───────────────────────────────────────────────────── */

    async function injectAgent(tabId) {
      try {
        await chrome.scripting.insertCSS({
          target: { tabId: tabId },
          files: ['injected/overlay.css']
        });
      } catch (e) {
        /* 樣式注入失敗不致命：HUD 會沒有外觀，但擷取照樣能跑 */
      }
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tabId },
          /* 代理要用到 scroll-plan 的捲動判定與 limits 的頁高擇優，
           * 所以這兩個引擎模組也要一起進頁面（順序有意義）。 */
          files: [
            'engine/limits.js',
            'engine/scroll-plan.js',
            'common/protocol.js',
            'injected/page-agent.js'
          ],
          world: 'ISOLATED'
        });
      } catch (e) {
        throw fail(PROTO.ERR.INJECT_FAILED, '無法在這個頁面上執行（' + ((e && e.message) || e) + '）');
      }

      for (var i = 0; i < 6; i++) {
        try {
          var pong = await agentCall(tabId, PROTO.MSG.AG_PING);
          if (pong && pong.ready) return;
        } catch (e) { /* 監聽器還沒就緒 */ }
        await sleep(70);
      }
      throw fail(PROTO.ERR.INJECT_FAILED, '頁面代理沒有回應');
    }

    /* ── 活動分頁 ───────────────────────────────────────────────────
     * `captureVisibleTab(windowId)` 抓的是「這個視窗目前顯示的那一頁」，
     * 而不是我們手上那個 tabId。只要活動分頁不是目標分頁——使用者中途
     * 切走了、擴充功能自己開了設定頁、或開了新視窗——後面每一幀都會
     * 拍到別的網站，而且**不會拋任何錯**：尺寸照樣對，內容全錯。
     *
     * 所以每次抓幀前都先確認一次，不是就把它拉回前台。
     * ------------------------------------------------------------------ */
    async function ensureActiveTab(tabId) {
      try {
        var tab = await chrome.tabs.get(tabId);
        if (!tab) return false;
        if (tab.active) return true;
        await chrome.tabs.update(tabId, { active: true });
        /* 分頁切回前台之後，瀏覽器需要一點時間重新合成畫面 */
        await sleep(180);
        return true;
      } catch (e) {
        return false;
      }
    }

    /* ── 抓幀 ───────────────────────────────────────────────────── */

    function captureVisible(windowId, settings) {
      var format = SETTINGS.captureFormatFor(settings);
      var options = { format: format };
      var quality = SETTINGS.captureQualityFor(settings);
      if (quality !== undefined && format === 'jpeg') options.quality = Math.round(quality * 100);

      var attempt = 0;
      var limit = Math.max(0, settings.retryLimit | 0);

      function once() {
        var gap = Date.now() - lastCaptureAt;
        var wait = gap < MIN_CAPTURE_GAP_MS ? MIN_CAPTURE_GAP_MS - gap : 0;
        return sleep(wait).then(function () {
          lastCaptureAt = Date.now();
          return chrome.tabs.captureVisibleTab(windowId, options);
        });
      }

      function retry(err) {
        attempt++;
        if (attempt > limit) {
          throw fail(PROTO.ERR.CAPTURE_FAILED, '抓取畫面失敗：' + ((err && err.message) || err));
        }
        return sleep(Math.min(2000, 150 * Math.pow(1.7, attempt))).then(once).catch(function (e) {
          if (e && e.code) throw e;
          return retry(e);
        });
      }

      return once().then(function (dataUrl) {
        if (!dataUrl) throw fail(PROTO.ERR.CAPTURE_FAILED, '抓到空白畫面');
        return dataUrl;
      }).catch(function (err) {
        if (err && err.code) throw err;
        return retry(err);
      });
    }

    /* ── 檔名與下載 ─────────────────────────────────────────────── */

    function buildDownloadPath(settings, meta, ext, index, total) {
      var ctx = {
        title: meta.title,
        url: meta.url,
        host: FILENAME.hostOf(meta.url),
        mode: settings.mode,
        format: ext,
        width: meta.width,
        height: meta.height
      };
      var name = (total > 1)
        ? FILENAME.buildSliceFilename({ template: settings.filenameTemplate, ctx: ctx, ext: ext }, index, total)
        : FILENAME.buildFilename({ template: settings.filenameTemplate, ctx: ctx, ext: ext });
      var folder = FILENAME.sanitizeFolder(settings.folder);
      return folder ? folder + '/' + name : name;
    }

    /* ── 手動滾動 ───────────────────────────────────────────────────
     * 不做程式化滾動，改成「取樣」：使用者自己往下滾，我們固定間隔抓一幀，
     * 並用當時的 scrollY 當作這一幀在輸出圖裡的位置。
     *
     * 為什麼要有這個模式：虛擬滾動清單、要互動才展開的內容、無限捲動的動態牆，
     * 自動滾動常常截不完整；人手動滾一遍反而什麼都看到了。
     * 代價是抓幀配額讓取樣率上不去（約 2fps），所以位置沒動時就不抓，
     * 停手幾秒就當作結束。
     * ------------------------------------------------------------------ */
    async function manualStep(tabId, windowId, settings, viewportHeight, heightCap) {
      var metrics = await agentCall(tabId, PROTO.MSG.AG_MEASURE);
      var y = Math.max(0, Math.round(metrics.scrollY || 0));

      if (Math.abs(y - manualState.lastY) > 2) {
        manualState.lastY = y;
        manualState.idleSince = Date.now();
      }

      var idleMs = Date.now() - manualState.idleSince;
      var overCap = (y + viewportHeight) > heightCap;

      if (overCap) {
        manualState.stoppedBecause = 'height-cap';
        return { done: true, metrics: metrics };
      }
      if (idleMs > MANUAL_IDLE_MS || Date.now() - manualState.startedAt > MANUAL_MAX_MS) {
        manualState.stoppedBecause = idleMs > MANUAL_IDLE_MS ? 'idle' : 'timeout';
        return { done: true, metrics: metrics };
      }
      if (finishRequested) {
        manualState.stoppedBecause = 'user';
        return { done: true, metrics: metrics };
      }

      /* 位置幾乎沒變就不浪費一次配額 */
      if (manualState.count > 0 && Math.abs(y - manualState.lastCapturedY) < MANUAL_MIN_STEP_PX) {
        return { skip: true, metrics: metrics };
      }

      /* 手動模式的 HUD 上有「完成」按鈕，不能整段收起，
       * 只能在抓這一幀的時候藏一下——順便等合成器跟上。 */
      var stowed = false;
      if (settings.showOverlay && settings.hideOwnOverlay) {
        try {
          await agentCall(tabId, PROTO.MSG.AG_OVERLAY, { hidden: true });
          await sleep(HUD_SETTLE_MS);
          stowed = true;
        } catch (e) { /* 忽略 */ }
      }

      var dataUrl = await captureVisible(windowId, settings);

      if (stowed) {
        try { await agentCall(tabId, PROTO.MSG.AG_OVERLAY, { hidden: false }); } catch (e) { /* 忽略 */ }
      }

      var frame = {
        index: manualState.count,
        y: y,
        clipY: 0,
        clipHeight: viewportHeight,
        coveredBefore: y,
        coveredAfter: Math.min(y + viewportHeight, heightCap)
      };
      manualState.lastCapturedY = y;
      manualState.count++;
      manualState.intervals.push([y, frame.coveredAfter]);

      return { frame: frame, dataUrl: dataUrl, metrics: metrics };
    }

    /* 覆蓋率：手動模式沒有「連續推進」可言，只能把抓到的區間聯集起來看 */
    function manualCoverage() {
      if (!manualState || !manualState.intervals.length) return 0;
      var sorted = manualState.intervals.slice().sort(function (a, b) { return a[0] - b[0]; });
      var total = 0;
      var from = sorted[0][0];
      var to = sorted[0][1];
      for (var i = 1; i < sorted.length; i++) {
        if (sorted[i][0] > to) {
          total += to - from;
          from = sorted[i][0];
          to = sorted[i][1];
        } else if (sorted[i][1] > to) {
          to = sorted[i][1];
        }
      }
      total += to - from;
      return total;
    }

    /* ── 主流程 ─────────────────────────────────────────────────── */

    async function run(tabId, rawOptions) {
      if (state.running) {
        throw fail(PROTO.ERR.UNKNOWN, '已經有一個擷取正在進行');
      }

      var settings = SETTINGS.normalize(rawOptions);
      cancelRequested = false;
      finishRequested = false;
      manualState = null;
      lastCaptureAt = 0;

      var tab = await chrome.tabs.get(tabId).catch(function () { return null; });
      if (!tab || tab.id === undefined) {
        throw fail(PROTO.ERR.NO_TAB, '找不到這個分頁');
      }
      if (!isCapturableUrl(tab.url)) {
        throw fail(PROTO.ERR.RESTRICTED_URL, '這個頁面不允許擴充功能擷取（瀏覽器內部頁面或本機檔案）');
      }

      var meta = {
        title: tab.title || 'page',
        url: tab.url || '',
        width: 0,
        height: 0
      };

      var jobId = nowId();
      emit({
        phase: PROTO.PHASE.PREPARING,
        running: true,
        jobId: jobId,
        tabId: tabId,
        progress: 0,
        frameIndex: 0,
        frameCount: 0,
        message: '準備頁面…',
        startedAt: Date.now()
      });
      startKeepAlive();

      var injected = false;
      var finalResult = null;

      try {
        await ensureOffscreen();
        await injectAgent(tabId);
        injected = true;

        /* 起始延遲：設定頁上真的有這個滑桿，使用者拖了它就該生效。
         * （先前的版本只存了值、從沒讀過，等於騙人。） */
        if (settings.startDelayMs > 0) {
          emit({ phase: PROTO.PHASE.PREPARING, message: '延遲 ' + settings.startDelayMs + ' ms 後開始…' });
          await sleep(settings.startDelayMs);
        }

        var info = await agentCall(tabId, PROTO.MSG.AG_MEASURE);
        if (!info || !info.viewportHeight) throw fail(PROTO.ERR.PAGE_CHANGED, '讀不到頁面尺寸');

        /* 選區 / 元素：先讓使用者在頁面上指定範圍 */
        var region = null;
        if (settings.mode === 'region' || settings.mode === 'element') {
          emit({ phase: PROTO.PHASE.PREPARING, message: settings.mode === 'element' ? '請點選要擷取的元素…' : '請拖曳框選範圍…' });
          var picked = await agentCall(tabId, PROTO.MSG.AG_PICK, {
            mode: settings.mode,
            timeoutMs: 180000
          });
          if (!picked || !picked.ok || !picked.result) {
            throw fail(PROTO.ERR.USER_CANCELLED, '沒有選擇範圍');
          }
          region = picked.result.rect;
          if (!region || region.width < 2 || region.height < 2) {
            throw fail(PROTO.ERR.PAGE_CHANGED, '選取範圍太小');
          }
          info = picked.metrics || info;
        }

        var prepared = await agentCall(tabId, PROTO.MSG.AG_PREPARE, {
          hideScrollbars: settings.hideScrollbars,
          showOverlay: settings.showOverlay
        });
        var scrollMode = (prepared && prepared.scrollMode) || 'window';

        var viewportHeight = Math.max(1, info.viewportHeight);
        var viewportWidth = Math.max(1, info.viewportWidth);

        var isRegion = !!region;
        var isViewport = settings.mode === 'viewport';

        /* 可視區域模式的「頁面」就是當前這一屏，不捲動、不預熱、不隱藏固定元素 */
        var pageHeight = isRegion
          ? region.height
          : (isViewport ? viewportHeight : Math.min(info.pageHeight, settings.maxPageHeight));

        if (pageHeight < 1) throw fail(PROTO.ERR.PAGE_CHANGED, '頁面沒有可擷取的內容');

        /* 預熱：先滾到底，再回到頂端，讓懶載入的內容全部就位。
         *
         * 不做這一步的話，頁面在「你滾下去之前」根本不知道自己有多長，
         * 於是畫布是按錯的高度建的，後面只能靠「邊拍邊長高」補救——
         * 補出來的代價是一張長圖被拆成好幾個檔案（part-01、part-02…）。
         * 花一兩秒先走一遍，換到的是一張完整、正確尺寸的圖。 */
        if (!isRegion && !isViewport && settings.mode !== 'manual' && settings.waitForLazy && pageHeight > viewportHeight) {
          emit({ phase: PROTO.PHASE.PREPARING, message: '預先載入頁面內容…' });
          try {
            var warmTarget = pageHeight;
            /* 滾到底 → 觸發新內容 → 頁面長高 → 再滾到「新的」底部……
             * 一路做到高度不再變動為止。
             * 只滾一次是不夠的：滾到舊底部只會補一批內容，補完之後頁面又更長了，
             * 而新的底部還在下面。無限捲動的頁面會把這個循環跑滿上限，
             * 那就停在那裡——至少已經把當下能拿到的都拿到了。 */
            for (var warmRound = 0; warmRound < 8; warmRound++) {
              var warmed = await agentCall(tabId, PROTO.MSG.AG_SCROLL, {
                y: warmTarget,
                delayMs: settings.frameDelayMs,
                lazyExtraWaitMs: settings.lazyExtraWaitMs,
                waitForLazy: true,
                hideFixed: false
              });
              var reached = warmed && warmed.pageHeight ? warmed.pageHeight : warmTarget;
              if (reached <= warmTarget + 4) {
                warmTarget = reached;
                break;
              }
              warmTarget = reached;
              emit({
                phase: PROTO.PHASE.PREPARING,
                message: '預先載入頁面內容… ' + Math.round(warmTarget) + ' px'
              });
            }

            var backToTop = await agentCall(tabId, PROTO.MSG.AG_SCROLL, {
              y: 0,
              delayMs: 60,
              lazyExtraWaitMs: 150,
              waitForLazy: false,
              hideFixed: false
            });
            if (backToTop && backToTop.pageHeight > warmTarget) warmTarget = backToTop.pageHeight;
            pageHeight = Math.min(warmTarget, settings.maxPageHeight);
          } catch (e) {
            /* 預熱失敗不致命，照原本的計劃繼續拍 */
          }
        }

        await offscreenCall(PROTO.MSG.OS_BEGIN, {
          jobId: jobId,
          mode: isRegion ? 'region' : 'full',
          format: settings.format,
          quality: settings.quality,
          viewportWidth: viewportWidth,
          viewportHeight: viewportHeight,
          pageWidth: isRegion ? region.width : info.pageWidth,
          pageHeight: pageHeight,
          regionWidth: region ? region.width : 0,
          regionHeight: region ? region.height : 0,
          pdf: settings.pdf,
          meta: { title: meta.title, url: meta.url, subject: tab.url || '' }
        });

        var isManual = settings.mode === 'manual';
        var heightCap = Math.min(Math.round(info.pageHeight * 1.3 + viewportHeight), settings.maxPageHeight);
        if (isManual) {
          manualState = {
            startedAt: Date.now(),
            idleSince: Date.now(),
            lastY: -1,
            lastCapturedY: -1,
            count: 0,
            intervals: [],
            stoppedBecause: null
          };
          /* 手動模式沒有「第一屏」的概念（使用者可能從中間開始滾），
           * 所以固定元素從一開始就藏起來，不要在每一幀裡重複。 */
          if (settings.hideFixed) {
            try { await agentCall(tabId, PROTO.MSG.AG_HIDE_FIXED, { hidden: true }); } catch (e) { /* 忽略 */ }
          }
          if (settings.showOverlay) {
            try {
              await agentCall(tabId, PROTO.MSG.AG_OVERLAY, {
                progress: 0,
                text: '請慢慢往下滾動頁面，滾完按「完成」',
                canCancel: true,
                canFinish: true
              });
            } catch (e) { /* 忽略 */ }
          }
        }

        emit({
          phase: PROTO.PHASE.CAPTURING,
          message: isManual ? '請慢慢往下滾動頁面…' : '擷取中…'
        });

        /* 非手動模式：整段抓幀期間都把 HUD 收起來。
         *
         * 不採「每幀藏起來→抓→放回來」是因為那是在跟合成器賽跑：
         * DOM 一改就抓，抓到的是舊畫面；等太久又拖慢整個流程，而且 HUD
         * 會不停閃爍。整段收起一次搞定，代價只是抓幀期間頁面上沒有進度條
         * ——進度在工具列徽章上照樣看得到。
         *
         * 手動模式例外：它的 HUD 上有「完成」按鈕，必須留著。 */
        var hudStowed = false;
        if (!isManual && settings.showOverlay && settings.hideOwnOverlay) {
          try {
            await agentCall(tabId, PROTO.MSG.AG_OVERLAY, { hidden: true });
            await sleep(HUD_SETTLE_MS);
            hudStowed = true;
          } catch (e) { /* HUD 收不起來不致命 */ }
        }

        /* 幀序列：整頁用 walker（高度可能變動），選區用固定計劃，
         * 可視區域就是當下這一屏——只有一幀，而且不滾動。 */
        var frames = isRegion
          ? SCROLL.planRegionFrames(region, viewportHeight, info.pageHeight)
          : null;
        var walker = (isRegion || isViewport) ? null : SCROLL.createWalker({
          pageHeight: pageHeight,
          viewportHeight: viewportHeight
        });
        var totalHint = isViewport
          ? 1
          : (frames ? frames.length : Math.max(1, Math.ceil(pageHeight / viewportHeight)));

        var latestHeight = pageHeight;
        var index = 0;
        var guardLimit = isViewport ? 1 : (isRegion ? frames.length + 4 : SCROLL.MAX_FRAMES);

        /* 每一幀「要求滾到哪」與「實際滾到哪」的紀錄。
         * 這條軌跡是判斷整頁截圖有沒有真的滾下去的唯一證據。 */
        var scrollTrace = [];
        var stuckFrames = 0;

        while (index < guardLimit) {
          checkCancelled();

          /* 每一幀都先確認目標分頁還在前台，否則抓到的會是別人的畫面 */
          if (!await ensureActiveTab(tabId)) {
            throw fail(PROTO.ERR.PAGE_CHANGED, '目標分頁已經關閉或被切換走了');
          }

          /* 手動模式完全走自己的節奏：取樣、可能不抓、抓完就送回 offscreen */
          if (isManual) {
            var step = await manualStep(tabId, tab.windowId, settings, viewportHeight, heightCap);
            if (step.done) break;

            if (step.frame) {
              await offscreenCall(PROTO.MSG.OS_FRAME, { dataUrl: step.dataUrl, frame: step.frame });
              index = step.frame.index + 1;

              var covered = manualCoverage();
              var ratio = Math.min(1, covered / Math.max(1, heightCap));
              emit({
                progress: ratio,
                frameIndex: index,
                frameCount: index,
                message: '已捕捉 ' + index + ' 幀 · 覆蓋約 ' + Math.round(ratio * 100) + '%'
              });
              if (settings.showOverlay) {
                try {
                  await agentCall(tabId, PROTO.MSG.AG_OVERLAY, {
                    progress: ratio,
                    text: '請慢慢往下滾 · 已捕捉 ' + index + ' 幀',
                    canCancel: true,
                    canFinish: true
                  });
                } catch (e) { /* HUD 更新失敗不影響擷取 */ }
              }
            }
            await sleep(MANUAL_SAMPLE_MS);
            continue;
          }

          var frame;
          if (isViewport) {
            frame = {
              index: 0,
              y: Math.max(0, Math.round(info.scrollY || 0)),
              clipY: 0,
              clipHeight: viewportHeight,
              coveredBefore: 0,
              coveredAfter: viewportHeight
            };
          } else if (isRegion) {
            frame = frames[index];
            if (!frame) break;
            /* 選區模式沒有「覆蓋」概念，補上 coveredBefore 讓 offscreen 的
             * 兩條繪製路徑共用同一組欄位 */
            frame = {
              index: index,
              y: frame.y,
              clipY: frame.srcY,
              clipHeight: frame.srcH,
              coveredBefore: frame.dstY,
              coveredAfter: frame.dstY + frame.srcH,
              srcY: frame.srcY,
              srcH: frame.srcH,
              dstY: frame.dstY
            };
          } else {
            frame = walker.next(latestHeight);
            if (!frame) break;
          }

          /* 可視區域模式不滾動——它就是「現在畫面上這一屏」 */
          var scrolled = null;
          if (!isViewport) {
            scrolled = await agentCall(tabId, PROTO.MSG.AG_SCROLL, {
              y: frame.y,
              delayMs: settings.frameDelayMs,
              lazyExtraWaitMs: settings.lazyExtraWaitMs,
              waitForLazy: settings.waitForLazy && !isRegion,
              hideFixed: settings.hideFixed && index > 0
            });
          }

          if (scrolled && scrolled.via) {
            var landedOk = scrolled.landedOk !== false;
            if (scrollTrace.length < 60) {
              scrollTrace.push({
                frame: index,
                requested: scrolled.requestedY,
                expected: scrolled.expectedY,
                actual: scrolled.actualY,
                via: scrolled.via,
                ok: landedOk
              });
            }

            if (!landedOk) {
              stuckFrames++;
              /* 連續兩幀要求滾動卻留在原地——這一頁的滾動不是我們能控制的。
               * 再拍下去只會得到一張尺寸正確、內容重複的圖，那比報錯更糟。 */
              if (stuckFrames >= 2) {
                throw fail(
                  PROTO.ERR.PAGE_NOT_SCROLLABLE,
                  '頁面捲不動：要求滾到 ' + scrolled.expectedY + 'px，實際停在 ' + scrolled.actualY +
                  'px（方式：' + scrolled.via + '）。這一頁的捲動可能不是由視窗驅動的，' +
                  '或是內容還沒展開。'
                );
              }
            } else {
              stuckFrames = 0;
            }
          }

          if (!isRegion && scrolled && scrolled.pageHeight > latestHeight) {
            latestHeight = Math.min(scrolled.pageHeight, settings.maxPageHeight);
          }
          if (isRegion && scrolled && scrolled.pageHeight < info.pageHeight) {
            /* 頁面在選區期間變短了，剩下的區段取不到 */
            info.pageHeight = scrolled.pageHeight;
          }

          /* HUD 在進入循環前就整段收起了（見上面 hudStowed），
           * 這裡不必再逐幀切換——那是在跟合成器賽跑，還會閃爍。 */
          var dataUrl = await captureVisible(tab.windowId, settings);
          var frameResult = await offscreenCall(PROTO.MSG.OS_FRAME, { dataUrl: dataUrl, frame: frame });

          /* 用第一幀實測的可用高度校正後續的推進量。
           *
           * 為什麼非做不可：我們量到的視口高（window.innerHeight）不一定等於
           * 瀏覽器真的拍到的高度。模擬裝置指標、混合 DPI、或高度取整時都會
           * 差上一截。照量到的值推進，每一幀都會漏掉那一段內容，而且接縫
           * 處會留下一條白邊——尺寸看起來完全正確，內容卻是殘缺的。
           *
           * 抓到多少就推進多少，才是誠實的做法。 */
          if (!isViewport && !isRegion && index === 0 &&
              frameResult && frameResult.contentHeightPx > 0) {
            var effective = frameResult.contentHeightPx;
            if (Math.abs(effective - viewportHeight) > 2) {
              viewportHeight = Math.max(1, Math.round(effective));
              walker = SCROLL.createWalker({
                pageHeight: pageHeight,
                viewportHeight: viewportHeight,
                covered: Math.round(frameResult.coveredTo || viewportHeight)
              });
              emit({ message: '畫面高度校正為 ' + viewportHeight + ' px' });
            }
          }

          index++;
          var progress = isRegion
            ? index / Math.max(1, totalHint)
            : Math.max(0, Math.min(1, (frame.coveredAfter) / Math.max(1, latestHeight)));

          emit({
            progress: progress,
            frameIndex: index,
            frameCount: index,
            message: '擷取中… ' + Math.round(progress * 100) + '%'
          });

          /* HUD 已經整段收起時就別再更新它了——那只是白白多一次訊息往返，
           * 而畫面上一點變化都看不到。（手動模式沒有收起，照常更新。） */
          if (settings.showOverlay && !hudStowed) {
            try {
              await agentCall(tabId, PROTO.MSG.AG_OVERLAY, {
                progress: progress,
                text: 'SnapScroll 擷取中 ' + Math.round(progress * 100) + '%',
                canCancel: true
              });
            } catch (e) { /* HUD 更新失敗不影響擷取 */ }
          }
        }

        if (index === 0) throw fail(PROTO.ERR.PAGE_CHANGED, '沒有任何畫面被擷取');

        checkCancelled();

        /* 抓幀階段結束：把 HUD 放回來，讓使用者看到「完成」，
         * 然後在收尾時整個移除。 */
        if (hudStowed) {
          try {
            await agentCall(tabId, PROTO.MSG.AG_OVERLAY, {
              hidden: false,
              text: '擷取完成，正在編碼…',
              progress: 1,
              canCancel: false
            });
          } catch (e) { /* 忽略 */ }
        }

        /* 收尾前把 HUD 關掉，免得它被寫進最後一張 */
        if (settings.hideOwnOverlay) {
          try { await agentCall(tabId, PROTO.MSG.AG_OVERLAY, { hide: true }); } catch (e) { /* 忽略 */ }
        }

        emit({ phase: PROTO.PHASE.ENCODING, message: '編碼中…', progress: 1 });

        var finished = await offscreenCall(PROTO.MSG.OS_FINISH, { meta: meta });
        meta.width = finished.outputWidth;
        meta.height = finished.outputHeight;

        emit({ phase: PROTO.PHASE.DOWNLOADING, message: '儲存中…' });

        var files = finished.files || [];
        var total = files.length;
        var downloads = [];
        var ext = finished.kind === 'pdf' ? 'pdf' : settings.format;

        for (var f = 0; f < total; f++) {
          checkCancelled();
          var path = buildDownloadPath(settings, meta, ext, f, total);
          var saved = await H.download({
            url: files[f].url,
            filename: path,
            conflictAction: 'uniquify'
          });
          downloads.push({ index: f, path: path, downloadId: saved.downloadId, filename: saved.filename, bytes: files[f].bytes });
        }

        /* 把「為什麼會是這個結果」講清楚。
         * 這三種情形以前都會安靜地產出一張看起來沒問題、其實不對的圖。 */
        var warnings = [];
        if (!isRegion && pageHeight >= settings.maxPageHeight) {
          warnings.push({
            code: PROTO.ERR.HEIGHT_CAPPED,
            text: '頁高 ' + Math.round(pageHeight) + 'px 撞到「高度上限」' +
              settings.maxPageHeight + 'px，超出的部分沒有被截取。可在設定頁調高。'
          });
        }
        if (!isRegion && index === 1 && pageHeight > viewportHeight * 1.5) {
          warnings.push({
            code: PROTO.ERR.PAGE_NOT_SCROLLABLE,
            text: '整頁模式只拍到一幀，但這一頁有 ' + Math.round(pageHeight) + 'px 高。'
          });
        }
        if (!isRegion && pageHeight <= viewportHeight * 1.05 + 4) {
          warnings.push({
            code: PROTO.ERR.SINGLE_SCREEN,
            text: '這一頁只有一屏高（' + Math.round(pageHeight) + 'px），所以「整頁」與「可視」的結果本來就會一樣。'
          });
        }

        finalResult = {
          ok: true,
          jobId: jobId,
          kind: finished.kind,
          format: ext,
          warnings: warnings,
          diagnostics: {
            scrollMode: scrollMode,
            heightSource: info.heightSource || null,
            heights: info.heights || null,
            pageHeight: Math.round(pageHeight),
            viewportHeight: Math.round(viewportHeight),
            maxPageHeight: settings.maxPageHeight,
            capped: pageHeight >= settings.maxPageHeight,
            singleScreen: pageHeight <= viewportHeight * 1.05 + 4,
            frameCount: index,
            scrollTrace: scrollTrace
          },
          files: downloads,
          blobUrls: files.map(function (x) { return x.url; }),
          thumb: finished.thumb || null,
          outputWidth: finished.outputWidth,
          outputHeight: finished.outputHeight,
          pageCount: finished.pageCount || null,
          tileMode: finished.tileMode || null,
          limits: finished.limits || null,
          downgraded: finished.downgraded || null,
          frames: index,
          meta: meta,
          scrollMode: scrollMode,
          settings: settings
        };

        emit({
          phase: PROTO.PHASE.DONE,
          running: false,
          progress: 1,
          message: total > 1 ? ('已儲存 ' + total + ' 個檔案') : '已儲存'
        });
        return finalResult;

      } catch (err) {
        var code = (err && err.code) || PROTO.ERR.UNKNOWN;
        var cancelled = code === PROTO.ERR.USER_CANCELLED;
        emit({
          phase: cancelled ? PROTO.PHASE.CANCELLED : PROTO.PHASE.FAILED,
          running: false,
          message: (err && err.message) || '擷取失敗'
        });
        err.code = code;
        throw err;
      } finally {
        /* 頁面一定要還原：這是唯一不能省的一步 */
        if (injected) {
          try { await chrome.scripting.removeCSS({ target: { tabId: tabId }, files: ['injected/overlay.css'] }); } catch (e) { /* 可能從未注入成功 */ }
          try { await agentCall(tabId, PROTO.MSG.AG_RESTORE); } catch (e) { /* 頁面可能已經關閉 */ }
        }
        if (!finalResult) {
          /* 沒有產出就沒有 blob 要留，直接收掉 */
          try { await offscreenCall(PROTO.MSG.OS_ABORT, {}); } catch (e) { /* 可能還沒開始 */ }
          await closeOffscreen();
        }
        stopKeepAlive();
      }
    }

    function cancel(reason) {
      if (!state.running) return false;
      cancelRequested = true;
      emit({ message: reason ? String(reason) : '正在取消…' });
      return true;
    }

    /* 「測試滾動」：不改任何設定、不截圖，只回答一個問題——
     * 這個頁面到底能不能被我們控制著捲動？
     *
     * 它走的是和截圖完全相同的捲動程式碼，所以它失敗，整頁截圖就一定會
     * 失敗。比起拍完十幾幀再讓使用者自己發現圖是錯的，這樣快得多。 */
    async function probeScroll(tabId) {
      var tab = await chrome.tabs.get(tabId).catch(function () { return null; });
      if (!tab || tab.id === undefined) throw fail(PROTO.ERR.NO_TAB, '找不到這個分頁');
      if (!isCapturableUrl(tab.url)) {
        throw fail(PROTO.ERR.RESTRICTED_URL, '這個頁面不允許擴充功能存取（瀏覽器內部頁面或本機檔案）');
      }

      await ensureActiveTab(tabId);
      await injectAgent(tabId);

      try {
        var info = await agentCall(tabId, PROTO.MSG.AG_MEASURE);
        var probed = await agentCall(tabId, PROTO.MSG.AG_PROBE_SCROLL, {});
        var viewport = Math.max(1, info.viewportHeight);

        /* 把「滾不動」細分成四種完全不同的情況。
         * 它們以前都被壓成同一句話，等於什麼都沒說。 */
        var verdict = LIMITS.classifyScrollability({
          isPdfViewer: !!info.isPdfViewer,
          depth: probed.expectedBottom,
          canScroll: probed.canScroll,
          viewportHeight: viewport,
          documentHeight: info.heights && info.heights.document,
          bodyHeight: info.heights && info.heights.body,
          innerHeight: info.heights && info.heights.inner,
          offscreenBottom: probed.offscreen && probed.offscreen.maxBottom
        });

        return {
          ok: true,
          verdict: verdict.verdict,
          verdictReason: verdict.reason,
          isPdfViewer: !!info.isPdfViewer,
          contentType: info.contentType || null,
          scrollMode: probed.scrollMode,
          canScroll: probed.canScroll,
          pageHeight: info.pageHeight,
          heightSource: info.heightSource,
          heights: info.heights,
          viewportHeight: info.viewportHeight,
          viewportWidth: info.viewportWidth,
          depth: probed.expectedBottom,
          actualBottom: probed.actualBottom,
          restored: probed.restoredOk,
          estimatedFrames: Math.max(1, Math.ceil(info.pageHeight / viewport)),
          candidates: probed.candidates || null,
          offscreen: probed.offscreen || null,
          readyState: probed.readyState || null
        };
      } finally {
        try { await agentCall(tabId, PROTO.MSG.AG_RESTORE); } catch (e) { /* 忽略 */ }
      }
    }

    /* 手動滾動模式專用：使用者在頁面上按了「完成」 */
    function requestFinish() {
      if (!state.running || !manualState) return false;
      finishRequested = true;
      emit({ message: '收尾中…' });
      return true;
    }

    /* 下載完成後由 service worker 呼叫：釋放 blob URL 與畫布 */
    async function release() {
      try { await offscreenCall(PROTO.MSG.OS_ABORT, {}); } catch (e) { /* 忽略 */ }
      await closeOffscreen();
    }

    return {
      run: run,
      cancel: cancel,
      requestFinish: requestFinish,
      probeScroll: probeScroll,
      release: release,
      snapshot: snapshot,
      isRunning: function () { return state.running; },
      isCapturableUrl: isCapturableUrl,
      MIN_CAPTURE_GAP_MS: MIN_CAPTURE_GAP_MS
    };
  }

  return {
    createController: createController,
    isCapturableUrl: isCapturableUrl,
    MIN_CAPTURE_GAP_MS: MIN_CAPTURE_GAP_MS,
    RESTRICTED_SCHEMES: RESTRICTED_SCHEMES
  };
});
