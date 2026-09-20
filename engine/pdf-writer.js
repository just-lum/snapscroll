/* SnapScroll — 零依賴 PDF 生成器
 *
 * 為什麼自己寫：一份「一頁貼一張 JPEG」的 PDF，規格本身就極簡，
 * 為了它拉進幾百 KB 的 PDF 函式庫，跟這個專案「零依賴」的立場不合。
 *
 * 核心技巧：PDF 的影像串流支援 /DCTDecode 過濾器，意思是
 * **JPEG 檔案可以原封不動塞進 PDF**，不需要解碼、不需要重新壓縮、
 * 也不需要 FlateDecode 那一套 PNG 用的預測器。所以流程是
 * canvas → JPEG → 位元組直接進 PDF，畫質只取決於 JPEG 品質參數。
 *
 * 排出來的物件表：
 *   1               Catalog
 *   2               Pages
 *   3               Info（標題等）
 *   4, 7, 10 …      每頁的 Page 物件
 *   5, 8, 11 …      每頁的 Contents 串流
 *   6, 9, 12 …      每頁的 Image XObject
 *
 * 最容易寫錯的地方有兩個，這裡都特別處理：
 *   1. 偏移量必須是**位元組**位置，而且 xref 每一行必須剛好 20 位元組。
 *      JPEG 是二進位資料，用字串長度去算偏移一定會歪掉。
 *   2. 非 ASCII 的字串（中文標題）要用 UTF-16BE 的十六進位字串，
 *      直接寫進 () 裡會被解讀成 PDFDocEncoding 而變成亂碼。
 *
 * 全部是純函式，回傳 Uint8Array，在 Node 與瀏覽器都能跑。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SnapScrollPdfWriter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function asciiBytes(str) {
    var s = String(str);
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
  }

  function toBytes(data) {
    if (!data) return new Uint8Array(0);
    if (data instanceof Uint8Array) return data;
    if (typeof ArrayBuffer !== 'undefined' && data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (Array.isArray(data)) return new Uint8Array(data);
    throw new Error('pdf-writer: 影像資料必須是 Uint8Array / ArrayBuffer / number[]');
  }

  /* PDF 數字：固定 3 位小數後去尾零，杜絕 1e-7 這種科學記號寫進檔案 */
  function num(v) {
    var n = Number(v);
    if (!isFinite(n)) n = 0;
    var s = n.toFixed(3);
    if (s.indexOf('.') >= 0) s = s.replace(/\.?0+$/, '');
    if (s === '-0' || s === '') s = '0';
    return s;
  }

  function pad10(n) {
    var s = String(Math.max(0, Math.floor(n)));
    while (s.length < 10) s = '0' + s;
    return s;
  }

  function isAscii(str) {
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x20 || c > 0x7e) return false;
    }
    return true;
  }

  /* 依內容挑字面字串或 UTF-16BE 十六進位字串 */
  function pdfText(str) {
    var s = str == null ? '' : String(str);
    if (isAscii(s)) {
      return '(' + s.replace(/[\\()]/g, function (m) { return '\\' + m; }) + ')';
    }
    var hex = 'FEFF';
    for (var i = 0; i < s.length; i++) {
      var code = s.charCodeAt(i);
      hex += (code < 0x1000 ? code < 0x100 ? code < 0x10 ? '000' : '00' : '0' : '') + code.toString(16).toUpperCase();
    }
    return '<' + hex + '>';
  }

  function pdfDate(d) {
    var t = d instanceof Date ? d : new Date();
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    var offMin = -t.getTimezoneOffset();
    var sign = offMin >= 0 ? '+' : '-';
    var absMin = Math.abs(offMin);
    var oh = p2(Math.floor(absMin / 60));
    var om = p2(absMin % 60);
    return 'D:' + t.getFullYear() + p2(t.getMonth() + 1) + p2(t.getDate()) +
      p2(t.getHours()) + p2(t.getMinutes()) + p2(t.getSeconds()) +
      sign + oh + "'" + om + "'";
  }

  function infoDict(meta) {
    var m = meta || {};
    var pairs = [];
    if (m.title) pairs.push('/Title ' + pdfText(m.title));
    if (m.author) pairs.push('/Author ' + pdfText(m.author));
    if (m.subject) pairs.push('/Subject ' + pdfText(m.subject));
    if (m.keywords) pairs.push('/Keywords ' + pdfText(m.keywords));
    pairs.push('/Creator ' + pdfText(m.creator || 'SnapScroll'));
    pairs.push('/Producer ' + pdfText(m.producer || 'SnapScroll'));
    pairs.push('/CreationDate ' + pdfText(pdfDate(m.date)));
    return pairs.join(' ');
  }

  /* 主函式。
   * spec = {
   *   pages: [{
   *     jpeg: Uint8Array,          // 這一頁的 JPEG 位元組
   *     pixelWidth, pixelHeight,   // JPEG 的實際像素尺寸
   *     pageWidth, pageHeight,     // 這一頁的 MediaBox（pt）
   *     drawX, drawY, drawWidth, drawHeight   // 影像在頁面上的落點（pt）
   *   }],
   *   meta: { title, author, subject, keywords, creator, producer, date }
   * }
   * → Uint8Array
   */
  function buildPdf(spec) {
    var s = spec || {};
    var pages = s.pages || [];
    if (!pages.length) throw new Error('pdf-writer: 至少需要一頁');

    var chunks = [];
    var size = 0;
    var offsets = [];

    function push(u8) {
      chunks.push(u8);
      size += u8.length;
    }
    function write(str) {
      push(asciiBytes(str));
    }
    function mark(objNum) {
      offsets[objNum] = size;
    }

    /* 標頭：第二行是四位元非 ASCII 註解，讓傳輸工具知道這是二進位檔 */
    write('%PDF-1.4\n');
    push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

    var kids = [];
    for (var i = 0; i < pages.length; i++) kids.push((4 + i * 3) + ' 0 R');

    mark(1);
    write('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

    mark(2);
    write('2 0 obj\n<< /Type /Pages /Count ' + pages.length + ' /Kids [' + kids.join(' ') + '] >>\nendobj\n');

    mark(3);
    write('3 0 obj\n<< ' + infoDict(s.meta) + ' >>\nendobj\n');

    for (var p = 0; p < pages.length; p++) {
      var page = pages[p];
      var pageNum = 4 + p * 3;
      var contentNum = pageNum + 1;
      var imageNum = pageNum + 2;

      var jpeg = toBytes(page.jpeg);
      var pw = num(page.pageWidth);
      var ph = num(page.pageHeight);
      var pixelW = Math.max(1, Math.round(Number(page.pixelWidth) || 1));
      var pixelH = Math.max(1, Math.round(Number(page.pixelHeight) || 1));

      mark(pageNum);
      write(pageNum + ' 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pw + ' ' + ph + ']' +
        ' /Resources << /XObject << /Im0 ' + imageNum + ' 0 R >> /ProcSet [/PDF /ImageC] >>' +
        ' /Contents ' + contentNum + ' 0 R >>\nendobj\n');

      var ops = 'q ' + num(page.drawWidth) + ' 0 0 ' + num(page.drawHeight) + ' ' +
        num(page.drawX) + ' ' + num(page.drawY) + ' cm /Im0 Do Q\n';
      var opsBytes = asciiBytes(ops);

      mark(contentNum);
      write(contentNum + ' 0 obj\n<< /Length ' + opsBytes.length + ' >>\nstream\n');
      push(opsBytes);
      write('endstream\nendobj\n');

      mark(imageNum);
      write(imageNum + ' 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + pixelW +
        ' /Height ' + pixelH + ' /ColorSpace /DeviceRGB /BitsPerComponent 8' +
        ' /Filter /DCTDecode /Length ' + jpeg.length + ' >>\nstream\n');
      push(jpeg);
      write('\nendstream\nendobj\n');
    }

    var total = 3 + pages.length * 3 + 1;   // 含 0 號自由物件
    var xrefOffset = size;

    write('xref\n0 ' + total + '\n');
    write('0000000000 65535 f \n');
    for (var n = 1; n < total; n++) {
      var off = offsets[n] == null ? 0 : offsets[n];
      /* 這一行的長度必須剛好 20 位元組（含換行） */
      write(pad10(off) + ' 00000 n \n');
    }
    write('trailer\n<< /Size ' + total + ' /Root 1 0 R /Info 3 0 R >>\nstartxref\n' +
      xrefOffset + '\n%%EOF\n');

    var out = new Uint8Array(size);
    var cursor = 0;
    for (var c = 0; c < chunks.length; c++) {
      out.set(chunks[c], cursor);
      cursor += chunks[c].length;
    }
    return out;
  }

  /* ── 自我檢查 ────────────────────────────────────────────────
   * 產出的 PDF 是否自洽：xref 偏移指到的地方真的是「n 0 obj」嗎？
   * 測試用它把關；執行期也可以拿它做保險。 */
  function verifyPdf(bytes) {
    var u8 = toBytes(bytes);
    var text = '';
    /* 只解前半段的 ASCII 標頭區不需要，直接掃描整個檔案的 ASCII 子集 */
    for (var i = 0; i < u8.length; i++) {
      var b = u8[i];
      text += (b >= 0x09 && b <= 0x7e) ? String.fromCharCode(b) : '\n';
    }

    var errors = [];
    if (text.slice(0, 8) !== '%PDF-1.4') errors.push('缺少 PDF 標頭');
    if (text.indexOf('%%EOF') < 0) errors.push('缺少 %%EOF');

    var sxIdx = text.lastIndexOf('startxref');
    if (sxIdx < 0) {
      errors.push('缺少 startxref');
      return { ok: false, errors: errors };
    }
    var tail = text.slice(sxIdx);
    var m = /startxref\s+(\d+)/.exec(tail);
    if (!m) {
      errors.push('startxref 沒有偏移量');
      return { ok: false, errors: errors };
    }
    var startxref = parseInt(m[1], 10);

    if (startxref >= u8.length) {
      errors.push('startxref 超出檔案長度：' + startxref + ' >= ' + u8.length);
      return { ok: false, errors: errors };
    }
    var xrefHead = '';
    for (var k = startxref; k < Math.min(u8.length, startxref + 4); k++) xrefHead += String.fromCharCode(u8[k]);
    if (xrefHead !== 'xref') errors.push('startxref 指向的不是 xref 表');

    /* 解析 xref 每行，檢查物件偏移 */
    var section = text.slice(startxref);
    var lines = section.split('\n');
    var header = /^xref\s*$/.test(lines[0].replace(/\r/g, ''));
    if (!header) lines = lines.slice(0);
    var countLine = /^0\s+(\d+)\s*$/.exec((lines[1] || '').replace(/\r/g, ''));
    if (!countLine) {
      errors.push('xref 表頭格式不對');
      return { ok: false, errors: errors, startxref: startxref };
    }
    var entryCount = parseInt(countLine[1], 10);
    var checked = 0;

    for (var e = 1; e < entryCount; e++) {
      /* lines[0]="xref"、lines[1]="0 N"、lines[2]=0 號自由物件，
       * 所以物件 e 的條目落在 lines[e + 2]（PDF 的經典差一錯誤）。 */
      var line = (lines[e + 2] || '').replace(/\r/g, '');
      if (line.length !== 19 && line.length !== 20) {
        errors.push('xref 第 ' + e + ' 行長度不是 20 位元組：' + line.length);
        break;
      }
      var mm = /^(\d{10}) (\d{5}) ([nf])/.exec(line);
      if (!mm) {
        errors.push('xref 第 ' + e + ' 行格式不對：' + JSON.stringify(line));
        break;
      }
      var objOffset = parseInt(mm[1], 10);
      var expect = e + ' 0 obj';
      var got = '';
      for (var q = objOffset; q < Math.min(u8.length, objOffset + expect.length); q++) got += String.fromCharCode(u8[q]);
      if (got !== expect) {
        errors.push('物件 ' + e + ' 的偏移指到 ' + JSON.stringify(got) + '，應為 ' + JSON.stringify(expect));
      }
      checked++;
    }

    return {
      ok: errors.length === 0,
      errors: errors,
      startxref: startxref,
      objects: entryCount - 1,
      checkedEntries: checked,
      bytes: u8.length
    };
  }

  return {
    buildPdf: buildPdf,
    verifyPdf: verifyPdf,
    pdfText: pdfText,
    pdfDate: pdfDate,
    num: num
  };
});
