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

  // 表示下限の許される範囲。
  // 0 以上を入れるとメーター幅が NaN%（＝CSSOM に拒否されて無言で凍結）になり、
  // 大型表示も「10.0 dBFS」という物理的にありえない正の dBFS を出していた。
  const FLOOR_DB_MIN = -120;
  const FLOOR_DB_MAX = -1;

  // 表示下限の入力値を数値へ（空欄・非数は既定の -60。範囲外は丸める）
  function parseFloorDb(raw) {
    const v = parseFloat(raw);
    if (Number.isNaN(v)) return -60;
    return clamp(v, FLOOR_DB_MIN, FLOOR_DB_MAX);
  }

  // ログ間隔の入力値を秒へ（下限 0.2 秒）
  function parseIntervalSec(raw) {
    return Math.max(0.2, parseFloat(raw) || 1);
  }

  // ---- 統計 ----
  //
  // 母集団は「記録された行（区間）」である。
  // 改修前は requestAnimationFrame ごと（約60Hz）に集計していたので、
  // ログ間隔（既定1秒）で書かれる CSV とは母集団が違っていた。実測では
  // ログ間隔5秒・14秒の記録で、CSV は -20.0 が2行なのに画面の最小は
  // -39.1 dBFS、変動幅は 19.1 dB と出ていた。第三者が CSV から画面の値を
  // 再現できないので、証拠・監査の用途では単独で失格になる。
  //
  // ⚠ 平均は dB の算術平均ではなくエネルギー平均（Leq と同じ定義）にする。
  //    dB は対数なので算術平均には物理的な意味がなく、実測で最大26dBずれる。
  //      Leq = 10 * log10( (1/N) * Σ 10^(db_i/10) )
  //    区間の代表値は段階1ですでにエネルギー平均なので、区間を連結すれば
  //    正しい Leq が出る（等間隔の区間であることが前提）。
  //
  // 無音（-Infinity）の扱いを分けてある。
  //   平均（Leq）＝ 全行。無音は電力 0 として数える（これが定義どおり）
  //   最大・最小・変動幅 ＝ 有限値の行だけ。無音を入れると最小が -∞ になり、
  //                        変動幅が意味を失うため

  function dbToPower(db) {
    if (db === -Infinity) return 0;
    return Math.pow(10, db / 10);
  }

  function powerToDb(power) {
    if (!(power > 0)) return -Infinity;
    return 10 * Math.log10(power);
  }

  function createStats() {
    return { powerSum: 0, n: 0, finiteN: 0, silentN: 0, minDb: Infinity, maxDb: -Infinity };
  }

  // 1区間ぶんを取り込む。取り込んだら true（数値にならないものだけ false）。
  function addStatsSample(stats, db) {
    if (Number.isNaN(db)) return false;
    if (db === Infinity) return false;
    stats.powerSum += dbToPower(db);
    stats.n += 1;
    if (Number.isFinite(db)) {
      stats.finiteN += 1;
      stats.minDb = Math.min(stats.minDb, db);
      stats.maxDb = Math.max(stats.maxDb, db);
    } else {
      stats.silentN += 1;
    }
    return true;
  }

  // 記録された行から Leq を出す。記録が無ければ null
  function statsLeq(stats) {
    if (!stats.n) return null;
    return powerToDb(stats.powerSum / stats.n);
  }

  function formatDbCell(db) {
    if (db === -Infinity) return '-∞ dBFS';
    if (!Number.isFinite(db)) return '--.- dBFS';
    return `${db.toFixed(1)} dBFS`;
  }

  function formatStats(stats, logCount) {
    const leq = statsLeq(stats);
    const hasFinite = stats.finiteN > 0;
    const rng = hasFinite ? (stats.maxDb - stats.minDb) : null;
    return {
      avg: leq === null ? '--.- dBFS' : formatDbCell(leq),
      max: hasFinite ? formatDbCell(stats.maxDb) : '--.- dBFS',
      min: hasFinite ? formatDbCell(stats.minDb) : '--.- dBFS',
      range: rng === null ? '--.- dB' : `${rng.toFixed(1)} dB`,
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

  // ---- キャンバスの大きさ ----
  //
  // getBoundingClientRect() は非整数を返す（ブラウザーのズーム 90/110/133%、
  // スマートフォンの幅）。改修前はその値をそのまま `new Array(WIDTH)` へ渡していて
  // RangeError: Invalid array length になった。しかも例外が resizeCanvas() の
  // 途中で飛ぶため、呼び出し元の drawSeries() と handleMobileButtonLayout() まで
  // 巻き添えで実行されない連鎖故障になっていた。整数へ丸めてから使う。
  //
  // cssW/cssH は描画で使う論理サイズ、pixelW/pixelH は canvas の内部解像度
  // （dpr 倍）である。表示上の大きさは CSS が決めるので、ここでは返さない。
  function canvasPixelSize(rectW, rectH, dpr) {
    const ratio = (Number.isFinite(dpr) && dpr > 0) ? dpr : 1;
    const cssW = Math.max(1, Math.round(Number.isFinite(rectW) ? rectW : 1));
    const cssH = Math.max(1, Math.round(Number.isFinite(rectH) ? rectH : 1));
    return {
      cssW,
      cssH,
      pixelW: Math.max(1, Math.round(cssW * ratio)),
      pixelH: Math.max(1, Math.round(cssH * ratio))
    };
  }

  // ---- グラフ（時間軸）----
  //
  // 改修前は「1フレーム＝1px」で左へ流す実装だった。1px の意味する時間が
  // リフレッシュレート（60Hz / 120Hz）とタブの非アクティブ化で変わるので、
  // 横軸が時間になっていない。目盛りもラベルも無かった。
  // 段階1で時刻がオーディオクロックに乗ったので、ここで横軸を実時間にする。
  //
  // ⚠ 点は dB 値のまま持つ。改修前は 0..1 へ正規化してから積んでいたため、
  //    記録中に表示下限を変えると、過去の点だけ古い正規化のまま残っていた。

  const GRAPH_WINDOW_SEC = 60;   // 横軸に映す長さ（秒）
  const GRAPH_TOP_DB = 0;        // 縦軸の上端（dBFS の最大は 0）

  // 目盛りとラベルのぶんだけ内側へ寄せた描画領域。
  // 狭い画面では余白を詰める（スマートフォンでは高さ 120px しかない）。
  function graphArea(width, height) {
    const left = width < 360 ? 28 : 40;
    const right = 8;
    const top = 8;
    const bottom = height < 160 ? 14 : 18;
    return {
      x: left,
      y: top,
      w: Math.max(1, width - left - right),
      h: Math.max(1, height - top - bottom)
    };
  }

  // 時刻 → x 座標（右端が「いま」、左端が windowMs 前）
  function timeToX(tMs, nowMs, windowMs, area) {
    const span = windowMs > 0 ? windowMs : 1;
    const ago = clamp((nowMs - tMs) / span, 0, 1);
    return area.x + area.w * (1 - ago);
  }

  // dBFS → y 座標。無音（-Infinity）は下端へ置く
  function dbToY(db, floorDb, topDb, area) {
    if (!Number.isFinite(db)) return area.y + area.h;
    const span = (topDb - floorDb) || 1;
    const t = clamp((db - floorDb) / span, 0, 1);
    return area.y + area.h * (1 - t);
  }

  // 目盛りの間隔。本数がおおむね6本以下に収まる刻みを選ぶ
  function timeTickStepSec(windowSec) {
    const candidates = [1, 2, 5, 10, 15, 30, 60, 120, 300];
    for (let i = 0; i < candidates.length; i++) {
      if (windowSec / candidates[i] <= 6) return candidates[i];
    }
    return Math.ceil(windowSec / 6);
  }

  // 右端を 0 秒前として、左へ step 秒ずつ
  function timeTicks(windowSec, stepSec) {
    const step = stepSec > 0 ? stepSec : timeTickStepSec(windowSec);
    const out = [];
    for (let ago = 0; ago <= windowSec + 1e-9; ago += step) {
      const a = Math.round(ago * 1000) / 1000;
      out.push({ agoSec: a, label: a === 0 ? '0s' : `-${a}s` });
    }
    return out;
  }

  function dbTickStep(spanDb) {
    const candidates = [1, 2, 5, 10, 20, 30, 50];
    for (let i = 0; i < candidates.length; i++) {
      if (spanDb / candidates[i] <= 6) return candidates[i];
    }
    return Math.ceil(spanDb / 6);
  }

  // 上端（0 dBFS）から下へ。表示下限そのものは必ず1本入れる
  function dbTicks(floorDb, topDb, stepDb) {
    const span = topDb - floorDb;
    const step = stepDb > 0 ? stepDb : dbTickStep(span > 0 ? span : 1);
    const out = [];
    for (let v = topDb; v >= floorDb - 1e-9; v -= step) {
      out.push(Math.round(v * 100) / 100);
    }
    if (!out.length || Math.abs(out[out.length - 1] - floorDb) > 1e-9) out.push(floorDb);
    return out.map(db => ({ db, label: String(Math.round(db)) }));
  }

  // 窓の外へ出た点を落とす。線が左端まで届くように、窓の外の直近1点は残す
  function pruneSeries(series, nowMs, windowMs) {
    if (!series.length) return series;
    const cutoff = nowMs - windowMs;
    let keepFrom = series.length - 1;   // 全部古ければ最後の1点だけ残す
    for (let i = 0; i < series.length; i++) {
      if (series[i].tMs >= cutoff) { keepFrom = i > 0 ? i - 1 : 0; break; }
    }
    return keepFrom > 0 ? series.slice(keepFrom) : series;
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
    // seq は「1つのCSVの中での通し番号」である。
    // ⚠ ワークレット側のカウンターは記録開始のたびに0から振り直される
    //   （記録開始のたびに新しい AudioWorkletNode を作るため）。ログは累積するので、
    //   そのまま載せると1つのCSVの中で seq が 0 に戻る。呼ぶ側が起点をずらす。
    //   区間を捨てたときの欠番は、ずらしても残る（欠番＝行が抜けた印であるため）。
    const seqBase = (extra && Number.isFinite(extra.seqBase)) ? extra.seqBase : 0;
    return {
      seq: Number.isFinite(msg.seq) ? seqBase + msg.seq : msg.seq,
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
      clockJumpMs: brk ? brk.jumpMs : null,
      // 測定条件は1セッションに1つ。参照だけを持ち、行ごとに複製しない
      metaId: (extra && extra.meta) ? extra.meta.id : null,
      meta: (extra && extra.meta) || null
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
      clockJumpMs: brk ? brk.jumpMs : null,
      metaId: opts.meta ? opts.meta.id : null,
      meta: opts.meta || null
    };
  }

  // ---- 測定条件（セッションのメタデータ）----
  //
  // AGC・ノイズ抑制・エコーキャンセルを「無効で」と要求しても、
  // 実際に無効になったかは track.getSettings() の実値でしか分からない。
  // AGC が効いていると入力の利得が勝手に動くので、dBFS の値そのものが
  // 測定値として信用できなくなる。
  // CSV の列は増やさない（列の確定は段階4の CSV v2）。内部のレコードから
  // 参照できる形で1セッション分を1つだけ持ち、行ごとに複製しない。

  // 主要3項目。どの実装も報告するので、報告が無ければ「不明」として扱う
  const PROCESSING_KEYS = ['autoGainControl', 'noiseSuppression', 'echoCancellation'];
  // 実装によっては存在しない加工。報告されて有効なときだけ数え、
  // 無ければ「不明」にはしない（大半のブラウザーで不明だらけになるため）
  const PROCESSING_OPTIONAL_KEYS = ['voiceIsolation'];
  const PROCESSING_OFF = 'off';           // 3つとも無効と報告された
  const PROCESSING_ACTIVE = 'active';     // 1つ以上が有効になっている
  const PROCESSING_UNKNOWN = 'unknown';   // 報告しない項目がある

  function numberOrNull(v) {
    return Number.isFinite(v) ? v : null;
  }

  // true / false / null（その環境が報告しない）の3値にそろえる
  function tristate(v) {
    if (v === true) return true;
    if (v === false) return false;
    return null;
  }

  function buildSessionMeta(input) {
    const src = input || {};
    const s = src.settings || {};
    const processing = {};
    const allKeys = PROCESSING_KEYS.concat(PROCESSING_OPTIONAL_KEYS);
    for (let i = 0; i < allKeys.length; i++) {
      processing[allKeys[i]] = tristate(s[allKeys[i]]);
    }
    const active = allKeys.filter(k => processing[k] === true);
    const unknown = PROCESSING_KEYS.filter(k => processing[k] === null);
    return Object.freeze({
      id: src.id || null,
      startedWallMs: numberOrNull(src.startedWallMs),
      engine: src.engine || null,
      contextSampleRate: numberOrNull(src.contextSampleRate),
      trackSampleRate: numberOrNull(s.sampleRate),
      channelCount: numberOrNull(s.channelCount),
      deviceLabel: src.deviceLabel || null,
      deviceId: s.deviceId || null,
      groupId: s.groupId || null,
      latency: numberOrNull(s.latency),
      processing: Object.freeze(processing),
      processingActive: Object.freeze(active),
      processingUnknown: Object.freeze(unknown),
      requested: Object.freeze(Object.assign({}, src.requested)),
      settings: Object.freeze(Object.assign({}, s)),
      userAgent: src.userAgent || null,
      timeZone: src.timeZone || null
    });
  }

  // 測定値をそのまま信用してよいか
  function processingVerdict(meta) {
    if (!meta) return PROCESSING_UNKNOWN;
    if (meta.processingActive.length) return PROCESSING_ACTIVE;
    if (meta.processingUnknown.length) return PROCESSING_UNKNOWN;
    return PROCESSING_OFF;
  }

  // ---- マイクの取得の試行 ----
  //
  // getUserMedia をタイムアウトなしで await していたため、許可プロンプトを
  // 放置すると「マイクに接続中…」の表示のまま記録開始・停止の両方が無効になり、
  // リロード以外に復帰手段がなかった。
  //
  // 試行に世代番号（トークン）を持たせ、取り消し・時間切れのあとに遅れて
  // 届いたストリームを捨てられるようにする。

  const CONNECT_HINT_MS = 8000;      // これを過ぎたら「応答してください」と出す
  const CONNECT_TIMEOUT_MS = 20000;  // これを過ぎたら試行を打ち切る

  function createAttemptGate() {
    let current = 0;
    return {
      begin() { current += 1; return current; },
      isCurrent(token) { return token > 0 && token === current; },
      cancel() { current += 1; },
      generation() { return current; }
    };
  }

  // 約束にタイムアウトを噛ませる。
  // 時間切れなら { timedOut: true }、成功なら { value }、失敗なら { error }。
  // 元の約束は捨てないので、呼び出し側が遅れて届いたストリームを止められる。
  // 既定のタイマー。ブラウザーの setTimeout は this が Window でないと
  // Illegal invocation になるので、オブジェクトへ直に入れずに包む。
  const DEFAULT_TIMERS = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id)
  };

  function raceWithTimeout(promise, ms, timers) {
    const t = timers || DEFAULT_TIMERS;
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = t.setTimeout(() => resolve({ timedOut: true }), ms);
    });
    const settled = Promise.resolve(promise).then(
      (value) => ({ value }),
      (error) => ({ error })
    );
    return Promise.race([settled, timeout]).then((result) => {
      if (timer !== null) t.clearTimeout(timer);
      return result;
    });
  }

  // ---- マイクのデバイス喪失 ----
  //
  // トラックを stop しても MediaStreamAudioSourceNode はデジタル無音を流し続ける。
  // そのため有効サンプル率は 1.0 のまま、サンプル数も期待どおりのままで、
  // dBFS だけが -Infinity になる。つまり計測値からは
  // 「部屋が静かだった」と「マイクが死んだ」を区別できない。
  // 区別できるのは MediaStreamTrack の状態だけである。

  const TRACK_LIVE = 'live';
  const TRACK_ENDED = 'ended';
  const DEVICE_LOST_ENDED = 'ended';   // ended イベント／readyState が live でない
  const DEVICE_LOST_GONE = 'gone';     // 音声トラックそのものが無くなった

  function readTrackState(track) {
    if (!track) return { readyState: null, muted: null, enabled: null, live: false };
    return {
      readyState: track.readyState || null,
      muted: track.muted === true,
      enabled: track.enabled !== false,
      live: track.readyState === TRACK_LIVE
    };
  }

  function isTrackLost(state) {
    return !state || state.live !== true;
  }

  // 最後の行に「この行のあとでマイクを失った」印を付ける。
  // 失ったあとの区間は測っていないので、行を作らない（作れば嘘になる）。
  function markDeviceLoss(logs, event) {
    const last = logs.length ? logs[logs.length - 1] : null;
    if (last) {
      last.deviceLostAfter = true;
      last.deviceLostReason = event.reason;
    }
    return {
      reason: event.reason,
      atWallMs: event.atWallMs,
      lastSeq: last ? last.seq : null,
      rowsKept: logs.length
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

  // 鎖の起点。
  // ⚠ 「出力されるメタ行そのもの」でなければならない。
  // hashAlgo や silence の印は buildCsv の中で足されるので、呼ぶ側が組んだ
  // メタ行で seed を作ると、受け取った側の再計算と一致しない（実際にずれた）。
  // 実装もテストもこの関数を通すことで、その食い違いを起こさないようにする。
  function csvSeed(logs, opts) {
    const probe = buildCsv(logs, Object.assign({}, opts || {}, { hashes: logs.map(() => '') }));
    return probe.split('\n').filter(l => l.charAt(0) === '#').join('\n');
  }

  // ⚠ 書き出すのは rawDb（生値）である。
  // 改修前は表示下限でクリップした値を記録していたため、記録中に表示の設定を
  // 変えるとログデータ自体が変質していた。表示下限は表示のための設定なので、
  // 記録には触らせない（db は表示用、rawDb は記録用と役割を分ける）。
  // CSV v2。
  //
  // A列 timestamp・B列 dbfs は動かさない。README が案内している Excel の手順
  // （=AVERAGE(B:B) など）が A列=時刻・B列=音量を前提にしているためで、
  // 新しい値は右へ足す。今後 列を足すときも同じ約束にする。
  //
  // seq は区間の通し番号である。欠番があれば行が抜けたと分かるので、
  // ハッシュチェーンとは別の手がかりになる。
  const CSV_COLUMNS = ['timestamp', 'dbfs', 'seq', 'peak_dbfs', 'clip', 'valid_ratio', 'hash'];

  // ハッシュチェーン。
  //
  // ⚠⚠ これは「改ざんを防ぐ」ものではない。
  // ログを作った本人はチェーンごと作り直せるので、提出者自身が疑われる場面
  // （探偵が自分で採ったログを裁判資料に出す、など）では主張が立たない。
  // 守れるのは「配布されたあとに、第三者が一部を消す／並べ替える」ことの検出だけである。
  // 外部のタイムスタンプ機関に預ければ作成時刻まで示せるが、
  // それには外部通信が要り、このツールの「端末内で完結する」という作りを壊す。
  //
  // 先頭16文字（64ビット）だけ載せる。1行あたりの長さを抑えるためで、
  // 偶然の衝突は実用上起きないが、衝突を意図的に作る攻撃には耐えない。
  const HASH_ALGO_LABEL = 'sha-256-chain-16';
  const HASH_HEX_LEN = 16;

  // i番目の行のハッシュの材料。前の行のハッシュを混ぜることで鎖にする。
  function hashInput(prevHex, fields) {
    return String(prevHex || '') + '|' + fields.join(',');
  }

  function formatRatio(v) {
    return Number.isFinite(v) ? v.toFixed(3) : '';
  }

  // 値そのものが無い（記録していない）ときは空欄にする。
  // formatCsvDb をそのまま通すと 'undefined' という文字列がCSVに出る。
  // -Infinity は「無音を測った」という測定結果なので、こちらは残す。
  function formatOptionalDb(db) {
    if (db === undefined || db === null || Number.isNaN(db)) return '';
    return formatCsvDb(db);
  }

  // 1行ぶんのフィールド（ハッシュ列は除く）。ハッシュはこの並びから計算する。
  function csvDataFields(r) {
    return [
      r.ts.toISOString(),
      formatOptionalDb(r.rawDb),
      Number.isFinite(r.seq) ? String(r.seq) : '',
      formatOptionalDb(r.peakDb),
      Number.isFinite(r.clipCount) ? String(r.clipCount) : '',
      formatRatio(r.validRatio)
    ];
  }

  // メタ行。記録の条件をあとから読み直せるようにする。
  // これが無いと、そのCSVがどの端末のどの設定で採られたのか分からない。
  function csvMetaLines(meta) {
    const m = meta || {};
    const out = [];
    const put = (k, v) => {
      if (v === null || v === undefined || v === '') return;
      // 改行は値に入れない（1行1項目を壊さないため）
      out.push(`# ${k}=${String(v).replace(/[\r\n]+/g, ' ')}`);
    };
    put('format', 'mic-gain-logger/2');
    put('engine', m.engine);
    put('started', m.started);
    put('sampleRate', m.sampleRate);
    put('intervalSec', m.intervalSec);
    put('device', m.device);
    put('processing', m.processing);
    put('weighting', 'Z');   // 周波数重み付けは入れていない（A特性は次の弾）
    if (m.hashAlgo) put('hash', m.hashAlgo);
    return out;
  }

  // AudioContext の中断（時刻の跳び）をメタ行へ出す。
  //
  // ⚠ 列は増やさない。clockStatus / clockBreakKind / clockJumpMs はレコードには
  // 載っているが、CSV の列は段階4で 7列に確定させた。列を足すと README・テスト・
  // Excel の手順まで波が及ぶので、回数と位置だけをメタ行で示す。
  //
  // これが無いあいだ、画面は「該当区間に印を付けた」と言うのに CSV には何も出ていなかった。
  // clockBreakAt は印が付いた区間の seq で、その行の直前でアンカーを取り直している。
  function clockMetaLines(logs) {
    const marked = (logs || []).filter(r => r && r.clockStatus === CLOCK_RESYNC);
    if (!marked.length) return [];   // 中断が0回なら行そのものを出さない
    const drift = marked.reduce(
      (a, r) => a + (Number.isFinite(r.clockJumpMs) ? r.clockJumpMs : 0), 0
    );
    return [
      `# clockBreaks=${marked.length}`,
      `# clockBreakAt=${marked.map(r => (Number.isFinite(r.seq) ? r.seq : '')).join(',')}`,
      `# clockDriftMs=${Math.round(drift)}`
    ];
  }

  // ⚠ 書き出すのは rawDb（生値）である。
  // 改修前は表示下限でクリップした値を記録していたため、記録中に表示の設定を
  // 変えるとログデータ自体が変質していた。表示下限は表示のための設定なので、
  // 記録には触らせない（db は表示用、rawDb は記録用と役割を分ける）。
  //
  // opts.hashes は csvDataFields と同じ並びの配列（省略可）。
  function buildCsv(logs, opts) {
    const o = opts || {};
    const meta = Object.assign({}, o.meta);
    if (o.engine && !meta.engine) meta.engine = o.engine;
    if (o.hashes) meta.hashAlgo = o.hashAlgo || HASH_ALGO_LABEL;

    const metaLines = csvMetaLines(meta);
    if (logs.some(r => r.rawDb === -Infinity)) {
      // 無音は -Infinity で残す。行を落とすと「活動がなかった」証拠にならない
      metaLines.push('# silence=-Infinity');
    }
    // 中断の印。0回なら1行も足さない
    for (const line of clockMetaLines(logs)) metaLines.push(line);
    const prefix = metaLines.length ? metaLines.join('\n') + '\n' : '';
    const header = CSV_COLUMNS.join(',') + '\n';
    const lines = logs.map((r, i) => {
      const fields = csvDataFields(r);
      fields.push(o.hashes ? (o.hashes[i] || '') : '');
      return fields.join(',');
    }).join('\n');
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
    FLOOR_DB_MIN,
    FLOOR_DB_MAX,
    parseIntervalSec,
    dbToPower,
    powerToDb,
    createStats,
    addStatsSample,
    statsLeq,
    formatDbCell,
    formatStats,
    emptyStatsText,
    canvasPixelSize,
    GRAPH_WINDOW_SEC,
    GRAPH_TOP_DB,
    graphArea,
    timeToX,
    dbToY,
    timeTickStepSec,
    timeTicks,
    dbTickStep,
    dbTicks,
    pruneSeries,
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
    PROCESSING_KEYS,
    PROCESSING_OPTIONAL_KEYS,
    PROCESSING_OFF,
    PROCESSING_ACTIVE,
    PROCESSING_UNKNOWN,
    buildSessionMeta,
    processingVerdict,
    CONNECT_HINT_MS,
    CONNECT_TIMEOUT_MS,
    createAttemptGate,
    raceWithTimeout,
    TRACK_LIVE,
    TRACK_ENDED,
    DEVICE_LOST_ENDED,
    DEVICE_LOST_GONE,
    readTrackState,
    isTrackLost,
    markDeviceLoss,
    buildIntervalRecord,
    buildFallbackRecord,
    formatCsvDb,
    buildCsv,
    CSV_COLUMNS,
    formatOptionalDb,
    csvDataFields,
    csvMetaLines,
    clockMetaLines,
    csvSeed,
    hashInput,
    HASH_ALGO_LABEL,
    HASH_HEX_LEN,
    csvFileName
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = MicGainLogic;
}
