/* SnapScroll — 頁面代理（注入到頁面的隔離世界）
 *
 * 這是唯一真正碰得到網頁的那一端。它負責四件事：
 *   1. 量：視口、頁面高、滾動位置、有沒有「內部滾動容器」。
 *   2. 滾：滾到指定位置，然後等到畫面真的穩定（含懶載入撐高頁面）。
 *   3. 整：截圖前把會重複出現的東西收乾淨——fixed/sticky 元素、捲軸、
 *      平滑滾動。每一步都留下還原紀錄，任務結束（含失敗與取消）一定復原。
 *   4. 選：選區與元素拾取。
 *
 * 兩個關鍵細節：
 *   - 隱藏 fixed 元素用 `visibility:hidden` 而不是 `display:none`：
 *     前者不影響佈局，不會在滾動過程中把頁面撐得跳來跳去。
 *   - 這個腳本會被注入到頁面的**隔離世界**，它看得到 DOM，但頁面看不到它。
 *     頁面的 CSP 也管不到它。
 */
(function () {
  'use strict';

  var PROTO = typeof globalThis !== 'undefined' ? globalThis.SnapScrollProtocol : null;
  if (!PROTO) return;
  var SCROLL = typeof globalThis !== 'undefined' ? globalThis.SnapScrollScrollPlan : null;
  var LIMITS = typeof globalThis !== 'undefined' ? globalThis.SnapScrollLimits : null;

  /* 重複注入時直接沿用既有代理：兩個監聽器會讓每一則訊息被處理兩次 */
  if (globalThis.__snapscrollAgent) return;
  var AGENT = { version: 1 };
  globalThis.__snapscrollAgent = AGENT;

  var STYLE_ID = '__snapscroll_style';
  var OVERLAY_ID = '__snapscroll_overlay';
  var PICKER_ID = '__snapscroll_picker';
  var VIS_ATTR = 'data-snapscroll-vis';

  /* 全頁掃描 fixed 元素的成本上限：超過就只掃前面這一批 */
  var MAX_SCAN = 30000;

  var innerScroller = null;
  /* 'window' | 'inner' | 'body' | null（還沒探測過） */
  var scrollMode = null;
  /* 最近一次容器掃描的結果，給診斷用 */
  var lastCandidates = { accepted: null, rejected: [] };
  /* 探測出來的「實際」捲動方式。讀位置、算範圍、下指令全部照它走——
   * 讀 window.scrollY 而實際在滾 body 的話，永遠只會讀到 0。 */
  var activeScrollMode = 'window';
  var fixedEls = [];
  var fixedHidden = false;
  /* 使用者原本停在頁面的哪個位置。截圖會把頁面從頭滾到尾，
   * 結束後當然要還回去——不然每次截完圖都被丟到頁尾。 */
  var savedScrollY = null;
  var styleEl = null;
  var overlayEl = null;
  var pickerSession = null;

  /* ── 基本工具 ───────────────────────────────────────────────────── */

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, Math.max(0, ms | 0)); });
  }

  function nextFrame() {
    return new Promise(function (resolve) { requestAnimationFrame(function () { resolve(); }); });
  }

  function waitFrames(n) {
    var left = Math.max(1, n | 0);
    return new Promise(function (resolve) {
      function tick() {
        left--;
        if (left <= 0) resolve();
        else requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });
  }

  function docHeight() {
    var de = document.documentElement;
    var body = document.body;
    var h = Math.max(
      de ? de.scrollHeight : 0,
      de ? de.offsetHeight : 0,
      de ? de.clientHeight : 0,
      body ? body.scrollHeight : 0,
      body ? body.offsetHeight : 0
    );
    return Math.max(0, Math.round(h));
  }

  function docWidth() {
    var de = document.documentElement;
    var body = document.body;
    return Math.max(
      de ? de.clientWidth : 0,
      body ? body.clientWidth : 0,
      window.innerWidth | 0
    );
  }

  function currentScrollY() {
    if (activeScrollMode === 'inner' && innerScroller) {
      return Math.round(innerScroller.scrollTop);
    }
    if (activeScrollMode === 'body' && document.body) {
      return Math.round(document.body.scrollTop);
    }
    return Math.round(window.scrollY || window.pageYOffset || (document.documentElement ? document.documentElement.scrollTop : 0));
  }

  function maxScrollY() {
    if (activeScrollMode === 'inner' && innerScroller) {
      return Math.max(0, innerScroller.scrollHeight - innerScroller.clientHeight);
    }
    if (activeScrollMode === 'body' && document.body) {
      return Math.max(0, document.body.scrollHeight - document.body.clientHeight);
    }
    return Math.max(0, docHeight() - (window.innerHeight | 0));
  }

  /* ── 內層滾動容器偵測 ────────────────────────────────────────────
   * 有些 SPA 把整頁鎖死，真正會滾的是裡面某個 overflow:auto 的容器。
   * 這時候對 window 下 scrollTo 是完全沒反應的——長截圖會變成一張重複的
   * 首屏。這裡挑「可滾動距離 × 面積」最大的那一個當代表。 */
  function detectInnerScroller(force) {
    var de = document.documentElement;
    var windowScrollable = de ? (de.scrollHeight - de.clientHeight) : 0;

    /* 沒被要求強制掃描時，只有在視窗「看起來」滾不動的時候才去找容器。
     *
     * 但這個判斷不能當真理：`html { overflow: hidden }` 的頁面照樣有很高的
     * scrollHeight，window.scrollTo 卻完全沒反應。所以真正的判斷權交給
     * probeScroller——它會實際滾 1px 來確認，確認失敗就帶著 force 進來掃。 */
    if (!force && windowScrollable > 8) return null;

    var vh = window.innerHeight | 0;
    var vw = window.innerWidth | 0;
    var viewportArea = Math.max(1, vh * vw);
    var candidates = document.querySelectorAll('div, main, section, article, ul, ol');
    var best = null;
    var bestScore = 0;
    var limit = Math.min(candidates.length, MAX_SCAN);
    var rejected = [];

    function reject(el, why, range, overflowY) {
      if (rejected.length >= 12) return;
      rejected.push({
        element: describeElement(el),
        reason: why,
        range: Math.round(range),
        overflowY: overflowY
      });
    }

    for (var i = 0; i < limit; i++) {
      var el = candidates[i];
      if (el.id && el.id.indexOf('__snapscroll') === 0) continue;

      var range = el.scrollHeight - el.clientHeight;
      /* 門檻放寬到「半個視口」。側邊欄、程式碼區塊這類小東西仍然會被
       * 面積條件擋掉，但真正的主滾動區不會因為差幾十像素就被漏掉。 */
      if (range < vh * 0.5) {
        if (range > 200) reject(el, 'range-too-small', range, '');
        continue;
      }

      var cs = getComputedStyle(el);
      var oy = cs.overflowY;
      var isScrollable = (oy === 'auto' || oy === 'scroll');
      /* overflow:hidden 的容器**程序化 scrollTop 依然有效**（modal 打開時的
       * body 就是這個狀態），所以它也該算候選——只是面積門檻更嚴，
       * 免得把頁面上某個被裁切的面板當成主滾動區。 */
      var isClipped = (oy === 'hidden');
      if (!isScrollable && !isClipped) {
        reject(el, 'overflow:' + oy, range, oy);
        continue;
      }

      var rect = el.getBoundingClientRect();
      var area = Math.max(0, rect.width) * Math.max(0, rect.height);
      var minArea = viewportArea * (isClipped ? 0.6 : 0.5);
      if (area < minArea) {
        reject(el, 'area-too-small', range, oy);
        continue;
      }

      var score = range * (area / viewportArea) * (isScrollable ? 1 : 0.8);
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }

    /* 被拒的候選清單純粹是為了診斷：當「找不到主滾動區」時，
     * 這份清單能直接回答「是不是漏掉了某個容器、為什麼漏掉」。 */
    lastCandidates = {
      accepted: best ? describeElement(best) : null,
      rejected: rejected
    };
    return best;
  }

  /* 內容有沒有排在視口底下，卻又完全找不到原生的捲動方式？
   * 這是 transform / canvas 驅動的「假捲動」的特徵——原生截圖路徑
   * 取不到那些內容，必須明講，而不是默默給一張只有一屏的圖。 */
  function detectOffscreenContent() {
    var vh = window.innerHeight | 0;
    var scrollY = window.scrollY || window.pageYOffset || 0;
    var all = document.querySelectorAll('div, main, section, article, ul, ol, table, p, img, h1, h2');
    var limit = Math.min(all.length, MAX_SCAN);
    var maxBottom = 0;
    var deepCount = 0;

    for (var i = 0; i < limit; i++) {
      var el = all[i];
      var id = el.id || '';
      if (id.indexOf('__snapscroll') === 0) continue;

      var rect = el.getBoundingClientRect();
      if (rect.height < 8 || rect.width < 8) continue;

      var bottom = Math.round(rect.bottom + scrollY);
      if (bottom > maxBottom) maxBottom = bottom;
      if (bottom > vh * 1.5) deepCount++;
    }

    return { maxBottom: maxBottom, deepCount: deepCount, viewportHeight: vh };
  }

  /* 正式開拍前，先確認「這個頁面到底是誰在滾」。
   *
   * 作法是實際滾 1 像素再滾回來——比讀 CSS 猜可靠得多。1px 的位移肉眼
   * 看不到，而且立刻復原，對頁面沒有影響。代價是極小，換到的卻是：
   * 不會在一個滾不動的容器上空轉一整個長截圖流程。 */
  function probeScroller() {
    var root = document.documentElement;
    var before = currentScrollY();

    /* 1) window 自己能不能滾 */
    var windowRange = root ? (root.scrollHeight - root.clientHeight) : 0;
    if (windowRange > 8) {
      var target = Math.min(before + 1, windowRange);
      window.scrollTo(0, target);
      var landed = Math.round(window.scrollY || window.pageYOffset || 0);
      window.scrollTo(0, before);
      if (Math.abs(landed - target) <= 1) {
        innerScroller = null;
        activeScrollMode = 'window';
        scrollMode = 'window';
        return scrollMode;
      }
      /* 滾不動。這裡就是 `html { overflow: hidden }` 那類頁面卡住的地方：
       * scrollHeight 明明很高，window.scrollTo 卻是空操作。 */
    }

    /* 2) 找內層容器。到這裡已經證明 window 滾不動了，所以要強制掃描，
     *    不能再用「scrollHeight 很高 ⇒ window 能滾」那個錯誤的前提擋掉。 */
    var candidate = detectInnerScroller(true);
    if (candidate) {
      var savedTop = candidate.scrollTop;
      candidate.scrollTop = savedTop + 1;
      var moved = Math.abs(candidate.scrollTop - (savedTop + 1)) <= 1;
      candidate.scrollTop = savedTop;
      if (moved) {
        innerScroller = candidate;
        activeScrollMode = 'inner';
        scrollMode = 'inner';
        return scrollMode;
      }
    }

    /* 3) 少數頁面是 body 在滾（html 被鎖住、body 自己 overflow:auto） */
    var body = document.body;
    if (body && (body.scrollHeight - body.clientHeight) > 8) {
      var bodyTop = body.scrollTop;
      body.scrollTop = bodyTop + 1;
      var bodyMoved = Math.abs(body.scrollTop - (bodyTop + 1)) <= 1;
      body.scrollTop = bodyTop;
      if (bodyMoved) {
        innerScroller = null;
        activeScrollMode = 'body';
        scrollMode = 'body';
        return scrollMode;
      }
    }

    /* 四種都試過了，都滾不動 */
    innerScroller = null;
    activeScrollMode = 'window';
    scrollMode = 'window';
    return scrollMode;
  }

  /* 這是 Chrome 內建的 PDF 檢視器嗎？
   *
   * PDF 的內容由 PDFium 外掛渲染，**不在 DOM 裡**：外層 document 沒有可捲動
   * 的元素（body.scrollHeight 常常直接是 0），插件本身的捲動也驅動不了。
   * 所以任何基於捲動的截圖方式都拿不到它的第二屏——這不是「滾不動」，
   * 而是另一種東西，必須單獨講，否則使用者只會看到一句莫名其妙的失敗。 */
  function isPdfViewerPage() {
    if (document.contentType === 'application/pdf') return true;
    if (document.querySelector('embed[type="application/pdf"]')) return true;
    /* 備援：body 空得離奇、網址又是 .pdf */
    var emptyBody = document.body ? document.body.scrollHeight : 0;
    var outside = document.documentElement ? document.documentElement.scrollHeight : 0;
    return emptyBody === 0 &&
      outside <= (window.innerHeight | 0) + 8 &&
      /\.pdf($|[?#])/i.test(location.href);
  }

  function measure() {
    /* 探測過就照探測結果走。沒探測過時才用便宜的啟發式判斷：
     * window 自己滾得動，那答案就是 window——不要再去頁面裡找容器；
     * 反過來說，window 完全滾不動（有些 SPA 把 html 鎖死），
     * 才去找那個真正在主導滾動的內層容器。 */
    if (scrollMode === null) {
      var root = document.documentElement;
      var windowScrollable = root ? (root.scrollHeight - root.clientHeight) : 0;
      if (windowScrollable > 8) {
        innerScroller = null;
      } else if (!innerScroller) {
        var detected = detectInnerScroller();
        if (detected) innerScroller = detected;
      }
    }

    var de = document.documentElement;
    var body = document.body;
    var sources = [
      { source: 'document', value: de ? de.scrollHeight : 0 },
      { source: 'body', value: body ? body.scrollHeight : 0 },
      { source: 'inner', value: innerScroller ? innerScroller.scrollHeight : 0 }
    ];

    var picked = LIMITS && LIMITS.pickPageHeight
      ? LIMITS.pickPageHeight(sources)
      : { source: 'document', value: docHeight() };

    return {
      viewportWidth: window.innerWidth | 0,
      viewportHeight: window.innerHeight | 0,
      pageWidth: docWidth(),
      /* 三個來源取最大的——不同網站把滾動交給不同的元素，
       * 只認一個就會在別的頁面上把一整頁量成一小段。 */
      pageHeight: Math.max(picked.value, window.innerHeight | 0),
      heightSource: picked.source,
      heights: {
        document: Math.round(de ? de.scrollHeight : 0),
        body: Math.round(body ? body.scrollHeight : 0),
        inner: Math.round(innerScroller ? innerScroller.scrollHeight : 0),
        viewport: window.innerHeight | 0
      },
      scrollY: currentScrollY(),
      maxScrollY: maxScrollY(),
      dpr: window.devicePixelRatio || 1,
      hasInnerScroller: !!innerScroller,
      title: document.title || '',
      url: location.href,
      contentType: document.contentType || '',
      isPdfViewer: isPdfViewerPage(),
      readyState: document.readyState,
      /* 有些頁面在視覺上不會滾，但內容一樣高——回報讓 SW 決定要不要繼續 */
      scrollable: maxScrollY() > 8
    };
  }

  /* ── 注入樣式 ───────────────────────────────────────────────────── */

  function applyStyle(opts) {
    var o = opts || {};
    if (!styleEl) {
      styleEl = document.getElementById(STYLE_ID);
    }
    var css = '';
    if (o.hideScrollbars !== false) {
      css += '::-webkit-scrollbar{display:none !important;width:0 !important;height:0 !important}';
      css += '::-webkit-scrollbar-thumb,::-webkit-scrollbar-track{display:none !important}';
      css += 'html{scrollbar-width:none !important;overflow:-moz-scrollbars-none !important}';
    }
    /* 平滑滾動會讓「滾到底再截」拍到滾動中的畫面 */
    css += 'html,body,*{scroll-behavior:auto !important}';
    css += '@media (prefers-reduced-motion: reduce){*{animation:none !important}}';
    if (o.ownOverlayHidden) {
      css += '#' + OVERLAY_ID + ',#' + PICKER_ID + '{visibility:hidden !important}';
    }

    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = STYLE_ID;
      styleEl.setAttribute('type', 'text/css');
      (document.head || document.documentElement).appendChild(styleEl);
    }
    styleEl.textContent = css;
  }

  function removeStyle() {
    if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
    styleEl = null;
  }

  /* ── 固定元素 ─────────────────────────────────────────────────── */

  function collectFixed() {
    var els = [];
    if (!document.body) return els;
    var all = document.querySelectorAll('*');
    var limit = Math.min(all.length, MAX_SCAN);
    for (var i = 0; i < limit; i++) {
      var el = all[i];
      var id = el.id || '';
      if (id.indexOf('__snapscroll') === 0) continue;
      if (el.tagName === 'HTML' || el.tagName === 'BODY') continue;
      var pos = getComputedStyle(el).position;
      if (pos === 'fixed' || pos === 'sticky') els.push(el);
    }
    return els;
  }

  function hideFixed() {
    if (fixedHidden) return fixedEls.length;
    if (!fixedEls.length) fixedEls = collectFixed();
    for (var i = 0; i < fixedEls.length; i++) {
      var el = fixedEls[i];
      try {
        el.setAttribute(VIS_ATTR, el.style.visibility || '');
        el.style.setProperty('visibility', 'hidden', 'important');
      } catch (e) { /* 某些元素不給改樣式，跳過 */ }
    }
    fixedHidden = true;
    return fixedEls.length;
  }

  function showFixed() {
    if (!fixedHidden) return;
    for (var i = 0; i < fixedEls.length; i++) {
      var el = fixedEls[i];
      try {
        var prev = el.getAttribute(VIS_ATTR);
        if (prev) el.style.setProperty('visibility', prev, 'important');
        else el.style.removeProperty('visibility');
        el.removeAttribute(VIS_ATTR);
      } catch (e) { /* 元素可能已經被頁面移除 */ }
    }
    fixedHidden = false;
  }

  /* ── 頁面內 HUD ───────────────────────────────────────────────── */

  function ensureOverlay() {
    if (overlayEl && overlayEl.isConnected) return overlayEl;
    overlayEl = document.getElementById(OVERLAY_ID);
    if (overlayEl) return overlayEl;

    overlayEl = document.createElement('div');
    overlayEl.id = OVERLAY_ID;
    overlayEl.setAttribute('data-snapscroll-ui', '1');
    overlayEl.innerHTML =
      '<div class="ss-row">' +
      '  <span class="ss-dot"></span>' +
      '  <span class="ss-text" data-role="text">準備中…</span>' +
      '  <span class="ss-bar"><i data-role="bar"></i></span>' +
      '  <button type="button" class="ss-done" data-role="done" hidden>完成</button>' +
      '  <button type="button" class="ss-cancel" data-role="cancel">取消</button>' +
      '</div>';
    (document.body || document.documentElement).appendChild(overlayEl);

    function notify(type) {
      return function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        try {
          chrome.runtime.sendMessage(PROTO.envelope(PROTO.TO.SW, type, { from: 'page' }));
        } catch (e) { /* 擴充可能已經卸載 */ }
      };
    }

    overlayEl.querySelector('[data-role="cancel"]').addEventListener('click', notify(PROTO.MSG.CANCEL));
    overlayEl.querySelector('[data-role="done"]').addEventListener('click', notify(PROTO.MSG.FINISH_MANUAL));
    return overlayEl;
  }

  function updateOverlay(payload) {
    var p = payload || {};
    if (p.hide) {
      if (overlayEl && overlayEl.parentNode) overlayEl.parentNode.removeChild(overlayEl);
      overlayEl = null;
      return;
    }
    /* HUD 本身也是一個 position:fixed 的元素，會被拍進圖裡。
     * 所以抓幀的那一瞬間必須把它藏起來（用 visibility 而不是 display，
     * 免得它的出現與消失讓頁面重新排版）。 */
    if (p.hidden !== undefined) {
      if (p.hidden) {
        if (!overlayEl) return;
        overlayEl.style.setProperty('visibility', 'hidden', 'important');
      } else if (overlayEl) {
        overlayEl.style.removeProperty('visibility');
      }
      return;
    }

    var el = ensureOverlay();
    var text = el.querySelector('[data-role="text"]');
    var bar = el.querySelector('[data-role="bar"]');
    var cancel = el.querySelector('[data-role="cancel"]');
    var done = el.querySelector('[data-role="done"]');
    if (text) text.textContent = p.text || '擷取中…';
    if (bar) bar.style.width = Math.max(0, Math.min(1, Number(p.progress) || 0)) * 100 + '%';
    if (cancel) cancel.style.display = p.canCancel === false ? 'none' : '';
    if (done) done.hidden = !p.canFinish;
    if (p.state) el.setAttribute('data-state', String(p.state));
  }

  function removeOverlay() {
    if (overlayEl && overlayEl.parentNode) overlayEl.parentNode.removeChild(overlayEl);
    overlayEl = null;
  }

  /* ── 捲動與穩定 ───────────────────────────────────────────────── */

  /* 捲動，而且**事後驗證真的滾動了**。
   * 這個驗證不是多餘的：有些「可滾動容器」其實被 CSS 鎖住或又被上層蓋掉，
   * 設了 scrollTop 卻不動。此時如果默默繼續，整張長圖就會是同一屏重複。
   * 所以滾不動就立刻換下一種方式，並且把不可用的容器丟掉。 */
  function scrollTo(y) {
    var target = Math.max(0, Math.round(y));

    if (activeScrollMode === 'inner' && innerScroller) {
      innerScroller.scrollTop = target;
      return 'inner';
    }
    if (activeScrollMode === 'body' && document.body) {
      document.body.scrollTop = target;
      return 'body';
    }
    window.scrollTo(0, target);
    return 'window';
  }

  /* 等到「畫面真的定下來」：
   * 滾動後至少兩個 rAF，然後在基礎延遲內持續觀察頁面高度，
   * 一旦又長高（懶載入補上內容）就把截止時間往後延。 */
  function settle(opts) {
    var o = opts || {};
    var base = Math.max(0, o.delayMs | 0);
    var extra = Math.max(0, o.lazyExtraWaitMs | 0);
    var watchLazy = o.waitForLazy !== false;

    return waitFrames(2).then(function () {
      var deadline = Date.now() + base + (watchLazy ? extra : 0);
      var lastHeight = docHeight();

      function loop() {
        return sleep(50).then(function () {
          if (!watchLazy) {
            if (Date.now() >= deadline) return waitFrames(2);
            return loop();
          }
          var h = docHeight();
          if (h !== lastHeight) {
            lastHeight = h;
            /* 又長高了：再多給它一點時間，但別無限等下去 */
            deadline = Math.max(deadline, Date.now() + Math.min(600, extra || 200));
          }
          if (Date.now() >= deadline) return waitFrames(2);
          return loop();
        });
      }
      return loop();
    });
  }

  /* ── 選區 / 元素拾取 ──────────────────────────────────────────── */

  function rectOf(el) {
    var r = el.getBoundingClientRect();
    var sx = window.scrollX || window.pageXOffset || 0;
    var sy = window.scrollY || window.pageYOffset || 0;
    return {
      x: Math.round(r.left + sx),
      y: Math.round(r.top + sy),
      width: Math.round(r.width),
      height: Math.round(r.height)
    };
  }

  function describeElement(el) {
    if (!el || !el.tagName) return '';
    var tag = el.tagName.toLowerCase();
    var id = el.id ? '#' + el.id : '';
    var cls = '';
    if (el.className && typeof el.className === 'string') {
      cls = '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
    }
    return tag + id + cls;
  }

  function endPick(result) {
    if (!pickerSession) return;
    var s = pickerSession;
    pickerSession = null;
    if (s.timer) clearTimeout(s.timer);
    if (s.cleanup) s.cleanup();
    if (s.resolve) s.resolve(result);
  }

  function runPicker(mode, timeoutMs) {
    if (pickerSession) endPick(null);

    return new Promise(function (resolve) {
      var root = document.createElement('div');
      root.id = PICKER_ID;
      root.setAttribute('data-snapscroll-ui', '1');
      root.className = mode === 'element' ? 'ss-picker ss-picker-element' : 'ss-picker';
      root.innerHTML =
        '<div class="ss-picker-hint">' +
        (mode === 'element'
          ? '滑鼠移到要擷取的元素上，點一下確認 · Esc 取消'
          : '拖曳框選要擷取的範圍 · Esc 取消') +
        '</div>' +
        '<div class="ss-picker-box" data-role="box"></div>' +
        '<div class="ss-picker-size" data-role="size"></div>';
      (document.body || document.documentElement).appendChild(root);

      var box = root.querySelector('[data-role="box"]');
      var size = root.querySelector('[data-role="size"]');
      var hover = null;
      var dragging = false;
      var start = null;
      var current = null;

      function paintRect(rect) {
        if (!rect || rect.width <= 0 || rect.height <= 0) {
          box.style.display = 'none';
          size.style.display = 'none';
          return;
        }
        var sy = window.scrollY || window.pageYOffset || 0;
        var sx = window.scrollX || window.pageXOffset || 0;
        box.style.display = 'block';
        box.style.left = (rect.x - sx) + 'px';
        box.style.top = (rect.y - sy) + 'px';
        box.style.width = rect.width + 'px';
        box.style.height = rect.height + 'px';
        size.style.display = 'block';
        size.textContent = rect.width + ' × ' + rect.height;
        size.style.left = (rect.x - sx) + 'px';
        size.style.top = Math.max(0, rect.y - sy - 22) + 'px';
      }

      function onMove(ev) {
        if (mode === 'element') {
          var el = document.elementFromPoint(ev.clientX, ev.clientY);
          if (el && (el.id === PICKER_ID || (el.closest && el.closest('#' + PICKER_ID)))) return;
          if (!el || el === hover) return;
          hover = el;
          paintRect(rectOf(el));
          return;
        }
        if (!dragging || !start) return;
        var sx = window.scrollX || window.pageXOffset || 0;
        var sy = window.scrollY || window.pageYOffset || 0;
        var a = { x: start.x + sx, y: start.y + sy };
        var b = { x: ev.clientX + sx, y: ev.clientY + sy };
        var rect = {
          x: Math.min(a.x, b.x),
          y: Math.min(a.y, b.y),
          width: Math.abs(b.x - a.x),
          height: Math.abs(b.y - a.y)
        };
        current = rect;
        paintRect(rect);
      }

      function onDown(ev) {
        if (mode === 'element') return;
        dragging = true;
        start = { x: ev.clientX, y: ev.clientY };
        ev.preventDefault();
      }

      function onUp(ev) {
        if (mode === 'element') {
          var el = document.elementFromPoint(ev.clientX, ev.clientY);
          if (!el || (el.closest && el.closest('#' + PICKER_ID))) return;
          endPick({ mode: 'element', rect: rectOf(el), selector: describeElement(el), label: describeElement(el) });
          return;
        }
        dragging = false;
        if (current && current.width > 2 && current.height > 2) {
          endPick({ mode: 'region', rect: current, label: current.width + '×' + current.height });
        }
      }

      function onKey(ev) {
        if (ev.key === 'Escape') {
          ev.preventDefault();
          endPick(null);
        }
      }

      function onScroll() {
        if (mode === 'element' && hover) paintRect(rectOf(hover));
      }

      var cleanup = function () {
        window.removeEventListener('mousemove', onMove, true);
        window.removeEventListener('mousedown', onDown, true);
        window.removeEventListener('mouseup', onUp, true);
        window.removeEventListener('keydown', onKey, true);
        window.removeEventListener('scroll', onScroll, true);
        if (root.parentNode) root.parentNode.removeChild(root);
      };

      pickerSession = { resolve: resolve, cleanup: cleanup, timer: null };
      if (timeoutMs > 0) {
        pickerSession.timer = setTimeout(function () { endPick(null); }, timeoutMs);
      }

      window.addEventListener('mousemove', onMove, true);
      window.addEventListener('mousedown', onDown, true);
      window.addEventListener('mouseup', onUp, true);
      window.addEventListener('keydown', onKey, true);
      window.addEventListener('scroll', onScroll, true);
    });
  }

  /* ── 還原 ─────────────────────────────────────────────────────── */

  function restoreAll() {
    endPick(null);
    showFixed();
    fixedEls = [];
    removeOverlay();
    removeStyle();
    if (savedScrollY != null) {
      scrollTo(savedScrollY);
      savedScrollY = null;
    }
    innerScroller = null;
    scrollMode = null;
    activeScrollMode = 'window';
    return true;
  }

  /* ── 訊息處理 ─────────────────────────────────────────────────── */

  function handle(type, payload) {
    var p = payload || {};
    switch (type) {
      case PROTO.MSG.AG_PING:
        return { ready: true, version: AGENT.version };

      case PROTO.MSG.AG_MEASURE:
        return measure();

      case PROTO.MSG.AG_PREPARE:
        measure();
        var probed = probeScroller();
        savedScrollY = currentScrollY();
        applyStyle({
          hideScrollbars: p.hideScrollbars !== false,
          ownOverlayHidden: false
        });
        fixedEls = collectFixed();
        if (p.showOverlay) updateOverlay({ text: '準備中…', progress: 0, canCancel: true });
        return {
          ok: true,
          fixedCount: fixedEls.length,
          hasInnerScroller: !!innerScroller,
          scrollMode: probed
        };

      case PROTO.MSG.AG_SCROLL: {
        var targetY = Math.max(0, Math.round(p.y || 0));
        if (p.hideFixed) hideFixed(); else showFixed();
        var via = scrollTo(targetY);
        return settle({
          delayMs: p.delayMs,
          lazyExtraWaitMs: p.lazyExtraWaitMs,
          waitForLazy: p.waitForLazy
        }).then(function () {
          var m = measure();
          var expected = Math.min(targetY, maxScrollY());
          /* 把「要求滾到哪 / 實際上滾到哪」一起回報。
           * 上層靠這個判斷整頁截圖到底有沒有真的滾下去。 */
          m.requestedY = targetY;
          m.expectedY = expected;
          m.actualY = m.scrollY;
          m.via = via;
          m.landedOk = SCROLL && SCROLL.isScrollSettled
            ? SCROLL.isScrollSettled(expected, m.actualY)
            : Math.abs(m.actualY - expected) <= 4;
          return m;
        });
      }

      /* 「測試滾動」：真的滾到底再滾回原位，用結果回答
       * 「這個頁面到底能不能被控制」。與截圖走同一套滾動程式碼，
       * 所以它失敗，截圖就一定會失敗。 */
      case PROTO.MSG.AG_PROBE_SCROLL:
        return (async function () {
          var mode = probeScroller();
          var before = currentScrollY();
          var depth = maxScrollY();

          scrollTo(depth);
          await waitFrames(2);
          var landedBottom = currentScrollY();

          scrollTo(before);
          await waitFrames(2);
          var restored = currentScrollY();

          var m = measure();
          var canScroll = depth > 8 &&
            (SCROLL && SCROLL.isScrollSettled
              ? SCROLL.isScrollSettled(depth, landedBottom)
              : Math.abs(landedBottom - depth) <= 4);

          var offscreen = detectOffscreenContent();

          return {
            ok: true,
            scrollMode: mode,
            canScroll: canScroll,
            from: before,
            expectedBottom: depth,
            actualBottom: landedBottom,
            restored: restored,
            restoredOk: Math.abs(restored - before) <= 4,
            candidates: lastCandidates,
            offscreen: offscreen,
            readyState: document.readyState,
            metrics: m
          };
        })();

      case PROTO.MSG.AG_HIDE_FIXED:
        if (p.hidden) hideFixed(); else showFixed();
        return { ok: true, hidden: fixedHidden, count: fixedEls.length };

      case PROTO.MSG.AG_OVERLAY:
        updateOverlay(p);
        /* 切換可見性之後要等合成器真的提交這一幀。
         * `captureVisibleTab` 抓的是合成結果，不是 DOM——DOM 改完就立刻抓，
         * 抓到的會是上一版畫面，HUD 就這樣被拍進圖裡（而且只在競態輸掉時
         * 偶爾發生，最難查）。兩個 rAF 之後再回，上層才動手。 */
        if (p.hidden !== undefined) {
          return waitFrames(2).then(function () { return { ok: true }; });
        }
        return { ok: true };

      case PROTO.MSG.AG_PICK:
        return runPicker(p.mode || 'region', p.timeoutMs || 120000).then(function (result) {
          /* 取消「不」回報成 ok:false。上層會把 ok:false 當成失敗並顯示
           * 「頁面操作失敗」，那對「使用者按了 Esc」來說是錯的說法。 */
          if (!result) return { cancelled: true };
          return { ok: true, result: result, metrics: measure() };
        });

      case PROTO.MSG.AG_RESTORE:
        restoreAll();
        return { ok: true };

      default:
        return { ok: false, error: 'unknown-action:' + type };
    }
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!PROTO.isFor(msg, PROTO.TO.AGENT)) return false;
    var out;
    try {
      out = handle(msg.type, msg.payload);
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
      return false;
    }
    if (out && typeof out.then === 'function') {
      out.then(
        function (value) { sendResponse({ ok: true, data: value }); },
        function (err) { sendResponse({ ok: false, error: String((err && err.message) || err) }); }
      );
      return true;
    }
    sendResponse({ ok: true, data: out });
    return false;
  });

  /* 頁面被卸載時盡量收乾淨，避免樣式殘留到下一次載入的快取快照 */
  window.addEventListener('pagehide', function () {
    try { restoreAll(); } catch (e) { /* 忽略 */ }
  });

  AGENT.measure = measure;
  AGENT.restoreAll = restoreAll;
})();
