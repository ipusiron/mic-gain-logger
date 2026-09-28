// 記録中に鎖を進める入れ物（createHashChain）。
//
// ⚠⚠ ここは非同期の状態機械である。改修前は同じ処理が script.js の中にあり、
// テストから1行も触れなかった。ハッシュチェーンはこのツールの主張そのものなので、
// 「静かに壊れる」場所を script.js に置いておくわけにはいかない。
//
// このファイルで縛るもの:
//   - 1区間につき digest を1回しか呼ばない（書き出しでは計算し直さない）
//   - 起点は1行目で凍結され、あとの行が増えても動かない
//   - 計算の途中でログを捨てられても、古い鎖の結果が新しい鎖を上書きしない
//   - digest が使えない環境では鎖を名乗らない（hashes() が null）

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createHashChain, csvSeed, csvDataFields, hashInput, trailerHashInput,
  HASH_HEX_LEN, HASH_ALGO_LABEL
} = require('../logic.js');

function rec(seq, db) {
  return {
    ts: new Date(Date.UTC(2026, 8, 28, 5, 0, seq, 0)),
    rawDb: db, db, seq, peakDb: db + 3, clipCount: 0, validRatio: 1
  };
}

const META = {
  engine: 'worklet', started: '2026-09-28T05:00:01.000Z', sampleRate: 48000,
  device: 'Fake Mic', processing: 'off', hashAlgo: HASH_ALGO_LABEL
};

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// 呼ばれた回数と材料を数える digest
function counting(impl) {
  const calls = [];
  const fn = (text) => {
    calls.push(text);
    return impl(text);
  };
  fn.calls = calls;
  return fn;
}

test('1区間につき digest は1回だけ呼ばれる', async () => {
  const digest = counting(sha256Hex);
  const chain = createHashChain(digest);
  const rows = [rec(1, -20), rec(2, -25), rec(3, -18)];
  chain.begin(META);
  for (const r of rows) chain.extend(r);
  await chain.settled();

  // 起点1回＋行3回
  assert.equal(digest.calls.length, 4);
  assert.equal(digest.calls[0], csvSeed(META));
  // 書き出しを2回しても、計算は増えない
  assert.deepEqual(chain.hashes(rows), rows.map(r => r.hash));
  assert.deepEqual(chain.hashes(rows), rows.map(r => r.hash));
  assert.equal(digest.calls.length, 4);
  for (const r of rows) assert.equal(r.hash.length, HASH_HEX_LEN);
});

test('材料は「前の行のハッシュ＋その行のフィールド」である', async () => {
  const digest = counting(sha256Hex);
  const chain = createHashChain(digest);
  const rows = [rec(1, -20), rec(2, -25)];
  chain.begin(META);
  for (const r of rows) chain.extend(r);
  await chain.settled();

  const seedHash = (await sha256Hex(csvSeed(META))).slice(0, HASH_HEX_LEN);
  assert.equal(digest.calls[1], hashInput(seedHash, csvDataFields(rows[0])));
  assert.equal(digest.calls[2], hashInput(rows[0].hash, csvDataFields(rows[1])));
  assert.equal(chain.prev, rows[1].hash);
});

test('⭐ 起点は1行目で凍結され、行が増えても動かない', async () => {
  const rows = [rec(1, -20), rec(2, -25)];
  const chain = createHashChain(sha256Hex);
  chain.begin(META);
  for (const r of rows) chain.extend(r);
  await chain.settled();
  const first = rows.map(r => r.hash);

  // 同じ鎖のまま行を足す（記録を再開して書き出すのと同じ）
  const more = [rec(3, -Infinity), rec(4, -22)];
  for (const r of more) chain.extend(r);
  await chain.settled();

  assert.deepEqual(rows.map(r => r.hash), first, '先に書き出した行のハッシュが変わった');
  assert.equal(chain.meta, META, '起点が差し替わっている');
});

test('トレーラーは最後の行のハッシュを材料にする', async () => {
  const rows = [rec(1, -20), rec(2, -25)];
  const chain = createHashChain(sha256Hex);
  chain.begin(META);
  for (const r of rows) chain.extend(r);
  await chain.settled();

  const lines = ['# rows=2', '# intervalSec=1'];
  const got = await chain.sealTrailer(lines);
  const want = (await sha256Hex(trailerHashInput(rows[1].hash, lines))).slice(0, HASH_HEX_LEN);
  assert.equal(got, want);
  // トレーラーの中身が1文字でも違えば別の値になる
  const other = await chain.sealTrailer(['# rows=3', '# intervalSec=1']);
  assert.notEqual(other, got);
});

// ---- ⚠ 計算の途中でログを捨てられたとき ----
//
// 「統計リセット」は記録中でも押せる。押した瞬間に走っていた計算が
// あとから解決して、新しい鎖の prev を上書きすると、
// そこから先のハッシュが誰にも検証できない値になる。

// マイクロタスクを吐き出させる（digest は待ち行列の先で呼ばれる）
async function flush(times) {
  for (let i = 0; i < (times || 20); i++) await Promise.resolve();
}

test('⚠ 計算中にリセットしても、古い鎖の結果が新しい鎖を上書きしない', async () => {
  // digest を手で解決できるようにして、解決の順番を自分で作る
  const pending = [];
  const digest = (text) => new Promise((resolve) => {
    pending.push({ text, resolve });
  });
  const chain = createHashChain(digest);

  const old = rec(1, -20);
  chain.begin(META);
  chain.extend(old);
  await flush();
  assert.equal(pending.length, 1, '起点の計算が始まっていない');
  assert.equal(pending[0].text, csvSeed(META));

  // 起点がまだ解決していない状態でログを捨てる
  chain.reset();
  const gen = chain.generation;

  // 新しい鎖を始める
  const fresh = rec(1, -30);
  chain.begin(META);
  chain.extend(fresh);
  await flush();
  assert.equal(pending.length, 2, '新しい鎖の起点の計算が並んでいない');

  // 古い鎖の起点を、いまになって解決させる（ここが上書きの危険な瞬間）
  pending[0].resolve('a'.repeat(64));
  await flush();
  assert.equal(chain.prev, null, '捨てた鎖の起点で prev が埋まった');

  // 新しい鎖の起点 → 1行目、と順に解決させる
  pending[1].resolve('b'.repeat(64));
  await flush();
  assert.equal(chain.prev, 'b'.repeat(HASH_HEX_LEN));
  assert.equal(pending.length, 3, '新しい鎖の1行目の計算が並んでいない');
  assert.equal(pending[2].text, hashInput('b'.repeat(HASH_HEX_LEN), csvDataFields(fresh)));
  pending[2].resolve('c'.repeat(64));
  await chain.settled();
  await flush();

  assert.equal(chain.generation, gen, '世代が意図せず進んだ');
  assert.equal(fresh.hash, 'c'.repeat(HASH_HEX_LEN), '新しい鎖の行にハッシュが付いていない');
  assert.equal(chain.prev, fresh.hash);
  assert.equal(old.hash, '', '捨てた行にハッシュが残っている');
  assert.equal(chain.unavailable, false);
  // 捨てた鎖の計算が、あとから4件目を並べたりしていない
  assert.equal(pending.length, 3);
});

test('リセットすると起点も直前のハッシュも消える', async () => {
  const rows = [rec(1, -20)];
  const chain = createHashChain(sha256Hex);
  chain.begin(META);
  chain.extend(rows[0]);
  await chain.settled();
  assert.ok(chain.prev);

  chain.reset();
  assert.equal(chain.meta, null);
  assert.equal(chain.prev, null);
  assert.equal(chain.unavailable, false);
  assert.equal(await chain.sealTrailer(['# rows=0']), null);
});

// ---- 鎖を作れない環境（file:// など） ----

test('digest が null を返す環境では鎖を名乗らない', async () => {
  const chain = createHashChain(() => Promise.resolve(null));
  const rows = [rec(1, -20), rec(2, -25)];
  chain.begin(META);
  for (const r of rows) chain.extend(r);
  await chain.settled();

  assert.equal(chain.unavailable, true);
  assert.equal(chain.hashes(rows), null, 'ハッシュが無いのに鎖を名乗っている');
  assert.equal(await chain.sealTrailer(['# rows=2']), null);
  for (const r of rows) assert.equal(r.hash, '');
});

test('digest が投げても落ちない（鎖を名乗らないだけ）', async () => {
  const chain = createHashChain(() => Promise.reject(new Error('だめ')));
  const rows = [rec(1, -20)];
  chain.begin(META);
  chain.extend(rows[0]);
  await chain.settled();

  assert.equal(chain.unavailable, true);
  assert.equal(chain.hashes(rows), null);
  assert.ok(chain.errors.length, 'エラーを控えていない');
});

test('1行でもハッシュが欠けていたら hashes() は null', async () => {
  const rows = [rec(1, -20), rec(2, -25)];
  const chain = createHashChain(sha256Hex);
  chain.begin(META);
  for (const r of rows) chain.extend(r);
  await chain.settled();
  assert.ok(chain.hashes(rows));

  // 鎖を通さない行が混ざった場合（あってはならないが、通してしまわない）
  const mixed = rows.concat([rec(3, -18)]);
  assert.equal(chain.hashes(mixed), null);
});

test('0件では hashes() は null（列だけ空の行を作らない）', () => {
  const chain = createHashChain(sha256Hex);
  assert.equal(chain.hashes([]), null);
});
