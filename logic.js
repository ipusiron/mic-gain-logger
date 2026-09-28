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
  // anchor = { epoch, audioTime, wallMs }
  function audioTimeToWallMs(audioTime, anchor) {
    return anchor.wallMs + (audioTime - anchor.audioTime) * 1000;
  }

  // ---- 時刻のアンカーと、その取り直し ----
  //
  // AudioContext が suspend されているあいだ currentTime は進まないが、壁時計は進む。
  // 記録開始時のアンカーを使い続けると、再開後のタイムスタンプが中断していた時間ぶん
  // 過去へずれる。スマートフォンの画面ロックで必ず通る経路なので、ずれを検出して
  // アンカーを取り直し、取り直したことを記録に残す。
  //
  // ずれの見方は「前回の点検からの差分」である。開始時からの累積で見ると、
  // オーディオ機器のクロックと OS のクロックのわずかな周波数差
  // （数十 ppm ＝ 1時間で数百ミリ秒）が積み上がって中断と区別できなくなる。
  // 差分で見れば周波数差は1秒あたり 0.1 ミリ秒未満に収まり、
  // 中断（秒単位の跳び）とはっきり分かれる。

  const CLOCK_JUMP_THRESHOLD_MS = 250;
  const CLOCK_BREAK_SUSPEND = 'suspend';   // statechange で中断を観測した
  const CLOCK_BREAK_STALL = 'stall';       // 状態変化なしにオーディオクロックが遅れた
  const CLOCK_OK = 'ok';
  const CLOCK_RESYNC = 'resync';           // この区間はアンカーの取り直しを跨いでいる

  function createClockAnchor(audioTime, wallMs) {
    return { epoch: 0, audioTime, wallMs };
  }

  // 2点間で、壁時計の経過とオーディオクロックの経過の差（ミリ秒）。
  // 正＝オーディオクロックが遅れている＝その間オーディオが止まっていた。
  function clockDriftMs(from, audioTime, wallMs) {
    return (wallMs - from.wallMs) - (audioTime - from.audioTime) * 1000;
  }

  // 前回の点検（probe）からのずれが閾値以上なら跳びとして報告する。閾値未満なら null。
  // probe は「点検した時刻の組」で、アンカーとは別に持つ。
  function detectClockJump(probe, audioTime, wallMs, thresholdMs) {
    const limit = Number.isFinite(thresholdMs) ? thresholdMs : CLOCK_JUMP_THRESHOLD_MS;
    const drift = clockDriftMs(probe, audioTime, wallMs);
    if (!(Math.abs(drift) >= limit)) return null;
    return { jumpMs: drift };
  }

  // アンカーを取り直す（epoch を1つ進める）
  function reanchorClock(anchor, audioTime, wallMs) {
    return { epoch: anchor.epoch + 1, audioTime, wallMs };
  }

  // ---- デジタル無音の扱い ----
  //
  // 振幅が完全に0の区間の dBFS は、定義上 -Infinity である。
  // 改修前はこれを「値が取れなかった」とみなして行ごと捨てていたため、
  // CSV には無標識の穴だけが残り、「対象時刻に音響活動がなかった」ことを
  // 示せなかった。証拠保全を掲げるツールとして、これは成立しない。
  //
  // 表示下限（floorDb）は表示のための設定なので、-Infinity をそこへ丸めない。
  // 丸めると「測っていない値」を作ってしまう。CSV には -Infinity と書く。

  function clipForDisplay(db, floorDb) {
    // 有限値だけを表示下限で切る（-Infinity はそのまま通す）
    return Number.isFinite(db) ? Math.max(db, floorDb) : db;
  }

  // ワークレットからの1メッセージを1行分の区間レコードへ
  // extra = { clockBreak: { kind, jumpMs } | null }
  function buildIntervalRecord(msg, anchor, floorDb, extra) {
    const sr = msg.sampleRate;
    const startTime = msg.startFrame / sr;
    const endTime = msg.endFrame / sr;
    const rms = msg.count > 0 ? Math.sqrt(msg.sumSq / msg.count) : 0;
    const rawDb = rmsToDbfs(rms);
    const startWall = new Date(audioTimeToWallMs(startTime, anchor));
    const endWall = new Date(audioTimeToWallMs(endTime, anchor));
    const brk = (extra && extra.clockBreak) || null;
    return {
      seq: msg.seq,
      engine: ENGINE_WORKLET,
      startTime,
      endTime,
      startWall,
      endWall,
      ts: endWall,                       // CSV の timestamp 列（区間の終わり）
      rawDb,                             // 区間のエネルギー平均（生値）
      db: clipForDisplay(rawDb, floorDb),
      silent: rawDb === -Infinity,       // デジタル無音（振幅が完全に0の区間）
      peak: msg.peak,
      peakDb: rmsToDbfs(msg.peak),
      clipCount: msg.clip,
      sampleCount: msg.count,
      expectedSamples: msg.expected,
      validRatio: validRatioOf(msg.count, msg.expected),
      clockEpoch: anchor.epoch || 0,
      clockStatus: brk ? CLOCK_RESYNC : CLOCK_OK,
      clockBreakKind: brk ? brk.kind : null,
      clockJumpMs: brk ? brk.jumpMs : null
    };
  }

  // AudioWorklet が使えない環境（簡易モード）での1行。
  // 瞬時値しか手元にないので、ピーク・クリップ数・有効サンプル率は「不明」を入れる。
  function buildFallbackRecord(opts) {
    const rawDb = opts.db;
    const endWall = new Date(opts.endWallMs);
    const brk = opts.clockBreak || null;
    return {
      seq: opts.seq,
      engine: ENGINE_FALLBACK,
      startTime: opts.startTime,
      endTime: opts.endTime,
      startWall: new Date(opts.startWallMs),
      endWall,
      ts: endWall,
      rawDb,
      db: clipForDisplay(rawDb, opts.floorDb),
      silent: rawDb === -Infinity,
      peak: null,
      peakDb: null,
      clipCount: null,
      sampleCount: null,
      expectedSamples: opts.expectedSamples,
      validRatio: null,
      clockEpoch: opts.clockEpoch || 0,
      clockStatus: brk ? CLOCK_RESYNC : CLOCK_OK,
      clockBreakKind: brk ? brk.kind : null,
      clockJumpMs: brk ? brk.jumpMs : null
    };
  }

  // ---- CSV ----
  // 列は増やさない（timestamp,dbfs のまま。列の確定は段階4の CSV v2）。
  // どちらの計測モードで取った記録かだけを、先頭のコメント行で残す。

  // dBFS を1セルへ。無音は数値へ丸めず -Infinity と書く。
  // 数値に見える値を書かないので、集計側が無音を測定値として取り込むことがない。
  function formatCsvDb(db) {
    if (Number.isFinite(db)) return db.toFixed(2);
    return String(db);   // -Infinity（無音）。想定外の値も隠さずそのまま出す
  }

  function buildCsv(logs, opts) {
    const header = 'timestamp,dbfs\n';
    const lines = logs.map(r => `${r.ts.toISOString()},${formatCsvDb(r.db)}`).join('\n');
    let prefix = (opts && opts.engine) ? `# engine=${opts.engine}\n` : '';
    if (logs.some(r => r.db === -Infinity)) prefix += '# silence=-Infinity\n';
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
    CLOCK_JUMP_THRESHOLD_MS,
    CLOCK_BREAK_SUSPEND,
    CLOCK_BREAK_STALL,
    CLOCK_OK,
    CLOCK_RESYNC,
    createClockAnchor,
    clockDriftMs,
    detectClockJump,
    reanchorClock,
    clipForDisplay,
    buildIntervalRecord,
    buildFallbackRecord,
    formatCsvDb,
    buildCsv,
    csvFileName
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = MicGainLogic;
}
