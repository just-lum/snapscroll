/* SnapScroll — 設定頁
 *
 * 沒有「儲存」按鈕：每一個控制項改動後就寫回 storage.local。
 * 設定頁不該讓人擔心「我剛剛改了到底存了沒」。
 */
(function () {
  'use strict';

  var SETTINGS = globalThis.SnapScrollSettings;
  var FILENAME = globalThis.SnapScrollFilename;
  var HISTORY = globalThis.SnapScrollHistory;
  var I18N = globalThis.SnapScrollI18n;

  var store = SETTINGS.createStore(chrome.storage.local);
  var history = HISTORY.createHistory({});
  var settings = SETTINGS.normalize({});
  var els = {};

  function $(id) { return document.getElementById(id); }

  function setSwitch(el, on) {
    el.classList.toggle('is-on', !!on);
    el.setAttribute('aria-checked', on ? 'true' : 'false');
  }

  var statusTimer = null;
  function flash(text) {
    els.status.textContent = text;
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(function () {
      els.status.textContent = I18N.t('options_autosave', '設定會自動儲存');
    }, 1400);
  }

  var saveTimer = null;
  function persist(silent) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      store.save(settings).then(function () {
        if (!silent) flash(I18N.t('options_saved', '已儲存'));
      }).catch(function (e) {
        els.status.textContent = '儲存失敗：' + String((e && e.message) || e);
      });
    }, 180);
  }

  function renderFilenamePreview() {
    var preview = FILENAME.buildPath({
      template: settings.filenameTemplate,
      ctx: {
        title: '安裝指南 · Getting Started',
        url: 'https://docs.example.com/guide/start',
        host: FILENAME.hostOf('https://docs.example.com/guide/start'),
        mode: settings.mode,
        format: settings.format,
        now: new Date()
      },
      ext: settings.format === 'pdf' ? 'pdf' : settings.format,
      folder: settings.folder
    });
    els.filenamePreview.value = preview;
  }

  function render() {
    els.mode.value = settings.mode;
    els.format.value = settings.format;

    els.quality.value = Math.round(settings.quality * 100);
    els.qualityValue.textContent = String(Math.round(settings.quality * 100));

    els.frameDelay.value = settings.frameDelayMs;
    els.frameDelayValue.textContent = settings.frameDelayMs + ' ms';

    els.startDelay.value = settings.startDelayMs;
    els.startDelayValue.textContent = settings.startDelayMs + ' ms';

    els.maxPageHeight.value = settings.maxPageHeight;

    setSwitch(els.swHideFixed, settings.hideFixed);
    setSwitch(els.swHideScrollbars, settings.hideScrollbars);
    setSwitch(els.swLazy, settings.waitForLazy);
    setSwitch(els.swOverlay, settings.showOverlay);
    setSwitch(els.swOpenResult, settings.openResultPage);

    els.paper.value = settings.pdf.paper;
    els.orientation.value = settings.pdf.orientation;
    els.pdfMode.value = settings.pdf.mode;
    els.marginPt.value = settings.pdf.marginPt;

    els.filenameTemplate.value = settings.filenameTemplate;
    els.folder.value = settings.folder;

    els.captureFormat.value = settings.captureFormat;
    els.retryLimit.value = settings.retryLimit;
    els.keepHistory.value = settings.keepHistory;

    renderFilenamePreview();
  }

  function bind() {
    els.mode.addEventListener('change', function () {
      settings.mode = els.mode.value;
      renderFilenamePreview();
      persist();
    });

    els.format.addEventListener('change', function () {
      settings.format = els.format.value;
      renderFilenamePreview();
      persist();
    });

    els.quality.addEventListener('input', function () {
      settings.quality = Number(els.quality.value) / 100;
      els.qualityValue.textContent = els.quality.value;
      persist(true);
    });
    els.quality.addEventListener('change', function () { persist(); });

    els.frameDelay.addEventListener('input', function () {
      settings.frameDelayMs = Number(els.frameDelay.value);
      els.frameDelayValue.textContent = settings.frameDelayMs + ' ms';
      persist(true);
    });

    els.startDelay.addEventListener('input', function () {
      settings.startDelayMs = Number(els.startDelay.value);
      els.startDelayValue.textContent = settings.startDelayMs + ' ms';
      persist(true);
    });

    els.maxPageHeight.addEventListener('change', function () {
      settings.maxPageHeight = Number(els.maxPageHeight.value);
      persist();
    });

    els.paper.addEventListener('change', function () {
      settings.pdf.paper = els.paper.value;
      persist();
    });

    els.orientation.addEventListener('change', function () {
      settings.pdf.orientation = els.orientation.value;
      persist();
    });

    els.pdfMode.addEventListener('change', function () {
      settings.pdf.mode = els.pdfMode.value;
      persist();
    });

    els.marginPt.addEventListener('change', function () {
      settings.pdf.marginPt = Number(els.marginPt.value);
      persist();
    });

    els.filenameTemplate.addEventListener('input', function () {
      settings.filenameTemplate = els.filenameTemplate.value;
      renderFilenamePreview();
      persist(true);
    });

    els.folder.addEventListener('input', function () {
      settings.folder = els.folder.value;
      renderFilenamePreview();
      persist(true);
    });

    els.captureFormat.addEventListener('change', function () {
      settings.captureFormat = els.captureFormat.value;
      persist();
    });

    els.retryLimit.addEventListener('change', function () {
      settings.retryLimit = Number(els.retryLimit.value);
      persist();
    });

    els.keepHistory.addEventListener('change', function () {
      settings.keepHistory = Number(els.keepHistory.value);
      history.prune(settings.keepHistory).then(refreshHistoryInfo).catch(function () {});
      persist();
    });

    var switches = [
      ['swHideFixed', 'hideFixed'],
      ['swHideScrollbars', 'hideScrollbars'],
      ['swLazy', 'waitForLazy'],
      ['swOverlay', 'showOverlay'],
      ['swOpenResult', 'openResultPage']
    ];
    switches.forEach(function (pair) {
      els[pair[0]].addEventListener('click', function () {
        settings[pair[1]] = !settings[pair[1]];
        setSwitch(els[pair[0]], settings[pair[1]]);
        persist();
      });
    });

    els.btnReset.addEventListener('click', function () {
      settings = SETTINGS.normalize(SETTINGS.DEFAULTS);
      render();
      store.save(settings).then(function () { flash('已恢復預設值'); });
    });

    els.btnHistory.addEventListener('click', function () {
      chrome.tabs.create({ url: chrome.runtime.getURL('ui/result.html') });
    });

    els.btnClearHistory.addEventListener('click', function () {
      history.clear().then(function () {
        refreshHistoryInfo();
        flash('已清空歷史紀錄');
      });
    });
  }

  function refreshHistoryInfo() {
    return history.list(0).then(function (items) {
      var bytes = items.reduce(function (n, it) { return n + (it.bytes || 0); }, 0);
      els.historyInfo.textContent = items.length
        ? (items.length + ' 筆 · ' + globalThis.SnapScrollLimits.formatBytes(bytes))
        : '目前沒有紀錄';
    }).catch(function () {
      els.historyInfo.textContent = '讀取失敗';
    });
  }

  async function init() {
    els = {
      mode: $('mode'),
      format: $('format'),
      quality: $('quality'),
      qualityValue: $('qualityValue'),
      frameDelay: $('frameDelay'),
      frameDelayValue: $('frameDelayValue'),
      startDelay: $('startDelay'),
      startDelayValue: $('startDelayValue'),
      maxPageHeight: $('maxPageHeight'),
      swHideFixed: $('swHideFixed'),
      swHideScrollbars: $('swHideScrollbars'),
      swLazy: $('swLazy'),
      swOverlay: $('swOverlay'),
      swOpenResult: $('swOpenResult'),
      paper: $('paper'),
      orientation: $('orientation'),
      pdfMode: $('pdfMode'),
      marginPt: $('marginPt'),
      filenameTemplate: $('filenameTemplate'),
      folder: $('folder'),
      filenamePreview: $('filenamePreview'),
      captureFormat: $('captureFormat'),
      retryLimit: $('retryLimit'),
      keepHistory: $('keepHistory'),
      historyInfo: $('historyInfo'),
      btnReset: $('btnReset'),
      btnHistory: $('btnHistory'),
      btnClearHistory: $('btnClearHistory'),
      status: $('status')
    };

    I18N.apply(document);
    bind();

    settings = await store.load();
    render();
    refreshHistoryInfo();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
