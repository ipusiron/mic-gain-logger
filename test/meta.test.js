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
  buildCsv
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

test('CSV の列は増えない（メタは CSV に出さない）', () => {
  const m = meta(REAL_SETTINGS);
  const recs = [0, 1].map(i => buildIntervalRecord(message(i), ANCHOR, -60, { meta: m }));
  const csv = buildCsv(recs, { engine: 'worklet' });
  const lines = csv.split('\n');
  assert.equal(lines[0], '# engine=worklet');
  assert.equal(lines[1], 'timestamp,dbfs');
  assert.equal(lines.length, 4);
  for (const line of lines.slice(2)) {
    assert.equal(line.split(',').length, 2);
  }
  assert.equal(csv.includes('Fake Default Audio Input'), false);
  assert.equal(csv.includes('autoGainControl'), false);
});
