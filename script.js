// Day041 - Mic Gain Logger v2.0
// 録音せずに音量（dBFS）をリアルタイム表示＆CSVログ出力
// 最終更新: マイク再接続問題の修正版

(() => {
  // 純粋ロジックは logic.js（DOM非依存）から取る
  const {
    clamp, dbToPercent, formatHMS, rmsToDbfs, rmsOf,
    parseFloorDb, parseIntervalSec,
    createStats, addStatsSample, formatStats, emptyStatsText,
    ENGINE_WORKLET, ENGINE_FALLBACK, framesForInterval,
    CLOCK_BREAK_SUSPEND, CLOCK_BREAK_STALL,
    createClockAnchor, detectClockJump, reanchorClock,
    CONNECT_HINT_MS, CONNECT_TIMEOUT_MS, createAttemptGate, raceWithTimeout,
    PROCESSING_ACTIVE, buildSessionMeta, processingVerdict,
    DEVICE_LOST_ENDED, DEVICE_LOST_GONE,
    readTrackState, isTrackLost, markDeviceLoss,
    buildIntervalRecord, buildFallbackRecord,
    buildCsv, csvFileName
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
  const countEl = document.getElementById('count');
  const uptimeEl = document.getElementById('uptime');

  const logIntervalInput = document.getElementById('logInterval');
  const smoothingInput = document.getElementById('smoothing');
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
  let seqCounter = 0;
  let lastIntervalSec = null;

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
  let series = new Array(WIDTH).fill(0); // 0..1 の値（可視化用）
  
  // キャンバスサイズをレスポンシブに調整
  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    
    // 実際のピクセルサイズを設定
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    
    // CSSサイズと同期
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    
    // スケールを設定
    ctx.scale(dpr, dpr);
    
    // 論理サイズを更新（描画用）
    WIDTH = rect.width;
    HEIGHT = rect.height;
    
    // 既存のseriesをリサイズ
    if (series.length !== WIDTH) {
      const newSeries = new Array(WIDTH).fill(0);
      for (let i = 0; i < Math.min(series.length, WIDTH); i++) {
        newSeries[i] = series[i] || 0;
      }
      series = newSeries;
    }
  }
  let lastLogTime = 0;
  let startedAt = 0;

  // 統計
  let stats = createStats();

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

  // キャンバス描画
  function drawSeries() {
    // 背景
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--card') || '#141820';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    // グリッド
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (let x = 0; x < WIDTH; x += 80) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, HEIGHT);
      ctx.stroke();
    }
    for (let y = 0; y < HEIGHT; y += 40) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(WIDTH, y);
      ctx.stroke();
    }

    // ライン
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#4da3ff';
    ctx.beginPath();
    for (let x = 0; x < WIDTH; x++) {
      const v = series[x]; // 0..1
      const y = HEIGHT - (HEIGHT * v);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function renderStats(text) {
    avgEl.textContent = text.avg;
    maxEl.textContent = text.max;
    minEl.textContent = text.min;
    rangeEl.textContent = text.range;
    countEl.textContent = text.count;
  }

  function updateStats(db) {
    if (!addStatsSample(stats, db)) return;
    renderStats(formatStats(stats, logs.length));
  }

  function resetStats() {
    stats = createStats();
    renderStats(emptyStatsText());
  }

  function setStatus(text, kind='ok') {
    statusEl.className = `status ${kind}`;
    statusEl.textContent = text;
  }

  // 計測エンジンの表示（どちらのモードで動いているかを画面に残す）
  function renderEngineMode() {
    if (engineMode === ENGINE_WORKLET) {
      engineModeEl.className = 'engine-mode ok';
      engineModeEl.textContent = '計測エンジン: 高精度モード（AudioWorklet・オーディオクロック基準）';
    } else if (engineMode === ENGINE_FALLBACK) {
      engineModeEl.className = 'engine-mode warn';
      engineModeEl.textContent = '計測エンジン: 簡易モード（欠測の可能性あり）';
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
        + '該当区間に印を付け、以降の時刻は取り直したアンカーで出しています'
      );
    }
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

  // 1行＝1区間。ここだけがログを増やす
  function pushRecord(rec) {
    const wasEmpty = logs.length === 0;
    logs.push(rec);
    if (wasEmpty) updateButtonStates();
    // 件数は行が増えたら必ず出す。無音だけの区間が続いても 0 のままにしない
    countEl.textContent = String(logs.length);
  }

  // ワークレットからの1区間
  function handleIntervalMessage(msg) {
    if (!running || !clockAnchor) return;
    const rec = buildIntervalRecord(msg, clockAnchor, getFloorDb(), {
      clockBreak: pendingClockBreak,
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
      seq: seqCounter++,
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
      analyser.smoothingTimeConstant = parseFloat(smoothingInput.value) || 0.5;

      sourceNode = audioCtx.createMediaStreamSource(mediaStream);
      sourceNode.connect(analyser);

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
        setStatus(`エラー: ${err.message || err}`, 'err');
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
        console.log('AudioContext close error:', e);
      }
      audioCtx = null;
    }
  }

  // rAF は描画専用。記録はワークレットのオーディオクロックが担う
  function animate() {
    if (!running) return;

    // スムージング更新（動的反映）
    // ⚠ smoothingTimeConstant は周波数領域にしか作用せず、時間領域のRMSには効かない。
    //    廃止するか時間重みへ置き換えるかは段階2以降の判断なので、ここでは触らない
    if (analyser) {
      const s = parseFloat(smoothingInput.value);
      if (!Number.isNaN(s)) analyser.smoothingTimeConstant = s;
    }

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

    // 可視化シリーズ更新（右端に追加して左へ流す）
    series.shift();
    series.push(clamp(pct/100, 0, 1));
    drawSeries();

    // 統計（母集団を区間へそろえるのは段階3）
    updateStats(db);

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

  function exportCSV() {
    if (!logs.length) {
      setStatus('書き出すログがありません', 'warn');
      return;
    }
    // 列は増やさない（timestamp,dbfs のまま）。どちらのモードで取った記録かだけ残す
    const engines = Array.from(new Set(logs.map(r => r.engine).filter(Boolean)));
    const engine = engines.length === 1 ? engines[0] : (engines.length ? 'mixed' : engineMode);
    const csv = buildCsv(logs, { engine });

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
  drawSeries();
  updateButtonStates(); // 初期状態でのボタン状態設定

  // 権限が拒否された場合のヒント
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus('このブラウザーはマイク取得に対応していません', 'err');
    startBtn.disabled = true;
  }
})();
