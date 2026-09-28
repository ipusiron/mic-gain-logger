'use strict';

// 段階0のテスト。
// 目的は「logic.js へ移した純関数が、移す前の script.js と同じ答えを返すこと」の固定である。
// いまの実装が正しいかどうかは問わない（-Infinity を捨てる・floorDb に上限がない等の
// 既知の問題は段階2以降で扱う）。ここで固定するのは現在の振る舞いそのもの。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  clamp,
  dbToPercent,
  formatHMS,
  rmsToDbfs,
  rmsOf,
  parseFloorDb,
  parseIntervalSec,
  createStats,
  addStatsSample,
  statsLeq,
  dbToPower,
  powerToDb,
  formatStats,
  emptyStatsText,
  buildCsv,
  csvFileName
} = require('../logic.js');

test('clamp: 範囲内はそのまま、範囲外は端に張り付く', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(11, 0, 10), 10);
  assert.equal(clamp(0, 0, 0), 0);
});

test('rmsToDbfs: 1e-8 以下は -Infinity、それ以外は 20*log10', () => {
  assert.equal(rmsToDbfs(0), -Infinity);
  assert.equal(rmsToDbfs(1e-8), -Infinity);
  assert.equal(rmsToDbfs(-1), -Infinity);
  assert.ok(rmsToDbfs(1e-8 + 1e-12) < -159);
  assert.equal(rmsToDbfs(1), 0);
  assert.ok(Math.abs(rmsToDbfs(0.1) + 20) < 1e-12);
  assert.ok(Math.abs(rmsToDbfs(0.5) + 6.0206) < 1e-4);
  assert.ok(rmsToDbfs(2) > 0);
});

test('rmsOf: 既知の列で二乗平均平方根が出る', () => {
  assert.equal(rmsOf(new Float32Array([0, 0, 0, 0])), 0);
  assert.equal(rmsOf(new Float32Array([1, -1, 1, -1])), 1);
  assert.equal(rmsOf([0.5, -0.5]), 0.5);
  assert.ok(Math.abs(rmsOf([1, 0]) - Math.SQRT1_2) < 1e-15);
});

test('dbToPercent: 既定の下限 -60 で 0〜100 に収まる', () => {
  assert.equal(dbToPercent(0), 100);
  assert.equal(dbToPercent(-60), 0);
  assert.equal(dbToPercent(-30), 50);
  assert.equal(dbToPercent(-120), 0);
  assert.equal(dbToPercent(20), 100);
  assert.equal(dbToPercent(-20, -40), 50);
  assert.equal(dbToPercent(-Infinity), 0);
});

test('dbToPercent: floorDb=0 は NaN になる（現状の振る舞い。段階2で扱う）', () => {
  assert.ok(Number.isNaN(dbToPercent(0, 0)));
});

test('formatHMS: 00:00:00 から桁あふれまで', () => {
  assert.equal(formatHMS(0), '00:00:00');
  assert.equal(formatHMS(1.9), '00:00:01');
  assert.equal(formatHMS(59), '00:00:59');
  assert.equal(formatHMS(60), '00:01:00');
  assert.equal(formatHMS(3599), '00:59:59');
  assert.equal(formatHMS(3600), '01:00:00');
  assert.equal(formatHMS(86399), '23:59:59');
  assert.equal(formatHMS(360000), '100:00:00');
});

test('parseFloorDb: 非数は -60。範囲は -120〜-1 に丸める', () => {
  assert.equal(parseFloorDb('-60'), -60);
  assert.equal(parseFloorDb(''), -60);
  assert.equal(parseFloorDb('abc'), -60);
  assert.equal(parseFloorDb('-40.5'), -40.5);
  assert.equal(parseFloorDb('-120'), -120);
  assert.equal(parseFloorDb('-1'), -1);

  // 0 以上を入れるとメーター幅が NaN%（CSSOM に拒否され無言で凍結）になり、
  // 大型表示も物理的にありえない正の dBFS を出していた
  assert.equal(parseFloorDb('0'), -1);
  assert.equal(parseFloorDb('10'), -1);
  assert.equal(parseFloorDb('-200'), -120);
  for (const raw of ['0', '10', '60', '-200', '-1e9']) {
    const v = parseFloorDb(raw);
    assert.ok(v >= -120 && v <= -1, `${raw} -> ${v}`);
    assert.ok(Number.isFinite(dbToPercent(-30, v)), `${raw} で百分率が数値にならない`);
  }
});

test('parseIntervalSec: 下限 0.2 秒、0 と非数は 1 秒（|| の現状の振る舞い）', () => {
  assert.equal(parseIntervalSec('1.0'), 1);
  assert.equal(parseIntervalSec('0.2'), 0.2);
  assert.equal(parseIntervalSec('0.05'), 0.2);
  assert.equal(parseIntervalSec('0'), 1);
  assert.equal(parseIntervalSec(''), 1);
  assert.equal(parseIntervalSec('abc'), 1);
  assert.equal(parseIntervalSec('60'), 60);
});

test('統計: 平均はエネルギー平均（Leq）。算術平均ではない', () => {
  const stats = createStats();
  assert.equal(addStatsSample(stats, NaN), false);
  assert.equal(addStatsSample(stats, Infinity), false);
  assert.deepEqual(stats,
    { powerSum: 0, n: 0, finiteN: 0, silentN: 0, minDb: Infinity, maxDb: -Infinity });

  assert.equal(addStatsSample(stats, -20), true);
  assert.equal(addStatsSample(stats, -40), true);
  assert.equal(addStatsSample(stats, -30), true);
  // Leq = 10*log10((10^-2 + 10^-4 + 10^-3)/3) = -24.3180…
  // 算術平均なら -30.0 で、5.7dB ずれる
  assert.deepEqual(formatStats(stats, 3), {
    avg: '-24.3 dBFS',
    max: '-20.0 dBFS',
    min: '-40.0 dBFS',
    range: '20.0 dB',
    count: '3'
  });
  assert.ok(Math.abs(statsLeq(stats) + 24.31798275933005) < 1e-9);
});

test('統計: 算術平均との差は条件しだいで 26dB を超える', () => {
  const mk = (list) => {
    const s = createStats();
    list.forEach(d => addStatsSample(s, d));
    return s;
  };
  const cases = [
    { list: [-20, -60], arith: -40, leq: -23.00993 },
    { list: [-20, -80], arith: -50, leq: -23.01030 }
  ];
  for (const c of cases) {
    const leq = statsLeq(mk(c.list));
    assert.ok(Math.abs(leq - c.leq) < 1e-4, `${c.list} -> ${leq}`);
    assert.ok(leq > c.arith, 'エネルギー平均は算術平均より必ず大きいか等しい');
  }
  // 大きい音1つと無音に近い音1つ。差は約27dB
  assert.ok(Math.abs(statsLeq(mk([-20, -80])) - (-50)) > 26);
});

test('統計: 無音（-Infinity）は電力0として平均に入り、最大・最小からは外れる', () => {
  const stats = createStats();
  assert.equal(addStatsSample(stats, -20), true);
  assert.equal(addStatsSample(stats, -Infinity), true, '無音の行も母集団に入る');
  assert.equal(addStatsSample(stats, -20), true);
  assert.equal(stats.n, 3);
  assert.equal(stats.finiteN, 2);
  assert.equal(stats.silentN, 1);
  // Leq = 10*log10((0.01 + 0 + 0.01)/3) = -21.76…（3行で割る）
  assert.deepEqual(formatStats(stats, 3), {
    avg: '-21.8 dBFS',
    max: '-20.0 dBFS',
    min: '-20.0 dBFS',
    range: '0.0 dB',
    count: '3'
  });
});

test('統計: すべて無音なら平均は -∞、最大・最小は未定義のまま', () => {
  const stats = createStats();
  addStatsSample(stats, -Infinity);
  addStatsSample(stats, -Infinity);
  assert.deepEqual(formatStats(stats, 2), {
    avg: '-∞ dBFS',
    max: '--.- dBFS',
    min: '--.- dBFS',
    range: '--.- dB',
    count: '2'
  });
});

test('統計: dBToPower / powerToDb は往復する', () => {
  for (const db of [-1, -6, -20, -40, -60, -90, -120]) {
    assert.ok(Math.abs(powerToDb(dbToPower(db)) - db) < 1e-9, `${db}`);
  }
  assert.equal(dbToPower(-Infinity), 0);
  assert.equal(powerToDb(0), -Infinity);
});

test('統計: 1件でも平均が出る。件数は logs 側の数を使う', () => {
  const stats = createStats();
  addStatsSample(stats, -12.34);
  // 1件のエネルギー平均はその値そのもの
  assert.deepEqual(formatStats(stats, 0), {
    avg: '-12.3 dBFS',
    max: '-12.3 dBFS',
    min: '-12.3 dBFS',
    range: '0.0 dB',
    count: '0'
  });
});

test('統計: リセット直後の表示文字列', () => {
  assert.deepEqual(emptyStatsText(), {
    avg: '--.- dBFS',
    max: '--.- dBFS',
    min: '--.- dBFS',
    range: '--.- dB',
    count: '0'
  });
});

test('CSV: ヘッダーは timestamp,dbfs、値は小数2桁', () => {
  const logs = [
    { ts: new Date('2026-09-28T02:55:02.192Z'), rawDb: -20, db: -20 },
    { ts: new Date('2026-09-28T02:55:03.192Z'), rawDb: -19.999, db: -19.999 }
  ];
  // ⚠ 行の位置で見ない。CSV はデータ行のあとにトレーラー行が付く
  const lines = buildCsv(logs).split('\n').filter(l => l.length && l.charAt(0) !== '#');
  assert.equal(lines[0], 'timestamp,dbfs,seq,peak_dbfs,clip,valid_ratio,hash');
  assert.equal(lines[1], '2026-09-28T02:55:02.192Z,-20.00,,,,,');
  assert.equal(lines[2], '2026-09-28T02:55:03.192Z,-20.00,,,,,');
  assert.equal(lines.length, 3);
});

test('CSV: 0件のときはヘッダー・列・トレーラーだけ（末尾に改行が付く）', () => {
  // トレーラーは0件でも出す。丸ごと落とされたときに気づけるようにするため
  assert.equal(
    buildCsv([]),
    '# format=mic-gain-logger/2\n'
    + '# weighting=Z\n'
    + 'timestamp,dbfs,seq,peak_dbfs,clip,valid_ratio,hash\n'
    + '# rows=0\n'
  );
});

test('CSV: ファイル名はコロンとピリオドをハイフンへ置き換える', () => {
  assert.equal(
    csvFileName(new Date('2026-09-28T02:55:02.192Z')),
    'mic-gain-logs-2026-09-28T02-55-02-192Z.csv'
  );
});
