'use strict';

// 画面の統計と、書き出した CSV から計算し直した統計が一致することの検証。
//
// 改修前は統計が requestAnimationFrame ごと（約60Hz）、CSV がログ間隔（既定1秒）で、
// 母集団が違っていた。実測（ログ間隔5秒・14秒）では CSV が -20.0 の2行なのに
// 画面の最小が -39.1 dBFS、変動幅が 19.1 dB と出ていた。
// 第三者が CSV から画面の値を再現できないのは、証拠・監査の用途では単独で失格になる。
//
// ここでは CSV のテキストだけを入力にして統計を組み直し、画面用の formatStats と
// 突き合わせる。集計の実装を共有しないよう、再計算はこのファイルで独立に書く。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createStats, addStatsSample, formatStats,
  buildIntervalRecord, buildCsv
} = require('../logic.js');

const ANCHOR = { epoch: 0, audioTime: 0, wallMs: Date.UTC(2026, 8, 28, 5, 0, 0) };

function message(seq, over) {
  const sr = 48000;
  return Object.assign({
    type: 'interval',
    seq,
    sampleRate: sr,
    startFrame: seq * sr,
    endFrame: (seq + 1) * sr,
    expected: sr,
    count: sr,
    sumSq: sr * 0.01,    // RMS 0.1 = -20 dBFS
    peak: 0.1 * Math.SQRT2,
    clip: 0,
    emittedAt: seq + 1
  }, over);
}

// 区間の dBFS から、ワークレットが送る sumSq を逆算する
function msgForDb(seq, db) {
  const sr = 48000;
  if (db === -Infinity) return message(seq, { sumSq: 0, peak: 0 });
  const rms = Math.pow(10, db / 20);
  return message(seq, { sumSq: sr * rms * rms, peak: rms * Math.SQRT2 });
}

// ---- CSV のテキストだけから統計を組み直す（実装を共有しない独立の計算）----
function recomputeFromCsv(csvText) {
  const lines = csvText.split('\n')
    .filter(l => l.length && !l.startsWith('#'));
  assert.equal(lines[0], 'timestamp,dbfs', 'ヘッダーが違う');
  const values = lines.slice(1).map(l => {
    const cell = l.split(',')[1];
    return cell === '-Infinity' ? -Infinity : Number(cell);
  });

  let powerSum = 0;
  const finite = [];
  for (const db of values) {
    powerSum += (db === -Infinity) ? 0 : Math.pow(10, db / 10);
    if (Number.isFinite(db)) finite.push(db);
  }
  const leq = powerSum > 0 ? 10 * Math.log10(powerSum / values.length) : -Infinity;
  const fmt = (db) => (db === -Infinity ? '-∞ dBFS' : `${db.toFixed(1)} dBFS`);
  return {
    avg: values.length ? fmt(leq) : '--.- dBFS',
    max: finite.length ? fmt(Math.max(...finite)) : '--.- dBFS',
    min: finite.length ? fmt(Math.min(...finite)) : '--.- dBFS',
    range: finite.length
      ? `${(Math.max(...finite) - Math.min(...finite)).toFixed(1)} dB`
      : '--.- dB',
    count: String(values.length),
    rows: values.length
  };
}

// 画面と同じ手順で統計を進める（pushRecord から呼ばれる経路と同じ）
function screenStats(recs) {
  const stats = createStats();
  for (const r of recs) addStatsSample(stats, r.rawDb);
  return formatStats(stats, recs.length);
}

function roundTrip(dbList, floorDb) {
  const recs = dbList.map((db, i) => buildIntervalRecord(msgForDb(i, db), ANCHOR, floorDb));
  const csv = buildCsv(recs, { engine: 'worklet' });
  return { recs, csv, screen: screenStats(recs), fromCsv: recomputeFromCsv(csv) };
}

test('統計: CSV から計算し直した値が画面の値と一致する（一定の音）', () => {
  const r = roundTrip([-20, -20, -20, -20, -20], -60);
  assert.equal(r.fromCsv.rows, 5);
  assert.deepEqual(r.screen, {
    avg: '-20.0 dBFS', max: '-20.0 dBFS', min: '-20.0 dBFS',
    range: '0.0 dB', count: '5'
  });
  assert.equal(r.screen.avg, r.fromCsv.avg);
  assert.equal(r.screen.max, r.fromCsv.max);
  assert.equal(r.screen.min, r.fromCsv.min);
  assert.equal(r.screen.range, r.fromCsv.range);
  assert.equal(r.screen.count, r.fromCsv.count);
});

test('統計: CSV から計算し直した値が画面の値と一致する（幅のある音）', () => {
  const r = roundTrip([-6, -12, -20, -35, -48, -59], -60);
  for (const key of ['avg', 'max', 'min', 'range', 'count']) {
    assert.equal(r.screen[key], r.fromCsv[key], `${key} が一致しない`);
  }
  assert.equal(r.screen.max, '-6.0 dBFS');
  assert.equal(r.screen.min, '-59.0 dBFS');
  assert.equal(r.screen.range, '53.0 dB');
});

test('統計: 無音をまたいでも CSV と画面が一致する', () => {
  const r = roundTrip([-20, -Infinity, -Infinity, -20], -60);
  assert.equal(r.fromCsv.rows, 4, '無音の行が CSV に出ていない');
  for (const key of ['avg', 'max', 'min', 'range', 'count']) {
    assert.equal(r.screen[key], r.fromCsv[key], `${key} が一致しない`);
  }
  // 4行のうち2行が無音（電力0）なので Leq は -20 より 3dB 低い
  assert.equal(r.screen.avg, '-23.0 dBFS');
  assert.equal(r.screen.max, '-20.0 dBFS');
});

test('統計: 表示下限を変えても CSV と画面の統計は動かない（表示専用である）', () => {
  const list = [-6, -20, -45, -58];
  const loose = roundTrip(list, -60);
  const tight = roundTrip(list, -30);   // -45 と -58 は表示上クリップされる
  // 表示用の db はクリップされている
  assert.equal(tight.recs[3].db, -30);
  assert.equal(loose.recs[3].db, -58);
  // 記録と統計はどちらも動かない
  assert.equal(loose.csv, tight.csv, 'CSV が表示下限で変わっている');
  assert.deepEqual(loose.screen, tight.screen, '統計が表示下限で変わっている');
  for (const key of ['avg', 'max', 'min', 'range']) {
    assert.equal(tight.screen[key], tight.fromCsv[key], `${key} が一致しない`);
  }
});

test('統計: すべて無音でも CSV と画面が一致する', () => {
  const r = roundTrip([-Infinity, -Infinity, -Infinity], -60);
  assert.equal(r.fromCsv.rows, 3);
  for (const key of ['avg', 'max', 'min', 'range', 'count']) {
    assert.equal(r.screen[key], r.fromCsv[key], `${key} が一致しない`);
  }
  assert.equal(r.screen.avg, '-∞ dBFS');
  assert.equal(r.screen.min, '--.- dBFS');
});

test('統計: 母集団はフレーム数ではなく行数である', () => {
  // 改修前は毎フレーム（約60Hz）加算していたので、同じ記録でも
  // 描画が速い環境ほど n が増え、CSV から再現できなかった。
  // いまは行ごとに1回だけなので、n は必ず行数と一致する
  const recs = [-20, -30, -40].map((db, i) => buildIntervalRecord(msgForDb(i, db), ANCHOR, -60));
  const stats = createStats();
  for (const r of recs) addStatsSample(stats, r.rawDb);
  assert.equal(stats.n, recs.length);
  assert.equal(stats.finiteN, 3);
  assert.equal(formatStats(stats, recs.length).count, '3');
});

test('script.js: 統計を毎フレーム進めない（pushRecord からだけ呼ぶ）', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');
  const animate = src.slice(src.indexOf('function animate()'), src.indexOf('function exportCSV'));
  assert.ok(!/updateStats\(/.test(animate), 'animate() から updateStats を呼んでいる');
  const push = src.slice(src.indexOf('function pushRecord'), src.indexOf('function handleIntervalMessage'));
  assert.ok(/updateStats\(rec\.rawDb\)/.test(push),
    'pushRecord が rawDb で統計を進めていない');
});
