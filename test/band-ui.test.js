'use strict';

// 画面の帯域を固める（第2弾b3）。
//
// 第2弾b2までは、帯域の3列はCSVにだけ出ていた。b3で画面に出す。
//  - グラフ：本体の音量（実線）に、超音波帯の値（破線）を重ねる。凡例はキャンバスの外のHTMLに置き、
//    色と線の形の両方で示す
//  - 欠測の切れ目：音が1つも届かなかった行（rawDbがnull）は線を切る。改修前はdbToYが下端に置いていたので、
//    欠測がデジタル無音と同じ下端の線に見えていた。帯域の値が無い区間も、超音波帯の線を切る
//  - 統計：「超音波帯の最大」。⚠ デジタル無音の行に付いた帯域の値も数える（区間の境目の前の約21ミリ秒の
//    実際の音であり、架空の値ではない）。簡易モード・?bands=offでは「--.-」
//  - 注意書き：帯域の有効率が1.0を下回った区間、マイクとAudioContextのサンプルレートの食い違い、
//    ?bands=off、簡易モード、超音波帯を測れないサンプルレート
//  - 上限の表示：min(AudioContext ÷ 2, トラック ÷ 2)
// 計算・判定・文言はlogic.jsの関数で組み立て、ここで振る舞いを確かめる。script.jsはDOMに入れるだけ。
// 期待値は手で書かず、式や別の素朴な計算（配列の最大・最小、CSVの列の読み直し）から出す。
// ⚠ 帯域の値は「その帯域に音のエネルギーがあったか」の記録である。画面の文言も「検出」と読める書き方にしない。
//
// 第2弾b3の点検で直したこと：
//  - 凡例とキャンバスの説明が?bands=offだけを見ていた。簡易モードと超音波帯にビンが無いサンプルレートでも
//    「破線は超音波帯の値」と言い続け、描かれない線があると読めた→ultraBandStateの1つの判定にそろえた
//  - AudioContextが低いサンプルレートでトラックと食い違うと、「値は超音波帯の音を表しません」と
//    「空欄になります」が同時に出ていた→値があるとき（on）だけ前者を足す
//  - script.jsの配線のテストが文字列の有無しか見ておらず、線の色・形の入れ替えや凡例の付け外しの逆転が通った
//    →呼び出しの形を丸ごと縛り、凡例のクラス名をCSSと合わせて見る

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const logic = require('../logic.js');
const {
  BAND_DEFS, BAND_ULTRA_KEY, GRAPH_LINE_STYLES, GRAPH_WINDOW_SEC, GRAPH_TOP_DB,
  graphArea, timeToX, dbToY, seriesPointOf, pruneSeries, graphLinePoints,
  createStats, addStatsRecord, formatUltraMax, statsWarningItems, recordNoticeItems, bandNoticeItems,
  buildIntervalRecord, buildFallbackRecord, buildSessionMeta, bandPlan, buildCsv,
  recordableUpperHz, upperLimitText, formatKhz, bandRangeLabel, ultraLegendText, graphAriaLabel,
  ULTRA_STATE, ultraBandState, ultraSwatchShown,
  ENGINE_WORKLET, ENGINE_FALLBACK
} = logic;

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'script.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
// 第2弾c1bでREADMEを入口にし、詳しい説明をdocs/へ分けた。「帯域の列」はdocs/csv.mdにある。
// READMEとdocs/を合わせたものが、分ける前のREADMEにあたる
const docsText = name => fs.readFileSync(path.join(root, 'docs', name), 'utf8');
const csvDoc = docsText('csv.md');
const readmeAndDocs = [readme, ...fs.readdirSync(path.join(root, 'docs')).filter(n => n.endsWith('.md')).map(docsText)].join('\n');

const SR = 48000;
const ANCHOR = { epoch: 0, audioTime: 0, wallMs: Date.UTC(2026, 8, 29, 0, 0, 0) };
const ULTRA = BAND_DEFS.findIndex(d => d.key === BAND_ULTRA_KEY);
const ULTRA_DEF = BAND_DEFS[ULTRA];

// 1秒の区間を1つ作る。
//   db        区間のdBFS（-Infinity＝デジタル無音、null＝音が1つも届かなかった区間）
//   ultra     超音波帯のdBFS（null＝値が無い）。可聴帯はultraより10dB上に置く（使わない）
//   frames    数えたフレーム数。expectedは数えるはずだったフレーム数（帯域の有効率＝frames ÷ expected）
//   bands     falseなら帯域の値を送らない（?bands=offと同じ形）
function recordOf(seq, o) {
  const opt = Object.assign({ db: -20, ultra: -60, frames: 188, expected: 188, bands: true }, o);
  const count = opt.db === null ? 0 : SR;
  const sumSq = (opt.db === null || opt.db === -Infinity) ? 0 : count * Math.pow(10, opt.db / 10);
  const power = [];
  BAND_DEFS.forEach((d, i) => {
    const db = i === ULTRA ? opt.ultra : (opt.ultra === null ? null : opt.ultra + 10);
    power.push(db === null ? null : (db === -Infinity ? 0 : opt.frames * Math.pow(10, db / 10)));
  });
  const msg = {
    type: 'interval', seq, sampleRate: SR,
    startFrame: seq * SR, endFrame: (seq + 1) * SR,
    expected: SR, count, sumSq,
    peak: opt.db === null ? 0 : Math.sqrt(sumSq / Math.max(count, 1)) * Math.SQRT2,
    clip: 0, clipRun: 0,
    bandPower: opt.bands ? power : null,
    bandFrames: opt.bands ? opt.frames : null,
    bandExpected: opt.bands ? opt.expected : null
  };
  return buildIntervalRecord(msg, ANCHOR, -90, { meta: { id: opt.sid || 's1' } });
}

function fallbackOf(seq, db) {
  return buildFallbackRecord({
    seq, db, floorDb: -90,
    startTime: seq, endTime: seq + 1,
    startWallMs: ANCHOR.wallMs + seq * 1000, endWallMs: ANCHOR.wallMs + (seq + 1) * 1000,
    expectedSamples: SR, intervalSec: 1, meta: { id: 's1' }
  });
}

// script.jsのpushRecordと同じ手順で、グラフの点を積む
function seriesOf(recs) {
  const out = [];
  for (const r of recs) out.push(seriesPointOf(r, out[out.length - 1] || null, 1000));
  return out;
}

function viewAt(recs, width) {
  const last = recs[recs.length - 1];
  return {
    nowMs: last.ts.getTime(),
    windowMs: GRAPH_WINDOW_SEC * 1000,
    floorDb: -90,
    topDb: GRAPH_TOP_DB,
    area: graphArea(width || 800, 220)
  };
}

const drawable = (v) => typeof v === 'number' && !Number.isNaN(v) && v !== Infinity;

// 素朴な参照：値の無い点で区切った「つながった区間」の列を作り、各点のgapとaloneを決める
function referenceLine(series, key, view) {
  const runs = [];
  let cur = null;
  for (const p of series) {
    if (!drawable(p[key])) { cur = null; continue; }
    if (!cur || p.gap) { cur = []; runs.push(cur); }
    cur.push(p);
  }
  const out = [];
  for (const run of runs) {
    run.forEach((p, i) => out.push({
      x: timeToX(p.tMs, view.nowMs, view.windowMs, view.area),
      y: dbToY(p[key], view.floorDb, view.topDb, view.area),
      gap: i === 0,
      alone: run.length === 1
    }));
  }
  return out;
}

// ---- グラフの点 ----

test('⭐欠測の行（rawDbがnull）で本体の線を切る。デジタル無音は下端に描く', () => {
  const recs = [
    recordOf(0, { db: -20 }), recordOf(1, { db: -25 }),
    recordOf(2, { db: null }),                    // 音が1つも届かなかった区間
    recordOf(3, { db: -30 }), recordOf(4, { db: -Infinity }), recordOf(5, { db: -28 })
  ];
  assert.equal(recs[2].rawDb, null, '欠測の区間の前提が崩れた');
  const series = seriesOf(recs);
  const view = viewAt(recs);
  const pts = graphLinePoints(series, 'db', view);
  assert.deepEqual(pts, referenceLine(series, 'db', view));
  // 欠測の行は点にならない（改修前は下端に置かれ、デジタル無音と同じ線に見えた）
  assert.equal(pts.length, recs.filter(r => drawable(r.rawDb)).length);
  const afterMissing = pts[2];
  assert.equal(afterMissing.x, timeToX(recs[3].ts.getTime(), view.nowMs, view.windowMs, view.area));
  assert.equal(afterMissing.gap, true, '欠測をまたいで線がつながっている');
  // デジタル無音は測った値なので、線をつないだまま下端に描く
  const silent = pts[3];
  assert.equal(silent.y, view.area.y + view.area.h);
  assert.equal(silent.gap, false);
});

test('帯域の値が無い区間で、超音波帯の線を切る', () => {
  const recs = [
    recordOf(0, { ultra: -62 }), recordOf(1, { ultra: -58 }),
    recordOf(2, { ultra: -60, frames: 0 }),        // 数えたフレームが0→値が無い
    recordOf(3, { ultra: -55 }),
    recordOf(4, { ultra: -57 }), recordOf(5, { ultra: -Infinity })
  ];
  assert.equal(recs[2].bandDb[BAND_ULTRA_KEY], null, '値の無い区間の前提が崩れた');
  const series = seriesOf(recs);
  // 点は超音波帯の値を持つ（本体の値とは別）
  series.forEach((p, i) => assert.equal(p.ultraDb, recs[i].bandDb[BAND_ULTRA_KEY]));
  const view = viewAt(recs);
  const pts = graphLinePoints(series, 'ultraDb', view);
  assert.deepEqual(pts, referenceLine(series, 'ultraDb', view));
  assert.equal(pts.length, 5);
  assert.equal(pts[2].gap, true, '値の無い区間をまたいで破線がつながっている');
  // 本体の線は、帯域の値が無くても切れない
  const level = graphLinePoints(series, 'db', view);
  assert.equal(level.filter(p => p.gap).length, 1);
  // 超音波帯の-Infinity（電力0）も下端に描く
  assert.equal(pts[pts.length - 1].y, view.area.y + view.area.h);
});

test('前後どちらともつながらない点にはaloneを立てる（線にならない点を丸で描くため）', () => {
  const recs = [
    recordOf(0, { db: null }), recordOf(1, { db: -40 }), recordOf(2, { db: null }),
    recordOf(3, { db: -41 }), recordOf(4, { db: -42 })
  ];
  const series = seriesOf(recs);
  const view = viewAt(recs);
  const pts = graphLinePoints(series, 'db', view);
  assert.deepEqual(pts, referenceLine(series, 'db', view));
  assert.deepEqual(pts.map(p => p.alone), [true, false, false]);
});

test('セッションの切り替わり・時刻の跳び（既存のgap）は、どちらの線でも切る', () => {
  const recs = [
    recordOf(0, { sid: 's1' }), recordOf(1, { sid: 's1' }),
    recordOf(2, { sid: 's2' }), recordOf(3, { sid: 's2' })
  ];
  const series = seriesOf(recs);
  assert.equal(series[2].gap, true);
  const view = viewAt(recs);
  for (const key of ['db', 'ultraDb']) {
    const pts = graphLinePoints(series, key, view);
    assert.deepEqual(pts, referenceLine(series, key, view));
    assert.deepEqual(pts.map(p => p.gap), [true, false, true, false], key);
  }
});

test('簡易モード・?bands=offの行は、超音波帯の点を持たない（線を描かない）', () => {
  const recs = [fallbackOf(0, -20), fallbackOf(1, -22), recordOf(2, { bands: false }), recordOf(3, { bands: false })];
  const series = seriesOf(recs);
  for (const p of series) assert.equal(p.ultraDb, null);
  const view = viewAt(recs);
  assert.deepEqual(graphLinePoints(series, 'ultraDb', view), []);
  assert.equal(graphLinePoints(series, 'db', view).length, 4);
});

test('縦軸・表示下限・窓の外の扱いは既存のdbToY・timeToX・pruneSeriesのまま', () => {
  const recs = [];
  for (let i = 0; i < 90; i++) recs.push(recordOf(i, { db: -10 - (i % 50), ultra: -40 - (i % 30) }));
  const view = viewAt(recs, 390);
  view.floorDb = -60;   // 表示下限より下の値は下端へ寄せる（dbToYの約束）
  const series = pruneSeries(seriesOf(recs), view.nowMs, view.windowMs);
  for (const key of ['db', 'ultraDb']) {
    const pts = graphLinePoints(series, key, view);
    assert.equal(pts.length, series.length);
    pts.forEach((p, i) => {
      assert.equal(p.y, dbToY(series[i][key], view.floorDb, GRAPH_TOP_DB, view.area));
      assert.ok(p.x >= view.area.x && p.x <= view.area.x + view.area.w, '枠の外へ出た');
    });
  }
});

// ---- 統計：超音波帯の最大 ----

// 素朴な参照：CSVのband_ultra_dbfs列（ヘッダー行から位置を読む）の最大
function ultraMaxFromCsv(recs) {
  const lines = buildCsv(recs, { engine: 'worklet' }).split('\n').filter(l => l && !l.startsWith('#'));
  const col = lines[0].split(',').indexOf('band_ultra_dbfs');
  assert.ok(col > 0, 'band_ultra_dbfsの列が無い');
  const vals = lines.slice(1).map(l => l.split(',')[col]).filter(c => c !== '')
    .map(c => (c === '-Infinity' ? -Infinity : Number(c)));
  if (!vals.length) return '--.- dBFS';
  const m = Math.max(...vals);
  return m === -Infinity ? '-∞ dBFS' : `${m.toFixed(1)} dBFS`;
}

const statsOf = (recs) => {
  const s = createStats();
  recs.forEach(r => addStatsRecord(s, r));
  return s;
};

test('⭐超音波帯の最大はband_ultra_dbfsの最大で、CSVから読み直した値と一致する', () => {
  const recs = [-61.2, -48.37, -70, -52.5].map((u, i) => recordOf(i, { ultra: u }));
  const expected = Math.max(...recs.map(r => r.bandDb[BAND_ULTRA_KEY]));
  assert.equal(formatUltraMax(statsOf(recs)), `${expected.toFixed(1)} dBFS`);
  assert.equal(formatUltraMax(statsOf(recs)), ultraMaxFromCsv(recs));
});

test('⭐デジタル無音の行（dbfsが-Infinity）に付いた帯域の値も数える', () => {
  // 境目の前の約21ミリ秒の実際の音が、後ろの区間に入る（READMEの「帯域の列」）。架空の値ではない
  const recs = [recordOf(0, { db: -30, ultra: -70 }), recordOf(1, { db: -Infinity, ultra: -45 }), recordOf(2, { db: -31, ultra: -66 })];
  assert.equal(recs[1].rawDb, -Infinity);
  const stats = statsOf(recs);
  const expected = Math.max(...recs.map(r => r.bandDb[BAND_ULTRA_KEY]));
  assert.equal(expected, recs[1].bandDb[BAND_ULTRA_KEY], '無音の行の値が最大になる組み立てになっていない');
  assert.equal(formatUltraMax(stats), `${expected.toFixed(1)} dBFS`);
  assert.equal(formatUltraMax(stats), ultraMaxFromCsv(recs));
  // 既存の統計（最大・最小）はこれまでどおり無音の行を外す
  assert.equal(stats.maxDb, Math.max(recs[0].rawDb, recs[2].rawDb));
});

test('欠測の行に付いた帯域の値も数え、値の無い行は除く', () => {
  const recs = [recordOf(0, { ultra: -70 }), recordOf(1, { db: null, ultra: -50 }), recordOf(2, { ultra: -40, frames: 0 })];
  assert.equal(recs[1].missing, true);
  assert.equal(recs[2].bandDb[BAND_ULTRA_KEY], null);
  const stats = statsOf(recs);
  const vals = recs.map(r => r.bandDb[BAND_ULTRA_KEY]).filter(v => v !== null);
  assert.equal(stats.ultraKnownN, vals.length);
  assert.equal(formatUltraMax(stats), `${Math.max(...vals).toFixed(1)} dBFS`);
  assert.equal(formatUltraMax(stats), ultraMaxFromCsv(recs));
});

test('簡易モード・?bands=off・記録前・リセット直後は「--.- dBFS」（測れないものを異常なしとして出さない）', () => {
  assert.equal(formatUltraMax(statsOf([fallbackOf(0, -20), fallbackOf(1, -30)])), '--.- dBFS');
  assert.equal(formatUltraMax(statsOf([recordOf(0, { bands: false }), recordOf(1, { bands: false })])), '--.- dBFS');
  assert.equal(formatUltraMax(createStats()), '--.- dBFS');
  assert.equal(formatUltraMax(null), '--.- dBFS');
  // -Infinityだけなら、サンプルピークと同じく-∞と出す（測った結果が電力0）
  const silent = [recordOf(0, { db: -Infinity, ultra: -Infinity }), recordOf(1, { db: -Infinity, ultra: -Infinity })];
  assert.equal(formatUltraMax(statsOf(silent)), '-∞ dBFS');
  assert.equal(formatUltraMax(statsOf(silent)), ultraMaxFromCsv(silent));
});

// ---- 注意書き：帯域の有効率 ----

test('⭐帯域の有効率が1.0を下回った区間の件数と最小値を、有効サンプル率と同じ書き方で出す', () => {
  const plan = [[188, 188], [150, 188], [188, 188], [94, 188], [187, 188]];
  const recs = plan.map(([f, e], i) => recordOf(i, { frames: f, expected: e }));
  const ratios = recs.map(r => r.bandValidRatio);
  const low = ratios.filter(v => v < 1);
  const pct = (Math.min(...ratios) * 100).toFixed(1);
  const item = statsWarningItems(statsOf(recs)).find(it => it.kind === 'bandValid');
  assert.ok(item, '帯域の有効率の項目が無い');
  assert.equal(item.short, `帯域の有効率 最小${pct}%`);
  assert.ok(item.full.includes(`${low.length}件`), item.full);
  assert.ok(item.full.includes(`最小 ${pct}%`), item.full);
  assert.ok(item.full.includes('band_valid_ratio'), 'CSVの列名が無い');
  // 画面の注意書きにも入る（recordNoticeItemsは統計から項目を取る）
  assert.ok(recordNoticeItems({ stats: statsOf(recs) }).some(it => it.kind === 'bandValid'));
});

test('帯域の有効率がすべて1、または値が無い（簡易モード・?bands=off）なら項目を出さない', () => {
  const full = [0, 1, 2].map(i => recordOf(i));
  assert.deepEqual(statsWarningItems(statsOf(full)), []);
  assert.deepEqual(statsWarningItems(statsOf([fallbackOf(0, -20), recordOf(1, { bands: false })])), []);
});

test('統計リセット（createStatsの作り直し）で、帯域の数も消える', () => {
  const s = createStats();
  for (const k of ['ultraKnownN', 'bandValidKnownN', 'lowBandValidRows']) assert.equal(s[k], 0, k);
  assert.equal(s.ultraMaxDb, -Infinity);
  assert.equal(s.minBandValidRatio, Infinity);
});

// ---- 注意書き：測定条件から決まるもの ----

const QUIET = { echoCancellation: false, autoGainControl: false, noiseSuppression: false };
const metaOf = (o) => buildSessionMeta(Object.assign({
  id: 's1', engine: ENGINE_WORKLET, contextSampleRate: 48000, bandsEnabled: true,
  settings: QUIET
}, o));
const withTrack = (trackSr, o) => metaOf(Object.assign({}, o, { settings: Object.assign({ sampleRate: trackSr }, QUIET) }));

// 素朴な参照：超音波帯にビンがあるか＝ナイキスト周波数が超音波帯の下端に届くか
const ultraHasBins = (rate) => rate / 2 >= ULTRA_DEF.lo;

test('⭐マイクの音声トラックとAudioContextのサンプルレートが違えば、両方の値と変換の影響を出す', () => {
  const cases = [[48000, 44100], [44100, 48000], [96000, 48000], [48000, 16000]];
  for (const [ctxSr, trackSr] of cases) {
    const meta = withTrack(trackSr, { contextSampleRate: ctxSr });
    const items = recordNoticeItems({ sessionMeta: meta });
    const it = items.find(i => i.kind === 'sampleRateMismatch');
    assert.ok(it, `${ctxSr}/${trackSr}で項目が無い`);
    const tK = formatKhz(trackSr);
    const cK = formatKhz(ctxSr);
    assert.ok(it.short.includes(`${tK}kHz`) && it.short.includes(`${cK}kHz`), it.short);
    assert.ok(it.full.includes('サンプルレートの変換で、上限に近い高い音は低く記録されます'), it.full);
    assert.ok(it.full.includes(`約${formatKhz(Math.min(ctxSr, trackSr) / 2)}kHz`), it.full);
    // 上限が超音波帯の下端より下なら、その帯域の値が超音波帯の音を表さないことも言う
    assert.equal(it.full.includes('超音波帯の音を表しません'), Math.min(ctxSr, trackSr) / 2 < ULTRA_DEF.lo, it.full);
  }
});

test('⭐超音波帯の値が無いとき（AudioContextが低い・簡易モード・?bands=off）は「表しません」を足さない', () => {
  // AudioContext 16kHz・トラック44.1kHz：超音波帯にビンが無いので値は空欄。「表しません」と「空欄」が同時に出ると食い違う
  const low = withTrack(44100, { contextSampleRate: 16000 });
  const items = bandNoticeItems(low);
  const mismatch = items.find(i => i.kind === 'sampleRateMismatch');
  assert.ok(mismatch, '食い違いの項目が無い');
  assert.ok(!mismatch.full.includes('超音波帯の音を表しません'), mismatch.full);
  assert.deepEqual(items.map(i => i.kind), ['sampleRateMismatch', 'ultraUnavailable']);
  // トラックのほうが低くても、値が無ければ足さない
  for (const o of [{ engine: ENGINE_FALLBACK }, { bandsEnabled: false }]) {
    const it = bandNoticeItems(withTrack(16000, o)).find(i => i.kind === 'sampleRateMismatch');
    assert.ok(it && !it.full.includes('超音波帯の音を表しません'), JSON.stringify(o));
  }
  // 値があって、トラックが上限を下げているときだけ足す
  const byTrack = bandNoticeItems(withTrack(16000)).find(i => i.kind === 'sampleRateMismatch');
  assert.ok(byTrack.full.includes('超音波帯の音を表しません'), byTrack.full);
});

test('サンプルレートが一致する・トラックが報告しないときは、食い違いの項目を出さない', () => {
  const same = withTrack(48000);
  assert.ok(!recordNoticeItems({ sessionMeta: same }).some(i => i.kind === 'sampleRateMismatch'));
  const unreported = metaOf({});
  assert.equal(unreported.trackSampleRate, null);
  assert.deepEqual(recordNoticeItems({ sessionMeta: unreported }), []);
});

test('?bands=offなら「帯域の計算を止めています」を出す', () => {
  const items = recordNoticeItems({ sessionMeta: metaOf({ bandsEnabled: false }) });
  assert.deepEqual(items.map(i => i.kind), ['bandsOff']);
  assert.ok(items[0].full.includes('帯域の計算を止めています（?bands=off）'), items[0].full);
  assert.ok(items[0].short.includes('?bands=off'));
});

test('簡易モードなら「帯域を計算していない」を出す（第2弾b3の点検で追加）', () => {
  const items = recordNoticeItems({ sessionMeta: metaOf({ engine: ENGINE_FALLBACK }) });
  assert.deepEqual(items.map(i => i.kind), ['bandsFallback']);
  assert.ok(items[0].short.includes('簡易モード'), items[0].short);
  assert.ok(items[0].full.includes('帯域の3列は空欄'), items[0].full);
  // 簡易モードで?bands=offなら、止めていることのほうを出す（2つ並べない）
  assert.deepEqual(bandNoticeItems(metaOf({ engine: ENGINE_FALLBACK, bandsEnabled: false })).map(i => i.kind), ['bandsOff']);
});

test('超音波帯にビンが無いサンプルレートでは「測れない」を出す（高精度モードで帯域を計算するときだけ）', () => {
  for (const rate of [8000, 16000, 22050, 32000, 44100, 48000, 96000]) {
    const items = bandNoticeItems(metaOf({ contextSampleRate: rate }));
    const has = items.some(i => i.kind === 'ultraUnavailable');
    assert.equal(has, !ultraHasBins(rate), `rate=${rate}`);
    // logic.jsのbandPlan（ワークレットへ渡す計画）とも合う
    const ultra = bandPlan(rate).bands.find(b => b.key === BAND_ULTRA_KEY);
    assert.equal(has, ultra.binLo === null, `rate=${rate}`);
  }
  // 簡易モードではbandsFallback、?bands=offではbandsOffが言うので、ここでは出さない
  assert.deepEqual(bandNoticeItems(metaOf({ contextSampleRate: 16000, engine: ENGINE_FALLBACK })).map(i => i.kind), ['bandsFallback']);
  assert.deepEqual(bandNoticeItems(metaOf({ contextSampleRate: 16000, bandsEnabled: false })).map(i => i.kind), ['bandsOff']);
});

test('記録を始める前（測定条件が無い）は、帯域の注意を出さない', () => {
  assert.deepEqual(bandNoticeItems(null), []);
  assert.deepEqual(recordNoticeItems({}), []);
});

// ---- 上限の表示 ----

test('⭐この端末で記録できる上限＝min(AudioContext ÷ 2, トラック ÷ 2)', () => {
  const cases = [[48000, 48000], [48000, 44100], [44100, 48000], [48000, 16000], [96000, 48000], [48000, null], [44100, undefined]];
  for (const [ctxSr, trackSr] of cases) {
    const u = recordableUpperHz(ctxSr, trackSr);
    const known = Number.isFinite(trackSr);
    const expected = (known ? Math.min(ctxSr, trackSr) : ctxSr) / 2;
    assert.equal(u.hz, expected, `${ctxSr}/${trackSr}`);
    assert.equal(u.trackKnown, known);
    const text = upperLimitText({ contextSampleRate: ctxSr, trackSampleRate: known ? trackSr : null });
    assert.ok(text.startsWith(`この端末で記録できる上限：約${formatKhz(expected)}kHz`), text);
    assert.equal(text.includes('トラックの値は不明'), !known, text);
    // 括弧の中で、どのサンプルレートの半分かを言う（同じなら1つ、違えば両方）
    if (!known) {
      assert.ok(text.includes(`AudioContext ${formatKhz(ctxSr)}kHzの半分`), text);
    } else if (ctxSr === trackSr) {
      assert.ok(text.includes(`サンプルレート${formatKhz(ctxSr)}kHzの半分`), text);
      assert.ok(!text.includes('小さいほう'), text);
    } else {
      assert.ok(text.includes(`マイク${formatKhz(trackSr)}kHz`) && text.includes(`AudioContext ${formatKhz(ctxSr)}kHz`), text);
      assert.ok(text.includes('小さいほうの半分'), text);
    }
  }
  // AudioContextのサンプルレートが分からない（記録前・リセット後）は出さない
  assert.equal(recordableUpperHz(null, 48000), null);
  assert.equal(upperLimitText(null), '');
});

test('kHzの書き方は小数2桁までで、末尾の0を付けない', () => {
  for (const hz of [8000, 11025, 16000, 18000, 22000, 22050, 24000, 44100, 48000, 88200, 96000]) {
    // 素朴な参照：小数2桁に丸めてから、末尾の0と小数点を落とす
    const naive = (hz / 1000).toFixed(2).replace(/\.?0+$/, '');
    assert.equal(formatKhz(hz), naive, `${hz}`);
  }
  assert.equal(bandRangeLabel(ULTRA_DEF), `${formatKhz(ULTRA_DEF.lo)}〜${formatKhz(ULTRA_DEF.hi)}kHz`);
});

// ---- 超音波帯の線を描けるか（凡例・キャンバスの説明・注意書きが同じ判定を使う） ----

test('⭐線を描けるかは、ページのURL・計測エンジン・サンプルレートの3つで決まる', () => {
  // 記録を始める前は、ページのURLだけで決まる
  assert.equal(ultraBandState(null, true), ULTRA_STATE.ON);
  assert.equal(ultraBandState(null, false), ULTRA_STATE.OFF);
  for (const engine of [ENGINE_WORKLET, ENGINE_FALLBACK]) {
    for (const bandsEnabled of [true, false]) {
      for (const rate of [16000, 32000, 44100, 48000, 96000]) {
        const meta = metaOf({ engine, bandsEnabled, contextSampleRate: rate });
        // 素朴な参照：止めていればoff、簡易モードならfallback、ビンが無ければnoBins、それ以外はon
        const expected = !bandsEnabled ? ULTRA_STATE.OFF
          : engine === ENGINE_FALLBACK ? ULTRA_STATE.FALLBACK
            : !ultraHasBins(rate) ? ULTRA_STATE.NO_BINS
              : ULTRA_STATE.ON;
        assert.equal(ultraBandState(meta, true), expected, `${engine}/${bandsEnabled}/${rate}`);
        // ページのURLで止めていれば、メタがどうでもoff
        assert.equal(ultraBandState(meta, false), ULTRA_STATE.OFF);
        // 見本の線は、線を描くときだけ出す
        assert.equal(ultraSwatchShown(ultraBandState(meta, true)), expected === ULTRA_STATE.ON);
        // 注意書きは、描かないとき、理由の項目をちょうど1つ出す
        const reasons = bandNoticeItems(meta).map(i => i.kind)
          .filter(k => ['bandsOff', 'bandsFallback', 'ultraUnavailable'].includes(k));
        assert.equal(reasons.length, expected === ULTRA_STATE.ON ? 0 : 1, `${engine}/${bandsEnabled}/${rate}`);
      }
    }
  }
});

test('⭐凡例の見本の線を出すときは、グラフに超音波帯の点がある（凡例と実際の線を合わせる）', () => {
  const cases = [
    { meta: metaOf({}), recs: [recordOf(0), recordOf(1)] },
    { meta: metaOf({ bandsEnabled: false }), recs: [recordOf(0, { bands: false }), recordOf(1, { bands: false })] },
    { meta: metaOf({ engine: ENGINE_FALLBACK }), recs: [fallbackOf(0, -20), fallbackOf(1, -21)] },
    // ビンが無い帯域は、ワークレットが値を送らない（bandDbがnull）
    { meta: metaOf({ contextSampleRate: 16000 }), recs: [recordOf(0, { ultra: null }), recordOf(1, { ultra: null })] }
  ];
  for (const { meta, recs } of cases) {
    const state = ultraBandState(meta, true);
    const series = seriesOf(recs);
    const pts = graphLinePoints(series, 'ultraDb', viewAt(recs));
    assert.equal(ultraSwatchShown(state), pts.length > 0, state);
  }
});

test('⭐凡例の超音波帯の項目：描くときだけ「破線」と書き、描かないときは理由を出す', () => {
  const range = bandRangeLabel(ULTRA_DEF);
  const on = ultraLegendText(ULTRA_STATE.ON);
  assert.ok(on.includes('破線') && on.includes(range), on);
  const reasons = {
    [ULTRA_STATE.OFF]: '止めています（?bands=off）',
    [ULTRA_STATE.FALLBACK]: '簡易モードでは測れません',
    [ULTRA_STATE.NO_BINS]: 'このサンプルレートでは測れません'
  };
  for (const [state, reason] of Object.entries(reasons)) {
    const text = ultraLegendText(state);
    assert.ok(text.includes(range) && text.includes(reason), text);
    assert.ok(!text.includes('破線'), `描かない線を破線と呼んでいる: ${text}`);
  }
});

test('⭐キャンバスの説明（aria-label）：描くときだけ破線があると書き、描かないときは理由を言う', () => {
  const range = bandRangeLabel(ULTRA_DEF);
  const on = graphAriaLabel(ULTRA_STATE.ON);
  assert.ok(on.includes(`破線は超音波帯（${range}）の値`), on);
  for (const state of [ULTRA_STATE.OFF, ULTRA_STATE.FALLBACK, ULTRA_STATE.NO_BINS]) {
    const text = graphAriaLabel(state);
    assert.ok(!text.includes('破線'), `無い線があると伝えている: ${text}`);
    // 凡例と同じ理由を言う
    const legendReason = ultraLegendText(state).split('：').pop();
    assert.ok(text.includes(legendReason), text);
    assert.ok(text.includes('実線は音量（全帯域）'), text);
  }
  const canvasTag = html.match(/<canvas id="levelCanvas"[^>]*>/)[0];
  assert.match(canvasTag, /role="img"/);
  // 初めの説明はlogic.jsの組み立てと同じ（script.jsが起動時に同じ関数で差し替える）
  assert.ok(canvasTag.includes(`aria-label="${graphAriaLabel(ULTRA_STATE.ON)}"`), canvasTag);
});

test('⭐凡例はキャンバスの外のHTMLにあり、色と線の形（実線・破線）の両方で示す', () => {
  const canvasAt = html.indexOf('<canvas id="levelCanvas"');
  const legendAt = html.indexOf('<ul class="graph-legend"');
  assert.ok(canvasAt > 0 && legendAt > canvasAt, '凡例がキャンバスの後ろに無い');
  const legend = html.slice(legendAt, html.indexOf('</ul>', legendAt));
  assert.ok(legend.includes('実線：音量（全帯域）'));
  assert.ok(legend.includes(ultraLegendText(ULTRA_STATE.ON)), '凡例の初めの文言がlogic.jsと違う');
  // 見本の破線は、グラフの破線と同じ間隔
  const dash = legend.match(/class="legend-swatch legend-ultra"[\s\S]*?stroke-dasharray="([^"]+)"/);
  assert.ok(dash, '凡例の超音波帯に破線が無い');
  assert.equal(dash[1], GRAPH_LINE_STYLES.ultra.dash.join(' '));
  assert.ok(GRAPH_LINE_STYLES.ultra.dash.length > 0, 'グラフの超音波帯が破線でない');
  assert.equal(GRAPH_LINE_STYLES.level.dash.length, 0, 'グラフの本体の線が実線でない');
  const level = legend.match(/<svg class="legend-swatch legend-level"[\s\S]*?<\/svg>/)[0];
  assert.doesNotMatch(level, /stroke-dasharray/);
  // 見本の線の太さも、グラフの線と同じ
  assert.match(level, new RegExp(`stroke-width="${GRAPH_LINE_STYLES.level.width}"`));
  const ultraSvg = legend.match(/<svg class="legend-swatch legend-ultra"[\s\S]*?<\/svg>/)[0];
  assert.match(ultraSvg, new RegExp(`stroke-width="${GRAPH_LINE_STYLES.ultra.width}"`));
  // 色はテーマのトークン
  assert.match(css, /\.legend-level\{color:var\(--plot\)\}/);
  assert.match(css, /\.legend-ultra\{color:var\(--plot-ultra\)\}/);
});

test('凡例・上限の表示は読み上げ領域にしない（#recordNoticeLiveだけで流す）', () => {
  const legendTag = html.match(/<ul class="graph-legend"[^>]*>/)[0];
  const limitTag = html.match(/<p id="upperLimit"[^>]*>/)[0];
  for (const tag of [legendTag, limitTag]) assert.doesNotMatch(tag, /aria-live|role="status"/);
  const body = script.slice(script.indexOf('function renderBandInfo'), script.indexOf('function updateStats'));
  assert.doesNotMatch(body, /recordNoticeLiveEl|engineModeEl/, '凡例の描き直しで読み上げ領域に書いている');
});

// ---- script.jsの配線（DOMに入れるだけ） ----

function bodyOf(name) {
  const start = script.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name}が見つからない`);
  const next = script.indexOf('\n  function ', start + 10);
  const nextAsync = script.indexOf('\n  async function ', start + 10);
  const ends = [next, nextAsync].filter(i => i > 0);
  return script.slice(start, ends.length ? Math.min(...ends) : undefined)
    .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
}

test('⭐script.jsは、本体を--plotの実線、超音波帯を--plot-ultraの破線で描く（色と形の組を入れ替えない）', () => {
  const draw = bodyOf('drawSeries');
  // 点・色・線の形の組を、呼び出しの形のまま縛る（色だけ・形だけの入れ替えも落ちる）
  assert.match(draw, /strokeSeries\(graphLinePoints\(series, 'db', view\), col\.plot, GRAPH_LINE_STYLES\.level\)/);
  assert.match(draw, /strokeSeries\(graphLinePoints\(series, 'ultraDb', view\), col\.plotUltra, GRAPH_LINE_STYLES\.ultra\)/);
  assert.equal((draw.match(/strokeSeries\(/g) || []).length, 2, '線の数が2本でない');
  // 点の位置をここで計算し直さない
  assert.doesNotMatch(draw.slice(draw.indexOf('graphLinePoints')), /timeToX\(p\.tMs|dbToY\(p\./);
  // 色の出どころ：col.plotは--plot、col.plotUltraは--plot-ultra（凡例のCSSと同じトークン）
  const colors = bodyOf('graphColors');
  assert.match(colors, /\bplot: pick\('--plot',/);
  assert.match(colors, /\bplotUltra: pick\('--plot-ultra',/);
});

test('script.jsのstrokeSeriesは、線の形を反映し、gapで線を切り、aloneの点を丸で描く', () => {
  const stroke = bodyOf('strokeSeries');
  assert.match(stroke, /ctx\.lineWidth = style\.width;/);
  assert.match(stroke, /ctx\.setLineDash\(style\.dash\);/);
  assert.match(stroke, /ctx\.strokeStyle = color;/);
  assert.match(stroke, /if \(p\.gap\) ctx\.moveTo\(p\.x, p\.y\);\s*else ctx\.lineTo\(p\.x, p\.y\);/);
  // aloneの点は同じ色で、塗った丸にする（線にならない点が消えないように）
  assert.match(stroke, /ctx\.fillStyle = color;/);
  assert.match(stroke, /if \(!p\.alone\) continue;\s*ctx\.beginPath\(\);\s*ctx\.arc\(p\.x, p\.y, style\.width, 0, Math\.PI \* 2\);\s*ctx\.fill\(\);/);
});

test('統計の「超音波帯の最大」を、統計の更新とリセットの両方で描き直す', () => {
  // 第2弾c3aで見出しに辞書のキー（data-i18n）を付けたので、属性を許して見る
  assert.match(html, /<div class="stat-label"[^>]*>超音波帯の最大<\/div>\s*<div id="ultraMaxDb" class="stat-value">--\.- dBFS<\/div>/);
  assert.match(bodyOf('renderUltraStat'), /formatUltraMax\(stats\)/);
  assert.match(bodyOf('updateStats'), /renderUltraStat\(\)/);
  assert.match(bodyOf('resetStats'), /renderUltraStat\(\)/);
});

test('⭐凡例・キャンバスの説明は、セッションのメタとページのURLから決めた1つの状態で描き直す', () => {
  const info = bodyOf('renderBandInfo');
  assert.match(info, /const state = ultraBandState\(sessionMeta, bandsOnPage\);/);
  // 第2弾c3aから、文言は画面の言語（lang）で組み立てる
  assert.match(info, /legendUltraTextEl\.textContent = ultraLegendText\(state, lang\)/);
  assert.match(info, /upperLimitEl\.textContent = upperLimitText\(sessionMeta, lang\)/);
  assert.match(info, /canvas\.setAttribute\('aria-label', graphAriaLabel\(state, lang\)\)/);
  // 見本の線を隠すクラスは、線を描かないときに付ける。付け外しの向きと、CSSのクラス名を合わせて縛る
  const toggle = info.match(/legendUltraEl\.classList\.toggle\('([\w-]+)', !ultraSwatchShown\(state\)\)/);
  assert.ok(toggle, '凡例の見本の線の付け外しが、ultraSwatchShownの逆になっていない');
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(stripped.includes(`.legend-item.${toggle[1]} .legend-swatch{display:none}`),
    `CSSに.legend-item.${toggle[1]}で見本の線を隠す規則が無い`);
  // 付け外しする要素は、凡例の超音波帯の項目（class="legend-item"）である
  assert.match(script, /const legendUltraEl = document\.getElementById\('legendUltra'\);/);
  assert.match(html, /<li class="legend-item" id="legendUltra"/);
  assert.match(script, /const legendUltraTextEl = document\.getElementById\('legendUltraText'\);/);
  assert.match(html, /<span id="legendUltraText">/);
});

test('凡例・上限の表示を、起動時・記録開始時（測定条件を取ったあと）・リセットで描き直す', () => {
  const start = bodyOf('start');
  const captured = start.indexOf('sessionMeta = captureSessionMeta()');
  assert.ok(captured > 0 && start.indexOf('renderBandInfo()', captured) > captured, '測定条件を取ったあとに描き直していない');
  // 計測エンジンを決めてから測定条件を取る（簡易モードの判定がメタに入るように）
  const engineSet = start.indexOf('engineMode = ENGINE_WORKLET');
  assert.ok(engineSet > 0 && engineSet < captured, '計測エンジンを決める前に測定条件を取っている');
  assert.match(bodyOf('captureSessionMeta'), /engine: engineMode,/);
  const reset = bodyOf('resetAllStats');
  assert.ok(reset.indexOf('renderBandInfo()') > reset.indexOf('sessionMeta = null'), 'リセットで上限の表示を消していない');
  assert.match(script, /\/\/ 初期\n\s*renderEngineMode\(\);\n\s*renderBandInfo\(\);/);
});

// ---- 見た目（CSS）・ヘルプ・README ----

test('超音波帯の色は両テーマのトークンで、凡例の規則は幅の@mediaより前にある', () => {
  const rootBlock = css.slice(css.indexOf(':root{'), css.indexOf('}', css.indexOf(':root{')));
  const light = css.slice(css.indexOf('body.light{'));
  assert.match(rootBlock, /--plot-ultra:#[0-9a-fA-F]{6};/);
  assert.match(light, /--plot-ultra:#[0-9a-fA-F]{6};/);
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const firstMedia = stripped.search(/@media\s*\(\s*max-width/);
  for (const sel of ['.graph-legend{', '.graph-limit{', '.legend-item.stopped .legend-swatch{']) {
    const at = stripped.indexOf(sel);
    assert.ok(at > 0 && at < firstMedia, `${sel}が@mediaの後ろにある`);
  }
  assert.match(stripped, /\.graph-limit:empty\{display:none\}/);
});

test('ヘルプが帯域の線・統計・注意書き・上限・?bands=offを説明している', () => {
  // 第2弾c3aで見出しに辞書のキー（data-i18n）を付けたので、属性を許して探す
  const head = html.search(/<h3[^>]*>📊 統計と表示<\/h3>/);
  const tail = html.search(/<h3[^>]*>💾 データの取り扱い<\/h3>/);
  const block = html.slice(head, tail);
  for (const label of ['超音波帯の最大：', 'リアルタイムグラフ：', '記録できる上限：', '帯域の注意書き：', '?bands=off：']) {
    assert.ok(block.includes('<strong>' + label + '</strong>'), `ヘルプに「${label}」が無い`);
  }
  assert.ok(block.includes('破線'), 'グラフの破線の説明が無い');
  assert.ok(block.includes('線を切ります'), '欠測で線を切る説明が無い');
  assert.ok(block.includes('簡易モードでは測れません'), '線を描かないときの凡例の説明が無い');
  assert.ok(block.includes('簡易モードで帯域を計算していないとき'), '簡易モードの注意書きの説明が無い');
});

test('「超音波帯の最大」は、デジタル無音と欠測の行に付いた値も数えることを、ヘルプ・統計のtitle・docs/csv.mdの3か所で言う', () => {
  // 第2弾c3aで項目・枠に辞書のキー（data-i18n-rich・data-i18n-title）を付けたので、属性を許して見る
  const help = html.match(/<li[^>]*><strong>超音波帯の最大：<\/strong>([\s\S]*?)<\/li>/)[1];
  const title = html.match(/<div class="stat"[^>]*\stitle="([^"]*)">\s*<div class="stat-label"[^>]*>超音波帯の最大/)[1];
  const readmeLine = csvDoc.split('\n').find(l => l.includes('画面の統計「超音波帯の最大」は、デジタル無音の行に付いた帯域の値も数える'));
  assert.ok(readmeLine, 'docs/csv.mdの「帯域の列」に説明が無い');
  for (const [where, text] of [['ヘルプ', help], ['統計のtitle', title], ['docs/csv.md', readmeLine]]) {
    assert.ok(text.includes('デジタル無音'), `${where}にデジタル無音の行の説明が無い`);
    assert.ok(text.includes('音が1つも届かなかった区間の行に付いた値も'), `${where}に欠測の行の説明が無い`);
  }
});

test('READMEとdocs/が画面の帯域を説明し、「CSVにだけ出ます」を残していない', () => {
  assert.ok(!readmeAndDocs.includes('帯域の3列は、いまはCSVにだけ出ます'), 'b2のときの説明が残っている');
  for (const s of ['超音波帯の最大', 'この端末で記録できる上限', '破線', 'band-ui.test.js', '簡易モードでは測れません']) {
    assert.ok(readmeAndDocs.includes(s), `READMEとdocs/に「${s}」が無い`);
  }
});

// ---- 文言の約束 ----

test('新しい画面の文言が「検出」や使わないと決めた語を含まない', () => {
  const texts = [];
  for (const state of Object.values(ULTRA_STATE)) texts.push(ultraLegendText(state), graphAriaLabel(state));
  texts.push(
    upperLimitText({ contextSampleRate: 48000, trackSampleRate: 44100 }),
    upperLimitText({ contextSampleRate: 48000 }),
    upperLimitText({ contextSampleRate: 48000, trackSampleRate: 48000 })
  );
  for (const meta of [
    withTrack(16000), metaOf({ bandsEnabled: false }), metaOf({ contextSampleRate: 16000 }),
    metaOf({ engine: ENGINE_FALLBACK }), withTrack(44100, { contextSampleRate: 16000 })
  ]) {
    for (const it of bandNoticeItems(meta)) texts.push(it.short, it.full);
  }
  const low = [recordOf(0, { frames: 100, expected: 188 })];
  for (const it of statsWarningItems(statsOf(low))) texts.push(it.short, it.full);
  // 凡例・上限・統計のtitle（HTML）
  const legendAt = html.indexOf('<ul class="graph-legend"');
  texts.push(html.slice(legendAt, html.indexOf('</p>', legendAt)));
  texts.push(html.match(/<div class="stat"[^>]*\stitle="([^"]*)">\s*<div class="stat-label"[^>]*>超音波帯の最大/)[1]);
  const banned = ['検出', '効く', '効き', '効い', '走る', '走っ', '照合', '突き合わせ', '断定', '踏み込', '構図', '落とし穴', '破綻', '潰'];
  for (const t of texts) {
    for (const w of banned) assert.ok(!t.includes(w), `「${w}」が入っている: ${t}`);
  }
});
