// Day041 - Mic Gain Logger v2.0
// 録音せずに音量（dBFS）をリアルタイム表示＆CSVログ出力
// 最終更新: マイク再接続問題の修正版

(() => {
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

  const canvas = document.getElementById('levelCanvas');
  const ctx = canvas.getContext('2d');

  // 状態
  let audioCtx = null;
  let analyser = null;
  let sourceNode = null;
  let mediaStream = null;

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
  let sum = 0;
  let n = 0;
  let minDb = Infinity;
  let maxDb = -Infinity;

  // ログ（CSV用）
  const logs = []; // { ts: Date, db: number }

  // 設定
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  function getFloorDb() {
    let v = parseFloat(floorDbInput.value);
    if (Number.isNaN(v)) v = -60;
    return v;
  }

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
    return [h,m,s].map(x => String(x).padStart(2,'0')).join(':');
  }

  // RMS→dBFS
  function rmsToDbfs(rms) {
    if (rms <= 1e-8) return -Infinity;
    return 20 * Math.log10(rms);
  }

  // 音量計算
  const buffer = new Float32Array(2048);
  function computeDb() {
    analyser.getFloatTimeDomainData(buffer);
    let sumSq = 0;
    for (let i = 0; i < buffer.length; i++) {
      const x = buffer[i];
      sumSq += x * x;
    }
    const rms = Math.sqrt(sumSq / buffer.length);
    const db = rmsToDbfs(rms);
    return db;
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

  function updateStats(db) {
    if (!Number.isFinite(db)) return;
    sum += db;
    n += 1;
    minDb = Math.min(minDb, db);
    maxDb = Math.max(maxDb, db);

    avgEl.textContent = `${(sum / n).toFixed(1)} dBFS`;
    maxEl.textContent = `${maxDb.toFixed(1)} dBFS`;
    minEl.textContent = `${minDb.toFixed(1)} dBFS`;
    const rng = (Number.isFinite(minDb) && Number.isFinite(maxDb)) ? (maxDb - minDb) : 0;
    rangeEl.textContent = `${rng.toFixed(1)} dB`;
    countEl.textContent = String(logs.length);
  }

  function resetStats() {
    sum = 0;
    n = 0;
    minDb = Infinity;
    maxDb = -Infinity;
    avgEl.textContent = `--.- dBFS`;
    maxEl.textContent = `--.- dBFS`;
    minEl.textContent = `--.- dBFS`;
    rangeEl.textContent = `--.- dB`;
    countEl.textContent = `0`;
  }

  function setStatus(text, kind='ok') {
    statusEl.className = `status ${kind}`;
    statusEl.textContent = text;
  }

  async function start() {
    if (running) return;
    
    // デバッグ: バージョン確認
    console.log('Mic Gain Logger v2.0 - 新しいstart()関数が実行されました');
    
    // ボタンを即座に無効化
    startBtn.disabled = true;
    
    // 前回のクリーンアップが完了していることを確認
    if (audioCtx || mediaStream) {
      await cleanup();
      // クリーンアップ後に少し待つ
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    
    // 停止直後の場合、警告を表示
    const timeSinceStop = Date.now() - lastStopTime;
    if (lastStopTime > 0 && timeSinceStop < 2000) {
      setStatus('マイク接続の準備中...少しお待ちください', 'warn');
      // 少し待ってから再試行
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    try {
      setStatus('マイクに接続中…', 'warn');

      // 新しいメディアストリームを取得
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        },
        video: false
      });

      // 新しいAudioContextを作成
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = parseFloat(smoothingInput.value) || 0.5;

      sourceNode = audioCtx.createMediaStreamSource(mediaStream);
      sourceNode.connect(analyser);

      startedAt = performance.now() / 1000;
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
      startBtn.disabled = false;
      updateButtonStates(); // エラー時にもボタン状態を更新
      await cleanup();
    }
  }

  async function stop() {
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
    // ストリームを最初に停止（これが最も重要）
    if (mediaStream) {
      mediaStream.getTracks().forEach(t => {
        t.stop();
      });
      mediaStream = null;
    }
    
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

  function animate() {
    if (!running) return;

    // スムージング更新（動的反映）
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

    // 統計
    updateStats(db);

    // 稼働時間
    const nowSec = performance.now() / 1000;
    uptimeEl.textContent = formatHMS(nowSec - startedAt);

    // ログ（間隔ごとに）
    const intervalSec = Math.max(0.2, parseFloat(logIntervalInput.value) || 1);
    if (nowSec - lastLogTime >= intervalSec) {
      if (Number.isFinite(db)) {
        const wasEmpty = logs.length === 0; // 最初のログかどうかを記録
        logs.push({
          ts: new Date(),
          db: Math.max(db, floorDb)
        });
        
        // 最初のログが追加された時にボタン状態を更新
        if (wasEmpty) {
          updateButtonStates();
        }
      }
      lastLogTime = nowSec;
    }

    rafId = requestAnimationFrame(animate);
  }

  function exportCSV() {
    if (!logs.length) {
      setStatus('書き出すログがありません', 'warn');
      return;
    }
    const header = 'timestamp,dbfs\n';
    const lines = logs.map(r => `${r.ts.toISOString()},${r.db.toFixed(2)}`).join('\n');
    const csv = header + lines;

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().replace(/[:.]/g,'-');
    a.href = url;
    a.download = `mic-gain-logs-${ts}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    setStatus(`CSVを書き出しました（${logs.length}件）`, 'ok');
  }

  function resetAllStats() {
    resetStats();
    logs.length = 0;
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
