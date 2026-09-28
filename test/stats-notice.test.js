'use strict';

// 真のピーク・クリップ数・有効サンプル率を画面へ出すことの検証。
//
// この3つは段階1から区間レコードに入っていて CSV にも書いていたのに、
// 画面ではひとつも使っていなかった。追加の計測をせずに、記録の信用に
// 直結する情報が手に入る状態だったということである。
//
//   ピーク       統計の項目にする（区間の真のピークの最大）
//   クリップ     注意書きにする。クリップした区間は波形が ±1.0 で頭打ちになり、
//                そこで生まれた高調波が広い帯域へ散るので、その区間の値は読めない
//   有効サンプル率 注意書きにする（1.0 を下回った区間＝欠測のあった区間）
//
// ⚠ ボタンは増やさない（style.css の 480px 分岐と handleMobileButtonLayout が
//    壊れやすいため）。統計欄の項目と、既存の状態表示（#recordNotice）に載せる。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  createStats, addStatsRecord, formatStats, statsWarnings, emptyStatsText,
  buildIntervalRecord, buildFallbackRecord
} = require('../logic.js');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'script.js'), 'utf8');

const SR = 48000;
const ANCHOR = { epoch: 0, audioTime: 0, wallMs: Date.UTC(2026, 8, 29, 0, 0, 0) };

// over で peak / clip / count を差し替えられる1区間（既定は 1 秒・-20 dBFS・欠測なし）
function recordOf(seq, over) {
  const rms = 0.1;   // -20 dBFS
  const msg = Object.assign({
    type: 'interval',
    seq,
    sampleRate: SR,
    startFrame: seq * SR,
    endFrame: (seq + 1) * SR,
    expected: SR,
    count: SR,
    sumSq: SR * rms * rms,
    peak: rms * Math.SQRT2,
    clip: 0,
    emittedAt: seq + 1
  }, over);
  return buildIntervalRecord(msg, ANCHOR, -60);
}

function statsOf(recs) {
  const stats = createStats();
  for (const r of recs) addStatsRecord(stats, r);
  return stats;
}

// ---- ピーク ----

test('ピーク: 区間の真のピークの最大を統計に出す（RMS の最大とは別の値）', () => {
  // 3区間とも RMS は -20 dBFS。2つめだけ瞬間的に大きい
  const recs = [
    recordOf(0, { peak: 0.1 * Math.SQRT2 }),   // -17.0 dBFS
    recordOf(1, { peak: 0.5 }),                // -6.0 dBFS
    recordOf(2, { peak: 0.1 * Math.SQRT2 })
  ];
  const text = formatStats(statsOf(recs), recs.length);
  assert.equal(text.max, '-20.0 dBFS', 'RMS の最大が動いている');
  assert.equal(text.peak, '-6.0 dBFS');
  // ピークは必ず RMS 以上である（同じ区間の中で）
  assert.ok(statsOf(recs).peakMaxDb > statsOf(recs).maxDb);
});

test('ピーク: 0 dBFS（フルスケール）まで出る', () => {
  const text = formatStats(statsOf([recordOf(0, { peak: 1 })]), 1);
  assert.equal(text.peak, '0.0 dBFS');
});

test('ピーク: 無音だけなら -∞。簡易モードでは「不明」のまま', () => {
  const silent = statsOf([recordOf(0, { sumSq: 0, peak: 0 })]);
  assert.equal(formatStats(silent, 1).peak, '-∞ dBFS');

  // 簡易モードは瞬時値しか無いので peakDb が null で来る
  const fb = buildFallbackRecord({
    seq: 0, db: -20, floorDb: -60,
    startTime: 0, endTime: 1,
    startWallMs: ANCHOR.wallMs, endWallMs: ANCHOR.wallMs + 1000,
    expectedSamples: SR
  });
  assert.equal(fb.peakDb, null);
  const stats = statsOf([fb]);
  assert.equal(stats.peakKnownN, 0);
  assert.equal(formatStats(stats, 1).peak, '--.- dBFS', '測れないのに値を出している');
  assert.equal(emptyStatsText().peak, '--.- dBFS');
});

// ---- クリップ ----

test('クリップ: 1区間でもあれば注意書きを出し、区間の数と延べサンプル数を言う', () => {
  const recs = [
    recordOf(0),
    recordOf(1, { peak: 1, clip: 12 }),
    recordOf(2),
    recordOf(3, { peak: 1, clip: 5 })
  ];
  const warns = statsWarnings(statsOf(recs));
  assert.equal(warns.length, 1);
  assert.match(warns[0], /クリップを2区間で検出/);
  assert.match(warns[0], /延べ17サンプル/);
  // ⭐クリップした区間の値は読めない、と言い切る（第2弾で帯域を見る前提になる）
  assert.match(warns[0], /その区間の値は読めません/);
});

test('クリップ: 無ければ何も出さない', () => {
  assert.deepEqual(statsWarnings(statsOf([recordOf(0), recordOf(1)])), []);
  assert.deepEqual(statsWarnings(createStats()), []);
  assert.deepEqual(statsWarnings(null), []);
});

// ---- 有効サンプル率 ----

test('有効サンプル率: 1.0 を下回った区間があれば、件数と最小値を出す', () => {
  const recs = [
    recordOf(0),                          // 48000/48000 = 1.0
    recordOf(1, { count: SR - 128 }),     // 0.99733…
    recordOf(2, { count: SR / 2 })        // 0.5
  ];
  const stats = statsOf(recs);
  assert.equal(stats.validKnownN, 3);
  assert.equal(stats.lowValidRows, 2);
  assert.equal(stats.minValidRatio, 0.5);
  const warns = statsWarnings(stats);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /1\.0を下回った区間が2件/);
  assert.match(warns[0], /最小 50\.0%/);
  assert.match(warns[0], /valid_ratio/, 'CSV のどの列を見ればよいか書いていない');
});

test('有効サンプル率: ちょうど 1.0 の区間は数えない', () => {
  const stats = statsOf([recordOf(0), recordOf(1), recordOf(2)]);
  assert.equal(stats.lowValidRows, 0);
  assert.equal(stats.minValidRatio, 1);
  assert.deepEqual(statsWarnings(stats), []);
});

test('有効サンプル率: 簡易モードは「不明」として数に入れない', () => {
  const fb = buildFallbackRecord({
    seq: 0, db: -20, floorDb: -60,
    startTime: 0, endTime: 1,
    startWallMs: ANCHOR.wallMs, endWallMs: ANCHOR.wallMs + 1000,
    expectedSamples: SR
  });
  assert.equal(fb.validRatio, null);
  const stats = statsOf([fb]);
  assert.equal(stats.validKnownN, 0);
  assert.equal(stats.lowValidRows, 0);
  assert.deepEqual(statsWarnings(stats), [], '測れないのに欠測だと言っている');
});

test('クリップと欠測が同時にあれば2件出る', () => {
  const recs = [recordOf(0, { peak: 1, clip: 3, count: SR - 1 })];
  assert.equal(statsWarnings(statsOf(recs)).length, 2);
});

// ---- 画面との結線 ----

test('画面: 統計欄にピークの枠があり、script.js が書き込んでいる', () => {
  assert.match(html, /id="peakDb"/, 'index.html にピークの枠が無い');
  assert.match(html, /<div class="stat-label">真のピーク<\/div>/);
  assert.match(script, /peakEl\.textContent = text\.peak/, 'script.js がピークを書いていない');
  // ピークの枠には「RMS とは別物である」ことの説明を付ける
  const m = html.match(/<div class="stat"[^>]*title="([^"]*)"[^>]*>\s*<div class="stat-label">真のピーク/);
  assert.ok(m, 'ピークの枠に title が無い');
  assert.match(m[1], /RMS/);
});

test('画面: クリップと欠測は既存の状態表示へ出す（ボタンを増やさない）', () => {
  // ⚠ 3つ目のボタンを handleMobileButtonLayout へ乗せない、という約束がある
  const ids = [...html.matchAll(/<button[^>]*id="([^"]+)"/g)].map(m => m[1]).sort();
  assert.deepEqual(ids, [
    'controlsToggle', 'exportBtn', 'helpBtn', 'resetBtn',
    'startBtn', 'stopBtn', 'themeToggle'
  ]);
  // 注意書きは #recordNotice にまとめる
  assert.match(script, /for \(const w of statsWarnings\(stats\)\) parts\.push\(w\)/,
    'renderRecordNotice が統計の注意書きを取り込んでいない');
  // 出たその区間で画面へ出す（停止まで待たない）
  const upd = script.slice(script.indexOf('function updateStats'), script.indexOf('function resetStats'));
  assert.match(upd, /renderRecordNotice\(\)/, 'updateStats が注意書きを更新していない');
  // 統計リセットで注意書きも消す（統計と同じ母集団から出ているため）
  const reset = script.slice(script.indexOf('function resetStats'), script.indexOf('function setStatus'));
  assert.match(reset, /statsNoticeCount = 0/);
  assert.match(reset, /renderRecordNotice\(\)/);
});

test('画面: クレストファクターは出さない（第3弾の診断へ回す）', () => {
  // 判断の記録。ピーク − Leq は計算できるが、
  //   1. セッション全体の最大ピークと全体の Leq の差は、音響で言うクレストファクター
  //      （区間ごとのピーク／RMS 比）ではない。3時間の記録では「いちばん大きかった
  //      一発が全体平均より何dB上か」になり、衝撃音と定常音の切り分けにはならない
  //   2. 区間ごとの分布を持たせれば正しく出せるが、それは新しい計算であり、
  //      検出・診断は第3弾の範囲である
  // ので、この弾では出さない。出すときは項目名を「クレストファクター」にせず、
  // 区間ごとの値の分布から作ること
  assert.ok(!html.includes('クレストファクター'), 'クレストファクターの枠が増えている');
  assert.ok(!('crest' in emptyStatsText()), '統計にクレストファクターが入っている');
});
