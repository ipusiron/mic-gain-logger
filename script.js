// Day041 - Mic Gain Logger v2.0
// 録音せずに音量（dBFS）をリアルタイム表示＆CSVログ出力
// 最終更新: マイク再接続問題の修正版

(() => {
  // 純粋ロジックは logic.js（DOM非依存）から取る
  const {
    clamp, dbToPercent, formatHMS, rmsToDbfs, rmsOf,
    parseFloorDb, parseIntervalSec, canvasPixelSize,
    GRAPH_WINDOW_SEC, GRAPH_TOP_DB, graphArea, timeToX, dbToY,
    timeTickStepSec, timeTicks, dbTickStep, dbTicks, pruneSeries, seriesPointOf,
    createStats, addStatsRecord, formatStats, statsWarnings, emptyStatsText,
    ENGINE_WORKLET, ENGINE_FALLBACK, framesForInterval,
    CLOCK_BREAK_SUSPEND, CLOCK_BREAK_STALL,
    createClockAnchor, detectClockJump, reanchorClock,
    CONNECT_HINT_MS, CONNECT_TIMEOUT_MS, createAttemptGate, raceWithTimeout,
    PROCESSING_ACTIVE, buildSessionMeta, processingVerdict,
    DEVICE_LOST_ENDED, DEVICE_LOST_GONE,
    readTrackState, isTrackLost, markDeviceLoss,
    buildIntervalRecord, buildFallbackRecord,
    buildCsv, csvFileName,
    csvTrailerLines, createHashChain, HASH_ALGO_LABEL
  } = MicGainLogic; // logic.js（classic script のグローバル束縛）

  // UI要素取得
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const exportBtn = document.getElementById('exportBtn');
  const resetBtn = document.getElementById('resetBtn');
  const themeToggle = document.getElementById('themeToggle');
  const helpBtn = document.getElementById('helpBtn');
  const helpModal = document.getElementById('helpModal');

  const bigValue = document.getElementById('bigValue');
  const meterBar = document.getElementById('meterBar');
  const statusEl = document.getElementById('status');

  const avgEl = document.getElementById('avgDb');
  const maxEl = document.getElementById('maxDb');
  const minEl = document.getElementById('minDb');
  const rangeEl = document.getElementById('rangeDb');
  const peakEl = document.getElementById('peakDb');
  const countEl = document.getElementById('count');
  const uptimeEl = document.getElementById('uptime');

  const logIntervalInput = document.getElementById('logInterval');
  const floorDbInput = document.getElementById('floorDb');

  const engineModeEl = document.getElementById('engineMode');
  const recordNoticeEl = document.getElementById('recordNotice');

  const canvas = document.getElementById('levelCanvas');
  const ctx = canvas.getContext('2d');

  // 状態
  let audioCtx = null;
  let analyser = null;
  let sourceNode = null;
  let mediaStream = null;

  // 計測エンジン（記録側）。rAF は描画専用に降格し、記録はここが担う
  let workletNode = null;
  let silentGain = null;
  let engineMode = null;      // null=未開始 / ENGINE_WORKLET / ENGINE_FALLBACK

  // CSV の seq は「1つのファイルの中での通し番号」である。
  // ⚠ 高精度モードの seq はワークレット側のカウンターで、記録開始のたびに
  //    新しい AudioWorkletNode を作るので 0 から振り直される。ログは累積するので、
  //    そのまま載せると1つのCSVの中で seq が 0 に戻る（実測で戻った）。
  //    セッションごとに起点をずらして足す。区間を捨てたときの欠番は残す。
  let seqCounter = 0;         // 簡易モードのセッション内カウンター
  let seqBase = 0;            // このセッションの起点
  let seqMax = -1;            // ログに入っている最大の seq（次の起点の元）
  let lastIntervalSec = null;

  // 記録に使ったログ間隔。
  // ⚠ 改修前は書き出し時に currentIntervalSec() を読んでいたので、
  //    1秒で採った行を 3s へ切り替えてから書き出すと「# intervalSec=3」と嘘が出た。
  //    メタ行は「その行がどういう条件で採られたか」を残す場所なので、
  //    画面の現在値ではなく、行を採ったときの値を持ち回る。
  //    ログ間隔は記録中でも変えられ、ログはセッションをまたいで累積するため、
  //    1つのCSVに複数の間隔が混ざりうる。processing=agc+ns と同じ書き方で全部並べる。
  //    ⚠ これは記録中に増える値なので、鎖の起点（ヘッダー）ではなくトレーラーへ出す。
  let usedIntervals = [];

  // ---- ハッシュチェーン ----
  //
  // ⚠⚠ 鎖は記録中に進める。1区間につき1回だけ計算して、その値を行に貼る。
  //    書き出しのたびに全行を計算し直していたころは、起点（メタ行）が
  //    「記録が終わってから分かる事実」を含んでいたため、同じセッションを
  //    2回書き出すと同じ行のハッシュが変わっていた（無音の行が1行増えるだけで
  //    1行目のハッシュまで変わった）。受け取った側には改変されたように見える。
  //    記録中に計算しておけば、書き出しは組み立てるだけになる。
  //
  //    鎖の進め方そのものは logic.js の createHashChain にある（テストから回せる
  //    ようにするため）。ここが渡すのは crypto を使う digest だけで、
  //    決めるのは「いつ始めるか・いつ伸ばすか」だけである。
  // ⚠ 作った本人はチェーンごと作り直せる。防げるのは第三者による後からの改変だけ。
  const hashChain = createHashChain(sha256Hex);

  // 時刻のアンカーと、中断の検出
  // clockAnchor = { epoch, audioTime, wallMs } オーディオクロック→壁時計の対応づけ
  // clockProbe  = { audioTime, wallMs } 直前に点検した時刻の組（差分でずれを見る）
  let clockAnchor = null;
  let clockProbe = null;
  let pendingClockBreak = null;  // 次に確定する区間へ付ける印
  let clockBreaks = [];          // このセッションで検出した中断の一覧
  let clockWatchId = null;       // 壁時計側の監視タイマー
  let ctxSuspendedSince = 0;     // suspended を観測した時刻（0＝観測していない）
  const CLOCK_WATCH_MS = 1000;

  // マイクの取得の試行（取り消し・時間切れに備える）
  const attemptGate = createAttemptGate();
  let connecting = false;
  let connectHintId = null;

  // 測定条件（1セッションに1つ。レコードは参照だけを持つ）
  let sessionMeta = null;
  let sessionCounter = 0;
  const AUDIO_CONSTRAINTS = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false
  };

  // マイクのデバイス喪失
  let deviceLoss = null;         // { reason, atWallMs, lastSeq, rowsKept }
  let deviceMuted = false;       // 供給元で無音化されている（通話の割り込みなど）
  let watchedTrack = null;

  let rafId = null;
  let running = false;
  let lastStopTime = 0;

  let WIDTH = canvas.width;
  let HEIGHT = canvas.height;
  // グラフの点。{ tMs: 壁時計ミリ秒, db: dBFS の生値 }
  // ⚠ 0..1 へ正規化して持たない。記録中に表示下限を変えたとき、
  //    過去の点だけ古い正規化のまま残ってしまう
  let series = [];
  
  // キャンバスの内部解像度だけを合わせる。
  // 表示上の大きさ（width:100% / height）は style.css が決める。
  //
  // 改修前はここに3つの不具合が同居していた。
  //  (1) rect.width が非整数のとき `new Array(WIDTH)` が RangeError を投げ、
  //      呼び出し元の drawSeries() と handleMobileButtonLayout() まで止まった
  //  (2) canvas.style.width/height へ px を焼き込み、CSS のレスポンシブ規則を
  //      インラインスタイルで無効化していた（狭めたあと二度と広がらない）
  //  (3) (2) の結果、481〜915px でキャンバスが 800px のまま横へはみ出した
  // 同じ関数の中の話なので、3つまとめて1つの修正として直す。
  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const size = canvasPixelSize(rect.width, rect.height, window.devicePixelRatio);

    canvas.width = size.pixelW;
    canvas.height = size.pixelH;
    // canvas.width への代入で変換行列は単位行列へ戻る。dpr 倍を入れ直す
    // （ctx.scale の積み重ねだと呼ぶたびに倍率が累乗になる）
    ctx.setTransform(size.pixelW / size.cssW, 0, 0, size.pixelH / size.cssH, 0, 0);

    WIDTH = size.cssW;
    HEIGHT = size.cssH;
    // series は時刻で持つので、幅が変わっても詰め替えは要らない
  }

  // コンテナ幅の変化を拾う。window の resize だけでは、設定の開閉や
  // レイアウトの組み替えで起きるカード幅の変化を取りこぼす
  function observeCanvasSize() {
    if (typeof ResizeObserver !== 'function') return;
    // canvas.width を変えても CSS 上の大きさは変わらないので、観測は循環しない
    new ResizeObserver(() => {
      resizeCanvas();
      drawSeries();
    }).observe(canvas);
  }
  let lastLogTime = 0;
  let startedAt = 0;

  // 統計
  let stats = createStats();
  // 統計から出ている注意書きの件数。増減したときだけ注意書きを組み直す
  // （1区間ごとに組み直すと、変わっていない文字列を毎秒作ることになる）
  let statsNoticeCount = 0;

  // ログ（CSV用）
  const logs = []; // { ts: Date, db: number }

  // 設定
  function getFloorDb() {
    return parseFloorDb(floorDbInput.value);
  }

  // 音量計算
  const buffer = new Float32Array(2048);
  function computeDb() {
    analyser.getFloatTimeDomainData(buffer);
    return rmsToDbfs(rmsOf(buffer));
  }

  // キャンバスの色はテーマ変数から取る。
  // ベタ書きだとライトで完全に見えなくなる（グリッドは白地に白で 1.00:1 だった）
  function graphColors() {
    const s = getComputedStyle(document.body);
    const pick = (name, fallback) => (s.getPropertyValue(name) || '').trim() || fallback;
    return {
      bg: pick('--card', '#141820'),
      grid: pick('--grid', 'rgba(128,128,128,.28)'),
      axis: pick('--muted', '#8b95a7'),
      plot: pick('--plot', '#4da3ff')
    };
  }

  // キャンバス描画。横軸は実時間（右端が「いま」）、縦軸は dBFS。
  function drawSeries() {
    const col = graphColors();
    const nowMs = Date.now();
    const floorDb = getFloorDb();
    const area = graphArea(WIDTH, HEIGHT);
    const windowMs = GRAPH_WINDOW_SEC * 1000;

    // 背景
    ctx.fillStyle = col.bg;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    const fontPx = WIDTH < 360 ? 9 : 10;
    ctx.font = `${fontPx}px ui-sans-serif, system-ui, sans-serif`;
    ctx.lineWidth = 1;

    // 縦のグリッドと時間ラベル
    const tStep = timeTickStepSec(GRAPH_WINDOW_SEC);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const tick of timeTicks(GRAPH_WINDOW_SEC, tStep)) {
      const x = Math.round(timeToX(nowMs - tick.agoSec * 1000, nowMs, windowMs, area)) + 0.5;
      ctx.strokeStyle = col.grid;
      ctx.beginPath();
      ctx.moveTo(x, area.y);
      ctx.lineTo(x, area.y + area.h);
      ctx.stroke();
      ctx.fillStyle = col.axis;
      ctx.fillText(tick.label, x, area.y + area.h + 3);
    }

    // 横のグリッドと dB ラベル
    const dStep = dbTickStep(GRAPH_TOP_DB - floorDb);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const tick of dbTicks(floorDb, GRAPH_TOP_DB, dStep)) {
      const y = Math.round(dbToY(tick.db, floorDb, GRAPH_TOP_DB, area)) + 0.5;
      ctx.strokeStyle = col.grid;
      ctx.beginPath();
      ctx.moveTo(area.x, y);
      ctx.lineTo(area.x + area.w, y);
      ctx.stroke();
      ctx.fillStyle = col.axis;
      ctx.fillText(tick.label, area.x - 4, y);
    }

    // 縦軸の単位。左の余白が狭い画面（390px など）では dB の目盛りラベルと
    // 重なるので、収まるときだけ描く（単位は canvas の title にも書いてある）
    const unit = 'dBFS';
    if (ctx.measureText(unit).width + 2 <= area.x - 14) {
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillStyle = col.axis;
      ctx.fillText(unit, 1, area.y - 1);
    }

    // 折れ線。x は実時刻、y は dB 値（正規化して持たない）
    if (series.length) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(area.x, area.y, area.w, area.h);
      ctx.clip();
      ctx.lineWidth = 2;
      ctx.strokeStyle = col.plot;
      ctx.beginPath();
      for (let i = 0; i < series.length; i++) {
        const p = series[i];
        const x = timeToX(p.tMs, nowMs, windowMs, area);
        const y = dbToY(p.db, floorDb, GRAPH_TOP_DB, area);
        // gap が立っている点は前とつなげない。測っていない時間を線で埋めないため
        if (i === 0 || p.gap) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
    }

    // 枠
    ctx.strokeStyle = col.grid;
    ctx.lineWidth = 1;
    ctx.strokeRect(area.x + 0.5, area.y + 0.5, area.w - 1, area.h - 1);
  }

  function renderStats(text) {
    avgEl.textContent = text.avg;
    maxEl.textContent = text.max;
    minEl.textContent = text.min;
    rangeEl.textContent = text.range;
    peakEl.textContent = text.peak;
    countEl.textContent = text.count;
  }

  // ⚠ 統計を進めるのはここだけである（母集団を CSV の行にそろえる）。
  //   区間レコードをそのまま渡す。重み（区間長）とピーク・クリップ・
  //   有効サンプル率は logic.js 側の addStatsRecord が拾う
  function updateStats(rec) {
    addStatsRecord(stats, rec);
    // 件数は、取り込めなかった行があっても logs に合わせる
    renderStats(formatStats(stats, logs.length));
    // クリップ・欠測が出たら、その区間で注意書きへ反映する
    const n = statsWarnings(stats).length;
    if (n !== statsNoticeCount) {
      statsNoticeCount = n;
      renderRecordNotice();
    }
  }

  function resetStats() {
    stats = createStats();
    statsNoticeCount = 0;
    renderStats(emptyStatsText());
    // 稼働時間だけ残ると「何をリセットしたのか」が読めない
    uptimeEl.textContent = '00:00:00';
    // クリップ・欠測の注意書きも一緒に消す（統計と同じ母集団から出ているため）
    renderRecordNotice();
  }

  function setStatus(text, kind='ok') {
    statusEl.className = `status ${kind}`;
    statusEl.textContent = text;
  }

  // 計測エンジンの表示（どちらのモードで動いているかを画面に残す）
  function renderEngineMode() {
    if (engineMode === ENGINE_WORKLET) {
      engineModeEl.className = 'engine-mode ok';
      engineModeEl.textContent = '計測エンジン：高精度モード（AudioWorklet・オーディオクロック基準）';
    } else if (engineMode === ENGINE_FALLBACK) {
      engineModeEl.className = 'engine-mode warn';
      engineModeEl.textContent = '計測エンジン：簡易モード（欠測の可能性あり）';
    } else {
      engineModeEl.className = 'engine-mode';
      engineModeEl.textContent = '';
    }
  }

  // 記録に関わる注意書き（デバイス喪失・時刻の跳び）を画面へ出す
  function deviceLossLabel(reason) {
    if (reason === DEVICE_LOST_GONE) return '音声トラックが無くなりました';
    return 'マイクが切断されました';
  }

  function renderRecordNotice() {
    if (!recordNoticeEl) return;
    const parts = [];
    if (deviceLoss) {
      parts.push(
        `${deviceLossLabel(deviceLoss.reason)}。${deviceLoss.rowsKept}行目までを記録し、`
        + 'そのあとは記録していません（ここまでのログは書き出せます）'
      );
    } else if (deviceMuted) {
      parts.push('マイクが供給元で無音化されています（通話の割り込みなど）。'
        + 'この間の記録はデジタル無音になります');
    }
    if (sessionMeta && processingVerdict(sessionMeta) === PROCESSING_ACTIVE) {
      parts.push(
        `マイク側の音の加工が有効です（${sessionMeta.processingActive.join(', ')}）。`
        + '利得が自動で動くため、この記録の dBFS は絶対値として扱えません'
      );
    }
    if (clockBreaks.length) {
      const totalSec = clockBreaks.reduce((a, b) => a + b.jumpMs, 0) / 1000;
      parts.push(
        `時刻の跳びを${clockBreaks.length}回検出（累計 ${totalSec.toFixed(2)} 秒）。`
        + '以降の時刻は取り直したアンカーで出し、'
        + '該当区間はCSVのメタ行（# clockBreaks / # clockBreakAt / # clockDriftMs）に残ります'
      );
    }
    // クリップと欠測。ボタンを増やさず、記録の信用に関わる事実をここへ集める
    for (const w of statsWarnings(stats)) parts.push(w);
    const kind = deviceLoss ? ' err' : (parts.length ? ' warn' : '');
    recordNoticeEl.className = 'record-notice' + kind;
    recordNoticeEl.textContent = parts.join(' / ');
  }

  // ---- 測定条件の取得 ----
  //
  // AGC が効いていると入力の利得が勝手に動くので、dBFS の値そのものが
  // 測定値として信用できない。要求した制約ではなく getSettings() の実値を残す。
  function captureSessionMeta() {
    const track = watchedTrack
      || (mediaStream ? mediaStream.getAudioTracks()[0] : null)
      || null;
    let settings = {};
    if (track && typeof track.getSettings === 'function') {
      try { settings = track.getSettings() || {}; } catch { settings = {}; }
    }
    let timeZone = null;
    try {
      timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
    } catch { timeZone = null; }
    sessionCounter += 1;
    return buildSessionMeta({
      id: `s${sessionCounter}`,
      startedWallMs: Date.now(),
      engine: engineMode,
      contextSampleRate: audioCtx ? audioCtx.sampleRate : null,
      deviceLabel: track ? (track.label || null) : null,
      requested: AUDIO_CONSTRAINTS,
      settings,
      userAgent: navigator.userAgent || null,
      timeZone
    });
  }

  // ---- マイクのデバイス喪失 ----
  //
  // 有効サンプル率では検出できない。トラックを stop しても
  // MediaStreamAudioSourceNode はデジタル無音を流し続けるので、
  // validRatio は 1.0、sampleCount も期待どおりのままで、dBFS だけが
  // -Infinity になる。区別できるのは MediaStreamTrack の状態だけである。
  function handleDeviceLost(reason) {
    if (!running || deviceLoss) return;
    deviceLoss = markDeviceLoss(logs, { reason, atWallMs: Date.now() });
    stop();
    setStatus('マイクが切断されました。記録を停止しました', 'err');
    renderRecordNotice();
  }

  function detachTrackWatch() {
    if (!watchedTrack) return;
    try { watchedTrack.removeEventListener('ended', onTrackEnded); } catch {}
    try { watchedTrack.removeEventListener('mute', onTrackMute); } catch {}
    try { watchedTrack.removeEventListener('unmute', onTrackUnmute); } catch {}
    watchedTrack = null;
  }

  function onTrackEnded() { handleDeviceLost(DEVICE_LOST_ENDED); }

  function onTrackMute() {
    deviceMuted = true;
    renderRecordNotice();
  }

  function onTrackUnmute() {
    deviceMuted = false;
    renderRecordNotice();
  }

  function attachTrackWatch(stream) {
    detachTrackWatch();
    const tracks = stream ? stream.getAudioTracks() : [];
    if (!tracks.length) return;
    watchedTrack = tracks[0];
    deviceMuted = readTrackState(watchedTrack).muted === true;
    watchedTrack.addEventListener('ended', onTrackEnded);
    watchedTrack.addEventListener('mute', onTrackMute);
    watchedTrack.addEventListener('unmute', onTrackUnmute);
  }

  // ended が来ない環境の取りこぼしを readyState で拾う
  function checkTrackHealth() {
    if (!running || deviceLoss) return;
    const tracks = mediaStream ? mediaStream.getAudioTracks() : [];
    if (!tracks.length) { handleDeviceLost(DEVICE_LOST_GONE); return; }
    if (isTrackLost(readTrackState(tracks[0]))) handleDeviceLost(DEVICE_LOST_ENDED);
  }

  // ---- 時刻の中断の検出 ----
  //
  // 壁時計とオーディオクロックのずれを点検し、閾値を超えていたらアンカーを取り直す。
  // 取り直したことは次に確定する区間へ印として渡り、画面にも出す。
  // kind は、AudioContext の状態変化として観測できた中断か（suspend）、
  // 状態変化なしにオーディオクロックが遅れたか（stall）の区別である。
  function probeClock(kind) {
    if (!audioCtx || !clockAnchor || !clockProbe) return null;
    const audioTime = audioCtx.currentTime;
    const wallMs = Date.now();
    const jump = detectClockJump(clockProbe, audioTime, wallMs);
    clockProbe = { audioTime, wallMs };
    if (!jump) return null;

    clockAnchor = reanchorClock(clockAnchor, audioTime, wallMs);
    const brk = {
      kind: kind || CLOCK_BREAK_STALL,
      jumpMs: jump.jumpMs,
      atWallMs: wallMs,
      epoch: clockAnchor.epoch
    };
    clockBreaks.push(brk);
    // 印は次の1区間が受け取る。確定前に2回検出したら足し合わせる
    pendingClockBreak = pendingClockBreak
      ? { kind: pendingClockBreak.kind, jumpMs: pendingClockBreak.jumpMs + brk.jumpMs }
      : { kind: brk.kind, jumpMs: brk.jumpMs };
    renderRecordNotice();
    return brk;
  }

  function takeClockBreak() {
    const brk = pendingClockBreak;
    pendingClockBreak = null;
    return brk;
  }

  // AudioContext の状態変化。画面のロック・タブの休止でここを通る
  function handleContextStateChange() {
    if (!audioCtx) return;
    if (audioCtx.state === 'suspended') {
      if (!ctxSuspendedSince) ctxSuspendedSince = Date.now();
      if (running) setStatus('計測が中断しています（画面のロックなど）', 'warn');
    } else if (audioCtx.state === 'running') {
      if (ctxSuspendedSince) {
        ctxSuspendedSince = 0;
        probeClock(CLOCK_BREAK_SUSPEND);
        if (running) setStatus('計測中（中断から復帰しました）', 'warn');
      }
    }
  }

  // 壁時計側の監視。statechange が来ない停止も拾う。
  // 中断しているあいだは点検を止め（probe を凍結し）、復帰時に1回でまとめて拾う
  function clockWatchTick() {
    if (!running || !audioCtx) return;
    checkTrackHealth();
    if (!running) return;
    if (audioCtx.state === 'suspended') {
      if (!ctxSuspendedSince) ctxSuspendedSince = Date.now();
      audioCtx.resume().catch(() => {});
      return;
    }
    if (audioCtx.state !== 'running') return;
    if (ctxSuspendedSince) {
      ctxSuspendedSince = 0;
      probeClock(CLOCK_BREAK_SUSPEND);
      return;
    }
    probeClock(CLOCK_BREAK_STALL);
  }

  function startClockWatch() {
    stopClockWatch();
    clockWatchId = setInterval(clockWatchTick, CLOCK_WATCH_MS);
  }

  function stopClockWatch() {
    if (clockWatchId !== null) {
      clearInterval(clockWatchId);
      clockWatchId = null;
    }
  }

  function currentIntervalSec() {
    return parseIntervalSec(logIntervalInput.value);
  }

  // 1行＝1区間。ここだけがログを増やす。
  // 統計もここだけで進める（母集団を CSV の行にそろえる）
  function pushRecord(rec) {
    const wasEmpty = logs.length === 0;
    // 鎖の起点は1行目で凍結する。2回目以降の書き出しでも同じ値になる
    if (wasEmpty) hashChain.begin(chainMetaOf(rec));
    logs.push(rec);
    // ハッシュは1区間につき1回だけ計算する（書き出し時に全行を計算し直さない）
    hashChain.extend(rec);
    // 次のセッションの起点。捨てた区間の欠番はそのまま残す
    if (Number.isFinite(rec.seq) && rec.seq > seqMax) seqMax = rec.seq;
    // 行を採ったときのログ間隔を控える（書き出し時点の設定では嘘になる）
    if (Number.isFinite(lastIntervalSec) && !usedIntervals.includes(lastIntervalSec)) {
      usedIntervals.push(lastIntervalSec);
    }
    // グラフの点も、ここで積む（記録と同じ源にする）。
    // rAF で積むと、タブが裏に回ったあいだの点が抜けて直線で補間されてしまう
    const intervalMs = Number.isFinite(lastIntervalSec) ? lastIntervalSec * 1000 : null;
    series.push(seriesPointOf(rec, series[series.length - 1] || null, intervalMs));
    series = pruneSeries(series, Date.now(), GRAPH_WINDOW_SEC * 1000);

    if (wasEmpty) updateButtonStates();
    // ⚠ 統計に入れるのは rawDb（記録される生値）である。
    //    表示用の db を使うと、表示下限を変えただけで統計が動いてしまう
    //    （addStatsRecord が rawDb を読む）
    updateStats(rec);
    // 件数は行が増えたら必ず出す。無音だけの区間が続いても 0 のままにしない
    countEl.textContent = String(logs.length);
  }

  // ワークレットからの1区間
  function handleIntervalMessage(msg) {
    if (!running || !clockAnchor) return;
    const rec = buildIntervalRecord(msg, clockAnchor, getFloorDb(), {
      clockBreak: pendingClockBreak,
      seqBase,
      meta: sessionMeta
    });
    // デジタル無音（-Infinity）は「音がなかった」という記録なので残す。
    // 捨てるのは数値にならなかったものだけ
    if (Number.isNaN(rec.rawDb)) return;
    // 印は行が確定してから外す（捨てた行で印を失わない）
    pendingClockBreak = null;
    pushRecord(rec);
  }

  // 簡易モードの1区間（現行の rAF 経路のまま。瞬時値しか取れない）
  function recordFallbackInterval(db, floorDb, nowSec) {
    if (nowSec - lastLogTime < lastIntervalSec) return;
    // 捨てる場合はログ枠を消費しない（lastLogTime を進めない）。
    // 改修前は更新がガードの外にあり、捨てたサンプルでも枠が消えていた
    if (Number.isNaN(db)) return;
    const startSec = lastLogTime;
    lastLogTime = nowSec;
    const nowMs = Date.now();
    const sr = audioCtx ? audioCtx.sampleRate : 48000;
    pushRecord(buildFallbackRecord({
      seq: seqBase + seqCounter++,
      db,
      floorDb,
      startTime: startSec,
      endTime: nowSec,
      startWallMs: nowMs - (nowSec - startSec) * 1000,
      endWallMs: nowMs,
      expectedSamples: Math.round(lastIntervalSec * sr),
      clockEpoch: clockAnchor ? clockAnchor.epoch : 0,
      clockBreak: takeClockBreak(),
      meta: sessionMeta
    }));
  }

  // ログ間隔の変更をワークレットへ伝える（記録中でも変えられる既存の仕様を保つ）
  function syncInterval() {
    const sec = currentIntervalSec();
    if (sec === lastIntervalSec) return;
    lastIntervalSec = sec;
    if (workletNode && audioCtx) {
      workletNode.port.postMessage({
        type: 'config',
        intervalFrames: framesForInterval(sec, audioCtx.sampleRate)
      });
    }
  }

  // 計測エンジンの組み立て。使えなければ false を返して簡易モードへ落ちる
  async function setupWorklet() {
    if (!audioCtx.audioWorklet || typeof audioCtx.audioWorklet.addModule !== 'function') {
      return false;
    }
    if (typeof AudioWorkletNode !== 'function') return false;

    await audioCtx.audioWorklet.addModule('./worklet/meter-processor.js');
    workletNode = new AudioWorkletNode(audioCtx, 'meter-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: {
        intervalFrames: framesForInterval(currentIntervalSec(), audioCtx.sampleRate)
      }
    });
    workletNode.port.onmessage = (event) => {
      const msg = event.data;
      if (msg && msg.type === 'interval') handleIntervalMessage(msg);
    };

    // 出力は無音だが、destination まで繋いでおかないと
    // レンダリンググラフから外れて process() が呼ばれなくなる
    silentGain = audioCtx.createGain();
    silentGain.gain.value = 0;
    sourceNode.connect(workletNode);
    workletNode.connect(silentGain);
    silentGain.connect(audioCtx.destination);
    return true;
  }

  // 遅れて届いたストリームを捨てる（取り消し・時間切れのあと）
  function discardStream(promise) {
    Promise.resolve(promise)
      .then(stream => { if (stream) stream.getTracks().forEach(t => t.stop()); })
      .catch(() => {});
  }

  function clearConnectHint() {
    if (connectHintId !== null) {
      clearTimeout(connectHintId);
      connectHintId = null;
    }
  }

  // 接続の試みを終える（成功・取り消し・時間切れのいずれでも通る）
  function finishConnecting() {
    connecting = false;
    clearConnectHint();
  }

  // 取得の取り消し。UI を待機状態へ戻す
  function cancelConnect(message, kind) {
    attemptGate.cancel();
    finishConnecting();
    startBtn.disabled = false;
    stopBtn.disabled = true;
    updateButtonStates();
    setStatus(message, kind || 'warn');
  }

  async function start() {
    if (running || connecting) return;

    // この試行の世代番号。取り消されたら以降の処理をすべて捨てる
    const token = attemptGate.begin();
    connecting = true;
    startBtn.disabled = true;
    stopBtn.disabled = false;   // 接続中も「停止」で取り消せる
    setStatus('マイクに接続中…', 'warn');

    // 前回のクリーンアップが完了していることを確認
    if (audioCtx || mediaStream) {
      await cleanup();
      // クリーンアップ後に少し待つ
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    if (!attemptGate.isCurrent(token)) return;

    // 停止直後の場合、警告を表示
    const timeSinceStop = Date.now() - lastStopTime;
    if (lastStopTime > 0 && timeSinceStop < 2000) {
      setStatus('マイク接続の準備中...少しお待ちください', 'warn');
      // 少し待ってから再試行
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!attemptGate.isCurrent(token)) return;

    try {
      setStatus('マイクに接続中…', 'warn');

      // 許可ダイアログを放置されたときの案内。これが無いと
      // 「マイクに接続中…」のまま何が起きているのか分からない
      clearConnectHint();
      connectHintId = setTimeout(() => {
        if (attemptGate.isCurrent(token)) {
          setStatus('マイクの許可ダイアログに応答してください（「停止」で取り消せます）', 'warn');
        }
      }, CONNECT_HINT_MS);

      // 新しいメディアストリームを取得（時間切れを設ける）
      const attempt = navigator.mediaDevices.getUserMedia({
        audio: Object.assign({}, AUDIO_CONSTRAINTS),
        video: false
      });
      const outcome = await raceWithTimeout(attempt, CONNECT_TIMEOUT_MS);
      clearConnectHint();

      if (!attemptGate.isCurrent(token)) {
        // すでに取り消されている。遅れて届いたストリームは捨てる
        discardStream(attempt);
        return;
      }
      if (outcome.timedOut) {
        discardStream(attempt);
        cancelConnect(
          `マイクを${Math.round(CONNECT_TIMEOUT_MS / 1000)}秒以内に取得できませんでした。`
          + '許可ダイアログに応答してから、もう一度お試しください',
          'err'
        );
        return;
      }
      if (outcome.error) throw outcome.error;
      mediaStream = outcome.value;
      finishConnecting();

      // デバイス喪失の監視（記録中に切断されたら止める）
      deviceLoss = null;
      deviceMuted = false;
      attachTrackWatch(mediaStream);

      // 新しいAudioContextを作成
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;

      sourceNode = audioCtx.createMediaStreamSource(mediaStream);
      sourceNode.connect(analyser);

      // seq の起点。前のセッションの続きから振る（1つのCSVの中で0へ戻さない）
      seqBase = seqMax + 1;
      seqCounter = 0;

      // 記録はオーディオスレッドへ。使えない環境は簡易モードへ落とす
      lastIntervalSec = currentIntervalSec();
      engineMode = ENGINE_FALLBACK;
      try {
        if (await setupWorklet()) engineMode = ENGINE_WORKLET;
      } catch (workletErr) {
        console.warn('AudioWorklet を読み込めないため簡易モードで動かします', workletErr);
        workletNode = null;
      }
      // 測定条件を1セッションぶん記録する（CSV の列は増やさない）。
      // 要求した制約ではなく、track.getSettings() の実値を残すのが要点である
      sessionMeta = captureSessionMeta();

      // 時刻のアンカーと、その監視
      clockAnchor = createClockAnchor(audioCtx.currentTime, Date.now());
      clockProbe = { audioTime: clockAnchor.audioTime, wallMs: clockAnchor.wallMs };
      pendingClockBreak = null;
      clockBreaks = [];
      ctxSuspendedSince = 0;
      renderRecordNotice();
      audioCtx.addEventListener('statechange', handleContextStateChange);
      startClockWatch();

      renderEngineMode();

      startedAt = performance.now() / 1000;
      // 簡易モードの1行目を「ページを開いてから」ではなく
      // 「記録を開始してから」ログ間隔ぶん後に出す
      lastLogTime = startedAt;
      running = true;
      stopBtn.disabled = false;
      updateButtonStates(); // ボタン状態を更新（記録中はCSV書き出し無効）

      setStatus('計測中', 'ok');
      animate();
    } catch (err) {
      console.error(err);
      
      // パーミッション関連のエラーの場合、特別なメッセージを表示
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        setStatus('マイクへのアクセスが拒否されました。ブラウザーのURL欄のマイクアイコンを確認してください', 'err');
      } else if (err.name === 'NotFoundError') {
        setStatus('マイクが見つかりません。デバイスを確認してください', 'err');
      } else {
        setStatus(`エラー：${err.message || err}`, 'err');
      }
      
      running = false;
      finishConnecting();
      startBtn.disabled = false;
      stopBtn.disabled = true;
      updateButtonStates(); // エラー時にもボタン状態を更新
      await cleanup();
    }
  }

  async function stop() {
    // 接続中なら、記録の停止ではなく取得の取り消しとして扱う
    if (connecting) {
      cancelConnect('マイクの取得を取り消しました');
      return;
    }
    if (!running) return;
    running = false;
    lastStopTime = Date.now();  // 停止時刻を記録
    setStatus('停止しました', 'warn');
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    
    // 少し遅延を入れてからクリーンアップ（ブラウザーの状態更新を待つ）
    setTimeout(async () => {
      await cleanup();
    }, 100);
    
    startBtn.disabled = false;
    stopBtn.disabled = true;
    updateButtonStates(); // 停止時にボタン状態を更新
  }

  async function cleanup() {
    // 時刻の監視を止める
    stopClockWatch();
    // トラックの監視を外す（自分で stop したときの ended を喪失と読まない）
    detachTrackWatch();
    if (audioCtx) {
      try { audioCtx.removeEventListener('statechange', handleContextStateChange); } catch {}
    }

    // ストリームを最初に停止（これが最も重要）
    if (mediaStream) {
      mediaStream.getTracks().forEach(t => {
        t.stop();
      });
      mediaStream = null;
    }
    
    // 計測エンジンの切断（ワークレット→無音ゲイン）
    if (workletNode) {
      try { workletNode.port.postMessage({ type: 'stop' }); } catch {}
      try { workletNode.port.onmessage = null; } catch {}
      try { workletNode.disconnect(); } catch {}
      workletNode = null;
    }
    if (silentGain) {
      try { silentGain.disconnect(); } catch {}
      silentGain = null;
    }
    clockAnchor = null;
    clockProbe = null;
    ctxSuspendedSince = 0;

    // Audio Nodeの切断
    if (sourceNode) { 
      try { sourceNode.disconnect(); } catch {} 
      sourceNode = null; 
    }
    if (analyser) { 
      try { analyser.disconnect(); } catch {} 
      analyser = null; 
    }
    
    // AudioContextを最後にクローズ
    if (audioCtx) {
      try {
        if (audioCtx.state !== 'closed') {
          await audioCtx.close();
        }
      } catch (e) {
        console.warn('AudioContext を閉じられませんでした', e);
      }
      audioCtx = null;
    }
  }

  // rAF は描画専用。記録はワークレットのオーディオクロックが担う
  function animate() {
    if (!running) return;

    const db = computeDb(); // dBFS (負の値、0が最大)

    // 表示下限
    const floorDb = getFloorDb();
    const dispDb = Math.max(db, floorDb);

    // 大型表示
    bigValue.textContent = Number.isFinite(db) ? `${dispDb.toFixed(1)} dBFS` : '--.- dBFS';

    // メーター
    const pct = dbToPercent(dispDb, floorDb);
    meterBar.style.width = `${pct.toFixed(1)}%`;

    // カラー（しきい値：-40dBFS, -20dBFS）
    if (db >= -20) meterBar.style.filter = 'hue-rotate(0deg)';        // 赤寄り
    else if (db >= -40) meterBar.style.filter = 'hue-rotate(-25deg)'; // 黄寄り
    else meterBar.style.filter = 'hue-rotate(-60deg)';                 // 緑寄り

    // ⚠ ここでは点を積まない。
    // 点は pushRecord（記録された区間）から積む。rAF で積むと、タブが裏に回った
    // あいだの点が抜け、再開時に前後が直線で結ばれて「測っていない時間」を描くことになる。
    // 描き直しだけを続ける（横軸が実時間なので、点が増えなくても右へ流れる）
    series = pruneSeries(series, Date.now(), GRAPH_WINDOW_SEC * 1000);
    drawSeries();

    // 統計はここでは進めない。母集団を CSV の行（区間）にそろえるため、
    // pushRecord() でのみ更新する（改修前はここで毎フレーム加算していた）

    // 稼働時間
    const nowSec = performance.now() / 1000;
    uptimeEl.textContent = formatHMS(nowSec - startedAt);

    // ログ間隔の変更を計測エンジンへ伝える
    syncInterval();

    // 記録は高精度モードではワークレット側で確定する。
    // 簡易モードのときだけ、これまでどおり rAF で記録する
    if (engineMode === ENGINE_FALLBACK) {
      recordFallbackInterval(db, floorDb, nowSec);
    }

    rafId = requestAnimationFrame(animate);
  }

  // crypto.subtle は安全なコンテキスト（https または localhost）でしか使えない。
  // file:// で開いたときはハッシュを計算できないので、鎖そのものを作らない。
  function hashAvailable() {
    return !!(window.crypto && window.crypto.subtle);
  }

  // SHA-256 を16進文字列で。使えない環境では null を返す（ハッシュ列は空になる）。
  async function sha256Hex(text) {
    if (!hashAvailable()) return null;
    const buf = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // 鎖の起点になるヘッダー。
  // ⚠ 記録を始めた瞬間に確定する事実だけを入れる。
  //    ログ間隔・無音の有無・中断の回数は記録中に変わるので、ここには入れない。
  function chainMetaOf(firstRec) {
    const m = sessionMeta || {};
    const proc = Array.isArray(m.processingActive) && m.processingActive.length
      ? m.processingActive.join('+')
      : 'off';
    return {
      engine: firstRec.engine || engineMode,
      // アンカーは中断のたびに取り直すので、記録開始の時刻には使えない。
      // 1行目の区間の時刻をそのまま載せる
      started: firstRec.ts.toISOString(),
      sampleRate: m.contextSampleRate || null,
      device: m.deviceLabel || null,
      processing: proc,
      hashAlgo: hashAvailable() ? HASH_ALGO_LABEL : null
    };
  }

  // 記録が終わってから分かる事実。トレーラー行へ出す。
  // ⚠ 起点（ヘッダー）に混ぜてはいけない。混ぜると、同じセッションを2回
  //    書き出したときに同じ行のハッシュが変わる。
  function csvTrailerExtraOf() {
    return {
      // 書き出し時点の設定ではなく、行を採ったときの値。混ざっていれば全部並べる
      intervalSec: usedIntervals.length ? usedIntervals.join('+') : null
    };
  }

  async function exportCSV() {
    if (!logs.length) {
      setStatus('書き出すログがありません', 'warn');
      return;
    }
    // A列 timestamp・B列 dbfs は動かさない（READMEのExcel手順がこれを前提にしている）
    //
    // ハッシュは記録中に計算済みである。ここでは計算し直さず、待って集めるだけ。
    // 計算し直すと、起点と同じ理由で「書き出すたびに値が変わる」余地が戻る
    await hashChain.settled();

    const extra = csvTrailerExtraOf();
    const hashes = hashChain.hashes(logs);
    // トレーラーを鎖の最後の輪にする。
    // 最後の行のハッシュを材料に混ぜるので、トレーラーの書き換えも、
    // 末尾の行をまとめて削ることも検出できる
    const trailerHash = hashes
      ? await hashChain.sealTrailer(csvTrailerLines(logs, extra))
      : null;
    // 鎖が作れなかった記録では、ヘッダーで方式を名乗らない（列も空になる）
    const meta = hashes
      ? hashChain.meta
      : Object.assign({}, hashChain.meta, { hashAlgo: null });
    for (const e of hashChain.errors) console.warn('ハッシュチェーン', e);

    const csv = buildCsv(logs, {
      meta,
      hashes,
      intervalSec: extra.intervalSec,
      trailerHash
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = csvFileName(new Date());
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    setStatus(`CSVを書き出しました（${logs.length}件）`, 'ok');
  }

  function resetAllStats() {
    resetStats();
    logs.length = 0;
    seqCounter = 0;
    seqBase = 0;
    seqMax = -1;
    usedIntervals = [];
    // ログを捨てたら鎖も捨てる。次の1行目で新しい起点を凍結する
    hashChain.reset();
    updateButtonStates(); // ボタン状態を更新
    setStatus('統計とログをリセットしました', 'ok');
  }

  // ボタン状態の管理
  function updateButtonStates() {
    // CSV書き出しボタンは記録停止中かつログが存在する場合のみ有効
    exportBtn.disabled = running || logs.length === 0;
    
    // 統計リセットボタンはログが存在する場合のみ有効
    resetBtn.disabled = logs.length === 0;
  }

  // テーマ切り替え
  let isDarkMode = false;
  
  function toggleTheme() {
    isDarkMode = !isDarkMode;
    if (isDarkMode) {
      document.body.classList.remove('light');
    } else {
      document.body.classList.add('light');
    }
    localStorage.setItem('theme', isDarkMode ? 'dark' : 'light');
    drawSeries();
  }
  
  function applyTheme() {
    const savedTheme = localStorage.getItem('theme');
    isDarkMode = savedTheme === 'dark';
    if (isDarkMode) {
      document.body.classList.remove('light');
    } else {
      document.body.classList.add('light');
    }
    drawSeries();
  }

  // ログ間隔プリセットボタンの処理
  function setupIntervalPresets() {
    const presetBtns = document.querySelectorAll('.preset-btn');
    const logIntervalInput = document.getElementById('logInterval');
    
    // プリセットボタンクリック時の処理
    presetBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const interval = parseFloat(btn.dataset.interval);
        logIntervalInput.value = interval;
        updateActivePreset();
      });
    });
    
    // 入力値変更時の処理
    logIntervalInput.addEventListener('input', updateActivePreset);
    
    // アクティブなプリセットを更新
    function updateActivePreset() {
      const currentValue = parseFloat(logIntervalInput.value);
      presetBtns.forEach(btn => {
        const interval = parseFloat(btn.dataset.interval);
        if (Math.abs(currentValue - interval) < 0.01) {
          btn.classList.add('active');
        } else {
          btn.classList.remove('active');
        }
      });
    }
    
    // 初期状態を設定
    updateActivePreset();
  }

  // イベント
  startBtn.addEventListener('click', start);
  stopBtn.addEventListener('click', stop);
  exportBtn.addEventListener('click', exportCSV);
  resetBtn.addEventListener('click', resetAllStats);
  themeToggle.addEventListener('click', toggleTheme);
  window.addEventListener('beforeunload', stop);

  // 画面が戻ったら、次の監視タイマーを待たずに時刻を点検する
  // （スマートフォンのロック解除・タブの復帰がここを通る）
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') clockWatchTick();
  });

  // デバイス構成が変わったら、使っているトラックが生きているかを見る
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', checkTrackHealth);
  }
  
  // ヘルプモーダル機能
  function setupHelpModal() {
    if (!helpModal) {
      console.warn('Help modal element not found');
      return;
    }
    
    const modalClose = helpModal.querySelector('.modal-close');
    const modalBackdrop = helpModal.querySelector('.modal-backdrop');
    
    // ヘルプボタンクリック
    helpBtn.addEventListener('click', () => {
      helpModal.classList.add('show');
      helpModal.setAttribute('aria-hidden', 'false');
      // aria-modal だけでは足りない。フォーカスを中へ移さないと背後を読み続ける
      modalClose.focus();
      document.body.style.overflow = 'hidden';
    });
    
    // 閉じるボタンクリック
    modalClose.addEventListener('click', closeModal);
    
    // 背景クリック
    modalBackdrop.addEventListener('click', closeModal);
    
    // ESCキーで閉じる
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && helpModal.classList.contains('show')) {
        closeModal();
      }
    });
    
    function closeModal() {
      helpModal.classList.remove('show');
      document.body.style.overflow = '';
      
      // フォーカスをヘルプボタンに戻してからaria-hiddenを設定
      helpBtn.focus();
      
      // 少し遅延させてからaria-hiddenを設定（フォーカス移動後）
      setTimeout(() => {
        helpModal.setAttribute('aria-hidden', 'true');
      }, 10);
    }
  }

  // プリセット機能を初期化
  setupIntervalPresets();
  
  // コントロール折りたたみ機能
  function setupControlsToggle() {
    const controlsToggle = document.getElementById('controlsToggle');
    const controls = document.getElementById('controls');
    
    if (!controlsToggle || !controls) return;
    
    controlsToggle.addEventListener('click', () => {
      const isCollapsed = controls.classList.contains('collapsed');
      const toggleText = controlsToggle.querySelector('.toggle-text');
      const toggleIcon = controlsToggle.querySelector('.toggle-icon');
      
      if (isCollapsed) {
        controls.classList.remove('collapsed');
        toggleText.textContent = '設定を隠す';
        toggleIcon.textContent = '▲';
      } else {
        controls.classList.add('collapsed');
        toggleText.textContent = '設定を表示';
        toggleIcon.textContent = '▼';
      }
    });
  }
  
  // モバイル用ボタン配置機能
  function setupMobileButtonLayout() {
    handleMobileButtonLayout();
  }
  
  function handleMobileButtonLayout() {
    const helpBtn = document.getElementById('helpBtn');
    const themeToggle = document.getElementById('themeToggle');
    const mobileControls = document.getElementById('mobileControls');
    const actions = document.querySelector('.actions');
    
    if (!helpBtn || !themeToggle || !mobileControls || !actions) return;
    
    const isMobile = window.innerWidth <= 480;
    
    if (isMobile) {
      // モバイルの場合：ヘルプとテーマボタンを mobile-controls エリアに移動
      if (!mobileControls.contains(helpBtn)) {
        mobileControls.appendChild(helpBtn);
        mobileControls.appendChild(themeToggle);
      }
    } else {
      // デスクトップの場合：ヘルプとテーマボタンを actions エリアに戻す
      if (!actions.contains(helpBtn)) {
        actions.appendChild(helpBtn);
        actions.appendChild(themeToggle);
      }
    }
  }

  // ヘルプモーダル機能を初期化
  setupHelpModal();
  
  // コントロール折りたたみ機能を初期化
  setupControlsToggle();
  
  // モバイル用ボタン配置の初期化
  setupMobileButtonLayout();

  // リサイズ対応
  window.addEventListener('resize', () => {
    resizeCanvas();
    drawSeries();
    handleMobileButtonLayout();
  });

  // 初期
  renderEngineMode();
  applyTheme();
  resizeCanvas();
  observeCanvasSize();
  drawSeries();
  updateButtonStates(); // 初期状態でのボタン状態設定

  // 権限が拒否された場合のヒント
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus('このブラウザーはマイク取得に対応していません', 'err');
    startBtn.disabled = true;
  }
})();
