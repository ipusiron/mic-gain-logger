'use strict';

// 区間ごとの帯域の集計を固める（第2弾b1）。
//
// ワークレット（worklet/meter-processor.js）を node:vm の中で動かし、区間ごとに送る帯域の値
// （帯域ごとの電力の和 bandPower・数えたフレーム数 bandFrames・数えるはずだったフレーム数 bandExpected）と、
// logic.js の換算（帯域の dBFS・band_valid_ratio）を確かめる。CSV の列（b2）と画面（b3）はまだ無い。
//
// ここで固めること：
//  - 帯域の定義は logic.js の BAND_DEFS にだけあり、FFT の長さとビンの割り当ても logic.js が決めて
//    processorOptions で渡す（ワークレットに同じ値を書かない）
//  - 設計で決めた帯域の範囲とビンの範囲（値が黙って動かないように、数そのものも縛る）
//  - FFT の長さ（約21.3ミリ秒になる2の累乗）と、ビンの割り当ての境目（オフバイワン）。44.1kHz・48kHz・96kHz
//  - 帯域の中の正弦波（約100Hz 以上で、帯域の端から2ビンほど内側のもの）は、その帯域に A^2/2 として入る。
//    フレームごとに平均を引くので、直流は入らない
//  - 約100Hz より下の正弦波は、平均を引くぶん値が大きく変わる（20Hz で約 -8dB）。素朴な参照と比べて固める
//  - ずらし幅 N/4（75% の重なり）で、両帯域のビンの中（上と同じ条件）にだけ音がある定常な信号なら、
//    全帯域を足した値が時間領域の平均二乗と一致する
//  - フレームの中身はサンプル [g-N, g) で、終わり g を含む区間に数える（素朴な参照とサンプル単位で比べる）。
//    そのため、デジタル無音の区間にも、直前の区間の最後の N サンプル以内の音が入る
//  - 区間の境目のそばの1ミリ秒の衝撃音が、隣り合う区間を合わせて消えない
//  - クォンタムが落ちたとき・入力が空のとき、そのサンプルを含むフレームを数えない（band_valid_ratio が下がる）
//  - 1行目の band_valid_ratio は 1（記録の起点より前のサンプルが要るフレームを、数えるはずのフレームに入れない）
//  - bands: false（?bands=off）では FFT を計算せず、既存の値（dbfs・valid_ratio）は変わらない
//  - コンストラクターで powerSpectrumInto を前もって呼んでおく
// ⚠ 帯域の値は「その帯域に音のエネルギーがあったか」の記録である。何が鳴っていたかは分からない。
//
// 期待値は手で書かず、式や素朴な計算（数え上げ・窓の DFT）から出す。乱数は種を固定して作る
// （Math.random は使わない）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(root, 'worklet', 'meter-processor.js'), 'utf8');
const SCRIPT = fs.readFileSync(path.join(root, 'script.js'), 'utf8');
const {
  BAND_DEFS, fftSizeForRate, bandBins, bandPlan, bandsEnabledFromQuery,
  buildIntervalRecord, buildFallbackRecord, dbToPower, csvDataFields
} = require('../logic.js');

const QUANTUM = 128;
const ANCHOR = { epoch: 0, audioTime: 0, wallMs: Date.UTC(2026, 8, 29, 0, 0, 0) };
const ULTRA = BAND_DEFS.findIndex(d => d.key === 'ultra');
const AUDIBLE = BAND_DEFS.findIndex(d => d.key === 'audible');

// ワークレットを node:vm の中で動かす（test/meter-processor.test.js と同じ差し替え）。
// powerSpectrumInto は、呼ばれた回数を数える包みに差し替える。トップレベルの function 宣言は
// 大域オブジェクトのプロパティなので、クラスの中からの呼び出しも差し替えた先へ届く。
// plan を省くと logic.js の bandPlan(rate) を渡す（script.js と同じ）。null なら計画を渡さない。
// warmUp=true（既定）なら、数え始めるフレームの1ブロック前に空の呼び出しを1回入れる
// （最初の1回は起点に使われない。第2弾a8）
function createHarness(opts = {}) {
  const rate = opts.rate || 48000;
  const intervalFrames = opts.intervalFrames || rate;
  const startFrame = opts.startFrame || 0;
  const warmUp = opts.warmUp !== false;
  const state = { frame: startFrame };
  const messages = [];
  const registered = {};
  const sandbox = {
    sampleRate: rate,
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
  Object.defineProperty(sandbox, 'currentTime', { get: () => state.frame / rate });
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'meter-processor.js' });

  const spy = { calls: 0 };
  const original = sandbox.powerSpectrumInto;
  sandbox.powerSpectrumInto = function (...args) {
    spy.calls++;
    return original(...args);
  };

  const processorOptions = { intervalFrames };
  if (opts.bands !== undefined) processorOptions.bands = opts.bands;
  const plan = opts.plan === undefined ? bandPlan(rate) : opts.plan;
  if (plan !== null) processorOptions.bandPlan = plan;
  const proc = new registered['meter-processor']({ processorOptions });
  const warmCalls = spy.calls;
  const ready = messages.find(m => m.type === 'ready');
  messages.length = 0;
  if (warmUp) {
    state.frame = startFrame - QUANTUM;
    proc.process([[]]);
    state.frame = startFrame;
  }

  return {
    rate,
    n: plan ? plan.fftSize : null,
    state,
    messages,
    proc,
    spy,
    warmCalls,
    ready,
    sandbox,
    // 1レンダークォンタムぶん進める。fill(t) は絶対のフレーム番号 t のサンプル
    tick(fill) {
      const block = new Float32Array(QUANTUM);
      for (let i = 0; i < QUANTUM; i++) block[i] = fill(state.frame + i);
      proc.process([[block]]);
      state.frame += QUANTUM;
    },
    // オーディオスレッドがクォンタムを落とした（process() が呼ばれず、クロックだけ進む）
    drop() { state.frame += QUANTUM; },
    // 入力が空のまま呼ばれた
    empty() {
      proc.process([[]]);
      state.frame += QUANTUM;
    },
    // frames フレームぶん（クォンタム単位に切り上げて）進める
    run(fill, frames) {
      const end = state.frame + frames;
      while (state.frame < end) this.tick(fill);
    },
    intervals() { return messages.filter(m => m.type === 'interval'); },
    records() { return this.intervals().map(m => buildIntervalRecord(m, ANCHOR, -90)); }
  };
}

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

// 正弦波 amp・sin(2π・f・t / rate + phase)
const sine = (f, amp, phase, rate) => (t) => amp * Math.sin(2 * Math.PI * f * t / rate + phase);
// ビン k の中心に乗る正弦波。長さ n のどのフレームにもちょうど k 周期が入る。角度は (k・t) mod n で縮める
const binSine = (k, n, amp, phase) => (t) => amp * Math.sin(2 * Math.PI * ((k * t) % n) / n + phase);
const sumOf = (fs) => (t) => { let s = 0; for (const f of fs) s += f(t); return s; };

// [from, to) の中で、終わりが hop の倍数になるフレームの終わり g を1つずつ数える（素朴な数え上げ）
function framesEndingIn(from, to, hop) {
  const list = [];
  for (let g = from; g < to; g++) if (g % hop === 0) list.push(g);
  return list;
}

// 区間 [S, E) で数えるはずのフレーム：終わり g が hop の倍数で、記録の起点 origin より前のサンプルが要らない（g - n ≥ origin）
function expectedEnds(S, E, origin, n) {
  return framesEndingIn(S, E, n / 4).filter(g => g - n >= origin);
}

// 帯域の平均二乗（電力の和 ÷ 数えたフレーム数）
const bandMeanSq = (m, band) => m.bandPower[band] / m.bandFrames;
const relErr = (a, b) => Math.abs(a / b - 1);

// ビン k の中心に乗る正弦波の電力が、周期型 Hann 窓で k-1・k・k+1 に分かれる割合。
// 窓の DFT（W_j = Σ w_i・e^(-2πj・ij/n)）の j = 0・1 から出す。ワークレットの hannWindow を使う
function hannSplit(W, n) {
  const w = W.hannWindow(n);
  let w0 = 0;
  let w1re = 0;
  let w1im = 0;
  for (let i = 0; i < n; i++) {
    w0 += w[i];
    w1re += w[i] * Math.cos(2 * Math.PI * i / n);
    w1im -= w[i] * Math.sin(2 * Math.PI * i / n);
  }
  const p0 = w0 * w0;
  const p1 = w1re * w1re + w1im * w1im;
  return { center: p0 / (p0 + 2 * p1), side: p1 / (p0 + 2 * p1) };
}

// 区間ごとの帯域の電力の和を、素朴に計算し直す（ワークレットの FFT・リングバッファを使わない参照）。
// 終わり g が H の倍数のフレームごとに、サンプル [g-N, g) を signal から明示的に作り、平均を引いて
// hannWindow を掛け、素朴な DFT（O(N・ビン数)）で帯域のビンの電力（片側。ナイキストのビンだけ1倍）を足して、
// g を含む区間（origin + i・interval ≤ g < origin + (i+1)・interval）に積む。
// 記録の起点 origin より前のサンプルが要るフレーム（g - N < origin）は作らない。途切れは扱わない。
// 届くサンプルは Float32 なので、signal の値は Math.fround で丸める。中身がすべて0のフレームは電力0なので飛ばす
function referenceBandPower(W, signal, rate, origin, interval, count) {
  const plan = bandPlan(rate);
  const n = plan.fftSize;
  const hop = n / 4;
  const w = W.hannWindow(n);
  let wSq = 0;
  for (let i = 0; i < n; i++) wSq += w[i] * w[i];
  const cos = new Float64Array(n);
  const sin = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    cos[i] = Math.cos(2 * Math.PI * i / n);
    sin[i] = Math.sin(2 * Math.PI * i / n);
  }
  const sums = [];
  for (let i = 0; i < count; i++) sums.push(plan.bands.map(b => (b.binLo === null ? null : 0)));
  const frame = new Float64Array(n);
  const end = origin + interval * count;
  for (let g = Math.ceil((origin + n) / hop) * hop; g < end; g += hop) {
    let mean = 0;
    let silent = true;
    for (let i = 0; i < n; i++) {
      frame[i] = Math.fround(signal(g - n + i));
      mean += frame[i];
      if (frame[i] !== 0) silent = false;
    }
    if (silent) continue;
    mean /= n;
    for (let i = 0; i < n; i++) frame[i] = (frame[i] - mean) * w[i];
    const row = sums[Math.floor((g - origin) / interval)];
    plan.bands.forEach((b, j) => {
      if (b.binLo === null) return;
      for (let k = b.binLo; k <= b.binHi; k++) {
        let re = 0;
        let im = 0;
        for (let i = 0; i < n; i++) {
          const a = (i * k) % n;
          re += frame[i] * cos[a];
          im -= frame[i] * sin[a];
        }
        row[j] += (k === n / 2 ? 1 : 2) * (re * re + im * im) / (n * wSq);
      }
    });
  }
  return sums;
}

// ワークレットの区間ごとの帯域の電力の和が、参照と合うか。差は、参照でいちばん大きい区間の両帯域の合計に対して見る。
// 帯域の外の音では、その帯域の値が丸めの誤差ほどに小さく、それ自身に対する比では比べられないため
// （インパルスがフレームの端に来ると、窓で0になり、平均を引いたぶんだけがビン0・1に残る）
function assertMatchesReference(got, ref, tol, label) {
  assert.equal(got.length, ref.length, `${label}: 区間の数`);
  let scale = 0;
  for (const row of ref) scale = Math.max(scale, row.reduce((s, v) => s + (v || 0), 0));
  assert.ok(scale > 0, `${label}: 参照がすべて0（前提が変わった）`);
  for (let i = 0; i < ref.length; i++) {
    ref[i].forEach((v, j) => {
      const p = got[i].bandPower[j];
      if (v === null) {
        assert.equal(p, null, `${label}: 区間 ${i} の ${BAND_DEFS[j].key}`);
        return;
      }
      // 参照が0（フレームがすべて無音）なら、ワークレットもちょうど0であること
      if (v === 0) assert.equal(p, 0, `${label}: 区間 ${i} の ${BAND_DEFS[j].key}`);
      assert.ok(Math.abs(p - v) <= tol * scale, `${label}: 区間 ${i} の ${BAND_DEFS[j].key} が ${p}（参照は ${v}）`);
    });
  }
}


// ---- 帯域の定義は logic.js にだけ置く ----

test('帯域の定義は logic.js の BAND_DEFS にあり、ワークレットには同じ値を書いていない', () => {
  assert.deepEqual(BAND_DEFS.map(d => d.key), ['ultra', 'audible']);
  // 設計で決めた値そのもの（計算で出す期待値ではない）。b2 で `# bands=18000-22000,20-18000` をヘッダーへ
  // 出すので、値が黙って動かないように縛る。下の境目のテストは期待値を BAND_DEFS から計算するので、
  // 定義が動くと期待値も一緒に動き、それだけでは気づけない
  assert.deepEqual(BAND_DEFS.map(d => [d.key, d.lo, d.hi]), [['ultra', 18000, 22000], ['audible', 20, 18000]]);
  for (const d of BAND_DEFS) assert.ok(d.lo < d.hi, `${d.key} の範囲が逆`);
  // 可聴帯の上端と超音波帯の下端はつながっている（すき間も重なりもない）
  assert.equal(BAND_DEFS[AUDIBLE].hi, BAND_DEFS[ULTRA].lo);
  assert.ok(Object.isFrozen(BAND_DEFS) && BAND_DEFS.every(d => Object.isFrozen(d)), '定義を書き換えられる');

  // ワークレットのコード（コメントを除く）に、帯域の範囲・名前と FFT の長さの決め方の数が無い
  const code = SOURCE.replace(/\/\/.*$/gm, '');
  assert.ok(code.includes('class MeterProcessor'), 'コメントを除いたら本体まで消えた');
  // 20 のような小さい数はほかの意味でも出てくるので、1000 以上の境目だけを見る
  const literals = new Set();
  for (const d of BAND_DEFS) for (const v of [d.lo, d.hi]) if (v >= 1000) literals.add(String(v));
  literals.add('48000');
  literals.add('1024');
  for (const lit of literals) {
    assert.ok(!new RegExp(`\\b${lit}\\b`).test(code), `ワークレットに ${lit} が書いてある（logic.js から渡す）`);
  }
  for (const d of BAND_DEFS) assert.ok(!code.includes(d.key), `ワークレットに帯域の名前 ${d.key} が書いてある`);
});

test('script.js は logic.js の bandPlan と ?bands=off の判定を processorOptions で渡すだけで、自分では計算しない', () => {
  const m = SCRIPT.match(/processorOptions:\s*\{([\s\S]*?)\n\s*\}/);
  assert.ok(m, 'processorOptions が見つからない');
  assert.match(m[1], /bandPlan:\s*bandPlan\(audioCtx\.sampleRate\)/);
  assert.match(m[1], /bands:\s*bandsEnabledFromQuery\(window\.location\.search\)/);
  // URL の読み取りの判定も、FFT の長さ・ビンも script.js に書かない（コメントの中の説明は除いて見る）
  const code = SCRIPT.replace(/\/\/.*$/gm, '');
  assert.ok(code.includes('bandsEnabledFromQuery('), 'コメントを除いたら本体まで消えた');
  assert.ok(!/bands=off|'off'|"off"|URLSearchParams/.test(code), 'script.js が ?bands=off を自分で読んでいる');
  assert.ok(!/\bfftSizeForRate\b|\bbandBins\b|Math\.log2/.test(code), 'script.js が FFT の長さかビンを計算している');
});


// ---- FFT の長さとビンの割り当て（logic.js）----

test('FFT の長さは約21.3ミリ秒になる2の累乗で、44.1kHz と 48kHz、88.2kHz と 96kHz がそれぞれ同じ長さになる', () => {
  const rates = [3000, 8000, 16000, 22050, 32000, 44100, 48000, 88200, 96000, 176400, 192000, 384000, 768000];
  const ref = 1024 / 48000;   // 48kHz で 1024 サンプル＝21.3ミリ秒（設計の基準）
  for (const rate of rates) {
    const n = fftSizeForRate(rate);
    assert.equal(n, Math.pow(2, Math.round(Math.log2(rate * ref))), `rate=${rate}`);
    assert.ok(Number.isInteger(Math.log2(n)), `rate=${rate} の N=${n} が2の累乗でない`);
    // 2の累乗に丸めたので、長さ（秒）は基準の 1/√2〜√2 倍に収まる
    assert.ok(n / rate >= ref / Math.SQRT2 && n / rate <= ref * Math.SQRT2, `rate=${rate} の長さ ${n / rate}`);
    assert.equal(n % 4, 0, `rate=${rate} のずらし幅 N/4 が整数でない`);
  }
  assert.equal(fftSizeForRate(48000) / 48000, ref);
  assert.equal(fftSizeForRate(44100), fftSizeForRate(48000));
  assert.equal(fftSizeForRate(88200), fftSizeForRate(96000));
  assert.equal(fftSizeForRate(96000), 2 * fftSizeForRate(48000));
  for (const bad of [0, -48000, NaN, Infinity, undefined, null, '48000']) {
    assert.equal(fftSizeForRate(bad), null, `rate=${String(bad)}`);
    assert.equal(bandPlan(bad), null, `rate=${String(bad)}`);
  }
});

test('⭐ビンの割り当ての境目（オフバイワン）：44.1kHz・48kHz・96kHz で、中心周波数が lo 以上 hi 未満のビンだけ', () => {
  for (const rate of [44100, 48000, 96000]) {
    const plan = bandPlan(rate);
    const n = plan.fftSize;
    assert.equal(n, fftSizeForRate(rate));
    const f = (k) => k * rate / n;
    plan.bands.forEach((b, i) => {
      const def = BAND_DEFS[i];
      assert.equal(b.key, def.key);
      // 式から：f_k ≥ lo ⇔ k ≥ lo・n/rate、f_k < hi ⇔ k < hi・n/rate。k は 1〜n/2
      const lo = Math.max(1, Math.ceil(def.lo * n / rate));
      const hi = Math.min(n / 2, Math.ceil(def.hi * n / rate) - 1);
      assert.equal(b.binLo, lo, `${rate}Hz の ${def.key} の下端`);
      assert.equal(b.binHi, hi, `${rate}Hz の ${def.key} の上端`);
      // 境目のビンを1つずつ見る：内側は帯域に入り、外側は入らない
      assert.ok(f(b.binLo) >= def.lo && f(b.binHi) < def.hi, `${rate}Hz の ${def.key} の内側`);
      assert.ok(b.binLo === 1 || f(b.binLo - 1) < def.lo, `${rate}Hz の ${def.key} で下端の1つ下も入るはず`);
      assert.ok(b.binHi === n / 2 || f(b.binHi + 1) >= def.hi, `${rate}Hz の ${def.key} で上端の1つ上も入るはず`);
      assert.ok(b.binLo >= 1, '直流のビン0を入れている');
    });
    // 可聴帯と超音波帯は、ビンでもすき間なく隣り合う（18kHz ちょうどのビンは超音波帯に入る）
    assert.equal(plan.bands[AUDIBLE].binHi + 1, plan.bands[ULTRA].binLo, `${rate}Hz`);
    // 直流のビン0は、帯域の下端が 0Hz でも入れない。上端はナイキストのビン n/2 まで
    assert.deepEqual(bandBins({ lo: 0, hi: rate }, rate, n), { binLo: 1, binHi: n / 2 }, `${rate}Hz`);
  }
  // 設計に書いた超音波帯のビンの範囲（48kHz は 384〜469、44.1kHz は 418〜510）。上の式と同じく、
  // 帯域の定義が動いたときに気づけるように、数そのものも1行ずつ見る
  const ultraBins = (rate) => {
    const u = bandPlan(rate).bands[ULTRA];
    return [u.binLo, u.binHi];
  };
  assert.deepEqual(ultraBins(48000), [384, 469]);
  assert.deepEqual(ultraBins(44100), [418, 510]);
});

test('サンプルレートが低くて帯域を表せないときは、その帯域のビンが null になる', () => {
  for (const rate of [8000, 16000, 22050, 32000]) {
    const plan = bandPlan(rate);
    const u = plan.bands[ULTRA];
    // ナイキスト（rate/2）が超音波帯の下端に届かない
    assert.ok(rate / 2 < BAND_DEFS[ULTRA].lo);
    assert.deepEqual([u.binLo, u.binHi], [null, null], `${rate}Hz`);
    assert.ok(plan.bands[AUDIBLE].binLo >= 1, `${rate}Hz の可聴帯にビンが無い`);
  }
  // 直接呼んでも同じ
  assert.deepEqual(bandBins({ lo: 18000, hi: 22000 }, 32000, 512), { binLo: null, binHi: null });
});

test('⭐ワークレットは渡されたビンの範囲どおりに足す（境目のビンの中心に乗る正弦波を、窓の分かれ方から読む）', () => {
  // ビン k の中心に乗る正弦波の電力は、周期型 Hann 窓で k-1・k・k+1 に side・center・side と分かれる。
  // 超音波帯の下端・上端の内側と外側のビンに1本ずつ置き、帯域ごとに入った割合を式と比べる。
  // ワークレットが範囲を1つずらして足していれば、ここで割合が変わる
  for (const rate of [44100, 48000, 96000]) {
    const plan = bandPlan(rate);
    const n = plan.fftSize;
    const u = plan.bands[ULTRA];
    // 分かれ方の式は k-1・k・k+1 が 1〜N/2 に収まるときのもの（N/2 を超えると負の周波数の側から折り返す）。
    // 収まらないビンは試さない（帯域の範囲そのものは、上の2つのテストが数で縛っている）
    const ks = [u.binLo - 1, u.binLo, u.binHi, u.binHi + 1].filter(k => k - 1 >= 1 && k + 1 <= n / 2);
    assert.equal(ks.length, 4, `${rate}Hz: 試すビンが減った（前提が変わった）`);
    for (const k of ks) {
      const h = createHarness({ rate, intervalFrames: Math.round(rate / 10) });
      const amp = 0.25;
      h.run(binSine(k, n, amp, 0.4), Math.round(rate / 10) * 3 + QUANTUM);
      const m = h.intervals()[1];   // 2つめの区間（すべてのフレームが揃っている）
      assert.equal(m.bandFrames, m.bandExpected);
      const split = hannSplit(h.sandbox, n);
      const share = (band) => {
        const b = plan.bands[band];
        let s = 0;
        for (const j of [k - 1, k, k + 1]) {
          if (j >= b.binLo && j <= b.binHi) s += (j === k) ? split.center : split.side;
        }
        return s;
      };
      for (const band of [ULTRA, AUDIBLE]) {
        const got = bandMeanSq(m, band) / (amp * amp / 2);
        assert.ok(Math.abs(got - share(band)) <= 1e-6,
          `${rate}Hz のビン ${k} の正弦波：${BAND_DEFS[band].key} に ${got}（式では ${share(band)}）`);
      }
    }
  }
});


// ---- 帯域の中の正弦波（48kHz）----

test('⭐超音波帯の中の正弦波は超音波帯に A^2/2 として入り、可聴帯はずっと小さい（ビンの中心から外れた周波数も）', () => {
  const r = rng(0xb1a5);
  for (const rate of [48000, 44100]) {
    const n = fftSizeForRate(rate);
    const width = rate / n;
    // 19kHz・21kHz と、ビンの中心から 1/4・1/2 ビン外れた周波数
    const freqs = [19000, 21000, Math.round(19000 / width) * width + width / 2, Math.round(20500 / width) * width + width / 4];
    for (const f of freqs) {
      const amp = 0.1 + 0.4 * r();
      const h = createHarness({ rate, intervalFrames: Math.round(rate / 10) });
      h.run(sine(f, amp, r() * 2 * Math.PI, rate), Math.round(rate / 10) * 4);
      for (const m of h.intervals()) {
        assert.ok(relErr(bandMeanSq(m, ULTRA), amp * amp / 2) <= 1e-4,
          `${rate}Hz・${f}Hz の超音波帯 ${bandMeanSq(m, ULTRA)}（A^2/2 は ${amp * amp / 2}）`);
      }
      // dBFS に直しても、超音波帯は 10・log10(A^2/2)、可聴帯は 40dB 以上下
      for (const rec of h.records()) {
        assert.ok(Math.abs(rec.bandDb.ultra - 10 * Math.log10(amp * amp / 2)) <= 1e-3, `${f}Hz: ${rec.bandDb.ultra}`);
        assert.ok(rec.bandDb.ultra - rec.bandDb.audible >= 40, `${f}Hz: 可聴帯 ${rec.bandDb.audible} dBFS`);
      }
    }
  }
});

test('可聴帯の中の正弦波（1kHz）はその逆で、可聴帯に A^2/2 として入り、超音波帯はずっと小さい', () => {
  const rate = 48000;
  const amp = 0.3;
  const h = createHarness({ rate, intervalFrames: 4800 });
  h.run(sine(1000, amp, 0.7, rate), 4800 * 4);
  for (const m of h.intervals()) {
    // ⚠ フレームごとに平均を引くので、わずかに大きく出る（1kHz で電力の比 +5.5e-5。引いた平均が窓でビン1へ広がるため）
    assert.ok(relErr(bandMeanSq(m, AUDIBLE), amp * amp / 2) <= 1e-4, `可聴帯 ${bandMeanSq(m, AUDIBLE)}`);
  }
  for (const rec of h.records()) {
    assert.ok(rec.bandDb.audible - rec.bandDb.ultra >= 40, `超音波帯 ${rec.bandDb.ultra} dBFS`);
  }
});

test('フレームごとに平均を引くので、直流のオフセットは可聴帯に入らない（直流だけなら電力0＝-Infinity）', () => {
  // ⚠ 周期型 Hann 窓では、直流の電力の 1/3 がビン1（48kHz・N=1024 で 46.875Hz）へ入る（test/fft.test.js）。
  //    ビン1は可聴帯の内側なので、平均を引かないとマイクの直流オフセットが可聴帯の値に混ざる
  const rate = 48000;
  const dc = 0.3;
  const amp = 0.05;
  const h = createHarness({ rate, intervalFrames: 4800 });
  h.run(sumOf([() => dc, sine(1000, amp, 0.2, rate)]), 4800 * 3);
  for (const m of h.intervals()) {
    // 平均を引かなければ、ここに dc^2/3 が足されて約 60 倍になる
    assert.ok(relErr(bandMeanSq(m, AUDIBLE), amp * amp / 2) <= 1e-3, `可聴帯 ${bandMeanSq(m, AUDIBLE)}`);
  }
  const h2 = createHarness({ rate, intervalFrames: 4800 });
  h2.run(() => dc, 4800 * 3);
  for (const rec of h2.records()) {
    assert.equal(rec.bandDb.audible, -Infinity, '直流だけなのに可聴帯に電力がある');
    assert.equal(rec.bandDb.ultra, -Infinity);
    assert.equal(rec.bandValidRatio, 1);
  }
});

test('⭐約100Hz より下の正弦波は、平均を引くぶん値が大きく変わる（素朴な参照と比べて、平均の引き方を縛る）', () => {
  // フレーム（約21ミリ秒）に1〜2周期しか入らない音は、フレームの平均がその音自身の一部なので、引くと値が変わる。
  // 期待値は素朴な参照（フレーム [g-N, g) ごとに平均を引いて hannWindow を掛け、素朴な DFT で帯域のビンを足す）から出す。
  // 平均の引き方（引くかどうか・窓の前か後か・何サンプルの平均か）を変えると、ここで落ちる
  const rate = 48000;
  const interval = 2048;
  const count = 4;
  const amp = 0.2;
  const ratio = {};
  for (const f of [20, 30, 50, 70, 100]) {
    const fill = sine(f, amp, 0.9, rate);
    const h = createHarness({ rate, intervalFrames: interval });
    h.run(fill, interval * count + QUANTUM);
    const iv = h.intervals().slice(0, count);
    const ref = referenceBandPower(h.sandbox, fill, rate, iv[0].startFrame, interval, count);
    assertMatchesReference(iv, ref, 1e-9, `${f}Hz`);
    // 2つめ以降の区間の可聴帯の平均二乗 ÷ A^2/2
    const rest = iv.slice(1);
    ratio[f] = rest.reduce((s, m) => s + bandMeanSq(m, AUDIBLE), 0) / rest.length / (amp * amp / 2);
  }
  // コメントと CLAUDE.md に書いた向きの前提（変わったら数も書き直す）：20Hz は 6dB 以上小さく、
  // 70Hz は大きく出て、100Hz は 0.1dB 以内
  assert.ok(10 * Math.log10(ratio[20]) < -6, `20Hz: ${10 * Math.log10(ratio[20])} dB`);
  assert.ok(ratio[70] > 1, `70Hz: ${ratio[70]}`);
  assert.ok(Math.abs(10 * Math.log10(ratio[100])) < 0.1, `100Hz: ${10 * Math.log10(ratio[100])} dB`);
});


// ---- ずらし幅 N/4（75% の重なり）----

test('前提：Hann 窓の2乗を重ねた和は、ずらし幅 N/4 でどの時刻も 1.5、N/2 だと 0.5〜1.0 と揺れる', () => {
  // ずらし幅 N/2 では、フレームの端のサンプルの重みが半分になる。1ミリ秒の衝撃音が境目に来ると、帯域の値から消えかける
  const W = createHarness().sandbox;
  for (const n of [1024, 2048]) {
    const w = W.hannWindow(n);
    const overlap = (hop) => {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < hop; i++) {
        let s = 0;
        for (let j = i; j < n; j += hop) s += w[j] * w[j];
        lo = Math.min(lo, s);
        hi = Math.max(hi, s);
      }
      return { lo, hi };
    };
    const quarter = overlap(n / 4);
    assert.ok(Math.abs(quarter.lo - 1.5) <= 1e-12 && Math.abs(quarter.hi - 1.5) <= 1e-12, `n=${n}: ${quarter.lo}〜${quarter.hi}`);
    const half = overlap(n / 2);
    assert.ok(Math.abs(half.lo - 0.5) <= 1e-12 && Math.abs(half.hi - 1) <= 1e-12, `n=${n}: ${half.lo}〜${half.hi}`);
    // 1.5 = (N/H)・Σw^2/N（Σw^2 = 3N/8）。ここから Σ_フレーム Σ_k out[k] = (1/H)・Σ_i x_i^2 が出る
    assert.ok(Math.abs(W.windowPowerSum(w) / (n / 4) - 1.5) <= 1e-12);
  }
});

test('⭐途切れのない定常な信号では、両帯域の電力の合計 ÷ 数えたフレーム数が、時間領域の平均二乗と一致する', () => {
  // 両帯域の中に正弦波を並べる。周波数は帯域の外（直流の近く・22kHz より上）へ漏れない位置に置く。
  // ⚠ 平均を引くぶん、低い周波数ほどずれが大きい（48kHz で電力の比が 440Hz +3.2e-4・250Hz +7.3e-4 と大きく出て、
  //    100Hz で -1.5%・70Hz で +11%・20Hz で -8dB。約100Hz より下は下の「低い周波数」のテスト）。440Hz 以上にする
  const r = rng(0x5eed);
  for (const rate of [48000, 44100, 96000]) {
    const parts = [440, 1000, 3150, 7777, 12000, 16500, 18900, 19750, 20600, 21400].map(f => ({
      f, amp: 0.02 + 0.1 * r(), phase: r() * 2 * Math.PI
    }));
    const h = createHarness({ rate });
    h.run(sumOf(parts.map(p => sine(p.f, p.amp, p.phase, rate))), rate * 3);
    const ultraSq = parts.filter(p => p.f >= BAND_DEFS[ULTRA].lo).reduce((s, p) => s + p.amp * p.amp / 2, 0);
    const audibleSq = parts.filter(p => p.f < BAND_DEFS[ULTRA].lo).reduce((s, p) => s + p.amp * p.amp / 2, 0);
    const iv = h.intervals();
    assert.ok(iv.length >= 2, `${rate}Hz の区間の数 ${iv.length}`);
    for (const m of iv) {
      assert.equal(m.bandFrames, m.bandExpected, `${rate}Hz: 途切れていないのに数えていないフレームがある`);
      const timeMs = m.sumSq / m.count;   // 第1弾の定義（dbfs 列の元）
      const total = bandMeanSq(m, ULTRA) + bandMeanSq(m, AUDIBLE);
      assert.ok(relErr(total, timeMs) <= 1e-3, `${rate}Hz: 帯域の合計 ${total}、時間領域 ${timeMs}`);
      assert.ok(relErr(bandMeanSq(m, ULTRA), ultraSq) <= 1e-3, `${rate}Hz の超音波帯`);
      assert.ok(relErr(bandMeanSq(m, AUDIBLE), audibleSq) <= 1e-3, `${rate}Hz の可聴帯`);
    }
  }
});


// ---- 区間の境目のそばの衝撃音 ----

test('⭐区間の境目のそばの1ミリ秒の衝撃音は、隣り合う区間の帯域の電力を合わせると衝撃音のエネルギーに見合い、どこに来ても消えない', () => {
  // 20kHz の1ミリ秒（48サンプル）のバースト。バーストの両端は Hann の形で絞る（四角く切ると
  // 周波数が ±1kHz より外へ広がり、超音波帯の外へ出るぶんが混ざるため）。まわりは無音。
  // 帯域の電力の和は「帯域の平均二乗 × 数えたフレーム数」で、ずらし幅 H=N/4 なら
  // Σ_フレーム Σ_k out[k] = (1/H)・Σ_i x_i^2 になる。位置を1サンプルずつずらしても変わらないはずである
  const rate = 48000;
  const interval = 4800;
  const E = interval * 5;          // 区間 4 と区間 5 の境目
  const len = 48;
  const amp = 0.5;
  const n = fftSizeForRate(rate);
  const hop = n / 4;
  const ratios = [];
  let split = 0;
  // バーストの始まりを、境目の N+64 サンプル前から境目の 64 サンプル後まで 37 サンプルずつ動かす
  for (let b0 = E - n - 64; b0 <= E + 64; b0 += 37) {
    const burst = (t) => {
      const i = t - b0;
      if (i < 0 || i >= len) return 0;
      const env = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 0.5) / len);
      return amp * env * Math.sin(2 * Math.PI * 20000 * i / rate);
    };
    let energy = 0;
    for (let t = b0; t < b0 + len; t++) energy += Math.fround(burst(t)) ** 2;   // 届くのは Float32
    const h = createHarness({ rate, intervalFrames: interval });
    h.run(burst, interval * 8);
    const recs = h.records();
    // 帯域の電力の和を、記録（dBFS と数えたフレーム数）から組み直す
    const powerOf = (rec, key) => dbToPower(rec.bandDb[key]) * rec.bandFrames;
    for (const rec of recs) assert.equal(rec.bandValidRatio, 1);
    recs.forEach((rec, i) => {
      if (i !== 4 && i !== 5) assert.equal(powerOf(rec, 'ultra'), 0, `b0=${b0}: 区間 ${i} に衝撃音が入っている`);
    });
    const ultra = powerOf(recs[4], 'ultra') + powerOf(recs[5], 'ultra');
    const both = ultra + powerOf(recs[4], 'audible') + powerOf(recs[5], 'audible');
    // 超音波帯だけで衝撃音のエネルギーの99%以上、両帯域を合わせれば 0.1% 以内
    assert.ok(relErr(ultra, energy / hop) <= 1e-2, `b0=${b0}: 超音波帯 ${ultra}（(1/H)・Σx^2 は ${energy / hop}）`);
    assert.ok(relErr(both, energy / hop) <= 1e-3, `b0=${b0}: 両帯域 ${both}`);
    ratios.push(ultra / (energy / hop));
    if (powerOf(recs[4], 'ultra') > 0 && powerOf(recs[5], 'ultra') > 0) split++;
  }
  // 位置によらず同じ値になる（重みが一様）。境目をはさんで2つの区間に分かれた位置も含んでいる
  assert.ok(Math.max(...ratios) - Math.min(...ratios) <= 1e-3, `位置による揺れ ${Math.min(...ratios)}〜${Math.max(...ratios)}`);
  assert.ok(split > 0, '2つの区間に分かれる位置を1つも試していない');
});

test('区間の最後のサンプルで終わるフレームは、次の区間に数える（終わり g を含む区間）', () => {
  // 区間長を H の倍数にすると、区間の終わりがちょうどフレームの終わりになる
  const rate = 48000;
  const n = fftSizeForRate(rate);
  const hop = n / 4;
  const interval = hop * 20;
  const h = createHarness({ rate, intervalFrames: interval });
  h.run(sine(19000, 0.2, 0, rate), interval * 4);
  const iv = h.intervals();
  for (const m of iv) {
    const ends = expectedEnds(m.startFrame, m.endFrame, 0, n);
    assert.equal(m.bandExpected, ends.length, `seq=${m.seq}`);
    assert.equal(m.bandFrames, m.bandExpected, `seq=${m.seq}`);
    // 始まり（startFrame）で終わるフレームはこの区間、終わり（endFrame）で終わるフレームは次の区間
    if (m.seq > 0) assert.equal(ends[0], m.startFrame);
    assert.ok(ends[ends.length - 1] < m.endFrame);
  }
});

test('⭐フレームの中身はサンプル [g-N, g) で、終わり g を含む区間に数える（境目のそばのインパルスを、素朴な参照とサンプル単位で比べる）', () => {
  // インパルスの電力はどのビンにも入るので、両帯域で比べられる。フレームの中の位置が1サンプルずれると窓の重みが変わり、
  // 境目をまたいで2つの区間に分かれるときの取り分が変わる（合計は重なりの和 1.5 で変わらないので、区間ごとに見る）。
  // 上の衝撃音のテストは合計を 1e-3 で見るので、フレームが1サンプルずれても通る。ここでは区間ごとに 1e-9 で比べる。
  // 位置は H の倍数とそうでないものの両方にし、境目をまたいで分かれる位置と、1つの区間に収まる位置を入れる
  const rate = 48000;
  const interval = 4800;
  const count = 7;
  const n = fftSizeForRate(rate);
  const hop = n / 4;
  const E = interval * 5;   // 区間 4 と区間 5 の境目
  const positions = [E - n + 1, E - 960, E - 899, E - 575, E - 448, E - 300, E - 193, E - 192, E - 1, E + 37];
  assert.ok(positions.some(p => p % hop === 0) && positions.some(p => p % hop !== 0), '位置の選び方');
  let split = 0;
  for (const p of positions) {
    const impulse = (t) => (t === p ? 0.5 : 0);
    const h = createHarness({ rate, intervalFrames: interval });
    h.run(impulse, interval * count + QUANTUM);
    const iv = h.intervals().slice(0, count);
    const ref = referenceBandPower(h.sandbox, impulse, rate, iv[0].startFrame, interval, count);
    assertMatchesReference(iv, ref, 1e-9, `インパルスの位置 ${p}`);
    if (ref[4][ULTRA] > 0 && ref[5][ULTRA] > 0) split++;
  }
  assert.ok(split >= 4, `境目をまたいで分かれる位置が ${split} か所しかない`);
});

test('区間の中がデジタル無音でも、直前の区間の最後の N サンプル以内の音は帯域の値に入る（dbfs が -Infinity の行でも帯域は有限になりうる）', () => {
  // 各フレームを終わり g を含む区間に数えるので、区間の始まりより前の [g-N, startFrame) の音も入る。
  // CSV に列を足すと（b2）、同じ行の dbfs（-Infinity）と帯域の値（有限）が食い違って見えるので、この性質を縛っておく
  const rate = 48000;
  const interval = 4800;
  const n = fftSizeForRate(rate);
  const E = interval * 2;   // 区間 1 と区間 2 の境目
  // 区間 1 の最後の 300 サンプルだけに 1kHz の音。ほかは無音
  const beep = (t) => (t >= E - 300 && t < E ? 0.3 * Math.sin(2 * Math.PI * 1000 * t / rate) : 0);
  const h = createHarness({ rate, intervalFrames: interval });
  h.run(beep, interval * 4 + QUANTUM);
  const iv = h.intervals();
  const silent = iv[2];
  assert.equal(silent.startFrame, E);
  assert.equal(silent.sumSq, 0, '区間 2 に音がある（前提が変わった）');
  assert.ok(silent.count > 0);
  assert.ok(silent.bandPower[AUDIBLE] > 0, '直前の区間の音が入っていない');
  const rec = buildIntervalRecord(silent, ANCHOR, -90);
  assert.equal(rec.rawDb, -Infinity);
  assert.ok(Number.isFinite(rec.bandDb.audible), `可聴帯 ${rec.bandDb.audible}`);
  assert.equal(rec.bandValidRatio, 1);
  // 入るのは、終わり g が E + N より前のフレーム（[g-N, g) が E より前のサンプルを含むもの）だけ。
  // 区間 3 のフレームは E より前のサンプルを含まないので、電力はちょうど0
  assert.ok(iv[3].startFrame - n >= E);
  assert.deepEqual(Array.from(iv[3].bandPower), [0, 0]);   // ワークレットの配列は vm の中で作られるので、こちらの配列に写して比べる
  assert.deepEqual(buildIntervalRecord(iv[3], ANCHOR, -90).bandDb, { ultra: -Infinity, audible: -Infinity });
});


// ---- 途切れ ----

// 途切れ（サンプル [gapStart, gapEnd) が届かない）を含むフレームの終わり g：g - n < gapEnd かつ g > gapStart
const touchesGap = (g, n, gapStart, gapEnd) => g - n < gapEnd && g > gapStart;

function checkGap(h, n, gapStart, gapEnd) {
  const iv = h.intervals();
  const origin = iv[0].startFrame;
  let affected = 0;
  for (const m of iv) {
    const ends = expectedEnds(m.startFrame, m.endFrame, origin, n);
    const missing = ends.filter(g => touchesGap(g, n, gapStart, gapEnd)).length;
    assert.equal(m.bandExpected, ends.length, `seq=${m.seq} の数えるはずのフレーム`);
    assert.equal(m.bandFrames, ends.length - missing, `seq=${m.seq} の数えたフレーム（途切れを含むもの ${missing}）`);
    const rec = buildIntervalRecord(m, ANCHOR, -90);
    if (missing > 0) {
      affected++;
      assert.ok(rec.bandValidRatio < 1, `seq=${m.seq} の band_valid_ratio が 1 のまま`);
    } else {
      assert.equal(rec.bandValidRatio, 1, `seq=${m.seq}`);
    }
  }
  // 途切れのあとは 1 に戻る
  assert.equal(buildIntervalRecord(iv[iv.length - 1], ANCHOR, -90).bandValidRatio, 1, '途切れのあとで戻っていない');
  return affected;
}

test('⭐クォンタムが落ちたときは、そのサンプルを含むフレームを数えず、その区間の band_valid_ratio が 1 を下回る', () => {
  const rate = 48000;
  const n = fftSizeForRate(rate);
  const interval = 4800;
  const fill = sumOf([sine(700, 0.1, 0, rate), sine(19500, 0.05, 1, rate)]);
  // 区間の中ほど・区間の終わりの直前・区間の境目をまたぐ位置と、40クォンタム続けて落ちる場合
  const cases = [
    { at: interval * 3 + 1280, quanta: 1 },
    { at: interval * 4 - QUANTUM, quanta: 1 },
    { at: interval * 4 - 3 * QUANTUM, quanta: 1 },
    { at: interval * 3 + 256, quanta: 40 }
  ];
  for (const c of cases) {
    const h = createHarness({ rate, intervalFrames: interval });
    h.run(fill, c.at);
    for (let q = 0; q < c.quanta; q++) h.drop();
    h.run(fill, interval * 5);
    const affected = checkGap(h, n, c.at, c.at + c.quanta * QUANTUM);
    assert.ok(affected >= 1, `落ちた位置 ${c.at}: どの区間にも痕跡が残っていない`);
    // 第1弾の有効サンプル率にも同じ区間で痕跡が残る（帯域だけが下がるのではない）
    assert.ok(h.records().some(rec => rec.validRatio < 1));
  }
});

test('入力が空で届いたときも、そのサンプルを含むフレームを数えず、0 で埋めない', () => {
  const rate = 48000;
  const n = fftSizeForRate(rate);
  const interval = 4800;
  const fill = sine(19200, 0.2, 0.3, rate);
  for (const quanta of [1, 3]) {
    const at = interval * 2 + 1920;
    const h = createHarness({ rate, intervalFrames: interval });
    h.run(fill, at);
    for (let q = 0; q < quanta; q++) h.empty();
    h.run(fill, interval * 4);
    checkGap(h, n, at, at + quanta * QUANTUM);
    // 0 で埋めていれば、途切れた区間の超音波帯の平均二乗が A^2/2 から下がる。数えたフレームだけなら変わらない
    for (const m of h.intervals()) {
      assert.ok(relErr(bandMeanSq(m, ULTRA), 0.2 * 0.2 / 2) <= 1e-4, `seq=${m.seq}: ${bandMeanSq(m, ULTRA)}`);
    }
  }
});


// ---- 1行目 ----

test('⭐1行目の band_valid_ratio は 1（記録の起点より前のサンプルが要るフレームを、数えるはずのフレームに入れない）', () => {
  const rate = 48000;
  const n = fftSizeForRate(rate);
  const fill = sine(19000, 0.1, 0, rate);
  const blocks = Math.ceil(rate / QUANTUM) * 2;
  const scenarios = {
    'ふつうに始まる': () => createHarness({ rate }),
    // 最初の呼び出しの currentFrame が古い値で届き、2回目で実際の位置へ飛ぶ（第2弾a8）
    '最初の呼び出しが古い': () => {
      const h = createHarness({ rate, warmUp: false });
      h.tick(fill);
      h.state.frame = 9728;
      return h;
    },
    // ノードを作ってから繋ぐまでに間がある（第1弾）
    '繋ぐまでに間がある': () => {
      const h = createHarness({ rate, warmUp: false });
      h.state.frame += 40 * QUANTUM;
      return h;
    },
    // 記録の頭で入力が空のまま呼ばれる（第2弾a3）
    '頭で入力が空': () => {
      const h = createHarness({ rate });
      for (let q = 0; q < 94; q++) h.empty();
      return h;
    }
  };
  for (const [name, make] of Object.entries(scenarios)) {
    const h = make();
    for (let q = 0; q < blocks; q++) h.tick(fill);
    const first = h.intervals()[0];
    const rec = buildIntervalRecord(first, ANCHOR, -90);
    assert.equal(rec.bandValidRatio, 1, `${name}: 1行目が見せかけの欠測になっている`);
    assert.equal(rec.validRatio, 1, `${name}: 第1弾の有効サンプル率`);
    // 数えるはずのフレームは、起点から N 以上あとで終わるものだけ
    const origin = first.startFrame;
    assert.equal(first.bandExpected, expectedEnds(origin, first.endFrame, origin, n).length, name);
    // 起点より前のサンプルが要るフレームも数えていたら、1 を下回っていた
    const all = framesEndingIn(first.startFrame, first.endFrame, n / 4).length;
    assert.ok(first.bandFrames < all, `${name}: 除いたフレームが無い（前提が変わった）`);
  }
});


// ---- bands: false（?bands=off）----

test('⭐bands: false なら FFT を計算せず、帯域の値は null。既存の dbfs・valid_ratio は変わらない', () => {
  const rate = 48000;
  const interval = 4800;
  const fill = sumOf([sine(1000, 0.2, 0, rate), sine(20000, 0.05, 0.5, rate)]);
  const on = createHarness({ rate, intervalFrames: interval });
  const off = createHarness({ rate, intervalFrames: interval, bands: false });
  for (const h of [on, off]) {
    h.run(fill, interval * 2);
    h.drop();                       // 途切れがあっても同じであること
    h.run(fill, interval * 2);
  }
  assert.equal(off.warmCalls, 0, 'bands: false なのにコンストラクターで FFT を呼んだ');
  assert.equal(off.spy.calls, 0, 'bands: false なのに FFT を計算した');
  assert.ok(on.spy.calls > on.warmCalls, '比べる側（bands あり）が FFT を計算していない');
  assert.equal(off.ready.bands, false);
  assert.equal(off.ready.fftSize, null);
  assert.equal(on.ready.bands, true);
  assert.equal(on.ready.fftSize, fftSizeForRate(rate));

  const a = on.intervals();
  const b = off.intervals();
  assert.equal(a.length, b.length);
  const FIRST_STAGE = ['seq', 'sampleRate', 'startFrame', 'endFrame', 'expected', 'count', 'sumSq', 'peak', 'clip', 'clipRun', 'emittedAt'];
  for (let i = 0; i < a.length; i++) {
    for (const key of FIRST_STAGE) assert.equal(b[i][key], a[i][key], `区間 ${i} の ${key}`);
    assert.equal(b[i].bandPower, null);
    assert.equal(b[i].bandFrames, null);
    assert.equal(b[i].bandExpected, null);
    const ra = buildIntervalRecord(a[i], ANCHOR, -90);
    const rb = buildIntervalRecord(b[i], ANCHOR, -90);
    assert.equal(rb.rawDb, ra.rawDb);
    assert.equal(rb.validRatio, ra.validRatio);
    assert.deepEqual(csvDataFields(rb), csvDataFields(ra), `区間 ${i} の CSV の値`);
    assert.deepEqual(rb.bandDb, { ultra: null, audible: null });
    assert.equal(rb.bandValidRatio, null);
  }
});

test('計画が使えないときも帯域を止める（FFT を計算せず null。0 として送らない）', () => {
  const rate = 48000;
  const good = bandPlan(rate);
  const withBand = (i, over) => Object.assign({}, good, {
    bands: good.bands.map((b, j) => (j === i ? Object.assign({}, b, over) : b))
  });
  const bad = {
    '計画が無い': null,
    'サンプルレートが違う': bandPlan(44100),
    'N が2の累乗でない': Object.assign({}, good, { fftSize: 1000 }),
    'N が大きすぎる': Object.assign({}, good, { fftSize: 65536 }),
    '直流のビン0を含む': withBand(AUDIBLE, { binLo: 0 }),
    'ビンが N/2 を超える': withBand(ULTRA, { binHi: good.fftSize / 2 + 1 }),
    'ビンの範囲が逆': withBand(ULTRA, { binLo: 400, binHi: 399 }),
    'ビンが整数でない': withBand(ULTRA, { binLo: 384.5 }),
    '帯域が無い': Object.assign({}, good, { bands: [] })
  };
  for (const [name, plan] of Object.entries(bad)) {
    const h = createHarness({ rate, intervalFrames: 4800, plan });
    h.run(sine(19000, 0.1, 0, rate), 4800 * 3);
    assert.equal(h.ready.bands, false, name);
    assert.equal(h.spy.calls, 0, `${name}: FFT を計算した`);
    for (const m of h.intervals()) assert.equal(m.bandPower, null, name);
    for (const rec of h.records()) assert.equal(rec.bandValidRatio, null, name);
  }
});

test('帯域にビンが無いとき（32kHz の超音波帯）は、その帯域だけ null で、ほかの帯域は数える', () => {
  const rate = 32000;
  const h = createHarness({ rate, intervalFrames: 3200 });
  h.run(sine(1000, 0.2, 0, rate), 3200 * 3);
  assert.equal(h.ready.bands, true);
  for (const m of h.intervals()) {
    assert.equal(m.bandPower[ULTRA], null);
    assert.ok(relErr(bandMeanSq(m, AUDIBLE), 0.2 * 0.2 / 2) <= 1e-4);
  }
  for (const rec of h.records()) {
    assert.equal(rec.bandDb.ultra, null, 'ビンが無いのに値がある（測れないものを出している）');
    assert.ok(Number.isFinite(rec.bandDb.audible));
    assert.equal(rec.bandValidRatio, 1);
  }
});


// ---- コンストラクターでの準備 ----

test('コンストラクターで powerSpectrumInto を前もって数十回呼んでおく（最初の数回の遅さを記録の外で済ませる）', () => {
  const h = createHarness();
  const warmup = vm.runInContext('FFT_WARMUP_CALLS', h.sandbox);
  assert.ok(Number.isInteger(warmup) && warmup >= 20 && warmup < 100, `前もって呼ぶ回数 ${warmup}`);
  assert.equal(h.warmCalls, warmup, 'コンストラクターで呼んだ回数が FFT_WARMUP_CALLS と違う');
  // まだ process() を呼んでいない時点の回数である。最初の区間を始める前に済んでいる
  const before = h.spy.calls;
  h.tick(() => 0);
  assert.equal(h.spy.calls, before, '最初の1ブロックでフレームを計算した（N サンプルに届いていない）');
  // bands: false では呼ばない
  assert.equal(createHarness({ bands: false }).warmCalls, 0);
});


// ---- logic.js の換算 ----

function bandMessage(over) {
  return Object.assign({
    type: 'interval', seq: 0, sampleRate: 48000, startFrame: 48000, endFrame: 96000,
    expected: 48000, count: 48000, sumSq: 480, peak: 0.2, clip: 0, clipRun: 0, emittedAt: 2
  }, over);
}

test('⭐帯域の dBFS は「電力の和 ÷ 数えたフレーム数」を powerToDb と同じ定義で換算し、band_valid_ratio は数えたフレーム数 ÷ 数えるはずのフレーム数', () => {
  const r = rng(0xdb);
  for (let i = 0; i < 20; i++) {
    const frames = 1 + Math.floor(r() * 200);
    const expected = frames + Math.floor(r() * 20);
    const power = [r() * frames * 1e-3, r() * frames * 1e-1];
    const rec = buildIntervalRecord(bandMessage({ bandPower: power, bandFrames: frames, bandExpected: expected }), ANCHOR, -90);
    assert.ok(Math.abs(rec.bandDb.ultra - 10 * Math.log10(power[ULTRA] / frames)) <= 1e-12);
    assert.ok(Math.abs(rec.bandDb.audible - 10 * Math.log10(power[AUDIBLE] / frames)) <= 1e-12);
    assert.equal(rec.bandValidRatio, frames / expected);
    assert.equal(rec.bandFrames, frames);
    assert.equal(rec.bandExpected, expected);
  }
});

test('換算の端：電力0は -Infinity、数えたフレームが0なら dBFS は null、数えるはずのフレームが0なら band_valid_ratio は null', () => {
  const zero = buildIntervalRecord(bandMessage({ bandPower: [0, 0], bandFrames: 10, bandExpected: 10 }), ANCHOR, -90);
  assert.deepEqual(zero.bandDb, { ultra: -Infinity, audible: -Infinity });
  assert.equal(zero.bandValidRatio, 1);

  const none = buildIntervalRecord(bandMessage({ bandPower: [0, 0], bandFrames: 0, bandExpected: 12 }), ANCHOR, -90);
  assert.deepEqual(none.bandDb, { ultra: null, audible: null }, '数えていないのに値を出している');
  assert.equal(none.bandValidRatio, 0);

  const noExpected = buildIntervalRecord(bandMessage({ bandPower: [0, 0], bandFrames: 0, bandExpected: 0 }), ANCHOR, -90);
  assert.equal(noExpected.bandValidRatio, null);
  assert.deepEqual(noExpected.bandDb, { ultra: null, audible: null });

  // ビンが無い帯域（ワークレットが null を送る）は、その帯域だけ null
  const noBins = buildIntervalRecord(bandMessage({ bandPower: [null, 0.5], bandFrames: 5, bandExpected: 5 }), ANCHOR, -90);
  assert.equal(noBins.bandDb.ultra, null);
  assert.ok(Math.abs(noBins.bandDb.audible - 10 * Math.log10(0.5 / 5)) <= 1e-12);

  // 帯域の値が届いていない（bands: false、または b1 より前の形のメッセージ）
  for (const msg of [bandMessage({ bandPower: null, bandFrames: null, bandExpected: null }), bandMessage({})]) {
    const rec = buildIntervalRecord(msg, ANCHOR, -90);
    assert.deepEqual(rec.bandDb, { ultra: null, audible: null });
    assert.equal(rec.bandFrames, null);
    assert.equal(rec.bandExpected, null);
    assert.equal(rec.bandValidRatio, null);
  }
});

test('簡易モードの行は、帯域をすべて null にする（測れないものを「異常なし」として出さない）', () => {
  const fb = buildFallbackRecord({
    seq: 0, db: -30, floorDb: -90, startTime: 0, endTime: 1,
    startWallMs: ANCHOR.wallMs, endWallMs: ANCHOR.wallMs + 1000, expectedSamples: 48000, intervalSec: 1
  });
  assert.deepEqual(fb.bandDb, { ultra: null, audible: null });
  assert.equal(fb.bandFrames, null);
  assert.equal(fb.bandExpected, null);
  assert.equal(fb.bandValidRatio, null);
});

test('帯域の値は CSV の値（とハッシュの材料）をまだ変えない（列を足すのは b2）', () => {
  const base = bandMessage({});
  const withBand = bandMessage({ bandPower: [0.01, 0.2], bandFrames: 187, bandExpected: 188 });
  assert.deepEqual(
    csvDataFields(buildIntervalRecord(withBand, ANCHOR, -90)),
    csvDataFields(buildIntervalRecord(base, ANCHOR, -90))
  );
});

test('?bands=off の判定：off（大文字小文字を問わない）だけが帯域を止め、それ以外は計算する', () => {
  for (const s of ['?bands=off', '?bands=OFF', '?x=1&bands=off', 'bands=off', '?bands=%20off%20']) {
    assert.equal(bandsEnabledFromQuery(s), false, s);
  }
  for (const s of ['', '?', '?bands=on', '?bands=', '?bands=0ff', '?foo=off', '?band=off', undefined, null, 42]) {
    assert.equal(bandsEnabledFromQuery(s), true, String(s));
  }
});
