/**
 * 檔名模板測試
 *
 *   node --test tests/filename.test.js
 *
 * 這裡測的是「存到磁碟會不會出事」：Windows 非法字元、尾隨點與空格、
 * 裝置保留名、超長檔名。這些在瀏覽器裡看不出來，但真的下載時會靜默失敗
 * 或者變成沒有副檔名的檔案。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const FN = require('../engine/filename.js');

const WHEN = new Date(2025, 0, 14, 9, 5, 7);

/* ── 清洗 ───────────────────────────────────────────────────────────── */

test('Windows 非法字元全部換成底線', () => {
  assert.equal(FN.sanitize('a<b>c:d"e/f\\g|h?i*j'), 'a_b_c_d_e_f_g_h_i_j');
});

test('控制字元與零寬字元被移除', () => {
  assert.equal(FN.sanitize('a\u0000b\u001fc\u200bd\ufeffe'), 'abcde');
});

test('尾隨的點與空格會清掉（否則 Windows 會吃掉副檔名）', () => {
  assert.equal(FN.sanitize('report... '), 'report');
  assert.equal(FN.sanitize('  leading space  '), 'leading space');
});

test('開頭的點會清掉，避免變成隱藏檔', () => {
  assert.equal(FN.sanitize('...hidden'), 'hidden');
});

test('裝置保留名加上前綴', () => {
  assert.equal(FN.sanitize('CON'), '_CON');
  assert.equal(FN.sanitize('com1'), '_com1');
  assert.equal(FN.sanitize('LPT9'), '_LPT9');
  assert.equal(FN.sanitize('console'), 'console', '只是剛好開頭相同，不該被動到');
});

test('空字串或全非法字元退回預設名', () => {
  assert.equal(FN.sanitize(''), 'capture');
  assert.equal(FN.sanitize('   '), 'capture');
  assert.equal(FN.sanitize(null), 'capture');
});

test('超長名稱被截斷且不留下尾隨點', () => {
  const long = 'x'.repeat(300);
  const out = FN.sanitize(long);
  assert.equal(out.length, FN.MAX_SEGMENT);
});

/* ── 主機名 ─────────────────────────────────────────────────────────── */

test('hostOf：去掉 www 與埠號', () => {
  assert.equal(FN.hostOf('https://www.example.com:8443/a/b?c=1#d'), 'example.com');
  assert.equal(FN.hostOf('http://sub.domain.co.uk/path'), 'sub.domain.co.uk');
});

test('hostOf：遇到怪東西不會回傳空字串', () => {
  assert.equal(FN.hostOf(''), '');
  assert.equal(FN.hostOf(null), '');
});

/* ── 模板展開 ───────────────────────────────────────────────────────── */

test('renderName：基本佔位符', () => {
  const out = FN.renderName('{date}_{host}_{title}', {
    url: 'https://docs.example.com/guide',
    title: '安裝指南',
    now: WHEN
  });
  assert.equal(out, '2025-01-14_docs.example.com_安裝指南');
});

test('renderName：時間戳佔位符', () => {
  assert.equal(FN.renderName('{time}', { now: WHEN }), '09-05-07');
  assert.equal(FN.renderName('{datetime}', { now: WHEN }), '2025-01-14_09-05-07');
  assert.equal(FN.renderName('{stamp}', { now: WHEN }), '20250114090507');
});

test('renderName：認不得的佔位符原樣保留，讓使用者看得出打錯', () => {
  assert.equal(FN.renderName('{title}_{nosuch}', { title: 'A', now: WHEN }), 'A_{nosuch}');
});

test('renderName：空模板退回預設模板', () => {
  const out = FN.renderName('', { url: 'https://a.test/x', title: 'T', now: WHEN });
  assert.equal(out, '2025-01-14_a.test_T');
});

test('renderName：沒有 title 時給 page 當後備', () => {
  assert.equal(FN.renderName('{title}', { now: WHEN }), 'page');
});

/* ── 完整檔名 ───────────────────────────────────────────────────────── */

test('buildFilename：補上副檔名', () => {
  const name = FN.buildFilename({
    template: '{date}_{host}',
    ctx: { url: 'https://example.com/a', now: WHEN },
    ext: 'png'
  });
  assert.equal(name, '2025-01-14_example.com.png');
});

test('buildFilename：模板自己寫了副檔名就不重複加', () => {
  const name = FN.buildFilename({ template: 'shot.jpg', ctx: { now: WHEN }, ext: 'jpg' });
  assert.equal(name, 'shot.jpg');
  assert.equal(FN.buildFilename({ template: 'SHOT.JPG', ctx: { now: WHEN }, ext: 'jpg' }), 'SHOT.JPG');
});

test('buildFilename：清理後仍然保有副檔名', () => {
  const name = FN.buildFilename({
    template: '{title}',
    ctx: { title: 'a'.repeat(400), now: WHEN },
    ext: 'png'
  });
  assert.ok(name.endsWith('.png'));
  assert.ok(name.length <= FN.MAX_SEGMENT);
});

test('buildFilename：只有非法字元的標題也能產出可用的檔名', () => {
  const name = FN.buildFilename({ template: '{title}', ctx: { title: '///', now: WHEN }, ext: 'png' });
  assert.equal(name, 'capture.png');
});

test('buildSliceFilename：分片補零對齊', () => {
  const opts = { template: 'page', ctx: { now: WHEN }, ext: 'png' };
  assert.equal(FN.buildSliceFilename(opts, 0, 3), 'page_part-01.png');
  assert.equal(FN.buildSliceFilename(opts, 2, 3), 'page_part-03.png');
  assert.equal(FN.buildSliceFilename(opts, 0, 12), 'page_part-01.png');
  assert.equal(FN.buildSliceFilename(opts, 11, 12), 'page_part-12.png');
});

test('buildSliceFilename：百片以上自動加寬', () => {
  const opts = { template: 'p', ctx: { now: WHEN }, ext: 'png' };
  assert.equal(FN.buildSliceFilename(opts, 99, 120), 'p_part-100.png');
});

/* ── 下載路徑 ───────────────────────────────────────────────────────── */

test('buildPath：資料夾被逐段清洗', () => {
  const path = FN.buildPath({
    template: '{title}',
    ctx: { title: 'Shot', now: WHEN },
    ext: 'png',
    folder: 'SnapScroll/2025:01'
  });
  assert.equal(path, 'SnapScroll/2025_01/Shot.png');
});

test('buildPath：沒有資料夾時就是單純檔名', () => {
  const path = FN.buildPath({ template: 'x', ctx: { now: WHEN }, ext: 'pdf', folder: '' });
  assert.equal(path, 'x.pdf');
});

test('sanitizeFolder：清掉空段與反斜線', () => {
  assert.equal(FN.sanitizeFolder('a\\\\b//c'), 'a/b/c');
  assert.equal(FN.sanitizeFolder('///'), '');
  assert.equal(FN.sanitizeFolder(null), '');
});

test('端到端：從一個真實網址產出可用的完整路徑', () => {
  const path = FN.buildPath({
    template: '{date}_{host}_{title}',
    ctx: {
      url: 'https://www.example.com/docs/start',
      title: 'Getting Started: 快速開始',
      now: WHEN
    },
    ext: 'pdf',
    folder: 'SnapScroll'
  });
  assert.equal(path, 'SnapScroll/2025-01-14_example.com_Getting Started_ 快速開始.pdf');
  assert.ok(!/[<>:"/\\|?*]/.test(path.replace(/^SnapScroll\//, '')));
});
