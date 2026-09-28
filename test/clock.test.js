'use strict';

// 段階2の1番。AudioContext の中断でタイムスタンプが無言でずれる問題を縛る。
//
// 記録開始時に1回だけ取ったアンカーを使い続けると、suspend のあいだ
// currentTime が進まないため、再開後の全タイムスタンプが中断していた時間ぶん
// 過去へずれる。実測で10.05秒／20.03秒のずれが出た。しかも CSV に穴が残らない。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CLOCK_JUMP_THRESHOLD_MS,
  CLOCK_BREAK_SUSPEND,
  CLOCK_BREAK_STALL,
  CLOCK_OK,
  CLOCK_RESYNC,
  createClockAnchor,
  clockDriftMs,
  detectClockJump,
  reanchorClock,
  audioTimeToWallMs,
  buildIntervalRecord,
  buildFallbackRecord
} = require('../logic.js');

test('createClockAnchor: epoch は0から始まる', () => {
  const a = createClockAnchor(1.5, 1000000);
  assert.equal(a.epoch, 0);
  assert.equal(a.audioTime, 1.5);
  assert.equal(a.wallMs, 1000000);
});

test('clockDriftMs: 両方が同じだけ進めば0', () => {
  const probe = { audioTime: 10, wallMs: 1000000 };
  assert.equal(clockDriftMs(probe, 11, 1001000), 0);
  assert.equal(clockDriftMs(probe, 12.5, 1002500), 0);
});

test('clockDriftMs: オーディオクロックが止まっていた分だけ正の値になる', () => {
  const probe = { audioTime: 10, wallMs: 1000000 };
  // 壁時計は10秒進み、オーディオクロックは止まっていた
  assert.equal(clockDriftMs(probe, 10, 1010000), 10000);
  // 壁時計は10秒、オーディオクロックは3秒だけ進んだ
  assert.equal(clockDriftMs(probe, 13, 1010000), 7000);
});

test('detectClockJump: 閾値未満は null、閾値以上は跳びとして返す', () => {
  const probe = { audioTime: 10, wallMs: 1000000 };
  assert.equal(detectClockJump(probe, 11, 1001000), null);          // ずれ0
  assert.equal(detectClockJump(probe, 10.9, 1001000), null);        // ずれ100ms
  assert.equal(detectClockJump(probe, 10.751, 1001000), null);      // ずれ249ms
  assert.deepEqual(detectClockJump(probe, 10.75, 1001000), { jumpMs: 250 });
  assert.equal(CLOCK_JUMP_THRESHOLD_MS, 250);
  // 逆向き（オーディオクロックが先に進む）も拾う
  assert.deepEqual(detectClockJump(probe, 11.5, 1001000), { jumpMs: -500 });
  // 閾値は差し替えられる
  assert.equal(detectClockJump(probe, 10.75, 1001000, 500), null);
});

test('detectClockJump: 機器クロックの周波数差（数十ppm）では発火しない', () => {
  // オーディオ側が 100ppm 遅い環境で、1秒ごとに1時間ぶん点検する。
  // 1点検あたりのずれは 0.1ms なので、1件も跳びにならない。
  let probe = { audioTime: 0, wallMs: 1000000 };
  let audio = 0;
  let wall = 1000000;
  let fired = 0;
  for (let i = 0; i < 3600; i++) {
    wall += 1000;
    audio += 1 - 100e-6;           // 100ppm 遅い
    if (detectClockJump(probe, audio, wall)) fired++;
    probe = { audioTime: audio, wallMs: wall };
  }
  assert.equal(fired, 0);
  // 累積では 360ms ずれている。開始時からの累積で見ると誤検出していた
  const total = clockDriftMs({ audioTime: 0, wallMs: 1000000 }, audio, wall);
  assert.ok(Math.abs(total - 360) < 1, `累積ずれ ${total}ms`);
  assert.ok(total >= CLOCK_JUMP_THRESHOLD_MS);
});

test('reanchorClock: epoch が進み、以降の写像が新しい組を基準にする', () => {
  const a0 = createClockAnchor(0, 1000000);
  const a1 = reanchorClock(a0, 1, 1011000);
  assert.equal(a1.epoch, 1);
  assert.equal(audioTimeToWallMs(1, a1), 1011000);
  assert.equal(audioTimeToWallMs(2, a1), 1012000);
  const a2 = reanchorClock(a1, 5, 1015000);
  assert.equal(a2.epoch, 2);
});

// 1区間＝1秒（48000フレーム）のメッセージ
function message(seq, startFrame) {
  return {
    type: 'interval',
    seq,
    sampleRate: 48000,
    startFrame,
    endFrame: startFrame + 48000,
    expected: 48000,
    count: 48000,
    sumSq: 48000 * 0.01,     // RMS 0.1 = -20 dBFS
    peak: 0.1 * Math.SQRT2,
    clip: 0,
    emittedAt: 0
  };
}

test('10秒の中断: アンカーを取り直さないと再開後の時刻が10秒過去へずれる', () => {
  const t0 = Date.UTC(2026, 8, 28, 3, 0, 0);
  const anchor0 = createClockAnchor(0, t0);

  // 中断前の1区間（frames 0..48000 = audioTime 0..1）
  const rec0 = buildIntervalRecord(message(0, 0), anchor0, -60);
  assert.equal(rec0.startWall.toISOString(), '2026-09-28T03:00:00.000Z');
  assert.equal(rec0.endWall.toISOString(), '2026-09-28T03:00:01.000Z');
  assert.equal(rec0.clockEpoch, 0);
  assert.equal(rec0.clockStatus, CLOCK_OK);
  assert.equal(rec0.clockJumpMs, null);

  // 直前の点検は audioTime 1 / 壁時計 t0+1000
  const probe = { audioTime: 1, wallMs: t0 + 1000 };
  // ここで10秒の suspend。復帰時は壁時計だけ10秒進んでいる
  const jump = detectClockJump(probe, 1, t0 + 11000);
  assert.deepEqual(jump, { jumpMs: 10000 });

  // 取り直さない場合（改修前の振る舞い）
  const bad = buildIntervalRecord(message(1, 48000), anchor0, -60);
  assert.equal(bad.endWall.toISOString(), '2026-09-28T03:00:02.000Z');

  // 取り直した場合
  const anchor1 = reanchorClock(anchor0, 1, t0 + 11000);
  const good = buildIntervalRecord(message(1, 48000), anchor1, -60, {
    clockBreak: { kind: CLOCK_BREAK_SUSPEND, jumpMs: jump.jumpMs }
  });
  assert.equal(good.startWall.toISOString(), '2026-09-28T03:00:11.000Z');
  assert.equal(good.endWall.toISOString(), '2026-09-28T03:00:12.000Z');
  // ずれの大きさが中断の長さと一致する
  assert.equal(good.endWall.getTime() - bad.endWall.getTime(), 10000);
  // 跳びを跨いだ区間には印が付く
  assert.equal(good.clockEpoch, 1);
  assert.equal(good.clockStatus, CLOCK_RESYNC);
  assert.equal(good.clockBreakKind, CLOCK_BREAK_SUSPEND);
  assert.equal(good.clockJumpMs, 10000);
});

test('20秒の中断でも同じ手順でずれが消える', () => {
  const t0 = Date.UTC(2026, 8, 28, 3, 0, 0);
  const anchor0 = createClockAnchor(0, t0);
  const probe = { audioTime: 1, wallMs: t0 + 1000 };
  const jump = detectClockJump(probe, 1, t0 + 21000);
  assert.deepEqual(jump, { jumpMs: 20000 });
  const anchor1 = reanchorClock(anchor0, 1, t0 + 21000);
  const rec = buildIntervalRecord(message(1, 48000), anchor1, -60, {
    clockBreak: { kind: CLOCK_BREAK_SUSPEND, jumpMs: jump.jumpMs }
  });
  assert.equal(rec.endWall.toISOString(), '2026-09-28T03:00:22.000Z');
  assert.equal(rec.clockJumpMs, 20000);
});

test('印は跳びを跨いだ1区間だけに付き、次の区間は ok に戻る', () => {
  const t0 = Date.UTC(2026, 8, 28, 3, 0, 0);
  const anchor1 = reanchorClock(createClockAnchor(0, t0), 1, t0 + 11000);
  const marked = buildIntervalRecord(message(1, 48000), anchor1, -60, {
    clockBreak: { kind: CLOCK_BREAK_STALL, jumpMs: 10000 }
  });
  const plain = buildIntervalRecord(message(2, 96000), anchor1, -60, { clockBreak: null });
  assert.equal(marked.clockStatus, CLOCK_RESYNC);
  assert.equal(marked.clockBreakKind, CLOCK_BREAK_STALL);
  assert.equal(plain.clockStatus, CLOCK_OK);
  assert.equal(plain.clockBreakKind, null);
  assert.equal(plain.clockEpoch, 1);
});

test('簡易モードのレコードも epoch と印を持つ', () => {
  const rec = buildFallbackRecord({
    seq: 1,
    db: -30,
    floorDb: -60,
    startTime: 1,
    endTime: 2,
    startWallMs: Date.UTC(2026, 8, 28, 3, 0, 11),
    endWallMs: Date.UTC(2026, 8, 28, 3, 0, 12),
    expectedSamples: 48000,
    clockEpoch: 1,
    clockBreak: { kind: CLOCK_BREAK_SUSPEND, jumpMs: 10000 }
  });
  assert.equal(rec.clockEpoch, 1);
  assert.equal(rec.clockStatus, CLOCK_RESYNC);
  assert.equal(rec.clockJumpMs, 10000);

  const plain = buildFallbackRecord({
    seq: 2,
    db: -30,
    floorDb: -60,
    startTime: 2,
    endTime: 3,
    startWallMs: 0,
    endWallMs: 1000,
    expectedSamples: 48000
  });
  assert.equal(plain.clockEpoch, 0);
  assert.equal(plain.clockStatus, CLOCK_OK);
  assert.equal(plain.clockJumpMs, null);
});
