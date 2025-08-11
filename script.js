// Day041 - Mic Gain Logger
// 録音せずに音量（dBFS）をリアルタイム表示＆CSVログ出力

(() => {
  // UI要素取得
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const exportBtn = document.getElementById('exportBtn');
  const resetBtn = document.getElementById('resetBtn');
  const darkToggle = document.getElementById('darkToggle');

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

  const WIDTH = canvas.width;
  const HEIGHT = canvas.height;
  let series = new Array(WIDTH).fill(0); // 0..1 の値（可視化用）
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
    try {
      setStatus('マイクに接続中…', 'warn');

      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        },
        video: false
      });

      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = parseFloat(smoothingInput.value) || 0.5;

      sourceNode = audioCtx.createMediaStreamSource(mediaStream);
      sourceNode.connect(analyser);

      startedAt = performance.now() / 1000;
      running = true;
      startBtn.disabled = true;
      stopBtn.disabled = false;
      exportBtn.disabled = false;
      resetBtn.disabled = false;

      setStatus('計測中', 'ok');
      animate();
    } catch (err) {
      console.error(err);
      setStatus(`エラー: ${err.message || err}`, 'err');
      running = false;
      cleanup();
    }
  }

  function stop() {
    if (!running) return;
    running = false;
    setStatus('停止しました', 'warn');
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    cleanup();
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }

  function cleanup() {
    try {
      if (sourceNode) { try{ sourceNode.disconnect(); }catch{} sourceNode = null; }
      if (analyser) { try{ analyser.disconnect(); }catch{} analyser = null; }
      if (audioCtx) { try{ audioCtx.close(); }catch{} audioCtx = null; }
      if (mediaStream) {
        mediaStream.getTracks().forEach(t => t.stop());
        mediaStream = null;
      }
    } catch {}
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
        logs.push({
          ts: new Date(),
          db: Math.max(db, floorDb)
        });
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
    setStatus('統計とログをリセットしました', 'ok');
  }

  // ダークモード
  function applyTheme() {
    if (darkToggle.checked) {
      document.body.classList.remove('light');
    } else {
      document.body.classList.add('light');
    }
    drawSeries();
  }

  // イベント
  startBtn.addEventListener('click', start);
  stopBtn.addEventListener('click', stop);
  exportBtn.addEventListener('click', exportCSV);
  resetBtn.addEventListener('click', resetAllStats);
  darkToggle.addEventListener('change', applyTheme);
  window.addEventListener('beforeunload', stop);

  // 初期
  document.body.classList.add('light'); // 既定はライト
  applyTheme();
  drawSeries();

  // 権限が拒否された場合のヒント
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus('このブラウザはマイク取得に対応していません', 'err');
    startBtn.disabled = true;
  }
})();
