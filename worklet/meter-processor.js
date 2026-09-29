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
