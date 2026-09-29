// クリップの注意書きは、分母を出し、単発と連続を言い分ける（第2弾a5）。
//
// ⚠⚠ 改修前（c7b6bad）は、1区間に1サンプルでも振幅1.0に届けば
//    「その区間の値は読めません。入力レベルを下げて採り直してください」と出していた。
//    ・1サンプル（48kHz・1秒の区間の0.002%）と、波形が長くつぶれた区間を同じ文で言う
//    ・延べのサンプル数を分母なしで出すので、実際より大ごとに見える
//    ・iPhone のブラウザーには入力音量を下げる手段が無く、助言を実行できない
//    iPhone の実機で「クリップを8区間で検出（延べ385サンプル）」が出た件の調べで分かった。
//    多くはマイクへの接触・端末の操作音で、単発である。
// また、統計の「真のピーク」は標本点の最大値（サンプルピーク）であって、
// ITU-R BS.1770 のトゥルーピーク（標本の間のピーク）ではない。呼び方を直す。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  createStats, addStatsRecord, statsWarnings, buildIntervalRecord, buildFallbackRecord,
  CLIP_RUN_SUSTAINED
} = require('../logic.js');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

const SR = 48000;
const ANCHOR = { epoch: 0, audioTime: 0, wallMs: Date.UTC(2026, 8, 29, 0, 0, 0) };

function recordOf(seq, over) {
  const msg = Object.assign({
    type: 'interval', seq, sampleRate: SR,
    startFrame: seq * SR, endFrame: (seq + 1) * SR,
    expected: SR, count: SR, sumSq: SR * 0.01, peak: 0.14, clip: 0, clipRun: 0,
    emittedAt: seq + 1
  }, over);
  return buildIntervalRecord(msg, ANCHOR, -90);
}

function statsOf(recs) {
  const s = createStats();
  for (const r of recs) addStatsRecord(s, r);
  return s;
}

test('区間レコードと統計が、クリップの最長の連続と記録した全サンプル数を持つ', () => {
  const r = recordOf(0, { peak: 1, clip: 5, clipRun: 3 });
  assert.equal(r.clipRunMax, 3);
  const s = statsOf([r, recordOf(1, { peak: 1, clip: 1, clipRun: 1 }), recordOf(2)]);
  assert.equal(s.clipRunMax, 3);
  assert.equal(s.clipRunKnownN, 3);
  assert.equal(s.sampleTotal, 3 * SR);
});

test('⭐分母を出す（記録した全サンプルに対する割合）', () => {
  const w = statsWarnings(statsOf([recordOf(0, { peak: 1, clip: 24, clipRun: 1 }), recordOf(1)]));
  assert.equal(w.length, 1);
  assert.match(w[0], /クリップを1区間で検出/);
  assert.match(w[0], /延べ24サンプル/);
  // 24 / 96000 = 0.025%
  assert.match(w[0], /記録した全サンプルの0\.03%/);
});

test('ごく少ないときは「0.01%未満」と出す', () => {
  const w = statsWarnings(statsOf([recordOf(0, { peak: 1, clip: 1, clipRun: 1 })]));
  assert.match(w[0], /0\.01%未満/);
});

test('⭐単発だけなら、その区間の値を「読めない」と言い切らない', () => {
  const w = statsWarnings(statsOf([
    recordOf(0, { peak: 1, clip: 2, clipRun: 1 }),
    recordOf(1, { peak: 1, clip: 1, clipRun: 2 })
  ]))[0];
  assert.match(w, /単発/);
  assert.doesNotMatch(w, /読めません/);
});

test('⭐3サンプル以上続いた箇所があれば、連続していることと最長の長さを言う', () => {
  const w = statsWarnings(statsOf([
    recordOf(0, { peak: 1, clip: 40, clipRun: 12 }),
    recordOf(1, { peak: 1, clip: 1, clipRun: 1 })
  ]))[0];
  assert.match(w, /連続して頭打ち/);
  assert.match(w, /最長12サンプル/);
  assert.match(w, /本来の音と違います/);
});

test('実行できない助言をしない（iPhone のブラウザーは入力音量を変えられない）', () => {
  const w = statsWarnings(statsOf([recordOf(0, { peak: 1, clip: 3, clipRun: 3 })]))[0];
  assert.doesNotMatch(w, /入力レベルを下げて/);
  assert.match(w, /接触/);
});

test('簡易モードの行は連続の長さを持たない（測れないことを 0 と言わない）', () => {
  const fb = buildFallbackRecord({
    seq: 0, db: -20, floorDb: -90, startTime: 0, endTime: 1,
    startWallMs: ANCHOR.wallMs, endWallMs: ANCHOR.wallMs + 1000, expectedSamples: SR
  });
  assert.equal(fb.clipRunMax, null);
  const s = statsOf([fb]);
  assert.equal(s.clipRunKnownN, 0);
  assert.equal(s.sampleTotal, 0);
});

test('「連続」の区切りは3サンプルで、README とヘルプも同じ数を書いている', () => {
  // 公開前の点検で見つかった。区切りをテストで固定していないと、値を変えても
  // README とヘルプの「3サンプル以上」と食い違ったまま気づけない
  assert.equal(CLIP_RUN_SUSTAINED, 3);
  assert.match(readme, /3サンプル以上続いた/);
  assert.match(html, /3サンプル以上続いていれば/);
  // 境目の前後で文が変わる
  const at = (run) => statsWarnings(statsOf([recordOf(0, { peak: 1, clip: run, clipRun: run })]))[0];
  assert.match(at(2), /単発/);
  assert.match(at(3), /連続して頭打ち/);
});

test('「真のピーク」を「サンプルピーク」と呼ぶ（トゥルーピークとは別物）', () => {
  assert.doesNotMatch(html, /真のピーク/, 'index.html に「真のピーク」が残っている');
  assert.match(html, /<div class="stat-label">サンプルピーク<\/div>/);
  // 別物であることを説明に書く
  const m = html.match(/<div class="stat"[^>]*title="([^"]*)"[^>]*>\s*<div class="stat-label">サンプルピーク/);
  assert.ok(m, 'サンプルピークの枠に title が無い');
  assert.match(m[1], /トゥルーピーク/);
  assert.doesNotMatch(readme, /真のピーク/, 'README に「真のピーク」が残っている');
});
