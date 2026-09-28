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
// ⚠ ヘッドレスの Chrome ではこの穴を再現できない（疑似マイクで実測したところ、
//    起点をコンストラクターに置いたままでも 1 行目から valid_ratio=1 だった）。
//    出力デバイスが無いあいだ currentFrame が進まないためで、実機とは条件が違う。

// ⚠⚠ 起点はさらに「入力に音が載った最初の process()」まで待つ（第2弾a3）。
//    iPhone の実機で、記録開始直後の区間の有効サンプル率が 74.9% になった。
//    48kHz・1秒の区間なら、欠けたのは 12032 フレーム＝ちょうど 94 クォンタム
//    （約251ミリ秒）である。上の穴とは別で、process() は呼ばれているのに、
//    マイクの経路が動き出すまで入力が空（チャンネルなし）で届く間を数えていた。
//    ただし、いつまでも音が来ない（マイクが最初から届かない）と1行も出ず、
//    「記録していない」ことすら残らない。猶予を過ぎたら最初の process() を起点にし、
//    届かなかったぶんを欠測（count=0）として残す。

'use strict';

const MIN_INTERVAL_FRAMES = 128;
const STARTUP_GRACE_SEC = 1;

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
    // 最初に process() が呼ばれたフレーム（猶予を数える起点）
    this.firstProcessFrame = null;
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
      if (this.firstProcessFrame === null) this.firstProcessFrame = currentFrame;
      if (channel) {
        this.startFrame = currentFrame;
      } else if (currentFrame - this.firstProcessFrame >= Math.round(sampleRate * STARTUP_GRACE_SEC)) {
        // 猶予を過ぎても音が来ない。最初の process() を起点にし、欠測として残す
        this.startFrame = this.firstProcessFrame;
      } else {
        return true;   // まだ始めない
      }
    }
    // 入力が途切れている間もオーディオクロックは進むので、ブロック長は既定の128で数える
    const blockLength = channel ? channel.length : 128;

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
          if (a >= 1) this.clip++;
        }
        this.count += take;
      }
      offset += take;
    }
    return true;
  }
}

registerProcessor('meter-processor', MeterProcessor);
