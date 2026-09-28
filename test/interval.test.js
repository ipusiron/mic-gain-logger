'use strict';

// 段階1のテスト。「1行＝1区間」の組み立てを固定する。

const test = require('node:test');
const assert = require('node:assert/strict');

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

test('区間レコード: 1サンプルも届かなければ -Infinity', () => {
  const rec = buildIntervalRecord(message({ count: 0, sumSq: 0, peak: 0 }), ANCHOR, -60);
  assert.equal(rec.rawDb, -Infinity);
  assert.equal(rec.peakDb, -Infinity);
  assert.equal(rec.validRatio, 0);
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
  assert.equal(buildCsv(logs), 'timestamp,dbfs\n2026-09-28T02:55:02.000Z,-20.00');
  assert.equal(
    buildCsv(logs, { engine: ENGINE_WORKLET }),
    '# engine=worklet\ntimestamp,dbfs\n2026-09-28T02:55:02.000Z,-20.00'
  );
  assert.equal(
    buildCsv(logs, { engine: ENGINE_FALLBACK }),
    '# engine=fallback\ntimestamp,dbfs\n2026-09-28T02:55:02.000Z,-20.00'
  );
  // データ行の形は段階0から変わっていない
  const body = buildCsv(logs, { engine: ENGINE_WORKLET }).split('\n').slice(1).join('\n');
  assert.equal(body, buildCsv(logs));
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
  assert.ok(buildCsv([clipped]).endsWith(',-20.00'), buildCsv([clipped]));
});
