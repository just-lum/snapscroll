/* SnapScroll — 結果頁
 *
 * 兩種視圖共用一個頁面：
 *   ?id=xxx  → 單次擷取的詳情（預覽、裁剪、換格式另存、刪除）
 *   無參數    → 歷史列表
 *
 * 圖片本身存在 IndexedDB 裡，這裡只是把它讀出來變成 blob URL 顯示。
 * 用完一定要 revoke，否則開十次歷史就會多留十份記憶體。
 */
(function () {
  'use strict';

  var HISTORY = globalThis.SnapScrollHistory;
  var LIMITS = globalThis.SnapScrollLimits;
  var I18N = globalThis.SnapScrollI18n;

  var history = HISTORY.createHistory({});
  var els = {};
  var currentUrl = null;
  var cropState = null;

  function $(id) { return document.getElementById(id); }

  function p2(n) { return (n < 10 ? '0' : '') + n; }

  function fmtTime(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) +
      ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  }

  function releaseUrl() {
    if (currentUrl) {
      try { URL.revokeObjectURL(currentUrl); } catch (e) { /* 已釋放 */ }
      currentUrl = null;
    }
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.indexOf('on') === 0) node.addEventListener(k.slice(2), attrs[k]);
        else node.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (child) {
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  /* ── 清單視圖 ───────────────────────────────────────────────────── */

  function renderList() {
    releaseUrl();
    els.pageTitle.textContent = I18N.t('result_history', '歷史紀錄');
    els.pageSubtitle.textContent = I18N.t('result_history_sub', '最近擷取的長截圖都留在這台電腦上。');
    els.headActions.innerHTML = '';
    els.headActions.appendChild(el('button', {
      class: 'btn-ghost',
      text: I18N.t('result_clear', '清空全部'),
      onclick: function () {
        if (!confirm(I18N.t('result_clear_confirm', '確定要清空所有歷史紀錄？'))) return;
        history.clear().then(renderList);
      }
    }));

    history.list(0).then(function (items) {
      els.content.innerHTML = '';
      if (!items.length) {
        els.content.appendChild(el('div', {
          class: 'empty',
          text: I18N.t('result_empty', '還沒有任何紀錄。回到網頁上按一下 SnapScroll 圖示就能開始。')
        }));
        return;
      }

      var grid = el('div', { class: 'list' }, items.map(function (item) {
        var thumb = el('div', { class: 'history-thumb' });
        if (item.thumb) {
          thumb.appendChild(el('img', { src: item.thumb, alt: '' }));
        } else {
          thumb.appendChild(el('span', { class: 'badge', text: item.format }));
        }

        return el('div', {
          class: 'history-card reveal',
          onclick: function () { location.search = '?id=' + encodeURIComponent(item.id); }
        }, [
          thumb,
          el('div', { class: 'history-meta' }, [
            el('div', { class: 'history-title', text: item.title || '（無標題）' }),
            el('div', { class: 'history-sub', text: item.outputWidth + '×' + item.outputHeight + ' · ' +
              LIMITS.formatBytes(item.bytes) + (item.pageCount ? ' · ' + item.pageCount + ' 頁' : '') }),
            el('div', { class: 'history-sub', text: fmtTime(item.createdAt) })
          ])
        ]);
      }));

      els.content.appendChild(grid);
    }).catch(function (e) {
      els.content.innerHTML = '';
      els.content.appendChild(el('div', { class: 'empty', text: '讀取歷史失敗：' + String((e && e.message) || e) }));
    });
  }

  /* ── 詳情視圖 ───────────────────────────────────────────────────── */

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    chrome.downloads.download({ url: url, filename: filename, conflictAction: 'uniquify' }, function () {
      /* 下載是非同步的，等一段時間再釋放，避免檔案還沒落地就被拔掉 */
      setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
    });
  }

  function baseName(item) {
    return 'snapscroll-' + item.outputWidth + 'x' + item.outputHeight + '-' +
      new Date(item.createdAt).getTime();
  }

  function reencode(blob, format, filename) {
    return createImageBitmap(blob).then(function (bitmap) {
      var canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      if (bitmap.close) bitmap.close();
      var mime = format === 'jpeg' ? 'image/jpeg' : (format === 'webp' ? 'image/webp' : 'image/png');
      return new Promise(function (resolve) {
        canvas.toBlob(function (out) { resolve(out); }, mime, format === 'png' ? undefined : 0.92);
      }).then(function (out) {
        if (out) downloadBlob(out, filename);
        return out;
      });
    });
  }

  function cropAndSave(rect, blob, filename) {
    return createImageBitmap(blob).then(function (bitmap) {
      var w = Math.max(1, Math.min(rect.width, bitmap.width - rect.x));
      var h = Math.max(1, Math.min(rect.height, bitmap.height - rect.y));
      var canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      var ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, rect.x, rect.y, w, h, 0, 0, w, h);
      if (bitmap.close) bitmap.close();
      return new Promise(function (resolve) {
        canvas.toBlob(function (out) { resolve(out); }, 'image/png');
      });
    }).then(function (out) {
      if (out) downloadBlob(out, filename);
      return out;
    });
  }

  function setupCropper(viewer, img, item, blob) {
    var box = null;
    var tag = null;

    function cleanup() {
      cropState = null;
      if (box && box.parentNode) box.parentNode.removeChild(box);
      if (tag && tag.parentNode) tag.parentNode.removeChild(tag);
      box = null;
      tag = null;
    }

    viewer.addEventListener('pointerdown', function (ev) {
      if (ev.button !== 0) return;
      var rect = img.getBoundingClientRect();
      var startX = ev.clientX - rect.left;
      var startY = ev.clientY - rect.top;

      cleanup();
      box = el('div', { class: 'crop-box' });
      tag = el('div', { class: 'crop-tag' });
      viewer.appendChild(box);
      viewer.appendChild(tag);
      viewer.setPointerCapture(ev.pointerId);

      var frame = null;

      function update(curX, curY) {
        var x = Math.max(0, Math.min(startX, curX));
        var y = Math.max(0, Math.min(startY, curY));
        var w = Math.min(rect.width - x, Math.abs(curX - startX));
        var h = Math.min(rect.height - y, Math.abs(curY - startY));

        box.style.display = 'block';
        box.style.left = x + 'px';
        box.style.top = y + 'px';
        box.style.width = w + 'px';
        box.style.height = h + 'px';
        tag.style.display = 'block';
        tag.style.left = x + 'px';
        tag.style.top = Math.max(14, y) + 'px';

        var k = img.naturalWidth / rect.width;
        var pxW = Math.round(w * k);
        var pxH = Math.round(h * k);
        tag.textContent = pxW + ' × ' + pxH;

        cropState = {
          rect: {
            x: Math.round(x * k),
            y: Math.round(y * k),
            width: pxW,
            height: pxH
          }
        };
      }

      function onMove(moveEv) {
        if (frame) cancelAnimationFrame(frame);
        frame = requestAnimationFrame(function () {
          update(moveEv.clientX - rect.left, moveEv.clientY - rect.top);
        });
      }

      function onUp() {
        viewer.removeEventListener('pointermove', onMove);
        viewer.removeEventListener('pointerup', onUp);
        if (cropState && (cropState.rect.width < 4 || cropState.rect.height < 4)) {
          cleanup();
          return;
        }
        setHint();
      }

      viewer.addEventListener('pointermove', onMove);
      viewer.addEventListener('pointerup', onUp);

      function setHint() {
        if (!cropState) return;
        els.pageSubtitle.textContent = '已選取 ' + cropState.rect.width + ' × ' + cropState.rect.height +
          ' px —— 按「裁剪並儲存」輸出這塊區域。';
      }
    });
  }

  function renderDetail(record) {
    var summary = record.summary;
    var files = record.files || [];
    var main = files[0];

    if (!main) {
      els.content.innerHTML = '';
      els.content.appendChild(el('div', { class: 'empty', text: '這筆紀錄的圖片已經不存在了。' }));
      return;
    }

    releaseUrl();
    currentUrl = URL.createObjectURL(main.blob);
    var outExt = summary.format === 'pdf' ? 'pdf' : summary.format;

    els.pageTitle.textContent = summary.title || '（無標題）';
    els.pageSubtitle.textContent = I18N.t('result_crop_hint', '在預覽圖上拖曳可以框選範圍，再按「裁剪並儲存」。');

    els.headActions.innerHTML = '';
    els.headActions.appendChild(el('button', {
      class: 'btn-ghost',
      text: I18N.t('result_back', '← 歷史'),
      onclick: function () { location.search = ''; }
    }));
    els.headActions.appendChild(el('button', {
      class: 'btn-ghost',
      text: I18N.t('result_download', '下載'),
      onclick: function () { downloadBlob(main.blob, baseName(summary) + '.' + outExt); }
    }));
    els.headActions.appendChild(el('button', {
      class: 'btn-ghost',
      text: I18N.t('result_delete', '刪除'),
      onclick: function () {
        if (!confirm('刪除這筆紀錄？')) return;
        history.remove(summary.id).then(renderList);
      }
    }));

    var viewer = el('div', { class: 'viewer' });
    var img = el('img', { src: currentUrl, alt: '' });
    viewer.appendChild(img);

    var actions = el('div', { class: 'row', style: 'margin-top:12px;flex-wrap:wrap' });
    actions.appendChild(el('button', {
      class: 'btn-primary',
      style: 'width:auto;padding:9px 16px',
      text: I18N.t('result_crop_save', '裁剪並儲存'),
      onclick: function () {
        if (!cropState) {
          els.pageSubtitle.textContent = '先在預覽圖上拖曳出要保留的範圍。';
          return;
        }
        cropAndSave(cropState.rect, main.blob, baseName(summary) + '-crop-' +
          cropState.rect.width + 'x' + cropState.rect.height + '.png');
      }
    }));

    if (summary.format !== 'png') {
      actions.appendChild(el('button', {
        class: 'btn-ghost',
        text: '另存 PNG',
        onclick: function () { reencode(main.blob, 'png', baseName(summary) + '.png'); }
      }));
    }
    if (summary.format !== 'jpeg') {
      actions.appendChild(el('button', {
        class: 'btn-ghost',
        text: '另存 JPEG',
        onclick: function () { reencode(main.blob, 'jpeg', baseName(summary) + '.jpg'); }
      }));
    }
    if (summary.format !== 'webp') {
      actions.appendChild(el('button', {
        class: 'btn-ghost',
        text: '另存 WebP',
        onclick: function () { reencode(main.blob, 'webp', baseName(summary) + '.webp'); }
      }));
    }

    var meta = el('dl', { class: 'meta-grid' }, [
      el('div', {}, [el('dt', { text: '尺寸' }), el('dd', { text: summary.outputWidth + ' × ' + summary.outputHeight + ' px' })]),
      el('div', {}, [el('dt', { text: '格式' }), el('dd', { text: String(summary.format).toUpperCase() })]),
      el('div', {}, [el('dt', { text: '檔案大小' }), el('dd', { text: LIMITS.formatBytes(main.bytes || main.blob.size) })]),
      el('div', {}, [el('dt', { text: '頁數' }), el('dd', { text: summary.pageCount ? String(summary.pageCount) : '—' })]),
      el('div', {}, [el('dt', { text: '擷取幀數' }), el('dd', { text: String(summary.frames || '—') })]),
      el('div', {}, [el('dt', { text: '時間' }), el('dd', { text: fmtTime(summary.createdAt) })])
    ]);

    var link = el('p', { class: 'card-hint mono' });
    if (summary.url) {
      link.appendChild(el('a', { href: summary.url, target: '_blank', rel: 'noreferrer', text: summary.url, style: 'color:var(--accent)' }));
    }

    els.content.innerHTML = '';
    els.content.appendChild(el('div', { class: 'card reveal' }, [viewer]));
    els.content.appendChild(el('div', { class: 'card reveal' }, [actions, meta, link]));

    if (summary.kind === 'pdf') {
      els.pageSubtitle.textContent = I18N.t('result_pdf_hint', '這是 PDF 檔，預覽只顯示第一頁的縮圖；按「下載」取得完整檔案。');
    }

    setupCropper(viewer, img, summary, main.blob);
  }

  /* ── 啟動 ───────────────────────────────────────────────────────── */

  function init() {
    els.pageTitle = $('pageTitle');
    els.pageSubtitle = $('pageSubtitle');
    els.headActions = $('headActions');
    els.content = $('content');

    I18N.apply(document);

    var id = new URLSearchParams(location.search).get('id');
    if (!id) {
      renderList();
      return;
    }

    history.get(id).then(function (record) {
      if (!record) {
        els.content.appendChild(el('div', { class: 'empty', text: '找不到這筆紀錄（可能已經被清掉）。' }));
        return;
      }
      renderDetail(record);
    }).catch(function (e) {
      els.content.appendChild(el('div', { class: 'empty', text: '讀取失敗：' + String((e && e.message) || e) }));
    });

    window.addEventListener('beforeunload', releaseUrl);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
