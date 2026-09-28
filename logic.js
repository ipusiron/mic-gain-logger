// Day041 - Mic Gain Logger / 純粋ロジック（DOM非依存）
// script.js から移した純関数だけを置く。ブラウザーでは通常のスクリプトとして、
// テストでは CommonJS の require で読む。

'use strict';

const MicGainLogic = (() => {
  // 値のクランプ
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

  // dBFS 表示→% 変換（-60dBFS=0%, 0dBFS=100%）
  function dbToPercent(db, floorDb = -60) {
    const p = (db - floorDb) / (0 - floorDb);
    return clamp(p * 100, 0, 100);
  }

  // 時分秒
  function formatHMS(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    return [h, m, s].map(x => String(x).padStart(2, '0')).join(':');
  }

  // RMS→dBFS（振幅→dBFS にも同じ式を使う）
  function rmsToDbfs(rms) {
    if (rms <= 1e-8) return -Infinity;
    return 20 * Math.log10(rms);
  }

  // サンプル列の RMS
  function rmsOf(samples) {
    let sumSq = 0;
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];
      sumSq += x * x;
    }
    return Math.sqrt(sumSq / samples.length);
  }

  // 表示下限の入力値を数値へ（空欄・非数は既定の -60）
  function parseFloorDb(raw) {
    const v = parseFloat(raw);
    if (Number.isNaN(v)) return -60;
    return v;
  }

  // ログ間隔の入力値を秒へ（下限 0.2 秒）
  function parseIntervalSec(raw) {
    return Math.max(0.2, parseFloat(raw) || 1);
  }

  // ---- 統計 ----
  function createStats() {
    return { sum: 0, n: 0, minDb: Infinity, maxDb: -Infinity };
  }

  // 有限値だけを取り込む。取り込んだら true。
  function addStatsSample(stats, db) {
    if (!Number.isFinite(db)) return false;
    stats.sum += db;
    stats.n += 1;
    stats.minDb = Math.min(stats.minDb, db);
    stats.maxDb = Math.max(stats.maxDb, db);
    return true;
  }

  function formatStats(stats, logCount) {
    const rng = (Number.isFinite(stats.minDb) && Number.isFinite(stats.maxDb))
      ? (stats.maxDb - stats.minDb)
      : 0;
    return {
      avg: `${(stats.sum / stats.n).toFixed(1)} dBFS`,
      max: `${stats.maxDb.toFixed(1)} dBFS`,
      min: `${stats.minDb.toFixed(1)} dBFS`,
      range: `${rng.toFixed(1)} dB`,
      count: String(logCount)
    };
  }

  function emptyStatsText() {
    return {
      avg: '--.- dBFS',
      max: '--.- dBFS',
      min: '--.- dBFS',
      range: '--.- dB',
      count: '0'
    };
  }

  // ---- 区間（1行＝1区間）----
  //
  // 計測の単位は「瞬間」ではなく「区間」である。1区間は次を持つ。
  //   開始・終了時刻（オーディオクロックと、それに対応する壁時計の両方）
  //   代表値 db（区間内のエネルギー平均＝Leq と同じ定義）
  //   真のピーク peak / peakDb（区間内の最大絶対値。RMS とは別物）
  //   クリップ数 clipCount（|sample| >= 1.0 のサンプル数）
  //   有効サンプル率 validRatio（実際に届いたサンプル数 ÷ 期待サンプル数）
  // CSV の列は段階1では増やさないが、内部の構造だけ先に確定させておく。

  const ENGINE_WORKLET = 'worklet';
  const ENGINE_FALLBACK = 'fallback';

  // ログ間隔（秒）→ フレーム数
  function framesForInterval(intervalSec, sampleRate) {
    const frames = Math.round(intervalSec * sampleRate);
    return Math.max(128, Number.isFinite(frames) ? frames : Math.round(sampleRate));
  }

  function validRatioOf(count, expected) {
    if (!(expected > 0)) return 0;
    return count / expected;
  }

  // オーディオクロックの秒 → 壁時計のミリ秒
  // anchor = { audioTime, wallMs }（記録開始時に1回だけ取る）
  function audioTimeToWallMs(audioTime, anchor) {
    return anchor.wallMs + (audioTime - anchor.audioTime) * 1000;
  }

  // ワークレットからの1メッセージを1行分の区間レコードへ
  function buildIntervalRecord(msg, anchor, floorDb) {
    const sr = msg.sampleRate;
    const startTime = msg.startFrame / sr;
    const endTime = msg.endFrame / sr;
    const rms = msg.count > 0 ? Math.sqrt(msg.sumSq / msg.count) : 0;
    const rawDb = rmsToDbfs(rms);
    const startWall = new Date(audioTimeToWallMs(startTime, anchor));
    const endWall = new Date(audioTimeToWallMs(endTime, anchor));
    return {
      seq: msg.seq,
      engine: ENGINE_WORKLET,
      startTime,
      endTime,
      startWall,
      endWall,
      ts: endWall,                       // CSV の timestamp 列（区間の終わり）
      rawDb,                             // 区間のエネルギー平均（生値）
      db: Math.max(rawDb, floorDb),      // 表示下限でのクリップ（段階2で表示専用へ移す）
      peak: msg.peak,
      peakDb: rmsToDbfs(msg.peak),
      clipCount: msg.clip,
      sampleCount: msg.count,
      expectedSamples: msg.expected,
      validRatio: validRatioOf(msg.count, msg.expected)
    };
  }

  // AudioWorklet が使えない環境（簡易モード）での1行。
  // 瞬時値しか手元にないので、ピーク・クリップ数・有効サンプル率は「不明」を入れる。
  function buildFallbackRecord(opts) {
    const rawDb = opts.db;
    const endWall = new Date(opts.endWallMs);
    return {
      seq: opts.seq,
      engine: ENGINE_FALLBACK,
      startTime: opts.startTime,
      endTime: opts.endTime,
      startWall: new Date(opts.startWallMs),
      endWall,
      ts: endWall,
      rawDb,
      db: Math.max(rawDb, opts.floorDb),
      peak: null,
      peakDb: null,
      clipCount: null,
      sampleCount: null,
      expectedSamples: opts.expectedSamples,
      validRatio: null
    };
  }

  // ---- CSV ----
  // 列は段階1では増やさない（timestamp,dbfs のまま）。
  // どちらの計測モードで取った記録かだけを、先頭の1行のコメントで残す。
  function buildCsv(logs, opts) {
    const header = 'timestamp,dbfs\n';
    const lines = logs.map(r => `${r.ts.toISOString()},${r.db.toFixed(2)}`).join('\n');
    const prefix = (opts && opts.engine) ? `# engine=${opts.engine}\n` : '';
    return prefix + header + lines;
  }

  function csvFileName(date) {
    const ts = date.toISOString().replace(/[:.]/g, '-');
    return `mic-gain-logs-${ts}.csv`;
  }

  return {
    clamp,
    dbToPercent,
    formatHMS,
    rmsToDbfs,
    rmsOf,
    parseFloorDb,
    parseIntervalSec,
    createStats,
    addStatsSample,
    formatStats,
    emptyStatsText,
    ENGINE_WORKLET,
    ENGINE_FALLBACK,
    framesForInterval,
    validRatioOf,
    audioTimeToWallMs,
    buildIntervalRecord,
    buildFallbackRecord,
    buildCsv,
    csvFileName
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = MicGainLogic;
}
