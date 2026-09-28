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

  // ---- CSV ----
  function buildCsv(logs) {
    const header = 'timestamp,dbfs\n';
    const lines = logs.map(r => `${r.ts.toISOString()},${r.db.toFixed(2)}`).join('\n');
    return header + lines;
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
    buildCsv,
    csvFileName
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = MicGainLogic;
}
