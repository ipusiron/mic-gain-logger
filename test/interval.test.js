'use strict';

// 段階1のテスト。「1行＝1区間」の組み立てを固定する。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  ENGINE_WORKLET,
  ENGINE_FALLBACK,
  framesForInterval,
  validRatioOf,
  audioTimeToWallMs,
  buildIntervalRecord,
  buildFallbackRecord,
  buildCsv
} = require('../logic.js');

test('framesForInterval: 秒→フレーム。下限は1レンダークォンタム', () => {
  assert.equal(framesForInterval(1, 48000), 48000);
  assert.equal(framesForInterval(0.2, 48000), 9600);
  assert.equal(framesForInterval(1, 44100), 44100);
  assert.equal(framesForInterval(60, 48000), 2880000);
  assert.equal(framesForInterval(0.001, 48000), 128);
  assert.equal(framesForInterval(NaN, 48000), 48000);
  assert.equal(framesForInterval(0.5, 44100), 22050);
});

test('validRatioOf: 届いたサンプル数 ÷ 期待サンプル数', () => {
  assert.equal(validRatioOf(48000, 48000), 1);
  assert.equal(validRatioOf(24000, 48000), 0.5);
  assert.equal(validRatioOf(0, 48000), 0);
  assert.equal(validRatioOf(10, 0), 0);
});

test('audioTimeToWallMs: オーディオクロックの秒を壁時計へ写す', () => {
  const anchor = { audioTime: 5, wallMs: 1000000 };
  assert.equal(audioTimeToWallMs(5, anchor), 1000000);
  assert.equal(audioTimeToWallMs(6, anchor), 1001000);
  assert.equal(audioTimeToWallMs(4.5, anchor), 999500);
});

// 区間内のサンプルから作った集計メッセージ（ワークレットが送る形）
function message(over) {
  return Object.assign({
    type: 'interval',
    seq: 0,
    sampleRate: 48000,
    startFrame: 48000,
    endFrame: 96000,
    expected: 48000,
    count: 48000,
    sumSq: 48000 * 0.01,     // RMS 0.1 = -20 dBFS
    peak: 0.1 * Math.SQRT2,
    clip: 0,
    emittedAt: 2
  }, over);
}

const ANCHOR = { audioTime: 0, wallMs: Date.UTC(2026, 8, 28, 2, 55, 0) };

test('区間レコード: 代表値はエネルギー平均、ピークは別に持つ', () => {
  const rec = buildIntervalRecord(message(), ANCHOR, -60);
  assert.equal(rec.engine, ENGINE_WORKLET);
  assert.equal(rec.startTime, 1);
  assert.equal(rec.endTime, 2);
  assert.equal(rec.startWall.toISOString(), '2026-09-28T02:55:01.000Z');
  assert.equal(rec.endWall.toISOString(), '2026-09-28T02:55:02.000Z');
  assert.equal(rec.ts, rec.endWall);
  assert.ok(Math.abs(rec.rawDb + 20) < 1e-9);
  assert.ok(Math.abs(rec.db + 20) < 1e-9);
  assert.ok(Math.abs(rec.peakDb + 16.9897) < 1e-3);
  assert.equal(rec.clipCount, 0);
  assert.equal(rec.sampleCount, 48000);
  assert.equal(rec.expectedSamples, 48000);
  assert.equal(rec.validRatio, 1);
});

test('区間レコード: エネルギー平均は大きいほうへ寄る（瞬時値・算術平均と別物）', () => {
  // -40 dBFS を半分、-20 dBFS を半分。
  // エネルギー平均 = 10*log10((1e-4 + 1e-2)/2) = -22.9678…
  const half = 24000;
  const sumSq = half * 1e-4 + half * 1e-2;
  const rec = buildIntervalRecord(message({ sumSq, count: 48000 }), ANCHOR, -60);
  assert.ok(Math.abs(rec.rawDb + 22.9678) < 1e-3, `got ${rec.rawDb}`);
  // 算術平均なら -30、瞬時値（最後のフレーム）なら -20。どちらとも違う
  assert.ok(Math.abs(rec.rawDb + 30) > 7);
  assert.ok(Math.abs(rec.rawDb + 20) > 2.9);
});

test('区間レコード: 欠測すると有効サンプル率が下がる', () => {
  const rec = buildIntervalRecord(message({ count: 12000, sumSq: 12000 * 0.01 }), ANCHOR, -60);
  assert.equal(rec.validRatio, 0.25);
  assert.equal(rec.sampleCount, 12000);
  assert.equal(rec.expectedSamples, 48000);
  // 届いたぶんのエネルギー平均なので dB 値そのものは下がらない
  assert.ok(Math.abs(rec.rawDb + 20) < 1e-9);
});

test('区間レコード: 1サンプルも届かなければ欠測（dbfs・ピーク・クリップは null）で、無音（-Infinity）と分ける', () => {
  // ⚠ 第2弾b1 まで（公開した版では第2弾a まで）は -Infinity にしていた。デジタル無音と同じ値なので、CSV の上で
  //    「音が無かった」と「記録していなかった」を区別できなかった（第2弾a の公開前の点検の W#4）
  const rec = buildIntervalRecord(message({ count: 0, sumSq: 0, peak: 0, clip: 0 }), ANCHOR, -60);
  assert.equal(rec.missing, true);
  assert.equal(rec.rawDb, null);
  assert.equal(rec.db, null);
  assert.equal(rec.peakDb, null);
  assert.equal(rec.clipCount, null);
  assert.equal(rec.silent, false);
  assert.equal(rec.validRatio, 0);
  // デジタル無音（届いたが振幅が0）は、これまでどおり -Infinity
  const silent = buildIntervalRecord(message({ sumSq: 0, peak: 0 }), ANCHOR, -60);
  assert.equal(silent.missing, false);
  assert.equal(silent.rawDb, -Infinity);
  assert.equal(silent.peakDb, -Infinity);
  assert.equal(silent.silent, true);
});

test('区間レコード: 表示下限は db だけを切り、rawDb は残す（段階2で表示専用へ）', () => {
  const rec = buildIntervalRecord(message({ sumSq: 48000 * 1e-8 }), ANCHOR, -60);
  assert.ok(Math.abs(rec.rawDb + 80) < 1e-9);
  assert.equal(rec.db, -60);
});

test('区間レコード: クリップ数をそのまま持つ', () => {
  const rec = buildIntervalRecord(message({ clip: 37, peak: 1.25 }), ANCHOR, -60);
  assert.equal(rec.clipCount, 37);
  assert.equal(rec.peak, 1.25);
  assert.ok(rec.peakDb > 0);
});

test('簡易モードのレコード: ピーク・クリップ・有効サンプル率は不明として null', () => {
  const rec = buildFallbackRecord({
    seq: 3,
    db: -25,
    floorDb: -60,
    startTime: 10,
    endTime: 11,
    startWallMs: Date.UTC(2026, 8, 28, 2, 55, 10),
    endWallMs: Date.UTC(2026, 8, 28, 2, 55, 11),
    expectedSamples: 48000
  });
  assert.equal(rec.engine, ENGINE_FALLBACK);
  assert.equal(rec.seq, 3);
  assert.equal(rec.rawDb, -25);
  assert.equal(rec.db, -25);
  assert.equal(rec.peak, null);
  assert.equal(rec.peakDb, null);
  assert.equal(rec.clipCount, null);
  assert.equal(rec.sampleCount, null);
  assert.equal(rec.validRatio, null);
  assert.equal(rec.ts.toISOString(), '2026-09-28T02:55:11.000Z');
});

test('CSV: 列は増えない。モードだけ先頭の1行に残る', () => {
  // 書き出すのは rawDb（生値）。db は表示用なので CSV には出ない
  const logs = [{ ts: new Date('2026-09-28T02:55:02.000Z'), rawDb: -20, db: -20 }];
  // 段階4で列を足した。A列 timestamp・B列 dbfs は動かさない
  // （READMEが案内している Excel の手順が A列=時刻・B列=音量を前提にしている）
  //
  // ⚠ 行の位置で見ない。CSV はヘッダー行のあとにトレーラー行が付くので、
  //    末尾からの数え方は壊れる（2026-09-29 に壊れた）
  const plain = buildCsv(logs).split('\n').filter(l => l.length && l.charAt(0) !== '#');
  assert.equal(plain[0], 'timestamp,dbfs,seq,peak_dbfs,clip,valid_ratio,band_ultra_dbfs,band_audible_dbfs,band_valid_ratio,hash');
  assert.equal(plain[1], '2026-09-28T02:55:02.000Z,-20.00,,,,,,,,');
  assert.equal(plain.length, 2, '列のヘッダーと1行だけのはず');

  const worklet = buildCsv(logs, { engine: ENGINE_WORKLET });
  assert.ok(worklet.includes('# engine=worklet'), worklet);
  const fallback = buildCsv(logs, { engine: ENGINE_FALLBACK });
  assert.ok(fallback.includes('# engine=fallback'), fallback);

  // データ行はモードによらず同じ（モードはメタ行にだけ出る）
  const bodyOf = csv => csv.split('\n').filter(l => !l.startsWith('#')).join('\n');
  assert.equal(bodyOf(worklet), bodyOf(fallback));

  // 先頭2列は段階0のときと同じ並び
  const first = plain[1].split(',');
  assert.equal(first[0], '2026-09-28T02:55:02.000Z');
  assert.equal(first[1], '-20.00');
});

test('CSV: 表示下限を変えても記録される値は動かない（表示専用である）', () => {
  // 同じ区間を、表示下限だけ変えて2通り作る。
  // 改修前は表示下限でクリップした値を記録していたため、記録中に表示の設定を
  // 変えるとログデータ自体が変質していた
  const loud = buildIntervalRecord(message(), ANCHOR, -60);
  const clipped = buildIntervalRecord(message(), ANCHOR, -10);
  assert.equal(loud.rawDb, clipped.rawDb, 'rawDb が表示下限で動いている');
  assert.notEqual(loud.db, clipped.db, '表示用の db は表示下限で切られるはず');
  assert.equal(clipped.db, -10);
  // CSV は両方とも同じ行になる
  assert.equal(buildCsv([loud]), buildCsv([clipped]));
  // 末尾一致は列が増えると壊れる。B列（dbfs）を明示的に見る
  const row = buildCsv([clipped]).split('\n').filter(l => l && !l.startsWith('#')).pop();
  assert.equal(row.split(',')[1], '-20.00', row);
});

// ---- seq は1つのCSVの中での通し番号 ----
//
// ⚠ ワークレットの seq は記録開始のたびに 0 から振り直される（記録開始のたびに
// 新しい AudioWorkletNode を作るため）。ところがログは累積するので、
// 1つのCSVの中で seq が 0 に戻っていた。列の意味が「通し番号」なのに
// 同じ値の行が2つ出るのは、Excel で並べ替えたときにそのまま事故になる。
// 呼ぶ側が起点（seqBase）をずらして足すことで、ファイルの中では通しにする。

test('seqBase: セッションをまたいでも1つのCSVの中で通し番号になる', () => {
  // 1回目のセッション（ワークレットの seq は 0,1,2）
  const first = [0, 1, 2].map(i => buildIntervalRecord(message({ seq: i }), ANCHOR, -60));
  assert.deepEqual(first.map(r => r.seq), [0, 1, 2]);

  // 2回目。ワークレットは また 0 から振り直す。起点を前の続きへずらす
  const base = Math.max(...first.map(r => r.seq)) + 1;
  const second = [0, 1].map(i => buildIntervalRecord(
    message({ seq: i }), ANCHOR, -60, { seqBase: base }
  ));
  assert.deepEqual(second.map(r => r.seq), [3, 4]);

  const all = first.concat(second).map(r => r.seq);
  assert.equal(new Set(all).size, all.length, '1つのCSVの中で seq が重複している');
});

test('seqBase: ずらしても、捨てた区間の欠番は残る', () => {
  // seq=1 の区間を捨てた場合（NaN で届いた、など）。欠番は行が抜けた印なので消さない
  const recs = [0, 2, 3].map(i => buildIntervalRecord(
    message({ seq: i }), ANCHOR, -60, { seqBase: 10 }
  ));
  assert.deepEqual(recs.map(r => r.seq), [10, 12, 13]);
});

test('seqBase: 省略すれば従来どおり msg.seq のまま', () => {
  assert.equal(buildIntervalRecord(message({ seq: 7 }), ANCHOR, -60).seq, 7);
  assert.equal(buildIntervalRecord(message({ seq: 7 }), ANCHOR, -60, {}).seq, 7);
  // seq が無いメッセージを NaN に変えない（CSV では空欄のままにする）
  assert.equal(buildIntervalRecord(message({ seq: undefined }), ANCHOR, -60).seq, undefined);
});

test('script.js: 記録開始のたびに seq の起点をずらしている', () => {
  // ここが外れると、1つのCSVの中で seq が 0 に戻る状態へ戻ってしまう
  const script = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');
  assert.match(script, /seqBase = seqMax \+ 1/, '記録開始で起点をずらしていない');
  assert.match(script, /rec\.seq > seqMax/, 'ログに入った最大の seq を追っていない');
  assert.match(script, /seq: seqBase \+ seqCounter\+\+/, '簡易モードが起点を足していない');
  assert.match(script, /seqBase,/, '高精度モードへ起点を渡していない');
});
