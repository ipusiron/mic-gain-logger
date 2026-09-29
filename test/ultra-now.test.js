'use strict';

// 超音波帯の現在値と、画面の数字とCSVの値の窓の違い（第2弾c0）。
//
// b4（2026-09-29 本人のiPhone）で、静かな部屋の超音波帯は-93〜-107dBFS（行の中央値）、22kHzのトーンは静寂より+1.9dBだった。
// 表示下限の既定（-90）より下なので、グラフの超音波帯の破線はいつも下端に張り付き、本人は「22kHzでは無音のようで、
// グラフにも出なかった」と見た（CSVには残っていた）。本人の決定＝(1)帯域ありの表示下限の既定を-110にする
// （test/meter-floor.test.js）(3)大きな音量の数字の近くに「超音波帯の現在値」を数字で出す。
//  - 値は、最後に記録した区間のband_ultra_dbfs（CSVに書く値と同じ。区間の長さはログ間隔）
//  - 大きな数字（直近METER_WINDOW_SAMPLESサンプル＝48kHzで約43ミリ秒の全帯域のRMS）とは窓が違うことが、
//    文言から分かるようにする（区間の長さを添える）
//  - 最初の区間が来るまでは「--.- dBFS」。?bands=off・簡易モード・超音波帯にビンが無いサンプルレートでは、
//    凡例と同じ判定（ultraBandState）で理由を出す。値の無い区間では「（この区間は値なし）」。統計リセットで最初に戻す
//  - 読み上げ領域（aria-live）を増やさない
// あわせて、画面の大きな数字とCSVのdbfsの窓の違いを、ヘルプ・大きな数字のtitle・READMEに書いた（b4の申し送り）。
// 窓が違うのは高精度モードだけで、簡易モードのCSVのdbfsは記録した瞬間の同じ窓の値なので、そう書き分けた（第2弾c0の点検）。
// 期待値は手で書かず、式（電力の和 ÷ フレーム数の10log10）やCSVの列の読み直しから出す。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  BAND_DEFS, BAND_ULTRA_KEY, ULTRA_STATE, ENGINE_WORKLET, ENGINE_FALLBACK, CSV_COLUMNS,
  METER_WINDOW_SAMPLES, meterWindowMs, framesForInterval,
  ultraNowText, ultraBandState, ultraLegendText, bandRangeLabel,
  buildIntervalRecord, buildFallbackRecord, buildSessionMeta, buildCsv
} = require('../logic.js');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'script.js'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
// 第2弾c1bでREADMEを入口にし、詳しい説明をdocs/へ分けた。READMEとdocs/を合わせたものが、分ける前のREADMEにあたる
const docsText = name => fs.readFileSync(path.join(root, 'docs', name), 'utf8');
const readmeAndDocs = [readme, ...fs.readdirSync(path.join(root, 'docs')).filter(n => n.endsWith('.md')).map(docsText)].join('\n');
const features = docsText('features.md');

const SR = 48000;
const ANCHOR = { epoch: 0, audioTime: 0, wallMs: Date.UTC(2026, 8, 29, 0, 0, 0) };
const ULTRA = BAND_DEFS.findIndex(d => d.key === BAND_ULTRA_KEY);
const HEAD_NO_SEC = '超音波帯（直近の区間）：';

// 1区間を作る。ultraPowerは超音波帯の電力の和（null＝値を送らない、0＝電力0）、framesは数えたフレーム数
function recordOf(o) {
  const opt = Object.assign({ sec: 1, count: null, ultraPower: 188 * 1e-9, frames: 188, bands: true }, o);
  const frames = framesForInterval(opt.sec, SR);
  const count = opt.count === null ? frames : opt.count;
  const power = BAND_DEFS.map((d, i) => (i === ULTRA ? opt.ultraPower : 188 * 1e-6));
  const msg = {
    type: 'interval', seq: 0, sampleRate: SR, startFrame: 0, endFrame: frames,
    expected: frames, count, sumSq: count * 1e-6, peak: 0.01, clip: 0, clipRun: 0,
    bandPower: opt.bands ? power : null,
    bandFrames: opt.bands ? opt.frames : null,
    bandExpected: opt.bands ? 188 : null
  };
  return buildIntervalRecord(msg, ANCHOR, -110, { meta: { id: 's1' } });
}

// CSVのband_ultra_dbfs列を読み直す（画面の値がCSVに書く値と同じかを見る）
function ultraCellOf(rec) {
  const lines = buildCsv([rec], { meta: {}, hashes: null }).split('\n');
  const header = lines.findIndex(l => l.startsWith(CSV_COLUMNS[0] + ','));
  const cols = lines[header].split(',');
  return lines[header + 1].split(',')[cols.indexOf('band_ultra_dbfs')];
}

const metaOf = (o) => buildSessionMeta(Object.assign({
  id: 's1', engine: ENGINE_WORKLET, contextSampleRate: SR, bandsEnabled: true,
  settings: { echoCancellation: false, autoGainControl: false, noiseSuppression: false }
}, o));

test('⭐最初の区間が来るまでは「--.- dBFS」（区間の長さはまだ書かない）', () => {
  // 記録前（測定条件なし）・記録を始めた直後（測定条件あり・区間なし）
  assert.equal(ultraNowText(ultraBandState(null, true), null), `${HEAD_NO_SEC}--.- dBFS`);
  assert.equal(ultraNowText(ultraBandState(metaOf(), true), null), `${HEAD_NO_SEC}--.- dBFS`);
});

test('⭐値は最後の区間のband_ultra_dbfsで、CSVに書く値と同じ。区間の長さ（ログ間隔）を添える', () => {
  for (const [sec, ultraPower, frames] of [[1, 188 * 6.76e-10, 188], [0.2, 37 * 3.1e-7, 37], [60, 11250 * 2.2e-11, 11250]]) {
    const rec = recordOf({ sec, ultraPower, frames });
    const db = 10 * Math.log10(ultraPower / frames);   // 素朴な式（帯域の平均二乗のdBFS）
    const expected = `超音波帯（直近${sec}秒の区間）：${db.toFixed(1)} dBFS`;
    assert.equal(ultraNowText(ULTRA_STATE.ON, rec), expected);
    // CSVの列（小数2桁）を1桁に丸めても同じ数字になる
    assert.equal(Number(ultraCellOf(rec)).toFixed(1), db.toFixed(1));
  }
});

test('区間の長さは、画面の設定ではなく、その区間を実際に測った長さ（レコードのintervalSec）', () => {
  // 設定を3秒へ変えた直後の区間は、まだ1秒で測っている（test/interval-label.test.jsと同じ考え方）
  const rec = recordOf({ sec: 1 });
  assert.equal(rec.intervalSec, framesForInterval(1, SR) / SR);
  assert.match(ultraNowText(ULTRA_STATE.ON, rec), /^超音波帯（直近1秒の区間）：/);
});

test('⭐値の無い区間は「--.- dBFS（この区間は値なし）」、デジタル無音は「-∞ dBFS」', () => {
  // 数えたフレームが0の区間（クォンタムが落ちて帯域を計算できなかった）
  const none = recordOf({ frames: 0 });
  assert.equal(none.bandDb[BAND_ULTRA_KEY], null);
  assert.equal(ultraCellOf(none), '', 'CSVでも空欄のはず');
  assert.equal(ultraNowText(ULTRA_STATE.ON, none), '超音波帯（直近1秒の区間）：--.- dBFS（この区間は値なし）');
  // 超音波帯の電力が0（デジタル無音）
  const silent = recordOf({ ultraPower: 0 });
  assert.equal(ultraCellOf(silent), '-Infinity');
  assert.equal(ultraNowText(ULTRA_STATE.ON, silent), '超音波帯（直近1秒の区間）：-∞ dBFS');
});

test('音が1つも届かなかった区間（dbfsが空欄）でも、帯域の値があれば出す（CSVと同じ）', () => {
  // 帯域のフレームは終わりを含む区間に数えるので、欠測の区間にも値が付くことがある（READMEの「帯域の列」）
  const rec = recordOf({ count: 0, ultraPower: 188 * 1e-9, frames: 188 });
  assert.equal(rec.missing, true);
  const db = 10 * Math.log10(1e-9);
  assert.equal(ultraNowText(ULTRA_STATE.ON, rec), `超音波帯（直近1秒の区間）：${db.toFixed(1)} dBFS`);
});

test('⭐?bands=off・簡易モード・超音波帯にビンが無いサンプルレートでは、凡例と同じ理由を出す', () => {
  const cases = [
    [metaOf({ bandsEnabled: false }), true, recordOf({ bands: false })],
    [null, false, null],   // ページのURLが?bands=off（記録前）
    [metaOf({ engine: ENGINE_FALLBACK }), true, buildFallbackRecord({
      seq: 0, db: -60, floorDb: -110, startTime: 0, endTime: 1,
      startWallMs: ANCHOR.wallMs, endWallMs: ANCHOR.wallMs + 1000, expectedSamples: SR, intervalSec: 1, meta: { id: 's1' }
    })],
    [metaOf({ contextSampleRate: 16000 }), true, null]
  ];
  const seen = new Set();
  for (const [meta, bandsOnPage, rec] of cases) {
    const state = ultraBandState(meta, bandsOnPage);
    assert.notEqual(state, ULTRA_STATE.ON);
    seen.add(state);
    // 凡例の文言（「超音波帯（18〜22kHz）：理由」）から理由を取り出し、同じ理由かを見る
    const legend = ultraLegendText(state);
    const reason = legend.slice(`超音波帯（${bandRangeLabel(BAND_DEFS[ULTRA])}）：`.length);
    assert.ok(reason.length > 0);
    assert.equal(ultraNowText(state, rec), HEAD_NO_SEC + reason);
    // 値の代わりに理由を出す（数字を出さない）
    assert.doesNotMatch(ultraNowText(state, rec), /dBFS/);
  }
  assert.deepEqual([...seen].sort(), [ULTRA_STATE.FALLBACK, ULTRA_STATE.NO_BINS, ULTRA_STATE.OFF].sort());
  // 3つの理由の言い回し（ヘルプの例と同じ）
  assert.equal(ultraNowText(ULTRA_STATE.OFF, null), `${HEAD_NO_SEC}止めています（?bands=off）`);
  assert.equal(ultraNowText(ULTRA_STATE.FALLBACK, null), `${HEAD_NO_SEC}簡易モードでは測れません`);
  assert.equal(ultraNowText(ULTRA_STATE.NO_BINS, null), `${HEAD_NO_SEC}このサンプルレートでは測れません`);
});

test('HTMLの初期の文言は、記録前のultraNowTextと同じ（読み込み直後に文字が変わらない）', () => {
  const m = html.match(/<div id="ultraNow" class="ultra-now"[^>]*>([^<]*)<\/div>/);
  assert.ok(m, '#ultraNowが無い');
  assert.equal(m[1], ultraNowText(ultraBandState(null, true), null));
  // 大きな数字のすぐ下に置く
  assert.match(html, /<div id="bigValue"[^>]*>[^<]*<\/div>\s*(?:<!--[\s\S]*?-->\s*)?<div id="ultraNow"/);
});

test('⭐読み上げ領域を増やさない（#ultraNowはaria-liveでなく、描き直しで読み上げ用の要素に触れない）', () => {
  const tag = html.match(/<div id="ultraNow"[^>]*>/)[0];
  assert.doesNotMatch(tag, /aria-live|role="status"|role="alert"/);
  const lives = (html.match(/aria-live=/g) || []).length;
  assert.equal(lives, 4, `aria-liveの数が変わった: ${lives}`);
  const start = script.indexOf('function renderUltraNow(');
  const body = script.slice(start, script.indexOf('\n  }', start));
  assert.doesNotMatch(body, /recordNoticeLiveEl|engineModeEl|statusEl|integrityEl/);
});

// ---- script.jsの配線（文言はlogic.jsで作り、DOMに入れるだけ） ----

function bodyOf(name) {
  const start = script.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name}が見つからない`);
  const next = script.indexOf('\n  function ', start + 10);
  const nextAsync = script.indexOf('\n  async function ', start + 10);
  const ends = [next, nextAsync].filter(i => i > 0);
  return script.slice(start, ends.length ? Math.min(...ends) : undefined)
    .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
}

test('⭐script.js：記録した区間で描き直し、記録開始とリセットで最初の状態に戻す', () => {
  // 第2弾c3aから、画面の言語（lang）で組み立てる
  assert.match(bodyOf('renderUltraNow'), /ultraNowText\(ultraBandState\(sessionMeta, bandsOnPage\), lastRecord, lang\)/);
  // 区間を記録したら、その区間（CSVに書くレコード）で描き直す
  const push = bodyOf('pushRecord');
  const i = push.indexOf('lastRecord = rec;');
  assert.ok(i > push.indexOf('logs.push(rec)'), '記録した区間を最後の区間にしていない');
  assert.ok(push.indexOf('renderUltraNow()', i) > i);
  // 凡例と同じ時点（起動・記録開始・リセット）で描き直す
  assert.match(bodyOf('renderBandInfo'), /renderUltraNow\(\);/);
  const start = bodyOf('start');
  const captured = start.indexOf('sessionMeta = captureSessionMeta()');
  const cleared = start.indexOf('lastRecord = null;');
  assert.ok(captured > 0 && cleared > captured && start.indexOf('renderBandInfo()', cleared) > cleared,
    '記録開始で前のセッションの値を残している');
  const reset = bodyOf('resetAllStats');
  const rc = reset.indexOf('lastRecord = null;');
  assert.ok(rc > 0 && reset.indexOf('renderBandInfo()', rc) > rc, '統計リセットで最初の状態に戻していない');
  // ここでdBFSを計算し直さない（CSVと同じ値を出すため、レコードの値をそのまま使う）
  assert.doesNotMatch(bodyOf('renderUltraNow'), /Math\.log10|toFixed|bandPower/);
});

// ---- 画面の数字とCSVの値の窓の違い ----

test('⭐大きな数字の窓（2048サンプル・48kHzで約43ミリ秒）は、script.jsの実装と同じ値から書く', () => {
  // script.jsがAnalyserNodeから読むサンプル数は、logic.jsの定数そのもの
  assert.match(script, /new Float32Array\(METER_WINDOW_SAMPLES\)/);
  assert.match(script, /analyser\.fftSize = METER_WINDOW_SAMPLES;/);
  assert.doesNotMatch(script, /Float32Array\(2048\)|fftSize = 2048/);
  const ms = Math.round(meterWindowMs(48000));
  assert.equal(ms, Math.round(METER_WINDOW_SAMPLES / 48000 * 1000));
  assert.equal(meterWindowMs(0), null);
  const n = `${METER_WINDOW_SAMPLES}サンプル`;
  const w = `48kHzで約${ms}ミリ秒`;
  const title = html.match(/<div id="bigValue"[^>]*title="([^"]*)"/)[1];
  const helpAt = html.indexOf('<strong>現在の音量（大きな数字）：</strong>');
  assert.ok(helpAt > 0, 'ヘルプに「現在の音量（大きな数字）：」が無い');
  const help = html.slice(helpAt, html.indexOf('</li>', helpAt));
  const readmeLine = features.split('\n').find(l => l.includes('画面の大きな数字は直近'));
  assert.ok(readmeLine, 'docs/features.mdに大きな数字の窓の説明が無い');
  for (const [where, text] of [['大きな数字のtitle', title], ['ヘルプ', help], ['docs/features.md', readmeLine]]) {
    assert.ok(text.includes(n), `${where}に「${n}」が無い`);
    assert.ok(text.includes(w), `${where}に「${w}」が無い`);
    assert.ok(text.includes('エネルギー平均'), `${where}にCSVの値（エネルギー平均）との違いが無い`);
    assert.ok(text.includes('dbfs'), `${where}にCSVのdbfs列の名前が無い`);
    assert.ok(text.includes('低く見える時間が長く'), `${where}に、揺れる音で画面の数字が低く見えることが無い`);
    // 窓が違うのは高精度モードだけ。簡易モードのCSVのdbfsは、記録した瞬間の同じ窓の値（第2弾c0の点検）
    assert.ok(text.includes('高精度モードのCSVの'), `${where}に、窓が違うのは高精度モードだという条件が無い`);
    assert.ok(/簡易モードでは、CSVの(<code>|`)?dbfs(<\/code>|`)?も記録した瞬間のこの窓の値/.test(text),
      `${where}に、簡易モードのCSVは同じ窓の値だという説明が無い`);
  }
  // READMEの「✨ 主な機能」の要約（第2弾c1bの点検で、2048を書き換えても落ちないと指摘された）。
  // 要点なので例（48kHzでのミリ秒・揺れる音）は docs/features.md に任せ、サンプル数と、窓が違うのは高精度モードのCSVだけを見る
  const summary = readme.split('\n').find(l => l.startsWith('- リアルタイム表示：'));
  assert.ok(summary, 'READMEの主な機能に「リアルタイム表示」の項目が無い');
  assert.ok(summary.includes(`大きな数字は直近${n}の値で、高精度モードのCSVの\`dbfs\`（区間全体のエネルギー平均）とは窓が違う`),
    `READMEの主な機能の要約が、窓（${n}）と条件（高精度モードのCSV）を書いていない`);
  // 前提：簡易モードは、大きな数字と同じ値（computeDb＝直近METER_WINDOW_SAMPLESサンプルのRMS）を記録している。
  // これが変わったら、上の説明を書き直す
  const anim = bodyOf('animate');
  assert.match(anim, /const db = computeDb\(\);/);
  assert.match(anim, /recordFallbackInterval\(db, /);
  assert.match(script, /function computeDb\(\) \{\s*analyser\.getFloatTimeDomainData\(buffer\);\s*return rmsToDbfs\(rmsOf\(buffer\)\);/);
});

test('超音波帯の現在値の説明（ヘルプ・title・README）が、窓の違いとCSVの列を言っている', () => {
  const helpAt = html.indexOf('<strong>超音波帯（直近の区間）：</strong>');
  assert.ok(helpAt > 0, 'ヘルプに「超音波帯（直近の区間）：」が無い');
  const help = html.slice(helpAt, html.indexOf('</li>', helpAt));
  const title = html.match(/<div id="ultraNow"[^>]*title="([^"]*)"/)[1];
  const readmeLine = features.split('\n').find(l => l.includes('超音波帯（直近1秒の区間）'));
  assert.ok(readmeLine, 'docs/features.mdに超音波帯の現在値の説明が無い');
  for (const [where, text] of [['ヘルプ', help], ['title', title], ['docs/features.md', readmeLine]]) {
    assert.ok(text.includes('band_ultra_dbfs'), `${where}にCSVの列名が無い`);
    assert.ok(text.includes('ログ間隔'), `${where}に区間の長さの説明が無い`);
    assert.ok(/窓も帯域も違|窓が違/.test(text), `${where}に大きな数字との窓の違いが無い`);
  }
  for (const reason of ['--.- dBFS', '（この区間は値なし）', '簡易モードでは測れません']) {
    assert.ok(help.includes(reason), `ヘルプに「${reason}」の説明が無い`);
  }
});

test('新しい画面の文言が、使わないと決めた語を含まない', () => {
  const texts = [];
  for (const state of Object.values(ULTRA_STATE)) texts.push(ultraNowText(state, null), ultraNowText(state, recordOf({})));
  texts.push(ultraNowText(ULTRA_STATE.ON, recordOf({ frames: 0 })));
  texts.push(html.match(/<div id="bigValue"[^>]*title="([^"]*)"/)[1]);
  texts.push(html.match(/<div id="ultraNow"[^>]*title="([^"]*)"/)[1]);
  for (const label of ['現在の音量（大きな数字）：', '超音波帯（直近の区間）：', '表示下限：', 'ボタンの配置：']) {
    const at = html.indexOf(`<strong>${label}</strong>`);
    assert.ok(at > 0, label);
    texts.push(html.slice(at, html.indexOf('</li>', at)));
  }
  const banned = ['検出', '効く', '効き', '効い', '走る', '走っ', '照合', '突き合わせ', '断定', '踏み込', '構図', '落とし穴', '破綻', '潰'];
  for (const t of texts) {
    for (const w of banned) assert.ok(!t.includes(w), `「${w}」が入っている: ${t}`);
  }
});
