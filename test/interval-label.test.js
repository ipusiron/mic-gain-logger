'use strict';

// 行に貼るログ間隔を「その区間を実際に測ったときの間隔」にすることの検証。
//
// ⚠⚠ 画面のログ間隔は記録中に変えられるが、変更が効くのは次の境界からである。
//    区間の集計はオーディオスレッドで走っているので、設定を変えた瞬間に
//    測りかけの区間を切ることはできない。
//    改修前の script.js は、設定が即座に更新した lastIntervalSec を行へ貼っていた。
//    そのため「1秒で測った区間に 3 というラベルが付く」行ができた。トレーラーの
//    `# intervalSec=1+3` は混在を示すが、どの行がどちらかは分からなかった。
//
// ⚠ CSV の列は増やさない。内部のレコードに実測の区間長を持たせ、
//    トレーラーでは変わったところだけを `間隔@開始seq` で並べる。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const logic = require('../logic.js');
const {
  buildIntervalRecord, buildFallbackRecord, framesForInterval, intervalSecOfFrames,
  intervalRuns, formatIntervalRuns, intervalRunsLabel, recordDurationSec,
  csvTrailerLines, buildCsv, seriesPointOf
} = logic;

const root = path.join(__dirname, '..');
const script = fs.readFileSync(path.join(root, 'script.js'), 'utf8');

const SR = 48000;
const ANCHOR = { epoch: 0, audioTime: 0, wallMs: Date.UTC(2026, 8, 29, 3, 0, 0) };

function recordOf(seq, startFrame, frames, over) {
  const msg = Object.assign({
    type: 'interval',
    seq,
    sampleRate: SR,
    startFrame,
    endFrame: startFrame + frames,
    expected: frames,
    count: frames,
    sumSq: frames * 0.01,   // RMS 0.1 = -20 dBFS
    peak: 0.15,
    clip: 0,
    emittedAt: 0
  }, over);
  return buildIntervalRecord(msg, ANCHOR, -60, { seqBase: 0, meta: { id: 's1' } });
}

// ---- フレーム数と秒の往復 ----

test('区間長のラベルは framesForInterval の逆算になっている', () => {
  for (const sec of [0.2, 0.5, 1, 1.5, 3, 5, 10, 60]) {
    for (const sr of [44100, 48000, 96000]) {
      const frames = framesForInterval(sec, sr);
      assert.equal(intervalSecOfFrames(frames, sr), sec, `sec=${sec} sr=${sr}`);
    }
  }
});

test('区間長のラベルは、丸めきれない値でも6桁で止める', () => {
  // 128 フレーム（下限）は 48kHz で 2.666...ミリ秒。桁が無限に伸びないこと
  const v = intervalSecOfFrames(128, SR);
  assert.equal(v, 0.002667);
  assert.equal(String(v).length <= 8, true, String(v));
  // 取れないものは null（0 や負、サンプルレート不明）
  assert.equal(intervalSecOfFrames(0, SR), null);
  assert.equal(intervalSecOfFrames(-1, SR), null);
  assert.equal(intervalSecOfFrames(SR, 0), null);
});

// ---- 行のラベルが実測になっていること ----

test('区間レコードのラベルは実測の区間長で、区間長そのものと一致する', () => {
  const r1 = recordOf(0, 0, SR);
  const r3 = recordOf(1, SR, 3 * SR);
  assert.equal(r1.intervalSec, 1);
  assert.equal(r3.intervalSec, 3);
  // 統計の重み（recordDurationSec）と同じ値であること。
  // 別の源から取ると、画面の Leq とトレーラーのラベルがずれる
  assert.equal(r1.intervalSec, recordDurationSec(r1));
  assert.equal(r3.intervalSec, recordDurationSec(r3));
});

test('⭐ワークレット本体を通しても、切り替えた直後の区間には前の間隔が付く', () => {
  const SOURCE = fs.readFileSync(path.join(root, 'worklet', 'meter-processor.js'), 'utf8');
  const QUANTUM = 128;
  const state = { frame: 0 };
  const messages = [];
  const registered = {};
  const sandbox = {
    sampleRate: SR, Math, Number, console,
    registerProcessor(n, c) { registered[n] = c; },
    AudioWorkletProcessor: class {
      constructor() { this.port = { postMessage: (m) => messages.push(m), onmessage: null }; }
    }
  };
  Object.defineProperty(sandbox, 'currentFrame', { get: () => state.frame });
  Object.defineProperty(sandbox, 'currentTime', { get: () => state.frame / SR });
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'meter-processor.js' });
  const proc = new registered['meter-processor']({ processorOptions: { intervalFrames: SR } });
  messages.length = 0;

  const rows = [];
  const uiLabels = [];         // 改修前のラベル（画面の設定値）
  let uiIntervalSec = 1;
  const drain = () => {
    for (const m of messages.filter(x => x.type === 'interval')) {
      rows.push(buildIntervalRecord(m, ANCHOR, -60, { seqBase: 0, meta: { id: 's1' } }));
      uiLabels.push(uiIntervalSec);
    }
    messages.length = 0;
  };
  const tick = (n) => {
    for (let i = 0; i < n; i++) {
      proc.process([[new Float32Array(QUANTUM).fill(0.1)]]);
      state.frame += QUANTUM;
      drain();
    }
  };

  tick(Math.ceil(SR / QUANTUM) * 2 + 2);     // 1秒の区間を2つ以上
  uiIntervalSec = 3;                          // 画面の設定だけが先に 3 になる
  proc.port.onmessage({ data: { type: 'config', intervalFrames: 3 * SR } });
  tick(Math.ceil((SR * 7) / QUANTUM));

  assert.ok(rows.length >= 5, `区間が足りない: ${rows.length}`);
  // seq 0,1,2 は 1 秒で測られている（2 は設定が 3 になったあとに閉じた区間）
  assert.deepEqual(rows.slice(0, 5).map(r => r.intervalSec), [1, 1, 1, 3, 3]);
  assert.deepEqual(rows.slice(0, 5).map(r => r.endTime - r.startTime), [1, 1, 1, 3, 3]);
  // ⭐改修前のラベルは seq 2 で嘘になっていた
  assert.equal(uiLabels[2], 3, '前提が崩れている（設定はもう 3 のはず）');
  assert.equal(rows[2].intervalSec, 1, '切り替えた直後の区間に新しい間隔が付いている');
  const wrong = rows.filter((r, i) => uiLabels[i] !== r.intervalSec);
  assert.equal(wrong.length, 1, `嘘のラベルが付く行は1件のはず: ${wrong.length}`);
  assert.equal(wrong[0].seq, 2);

  // トレーラーは「どの seq からどちらか」を言える形になっている
  assert.equal(intervalRunsLabel(rows.slice(0, 5)), '1@0+3@3');
});

test('簡易モードの行は、行を出す条件で使った間隔を貼る', () => {
  const rec = buildFallbackRecord({
    seq: 0, db: -30, floorDb: -60,
    startTime: 0, endTime: 1.017,          // rAF なので実測はぴったりにならない
    startWallMs: ANCHOR.wallMs, endWallMs: ANCHOR.wallMs + 1017,
    expectedSamples: SR, intervalSec: 1,
    clockEpoch: 0, clockBreak: null, meta: { id: 's1' }
  });
  // ⚠ 実測の区間長（1.017）をラベルにすると、rAF の揺れのぶんだけ
  //    ランが割れて `# intervalSec=` が行数ぶんに膨らむ
  assert.equal(rec.intervalSec, 1);
  assert.ok(Math.abs(recordDurationSec(rec) - 1.017) < 1e-9);
  // 渡されなければ「不明」
  const bare = buildFallbackRecord({
    seq: 1, db: -30, floorDb: -60, startTime: 1, endTime: 2,
    startWallMs: 0, endWallMs: 1000, expectedSamples: SR,
    clockEpoch: 0, clockBreak: null, meta: null
  });
  assert.equal(bare.intervalSec, null);
});

// ---- ランの組み立てと書き方 ----

test('ランは変わったところだけを出す', () => {
  const rows = [
    recordOf(0, 0, SR), recordOf(1, SR, SR), recordOf(2, 2 * SR, SR),
    recordOf(3, 3 * SR, 3 * SR), recordOf(4, 6 * SR, 3 * SR),
    recordOf(5, 9 * SR, SR)
  ];
  assert.deepEqual(intervalRuns(rows), [
    { sec: 1, seq: 0 }, { sec: 3, seq: 3 }, { sec: 1, seq: 5 }
  ]);
  assert.equal(formatIntervalRuns(intervalRuns(rows)), '1@0+3@3+1@5');
  // 全区間が同じなら `+` は入らない（README の分岐がこれを見ている）
  assert.equal(intervalRunsLabel(rows.slice(0, 3)), '1@0');
  assert.equal(intervalRunsLabel([]), null);
});

test('ラベルが分からない行はランに入れない', () => {
  const rows = [
    { seq: 0, intervalSec: null, ts: new Date(0), rawDb: -20 },
    recordOf(1, SR, SR)
  ];
  assert.deepEqual(intervalRuns(rows), [{ sec: 1, seq: 1 }]);
});

test('CSV のトレーラーに seq つきで出る（列は増えない）', () => {
  const rows = [
    recordOf(0, 0, SR), recordOf(1, SR, SR),
    recordOf(2, 2 * SR, 3 * SR)
  ];
  const csv = buildCsv(rows, {
    engine: 'worklet',
    meta: { started: rows[0].ts.toISOString() },
    intervalSec: intervalRunsLabel(rows)
  });
  const lines = csv.split('\n');
  assert.ok(lines.includes('# intervalSec=1@0+3@2'), csv);
  // 列は7列のまま
  const headerRow = lines.find(l => l.startsWith('timestamp,'));
  assert.equal(headerRow.split(',').length, 7, headerRow);
  for (const l of lines) {
    if (!l.length || l.startsWith('#') || l.startsWith('timestamp,')) continue;
    assert.equal(l.split(',').length, 7, l);
  }
});

test('トレーラーのラベルは、行が無ければ出さない', () => {
  assert.ok(!csvTrailerLines([], {}).some(l => l.startsWith('# intervalSec=')));
});

// ---- グラフの線を切る判定も実測の区間長で見る ----

test('グラフの線を切る判定が、切り替え直後の行を「飛んだ」と誤判定しない', () => {
  // 1秒の区間が閉じた直後。設定は 3 になっているが、この区間は 1 秒で測られている
  const rec = recordOf(2, 2 * SR, SR);
  // 前の点は同じセッションのもの（第2弾a4 から点がセッションの印 sid を持つ）
  const prev = { tMs: ANCHOR.wallMs + 2000, db: -20, gap: false, sid: rec.metaId || null };
  // ⭐実測の区間長（1秒）で見るので線は切れない
  assert.equal(seriesPointOf(rec, prev, rec.intervalSec * 1000).gap, false);
  // 改修前は画面の設定値（3秒）を渡していた。1.5倍の窓が 4.5 秒に広がるので、
  // こちらでも切れないが、逆向き（長い→短い）では切れてしまう
  const longRec = recordOf(3, 3 * SR, 3 * SR);
  const prev2 = { tMs: longRec.ts.getTime() - 3000, db: -20, gap: false, sid: longRec.metaId || null };
  assert.equal(seriesPointOf(longRec, prev2, 1 * 1000).gap, true,
    '前提が崩れている（短い間隔で見ると線が切れるはず）');
  assert.equal(seriesPointOf(longRec, prev2, longRec.intervalSec * 1000).gap, false);
});

test('script.js はグラフの区間長にもレコードの実測を使う', () => {
  assert.match(
    script,
    /Number\.isFinite\(rec\.intervalSec\) \? rec\.intervalSec \* 1000 : null/,
    'グラフの区間長が画面の設定値のままになっている'
  );
});
