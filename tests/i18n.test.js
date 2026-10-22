/**
 * 翻譯完整性測試
 *
 *   node --test tests/i18n.test.js
 *
 * chrome.i18n 找不到 key 時不會報錯，只會回空字串——於是英文使用者看到
 * 一片空白，而開發者（locale 是 zh_CN）什麼都看不到。所以這裡把三份
 * messages 與所有引用點硬碰硬對一次。
 *
 * 四個檢查面：
 *   1. 三份 locale 的 key 集合必須完全相同
 *   2. 同一條訊息的替換佔位符在各語言裡必須一致（否則 getMessage 傳參錯位）
 *   3. HTML 的 data-i18n* 與 JS 的 I18N.t('…') 引用都必須有對應條目
 *   4. manifest 的 __MSG_*__ 必須有對應條目，否則擴充裝不起來
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const LOCALES = ['en', 'zh_CN', 'zh_TW'];

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

function messagesOf(locale) {
  return readJson(path.join('_locales', locale, 'messages.json'));
}

function keysOf(obj) {
  return Object.keys(obj).sort();
}

function placeholdersOf(message) {
  const found = new Set();
  const named = /\$([A-Za-z0-9_]+)\$/g;
  const numbered = /\$(\d)/g;
  let m;
  while ((m = named.exec(message))) found.add('$' + m[1] + '$');
  while ((m = numbered.exec(message))) found.add('$' + m[1]);
  return Array.from(found).sort();
}

function listFiles(dir, ext) {
  return fs.readdirSync(path.join(ROOT, dir))
    .filter((name) => name.endsWith(ext))
    .map((name) => path.join(dir, name));
}

/* ── 1. key 集合 ────────────────────────────────────────────────────── */

test('三份 locale 的 key 集合完全相同', () => {
  const base = keysOf(messagesOf('zh_CN'));
  LOCALES.forEach((locale) => {
    const other = keysOf(messagesOf(locale));
    const missing = base.filter((k) => !other.includes(k));
    const extra = other.filter((k) => !base.includes(k));
    assert.deepEqual(missing, [], `${locale} 缺少這些 key`);
    assert.deepEqual(extra, [], `${locale} 多出這些 key`);
  });
});

test('每條訊息都是非空字串，且沒有殘留的 TODO', () => {
  LOCALES.forEach((locale) => {
    const messages = messagesOf(locale);
    Object.keys(messages).forEach((key) => {
      const entry = messages[key];
      assert.equal(typeof entry, 'object', `${locale}/${key} 必須是物件`);
      assert.equal(typeof entry.message, 'string', `${locale}/${key}.message 必須是字串`);
      assert.ok(entry.message.trim().length > 0, `${locale}/${key} 是空字串`);
      assert.doesNotMatch(entry.message, /TODO|FIXME|XXX/, `${locale}/${key} 有殘留標記`);
    });
  });
});

test('同一條訊息的替換佔位符在各語言裡一致', () => {
  const base = messagesOf('zh_CN');
  LOCALES.forEach((locale) => {
    const messages = messagesOf(locale);
    Object.keys(base).forEach((key) => {
      assert.deepEqual(
        placeholdersOf(messages[key].message),
        placeholdersOf(base[key].message),
        `${locale}/${key} 的佔位符與 zh_CN 不一致`
      );
    });
  });
});

/* ── 2. HTML 引用 ───────────────────────────────────────────────────── */

test('HTML 的 data-i18n* 全部有對應條目', () => {
  const messages = messagesOf('zh_CN');
  const missing = [];
  listFiles('ui', '.html').forEach((rel) => {
    const html = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const re = /data-i18n(?:-[a-z]+)?="([^"]+)"/g;
    let m;
    while ((m = re.exec(html))) {
      if (!(m[1] in messages)) missing.push(`${rel}: ${m[1]}`);
    }
  });
  assert.deepEqual(missing, []);
});

/* ── 3. JS 引用 ─────────────────────────────────────────────────────── */

test('JS 的 I18N.t(…) 全部有對應條目', () => {
  const messages = messagesOf('zh_CN');
  const missing = [];
  listFiles('ui', '.js').forEach((rel) => {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const re = /I18N\.t\(\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(src))) {
      if (!(m[1] in messages)) missing.push(`${rel}: ${m[1]}`);
    }
  });
  assert.deepEqual(missing, []);
});

/* ── 4. manifest ────────────────────────────────────────────────────── */

test('manifest 的 __MSG_*__ 全部有對應條目（大小寫不敏感）', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8');
  const messages = messagesOf('zh_CN');
  const lowered = new Set(Object.keys(messages).map((k) => k.toLowerCase()));
  const re = /__MSG_([A-Za-z0-9_]+)__/g;
  const refs = [];
  let m;
  while ((m = re.exec(raw))) refs.push(m[1]);

  assert.ok(refs.length >= 4, 'manifest 至少要有四個 __MSG__ 引用');
  refs.forEach((key) => {
    assert.ok(lowered.has(key.toLowerCase()), `manifest 引用了不存在的 key：${key}`);
  });
});

test('manifest 宣告的 default_locale 真的存在', () => {
  const manifest = readJson('manifest.json');
  const dirs = fs.readdirSync(path.join(ROOT, '_locales'));
  assert.ok(dirs.includes(manifest.default_locale), `缺少 _locales/${manifest.default_locale}`);
});
