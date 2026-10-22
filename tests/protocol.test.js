/**
 * 訊息協定測試
 *
 *   node --test tests/protocol.test.js
 *
 * 四個執行環境共用同一條 chrome.runtime 匯流排，而分發完全靠 type 字串。
 * 所以這裡最要緊的一條是「沒有兩個訊息類型撞在同一個值上」——撞了不會
 * 報錯，只會在某個路徑上默默走到錯的 if 分支。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const P = require('../common/protocol.js');

/* ── 封包形狀 ───────────────────────────────────────────────────────── */

test('envelope 產出固定五個欄位', () => {
  const msg = P.envelope(P.TO.SW, P.MSG.START, { tabId: 7 });
  assert.deepEqual(Object.keys(msg).sort(), ['payload', 'target', 'type', 'v', P.FLAG].sort());
  assert.equal(msg[P.FLAG], true);
  assert.equal(msg.v, P.VERSION);
  assert.equal(msg.target, 'sw');
  assert.equal(msg.type, 'start');
  assert.deepEqual(msg.payload, { tabId: 7 });
});

test('payload 省略時補 null，不是 undefined', () => {
  const msg = P.envelope(P.TO.UI, P.MSG.QUERY_STATE);
  assert.equal(msg.payload, null);
  /* structured clone 會把 undefined 欄位整個丟掉，接收端就少一個鍵 */
  assert.ok('payload' in msg);
});

test('每次呼叫都是新物件，兩則訊息不共用 payload', () => {
  const a = P.envelope(P.TO.SW, P.MSG.CANCEL);
  const b = P.envelope(P.TO.SW, P.MSG.CANCEL);
  assert.notEqual(a, b);
  a.payload = { x: 1 };
  assert.equal(b.payload, null);
});

/* ── 收件者判定 ─────────────────────────────────────────────────────── */

test('isFor 只認自己那一個 target', () => {
  const toSw = P.envelope(P.TO.SW, P.MSG.START);
  assert.equal(P.isFor(toSw, P.TO.SW), true);
  assert.equal(P.isFor(toSw, P.TO.UI), false);
  assert.equal(P.isFor(toSw, P.TO.OFFSCREEN), false);
  assert.equal(P.isFor(toSw, P.TO.AGENT), false);
});

test('isFor 對非協定訊息一律為假', () => {
  assert.equal(P.isFor(null, P.TO.SW), false);
  assert.equal(P.isFor(undefined, P.TO.SW), false);
  assert.equal(P.isFor('start', P.TO.SW), false);
  assert.equal(P.isFor({}, P.TO.SW), false);
  assert.equal(P.isFor({ target: 'sw' }, P.TO.SW), false);
  /* 旗標必須是布林 true，字串 "true" 不算 */
  assert.equal(P.isFor({ [P.FLAG]: 'true', target: 'sw' }, P.TO.SW), false);
});

test('isProtocolMessage 只看旗標，不看 target', () => {
  assert.equal(P.isProtocolMessage(P.envelope(P.TO.UI, P.MSG.PROGRESS)), true);
  assert.equal(P.isProtocolMessage({ [P.FLAG]: true }), true);
  assert.equal(P.isProtocolMessage({ type: 'start' }), false);
  assert.equal(P.isProtocolMessage(null), false);
});

/* ── 常數表完整性 ───────────────────────────────────────────────────── */

function assertNoDuplicates(table, label) {
  const seen = new Map();
  Object.keys(table).forEach((name) => {
    const value = table[name];
    assert.equal(typeof value, 'string', `${label}.${name} 必須是字串`);
    assert.ok(value.length > 0, `${label}.${name} 不能是空字串`);
    if (seen.has(value)) {
      assert.fail(`${label}.${name} 與 ${seen.get(value)} 撞值：${value}`);
    }
    seen.set(value, name);
  });
}

test('MSG 沒有兩個類型撞在同一個值上', () => {
  assertNoDuplicates(P.MSG, 'MSG');
});

test('TO / PHASE / ERR 同樣不得撞值', () => {
  assertNoDuplicates(P.TO, 'TO');
  assertNoDuplicates(P.PHASE, 'PHASE');
  assertNoDuplicates(P.ERR, 'ERR');
});

test('MSG 的值都是 kebab-case，方便在日誌裡一眼認出', () => {
  Object.keys(P.MSG).forEach((name) => {
    assert.match(P.MSG[name], /^[a-z][a-z0-9-]*$/, `MSG.${name} = ${P.MSG[name]}`);
  });
});

test('每個 target 都有一個收件者常數', () => {
  const targets = Object.keys(P.TO).map((k) => P.TO[k]).sort();
  assert.deepEqual(targets, ['agent', 'offscreen', 'sw', 'ui']);
});
