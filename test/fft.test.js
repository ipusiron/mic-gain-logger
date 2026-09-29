'use strict';

// FFT の土台を、process() から呼ぶ前に固める（第2弾b0）。
//
// 第2弾bでは、区間ごとに 18〜22kHz と 20〜18,000Hz の帯域の値（平均二乗の推定）を記録に足す。
// その前段として、worklet/meter-processor.js にトップレベル関数で置いた FFT の計算
// （createFftPlan・fftInPlace・hannWindow・windowPowerSum・powerSpectrumInto・binFrequency）を、
// ワークレットのソースを node:vm の中で読み込んで確かめる。b0 では process() からまだ呼ばなかった。
// b1 で区間ごとの帯域の集計（test/band.test.js）から呼び始めた。
//
// ここで固めること：
//  - 素朴な DFT（O(N^2)）と同じ値を返し、パーセバルの等式が成り立つ
//  - 片側の平均二乗スペクトルの正規化。全ビンの和が窓で重み付けした平均二乗になり、
//    矩形窓なら第1弾の sumSq / count と同じ値になる。直流とナイキストは2倍にしない
//  - 周期型の Hann 窓（ビンの中心に乗る正弦波の電力が、隣り合う3ビンに収まる）
//  - ⚠ 周期型 Hann 窓では、直流とナイキストの電力の 1/3 が隣のビンへ分かれる（b1 で帯域の下端を決めるときの前提）
//  - ⚠ fftInPlace と powerSpectrumInto の中で配列もオブジェクトも作らない（オーディオスレッドでのGCを避ける）。
//    ソースの文字列で、作る代表的な書き方が無いことを見る
//  - FFT を呼ぶのは帯域の集計だけで、フレームごとに通るメソッドの中でも配列を作らない
//    （第2弾b1 で「b0 は置くだけ」のテストを書き換えた。理由はそのテストのコメント）
//
// 期待値は手で書かず、式から計算する。乱数は種を固定して作る（Math.random は使わない）。
// ⚠ コンテキストの RangeError・Float64Array はこのファイルのものと別の realm である。
//    instanceof では見分けられないので、名前で見る。

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

const FFT_FUNCTIONS = [
  'createFftPlan', 'fftInPlace', 'hannWindow', 'windowPowerSum', 'powerSpectrumInto', 'binFrequency'
];

// ワークレットのソースを node:vm の中で読み込む（test/meter-processor.test.js と同じ差し替え）。
// トップレベルの function 宣言は、コンテキストの大域オブジェクトから取り出せる
function loadWorklet() {
  const state = { frame: 0 };
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
  return { sandbox, state, messages, registered };
}

const W = loadWorklet().sandbox;
const { createFftPlan, fftInPlace, hannWindow, windowPowerSum, powerSpectrumInto, binFrequency } = W;

// n = 2, 4, 8, …, 1024
const SIZES = [];
for (let n = 2; n <= 1024; n *= 2) SIZES.push(n);

// 種を固定した乱数（mulberry32）。同じ種なら毎回同じ列になる
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const uniform = (r) => r() * 2 - 1;   // [-1, 1)

// 素朴な DFT。X_k = Σ x_i・e^(-2πj・ik/n)。角度は (i・k) mod n で縮めて、大きな角度の丸めを避ける
function naiveDft(re, im) {
  const n = re.length;
  const outRe = new Float64Array(n);
  const outIm = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let sr = 0;
    let si = 0;
    for (let i = 0; i < n; i++) {
      const a = -2 * Math.PI * ((i * k) % n) / n;
      const c = Math.cos(a);
      const s = Math.sin(a);
      sr += re[i] * c - im[i] * s;
      si += re[i] * s + im[i] * c;
    }
    outRe[k] = sr;
    outIm[k] = si;
  }
  return { re: outRe, im: outIm };
}

// 片側の平均二乗スペクトルを、作業用の配列を用意して求める
function spectrum(frame, win) {
  const n = frame.length;
  const plan = createFftPlan(n);
  const out = new Float64Array(n / 2 + 1);
  powerSpectrumInto(plan, frame, win, windowPowerSum(win), new Float64Array(n), new Float64Array(n), out);
  return out;
}

const rectWindow = (n) => new Float64Array(n).fill(1);
const sum = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; };
const assertClose = (actual, expected, rel, msg) => {
  assert.ok(
    Math.abs(actual - expected) <= rel * Math.abs(expected),
    `${msg}: ${actual}（期待 ${expected}、相対誤差の許容 ${rel}）`
  );
};

// ビン k の中心に乗る正弦波 A・sin(2πki/n + φ)。角度は (k・i) mod n で縮める
function sineFrame(n, k, amp, phase) {
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin(2 * Math.PI * ((k * i) % n) / n + phase);
  return x;
}


// ---- FFT そのもの ----

test('FFT の関数は、ワークレットのトップレベル関数として取り出せる', () => {
  for (const name of FFT_FUNCTIONS) {
    assert.equal(typeof W[name], 'function', `${name} をコンテキストから取り出せない`);
  }
});

test('⭐素朴な DFT と同じ値を返す（n = 2〜1024、複素数の入力）', () => {
  const r = rng(0xb0f7);
  for (const n of SIZES) {
    const plan = createFftPlan(n);
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) { re[i] = uniform(r); im[i] = uniform(r); }
    const ref = naiveDft(re, im);
    // 許容誤差は入力の大きさに比例させる。|X_k| の上限は Σ|x_i| である
    let scale = 0;
    for (let i = 0; i < n; i++) scale += Math.hypot(re[i], im[i]);
    const tol = 1e-12 * scale;

    fftInPlace(plan, re, im);
    let maxErr = 0;
    for (let k = 0; k < n; k++) {
      maxErr = Math.max(maxErr, Math.hypot(re[k] - ref.re[k], im[k] - ref.im[k]));
    }
    assert.ok(maxErr <= tol, `n=${n} の誤差 ${maxErr}（許容 ${tol}）`);
  }
});

test('パーセバルの等式 Σ|X_k|^2 = n・Σ|x_i|^2 が成り立つ', () => {
  const r = rng(0x9a55e7a1);
  for (const n of SIZES) {
    const plan = createFftPlan(n);
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    let timeSide = 0;
    for (let i = 0; i < n; i++) {
      re[i] = uniform(r);
      im[i] = uniform(r);
      timeSide += re[i] * re[i] + im[i] * im[i];
    }
    fftInPlace(plan, re, im);
    let freqSide = 0;
    for (let k = 0; k < n; k++) freqSide += re[k] * re[k] + im[k] * im[k];
    assertClose(freqSide, n * timeSide, 1e-12, `n=${n}`);
  }
});

test('createFftPlan は 2 以上の 2 の累乗でない長さを RangeError で拒む', () => {
  const bad = [0, 1, 3, 6, 12, 100, 1000, 1023, 1025, -2, -1024, 0.5, 2.5, NaN, Infinity, -Infinity, '8', null, undefined];
  for (const n of bad) {
    assert.throws(() => createFftPlan(n), { name: 'RangeError' }, `n=${String(n)} を拒んでいない`);
  }
  for (let n = 2; n <= 65536; n *= 2) {
    const plan = createFftPlan(n);
    assert.equal(plan.n, n);
    assert.equal(plan.rev.length, n);
    assert.equal(plan.cos.length, n / 2);
    assert.equal(plan.sin.length, n / 2);
  }
  // ビット反転の表は並べ替えで、2回かけると元に戻る
  for (const n of SIZES) {
    const rev = createFftPlan(n).rev;
    for (let i = 0; i < n; i++) assert.equal(rev[rev[i]], i, `n=${n} i=${i}`);
  }
});


// ---- 片側の平均二乗スペクトル（正規化）----

test('⭐ビンの中心に乗る正弦波：矩形窓なら out[k] = A^2/2、周期型 Hann 窓なら隣り合う3ビンの和が A^2/2', () => {
  const r = rng(0x5e1e);
  for (const n of SIZES) {
    for (const amp of [1, 0.1]) {
      // 矩形窓：1 ≤ k ≤ n/2-1 のどこでも、電力は k のビンだけに入る
      if (n >= 4) {
        for (const k of new Set([1, n / 4, n / 2 - 1])) {
          const out = spectrum(sineFrame(n, k, amp, r() * 2 * Math.PI), rectWindow(n));
          assertClose(out[k], amp * amp / 2, 1e-12, `矩形窓 n=${n} k=${k} A=${amp}`);
          for (let j = 0; j <= n / 2; j++) {
            if (j === k) continue;
            assert.ok(out[j] <= 1e-20 * amp * amp, `矩形窓 n=${n} k=${k} のビン ${j} に ${out[j]} が漏れている`);
          }
        }
      }
      // 周期型 Hann 窓：電力は k-1・k・k+1 に広がる。
      // ⚠ k=1 や k=n/2-1 では、広がった先が直流・ナイキストで負の周波数の鏡像と重なり、
      //    位相しだいで和が A^2/2 からずれる（数学的にずれる。n=64・k=1・A=1 なら位相 0 で 0.4167、
      //    π/2 で 0.5833）。ここでは 2 ≤ k ≤ n/2-2 で確かめる
      if (n >= 8) {
        const w = hannWindow(n);
        for (const k of new Set([2, n / 4, n / 2 - 2])) {
          const out = spectrum(sineFrame(n, k, amp, r() * 2 * Math.PI), w);
          assertClose(out[k - 1] + out[k] + out[k + 1], amp * amp / 2, 1e-12, `Hann n=${n} k=${k} A=${amp}`);
          for (let j = 0; j <= n / 2; j++) {
            if (Math.abs(j - k) <= 1) continue;
            assert.ok(out[j] <= 1e-20 * amp * amp, `Hann n=${n} k=${k} のビン ${j} に ${out[j]} が漏れている`);
          }
        }
      }
    }
  }
});

// 第1弾の定義そのもの（ワークレットが区間ごとに出す sumSq / count）を、ワークレットを動かして取る。
// 区間長を frame の長さにして、frame を1区間として流す
function workletMeanSquare(frame) {
  const n = frame.length;
  const w = loadWorklet();
  const proc = new w.registered['meter-processor']({ processorOptions: { intervalFrames: n } });
  // 最初の1回は起点に使われない（第2弾a8）ので、1ブロック前に空の呼び出しを入れる
  w.state.frame = -QUANTUM;
  proc.process([[]]);
  for (let f = 0; f <= n; f += QUANTUM) {
    w.state.frame = f;
    // n フレーム目の呼び出しで区間が閉じる（このブロックは次の区間に入る）
    proc.process([[f < n ? frame.subarray(f, f + QUANTUM) : new Float32Array(QUANTUM)]]);
  }
  const iv = w.messages.filter(m => m.type === 'interval');
  assert.equal(iv.length, 1, `区間の数 ${iv.length}`);
  assert.equal(iv[0].count, n);
  return iv[0].sumSq / iv[0].count;
}

test('⭐矩形窓なら全ビンの和が frame の平均二乗になり、第1弾の sumSq / count と一致する', () => {
  const r = rng(0x1d0c);
  // ワークレットの区間は 128 フレーム以上なので、ここでは 128 以上の長さで比べる
  for (const n of [128, 256, 1024, 4096]) {
    const frame = new Float32Array(n);   // ワークレットに届く入力と同じ Float32Array
    for (let i = 0; i < n; i++) frame[i] = uniform(r) * 0.5;
    let meanSq = 0;
    for (let i = 0; i < n; i++) meanSq += frame[i] * frame[i];
    meanSq /= n;

    const total = sum(spectrum(frame, rectWindow(n)));
    assertClose(total, meanSq, 1e-12, `n=${n} の平均二乗`);
    assertClose(total, workletMeanSquare(frame), 1e-12, `n=${n} の第1弾の sumSq / count`);
  }
});

test('窓を掛けたときは、全ビンの和が窓で重み付けした平均二乗 Σ(x・w)^2 / Σw^2 になる', () => {
  const r = rng(0x4a11);
  for (const n of SIZES) {
    const frame = new Float64Array(n);
    for (let i = 0; i < n; i++) frame[i] = uniform(r);
    const w = hannWindow(n);
    let weighted = 0;
    for (let i = 0; i < n; i++) weighted += (frame[i] * w[i]) ** 2;
    let wSq = 0;
    for (let i = 0; i < n; i++) wSq += w[i] * w[i];
    assertClose(sum(spectrum(frame, w)), weighted / wSq, 1e-12, `n=${n}`);
  }
});

test('直流は out[0] に、ナイキストは out[n/2] に、2倍にせずそのまま入る', () => {
  for (const n of SIZES) {
    for (const a of [0.5, -0.25]) {
      const dc = new Float64Array(n).fill(a);
      const nyquist = new Float64Array(n);
      for (let i = 0; i < n; i++) nyquist[i] = (i % 2 === 0) ? a : -a;   // (-1)^i・a

      const outDc = spectrum(dc, rectWindow(n));
      assertClose(outDc[0], a * a, 1e-12, `直流 n=${n} a=${a}`);
      const outNy = spectrum(nyquist, rectWindow(n));
      assertClose(outNy[n / 2], a * a, 1e-12, `ナイキスト n=${n} a=${a}`);
      for (let j = 0; j <= n / 2; j++) {
        if (j !== 0) assert.ok(outDc[j] <= 1e-20 * a * a, `直流 n=${n} のビン ${j} に ${outDc[j]} が漏れている`);
        if (j !== n / 2) assert.ok(outNy[j] <= 1e-20 * a * a, `ナイキスト n=${n} のビン ${j} に ${outNy[j]} が漏れている`);
      }
    }
  }
});

test('周期型 Hann 窓では、直流は out[0] に 2/3・out[1] に 1/3、ナイキストは out[n/2] に 2/3・out[n/2-1] に 1/3 と分かれる', () => {
  // ⚠ 矩形窓なら直流は out[0] だけに入る（上のテスト）が、Hann 窓を掛けると隣のビンへ広がる。
  //    48kHz・n=1024 ではビン1の中心は 46.875Hz で、20〜18,000Hz の帯域の内側にある。
  //    帯域はビン1から数えるので、平均を引かずに窓を掛けると、マイクの直流オフセットの 1/3 がその帯域の値に入る。
  //    b1 ではフレームごとに平均を引いてから窓を掛けるので、直流は入らない（第2弾b1。test/band.test.js）。
  //    帯域の割り当てがこの分かれ方を忘れないように縛る。
  assert.ok(binFrequency(1, SAMPLE_RATE, 1024) >= 20, 'ビン1が 20Hz より下にある（前提が変わった）');
  // 期待値は窓そのものの DFT（素朴な DFT）から作る。直流 a に窓を掛けた列の DFT は a・W_k なので
  // out[0] = a^2・|W_0|^2 / (n・Σw^2)、out[1] = 2・a^2・|W_1|^2 / (n・Σw^2)。
  // ナイキスト (-1)^i・a では W が n/2 ずれるので、同じ値が out[n/2] と out[n/2-1] に出る
  for (const n of SIZES) {
    if (n < 4) continue;   // n=2 の周期型 Hann 窓は [0, 1] で、3本に分かれない
    const w = hannWindow(n);
    const wDft = naiveDft(w, new Float64Array(n));
    let wSq = 0;
    for (let i = 0; i < n; i++) wSq += w[i] * w[i];
    const p0 = (wDft.re[0] ** 2 + wDft.im[0] ** 2) / (n * wSq);
    const p1 = 2 * (wDft.re[1] ** 2 + wDft.im[1] ** 2) / (n * wSq);
    // 閉じた形（W_0 = Σw = n/2、W_1 = -n/4、Σw^2 = 3n/8）から出る 2/3・1/3 とも合う
    assertClose(p0, (n / 2) ** 2 / (n * 3 * n / 8), 1e-12, `n=${n} の窓の k=0`);
    assertClose(p1, 2 * (n / 4) ** 2 / (n * 3 * n / 8), 1e-12, `n=${n} の窓の k=1`);
    for (const a of [0.5, -0.25]) {
      const dc = new Float64Array(n).fill(a);
      const nyquist = new Float64Array(n);
      for (let i = 0; i < n; i++) nyquist[i] = (i % 2 === 0) ? a : -a;   // (-1)^i・a

      const outDc = spectrum(dc, w);
      assertClose(outDc[0], a * a * p0, 1e-12, `直流 n=${n} a=${a} の k=0`);
      assertClose(outDc[1], a * a * p1, 1e-12, `直流 n=${n} a=${a} の k=1`);
      const outNy = spectrum(nyquist, w);
      assertClose(outNy[n / 2], a * a * p0, 1e-12, `ナイキスト n=${n} a=${a} の k=n/2`);
      assertClose(outNy[n / 2 - 1], a * a * p1, 1e-12, `ナイキスト n=${n} a=${a} の k=n/2-1`);
      for (let j = 0; j <= n / 2; j++) {
        if (j > 1) assert.ok(outDc[j] <= 1e-20 * a * a, `直流 n=${n} のビン ${j} に ${outDc[j]} が漏れている`);
        if (j < n / 2 - 1) assert.ok(outNy[j] <= 1e-20 * a * a, `ナイキスト n=${n} のビン ${j} に ${outNy[j]} が漏れている`);
      }
    }
  }
});

test('作業用の配列を使い回しても前の呼び出しの値が混ざらず、frame も書き換えない', () => {
  // b1 では re・im・out をコンストラクターで一度だけ作り、フレームごと（N/4 サンプルごと）に使い回す
  const n = 256;
  const r = rng(0x2e05e);
  const plan = createFftPlan(n);
  const w = hannWindow(n);
  const power = windowPowerSum(w);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  // out は n/2+1 より長く用意し、うしろに印を置く（書くのは n/2+1 個だけであること）
  const out = new Float64Array(n / 2 + 3).fill(-1);
  const frameA = new Float32Array(n);
  const frameB = new Float32Array(n);
  for (let i = 0; i < n; i++) { frameA[i] = uniform(r); frameB[i] = uniform(r); }
  const copyA = Array.from(frameA);

  powerSpectrumInto(plan, frameA, w, power, re, im, out);
  const first = Array.from(out);
  powerSpectrumInto(plan, frameB, w, power, re, im, out);
  powerSpectrumInto(plan, frameA, w, power, re, im, out);
  assert.deepEqual(Array.from(out), first, '同じ frame なのに、前の呼び出しで値が変わった');
  assert.deepEqual(Array.from(frameA), copyA, 'frame を書き換えている');
  assert.equal(out[n / 2 + 1], -1, 'n/2+1 個より先まで書いている');
  assert.equal(out[n / 2 + 2], -1, 'n/2+1 個より先まで書いている');
});


// ---- 周期型の Hann 窓 ----

test('周期型の Hann 窓：w[0] = 0、w[i] = w[n-i]、n ≥ 4 で Σw^2 = 3n/8', () => {
  for (const n of SIZES) {
    const w = hannWindow(n);
    assert.equal(Object.prototype.toString.call(w), '[object Float64Array]');
    assert.equal(w.length, n);
    assert.equal(w[0], 0);
    assert.equal(w[n / 2], 1);
    for (let i = 1; i < n; i++) {
      // 短いほうの角度で計算しているので、丸めの差も無くぴたりとそろう
      assert.equal(w[i], w[n - i], `n=${n} i=${i}`);
      const expected = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
      assert.ok(Math.abs(w[i] - expected) <= 1e-14, `n=${n} i=${i}: ${w[i]}（式では ${expected}）`);
    }
    // 周期型なので最後の点は 0 にならない（対称型なら分母が n-1 で、w[n-1] = 0 になる）
    assert.ok(w[n - 1] > 0, `n=${n} の最後の点が 0 になっている（対称型になっている）`);
    if (n >= 4) assertClose(windowPowerSum(w), 3 * n / 8, 1e-12, `n=${n} の Σw^2`);
  }
});


// ---- ビンと周波数 ----

test('binFrequency はビンの番号を周波数に直す（48kHz・n=1024 なら 18kHz はビン 384 の中心）', () => {
  const n = 1024;
  const width = SAMPLE_RATE / n;   // 1ビンの幅
  // 帯域の下端 18,000Hz は、ちょうどビン 384 の中心に乗る
  assert.equal(18000 / width, 384);
  assert.equal(binFrequency(384, SAMPLE_RATE, n), 18000);
  // 22,000Hz を超えない最後のビンは 469
  const last = Math.floor(22000 / width);
  assert.equal(last, 469);
  assert.equal(binFrequency(last, SAMPLE_RATE, n), 22000 - 22000 % width);   // 21984.375Hz
  assert.ok(binFrequency(last + 1, SAMPLE_RATE, n) > 22000);
  // 直流は 0Hz、k = n/2 はナイキスト（サンプルレートの半分）
  for (const rate of [44100, 48000, 96000]) {
    for (const m of [256, 1024, 4096]) {
      assert.equal(binFrequency(0, rate, m), 0);
      assert.equal(binFrequency(m / 2, rate, m), rate / 2, `rate=${rate} n=${m}`);
    }
  }
});


// ---- オーディオスレッドで配列を作らない約束（ソースの文字列で縛る）----
//
// ⚠ b1 では fftInPlace と powerSpectrumInto を process() から呼ぶ。オーディオスレッドで
//    配列やオブジェクトを作ると、ガベージコレクションで音が途切れうる。
//    ここでは関数のパラメーターと本体を文字列で切り出し、作る代表的な書き方が無いことを見る
//    （実行してヒープの増え方を数えてはいない）。見ているのは allocations() と paramAllocations() が
//    拾う書き方だけで、これで全部ではない（正規表現リテラル・文字列の連結・getter の中は見ていない）。
// ⚠ 第2弾b0の点検で、拒む書き方を並べる形では、new の付かない Array(n)・for…of・分割代入・
//    Object.create(…)・.bind(…)・残余引数などを見落としていた（どれを入れても14件すべて通った）。
//    呼び出しは許可リストで見る形に改め、パラメーターも見るようにした。

// コメントと文字列の中身を空白に置き換える（長さは変えない）。コメントの中の new や括弧を数えないため
function blankCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
    } else if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else if (c === '\'' || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += (src[j] === '\\') ? 2 : 1;
      out += c + ' '.repeat(Math.max(0, Math.min(j, src.length) - i - 1)) + (j < src.length ? c : '');
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// from の位置から後ろで最初に開く中括弧と、対になる閉じ括弧の間を返す
function braceBody(code, from) {
  const open = code.indexOf('{', from);
  assert.notEqual(open, -1, '本体の中括弧が見つからない');
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}' && --depth === 0) return code.slice(open + 1, i);
  }
  throw new Error('閉じ括弧が見つからない');
}

const CODE = blankCommentsAndStrings(SOURCE);

// 関数のパラメーター（丸括弧の中）と本体（中括弧の中）を切り出す。
// パラメーターも返すのは、残余引数や既定値が呼び出しごとに配列を作りうるためである
function functionParts(name, code = CODE) {
  const m = new RegExp(`\\bfunction\\s+${name}\\s*\\(([^)]*)\\)`).exec(code);
  assert.ok(m, `function ${name} が見つからない`);
  return { params: m[1], body: braceBody(code, m.index + m[0].length) };
}

function methodBody(className, method) {
  const cls = CODE.indexOf(`class ${className}`);
  assert.notEqual(cls, -1, `class ${className} が見つからない`);
  const body = braceBody(CODE, cls);
  const m = new RegExp(`\\n\\s*${method}\\s*\\(([^)]*)\\)`).exec(body);
  assert.ok(m, `${className} の ${method}() が見つからない`);
  return braceBody(body, m.index + m[0].length);
}

// 本体の中で呼んでよい関数（許可リスト）。ここに無い呼び出しはすべて報告する。
// Array(n)・Object.create(…)・re.slice()・g.bind(…)・structuredClone(…) のように、呼び出しの形で
// 配列やオブジェクトを作るものは数が多く、拒むものを並べる形では漏れた。
// ⚠ b1 でここから別の関数を呼ぶときは、その関数も配列を作らないことを確かめてから足す
const ALLOWED_CALLS = new Set(['fftInPlace']);
// Math の関数は数を返すだけなので許す
const isAllowedCall = (name) => ALLOWED_CALLS.has(name) || /^Math\.[\w$]+$/.test(name);
// 名前の直後に ( が来ても、関数の呼び出しではないもの
const NOT_CALLS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'void', 'delete',
  'in', 'of', 'instanceof', 'do', 'else', 'case', 'throw', 'await', 'yield', 'new', 'function'
]);

// 本体の中で、配列やオブジェクトを新しく作る書き方を探す。見つけたものを返す
function allocations(body) {
  const found = [];
  const add = (what, at) => found.push(`${what}：${JSON.stringify(body.slice(Math.max(0, at - 24), at + 24).trim())}`);
  // new ○○（new Float64Array・new Array・new Object など、コンストラクターの呼び出しすべて）
  for (const m of body.matchAll(/\bnew\b/g)) add('new', m.index);
  // 関数・アロー関数（クロージャーを作る）とスプレッド
  for (const m of body.matchAll(/\bfunction\b|=>/g)) add('関数', m.index);
  for (const m of body.matchAll(/\.\.\./g)) add('スプレッド', m.index);
  // 関数の呼び出しは許可リストで見る。new の付かない Array(n)・Object.create(…)・re.slice()・
  // g.bind(…)・re.entries()・Array.prototype.slice.call(…) などを、名前を並べずにまとめて拾う
  for (const m of body.matchAll(/([\w$][\w$.]*)\s*\(/g)) {
    if (NOT_CALLS.has(m[1]) || isAllowedCall(m[1])) continue;
    add(`許可していない呼び出し（${m[1]}）`, m.index);
  }
  // 名前を介さない呼び出し（a[0](…)・(f)(…)・f?.(…)）とテンプレートリテラル（タグ付きなら呼び出し）。
  // 許可リストの名前の検査をすり抜けるため、形で拾う
  for (const m of body.matchAll(/[\])]\s*\(|\?\.\s*\(/g)) add('名前を介さない呼び出し', m.index);
  for (const m of body.matchAll(/`/g)) add('テンプレートリテラル', m.index);
  // arguments（呼び出しごとにオブジェクトを作りうる）
  for (const m of body.matchAll(/\barguments\b/g)) add('arguments', m.index);
  // for…of は反復子（オブジェクト）を作る。for…in も同じ扱いにする
  for (const m of body.matchAll(/\bfor\s*\([^;)]*\b(?:of|in)\b/g)) add('for…of・for…in', m.index);
  // [ と { は、直前の文字で「添え字・ブロック」か「リテラル」かを見分ける
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '[' && c !== '{') continue;
    let j = i - 1;
    while (j >= 0 && /\s/.test(body[j])) j--;
    const prev = j >= 0 ? body[j] : '';
    const wordMatch = /[\w$]+$/.exec(body.slice(0, j + 1));
    const word = wordMatch ? wordMatch[0] : '';
    if (c === '[') {
      // 添え字（re[i]・plan.rev[i]・a[b][c]・(x)[i]）なら、直前は識別子・]・) である。
      // ただし const・let・var の直後は配列の分割代入（反復子を作る）、throw の直後はリテラルである
      const index = /[\w$\])]/.test(prev) &&
        !/^(?:return|typeof|case|in|of|do|else|void|yield|await|throw|const|let|var)$/.test(word);
      if (!index) add('配列リテラル・分割代入', i);
    } else {
      // ブロック（if (…) {・else {・do {・try {・{ の入れ子）なら、直前は )・キーワード・{・}・; である
      const block = prev === '' || /[){};]/.test(prev) || /^(?:else|do|try|finally)$/.test(word);
      if (!block) add('オブジェクトリテラル', i);
    }
  }
  return found;
}

// パラメーターは名前を並べただけにする。残余引数（...rest）は呼び出しごとに配列を作り、
// 既定値（tmp = new Float64Array(8)）は省かれるたびに評価され、配列の分割代入は反復子を作る
function paramAllocations(params) {
  return /^\s*(?:[\w$]+\s*(?:,\s*[\w$]+\s*)*)?$/.test(params)
    ? []
    : [`パラメーターが名前を並べただけになっていない：${JSON.stringify(params.trim())}`];
}

test('配列を作る書き方の検出そのものが、挙げた書き方をすべて拾い、ふつうの添え字・ブロック・許可した呼び出しを拾わない', () => {
  // ⚠ 検出が何も拾わない作りだと、下のテストは中身を見ないまま通る。先に検出を確かめる
  const bad = [
    'const t = new Float64Array(n);',
    'const a = new Array(n);',
    'const e = [];',
    '[re[i], re[j]] = [re[j], re[i]];',
    'const o = {};',
    'const o = { re, im };',
    'return { re, im };',
    'return [re, im];',
    'const v = re.subarray(0, 4);',
    'const c = re.slice();',
    'g(x => x);',
    'h(...re);',
    // ここから下は、第2弾b0の点検で見落としていた書き方
    'const a = Array(n);',
    'const o = Object.create(null);',
    'const s = structuredClone(re);',
    'const f = g.bind(null);',
    'const c = Array.prototype.slice.call(re);',
    're.toSorted();',
    're.with(0, 1);',
    'const it = re.entries();',
    'for (const v of re) s += v;',
    'for (const k in plan) s++;',
    'const [d0, d1] = out;',
    'throw [1];',
    'const x = arguments[0];',
    'const y = plan.rev[0](1);',
    'const z = f?.(1);',
    'const s = tag`x`;'
  ];
  for (const s of bad) assert.ok(allocations(blankCommentsAndStrings(s)).length > 0, `見逃した: ${s}`);
  const good = [
    'for (let i = 0; i < n; i++) { re[i] = frame[i] * win[i]; im[i] = 0; }',
    'if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; } else { out[0] = 0; }',
    'out[k] = 2 * (re[k] * re[k] + im[k] * im[k]) * scale;',
    'const x = plan.rev[i]; const y = a[b][c];',
    // 許可した呼び出し（fftInPlace と Math の関数）と、of・in で始まる名前
    'fftInPlace(plan, re, im); const r = Math.sqrt(re[0]) + Math.abs(im[0]);',
    'for (let index = 0, info = 1; index < n; index++) s += info;'
  ];
  for (const s of good) assert.deepEqual(allocations(blankCommentsAndStrings(s)), [], `誤って拾った: ${s}`);

  // パラメーター：残余引数・既定値・配列の分割代入を拾い、名前を並べただけのものは拾わない。
  // 既定値の中に丸括弧があっても、切り出しがパラメーターの途中で止まるだけで = は残る
  const badParams = [
    'function f(plan, re, im, ...rest) { re[0] = 0; }',
    'function f(plan, re, im, tmp = new Float64Array(8)) { re[0] = 0; }',
    'function f([a, b], re) { re[0] = a; }'
  ];
  for (const s of badParams) {
    const { params } = functionParts('f', blankCommentsAndStrings(s));
    assert.ok(paramAllocations(params).length > 0, `見逃した: ${s}`);
  }
  for (const p of ['plan, re, im', 'plan, frame, win, winPower, re, im, out', '']) {
    assert.deepEqual(paramAllocations(p), [], `誤って拾った: ${p}`);
  }
});

test('⭐fftInPlace と powerSpectrumInto のパラメーターと本体に、配列やオブジェクトを作る書き方（上で拾うもの）が無い', () => {
  for (const name of ['fftInPlace', 'powerSpectrumInto']) {
    const { params, body } = functionParts(name);
    // 切り出しに失敗して空の本体を見ていないこと
    assert.ok(body.includes('re[') && body.includes('im['), `${name} の本体を切り出せていない`);
    assert.deepEqual(paramAllocations(params), [], `${name} のパラメーターで配列を作りうる`);
    assert.deepEqual(allocations(body), [], `${name} の中で配列かオブジェクトを作っている`);
  }
});


// ---- b1 で帯域の集計から呼ぶ ----
//
// ⚠ 第2弾b0 では、ここで「b0 は置くだけで、process() はまだ FFT を呼んでいない」を縛っていた。
//    b1 で区間ごとの帯域の集計に使い始めたので、b1 の実態に合わせて書き換えた（第2弾b1）。
//    置くだけの約束のままでは、呼び始めた時点で必ず落ちる。代わりに、呼び方の約束を縛る。
//    - 計画・窓・作業用の配列を作る関数（createFftPlan・hannWindow・windowPowerSum）は、
//      コンストラクターから呼ぶ setupBands の中だけで呼ぶ。最初の遅さを済ませる powerSpectrumInto もそこで呼ぶ
//    - process() は FFT の関数を直に呼ばず、feedBands を通す。フレームごとの計算は analyzeBandFrame
//    - フレームごとに通るメソッド（feedBands・analyzeBandFrame・addBandFrame）と process() のパラメーターと
//      本体に、配列やオブジェクトを作る書き方（上の allocations() が拾うもの）が無い。
//      呼んでよいのは、同じ約束を守るこれらのメソッドと powerSpectrumInto だけ。
//      ⚠ process() から呼ぶ emitInterval は、区間ごとに1回（既定で1秒に1回）メッセージを作って送る。
//      第1弾からの作りで、b1 で帯域の電力の和の配列（bandPowerList）も区間ごとに1つ作るようにした。
//      フレームごとではないので、ここでは中身を見ない
//    ビンの割り当ては logic.js の bandPlan が行ってビンの番号を渡すので、クラスは binFrequency を使わない。

test('b1 では FFT を帯域の集計から呼び、フレームごとに通るメソッドの中では配列もオブジェクトも作らない', () => {
  const cls = braceBody(CODE, CODE.indexOf('class MeterProcessor'));
  const proc = methodBody('MeterProcessor', 'process');
  assert.ok(proc.includes('emitInterval'), 'process() の本体を切り出せていない');
  assert.match(proc, /\bthis\.feedBands\s*\(/, 'process() が帯域の集計（feedBands）を呼んでいない');
  for (const name of FFT_FUNCTIONS) {
    assert.ok(!new RegExp(`\\b${name}\\b`).test(proc), `process() が ${name} を直に呼んでいる（feedBands を通す）`);
  }

  // 配列を作る準備は setupBands の中だけ
  const setup = methodBody('MeterProcessor', 'setupBands');
  for (const name of ['createFftPlan', 'hannWindow', 'windowPowerSum', 'powerSpectrumInto']) {
    assert.match(setup, new RegExp(`\\b${name}\\s*\\(`), `setupBands が ${name} を呼んでいない`);
  }
  const outside = cls.replace(setup, '');
  assert.notEqual(outside, cls, 'setupBands の本体を取り除けていない');
  for (const name of ['createFftPlan', 'hannWindow', 'windowPowerSum', 'binFrequency']) {
    assert.ok(!new RegExp(`\\b${name}\\b`).test(outside), `MeterProcessor が setupBands の外で ${name} を使っている`);
  }
  assert.match(methodBody('MeterProcessor', 'analyzeBandFrame'), /\bpowerSpectrumInto\s*\(/,
    'フレームごとの計算（analyzeBandFrame）が powerSpectrumInto を呼んでいない');

  // フレームごとに通るメソッドで、呼んでよいもの（どれも配列を作らないことを、このテストで見ている）
  const perFrameCalls = new Set([
    'powerSpectrumInto', 'this.feedBands', 'this.analyzeBandFrame', 'this.addBandFrame', 'this.emitInterval'
  ]);
  for (const method of ['process', 'feedBands', 'analyzeBandFrame', 'addBandFrame']) {
    const m = new RegExp(`\\n\\s*${method}\\s*\\(([^)]*)\\)`).exec(cls);
    assert.ok(m, `${method}() が見つからない`);
    assert.deepEqual(paramAllocations(m[1]), [], `${method} のパラメーターで配列を作りうる`);
    const body = methodBody('MeterProcessor', method);
    assert.ok(body.trim().length > 0, `${method} の本体を切り出せていない`);
    const found = allocations(body).filter(s => {
      const call = /^許可していない呼び出し（(.+?)）/.exec(s);
      return !(call && perFrameCalls.has(call[1]));
    });
    assert.deepEqual(found, [], `${method} の中で配列かオブジェクトを作っている`);
  }
});
