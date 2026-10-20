(() => {
  'use strict';

  // 実機検証に使った試験音の順序。出力・受信の成否は機材に依存する。
  const STEPS = [1000, 15000, 16000, 17000, 18000, 19000, 20000, 21000, 22000];
  let TONE_SEC = 5;   // 1トーンの秒数（画面から変える）
  let GAP_SEC = 2;    // 間の静寂の秒数

  // 判定に使う帯域
  const BANDS = [
    { name: '1kHz 付近（基準）', lo: 900, hi: 1100 },
    { name: '15-17kHz', lo: 15000, hi: 17000 },
    { name: '17-18kHz', lo: 17000, hi: 18000 },
    { name: '18-20kHz', lo: 18000, hi: 20000 },
    { name: '20-22kHz', lo: 20000, hi: 22000 },
  ];

  const $ = id => document.getElementById(id);
  const seqBtn = $('seqBtn'), stopBtn = $('stopBtn'), manualBtn = $('manualBtn');
  const micBtn = $('micBtn'), floorBtn = $('floorBtn');
  const logEl = $('log'), canvas = $('spec'), ctx = canvas.getContext('2d');

  let outCtx = null, osc = null, gain = null;
  let seqTimer = null, seqIndex = -1, seqPhase = '';
  let inCtx = null, analyser = null, micStream = null, freqData = null, rafId = null;
  let noiseFloor = null;
  let playbackId = 0, micId = 0;

  function stamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
      + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
      + '.' + String(d.getMilliseconds()).padStart(3, '0');
  }

  function addLog(text) {
    logEl.value += stamp() + '  ' + text + '\n';
    logEl.scrollTop = logEl.scrollHeight;
  }

  function volAmp() {
    const value = Number($('vol').value);
    return Math.pow(10, Math.max(-60, Math.min(-12, Number.isFinite(value) ? value : -24)) / 20);
  }

  function ensureOut() {
    if (outCtx) return outCtx;
    outCtx = new (window.AudioContext || window.webkitAudioContext)();
    $('srOut').textContent = outCtx.sampleRate;
    $('nyqOut').textContent = (outCtx.sampleRate / 2).toFixed(0);
    addLog('出力の AudioContext を作った（sampleRate=' + outCtx.sampleRate + '）');
    return outCtx;
  }

  function startTone(hz) {
    const c = ensureOut();
    stopTone(true);
    if (!Number.isFinite(hz) || hz < 20 || hz > 24000 || hz >= c.sampleRate / 2) {
      $('freqNow').textContent = '-';
      $('stepInfo').textContent = '再生できない周波数です（20〜24000Hz、sampleRate/2未満）。';
      addLog('再生せず: ' + hz + ' Hz（sampleRate=' + c.sampleRate + '）');
      return false;
    }
    const o = c.createOscillator(), g = c.createGain(), envelope = c.createGain();
    osc = o; gain = g;
    o.type = 'sine'; o.frequency.value = hz;
    const end = c.currentTime + TONE_SEC;
    g.gain.value = volAmp();
    envelope.gain.setValueAtTime(0.0001, c.currentTime);
    envelope.gain.exponentialRampToValueAtTime(1, c.currentTime + 0.05);
    o.connect(envelope).connect(g).connect(c.destination);
    o.onended = () => {
      o.disconnect(); envelope.disconnect(); g.disconnect();
      if (osc === o) { osc = null; gain = null; $('freqNow').textContent = '-'; }
    };
    o.start();
    // 音声クロックで停止を予約する。描画やタイマーが遅れても鳴り続けない。
    envelope.gain.setValueAtTime(1, end - 0.05);
    envelope.gain.exponentialRampToValueAtTime(0.0001, end);
    o.stop(end);
    $('freqNow').textContent = hz.toLocaleString();
    return true;
  }

  async function prepareOutput() {
    seqStop();
    const id = playbackId;
    syncDurations();
    stopBtn.disabled = false;
    try {
      const c = ensureOut();
      if (c.state === 'suspended') await c.resume();
      const ready = id === playbackId && !document.hidden;
      if (ready) { $('toneSec').disabled = true; $('gapSec').disabled = true; }
      return ready;
    } catch (e) {
      if (id === playbackId) { seqStop(); addLog('再生を開始できません: ' + e.name); }
      return false;
    }
  }

  function stopTone(silent) {
    if (osc) {
      try {
        gain.gain.cancelScheduledValues(outCtx.currentTime);
        gain.gain.setValueAtTime(gain.gain.value, outCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.0001, outCtx.currentTime + 0.05);
        osc.stop(outCtx.currentTime + 0.08);
      } catch (e) { /* すでに止まっている */ }
      osc = null; gain = null;
    }
    if (!silent) $('freqNow').textContent = '-';
  }

  // ---- 階段シーケンス ----
  function seqNext() {
    if (seqPhase === 'tone') {
      stopTone(false);
      seqPhase = 'gap';
      $('stepInfo').textContent = '静寂 ' + GAP_SEC + ' 秒';
      addLog('静寂 ' + GAP_SEC + ' 秒');
      seqTimer = setTimeout(seqNext, GAP_SEC * 1000);
      return;
    }
    seqIndex++;
    if (seqIndex >= STEPS.length) { seqStop(); addLog('シーケンス完了'); return; }
    const hz = STEPS[seqIndex];
    seqPhase = 'tone';
    $('stepInfo').textContent = (seqIndex + 1) + ' / ' + STEPS.length
      + '　' + hz.toLocaleString() + ' Hz を ' + TONE_SEC + ' 秒';
    addLog('▶ ' + hz + ' Hz 開始（' + TONE_SEC + ' 秒、音量 ' + $('vol').value + ' dBFS）');
    startTone(hz);
    seqTimer = setTimeout(seqNext, TONE_SEC * 1000);
  }

  async function seqStart() {
    if (!await prepareOutput()) return;
    seqIndex = -1; seqPhase = '';
    seqBtn.disabled = true; stopBtn.disabled = false;
    $('seqState').textContent = '実行中'; $('seqState').className = 'state on';
    addLog('=== シーケンス開始 ===（各 ' + TONE_SEC + ' 秒、間に静寂 ' + GAP_SEC + ' 秒）');
    addLog('順序: ' + STEPS.join(' → ') + ' Hz');
    // 最初に静寂を1回入れる（暗騒音の区間をCSVに残すため）
    seqPhase = 'tone';
    $('stepInfo').textContent = '最初の静寂 ' + GAP_SEC + ' 秒';
    addLog('最初の静寂 ' + GAP_SEC + ' 秒（暗騒音）');
    seqTimer = setTimeout(seqNext, GAP_SEC * 1000);
    seqPhase = '';
  }

  function seqStop() {
    playbackId++;
    $('toneSec').disabled = false; $('gapSec').disabled = false;
    clearTimeout(seqTimer); seqTimer = null;
    stopTone(false);
    seqBtn.disabled = false; stopBtn.disabled = true;
    $('seqState').textContent = '停止中'; $('seqState').className = 'state off';
    $('stepInfo').textContent = '-';
  }

  seqBtn.addEventListener('click', seqStart);
  stopBtn.addEventListener('click', () => { seqStop(); addLog('■ 手で停止'); });
  manualBtn.addEventListener('click', async () => {
    const hz = Number($('manualHz').value);
    if (!await prepareOutput()) return;
    if (!startTone(hz)) {
      const reason = $('stepInfo').textContent;
      seqStop();
      $('stepInfo').textContent = reason;
      return;
    }
    $('seqState').textContent = '手動再生中';
    addLog('▶ 手動 ' + hz + ' Hz（' + TONE_SEC + ' 秒）');
    seqTimer = setTimeout(seqStop, TONE_SEC * 1000);
  });
  $('vol').addEventListener('input', () => {
    $('volLabel').textContent = $('vol').value + ' dBFS（ピーク振幅）';
    if (gain && outCtx) {
      gain.gain.setValueAtTime(volAmp(), outCtx.currentTime);
    }
  });

  // ---- マイク側 ----
  async function connectMic() {
    const id = ++micId;
    try {
      micBtn.disabled = true;
      $('micStopBtn').disabled = false;
      $('micState').textContent = '許可待ち（切断でキャンセル）';
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: false
      });
      if (id !== micId || document.hidden) { stream.getTracks().forEach(t => t.stop()); return; }
      micStream = stream;
      inCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (inCtx.state === 'suspended') await inCtx.resume();
      if (id !== micId) return;
      const src = inCtx.createMediaStreamSource(micStream);
      analyser = inCtx.createAnalyser();
      analyser.fftSize = 8192;
      analyser.smoothingTimeConstant = 0.35;
      src.connect(analyser);
      freqData = new Float32Array(analyser.frequencyBinCount);
      $('srIn').textContent = inCtx.sampleRate;
      $('binHz').textContent = (inCtx.sampleRate / analyser.fftSize).toFixed(2);
      $('micState').textContent = '接続した'; $('micState').className = 'state on';

      const t = micStream.getAudioTracks()[0];
      t.addEventListener('ended', () => { if (id === micId) disconnectMic(); });
      const s = t.getSettings ? t.getSettings() : {};
      addLog('マイク接続: ' + (t.label || '(名前なし)'));
      addLog('  sampleRate=' + inCtx.sampleRate
        + ' / AEC=' + s.echoCancellation + ' / NS=' + s.noiseSuppression + ' / AGC=' + s.autoGainControl);
      if (s.echoCancellation === true || s.noiseSuppression === true) {
        addLog('  ⚠ 切るよう要求したのに有効になっている。高域が削られる可能性がある');
      }
      draw();
    } catch (e) {
      if (id !== micId) return;
      disconnectMic();
      $('micState').textContent = '失敗: ' + e.name; $('micState').className = 'state off';
      addLog('マイク接続に失敗: ' + e.name + ' ' + e.message);
      micBtn.disabled = false;
    }
  }
  function disconnectMic() {
    micId++;
    cancelAnimationFrame(rafId); rafId = null;
    if (micStream) micStream.getTracks().forEach(t => t.stop());
    if (inCtx) inCtx.close().catch(() => {});
    micStream = null; inCtx = null; analyser = null; freqData = null; noiseFloor = null;
    micBtn.disabled = false; $('micStopBtn').disabled = true;
    $('micState').textContent = '未接続'; $('micState').className = 'state off';
    $('floorState').textContent = '未記録（静かな状態で押す）';
    for (const id of ['srIn', 'binHz', 'peakHz']) $(id).textContent = '-';
    $('bandRows').replaceChildren();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  function shutdown() {
    seqStop(); disconnectMic();
    if (outCtx) outCtx.close().catch(() => {});
    outCtx = null;
  }
  micBtn.addEventListener('click', connectMic);
  $('micStopBtn').addEventListener('click', disconnectMic);
  document.addEventListener('visibilitychange', () => { if (document.hidden) shutdown(); });
  window.addEventListener('pagehide', shutdown);

  // 帯域のエネルギー（dB の平均ではなく、パワーで足してから dB に戻す）
  function bandDb(lo, hi) {
    if (!analyser || !freqData) return null;
    const nyq = inCtx.sampleRate / 2;
    const n = freqData.length;
    const i0 = Math.max(0, Math.floor(lo / nyq * n));
    const i1 = Math.min(n - 1, Math.ceil(hi / nyq * n));
    if (i1 < i0) return null;
    let sum = 0, cnt = 0;
    for (let i = i0; i <= i1; i++) {
      const v = freqData[i];
      if (!isFinite(v)) continue;
      sum += Math.pow(10, v / 10);
      cnt++;
    }
    if (!cnt) return null;
    return 10 * Math.log10(sum / cnt);
  }

  function renderBands() {
    const rows = [];
    for (const b of BANDS) {
      const db = bandDb(b.lo, b.hi);
      const nyq = inCtx ? inCtx.sampleRate / 2 : 0;
      let diff = '-', verdict = '暗騒音が未記録', status = 'pend';
      if (b.hi > nyq) {
        verdict = '測れない（sampleRate不足）'; status = 'miss';
      } else if (db !== null && noiseFloor && Number.isFinite(noiseFloor[b.name])) {
        const d = db - noiseFloor[b.name];
        diff = (d >= 0 ? '+' : '') + d.toFixed(1) + ' dB';
        verdict = d >= 6 ? '届いている' : '届いていない';
        status = d >= 6 ? 'hit' : 'miss';
      }
      const row = document.createElement('tr');
      [b.name, db === null ? '-' : db.toFixed(1) + ' dB', diff, verdict].forEach((text, index) => {
        const cell = document.createElement('td');
        cell.textContent = text;
        cell.className = index === 3 ? status : index > 0 ? 'num' : '';
        row.append(cell);
      });
      rows.push(row);
    }
    $('bandRows').replaceChildren(...rows);
  }

  function captureFloor(how) {
    if (!analyser) { addLog('先にマイクを繋ぐ'); return false; }
    noiseFloor = {};
    for (const b of BANDS) noiseFloor[b.name] = bandDb(b.lo, b.hi);
    $('floorState').textContent = '記録した（' + stamp() + '・' + how + '）';
    addLog('暗騒音を記録（' + how + '）: ' + BANDS.map(b =>
      b.name + '=' + (noiseFloor[b.name] === null ? '-' : noiseFloor[b.name].toFixed(1))).join(' / '));
    return true;
  }
  floorBtn.addEventListener('click', () => captureFloor('手動'));

  function draw() {
    rafId = requestAnimationFrame(draw);
    if (!analyser) return;
    analyser.getFloatFrequencyData(freqData);

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }

    const nyq = inCtx.sampleRate / 2;
    const DB_TOP = -20, DB_BOT = -130;
    const padL = 42 * dpr, padB = 22 * dpr, padT = 8 * dpr, padR = 8 * dpr;
    const gw = w - padL - padR, gh = h - padT - padB;

    // 図の色は配色のトークンから取る（配色を切り替えると次の描画から変わる）
    const cs = getComputedStyle(document.documentElement);
    const tok = (name) => cs.getPropertyValue(name).trim();
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = tok('--canvas-bg'); ctx.fillRect(0, 0, w, h);

    const xOf = hz => padL + (hz / nyq) * gw;
    const yOf = db => padT + (DB_TOP - db) / (DB_TOP - DB_BOT) * gh;

    // 目盛り
    ctx.strokeStyle = tok('--canvas-grid'); ctx.lineWidth = 1 * dpr;
    ctx.fillStyle = tok('--canvas-text'); ctx.font = (10 * dpr) + 'px sans-serif';
    ctx.textAlign = 'center';
    for (let k = 0; k <= 24000; k += 2000) {
      if (k > nyq) break;
      const x = xOf(k);
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + gh); ctx.stroke();
      ctx.fillText((k / 1000) + 'k', x, h - 7 * dpr);
    }
    ctx.textAlign = 'right';
    for (let db = DB_TOP; db >= DB_BOT; db -= 20) {
      const y = yOf(db);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + gw, y); ctx.stroke();
      ctx.fillText(db, padL - 5 * dpr, y + 3.5 * dpr);
    }

    // 18/20/22kHz の目印
    ctx.setLineDash([4 * dpr, 4 * dpr]);
    for (const k of [18000, 20000, 22000]) {
      if (k > nyq) continue;
      ctx.strokeStyle = tok('--canvas-mark');
      ctx.beginPath(); ctx.moveTo(xOf(k), padT); ctx.lineTo(xOf(k), padT + gh); ctx.stroke();
    }
    ctx.setLineDash([]);

    // スペクトル
    ctx.strokeStyle = tok('--line'); ctx.lineWidth = 1.4 * dpr;
    ctx.beginPath();
    let peakDb = -Infinity, peakIdx = 0;
    // DC 付近（100Hz 未満）は常に大きいので、山を探す対象から外す。
    // ここを入れないと peakHz がいつも 0Hz になり、何も読めない
    const skipBelow = Math.ceil(100 / nyq * freqData.length);
    for (let i = 0; i < freqData.length; i++) {
      const hz = i / freqData.length * nyq;
      const db = Math.max(DB_BOT, Math.min(DB_TOP, freqData[i]));
      const x = xOf(hz), y = yOf(db);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      if (i >= skipBelow && freqData[i] > peakDb) { peakDb = freqData[i]; peakIdx = i; }
    }
    ctx.stroke();

    const peakHz = peakIdx / freqData.length * nyq;
    $('peakHz').textContent = peakHz.toFixed(0) + ' Hz（' + peakDb.toFixed(1) + ' dB）';
    renderBands();
  }

  $('copyBtn').addEventListener('click', () => {
    logEl.select();
    try { document.execCommand('copy'); } catch (e) { /* 手で選ぶ */ }
  });
  $('clearBtn').addEventListener('click', () => { logEl.value = ''; });

  // 長さの入力を反映する
  function syncDurations() {
    const t = Math.max(2, Math.min(30, Number($('toneSec').value) || 5));
    const g = Math.max(1, Math.min(20, Number($('gapSec').value) || 2));
    TONE_SEC = t; GAP_SEC = g;
    fillSeqDesc();
  }
  // 説明文は定数から作る。STEPS を変えたら文面も自動で追従する
  function fillSeqDesc() {
    const el = $('seqDesc');
    if (!el) return;
    const list = STEPS.map(h => h >= 1000 ? (h / 1000) + 'k' : h + '').join(' → ') + ' Hz';
    el.textContent = '静寂 ' + GAP_SEC + ' 秒 → ' + list
      + '。各トーンを ' + TONE_SEC + ' 秒鳴らし、間に静寂 ' + GAP_SEC
      + ' 秒を挟む（全 ' + STEPS.length + ' 段、所要 約'
      + Math.round(STEPS.length * (TONE_SEC + GAP_SEC) + GAP_SEC) + ' 秒）。';
  }
  $('toneSec').addEventListener('input', syncDurations);
  $('gapSec').addEventListener('input', syncDurations);
  fillSeqDesc();

  addLog('準備完了。ページ末尾の「実機テストの資料」に手順があります');
})();
