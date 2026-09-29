'use strict';

// 段階2の2番。デジタル無音を記録に残す。
//
// 改修前はワークレットが正しく出した無音区間（rawDb = -Infinity）を
// script.js 側で捨てていたため、CSV には無標識の穴だけが残った。
// 「音がなかった」と「記録していなかった」が区別できないなら、
// 記録として読めない。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  clipForDisplay,
  formatCsvDb,
  buildCsv,
  buildIntervalRecord,
  buildFallbackRecord,
  CSV_COLUMNS
} = require('../logic.js');

test('clipForDisplay: 有限値だけを表示下限で切る。無音は通す', () => {
  assert.equal(clipForDisplay(-20, -60), -20);
  assert.equal(clipForDisplay(-80, -60), -60);
  assert.equal(clipForDisplay(-60, -60), -60);
  // -Infinity を下限へ丸めると「測っていない値」を作ってしまう
  assert.equal(clipForDisplay(-Infinity, -60), -Infinity);
  assert.equal(clipForDisplay(-Infinity, -120), -Infinity);
});

test('formatCsvDb: 有限値は小数2桁、無音は -Infinity', () => {
  assert.equal(formatCsvDb(-20), '-20.00');
  assert.equal(formatCsvDb(-59.987), '-59.99');
  assert.equal(formatCsvDb(0), '0.00');
  assert.equal(formatCsvDb(-Infinity), '-Infinity');
  // 有限の測定値としては読めない。読み戻せば -Infinity に戻る
  assert.equal(Number.isFinite(Number(formatCsvDb(-Infinity))), false);
  assert.equal(Number(formatCsvDb(-Infinity)), -Infinity);
});

function message(seq, over) {
  return Object.assign({
    type: 'interval',
    seq,
    sampleRate: 48000,
    startFrame: seq * 48000,
    endFrame: (seq + 1) * 48000,
    expected: 48000,
    count: 48000,
    sumSq: 48000 * 0.01,     // RMS 0.1 = -20 dBFS
    peak: 0.1 * Math.SQRT2,
    clip: 0,
    emittedAt: seq + 1
  }, over || {});
}

const ANCHOR = { epoch: 0, audioTime: 0, wallMs: Date.UTC(2026, 8, 28, 5, 0, 0) };

test('無音の区間: rawDb も db も -Infinity のまま、silent が立つ', () => {
  // 全サンプルが0（sumSq=0）。サンプルは届いているので validRatio は 1
  const rec = buildIntervalRecord(message(0, { sumSq: 0, peak: 0 }), ANCHOR, -60);
  assert.equal(rec.rawDb, -Infinity);
  assert.equal(rec.db, -Infinity);
  assert.equal(rec.silent, true);
  assert.equal(rec.validRatio, 1);
  assert.equal(rec.sampleCount, 48000);
  assert.equal(rec.clipCount, 0);
});

test('表示下限より小さいだけの音は無音ではない（従来どおり下限で切る）', () => {
  const rec = buildIntervalRecord(message(0, { sumSq: 48000 * 1e-8 }), ANCHOR, -60);
  assert.ok(Math.abs(rec.rawDb + 80) < 1e-9);
  assert.equal(rec.db, -60);
  assert.equal(rec.silent, false);
});

test('簡易モードでも無音は -Infinity のまま残る', () => {
  const rec = buildFallbackRecord({
    seq: 0,
    db: -Infinity,
    floorDb: -60,
    startTime: 0,
    endTime: 1,
    startWallMs: ANCHOR.wallMs,
    endWallMs: ANCHOR.wallMs + 1000,
    expectedSamples: 48000
  });
  assert.equal(rec.rawDb, -Infinity);
  assert.equal(rec.db, -Infinity);
  assert.equal(rec.silent, true);
});

test('CSV: 無音の行が出て、印の行が末尾のトレーラーに付く', () => {
  // ⚠⚠ 2026-09-29 に、この印を鎖の起点（ヘッダー）からトレーラーへ移した。
  //    無音は記録が終わってから分かる事実なので、起点に入れると
  //    無音の行が1行増えるだけで1行目のハッシュまで変わっていた。
  const t = (sec) => new Date(ANCHOR.wallMs + sec * 1000);
  const logs = [
    { ts: t(1), rawDb: -20, db: -20 },
    { ts: t(2), rawDb: -Infinity, db: -Infinity },
    { ts: t(3), rawDb: -20, db: -20 }
  ];
  const csv = buildCsv(logs, { engine: 'worklet' });
  const lines = csv.split('\n');
  const at = lines.indexOf(CSV_COLUMNS.join(','));
  const head = lines.slice(0, at);
  const trailer = lines.slice(at + 1).filter(l => l.startsWith('#'));
  const dataLines = lines.filter(l => l && !l.startsWith('#'));

  // ヘッダーの本数には依存しない（段階4で項目が増えた）。印の位置だけ見る
  assert.ok(head.includes('# engine=worklet'));
  assert.ok(trailer.includes('# silence=-Infinity'), trailer.join(' / '));
  assert.ok(!head.join('\n').includes('silence'), '起点に無音の印が混ざっている');
  assert.equal(dataLines[0], 'timestamp,dbfs,seq,peak_dbfs,clip,valid_ratio,band_ultra_dbfs,band_audible_dbfs,band_valid_ratio,hash');
  assert.equal(dataLines.length, 4);   // ヘッダー＋3行

  // B列（dbfs）が -Infinity であること。列の増減に強い見方をする
  assert.equal(dataLines[2].split(',')[1], '-Infinity');
  assert.equal(dataLines[2].split(',')[0], '2026-09-28T05:00:02.000Z');
});

test('CSV: 無音が1行もなければ印の行は出ない（既存の出力を変えない）', () => {
  const logs = [{ ts: new Date('2026-09-28T05:00:01.000Z'), rawDb: -20, db: -20 }];
  const csv = buildCsv(logs, { engine: 'worklet' });
  const metaLines = csv.split('\n').filter(l => l.startsWith('#'));
  // 印が出ないことだけを見る（メタ行の項目そのものは段階4で増えた）
  assert.equal(metaLines.filter(l => l.includes('silence')).length, 0, metaLines.join(' / '));
  const row = csv.split('\n').filter(l => l && !l.startsWith('#')).pop();
  assert.equal(row.split(',')[1], '-20.00');
});

test('音→無音→音: 行が1つも欠けず、無音の区間が読み取れる', () => {
  // 1秒間隔で 10 区間の音、10 区間の無音、10 区間の音
  const msgs = [];
  for (let i = 0; i < 30; i++) {
    const silent = i >= 10 && i < 20;
    msgs.push(message(i, silent ? { sumSq: 0, peak: 0 } : {}));
  }
  const recs = msgs.map(m => buildIntervalRecord(m, ANCHOR, -60));

  // 改修前の振る舞い（有限でない行を捨てる）なら 20 行しか残らなかった
  const oldWay = recs.filter(r => Number.isFinite(r.rawDb));
  assert.equal(oldWay.length, 20);
  const oldGaps = oldWay.map((r, i) => i === 0 ? 0
    : (r.ts.getTime() - oldWay[i - 1].ts.getTime()) / 1000);
  assert.equal(Math.max(...oldGaps), 11);   // 無標識の 11 秒の穴

  // 改修後は 30 行そろい、間隔はすべて 1 秒
  assert.equal(recs.length, 30);
  const gaps = recs.slice(1).map((r, i) => (r.ts.getTime() - recs[i].ts.getTime()) / 1000);
  assert.deepEqual(Array.from(new Set(gaps)), [1]);
  assert.equal(recs.filter(r => r.silent).length, 10);

  // CSV でも無音の区間が10行ぶん読み取れる
  const all = buildCsv(recs, { engine: 'worklet' }).split('\n');
  const body = all.filter(l => l && !l.startsWith('#')).slice(1);   // ヘッダーを除く
  const col = (line, i) => line.split(',')[i];
  assert.equal(body.length, 30);
  // 末尾一致は列が増えると壊れるので、B列を明示的に見る
  assert.equal(body.filter(l => col(l, 1) === '-Infinity').length, 10);
  assert.equal(col(body[10], 0), '2026-09-28T05:00:11.000Z');
  assert.equal(col(body[10], 1), '-Infinity');
  assert.equal(col(body[19], 1), '-Infinity');
  assert.equal(col(body[20], 0), '2026-09-28T05:00:21.000Z');
  assert.equal(col(body[20], 1), '-20.00');
});
