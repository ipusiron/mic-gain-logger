'use strict';

// 段階2の3番。マイクのデバイス喪失の検出。
//
// 有効サンプル率では検出できない。トラックを stop しても
// MediaStreamAudioSourceNode はデジタル無音を流し続けるので、
// validRatio は 1.0、sampleCount も期待どおりのままで、dBFS だけが
// -Infinity になる。まずその「検出できなさ」を固定し、
// そのうえで MediaStreamTrack の状態から検出することを確かめる。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TRACK_LIVE,
  TRACK_ENDED,
  DEVICE_LOST_ENDED,
  DEVICE_LOST_GONE,
  readTrackState,
  isTrackLost,
  markDeviceLoss,
  buildIntervalRecord
} = require('../logic.js');

const ANCHOR = { epoch: 0, audioTime: 0, wallMs: Date.UTC(2026, 8, 28, 6, 0, 0) };

function message(seq, over) {
  return Object.assign({
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
  }, over || {});
}

test('デバイス喪失は計測値から区別できない（静かな部屋と同じ値になる）', () => {
  // マイクを失ったあとの区間。サンプルは届いていて中身が0
  const lost = buildIntervalRecord(message(5, { sumSq: 0, peak: 0 }), ANCHOR, -60);
  // 本当に無音な部屋の区間（同じ値になる）
  const quiet = buildIntervalRecord(message(6, { sumSq: 0, peak: 0 }), ANCHOR, -60);
  for (const key of ['rawDb', 'db', 'silent', 'validRatio', 'sampleCount',
                     'expectedSamples', 'clipCount', 'peak']) {
    assert.deepEqual(lost[key], quiet[key], key);
  }
  assert.equal(lost.validRatio, 1);
  assert.equal(lost.sampleCount, 48000);
  assert.equal(lost.rawDb, -Infinity);
});

test('readTrackState: readyState が live のときだけ live になる', () => {
  assert.deepEqual(
    readTrackState({ readyState: TRACK_LIVE, muted: false, enabled: true }),
    { readyState: 'live', muted: false, enabled: true, live: true }
  );
  assert.deepEqual(
    readTrackState({ readyState: TRACK_ENDED, muted: false, enabled: true }),
    { readyState: 'ended', muted: false, enabled: true, live: false }
  );
  // muted は「無音化」であって喪失ではない
  const muted = readTrackState({ readyState: TRACK_LIVE, muted: true, enabled: true });
  assert.equal(muted.live, true);
  assert.equal(muted.muted, true);
  // トラックが無い
  assert.deepEqual(readTrackState(null),
    { readyState: null, muted: null, enabled: null, live: false });
  assert.deepEqual(readTrackState(undefined),
    { readyState: null, muted: null, enabled: null, live: false });
});

test('isTrackLost: live 以外はすべて喪失として扱う', () => {
  assert.equal(isTrackLost(readTrackState({ readyState: TRACK_LIVE })), false);
  assert.equal(isTrackLost(readTrackState({ readyState: TRACK_ENDED })), true);
  assert.equal(isTrackLost(readTrackState({ readyState: 'unknown' })), true);
  assert.equal(isTrackLost(readTrackState(null)), true);
  assert.equal(isTrackLost(null), true);
  // 無音化されていても live なら喪失ではない
  assert.equal(isTrackLost(readTrackState({ readyState: TRACK_LIVE, muted: true })), false);
});

test('markDeviceLoss: 最後の行に印を付け、そのあとの行は作らない', () => {
  const logs = [
    { seq: 0, db: -20 },
    { seq: 1, db: -21 },
    { seq: 2, db: -22 }
  ];
  const at = Date.UTC(2026, 8, 28, 6, 0, 10);
  const info = markDeviceLoss(logs, { reason: DEVICE_LOST_ENDED, atWallMs: at });
  assert.deepEqual(info, {
    reason: 'ended',
    atWallMs: at,
    lastSeq: 2,
    rowsKept: 3
  });
  assert.equal(logs.length, 3);                    // 行を足さない
  assert.equal(logs[2].deviceLostAfter, true);
  assert.equal(logs[2].deviceLostReason, 'ended');
  assert.equal(logs[0].deviceLostAfter, undefined);
  assert.equal(logs[1].deviceLostAfter, undefined);
});

test('markDeviceLoss: 1行も記録していないうちに失っても落ちない', () => {
  const info = markDeviceLoss([], { reason: DEVICE_LOST_GONE, atWallMs: 1 });
  assert.equal(info.reason, 'gone');
  assert.equal(info.lastSeq, null);
  assert.equal(info.rowsKept, 0);
});
