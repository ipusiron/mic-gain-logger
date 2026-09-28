'use strict';

// 統計（Leq）を区間長で重み付けすることの検証。
//
// 第1弾で「画面とCSVの母集団をそろえる」は済んだが、重みが残っていた。
// 統計は全行を等しく数えていたのに、ログ間隔は記録中に変えられる
// （CSV のトレーラーは `# intervalSec=1+3` のように混在を明記している）。
// 1秒の区間と3秒の区間を同じ重みで平均すると、短い区間が実時間に不相応な
// 発言力を持って Leq が誤る。
//
// ここでは
//   1. ログ間隔が混ざった入力で、等重みの Leq と重み付きの Leq が違うこと
//   2. その重み付きの値が、CSV のタイムスタンプから第三者が組み直せること
//   3. 区間長がそろっていれば両者が一致すること（退化）
// を固定する。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createStats, addStatsSample, addStatsRecord, statsLeq, formatStats,
  recordDurationSec, buildIntervalRecord, buildCsv
} = require('../logic.js');

const SR = 48000;
const STARTED = '2026-09-29T00:00:00.000Z';
const ANCHOR = { epoch: 0, audioTime: 0, wallMs: Date.parse(STARTED) };

// spec = [{ db, lenSec }, ...] を連続する区間レコードの列にする。
// 区間の境界は隙間なく連なる（ワークレットが理想の境界を次の startFrame にする）
function recordsOf(spec) {
  let frame = 0;
  let seq = 0;
  return spec.map((s) => {
    const frames = Math.round(s.lenSec * SR);
    const rms = (s.db === -Infinity) ? 0 : Math.pow(10, s.db / 20);
    const rec = buildIntervalRecord({
      type: 'interval',
      seq: seq++,
      sampleRate: SR,
      startFrame: frame,
      endFrame: frame + frames,
      expected: frames,
      count: frames,
      sumSq: frames * rms * rms,
      peak: rms * Math.SQRT2,
      clip: 0,
      emittedAt: 0
    }, ANCHOR, -60);
    frame += frames;
    return rec;
  });
}

// いまの実装（区間長で重み付け）
function weightedLeq(recs) {
  const stats = createStats();
  for (const r of recs) addStatsRecord(stats, r);
  return statsLeq(stats);
}

// 改修前の実装（全行を等しく数える）。比較のためここに残す
function equalWeightLeq(recs) {
  const stats = createStats();
  for (const r of recs) addStatsSample(stats, r.rawDb);
  return statsLeq(stats);
}

// ---- CSV のテキストだけから重み付きの Leq を組み直す（第三者の再現）----
//
// timestamp 列は区間の「終わり」である。区間長は隣の行との差で取れる。
//
// ⚠ 1行目だけは前の行が無い。ここで `# started=` との差を使ってはいけない。
//    `# started=` は「1行目の区間の終わりの時刻」である（chainMetaOf が
//    firstRec.ts をそのまま載せている。アンカーは中断のたびに取り直すので
//    記録開始の時刻には使えないためである）。差を取ると必ず 0 になり、
//    1行目の重みが消える。実測では 0.2dB 低く出た。
//    1行目の長さは、トレーラーの `# intervalSec=` の最初の値を使う。
function weightedLeqFromCsv(csvText) {
  const lines = csvText.split('\n').filter(l => l.length);
  const pick = (key) => lines
    .filter(l => l.startsWith(`# ${key}=`))
    .map(l => l.slice(`# ${key}=`.length))[0];

  const firstLen = Number(String(pick('intervalSec') || '').split('+')[0]);
  assert.ok(firstLen > 0, 'トレーラーに # intervalSec= が無い');

  const data = lines.filter(l => !l.startsWith('#'));
  assert.equal(data[0], 'timestamp,dbfs,seq,peak_dbfs,clip,valid_ratio,hash', 'ヘッダーが違う');
  const rows = data.slice(1).map(line => {
    const cells = line.split(',');
    return {
      tMs: Date.parse(cells[0]),
      db: (cells[1] === '-Infinity') ? -Infinity : Number(cells[1])
    };
  });

  let energy = 0;   // Σ T_i * 10^(db_i/10)
  let totalSec = 0; // Σ T_i
  rows.forEach((r, i) => {
    const lenSec = (i === 0) ? firstLen : (r.tMs - rows[i - 1].tMs) / 1000;
    assert.ok(lenSec > 0, `区間長が正でない: ${i}`);
    energy += ((r.db === -Infinity) ? 0 : Math.pow(10, r.db / 10)) * lenSec;
    totalSec += lenSec;
  });
  return (energy > 0) ? 10 * Math.log10(energy / totalSec) : -Infinity;
}

test('区間長: 区間レコードから取れる（オーディオクロックの差）', () => {
  const recs = recordsOf([{ db: -20, lenSec: 1 }, { db: -20, lenSec: 3 }]);
  assert.equal(recordDurationSec(recs[0]), 1);
  assert.equal(recordDurationSec(recs[1]), 3);
  // startTime / endTime は連なっている（区間の隙間を作らない）
  assert.equal(recs[0].endTime, recs[1].startTime);
});

test('⭐ログ間隔が混ざると、等重みの Leq は重み付きの Leq と違う値になる', () => {
  // 静かな1秒が3つ、そのあと大きい3秒が1つ。実時間では大きい音が半分を占める
  const recs = recordsOf([
    { db: -40, lenSec: 1 },
    { db: -40, lenSec: 1 },
    { db: -40, lenSec: 1 },
    { db: -10, lenSec: 3 }
  ]);

  const weighted = weightedLeq(recs);
  const equal = equalWeightLeq(recs);

  // 期待値は定義式から独立に組む（実装の積み上げ方を借りない）
  const p40 = Math.pow(10, -40 / 10);
  const p10 = Math.pow(10, -10 / 10);
  // 重み付き: (1*p40*3 + 3*p10) / 6 秒
  const wantWeighted = 10 * Math.log10((3 * p40 + 3 * p10) / 6);
  // 等重み:   (3*p40 + p10) / 4 行
  const wantEqual = 10 * Math.log10((3 * p40 + p10) / 4);
  assert.ok(Math.abs(weighted - wantWeighted) < 1e-9, `weighted=${weighted}`);
  assert.ok(Math.abs(equal - wantEqual) < 1e-9, `equal=${equal}`);
  assert.equal(weighted.toFixed(1), '-13.0');
  assert.equal(equal.toFixed(1), '-16.0');
  // ⭐ここが本題。等重みと一致してはいけない
  assert.notEqual(weighted.toFixed(1), equal.toFixed(1));
  assert.ok(Math.abs(weighted - equal) > 2.9, `差が ${(weighted - equal).toFixed(4)} dB しかない`);
  // 大きい音が実時間の半分を占めるので、重み付きのほうが高く出る
  assert.ok(weighted > equal);

  // 画面の表示文字列でも違いが出る
  const stats = createStats();
  for (const r of recs) addStatsRecord(stats, r);
  assert.equal(formatStats(stats, recs.length).avg, '-13.0 dBFS');
  assert.equal(stats.weightSec, 6, '重みの総和が記録された実時間になっていない');
  assert.equal(stats.n, 4, '行数は行数のまま数える');
});

test('⭐長い静けさを短い大音量が上書きしない（重み付きのほうが低く出る側）', () => {
  // 大きい1秒のあと、静かな10秒。等重みだと大きい音が半分の発言力を持つ
  const recs = recordsOf([
    { db: -6, lenSec: 1 },
    { db: -60, lenSec: 10 }
  ]);
  const weighted = weightedLeq(recs);
  const equal = equalWeightLeq(recs);
  const p6 = Math.pow(10, -6 / 10);
  const p60 = Math.pow(10, -60 / 10);
  const wantWeighted = 10 * Math.log10((p6 + 10 * p60) / 11);   // 秒で割る
  const wantEqual = 10 * Math.log10((p6 + p60) / 2);            // 行で割る
  assert.ok(Math.abs(weighted - wantWeighted) < 1e-9, `weighted=${weighted}`);
  assert.ok(Math.abs(equal - wantEqual) < 1e-9, `equal=${equal}`);
  assert.equal(weighted.toFixed(1), '-16.4');
  assert.equal(equal.toFixed(1), '-9.0');
  assert.ok(Math.abs(weighted - equal) > 7.3, `差が ${(weighted - equal).toFixed(4)} dB しかない`);
  assert.ok(weighted < equal, 'こちらの向きでは重み付きのほうが低くなる');
});

test('区間長がそろっていれば、重み付きと等重みは一致する（退化）', () => {
  const recs = recordsOf([
    { db: -20, lenSec: 1 },
    { db: -35, lenSec: 1 },
    { db: -50, lenSec: 1 }
  ]);
  assert.ok(Math.abs(weightedLeq(recs) - equalWeightLeq(recs)) < 1e-12);

  // 1秒以外でそろえても一致する（重みの定数倍は平均を変えない）
  const long = recordsOf([
    { db: -20, lenSec: 10 },
    { db: -35, lenSec: 10 },
    { db: -50, lenSec: 10 }
  ]);
  assert.ok(Math.abs(weightedLeq(long) - equalWeightLeq(long)) < 1e-12);
  assert.ok(Math.abs(weightedLeq(long) - weightedLeq(recs)) < 1e-12);
});

test('無音の区間も区間長ぶんの重みで数える', () => {
  // 1秒の -20 と、9秒の無音。実時間の9割が無音なので Leq は 10dB 下がる
  const recs = recordsOf([
    { db: -20, lenSec: 1 },
    { db: -Infinity, lenSec: 9 }
  ]);
  const stats = createStats();
  for (const r of recs) addStatsRecord(stats, r);
  assert.equal(stats.weightSec, 10);
  assert.equal(stats.silentN, 1);
  // 1e-2 * 1 / 10 = 1e-3 -> -30.0 dB
  assert.ok(Math.abs(statsLeq(stats) - (-30)) < 1e-9, `${statsLeq(stats)}`);
  // 等重みなら (1e-2 + 0)/2 = 5e-3 -> -23.0 dB で、7dB 高く出ていた
  assert.ok(Math.abs(equalWeightLeq(recs) - (-23.0103)) < 1e-4);
});

test('⭐CSV のタイムスタンプから、第三者が同じ重み付きの Leq を出せる', () => {
  const recs = recordsOf([
    { db: -40, lenSec: 1 },
    { db: -40, lenSec: 1 },
    { db: -40, lenSec: 1 },
    { db: -10, lenSec: 3 }
  ]);
  // ヘッダーの started は script.js の chainMetaOf と同じものを入れる
  // （1行目の区間の終わりの時刻。記録開始の時刻ではない）
  const csv = buildCsv(recs, {
    engine: 'worklet',
    meta: { started: recs[0].ts.toISOString() },
    intervalSec: '1+3'
  });
  // 重みの根拠（区間長の混在）が CSV に残っていること
  assert.ok(csv.includes('# intervalSec=1+3'), 'トレーラーにログ間隔の混在が無い');

  const fromCsv = weightedLeqFromCsv(csv);
  const screen = weightedLeq(recs);
  assert.ok(Math.abs(fromCsv - screen) < 1e-6, `csv=${fromCsv} screen=${screen}`);
  assert.equal(fromCsv.toFixed(1), '-13.0');

  // ⚠ `# started=` は1行目の区間の終わりである。ここから差を取ると 0 になり、
  //    1行目の重みが消える。この落とし穴を固定しておく
  const startedLine = csv.split('\n').filter(l => l.startsWith('# started='))[0];
  assert.equal(startedLine, `# started=${recs[0].ts.toISOString()}`);
  assert.equal(Date.parse(startedLine.slice('# started='.length)), recs[0].ts.getTime());
});
