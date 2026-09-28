'use strict';

// 段階2の4番。許可プロンプトを放置したときに UI が固まらないようにする。
//
// 改修前は startBtn を無効にしたあと getUserMedia をタイムアウトなしで
// await していたため、20秒経っても「マイクに接続中…」のままで
// 記録開始・停止の両方が無効になり、リロード以外に復帰手段がなかった。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CONNECT_HINT_MS,
  CONNECT_TIMEOUT_MS,
  createAttemptGate,
  raceWithTimeout
} = require('../logic.js');

test('待ち時間の設定: 案内が先、打ち切りがあと', () => {
  assert.ok(CONNECT_HINT_MS > 0);
  assert.ok(CONNECT_TIMEOUT_MS > CONNECT_HINT_MS);
  assert.equal(CONNECT_HINT_MS, 8000);
  assert.equal(CONNECT_TIMEOUT_MS, 20000);
});

test('createAttemptGate: 最新の試行だけが有効', () => {
  const gate = createAttemptGate();
  assert.equal(gate.isCurrent(0), false);   // まだ何も始めていない
  const a = gate.begin();
  assert.equal(gate.isCurrent(a), true);
  const b = gate.begin();
  assert.equal(gate.isCurrent(a), false);   // 古い試行は無効になる
  assert.equal(gate.isCurrent(b), true);
  gate.cancel();
  assert.equal(gate.isCurrent(b), false);   // 取り消したら誰も有効でない
  const c = gate.begin();
  assert.equal(gate.isCurrent(c), true);
  assert.ok(gate.generation() >= 4);
});

test('raceWithTimeout: 間に合えば値を返し、タイマーを残さない', async () => {
  const cleared = [];
  const timers = {
    setTimeout: (fn, ms) => ({ fn, ms }),
    clearTimeout: (t) => cleared.push(t)
  };
  const r = await raceWithTimeout(Promise.resolve('stream'), 20000, timers);
  assert.deepEqual(r, { value: 'stream' });
  assert.equal(cleared.length, 1);
  assert.equal(cleared[0].ms, 20000);
});

test('raceWithTimeout: 失敗はそのまま返る（例外にしない）', async () => {
  const err = new Error('NotAllowedError');
  const r = await raceWithTimeout(Promise.reject(err), 50);
  assert.equal(r.error, err);
  assert.equal(r.value, undefined);
  assert.equal(r.timedOut, undefined);
});

test('raceWithTimeout: 応答がなければ時間切れとして戻る', async () => {
  const never = new Promise(() => {});
  const t0 = Date.now();
  const r = await raceWithTimeout(never, 30);
  assert.deepEqual(r, { timedOut: true });
  assert.ok(Date.now() - t0 >= 25, '待ってから戻る');
});

test('時間切れのあとに届いたストリームは、古い試行として捨てられる', async () => {
  const gate = createAttemptGate();
  const token = gate.begin();

  const stopped = [];
  const lateStream = { getTracks: () => [{ stop: () => stopped.push('a') }] };
  let resolveLate;
  const attempt = new Promise((res) => { resolveLate = res; });

  const outcome = await raceWithTimeout(attempt, 20);
  assert.deepEqual(outcome, { timedOut: true });

  // 時間切れで打ち切る
  gate.cancel();
  assert.equal(gate.isCurrent(token), false);

  // そのあとで許可された
  resolveLate(lateStream);
  const late = await attempt;
  if (!gate.isCurrent(token)) late.getTracks().forEach(t => t.stop());
  assert.deepEqual(stopped, ['a']);
});

test('取り消したあとに新しく開始しても、古い応答は混ざらない', async () => {
  const gate = createAttemptGate();
  const first = gate.begin();
  gate.cancel();                 // 「停止」で取り消し
  const second = gate.begin();   // もう一度「記録開始」
  assert.equal(gate.isCurrent(first), false);
  assert.equal(gate.isCurrent(second), true);
});

test('既定のタイマーはそのまま呼べる（this を失って落ちない）', async () => {
  // ブラウザーの setTimeout は this が Window でないと Illegal invocation になる。
  // オブジェクトのプロパティとして素の setTimeout を置くとこれを踏む
  // （実機で実際に踏んだ。node では再現しないのでここは呼べることだけを見る）。
  const r = await raceWithTimeout(new Promise(() => {}), 20);
  assert.deepEqual(r, { timedOut: true });
  const ok = await raceWithTimeout(Promise.resolve(1), 20);
  assert.deepEqual(ok, { value: 1 });
});
