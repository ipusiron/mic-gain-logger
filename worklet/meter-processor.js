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
//
// 区間ごとに、帯域ごとの電力の和も集計する（第2弾b1。下の「帯域の集計」）。
// ここでも dBFS への換算はしない。

'use strict';

const MIN_INTERVAL_FRAMES = 128;
const STARTUP_GRACE_SEC = 1;
// 起点を決める前に、つながりを確かめられない呼び出しを何回まで見送るか（第2弾a8）
const MAX_UNJOINED_CALLS = 16;
// processorOptions の帯域の計画を確かめるときの範囲（第2弾b1）。
// FFT の長さの下限は、ずらし幅 N/4 が 1 以上になる長さ。上限は、大きすぎる計画で配列を作らないため
// （Web Audio のサンプルレートの上限 768kHz でも、logic.js の決め方では 16384 に収まる）
const FFT_SIZE_MIN = 4;
const FFT_SIZE_MAX = 32768;
const BAND_COUNT_MAX = 8;
// コンストラクターで powerSpectrumInto を前もって呼ぶ回数（第2弾b1）。理由は setupBands のコメント
const FFT_WARMUP_CALLS = 64;

function normalizeFrames(value, fallback) {
  const v = Math.round(Number(value));
  if (!Number.isFinite(v) || v < MIN_INTERVAL_FRAMES) return fallback;
  return v;
}

// ---- FFT の土台（第2弾b0）----
//
// 区間ごとの帯域の集計（第2弾b1、下の「帯域の集計」）で使う。b0 で FFT の計算だけを先に置き、
// test/fft.test.js で固めた。帯域の範囲は logic.js の BAND_DEFS が正で、ここには書かない。
// ワークレットは別スレッドで logic.js を読めないので、FFT の計算はこのファイルに置く。
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
//    48kHz・n=1024 ではビン1の中心は 46.875Hz なので、20〜18,000Hz の帯域をビン1から数えると、
//    マイクの直流オフセットの 1/3 がその帯域の値に入る。b1 ではフレームごとに平均を引いてから
//    窓を掛ける（analyzeBandFrame。SciPy の welch の既定 detrend='constant' と同じ）。
//    分かれ方は test/fft.test.js、平均を引いたあとの値は test/band.test.js で確かめている。
//
// ⚠ fftInPlace と powerSpectrumInto の中では、配列もオブジェクトも作らない。
//    process() から呼ぶ（第2弾b1）ので、オーディオスレッドでガベージコレクションを起こさないためである。
//    計画・窓・作業用の配列（re・im・out）は、呼び出し側がコンストラクターで一度だけ用意する。
//    長さも確かめない（process() の中で例外を投げると、ノードが止まる）。長さは plan.n に合わせて作る。
//    test/fft.test.js がパラメーターと本体の文字列を見て、配列やオブジェクトを作る代表的な書き方
//    （new・リテラル・分割代入・for…of・許可していない関数の呼び出しなど）が無いことを確かめている。
//    実行してヒープの増え方を数えてはいない。

// FFT の計画。長さ n（2 以上の 2 の累乗）ごとに、ビット反転の並べ替え表と、
// 回転因子の表（cos・sin、k = 0..n/2-1 の角度 2πk/n）を前もって作る。
// ⚠ 配列を作るので、process() の中では呼ばない（コンストラクターの setupBands で呼ぶ）。
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
// ⚠ 配列を作るので、process() の中では呼ばない（コンストラクターの setupBands で呼ぶ）。
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

// ビン k の中心の周波数（Hz）。
// ⚠ 帯域へのビンの割り当ては、logic.js の bandPlan が同じ定義（k・sampleRate / N）で行い、
//    ビンの番号だけを processorOptions で渡してくる（第2弾b1）。MeterProcessor はこの関数を使わない。
//    test/fft.test.js が前提（48kHz・n=1024 で 18kHz がビン384の中心に乗る）を確かめるのに使う。
// 引数を rate と名付けるのは、ワークレットの大域の sampleRate を隠さないためである
function binFrequency(k, rate, n) {
  return k * rate / n;
}

// ---- 帯域の集計（第2弾b1）----
//
// 区間ごとに、帯域ごとの電力の和（bandPower）・数えたフレーム数（bandFrames）・
// 数えるはずだったフレーム数（bandExpected）を送る。dBFS への換算と band_valid_ratio は
// logic.js（buildIntervalRecord）で行う。帯域の平均二乗は「電力の和 ÷ bandFrames」である。
// ⚠ 帯域の値は「その帯域に音のエネルギーがあったか」の記録である。何が鳴っていたかは分からない。
//
// 帯域の定義・FFT の長さ N・ビンの割り当ては logic.js の bandPlan が決め、script.js が
// processorOptions.bandPlan で渡す。ワークレットは logic.js を読めないので、同じ値をここに書かない。
// ?bands=off のときは processorOptions.bands が false で届き、FFT を計算しない（帯域の値は null）。
//
// フレームの切り方：
//  - 窓は周期型 Hann、ずらし幅 H = N/4（75% の重なり）。Hann 窓の2乗を H=N/4 で重ねた和は
//    どの時刻でも 1.5 で一定になり、途切れのあいだと記録の起点のそば（下の「途切れ」）を除き、
//    どのサンプルも同じ重みで数えられる。H=N/2 だと 0.5〜1.0 と揺れ、
//    フレームの端に来た1ミリ秒の衝撃音が帯域の値から消えかける。H=N/4 なら、途切れのない信号で
//    全ビン（k = 0..N/2）について Σ_フレーム Σ_k out[k] = (1/H)・Σ_i x_i^2 になる
//    （Σw^2 = 3N/8 と重なりの和 1.5 から。フレームの平均を引く前の関係である）。
//    帯域に入るのはそのうちのビンの一部なので、全帯域を足した値（電力の和 ÷ bandFrames）が時間領域の
//    平均二乗と一致するのは、音のエネルギーが両帯域のビンの中（約100Hz〜超音波帯の上端より2ビンほど下）に
//    だけある定常な信号のときである。ビン0と、超音波帯の上端より上のビン（48kHz で 22〜24kHz、
//    96kHz で 22〜48kHz）はどの帯域にも入らない（白色雑音で両帯域の和 ÷ 平均二乗を測ると、
//    44.1kHz で -0.02dB、48kHz で -0.4dB、96kHz で -3.4dB だった）
//  - フレームの区切りはオーディオクロックのフレーム番号で固定する。番号 g が H の倍数の位置を
//    「フレームの終わり」とし、終わりが g のフレームはサンプル [g-N, g) である
//  - 各フレームは、終わり g を含む区間（startFrame ≤ g < endFrame）に数える。
//    ⚠ 中心で数えないのは、区間の最後の約10ミリ秒のフレームが区間の終わりまでに計算し終わらず、
//    行を作る（ハッシュを付ける）時点に間に合わないためである。終わりで数えるので、
//    区間の境目の前の約21ミリ秒（N サンプル）の音が、後ろの区間の値に入ることがある。
//    そのため、区間の中がデジタル無音（dbfs が -Infinity）の行でも、帯域の値が有限になることがある
//  - フレームごとに平均を引いてから窓を掛ける（周期型 Hann 窓では直流の電力の 1/3 がビン1へ入るため）。
//    ⚠ 平均を引くと、約100Hz より下の音は値が大きく変わる。このワークレットを node:vm で動かし、48kHz の正弦波を
//    測ると、可聴帯の値は A^2/2 に対して 20Hz -8.0dB・30Hz -4.3dB・40Hz -1.9dB・50Hz -0.4dB・70Hz +0.46dB・100Hz -0.07dB だった（44.1kHz の 20Hz は -7.2dB）。
//    フレーム（約21ミリ秒）に1〜2周期しか入らない音は、フレームの平均がその音自身の一部なので、引くと音の値も変わる。
//    ビン0を入れないので、平均を引かなくても 20Hz は -3.2dB になる。
//    約100Hz より上では、引いた平均（フレームに入りきらない端数の周期のぶん）が窓でビン1へ広がり、
//    わずかに大きく出る（電力の比で 440Hz が +3.2e-4、1kHz が +5.5e-5。どちらも 0.002dB 未満）。test/band.test.js で確かめている
//
// 途切れ：クォンタムが落ちた（currentFrame が前の呼び出しの終わりとつながらない）とき・入力が空のときは、
// そのあいだのサンプルを含むフレームを数えない。0 で埋めると「音が無かった」ことになるためである。
// リングバッファは「途切れずに届いたサンプル数」（bandRun）を持ち、N に満たないフレームは計算しない。
// 数えるはずだったフレームは、区間の中の H の倍数の個数である。ただし記録の起点（1区間めの startFrame）
// より前のサンプルが要るフレーム（g - N < 起点）は入れない。1行目が見せかけの欠測にならないようにするため。
// ⚠ そのかわり、起点から最大 N サンプル（48kHz で約21ミリ秒）の音は、重みが 1.5 に届かない（起点に近いほど小さい）。
//    起点から 6.3ミリ秒の1ミリ秒の衝撃音は約33%、10.4ミリ秒なら約86%しか入らず、band_valid_ratio には出ない
//    （記録を始めるたびに起きる）。途切れのそばでも重みは下がるが、そちらは数えなかったフレームが band_valid_ratio に出る。

// processorOptions の帯域の計画を確かめて、使う形（N と、帯域ごとのビンの範囲）にする。
// 使えないときは null を返し、帯域を計算しない（測れないものを「0」として送らない）。
//  - bands が false（?bands=off）・計画が無い・計画のサンプルレートがこのワークレットと違う
//  - N が 2 の累乗でない・範囲の外、帯域の数が範囲の外
//  - ビンの範囲が 1〜N/2 に収まらない（直流のビン0は入れない）
// ビンが無い帯域（binLo・binHi がともに null）は -1 として持ち、その帯域の値だけを null で送る。
// ⚠ 配列を作るので、process() の中では呼ばない（コンストラクターで呼ぶ）。
function readBandPlan(opts, rate) {
  if (!opts || opts.bands === false) return null;
  const plan = opts.bandPlan;
  if (!plan || typeof plan !== 'object' || plan.sampleRate !== rate) return null;
  const n = plan.fftSize;
  if (!Number.isInteger(n) || n < FFT_SIZE_MIN || n > FFT_SIZE_MAX || (n & (n - 1)) !== 0) return null;
  const list = plan.bands;
  if (!Array.isArray(list) || list.length === 0 || list.length > BAND_COUNT_MAX) return null;
  const lo = new Int32Array(list.length);
  const hi = new Int32Array(list.length);
  let usable = 0;
  for (let b = 0; b < list.length; b++) {
    const band = list[b] || {};
    if (band.binLo === null && band.binHi === null) {
      lo[b] = -1;
      hi[b] = -1;
      continue;
    }
    if (!Number.isInteger(band.binLo) || !Number.isInteger(band.binHi) ||
        band.binLo < 1 || band.binHi > n / 2 || band.binLo > band.binHi) return null;
    lo[b] = band.binLo;
    hi[b] = band.binHi;
    usable++;
  }
  // どの帯域にもビンが無いなら、FFT を計算しても送る値が無い
  if (usable === 0) return null;
  return { n, lo, hi };
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
    // 帯域の集計（第2弾b1）。区間の値を0へ戻す先を作るので、resetAccumulator より先に用意する
    this.setupBands(readBandPlan(opts, sampleRate));
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
    // レンダーグラフへ繋ぐ前の値で、1区間めの実際の起点にはならない）。
    // bands は帯域を計算するか（計画が使えないときは ?bands=off でなくても false になる。第2弾b1）
    this.port.postMessage({
      type: 'ready',
      sampleRate,
      intervalFrames: this.intervalFrames,
      bands: this.bandsOn,
      fftSize: this.bandsOn ? this.fftN : null
    });
  }

  // 帯域の集計の準備（第2弾b1）。plan は readBandPlan の戻り値で、null なら帯域を計算しない。
  // ⚠ 配列はすべてここで作る。process() の中では作らない（オーディオスレッドでのGCを避ける）
  setupBands(plan) {
    this.bandsOn = plan !== null;
    // 記録の起点（1区間めの startFrame）。起点より前のサンプルが要るフレームは、数えるはずのフレームに入れない
    this.bandOrigin = null;
    // リングバッファへ途切れずに届いたサンプル数（N で頭打ち）。途切れたら 0 へ戻す
    this.bandRun = 0;
    this.bandFrames = 0;
    // 区間の最後のサンプルで終わるフレーム（終わり g が区間の終わりと同じ）は、次の区間に入る。
    // 次の区間が始まるまで、ここに置いておく
    this.bandCarryFrames = 0;
    if (!this.bandsOn) return;
    const n = plan.n;
    this.fftN = n;
    this.fftHop = n / 4;
    this.fftMask = n - 1;
    this.fftPlan = createFftPlan(n);
    this.fftWin = hannWindow(n);
    this.fftWinPower = windowPowerSum(this.fftWin);
    this.fftRe = new Float64Array(n);
    this.fftIm = new Float64Array(n);
    this.fftOut = new Float64Array(n / 2 + 1);
    // 直近 N サンプルのリングバッファと、それを古い順に並べ直す作業用の配列
    this.bandRing = new Float64Array(n);
    this.bandRingPos = 0;   // 次に書く位置＝いちばん古いサンプルの位置
    this.bandFrame = new Float64Array(n);
    // 帯域ごとのビンの範囲（両端を含む）。ビンが無い帯域は -1
    this.bandLo = plan.lo;
    this.bandHi = plan.hi;
    this.bandSum = new Float64Array(plan.lo.length);
    this.bandCarry = new Float64Array(plan.lo.length);
    // ⚠ 最適化される前の最初の数回は遅い。Node 22.18 で powerSpectrumInto を続けて呼んで測ると、
    //    n=1024 は1回目が約2.0ミリ秒（1ブロック 2.667ミリ秒の76%）、2〜5回目が約0.56〜1.0ミリ秒、
    //    6〜60回目が約0.09〜0.16ミリ秒で、61回目から約0.032ミリ秒に落ち着いた。
    //    n=2048 は1回目が約3.1ミリ秒（1ブロックを超える）で、26回目から約0.068ミリ秒。
    //    記録中にこの遅さが出ないように、ここで FFT_WARMUP_CALLS（64）回呼んでおく。
    //    ここで待つ時間は、Node では n=1024 で約10〜12ミリ秒・n=2048 で約14ミリ秒だった（ブラウザーでは測っていない）。
    //    記録の起点は「前の呼び出しとつながった呼び出し」で決まる（第2弾a8）ので、
    //    コンストラクターが遅れても1行目は欠測にならない。
    for (let c = 0; c < FFT_WARMUP_CALLS; c++) {
      powerSpectrumInto(this.fftPlan, this.bandFrame, this.fftWin, this.fftWinPower,
        this.fftRe, this.fftIm, this.fftOut);
    }
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
    // 帯域（第2弾b1）。前の区間の最後のサンプルで終わったフレームは、ここで今の区間へ移す
    this.bandFrames = this.bandCarryFrames;
    this.bandCarryFrames = 0;
    if (this.bandsOn) {
      for (let b = 0; b < this.bandSum.length; b++) {
        this.bandSum[b] = this.bandCarry[b];
        this.bandCarry[b] = 0;
      }
    }
  }

  // 帯域ごとの電力の和（ビンが無い帯域は null）。
  // 区間ごとに1回の送信で、メッセージのオブジェクトと同じく、ここで配列を作る（フレームごとには作らない）
  bandPowerList() {
    const list = new Array(this.bandSum.length);
    for (let b = 0; b < list.length; b++) list[b] = this.bandLo[b] < 0 ? null : this.bandSum[b];
    return list;
  }

  // 区間 [start, end) の中で、数えるはずだったフレームの数（終わり g が H の倍数で start ≤ g < end）。
  // 記録の起点より前のサンプルが要るフレーム（g - N < 起点）は入れない
  bandExpectedIn(start, end) {
    const hop = this.fftHop;
    const from = Math.max(start, this.bandOrigin + this.fftN);
    if (from >= end) return 0;
    const first = Math.ceil(from / hop) * hop;
    if (first >= end) return 0;
    return Math.floor((end - 1 - first) / hop) + 1;
  }

  // ブロックの [from, to) のサンプルをリングバッファへ入れ、フレームの終わりに来るたびに帯域を計算する。
  // frame0 は channel[from] のフレーム番号。[from, to) はすべて今の区間に入っている（process() が区間の境目で分ける）。
  // ⚠ 配列もオブジェクトも作らない（test/fft.test.js が本体の文字列で見ている）
  feedBands(channel, from, to, frame0) {
    const ring = this.bandRing;
    const mask = this.fftMask;
    const n = this.fftN;
    const hop = this.fftHop;
    const intervalEnd = this.startFrame + this.intervalFrames;
    let pos = this.bandRingPos;
    let run = this.bandRun;
    for (let i = from; i < to; i++) {
      ring[pos] = channel[i];
      pos = (pos + 1) & mask;
      if (run < n) run++;
      // いま入れたサンプルの次のフレーム番号 g が H の倍数なら、[g-N, g) で1フレームになる。
      // ⚠ g は 2^31 を超えうる（48kHz で約12.4時間）ので、ビット演算ではなく % で見る
      const g = frame0 + (i - from) + 1;
      if (run === n && g % hop === 0) {
        this.analyzeBandFrame(pos);
        // 終わり g が区間の終わりと同じなら、g を含むのは次の区間である
        this.addBandFrame(g >= intervalEnd);
      }
    }
    this.bandRingPos = pos;
    this.bandRun = run;
  }

  // リングバッファの N サンプルを古い順（start から）に作業用の配列へ写し、平均を引いてから
  // 窓を掛けて、片側の電力スペクトルを fftOut へ書く。
  // ⚠ 配列もオブジェクトも作らない（process() から呼ぶ）
  analyzeBandFrame(start) {
    const n = this.fftN;
    const mask = this.fftMask;
    const ring = this.bandRing;
    const frame = this.bandFrame;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const x = ring[(start + i) & mask];
      frame[i] = x;
      sum += x;
    }
    // 平均を引く（SciPy の welch の既定 detrend='constant' と同じ）。直流がビン1へ入らないようにする
    const mean = sum / n;
    for (let i = 0; i < n; i++) frame[i] -= mean;
    powerSpectrumInto(this.fftPlan, frame, this.fftWin, this.fftWinPower, this.fftRe, this.fftIm, this.fftOut);
  }

  // fftOut を帯域ごとに足し、1フレームとして数える。toNext なら次の区間のぶんとして置いておく。
  // ⚠ 配列もオブジェクトも作らない（process() から呼ぶ）
  addBandFrame(toNext) {
    const out = this.fftOut;
    const sums = toNext ? this.bandCarry : this.bandSum;
    for (let b = 0; b < sums.length; b++) {
      const lo = this.bandLo[b];
      if (lo < 0) continue;
      const hi = this.bandHi[b];
      let s = 0;
      for (let k = lo; k <= hi; k++) s += out[k];
      sums[b] += s;
    }
    if (toNext) this.bandCarryFrames++;
    else this.bandFrames++;
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
      // 帯域（第2弾b1）。帯域を計算しないときは3つとも null。dBFS への換算は logic.js
      bandPower: this.bandsOn ? this.bandPowerList() : null,
      bandFrames: this.bandsOn ? this.bandFrames : null,
      bandExpected: this.bandsOn ? this.bandExpectedIn(this.startFrame, endFrame) : null,
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
      // 帯域の「数えるはずのフレーム」から、この起点より前のサンプルが要るものを除く（第2弾b1）
      this.bandOrigin = this.startFrame;
    }
    // 入力が途切れている間もオーディオクロックは進むので、ブロック長は既定の128で数える
    const blockLength = channel ? channel.length : 128;
    // クォンタムが落ちて（process() が呼ばれず）サンプルが飛んだら、クリップの連続を切る。
    // 帯域のリングバッファも空から埋め直す（飛んだサンプルを含むフレームを数えない。第2弾b1）
    if (this.nextFrame !== null && currentFrame !== this.nextFrame) {
      this.clipRunCur = 0;
      this.bandRun = 0;
    }
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
        if (this.bandsOn) this.feedBands(channel, offset, end, currentFrame + offset);
      } else {
        // 入力が途切れたら、クリップの連続も切る。
        // 帯域のリングバッファも空から埋め直す（0 で埋めると「音が無かった」ことになる。第2弾b1）
        this.clipRunCur = 0;
        this.bandRun = 0;
      }
      offset += take;
    }
    return true;
  }
}

registerProcessor('meter-processor', MeterProcessor);
