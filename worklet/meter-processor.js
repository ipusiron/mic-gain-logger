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

'use strict';

const MIN_INTERVAL_FRAMES = 128;

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
    this.startFrame = currentFrame;
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

    this.port.postMessage({ type: 'ready', sampleRate, startFrame: this.startFrame });
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
    const channel = (input && input.length > 0) ? input[0] : null;
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
