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
    // レンダーグラフへ繋ぐ前。process() は呼ばれないが、オーディオクロックは進む
    skip(n) {
      const k = (n === undefined) ? 1 : n;   // 0 を 1 に読み替えない
      for (let i = 0; i < k; i++) state.frame += QUANTUM;
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


// ---- 記録開始直後の1行目 ----
//
// ⚠⚠ 改修前は `this.startFrame = currentFrame` をコンストラクターに置いていた。
//    AudioWorkletNode を作ってからレンダーグラフへ繋ぐまでのあいだ process() は
//    呼ばれないので、その間のフレームが expected にだけ入り count には入らない。
//    そのため記録開始直後の1行目だけ有効サンプル率が 1 を下回り、画面が
//    「欠測があった」と警告していた。実測では通常の記録で valid_ratio=0.979。
//    欠測ではなく、まだ音が流れていない時間を区間に数えていただけである。
//    起点を最初の process() へ移して塞いだ。

test('⭐繋ぐまでに間があっても、1行目の有効サンプル率は 1 になる', () => {
  // 実測の 0.979 は 48kHz で 8 クォンタム（1024フレーム＝21.3ミリ秒）ぶんに当たる
  assert.equal((1 - (8 * QUANTUM) / SAMPLE_RATE).toFixed(4), '0.9787');

  for (const gap of [0, 1, 4, 8, 16, 40]) {
    const h = createHarness(SAMPLE_RATE);
    h.skip(gap);                                   // 構築〜接続のあいだ
    for (let q = 0; q < Math.ceil(SAMPLE_RATE / QUANTUM) * 3; q++) h.tick(sine(0.1));
    const iv = h.intervals();
    assert.ok(iv.length >= 2, `gap=${gap} intervals=${iv.length}`);
    assert.equal(iv[0].count, iv[0].expected, `gap=${gap} の1行目が欠測になっている`);
    assert.equal(iv[0].count / iv[0].expected, 1, `gap=${gap}`);
    // 起点は「最初に process() が呼ばれたフレーム」である
    assert.equal(iv[0].startFrame, gap * QUANTUM, `gap=${gap} の起点`);
    assert.equal(iv[0].endFrame, gap * QUANTUM + SAMPLE_RATE, `gap=${gap} の終わり`);
    // 区間長は縮まない（短い1区間を作って重みを狂わせない）
    assert.equal(iv[0].endFrame - iv[0].startFrame, SAMPLE_RATE, `gap=${gap} の区間長`);
  }
});

test('記録中にクォンタムを落としたときは、いまでも有効サンプル率が下がる', () => {
  // ⚠ 起点を動かしたことで「本当の欠測」まで見えなくなっていないこと
  const h = createHarness(4800);
  h.skip(8);
  for (let q = 0; q < 38; q++) h.tick(sine(0.1));
  for (let q = 0; q < 40; q++) h.tick(sine(0.1), true);   // 落とす
  for (let q = 0; q < 80; q++) h.tick(sine(0.1));
  const ratios = h.intervals().map(m => m.count / m.expected);
  assert.equal(ratios[0], 1, '1行目が欠測になっている');
  assert.ok(ratios.slice(1, 3).some(r => r < 0.5), JSON.stringify(ratios));
  assert.equal(ratios[ratios.length - 1], 1, '復帰後に戻っていない');
});

test('ready のメッセージは、決まっていない起点を名乗らない', () => {
  // ⚠ コンストラクターの currentFrame は1区間めの実際の起点にならない
  const state = { frame: 12345 };
  const messages = [];
  const registered = {};
  const sandbox = {
    sampleRate: SAMPLE_RATE, Math, Number, console,
    registerProcessor(name, cls) { registered[name] = cls; },
    AudioWorkletProcessor: class {
      constructor() { this.port = { postMessage: (m) => messages.push(m), onmessage: null }; }
    }
  };
  Object.defineProperty(sandbox, 'currentFrame', { get: () => state.frame });
  Object.defineProperty(sandbox, 'currentTime', { get: () => state.frame / SAMPLE_RATE });
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'meter-processor.js' });
  new registered['meter-processor']({ processorOptions: { intervalFrames: 4800 } });

  const ready = messages.filter(m => m.type === 'ready');
  assert.equal(ready.length, 1);
  assert.equal('startFrame' in ready[0], false, 'まだ決まっていない起点を載せている');
  assert.equal(ready[0].sampleRate, SAMPLE_RATE);
  assert.equal(ready[0].intervalFrames, 4800);
});


// ---- 記録開始直後、入力が空のまま process() が呼ばれるとき（第2弾a3）----
//
// ⚠⚠ iPhone の実機で、記録開始直後の区間の有効サンプル率が 74.9% になった
//    （2026-09-29）。48kHz・1秒の区間なら、欠けたのは 12032 フレーム
//    ＝ちょうど 94 クォンタム（約251ミリ秒）である。第1弾で塞いだのは
//    「process() が呼ばれるまでの間」だったが、こちらは「process() は呼ばれて
//    いるのに、マイクの経路が動き出すまで入力が空で届く間」で、別の穴である。
//    入力に音が載った最初の process() を起点にして塞ぐ。

// 入力を空のまま（チャンネルなしで）1クォンタム進める
function emptyTick(h, kind) {
  h.proc.process(kind === 'zero-length' ? [[new Float32Array(0)]] : [[]]);
  h.state.frame += QUANTUM;
}

test('⭐記録の頭で入力が空のあいだは区間を始めない（実機の 74.9% の再現）', () => {
  // 改修前はこの状況で1行目が 35968/48000 になった
  assert.equal(((SAMPLE_RATE - 94 * QUANTUM) / SAMPLE_RATE).toFixed(3), '0.749');

  const h = createHarness(SAMPLE_RATE);
  for (let q = 0; q < 94; q++) emptyTick(h);
  for (let q = 0; q < Math.ceil(SAMPLE_RATE / QUANTUM) * 3; q++) h.tick(sine(0.1));
  const iv = h.intervals();
  assert.ok(iv.length >= 2, `intervals=${iv.length}`);
  assert.equal(iv[0].count / iv[0].expected, 1, '1行目が見せかけの欠測になっている');
  // 起点は「入力に音が載った最初の process()」
  assert.equal(iv[0].startFrame, 94 * QUANTUM);
  assert.equal(iv[0].endFrame - iv[0].startFrame, SAMPLE_RATE, '区間長が縮んでいる');
});

test('長さ0の配列で届く入力も、空の入力として扱う', () => {
  const h = createHarness(SAMPLE_RATE);
  for (let q = 0; q < 20; q++) emptyTick(h, 'zero-length');
  for (let q = 0; q < Math.ceil(SAMPLE_RATE / QUANTUM) * 2; q++) h.tick(sine(0.1));
  const iv = h.intervals();
  assert.equal(iv[0].startFrame, 20 * QUANTUM);
  assert.equal(iv[0].count / iv[0].expected, 1);
});

test('入力がいつまでも来ないときは、猶予（1秒）のあとで区間を始め、欠測として残す', () => {
  // マイクが最初から届かない場合に1行も出ないと、「記録していない」ことすら残らない。
  // 猶予を過ぎたら最初の process() を起点にし、届かなかったぶんを count=0 で出す
  const h = createHarness(SAMPLE_RATE);
  for (let q = 0; q < Math.ceil(SAMPLE_RATE / QUANTUM) * 3; q++) emptyTick(h);
  const iv = h.intervals();
  assert.ok(iv.length >= 2, `intervals=${iv.length}`);
  assert.equal(iv[0].startFrame, 0, '起点が最初の process() になっていない');
  assert.equal(iv[0].count, 0);
  assert.equal(iv[0].count / iv[0].expected, 0, '届いていないのに欠測として残っていない');
});

test('猶予の途中で音が届けば、その時点を起点にする', () => {
  const h = createHarness(SAMPLE_RATE);
  for (let q = 0; q < 200; q++) emptyTick(h);   // 約0.53秒（猶予の1秒より短い）
  for (let q = 0; q < Math.ceil(SAMPLE_RATE / QUANTUM) * 2; q++) h.tick(sine(0.1));
  const iv = h.intervals();
  assert.equal(iv[0].startFrame, 200 * QUANTUM);
  assert.equal(iv[0].count / iv[0].expected, 1);
});
