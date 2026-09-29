// Day041 - Mic Gain Logger / 計測用の AudioWorkletProcessor
//
// オーディオスレッドで動く。128サンプルごとに必ず呼ばれるので、
// requestAnimationFrame が止まっても計測は続く。
// ここでは「区間の集計」だけを行い、dBFS への換算は
// メインスレッド（logic.js）に任せる。
//
// 区間の切れ目は currentFrame（オーディオクロックのフレーム番号）で決める。
// 理想の境界 startFrame + intervalFrames をそのまま次の startFrame にするので、
// 区間長のずれが積み上がらない。
// オーディオスレッドがレンダークォンタムを落とした場合は currentFrame だけが
// 先へ飛ぶため、count / expected（有効サンプル率）が 1 を下回って痕跡が残る。
//
// ⚠ 1区間めの起点は、コンストラクターではなく最初の process() で取る。
//    改修前は `this.startFrame = currentFrame` をコンストラクターに置いていた。
//    AudioWorkletNode を作ってからレンダーグラフへ繋ぐまでのあいだ process() は
//    呼ばれないので、その間のフレームが expected にだけ入り count には入らず、
//    記録開始直後の1行目だけ有効サンプル率が 1 を下回った。
//    観測されたのは「通常の記録で1行目だけ valid_ratio=0.979」である。
//    そこから逆算すると 48kHz で 8 クォンタム（1024 フレーム＝21.3 ミリ秒）ぶんに
//    当たり、このファイルを node:vm で動かして同じ値を再現できた
//    （test/meter-processor.test.js）。欠測ではなく、まだ音が流れていない時間を
//    区間に数えていたことによる見せかけの穴である。
//
// ⚠ 第1弾では「ヘッドレスの Chrome ではこの穴を再現できない（出力デバイスが無いあいだ
//    currentFrame が進まない）」と書いたが、誤りだった（第2弾a8の調べ）。ヘッドレスでも
//    currentFrame は進む。再現しなかったのは、手元のサーバーから読み込んでいて
//    ワークレットの読み込みに遅れが無かったためである。0.979 も a8 の仕組みで説明がつく
//    （確かめてはいない）。

// ⚠⚠ 起点はさらに「入力に音が載った process()」まで待つ（第2弾a3）。
//    入力が空（チャンネルなし・長さ0）のまま process() が呼ばれる間を、区間に数えないためである。
//    ただし、いつまでも音が来ない（マイクが最初から届かない）と1行も出ず、
//    「記録していない」ことすら残らない。猶予（1秒）を過ぎたら区間を始め、
//    届かなかったぶんを欠測（count=0）として残す。
//    ⚠ 入力が空で届く状況は、Chromium では観測していない（a8の調べで0回）。
//    iPhone の実機で記録開始直後の区間が 74.9%（12032フレーム＝94クォンタム）になった件の
//    見立てとして入れたが、下の a8 の仕組みでも同じ形の穴になる。どちらだったかは分かっていない。
//
// ⚠⚠ 起点は、currentFrame が前の呼び出しの終わりとつながった呼び出しで決める（第2弾a8）。
//    Chromium 145（ヘッドレス・疑似マイク）では、ノードを作ったあと最初の process() だけ
//    currentFrame が 0 で届き、2回目で実際の位置へ飛んだ。ワークレットの読み込み（addModule）に
//    時間がかかると、その間も AudioContext は進むので、飛ぶ幅が広がる。読み込みを50・200ミリ秒
//    遅らせると1行目の有効サンプル率は 0.949・0.800 になり、欠けたフレーム数（2432・9600）は
//    ノードを作った時点の currentFrame と一致した。GitHub Pages から読み込むと6回中4回で
//    1行目が 1.000 を下回り、手元のサーバーでは6回とも 1.000 だった。
//    最初の1回はつながりを確かめようがないので、起点に使わない（2.7ミリ秒ぶんを捨てる）。
//    つながりを確かめられないまま MAX_UNJOINED_CALLS 回を過ぎたら、確かめずに始める
//    （本当にクォンタムが落ち続けているなら、それは欠測として残すべきものである）。
// ⚠ a3 のときに「旧版が8回中3回この穴を出し、改修版は16回中0回だった」と書いたが、
//    旧版を GitHub Pages から、改修版を手元のサーバーから読み込んで比べていた。
//    読み込みの遅れの差を、版の差と取り違えていた。旧版も手元から読み込めば穴は出ない。

'use strict';

const MIN_INTERVAL_FRAMES = 128;
const STARTUP_GRACE_SEC = 1;
// 起点を決める前に、つながりを確かめられない呼び出しを何回まで見送るか（第2弾a8）
const MAX_UNJOINED_CALLS = 16;

function normalizeFrames(value, fallback) {
  const v = Math.round(Number(value));
  if (!Number.isFinite(v) || v < MIN_INTERVAL_FRAMES) return fallback;
  return v;
}

// ---- FFT の土台（第2弾b0）----
//
// ⚠ まだ process() から呼ばない（第2弾b0）。b1 で区間ごとの帯域の集計に使う。
//    第2弾bでは、区間ごとに 18〜22kHz と 20〜18,000Hz の帯域の値（平均二乗の推定）を
//    記録に足す。その前段として FFT の計算だけを先に置き、test/fft.test.js で固める。
//    ワークレットは別スレッドで logic.js を読めないので、計算はこのファイルに置く。
// ⚠ 帯域の値は「その帯域に音のエネルギーがあったか」の記録である。超音波ビーコンを
//    検出するものではなく、何が鳴っていたかは分からない。値は dBFS と同じく、
//    端末（マイクと変換器）に依存する相対値である。
//
// 正規化の考え方（powerSpectrumInto）：
//  - X_k = Σ x_i・e^(-2πj・ik/n)（1/n を掛けない形）とすると、パーセバルの等式から
//    Σ_k |X_k|^2 = n・Σ_i x_i^2 になる。n で2回割れば、全ビンの和が平均二乗になる。
//  - 窓 w を掛けたときは n・Σw^2 で割る。全ビンの和は Σ(x・w)^2 / Σw^2
//    （窓で重み付けした平均二乗）になる。矩形窓（w=1）なら Σw^2 = n なので、
//    第1弾の sumSq / count と同じ定義に戻る。
//  - 入力が実数なら |X_(n-k)| = |X_k| で、負の周波数のビンは正の側の鏡像である。
//    片側（k = 0..n/2）だけを持つので、鏡像のぶんを2倍にして足し込む。
//  - k=0（直流）と k=n/2（ナイキスト）は自分自身が鏡像で、対になる相手がいない。
//    2倍にすると同じ電力を二重に数えるので、この2つは1倍のままにする。
//  こうすると Σ_{k=0..n/2} out[k] = Σ(x・w)^2 / Σw^2 がちょうど成り立つ。
//  ⚠ c_0 = 1 は係数の話で、直流の電力が k=0 だけに入るのは矩形窓のときである。周期型 Hann 窓を掛けると、直流の電力は
//    k=0 に 2/3、k=1 に 1/3 と分かれる（窓のスペクトルが k=0・±1 の3本で、+1 と -1 へ広がったぶんが
//    片側では k=1 にまとまるため）。ナイキストも同じで、k=n/2 に 2/3、k=n/2-1 に 1/3 になる。
//    48kHz・n=1024 ではビン1の中心は 46.875Hz なので、b1 で 20〜18,000Hz の帯域をビン1から数えると、
//    マイクの直流オフセットの 1/3 がその帯域の値に入る。FFT のフレームごとに平均を引いてから
//    窓を掛けるか、ビン2から数えるかを b1 で決める（test/fft.test.js で分かれ方を確かめている）。
//
// ⚠ fftInPlace と powerSpectrumInto の中では、配列もオブジェクトも作らない。
//    b1 で process() から呼ぶので、オーディオスレッドでガベージコレクションを起こさないためである。
//    計画・窓・作業用の配列（re・im・out）は、呼び出し側がコンストラクターで一度だけ用意する。
//    長さも確かめない（process() の中で例外を投げると、ノードが止まる）。長さは plan.n に合わせて作る。
//    test/fft.test.js がパラメーターと本体の文字列を見て、配列やオブジェクトを作る代表的な書き方
//    （new・リテラル・分割代入・for…of・許可していない関数の呼び出しなど）が無いことを確かめている。
//    実行してヒープの増え方を数えてはいない。

// FFT の計画。長さ n（2 以上の 2 の累乗）ごとに、ビット反転の並べ替え表と、
// 回転因子の表（cos・sin、k = 0..n/2-1 の角度 2πk/n）を前もって作る。
// ⚠ 配列を作るので、process() の中では呼ばない（b1 ではコンストラクターで呼ぶ）。
function createFftPlan(n) {
  let m = n;
  if (Number.isInteger(n) && n >= 2) {
    while (m % 2 === 0) m /= 2;
  }
  if (!Number.isInteger(n) || n < 2 || m !== 1) {
    throw new RangeError(`FFT の長さは 2 以上の 2 の累乗にする（n=${String(n)}）`);
  }
  const half = n / 2;
  // i のビット反転＝「i を1ビット右へずらしたもの」のビット反転を1ビット右へずらし、
  // i の最下位ビットを最上位ビット（half）へ移したもの
  const rev = new Uint32Array(n);
  for (let i = 1; i < n; i++) rev[i] = (rev[i >> 1] >> 1) | ((i & 1) ? half : 0);
  const cos = new Float64Array(half);
  const sin = new Float64Array(half);
  for (let k = 0; k < half; k++) {
    cos[k] = Math.cos(2 * Math.PI * k / n);
    sin[k] = Math.sin(2 * Math.PI * k / n);
  }
  return { n, rev, cos, sin };
}

// 反復型の radix-2 Cooley–Tukey（時間間引き）。re・im（長さ n の Float64Array）を
// その場で X_k = Σ x_i・e^(-2πj・ik/n) に置き換える（1/n は掛けない）。
// 先にビット反転の順へ並べ替え、長さ 2・4・…・n の蝶を下から順に組む。
// ⚠ 呼び出しの中で配列もオブジェクトも作らない（オーディオスレッドでのGCを避ける）
function fftInPlace(plan, re, im) {
  const n = plan.n;
  const rev = plan.rev;
  const cos = plan.cos;
  const sin = plan.sin;
  // ビット反転の並べ替え。組ごとに1回だけ入れ替える（j > i のときだけ）
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  // size は束ねる長さ。長さ size の蝶の回転因子 e^(-2πj・t/size) は、表の k = t・(n/size) 番目
  for (let size = 2; size <= n; size *= 2) {
    const halfSize = size / 2;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let t = 0, k = 0; t < halfSize; t++, k += step) {
        const wr = cos[k];
        const wi = -sin[k];
        const a = start + t;
        const b = a + halfSize;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}

// 周期型の Hann 窓 w[i] = 0.5 - 0.5・cos(2πi/n)（i = 0..n-1）を返す。
// スペクトル解析用なので、対称型（分母が n-1、両端がともに 0）ではなく周期型（分母が n）にする。
// 周期型は FFT の長さ n でちょうど1周期になるので、窓そのもののスペクトルが k=0 と k=±1 の
// 3本だけになる。ビンの中心に乗る正弦波の電力は隣り合う3ビンに収まり、Σw^2 もちょうど 3n/8 になる
// （n ≥ 4）。対称型は FIR フィルターの設計向けで、長さ n で1周期にならず、ほかのビンへ少しずつ漏れる。
// cos は偶関数で周期が n なので、i と n-i は同じ値になるはずである。短いほうの角度で計算して、
// 丸めの差を残さない（w[i] と w[n-i] がぴたりとそろう）。
// ⚠ 配列を作るので、process() の中では呼ばない（b1 ではコンストラクターで呼ぶ）。
function hannWindow(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const m = (i <= n - i) ? i : n - i;
    w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * m / n);
  }
  return w;
}

// 窓の電力の和 Σw[i]^2。powerSpectrumInto の正規化に使う（窓を作ったときに一度だけ求める）
function windowPowerSum(win) {
  let s = 0;
  for (let i = 0; i < win.length; i++) s += win[i] * win[i];
  return s;
}

// frame（長さ n。Float32Array でも Float64Array でもよい）に窓を掛けて FFT し、
// 片側の平均二乗スペクトルを out（長さ n/2+1 の Float64Array）へ書く。
// out[k] = c_k・|X_k|^2 / (n・Σw^2)、c_0 = c_(n/2) = 1、それ以外は 2（上の「正規化の考え方」）。
// frame は書き換えない。re・im は作業用で、中身は上書きする（前の呼び出しの値は残らない）。
// ⚠ 呼び出しの中で配列もオブジェクトも作らない。re・im・out は呼び出し側が用意する
function powerSpectrumInto(plan, frame, win, winPower, re, im, out) {
  const n = plan.n;
  for (let i = 0; i < n; i++) {
    re[i] = frame[i] * win[i];
    im[i] = 0;
  }
  fftInPlace(plan, re, im);
  const half = n / 2;
  const scale = 1 / (n * winPower);
  out[0] = (re[0] * re[0] + im[0] * im[0]) * scale;
  for (let k = 1; k < half; k++) out[k] = 2 * (re[k] * re[k] + im[k] * im[k]) * scale;
  out[half] = (re[half] * re[half] + im[half] * im[half]) * scale;
}

// ビン k の中心の周波数（Hz）。帯域へのビンの割り当ては b1 で行う。
// 引数を rate と名付けるのは、ワークレットの大域の sampleRate を隠さないためである
function binFrequency(k, rate, n) {
  return k * rate / n;
}

class MeterProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    const defaultFrames = Math.round(sampleRate); // 1秒
    this.intervalFrames = normalizeFrames(opts.intervalFrames, defaultFrames);
    this.pendingIntervalFrames = 0;
    this.stopped = false;
    this.seq = 0;
    // null＝まだ起点が決まっていない（入力に音が載った最初の process() で取る）
    this.startFrame = null;
    // つながりを確かめられた最初の process() のフレーム（猶予を数える起点）
    this.firstProcessFrame = null;
    // 起点を決める前の呼び出しで、次に来るはずのフレームと、呼び出しの回数（第2弾a8）
    this.probeEnd = null;
    this.probeCalls = 0;
    // いま続いているクリップの長さ。区間の境目では切らない（区間をまたぐ連続を
    // 2つに分けると、4サンプルの連続が「単発」と出る）
    this.clipRunCur = 0;
    // 次に来るはずのフレーム。クォンタムが落ちてサンプルが飛んだら、クリップの連続を切る
    this.nextFrame = null;
    this.resetAccumulator();

    this.port.onmessage = (event) => {
      const data = event.data || {};
      if (data.type === 'config') {
        const next = normalizeFrames(data.intervalFrames, 0);
        if (next) this.pendingIntervalFrames = next;
      } else if (data.type === 'stop') {
        this.stopped = true;
      }
    };

    // 起点はまだ決まっていないので載せない（コンストラクターの currentFrame は
    // レンダーグラフへ繋ぐ前の値で、1区間めの実際の起点にはならない）
    this.port.postMessage({ type: 'ready', sampleRate, intervalFrames: this.intervalFrames });
  }

  resetAccumulator() {
    this.sumSq = 0;
    this.count = 0;
    this.peak = 0;
    this.clip = 0;
    // この区間でクリップが続いた最長のサンプル数（単発と連続を言い分けるため）。
    // ブロックの境目と区間の境目をまたいで数え（clipRunCur は持ち越す）、
    // 入力が途切れたとき・サンプルが飛んだときに切る
    this.clipRunMax = 0;
  }

  emitInterval(endFrame) {
    this.port.postMessage({
      type: 'interval',
      seq: this.seq++,
      sampleRate,
      startFrame: this.startFrame,
      endFrame,
      expected: this.intervalFrames,
      count: this.count,
      sumSq: this.sumSq,
      peak: this.peak,
      clip: this.clip,
      clipRun: this.clipRunMax,
      emittedAt: currentTime
    });
    this.startFrame = endFrame;
    if (this.pendingIntervalFrames) {
      this.intervalFrames = this.pendingIntervalFrames;
      this.pendingIntervalFrames = 0;
    }
    this.resetAccumulator();
  }

  process(inputs) {
    if (this.stopped) return false;

    const input = inputs[0];
    // 長さ0の配列も「空の入力」として扱う（チャンネルなしと同じ）
    const channel = (input && input.length > 0 && input[0] && input[0].length > 0)
      ? input[0] : null;

    // 1区間めの起点。入力に音が載った最初のフレームであり、音が流れ始めた時刻である
    if (this.startFrame === null) {
      // 前の呼び出しの終わりとつながっていない呼び出しは、currentFrame を信じない（a8）
      const joined = this.probeEnd !== null && currentFrame === this.probeEnd;
      this.probeEnd = currentFrame + (channel ? channel.length : 128);
      this.probeCalls++;
      if (!joined && this.probeCalls <= MAX_UNJOINED_CALLS) return true;
      if (this.firstProcessFrame === null) this.firstProcessFrame = currentFrame;
      if (channel) {
        this.startFrame = currentFrame;
      } else if (currentFrame - this.firstProcessFrame >= Math.round(sampleRate * STARTUP_GRACE_SEC)) {
        // 猶予を過ぎても音が来ない。つながりを確かめた最初の process() を起点にし、欠測として残す
        this.startFrame = this.firstProcessFrame;
      } else {
        return true;   // まだ始めない
      }
    }
    // 入力が途切れている間もオーディオクロックは進むので、ブロック長は既定の128で数える
    const blockLength = channel ? channel.length : 128;
    // クォンタムが落ちて（process() が呼ばれず）サンプルが飛んだら、クリップの連続を切る
    if (this.nextFrame !== null && currentFrame !== this.nextFrame) this.clipRunCur = 0;
    this.nextFrame = currentFrame + blockLength;

    let offset = 0;
    while (offset < blockLength) {
      const elapsed = (currentFrame + offset) - this.startFrame;
      const remaining = this.intervalFrames - elapsed;
      if (remaining <= 0) {
        // 区間の終わりを跨いだ（あるいはクォンタムを落として飛び越えた）
        this.emitInterval(this.startFrame + this.intervalFrames);
        continue;
      }
      const take = Math.min(remaining, blockLength - offset);
      if (channel) {
        const end = offset + take;
        for (let i = offset; i < end; i++) {
          const x = channel[i];
          this.sumSq += x * x;
          const a = x < 0 ? -x : x;
          if (a > this.peak) this.peak = a;
          if (a >= 1) {
            this.clip++;
            this.clipRunCur++;
            if (this.clipRunCur > this.clipRunMax) this.clipRunMax = this.clipRunCur;
          } else {
            this.clipRunCur = 0;
          }
        }
        this.count += take;
      } else {
        // 入力が途切れたら、クリップの連続も切る
        this.clipRunCur = 0;
      }
      offset += take;
    }
    return true;
  }
}

registerProcessor('meter-processor', MeterProcessor);
