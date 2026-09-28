'use strict';

// worklet/meter-processor.js を node:vm の中で動かし、
// 区間の切り方（オーディオクロック基準・ドリフトなし・欠測が痕跡に残る）を固定する。
// AudioWorkletGlobalScope の sampleRate / currentFrame / currentTime は差し替える。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'worklet', 'meter-processor.js'), 'utf8'
);
const SAMPLE_RATE = 48000;
const QUANTUM = 128;

function createHarness(intervalFrames, startFrame = 0) {
  const state = { frame: startFrame };
  const messages = [];
  const registered = {};

  const sandbox = {
    sampleRate: SAMPLE_RATE,
    Math,
    Number,
    console,
    registerProcessor(name, cls) { registered[name] = cls; },
    AudioWorkletProcessor: class {
      constructor() {
        this.port = { postMessage: (m) => messages.push(m), onmessage: null };
      }
    }
  };
  Object.defineProperty(sandbox, 'currentFrame', { get: () => state.frame });
  Object.defineProperty(sandbox, 'currentTime', { get: () => state.frame / SAMPLE_RATE });

  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'meter-processor.js' });

  const proc = new registered['meter-processor']({ processorOptions: { intervalFrames } });
  messages.length = 0; // 'ready' は捨てる

  return {
    state,
    messages,
    proc,
    // 1レンダークォンタムぶん進める。drop=true ならオーディオスレッドが落としたことにする
    tick(fill, drop) {
      if (!drop) {
        const block = new Float32Array(QUANTUM);
        for (let i = 0; i < QUANTUM; i++) block[i] = fill(state.frame + i);
        proc.process([[block]]);
      }
      state.frame += QUANTUM;
    },
    intervals() { return messages.filter(m => m.type === 'interval'); }
  };
}

const sine = (amp) => (n) => amp * Math.sin(2 * Math.PI * 1000 * (n / SAMPLE_RATE));

test('区間の境界はオーディオクロック基準で、ずれが積み上がらない', () => {
  // 4800 は 128 の倍数ではない（4800 / 128 = 37.5）ので、境界はブロックの途中に来る
  const h = createHarness(4800);
  for (let q = 0; q < 37 * 20; q++) h.tick(sine(0.1));
  const iv = h.intervals();
  assert.ok(iv.length >= 18, `intervals=${iv.length}`);
  for (let i = 0; i < iv.length; i++) {
    assert.equal(iv[i].startFrame, i * 4800, `start of #${i}`);
    assert.equal(iv[i].endFrame, (i + 1) * 4800, `end of #${i}`);
    assert.equal(iv[i].expected, 4800);
    assert.equal(iv[i].count, 4800, `count of #${i}`);
    assert.equal(iv[i].seq, i);
  }
});

test('RMS の集計が既知の値と合う（-20 dBFS の正弦波）', () => {
  const h = createHarness(4800);
  const amp = 0.1 * Math.SQRT2;          // RMS 0.1 = -20 dBFS
  for (let q = 0; q < 200; q++) h.tick(sine(amp));
  const iv = h.intervals();
  assert.ok(iv.length > 3);
  for (const m of iv.slice(1)) {
    const db = 20 * Math.log10(Math.sqrt(m.sumSq / m.count));
    assert.ok(Math.abs(db + 20) < 0.01, `got ${db}`);
    assert.ok(Math.abs(m.peak - amp) < 1e-3);
    assert.equal(m.clip, 0);
  }
});

test('クォンタムを落とすと有効サンプル率が下がり、境界は動かない', () => {
  const h = createHarness(4800);
  // 1区間（4800フレーム＝37.5クォンタム）ぶん進めたあと、2区間ぶんを丸ごと落とす
  for (let q = 0; q < 38; q++) h.tick(sine(0.1));
  for (let q = 0; q < 75; q++) h.tick(sine(0.1), true); // 落とす
  for (let q = 0; q < 80; q++) h.tick(sine(0.1));

  const iv = h.intervals();
  assert.ok(iv.length >= 4);
  for (let i = 0; i < iv.length; i++) {
    assert.equal(iv[i].startFrame, i * 4800);
    assert.equal(iv[i].endFrame, (i + 1) * 4800);
  }
  const ratios = iv.map(m => m.count / m.expected);
  assert.equal(ratios[0], 1);
  // 落とした区間は 1 を割る
  assert.ok(ratios.slice(1, 3).some(r => r < 0.5), JSON.stringify(ratios));
  // 復帰後は 1 に戻る
  assert.equal(ratios[ratios.length - 1], 1);
});

test('入力が切れているあいだも区間は進み、届いたサンプルが 0 になる', () => {
  const h = createHarness(2560);   // 20 クォンタム
  for (let q = 0; q < 20; q++) h.tick(sine(0.1));
  for (let q = 0; q < 40; q++) h.proc.process([[]]), h.state.frame += QUANTUM;
  const iv = h.intervals();
  assert.equal(iv[0].count, 2560);
  assert.equal(iv[1].count, 0);
  assert.equal(iv[1].sumSq, 0);
  assert.equal(iv[1].startFrame, 2560);
  assert.equal(iv[1].endFrame, 5120);
});

test('真のピークとクリップ数を数える', () => {
  const h = createHarness(1280);   // 10 クォンタム。区間が閉じるのは 11 回目の呼び出し
  let n = 0;
  for (let q = 0; q < 11; q++) {
    h.tick(() => {
      n++;
      if (n === 5) return 1.5;     // クリップ
      if (n === 6) return -1.0;    // ちょうど 1.0 もクリップ
      if (n === 7) return 0.9;
      return 0.001;
    });
  }
  const iv = h.intervals();
  assert.equal(iv[0].count, 1280);
  assert.equal(iv[0].peak, 1.5);
  assert.equal(iv[0].clip, 2);
});

test('ログ間隔を変えると次の境界から効く', () => {
  const h = createHarness(1280);
  for (let q = 0; q < 15; q++) h.tick(sine(0.1));
  h.proc.port.onmessage({ data: { type: 'config', intervalFrames: 2560 } });
  for (let q = 0; q < 40; q++) h.tick(sine(0.1));

  const iv = h.intervals();
  assert.equal(iv[0].expected, 1280);
  assert.equal(iv[0].startFrame, 0);
  assert.equal(iv[0].endFrame, 1280);
  // 変更を受け取った区間の次から 2560 になる
  const changed = iv.findIndex(m => m.expected === 2560);
  assert.ok(changed > 0, JSON.stringify(iv.map(m => m.expected)));
  for (let i = changed; i < iv.length; i++) {
    assert.equal(iv[i].expected, 2560);
    assert.equal(iv[i].endFrame - iv[i].startFrame, 2560);
  }
});

test('stop を受け取ると process が false を返して終わる', () => {
  const h = createHarness(1280);
  h.proc.port.onmessage({ data: { type: 'stop' } });
  assert.equal(h.proc.process([[new Float32Array(QUANTUM)]]), false);
});

test('不正な intervalFrames は既定（1秒）に落とす', () => {
  for (const bad of [0, -1, NaN, undefined, 'abc', 10]) {
    const h = createHarness(bad);
    for (let q = 0; q < Math.ceil(SAMPLE_RATE / QUANTUM) + 2; q++) h.tick(sine(0.1));
    assert.equal(h.intervals()[0].expected, SAMPLE_RATE, `intervalFrames=${bad}`);
  }
});
