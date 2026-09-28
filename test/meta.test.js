'use strict';

// 段階2の5番。測定条件をセッションのメタデータとして残す。
//
// AGC・ノイズ抑制・エコーキャンセルを「無効で」と要求しても、実際に
// 無効になったかは track.getSettings() の実値でしか分からない。
// AGC が効いていると入力の利得が勝手に動くので、dBFS の値そのものが
// 測定値として信用できなくなる。
// CSV の列は増やさない（列の確定は段階4）。内部のレコードから参照する。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  PROCESSING_KEYS,
  PROCESSING_OPTIONAL_KEYS,
  PROCESSING_OFF,
  PROCESSING_ACTIVE,
  PROCESSING_UNKNOWN,
  buildSessionMeta,
  processingVerdict,
  buildIntervalRecord,
  buildFallbackRecord,
  buildCsv,
  CSV_COLUMNS
} = require('../logic.js');

const REQUESTED = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false
};

// Chromium 145 の疑似デバイスが実際に返した値（measure/stage2_meta.py の実測、
// 2026-09-28）。トラックの sampleRate が 44100 なのに AudioContext は 48000 で
// 動いていた。両方を別々に持つ理由がこれである。
const REAL_SETTINGS = {
  autoGainControl: false,
  channelCount: 2,
  deviceId: 'default',
  echoCancellation: false,
  groupId: 'd307858b35dede56ec225be3cbbac0a1086b4c2e871d2a247e5e7aef756a1e89',
  latency: 0.01,
  noiseSuppression: false,
  sampleRate: 44100,
  sampleSize: 16,
  voiceIsolation: false
};

function meta(settings, over) {
  return buildSessionMeta(Object.assign({
    id: 's1',
    startedWallMs: Date.UTC(2026, 8, 28, 7, 0, 0),
    engine: 'worklet',
    contextSampleRate: 48000,
    deviceLabel: 'Fake Default Audio Input',
    requested: REQUESTED,
    settings,
    userAgent: 'test-agent',
    timeZone: 'Asia/Tokyo'
  }, over || {}));
}

test('buildSessionMeta: getSettings の実値をそのまま持つ', () => {
  const m = meta(REAL_SETTINGS);
  assert.equal(m.id, 's1');
  assert.equal(m.engine, 'worklet');
  // トラックと AudioContext でサンプルレートが違う。両方を残す
  assert.equal(m.contextSampleRate, 48000);
  assert.equal(m.trackSampleRate, 44100);
  assert.notEqual(m.trackSampleRate, m.contextSampleRate);
  assert.equal(m.channelCount, 2);
  assert.equal(m.deviceLabel, 'Fake Default Audio Input');
  assert.equal(m.deviceId, 'default');
  assert.equal(m.groupId, REAL_SETTINGS.groupId);
  assert.equal(m.latency, 0.01);
  assert.equal(m.timeZone, 'Asia/Tokyo');
  assert.deepEqual(m.processing, {
    autoGainControl: false,
    noiseSuppression: false,
    echoCancellation: false,
    voiceIsolation: false
  });
  assert.deepEqual(m.processingActive, []);
  assert.deepEqual(m.processingUnknown, []);
  assert.equal(processingVerdict(m), PROCESSING_OFF);
});

test('buildSessionMeta: 要求と実値が食い違ってもごまかさない', () => {
  // 「無効で」と要求したのに AGC が有効のまま返ってきた
  const m = meta(Object.assign({}, REAL_SETTINGS, { autoGainControl: true }));
  assert.equal(m.requested.autoGainControl, false);
  assert.equal(m.settings.autoGainControl, true);
  assert.equal(m.processing.autoGainControl, true);
  assert.deepEqual(m.processingActive, ['autoGainControl']);
  assert.equal(processingVerdict(m), PROCESSING_ACTIVE);
});

test('buildSessionMeta: 報告しない項目は null（false と混ぜない）', () => {
  const m = meta({ sampleRate: 44100 });
  for (const k of PROCESSING_KEYS) assert.equal(m.processing[k], null, k);
  assert.deepEqual(m.processingUnknown.slice().sort(), PROCESSING_KEYS.slice().sort());
  assert.deepEqual(m.processingActive, []);
  assert.equal(processingVerdict(m), PROCESSING_UNKNOWN);
  assert.equal(m.trackSampleRate, 44100);
  assert.equal(m.channelCount, null);
  assert.equal(m.deviceId, null);
});

test('実装依存の加工（voiceIsolation）は、有効なときだけ数える', () => {
  assert.deepEqual(PROCESSING_OPTIONAL_KEYS, ['voiceIsolation']);
  // 報告が無くても「不明」を増やさない（3項目が false なら off のまま）
  const absent = meta({
    autoGainControl: false, noiseSuppression: false, echoCancellation: false
  });
  assert.equal(absent.processing.voiceIsolation, null);
  assert.deepEqual(absent.processingUnknown, []);
  assert.equal(processingVerdict(absent), PROCESSING_OFF);
  // 有効なら active に数える
  const on = meta({
    autoGainControl: false, noiseSuppression: false, echoCancellation: false,
    voiceIsolation: true
  });
  assert.deepEqual(on.processingActive, ['voiceIsolation']);
  assert.equal(processingVerdict(on), PROCESSING_ACTIVE);
});

test('processingVerdict: 有効が1つでもあれば active（unknown より優先）', () => {
  const m = meta({ autoGainControl: true, echoCancellation: false });
  assert.deepEqual(m.processingActive, ['autoGainControl']);
  assert.deepEqual(m.processingUnknown, ['noiseSuppression']);
  assert.equal(processingVerdict(m), PROCESSING_ACTIVE);
  assert.equal(processingVerdict(null), PROCESSING_UNKNOWN);
});

test('buildSessionMeta: 凍結されている（あとから書き換えられない）', () => {
  const m = meta(REAL_SETTINGS);
  assert.equal(Object.isFrozen(m), true);
  assert.equal(Object.isFrozen(m.processing), true);
  assert.equal(Object.isFrozen(m.settings), true);
  assert.throws(() => { 'use strict'; m.deviceLabel = 'x'; }, TypeError);
});

function message(seq) {
  return {
    type: 'interval',
    seq,
    sampleRate: 48000,
    startFrame: seq * 48000,
    endFrame: (seq + 1) * 48000,
    expected: 48000,
    count: 48000,
    sumSq: 48000 * 0.01,
    peak: 0.1 * Math.SQRT2,
    clip: 0,
    emittedAt: seq + 1
  };
}

const ANCHOR = { epoch: 0, audioTime: 0, wallMs: Date.UTC(2026, 8, 28, 7, 0, 0) };

test('レコードはメタを参照で持つ（行ごとに複製しない）', () => {
  const m = meta(REAL_SETTINGS);
  const a = buildIntervalRecord(message(0), ANCHOR, -60, { meta: m });
  const b = buildIntervalRecord(message(1), ANCHOR, -60, { meta: m });
  assert.equal(a.metaId, 's1');
  assert.equal(a.meta, m);
  assert.equal(a.meta, b.meta);          // 同じオブジェクト
  assert.equal(a.meta.processing.autoGainControl, false);

  const f = buildFallbackRecord({
    seq: 2, db: -20, floorDb: -60, startTime: 2, endTime: 3,
    startWallMs: ANCHOR.wallMs, endWallMs: ANCHOR.wallMs + 1000,
    expectedSamples: 48000, meta: m
  });
  assert.equal(f.metaId, 's1');
  assert.equal(f.meta, m);
});

test('メタが無くても落ちない', () => {
  const rec = buildIntervalRecord(message(0), ANCHOR, -60);
  assert.equal(rec.metaId, null);
  assert.equal(rec.meta, null);
});

test('CSV: 測定条件はヘッダーのメタ行に出る（段階4で確定）', () => {
  // 段階2では「列の確定は段階4」として出していなかった。ここで出す。
  // これが無いと、そのCSVがどの端末のどの設定で採られたのか後から読めない。
  const m = meta(REAL_SETTINGS);
  const recs = [0, 1].map(i => buildIntervalRecord(message(i), ANCHOR, -60, { meta: m }));
  const csv = buildCsv(recs, {
    engine: 'worklet',
    meta: { sampleRate: 48000, device: 'Fake Default Audio Input', processing: 'off' },
    intervalSec: 1
  });
  const lines = csv.split('\n');
  // 起点になるのは列のヘッダーより上の行だけ（トレーラーは含めない）
  const metaLines = lines.slice(0, lines.indexOf(CSV_COLUMNS.join(',')));
  const dataLines = lines.filter(l => l && !l.startsWith('#'));

  assert.ok(metaLines.includes('# engine=worklet'));
  assert.ok(metaLines.includes('# sampleRate=48000'));
  assert.ok(metaLines.includes('# device=Fake Default Audio Input'));
  assert.ok(metaLines.includes('# processing=off'));
  // 重み付けは未実装なので Z（平坦）と明記する。A特性は次の弾
  assert.ok(metaLines.includes('# weighting=Z'));
  // ⚠ ログ間隔は記録中に変えられるので、起点には出ない（トレーラーへ出る）
  assert.ok(!metaLines.join('\n').includes('intervalSec'), metaLines.join(' / '));
  assert.ok(lines.includes('# intervalSec=1'), csv);

  // ヘッダー＋2行
  assert.equal(dataLines.length, 3);
  assert.equal(dataLines[0], 'timestamp,dbfs,seq,peak_dbfs,clip,valid_ratio,hash');
  for (const line of dataLines.slice(1)) {
    assert.equal(line.split(',').length, 7);
  }
});

test('CSV: メタ行の値に改行を混ぜても1行1項目が崩れない', () => {
  const csv = buildCsv([], { meta: { device: 'My\nMic\r\n2' } });
  const metaLines = csv.split('\n').filter(l => l.startsWith('#'));
  assert.ok(metaLines.includes('# device=My Mic 2'), metaLines.join(' / '));
});

// ---- # intervalSec= は「記録に使った値」で、トレーラーに出る ----
//
// ⚠ 改修前は書き出し時に currentIntervalSec() を読んでいた。
// 1秒で採った行を 3s へ切り替えてから書き出すと「# intervalSec=3」と出る。
// メタ行は「その行がどういう条件で採られたか」を残す場所なので、
// 画面の現在値を書いてはいけない。
// ログ間隔は記録中でも変えられ、ログはセッションをまたいで累積するため、
// 1つのCSVに複数の間隔が混ざりうる。processing=agc+ns と同じ書き方で全部並べる。
//
// ⚠⚠ 2026-09-29 に、この行を鎖の起点から外してトレーラーへ移した。
// 記録中に増える値を起点に入れていたため、ログ間隔を変えるだけで、
// すでに書き出した行のハッシュまで変わっていた。

test('CSV: 混ざったログ間隔はプラスでつないで並ぶ', () => {
  const csv = buildCsv([], { intervalSec: '1+3' });
  assert.ok(csv.split('\n').includes('# intervalSec=1+3'), csv);
});

test('CSV: ログ間隔が分からなければ、その行を出さない', () => {
  const csv = buildCsv([], { meta: { sampleRate: 48000 } });
  assert.ok(!csv.includes('intervalSec'), csv);
});

test('CSV: ログ間隔は起点（ヘッダー）に出ない', () => {
  // 起点に入れると、記録中にログ間隔を変えるだけで既出の行のハッシュが変わる
  const csv = buildCsv([], { meta: { intervalSec: '1+3', sampleRate: 48000 }, intervalSec: '1+3' });
  const lines = csv.split('\n');
  const head = lines.slice(0, lines.indexOf(CSV_COLUMNS.join(',')));
  assert.ok(!head.join('\n').includes('intervalSec'), head.join(' / '));
  assert.ok(lines.includes('# intervalSec=1+3'), csv);
});

test('script.js: 書き出し時点のログ間隔も、画面の設定値も読んでいない', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');
  assert.ok(
    !/intervalSec: currentIntervalSec\(\)/.test(script),
    'メタ行が書き出し時点の設定を読んでいる'
  );
  // ⚠ 画面の設定値（lastIntervalSec）を控えて並べるのも嘘だった。
  //    設定は即座に変わるのに、ワークレットは次の境界まで前の区間長で測り続ける。
  //    行の実測（rec.intervalSec）から組み直す
  assert.ok(
    !/usedIntervals/.test(script),
    '画面の設定値を控える持ち回りが残っている'
  );
  assert.match(
    script,
    /intervalSec: intervalRunsLabel\(logs\)/,
    '行の実測からログ間隔のラベルを組んでいない'
  );
  // ⚠ ログ間隔を鎖の起点（chainMetaOf）に戻さない
  const chainMeta = script.slice(script.indexOf('function chainMetaOf'));
  assert.ok(
    !/intervalSec/.test(chainMeta.slice(0, chainMeta.indexOf('\n  }'))),
    '鎖の起点にログ間隔が戻っている'
  );
});

// ---- 鎖の起点は記録中に動かさない ----

test('script.js: ハッシュは記録中に1区間1回だけ計算する', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');
  // 1行目で起点を凍結し、区間ごとに伸ばす
  assert.match(script, /if \(wasEmpty\) hashChain\.begin\(/, '起点を1行目で凍結していない');
  assert.match(script, /hashChain\.extend\(rec\)/, '区間ごとに鎖を伸ばしていない');
  // 書き出しでは計算し直さず、凍結した起点をそのまま使う
  assert.match(script, /await hashChain\.settled\(\)/, '書き出しが記録中の計算を待っていない');
  assert.match(script, /hashChain\.meta/, '書き出しが凍結した起点を使っていない');
  assert.ok(
    !/computeHashChain/.test(script),
    '書き出しのたびに全行を計算し直す関数が残っている'
  );
  // ログを捨てたら鎖も捨てる（走っている計算を無効にする）
  assert.match(script, /hashChain\.reset\(\)/, 'リセットで鎖を捨てていない');
});
