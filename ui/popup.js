/* SnapScroll — 彈出面板
 *
 * 面板的職責只有兩件：把「這一頁有多大」講清楚，然後把設定送出去。
 * 真正的進度顯示在頁面裡的 HUD 與工具列徽章上——因為使用者一滾動，
 * 這個面板就會失去焦點關掉。
 */
(function () {
  'use strict';

  var PROTO = globalThis.SnapScrollProtocol;
  var SETTINGS = globalThis.SnapScrollSettings;
  var LIMITS = globalThis.SnapScrollLimits;
  var PAGINATE = globalThis.SnapScrollPaginate;
  var I18N = globalThis.SnapScrollI18n;

  var store = SETTINGS.createStore(chrome.storage.local);

  var settings = SETTINGS.normalize({});
  var tab = null;
  var pageInfo = null;
  var running = false;
  var probeResult = null;
  var els = {};

  function $(id) { return document.getElementById(id); }

  function capturable(url) {
    return /^(https?|ftp|data):/i.test(String(url || ''));
  }

  function formatNumber(n) {
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /* ── 量測當前分頁 ───────────────────────────────────────────────── */

  function measureInPage() {
    var de = document.documentElement;
    var body = document.body;
    var documentHeight = de ? de.scrollHeight : 0;
    var bodyHeight = body ? body.scrollHeight : 0;
    var height = Math.max(documentHeight, bodyHeight, de ? de.clientHeight : 0);

    /* 順手確認「這一頁到底是誰在滾」：滾 1px 再立刻復位，肉眼看不到。
     * 這件事的答案直接決定整頁截圖能不能成功——如果視窗滾不動而我們
     * 又沒找到真正的捲動容器，整頁就會變成一屏重複。 */
    var before = Math.round(window.scrollY || 0);
    var range = de ? (de.scrollHeight - de.clientHeight) : 0;
    var mode = 'window';
    var works = true;

    if (range > 8) {
      var target = Math.min(before + 1, range);
      window.scrollTo(0, target);
      var landed = Math.round(window.scrollY || 0);
      window.scrollTo(0, before);
      works = Math.abs(landed - target) <= 1;
      mode = works ? 'window' : 'blocked';
    } else {
      mode = 'inner';
      works = false;
    }

    /* Chrome 內建 PDF 檢視器：內容由外掛繪製，DOM 裡沒有可捲動的東西。
     * 它也需要單獨講，否則使用者只會看到一句沒頭沒腦的失敗。 */
    var isPdf = document.contentType === 'application/pdf' ||
      !!document.querySelector('embed[type="application/pdf"]');

    return {
      pageHeight: Math.round(height),
      documentHeight: Math.round(documentHeight),
      bodyHeight: Math.round(bodyHeight),
      viewportHeight: window.innerHeight | 0,
      viewportWidth: window.innerWidth | 0,
      pageWidth: de ? de.clientWidth : (window.innerWidth | 0),
      scrollMode: mode,
      scrollWorks: works,
      isPdf: isPdf,
      title: document.title || '',
      url: location.href
    };
  }

  async function probeTab() {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs && tabs[0];
    if (!tab) return { state: 'none' };
    if (!capturable(tab.url)) return { state: 'restricted' };

    try {
      var results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: measureInPage
      });
      var info = results && results[0] && results[0].result;
      if (!info) return { state: 'blocked' };
      return { state: 'ok', info: info };
    } catch (e) {
      return { state: 'blocked', error: String((e && e.message) || e) };
    }
  }

  /* ── 渲染 ───────────────────────────────────────────────────────── */

  function renderPage(result) {
    if (result.state === 'ok') {
      pageInfo = result.info;
      els.pageTitle.textContent = pageInfo.title || tab.title || '（無標題）';
      els.pageHost.textContent = pageInfo.url || tab.url || '';

      var screens = pageInfo.viewportHeight > 0
        ? pageInfo.pageHeight / pageInfo.viewportHeight
        : 1;
      var ratio = Math.max(0.04, Math.min(1, 1 / Math.max(1, screens)));
      els.rulerFill.style.width = (ratio * 100).toFixed(2) + '%';
      els.rulerLeft.textContent = '視口 ' + formatNumber(pageInfo.viewportHeight) + ' px';
      els.rulerRight.innerHTML = '整頁 <b>' + formatNumber(pageInfo.pageHeight) + '</b> px · ≈ ' +
        (Math.round(screens * 10) / 10) + ' 屏';
      els.btnCapture.disabled = false;
      renderDiagnostics();
      updateNotice();
      return;
    }

    pageInfo = null;
    els.btnCapture.disabled = true;
    els.rulerFill.style.width = '0%';
    els.rulerLeft.textContent = '—';
    els.rulerRight.textContent = '—';
    renderDiagnostics();

    if (result.state === 'restricted') {
      els.pageTitle.textContent = I18N.t('popup_restricted', '這個頁面無法擷取');
      els.pageHost.textContent = tab ? (tab.url || '') : '';
      showNotice('error', I18N.t('popup_restricted_desc',
        '瀏覽器內部頁面、擴充功能頁面與本機檔案不開放擷取。請切到一般網頁再試。'));
    } else if (result.state === 'blocked') {
      els.pageTitle.textContent = I18N.t('popup_blocked', '無法存取這個頁面');
      els.pageHost.textContent = tab ? (tab.url || '') : '';
      showNotice('error', I18N.t('popup_blocked_desc',
        '頁面拒絕了擴充功能的存取。重新載入頁面後再試一次通常就能解決。'));
    } else {
      els.pageTitle.textContent = '沒有作用中的分頁';
      els.pageHost.textContent = '—';
    }
  }

  /* 診斷列：把兩件以前看不到、但決定成敗的事實擺出來——
   * 「這一頁是誰在滾」以及「高度上限現在是多少」。 */
  function renderDiagnostics() {
    if (!pageInfo) {
      els.diagMode.textContent = '—';
      els.diagCap.textContent = '—';
      els.diagHeights.textContent = '—';
      return;
    }

    /* 三個高度直接攤開：document / body / 視口。
     * 「這一頁有多長」不該是一個要按按鈕才知道的黑盒子。 */
    els.diagHeights.textContent =
      'doc ' + pageInfo.documentHeight + ' · body ' + pageInfo.bodyHeight +
      ' · 視口 ' + pageInfo.viewportHeight;
    els.diagHeights.setAttribute('data-level',
      pageInfo.pageHeight <= pageInfo.viewportHeight + 8 ? 'warn' : '');

    var mode = pageInfo.scrollMode || 'window';
    var works = pageInfo.scrollWorks !== false;
    var singleScreen = pageInfo.pageHeight <= pageInfo.viewportHeight + 8;

    if (pageInfo.isPdf) {
      els.diagMode.textContent = 'PDF 檢視器';
      els.diagMode.setAttribute('data-level', 'warn');
    } else if (singleScreen) {
      /* 這一頁就只有一屏——不是故障，別把它標成紅色嚇人 */
      els.diagMode.textContent = '這一頁只有一屏';
      els.diagMode.setAttribute('data-level', '');
    } else if (mode === 'window') {
      els.diagMode.textContent = works ? 'window · 正常' : 'window · 無法捲動';
      els.diagMode.setAttribute('data-level', works ? 'ok' : 'error');
    } else if (mode === 'inner') {
      els.diagMode.textContent = '內層容器 · 按「測試滾動」確認';
      els.diagMode.setAttribute('data-level', '');
    } else {
      els.diagMode.textContent = mode + ' · 視窗捲動被鎖住';
      els.diagMode.setAttribute('data-level', 'error');
    }

    var capped = pageInfo.pageHeight >= settings.maxPageHeight;
    els.diagCap.textContent = settings.maxPageHeight + ' px' + (capped ? '（已截斷！）' : '');
    els.diagCap.setAttribute('data-level', capped ? 'error' : '');
  }

  /* 剪貼簿在擴充功能頁面裡不一定有權限，用 textarea + execCommand 最保險 */
  function copyToClipboard(text) {
    return new Promise(function (resolve) {
      try {
        var area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.left = '-9999px';
        document.body.appendChild(area);
        area.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(area);
        resolve(!!ok);
      } catch (e) {
        resolve(false);
      }
    });
  }

  /* 五種結論，五種講法。以前它們全都是「滾不動」三個字。 */
  function explainVerdict(res) {
    if (res.verdict === 'pdf-viewer') {
      return '這是 PDF：內容由瀏覽器內建檢視器繪製，不在網頁的 DOM 裡，' +
        '所以擴充功能沒辦法捲動它。最快的做法是按幾下 Ctrl 和減號，把整頁縮進畫面，' +
        '再用「可視」模式截一屏；要清晰的話直接下載這份 PDF——它是向量圖，比截圖清楚。';
    }
    if (res.verdict === 'scrollable') {
      return '可以捲動：0 → ' + res.depth + 'px，約 ' + res.estimatedFrames +
        ' 幀；頁高取自 ' + res.heightSource + '。';
    }
    if (res.verdict === 'blocked') {
      return '這一頁有可捲動的內容，但實際滾不動（要求滾到 ' + res.depth + 'px，實際停在 ' +
        res.actualBottom + 'px）。通常是頁面用自訂腳本接管了捲動，整頁截圖無法進行。';
    }
    if (res.verdict === 'non-native') {
      return '這一頁沒有原生的捲動範圍，但內容確實排在視口底下（最低到 ' +
        (res.offscreen ? res.offscreen.maxBottom : '?') + 'px）：這是 transform / canvas 驅動的捲動，' +
        '原生截圖取不到。建議改用「手動」模式，或以可視模式逐屏截。';
    }
    return '這一頁只有一屏（內容高 ' + res.pageHeight + 'px ≈ 視口高 ' + res.viewportHeight +
      'px），所以「整頁」與「可視」的結果本來就會一樣。' +
      (res.readyState && res.readyState !== 'complete' ? '頁面尚未載入完成，載入後再測一次。' : '');
  }

  function buildDiagnosticText() {
    var lines = [];
    lines.push('=== SnapScroll 診斷 ===');
    lines.push('擴充版本: ' + chrome.runtime.getManifest().version);
    lines.push('時間: ' + new Date().toISOString());
    lines.push('頁面: ' + ((pageInfo && pageInfo.url) || (tab && tab.url) || '-'));
    lines.push('標題: ' + ((pageInfo && pageInfo.title) || (tab && tab.title) || '-'));
    lines.push('裝置像素比: ' + (window.devicePixelRatio || 1));
    lines.push('模式/格式: ' + settings.mode + ' / ' + settings.format);
    lines.push('高度上限: ' + settings.maxPageHeight + ' px');
    if (pageInfo) {
      lines.push('頁高: ' + pageInfo.pageHeight + ' px');
      lines.push('  document.scrollHeight = ' + pageInfo.documentHeight);
      lines.push('  body.scrollHeight     = ' + pageInfo.bodyHeight);
      lines.push('視口: ' + pageInfo.viewportWidth + ' × ' + pageInfo.viewportHeight);
      lines.push('捲動方式: ' + pageInfo.scrollMode + (pageInfo.scrollWorks ? '（正常）' : '（滾不動）'));
      lines.push('預計幀數: ' + Math.max(1, Math.ceil(pageInfo.pageHeight / Math.max(1, pageInfo.viewportHeight))));
    }
    if (probeResult) {
      lines.push('--- 測試滾動 ---');
      lines.push('結論: ' + probeResult.verdict + '（' + probeResult.verdictReason + '）');
      lines.push('捲動方式: ' + probeResult.scrollMode);
      lines.push('可滾動: ' + (probeResult.canScroll ? '是' : '否'));
      lines.push('頁高來源: ' + probeResult.heightSource + ' = ' + probeResult.pageHeight);
      lines.push('來源明細: ' + JSON.stringify(probeResult.heights));
      lines.push('捲動範圍: 0 → ' + probeResult.depth + 'px（實際 ' + probeResult.actualBottom + '）');
      lines.push('復位: ' + (probeResult.restored ? '正常' : '失敗'));
      lines.push('預計幀數: ' + probeResult.estimatedFrames);
      lines.push('頁面載入狀態: ' + (probeResult.readyState || '-'));
      if (probeResult.offscreen) {
        lines.push('視口底下最深內容: ' + probeResult.offscreen.maxBottom + 'px（' +
          probeResult.offscreen.deepCount + ' 個元素超出一屏）');
      }
      if (probeResult.candidates) {
        lines.push('主捲動容器: ' + (probeResult.candidates.accepted || '（找不到）'));
        var rejected = probeResult.candidates.rejected || [];
        if (rejected.length) {
          lines.push('被排除的候選:');
          rejected.forEach(function (c) {
            lines.push('  ' + c.element + ' range=' + c.range + ' overflow-y=' + (c.overflowY || '?') +
              ' → ' + c.reason);
          });
        }
      }
    }
    return lines.join('\n');
  }

  function showNotice(level, text) {
    if (!text) {
      els.notice.hidden = true;
      return;
    }
    els.notice.hidden = false;
    els.notice.setAttribute('data-level', level);
    els.notice.textContent = text;
  }

  /* 依當下格式給出「這一張會多大 / 會被怎麼切」的說明 */
  function updateNotice() {
    if (!pageInfo) return;

    /* 彈出面板與頁面同一個裝置、同一個縮放層級，所以這裡的 devicePixelRatio
     * 足以用來預估輸出像素；真正的比例仍由第一幀量測決定。 */
    var scale = window.devicePixelRatio || 1;
    var outWidth = Math.round(pageInfo.pageWidth * scale);
    var outHeight = Math.round(pageInfo.pageHeight * scale);

    if (settings.format === 'pdf') {
      var plan = PAGINATE.planPages({
        imageWidth: outWidth,
        imageHeight: outHeight,
        paper: settings.pdf.paper,
        orientation: settings.pdf.orientation,
        marginPt: settings.pdf.marginPt,
        mode: settings.pdf.mode,
        keepPageSize: settings.pdf.keepPageSize
      });
      var text = 'PDF：' + plan.paper.label + ' 約 ' + plan.pageCount + ' 頁';
      if (plan.downgraded && plan.downgraded.reason === 'page-too-long') {
        text += '（單頁長圖超出 PDF 的單頁上限，已自動改為分頁）';
      }
      showNotice(plan.pageCount > 1 ? 'info' : 'ok', text);
      return;
    }

    var verdict = LIMITS.describe(outWidth, outHeight, settings.format);
    showNotice(verdict.level === 'ok' ? 'info' : verdict.level, verdict.text);
  }

  function renderSettings() {
    var modeButtons = els.modeGroup.querySelectorAll('[data-mode]');
    for (var i = 0; i < modeButtons.length; i++) {
      modeButtons[i].classList.toggle('is-active', modeButtons[i].getAttribute('data-mode') === settings.mode);
    }
    var formatButtons = els.formatGroup.querySelectorAll('[data-format]');
    for (var j = 0; j < formatButtons.length; j++) {
      formatButtons[j].classList.toggle('is-active', formatButtons[j].getAttribute('data-format') === settings.format);
    }

    els.quality.value = Math.round(settings.quality * 100);
    els.qualityValue.textContent = String(Math.round(settings.quality * 100));
    els.qualityField.style.display = settings.format === 'png' ? 'none' : '';

    els.paper.value = settings.pdf.paper;
    els.orientation.value = settings.pdf.orientation;
    els.margin.value = settings.pdf.marginPt;
    els.marginValue.textContent = settings.pdf.marginPt + ' pt';
    els.delay.value = settings.frameDelayMs;
    els.delayValue.textContent = settings.frameDelayMs + ' ms';
    els.filenameTemplate.value = settings.filenameTemplate;

    setSwitch(els.swHideFixed, settings.hideFixed);
    setSwitch(els.swLazy, settings.waitForLazy);
  }

  function setSwitch(el, on) {
    el.classList.toggle('is-on', !!on);
    el.setAttribute('aria-checked', on ? 'true' : 'false');
  }

  function renderRunning(isRunning, state) {
    running = isRunning;
    els.btnCapture.disabled = false;
    if (isRunning) {
      els.btnCapture.textContent = I18N.t('popup_cancel', '取消擷取');
      els.btnCapture.classList.add('is-danger');
      els.progress.classList.add('is-visible');
      showProgress(state || {});
    } else {
      els.btnCapture.textContent = I18N.t('popup_capture', '開始擷取');
      els.btnCapture.classList.remove('is-danger');
      els.progress.classList.remove('is-visible');
      els.progressFill.style.width = '0%';
    }
  }

  function showProgress(state) {
    var pct = Math.max(0, Math.min(1, state.progress || 0));
    els.progressFill.style.width = (pct * 100).toFixed(1) + '%';
    els.progressText.textContent = state.message
      ? state.message + (state.frameCount ? '（第 ' + state.frameCount + ' 幀）' : '')
      : '準備中…';
  }

  /* ── 設定同步 ───────────────────────────────────────────────────── */

  var saveTimer = null;
  function persist() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      store.save(settings).catch(function () { /* 存不進去也只影響下次預設值 */ });
    }, 220);
  }

  /* ── 事件 ───────────────────────────────────────────────────────── */

  function bindSettingsEvents() {
    els.modeGroup.addEventListener('click', function (ev) {
      var btn = ev.target.closest('[data-mode]');
      if (!btn) return;
      settings.mode = btn.getAttribute('data-mode');
      renderSettings();
      persist();
    });

    els.formatGroup.addEventListener('click', function (ev) {
      var btn = ev.target.closest('[data-format]');
      if (!btn) return;
      settings.format = btn.getAttribute('data-format');
      renderSettings();
      updateNotice();
      persist();
    });

    els.quality.addEventListener('input', function () {
      settings.quality = Number(els.quality.value) / 100;
      els.qualityValue.textContent = els.quality.value;
      persist();
    });

    els.paper.addEventListener('change', function () {
      settings.pdf.paper = els.paper.value;
      updateNotice();
      persist();
    });

    els.orientation.addEventListener('change', function () {
      settings.pdf.orientation = els.orientation.value;
      updateNotice();
      persist();
    });

    els.margin.addEventListener('input', function () {
      settings.pdf.marginPt = Number(els.margin.value);
      els.marginValue.textContent = settings.pdf.marginPt + ' pt';
      updateNotice();
      persist();
    });

    els.delay.addEventListener('input', function () {
      settings.frameDelayMs = Number(els.delay.value);
      els.delayValue.textContent = settings.frameDelayMs + ' ms';
      persist();
    });

    els.filenameTemplate.addEventListener('input', function () {
      settings.filenameTemplate = els.filenameTemplate.value;
      persist();
    });

    els.swHideFixed.addEventListener('click', function () {
      settings.hideFixed = !settings.hideFixed;
      setSwitch(els.swHideFixed, settings.hideFixed);
      persist();
    });

    els.swLazy.addEventListener('click', function () {
      settings.waitForLazy = !settings.waitForLazy;
      setSwitch(els.swLazy, settings.waitForLazy);
      persist();
    });
  }

  async function onCaptureClick() {
    if (running) {
      PROTO.send(PROTO.TO.SW, PROTO.MSG.CANCEL, { reason: '使用者取消' }).catch(function () {});
      els.btnCapture.disabled = true;
      return;
    }
    if (!tab || !pageInfo) return;

    els.btnCapture.disabled = true;
    els.progress.classList.add('is-visible');
    showProgress({ message: '啟動中…', progress: 0 });

    try {
      var res = await PROTO.send(PROTO.TO.SW, PROTO.MSG.START, {
        tabId: tab.id,
        options: settings
      });
      if (res && res.ok === false) {
        showProgressFailure(res.error || '啟動失敗');
        els.btnCapture.disabled = false;
        els.progress.classList.remove('is-visible');
      } else {
        renderRunning(true, { message: '準備中…', progress: 0 });
      }
    } catch (e) {
      showProgressFailure(String((e && e.message) || e));
      els.btnCapture.disabled = false;
      els.progress.classList.remove('is-visible');
    }
  }

  function showProgressFailure(text) {
    showNotice('error', text);
  }

  /* ── 背景廣播 ───────────────────────────────────────────────────── */

  chrome.runtime.onMessage.addListener(function (msg) {
    if (!PROTO.isProtocolMessage(msg) || msg.target !== PROTO.TO.UI) return;

    if (msg.type === PROTO.MSG.PROGRESS) {
      var state = msg.payload || {};
      renderRunning(true, state);
      return;
    }
    if (msg.type === PROTO.MSG.FINISHED) {
      var result = msg.payload || {};
      renderRunning(false);
      var files = result.files || [];
      var warnings = result.warnings || [];

      /* 有話要說的時候，警告優先於「已儲存」——一張存下來但內容不對的圖，
       * 比一個明確的警告糟糕得多。 */
      if (warnings.length) {
        showNotice('warn', warnings.map(function (w) { return w.text; }).join(' '));
        return;
      }

      showNotice('ok', files.length > 1
        ? ('已儲存 ' + files.length + ' 個檔案：' + files.map(function (f) { return f.path; }).join('、'))
        : ('已儲存 ' + (files[0] ? files[0].path : '檔案')));
      return;
    }
    if (msg.type === PROTO.MSG.FAILED) {
      renderRunning(false);
      var failure = msg.payload || {};
      /* 使用者自己按的取消不是「失敗」，不該用紅字嚇人 */
      if (failure.code === PROTO.ERR.USER_CANCELLED) {
        showNotice('info', failure.error || '已取消');
        return;
      }
      showProgressFailure(failure.error || '擷取失敗');
    }
  });

  function the() {
    return '檔案';
  }

  /* ── 啟動 ───────────────────────────────────────────────────────── */

  async function init() {
    els = {
      pageTitle: $('pageTitle'),
      pageHost: $('pageHost'),
      rulerFill: $('rulerFill'),
      rulerLeft: $('rulerLeft'),
      rulerRight: $('rulerRight'),
      modeGroup: $('modeGroup'),
      formatGroup: $('formatGroup'),
      quality: $('quality'),
      qualityValue: $('qualityValue'),
      qualityField: $('qualityField'),
      paper: $('paper'),
      orientation: $('orientation'),
      margin: $('margin'),
      marginValue: $('marginValue'),
      delay: $('delay'),
      delayValue: $('delayValue'),
      filenameTemplate: $('filenameTemplate'),
      swHideFixed: $('swHideFixed'),
      swLazy: $('swLazy'),
      notice: $('notice'),
      progress: $('progress'),
      progressFill: $('progressFill'),
      progressText: $('progressText'),
      btnCapture: $('btnCapture'),
      btnOptions: $('btnOptions'),
      btnHistory: $('btnHistory'),
      diagMode: $('diagMode'),
      diagCap: $('diagCap'),
      diagHeights: $('diagHeights'),
      diagNote: $('diagNote'),
      btnProbe: $('btnProbe'),
      btnDiag: $('btnDiag')
    };

    I18N.apply(document);
    bindSettingsEvents();

    els.btnCapture.addEventListener('click', onCaptureClick);
    els.btnOptions.addEventListener('click', function () {
      PROTO.send(PROTO.TO.SW, PROTO.MSG.OPEN_OPTIONS, {}).catch(function () {
        chrome.runtime.openOptionsPage();
      });
    });
    els.btnHistory.addEventListener('click', function () {
      chrome.tabs.create({ url: chrome.runtime.getURL('ui/result.html') });
    });

    /* 「測試滾動」：真的把頁面滾到底再滾回來，用結果回答
     * 「這個頁面能不能被控制著捲動」。它和截圖走同一套捲動程式碼。 */
    els.btnProbe.addEventListener('click', async function () {
      if (!tab) return;
      els.btnProbe.disabled = true;
      els.diagNote.textContent = '測試中…（頁面會滾到底再回到原位）';

      try {
        var res = await PROTO.send(PROTO.TO.SW, PROTO.MSG.PROBE_SCROLL, { tabId: tab.id });
        if (!res || res.ok === false) {
          els.diagNote.textContent = (res && res.error) || '測試失敗';
          els.diagNote.setAttribute('data-level', 'error');
        } else {
          probeResult = res;
          var labels = {
            scrollable: '可捲動',
            blocked: '有內容但滾不動',
            'non-native': '非原生捲動',
            'no-content': '只有一屏',
            'pdf-viewer': 'PDF 檢視器'
          };
          els.diagMode.textContent = res.scrollMode + ' · ' + (labels[res.verdict] || res.verdict);
          /* PDF 與「只有一屏」都不是故障，不該標成紅色嚇人 */
          var soft = (res.verdict === 'no-content' || res.verdict === 'pdf-viewer');
          els.diagMode.setAttribute('data-level',
            res.verdict === 'scrollable' ? 'ok' : (soft ? 'warn' : 'error'));

          els.diagNote.textContent = explainVerdict(res);
          els.diagNote.setAttribute('data-level',
            res.verdict === 'scrollable' ? 'ok' : (soft ? 'warn' : 'error'));
        }
      } catch (e) {
        els.diagNote.textContent = String((e && e.message) || e);
        els.diagNote.setAttribute('data-level', 'error');
      }
      els.btnProbe.disabled = false;
    });

    els.btnDiag.addEventListener('click', function () {
      var text = buildDiagnosticText();
      copyToClipboard(text).then(function (ok) {
        els.diagNote.textContent = ok
          ? '診斷資訊已複製到剪貼簿。'
          : '複製失敗——請手動選取下方文字。';
        els.diagNote.setAttribute('data-level', ok ? 'ok' : 'error');
        if (!ok) {
          window.prompt('手動複製診斷資訊：', text);
        }
      });
    });

    settings = await store.load();
    renderSettings();

    /* 面板可能是「任務跑到一半」時被重新打開的 */
    try {
      var state = await PROTO.send(PROTO.TO.SW, PROTO.MSG.QUERY_STATE, {});
      if (state && state.ok && state.state && state.state.running) {
        renderRunning(true, state.state);
      }
    } catch (e) { /* 背景還沒醒，無所謂 */ }

    renderPage(await probeTab());
  }

  document.addEventListener('DOMContentLoaded', init);
})();
