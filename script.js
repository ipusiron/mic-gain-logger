// Day041 - Mic Gain Logger v2.0
// 録音せずに音量（dBFS）をリアルタイム表示＆CSVログ出力
// 最終更新: マイク再接続問題の修正版

(() => {
  // 純粋ロジックは logic.js（DOM非依存）から取る
  const {
    clamp, dbToPercent, formatHMS, rmsToDbfs, rmsOf, METER_WINDOW_SAMPLES,
    parseFloorDb, floorDbDefaultFor, parseIntervalSec, canvasPixelSize, meterScaleLabels,
    COMPACT_MEDIA_QUERY, startStopView, moreMenuNext,
    GRAPH_WINDOW_SEC, GRAPH_TOP_DB, graphArea, timeToX, dbToY,
    timeTickStepSec, timeTicks, dbTickStep, dbTicks, pruneSeries, seriesPointOf,
    GRAPH_LINE_STYLES, graphLinePoints,
    createStats, addStatsRecord, formatStats, formatUltraMax, statsWarnings, noticeSummary,
    statsIntegrity,
    emptyStatsText, intervalRunsLabel,
    ENGINE_WORKLET, ENGINE_FALLBACK, framesForInterval,
    CLOCK_BREAK_SUSPEND, CLOCK_BREAK_STALL,
    createClockAnchor, detectClockJump, reanchorClock,
    CONNECT_HINT_MS, CONNECT_TIMEOUT_MS, createAttemptGate, raceWithTimeout,
    buildSessionMeta, chainHeaderMeta, recordNoticeItems,
    DEVICE_LOST_ENDED, DEVICE_LOST_GONE,
    readTrackState, isTrackLost, markDeviceLoss,
    buildIntervalRecord, buildFallbackRecord,
    bandPlan, bandsEnabledFromQuery,
    upperLimitText, ultraBandState, ultraSwatchShown, ultraLegendText, graphAriaLabel, ultraNowText,
    buildCsv, csvFileName,
    csvTrailerLines, createHashChain, HASH_ALGO_LABEL
  } = MicGainLogic; // logic.js（classic script のグローバル束縛）
  // 画面の文言の辞書と、言語の決め方（messages.js。第2弾c3a）。
  // ⚠ 画面に出る文言はここに書かず、辞書のキーで引く（test/i18n.test.js が、コメントの外の日本語の文字列を見ている）
  const {
    t, initialLang, searchWithLang, richSegments, richPlainText, I18N_ATTRS, LANG_STORAGE_KEY
  } = MicGainMessages;

  // UI要素取得
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const exportBtn = document.getElementById('exportBtn');
  const resetBtn = document.getElementById('resetBtn');
  // 「その他」と、その中身（CSV書き出し・統計リセット）。幅480px以下でだけ畳む（第2弾c0）
  const moreBtn = document.getElementById('moreBtn');
  const moreMenuEl = document.getElementById('moreMenu');
  const themeToggle = document.getElementById('themeToggle');
  // 表示の言語の切り替え（第2弾c3a）。ヘッダーの右上
  const langToggle = document.getElementById('langToggle');
  const helpBtn = document.getElementById('helpBtn');
  const helpModal = document.getElementById('helpModal');

  const bigValue = document.getElementById('bigValue');
  // 超音波帯の現在値（第2弾c0）。大きな数字のすぐ下の1行
  const ultraNowEl = document.getElementById('ultraNow');
  const meterEl = document.getElementById('meter');
  const meterBar = document.getElementById('meterBar');
  const meterScaleEl = document.getElementById('meterScale');
  const statusEl = document.getElementById('status');

  const avgEl = document.getElementById('avgDb');
  const maxEl = document.getElementById('maxDb');
  const minEl = document.getElementById('minDb');
  const rangeEl = document.getElementById('rangeDb');
  const peakEl = document.getElementById('peakDb');
  const ultraMaxEl = document.getElementById('ultraMaxDb');
  const countEl = document.getElementById('count');
  const uptimeEl = document.getElementById('uptime');

  const logIntervalInput = document.getElementById('logInterval');
  const floorDbInput = document.getElementById('floorDb');

  const engineModeEl = document.getElementById('engineMode');
  const recordNoticeEl = document.getElementById('recordNotice');
  const recordNoticeLiveEl = document.getElementById('recordNoticeLive');
  const integrityEl = document.getElementById('integrityNote');

  const canvas = document.getElementById('levelCanvas');
  const ctx = canvas.getContext('2d');
  // グラフの凡例と上限の表示（第2弾b3）。凡例はキャンバスの外のHTMLに置く
  const legendUltraEl = document.getElementById('legendUltra');
  const legendUltraTextEl = document.getElementById('legendUltraText');
  const upperLimitEl = document.getElementById('upperLimit');

  // ---- 表示の言語（第2弾c3a）----
  //
  // 初期言語は ?lang=ja|en → 保存した選択（localStorage）→ ブラウザーの言語（navigator.languages の先頭が日本語なら日本語、
  // それ以外は英語）。決め方は messages.js の initialLang で、ここは材料を集めて渡すだけ。
  // ⚠ 言語は表示だけを変える。記録（logs）・統計（stats）・グラフの点（series）・ハッシュチェーン・CSV には触らない。
  //    CSV の中身と書き出すファイル名は、言語によらず同じ（logic.js の buildCsv・csvFileName は辞書を使わない）
  // ⚠ localStorage は使えない環境（プライベートブラウズ・保存の拒否）がある。読めなければ null、書けなければ黙って続ける
  function readSavedLang() {
    try { return localStorage.getItem(LANG_STORAGE_KEY); } catch { return null; }
  }
  function saveLang(value) {
    try { localStorage.setItem(LANG_STORAGE_KEY, value); } catch { /* 保存できなくても、開いているあいだの切り替えはできる */ }
  }
  let lang = initialLang({
    search: window.location.search,
    saved: readSavedLang(),
    languages: (navigator.languages && navigator.languages.length) ? navigator.languages : [navigator.language]
  });

  // いまの言語で辞書を引く
  function tr(key, params) {
    return t(lang, key, params);
  }

  // 辞書のキーで文字を入れる。キー（と置き換える値）を要素に残し、言語を切り替えたら applyStaticText が同じキーで入れ直す。
  // keyが空なら、文字もキーも消す
  function setMessage(el, key, params) {
    if (!el) return;
    if (!key) {
      el.removeAttribute('data-i18n');
      el.removeAttribute('data-i18n-params');
      el.textContent = '';
      return;
    }
    el.setAttribute('data-i18n', key);
    if (params) el.setAttribute('data-i18n-params', JSON.stringify(params));
    else el.removeAttribute('data-i18n-params');
    el.textContent = tr(key, params);
  }

  function paramsOf(el) {
    const raw = el.getAttribute('data-i18n-params');
    if (!raw) return undefined;
    try { return JSON.parse(raw); } catch { return undefined; }
  }

  // <strong>・<code>・<em> を含む文言（ヘルプ・説明と注意事項）を要素にする。
  // 分け方は messages.js の richSegments が決め、ここは要素を作るだけ（innerHTML は使わない）
  function renderRich(el, value) {
    el.replaceChildren(...richSegments(value).map(seg => {
      if (!seg.tag) return document.createTextNode(seg.text);
      const node = document.createElement(seg.tag);
      node.textContent = seg.text;
      return node;
    }));
  }

  // index.html の data-i18n（文字）・data-i18n-rich（タグを含む文字）・data-i18n-<属性名>（title・aria-label など）を、
  // いまの言語で入れ直す。非表示の要素（ヘルプ・「その他」の中身・閉じた説明）も同じく入れ直す。変わったところだけ書く
  function applyStaticText() {
    for (const el of document.querySelectorAll('[data-i18n]')) {
      const text = tr(el.getAttribute('data-i18n'), paramsOf(el));
      if (el.textContent !== text) el.textContent = text;
    }
    for (const el of document.querySelectorAll('[data-i18n-rich]')) {
      const value = tr(el.getAttribute('data-i18n-rich'));
      if (el.textContent !== richPlainText(value)) renderRich(el, value);
    }
    for (const attr of I18N_ATTRS) {
      for (const el of document.querySelectorAll(`[data-i18n-${attr}]`)) {
        const value = tr(el.getAttribute(`data-i18n-${attr}`));
        if (el.getAttribute(attr) !== value) el.setAttribute(attr, value);
      }
    }
  }

  // 帯域を計算するか（?bands=offならfalse）。ページを開いたときのURLで決まり、開いているあいだ変わらない。
  // 凡例は記録を始める前から出すので、セッションのメタ（bandsEnabled）を待たずにここで読む
  const bandsOnPage = bandsEnabledFromQuery(window.location.search);

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

  // 記録に使ったログ間隔は、ここでは持ち回らない。
  //
  // ⚠ 改修前は書き出し時に currentIntervalSec() を読んでいたので、1秒で採った行を
  //    3s へ切り替えてから書き出すと「# intervalSec=3」と嘘が出た。次に画面の設定値
  //    （lastIntervalSec）を行へ貼るようにしたが、これも嘘だった。設定は即座に
  //    変わるのに、ワークレットは次の境界まで前の区間長で測り続けるので、
  //    「1秒で測った区間に 3 というラベルが付く」行ができた。
  //    いまは区間レコード自身が「その区間を実際に測ったときの間隔」（rec.intervalSec）
  //    を持つ。トレーラーのラベルは書き出しのときに logs から組み直す
  //    （logic.js の intervalRunsLabel）。別に控えておくと、また実態とずれる。
  //    ⚠ これは記録中に変わる値なので、鎖の起点（ヘッダー）ではなくトレーラーへ出す。

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
  // ⚠ 分かるのは、うっかりの破損・部分的な欠落・順序の入れ替わりまでである。
  //    意図的な改変には、相手が誰であっても耐えない（誰でも鎖を張り直せる）。
  //    名乗りの根拠は logic.js のハッシュチェーンの節にある。
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
  //      呼び出し元のdrawSeries()とhandleMobileButtonLayout()（第2弾c0で廃止）まで止まった
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
  // 統計から出ている注意書き。中身が変わったときだけ組み直す。
  // ⚠ 件数（何本の警告が出ているか）で比べてはいけない。クリップした区間が
  //    2つ目・3つ目と増えても警告は1本のままなので、画面が「1区間」で止まる。
  //    実測で、4区間クリップしているのに「1区間」と出た。文字列で比べる。
  let statsNoticeText = '';

  // ログ（CSV用）
  const logs = []; // { ts: Date, db: number }

  // 設定
  // 表示下限の既定は、帯域を計算するかどうかで決まる（第2弾c0。帯域あり-110、?bands=offは従来の-90）。
  // 決め方はlogic.jsのfloorDbDefaultFor。空欄・非数のときもこの値に戻す
  const floorDbDefault = floorDbDefaultFor(bandsOnPage);
  function getFloorDb() {
    return parseFloorDb(floorDbInput.value, floorDbDefault);
  }

  // メーターの目盛りと説明を、表示下限に合わせる。
  // ⚠ 改修前は -60 / -40 / -20 / 0 を固定で書いていた（しかも .meter の中にあって切られ、
  //    一度も見えていなかった）。表示下限を変えると目盛りだけが嘘になる
  function renderMeterScale() {
    const floorDb = getFloorDb();
    const labels = meterScaleLabels(floorDb);
    if (meterScaleEl) {
      const spans = meterScaleEl.querySelectorAll('span');
      labels.forEach((t, i) => { if (spans[i]) spans[i].textContent = t; });
    }
    if (meterEl) meterEl.title = tr('meter.title', { floor: labels[0] });
  }

  // 音量計算。大きな数字は直近METER_WINDOW_SAMPLES（2048）サンプルの全帯域のRMSである。
  // ⚠ CSVのdbfs（区間全体のエネルギー平均）とは窓が違う（ヘルプ・title・READMEに書いた。第2弾c0）
  const buffer = new Float32Array(METER_WINDOW_SAMPLES);
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
      plot: pick('--plot', '#4da3ff'),
      // 超音波帯の破線（第2弾b3）。本体の線と色でも形でも見分けられるようにする
      plotUltra: pick('--plot-ultra', '#f0883e')
    };
  }

  // グラフの右端の時刻。記録中は「いま」、停止中は止めた時刻に固定する。
  // ⚠ 停止中も「いま」で描き直すと、表示下限の変更・テーマの切り替え・リサイズの
  //    たびに線が左へずれ、60秒たつと記録した線がまるごと左端へ寄って見えなくなった
  //    （公開前の点検で見つかった）
  let graphFrozenMs = null;
  function graphNowMs() {
    if (running || graphFrozenMs === null) return Date.now();
    return graphFrozenMs;
  }

  // キャンバス描画。横軸は実時間（右端が「いま」）、縦軸は dBFS。
  function drawSeries() {
    const col = graphColors();
    const nowMs = graphNowMs();
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

    // 折れ線。xは実時刻、yはdB値（正規化して持たない）。
    // 本体の音量（実線）に、超音波帯の値（破線）を重ねる（第2弾b3）。点の組み立て（どこで線を切るか）は
    // logic.jsのgraphLinePointsが決める。欠測の行・帯域の値の無い区間は線を切り、デジタル無音は下端に描く
    if (series.length) {
      const view = { nowMs, windowMs, floorDb, topDb: GRAPH_TOP_DB, area };
      ctx.save();
      ctx.beginPath();
      ctx.rect(area.x, area.y, area.w, area.h);
      ctx.clip();
      strokeSeries(graphLinePoints(series, 'db', view), col.plot, GRAPH_LINE_STYLES.level);
      // 破線を上に描く（超音波帯だけに音があると、2本の線がほぼ重なるため）
      strokeSeries(graphLinePoints(series, 'ultraDb', view), col.plotUltra, GRAPH_LINE_STYLES.ultra);
      ctx.restore();
    }

    // 枠
    ctx.strokeStyle = col.grid;
    ctx.lineWidth = 1;
    ctx.strokeRect(area.x + 0.5, area.y + 0.5, area.w - 1, area.h - 1);
  }

  // 1本の折れ線を描く。pointsはlogic.jsのgraphLinePointsの戻り値
  function strokeSeries(points, color, style) {
    if (!points.length) return;
    ctx.lineWidth = style.width;
    ctx.setLineDash(style.dash);
    ctx.strokeStyle = color;
    ctx.beginPath();
    for (const p of points) {
      // gapが立っている点は前とつなげない。測っていない時間・欠測の行・値の無い区間を線で埋めないため
      if (p.gap) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    // 前後どちらともつながらない点は線にならないので、小さな丸で描く
    ctx.fillStyle = color;
    for (const p of points) {
      if (!p.alone) continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, style.width, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function renderStats(text) {
    avgEl.textContent = text.avg;
    maxEl.textContent = text.max;
    minEl.textContent = text.min;
    rangeEl.textContent = text.range;
    peakEl.textContent = text.peak;
    countEl.textContent = text.count;
  }

  // 統計の「超音波帯の最大」（第2弾b3）。簡易モード・?bands=offでは値のある行が無いので「--.- dBFS」のまま
  function renderUltraStat() {
    if (ultraMaxEl) ultraMaxEl.textContent = formatUltraMax(stats);
  }

  // 凡例・上限の表示・キャンバスの説明（第2弾b3）。判定と文言はlogic.jsで組み立てる。
  // 線を描くかどうかは、ページのURL（?bands=off）だけでなく、セッションの計測エンジンとサンプルレートでも決まる
  // （ultraBandState。簡易モード・超音波帯にビンが無いときも、描かない線の見本を出さない）。
  // ⚠ 読み上げ領域（aria-live）にはしない。注意書きの要約は#recordNoticeLiveだけで流す
  function renderBandInfo() {
    const state = ultraBandState(sessionMeta, bandsOnPage);
    if (legendUltraEl) legendUltraEl.classList.toggle('stopped', !ultraSwatchShown(state));
    if (legendUltraTextEl) legendUltraTextEl.textContent = ultraLegendText(state, lang);
    // 上限は記録を始めてから分かる（リセットで測定条件を捨てたら消す）
    if (upperLimitEl) upperLimitEl.textContent = upperLimitText(sessionMeta, lang);
    canvas.setAttribute('aria-label', graphAriaLabel(state, lang));
    // 超音波帯の現在値も同じ判定で出す（線を描かないときは、値の代わりに理由を出す）
    renderUltraNow();
  }

  // 超音波帯の現在値（第2弾c0）。最後に記録した区間（lastRecord）のband_ultra_dbfsを、
  // 凡例と同じ判定（ultraBandState）とともにlogic.jsのultraNowTextへ渡し、文言を入れるだけ。
  // ⚠ 読み上げ領域（aria-live）にはしない。区間ごとに変わる値を読み上げ続けないため
  let lastRecord = null;
  function renderUltraNow() {
    if (!ultraNowEl) return;
    const text = ultraNowText(ultraBandState(sessionMeta, bandsOnPage), lastRecord, lang);
    if (ultraNowEl.textContent !== text) ultraNowEl.textContent = text;
  }

  // 記録に穴があるかないかを、必ず1行で言い切る。
  // ⚠ 片側表示にしない。穴が無いときも「無い」と出す（改修前は、クリップも欠測も
  //    無い記録では画面が何も言わなかった。利用者は「穴が無い」と「まだ調べて
  //    いない」を区別できない）
  function renderIntegrity() {
    if (!integrityEl) return;
    const v = statsIntegrity(stats, lang);
    integrityEl.className = 'integrity-note' + (v.level === 'none' ? '' : ' ' + v.level);
    integrityEl.textContent = v.text;
  }

  // ⚠ 統計を進めるのはここだけである（母集団を CSV の行にそろえる）。
  //   区間レコードをそのまま渡す。重み（区間長）とピーク・クリップ・
  //   有効サンプル率は logic.js 側の addStatsRecord が拾う
  function updateStats(rec) {
    addStatsRecord(stats, rec);
    // 件数は、取り込めなかった行があっても logs に合わせる
    renderStats(formatStats(stats, logs.length));
    renderUltraStat();
    // 穴の有無は行が増えるたびに出し直す（0区間→1区間で文言が変わる）
    renderIntegrity();
    // クリップ・欠測が出たら、その区間で注意書きへ反映する。
    // 区間の数が増えれば文字列も変わるので、増えたぶんもここで拾える
    const text = statsWarnings(stats, lang).join('\n');
    if (text !== statsNoticeText) {
      statsNoticeText = text;
      renderRecordNotice();
    }
  }

  function resetStats() {
    stats = createStats();
    statsNoticeText = '';
    renderStats(emptyStatsText());
    renderUltraStat();
    // 穴の有無の表示も消す（統計と同じ母集団から出ているため）
    renderIntegrity();
    // 稼働時間だけ残ると「何をリセットしたのか」が読めない
    uptimeEl.textContent = '00:00:00';
    // クリップ・欠測の注意書きも一緒に消す（統計と同じ母集団から出ているため）
    renderRecordNotice();
  }

  // 状態の1行。文言は辞書のキーで渡す（言語を切り替えたら、applyStaticText が同じキーで入れ直す）
  function setStatus(key, kind='ok', params) {
    statusEl.className = `status ${kind}`;
    setMessage(statusEl, key, params);
  }

  // 計測エンジンの表示（どちらのモードで動いているかを画面に残す）
  function renderEngineMode() {
    if (engineMode === ENGINE_WORKLET) {
      engineModeEl.className = 'engine-mode ok';
      engineModeEl.textContent = tr('engine.worklet');
    } else if (engineMode === ENGINE_FALLBACK) {
      engineModeEl.className = 'engine-mode warn';
      engineModeEl.textContent = tr('engine.fallback');
    } else {
      engineModeEl.className = 'engine-mode';
      engineModeEl.textContent = '';
    }
  }

  // 注意書きを開いているか（中身を差し替えても閉じないように覚えておく）
  let noticeOpen = false;
  // 注意書きの入れ物（details・summary・ul）。一度だけ作って、中身だけ差し替える
  let noticeDetails = null;
  let noticeSummaryEl = null;
  let noticeList = null;
  // 最後に読み上げ用へ渡した要約
  let lastNoticeSummary = '';

  // 注意書きは「件数と要点の1行」を出し、全文は開いて読む（第2弾a6）。
  // ⚠ 改修前は全文を ' / ' でつないだ1本の文字列で、430px幅に5行（90px）を占めた。
  //    中身は限界を正しく書くためのものなので、削らずに出し方を変える
  function renderRecordNotice() {
    if (!recordNoticeEl) return;
    const parts = recordNoticeItems({ deviceLoss, deviceMuted, sessionMeta, clockBreaks, stats, lang });
    const kind = deviceLoss ? ' err' : (parts.length ? ' warn' : '');
    recordNoticeEl.className = 'record-notice' + kind;
    if (!parts.length) {
      recordNoticeEl.replaceChildren();   // :empty で隠れる
      lastNoticeSummary = '';
      if (recordNoticeLiveEl) recordNoticeLiveEl.textContent = '';
      return;
    }
    // ⚠ 区間ごとに details を作り直さない。作り直すと、フォーカス・開閉の操作・
    //    文字の選択が失われ、同じ要約が読み上げ直される（公開前の点検で見つかった。
    //    クリップの割合は行ごとに変わるので、全文は毎区間のように変わる）
    ensureNoticeDom();
    if (noticeDetails.parentNode !== recordNoticeEl) recordNoticeEl.replaceChildren(noticeDetails);
    // 要約の1行（summary）と全文（開いたときの箇条）。変わったところだけ textContent で差し替える
    const summaryText = '⚠ ' + noticeSummary(parts, lang);
    if (noticeSummaryEl.textContent !== summaryText) noticeSummaryEl.textContent = summaryText;
    while (noticeList.children.length > parts.length) noticeList.lastElementChild.remove();
    parts.forEach((it, i) => {
      let li = noticeList.children[i];
      if (!li) {
        li = document.createElement('li');
        noticeList.appendChild(li);
      }
      if (li.textContent !== it.full) li.textContent = it.full;
    });
    if (noticeDetails.open !== noticeOpen) noticeDetails.open = noticeOpen;
    // 読み上げは要約が変わったときだけ（全文の割合が変わるたびには読まない）
    if (summaryText !== lastNoticeSummary) {
      lastNoticeSummary = summaryText;
      if (recordNoticeLiveEl) recordNoticeLiveEl.textContent = summaryText;
    }
  }

  // 注意書きの入れ物を一度だけ作る
  function ensureNoticeDom() {
    if (noticeDetails) return;
    noticeDetails = document.createElement('details');
    noticeSummaryEl = document.createElement('summary');
    noticeList = document.createElement('ul');
    noticeDetails.addEventListener('toggle', () => { noticeOpen = noticeDetails.open; });
    noticeDetails.append(noticeSummaryEl, noticeList);
  }

  // 注意書きの開閉を閉じた状態へ戻す（リセット・新しいセッションで、前の開閉を持ち越さない）
  function closeNotice() {
    noticeOpen = false;
    if (noticeDetails) noticeDetails.open = false;
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
      timeZone,
      // 帯域を計算するか（CSV のヘッダーの `# bands=` に出す。第2弾b2）。
      // ワークレットへ渡す processorOptions.bands と同じ判定を通す
      bandsEnabled: bandsEnabledFromQuery(window.location.search)
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
    setStatus('status.deviceLost', 'err');
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
      if (running) setStatus('status.suspended', 'warn');
    } else if (audioCtx.state === 'running') {
      if (ctxSuspendedSince) {
        ctxSuspendedSince = 0;
        probeClock(CLOCK_BREAK_SUSPEND);
        if (running) setStatus('status.resumed', 'warn');
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
    // グラフの点も、ここで積む（記録と同じ源にする）。
    // rAF で積むと、タブが裏に回ったあいだの点が抜けて直線で補間されてしまう。
    // ⚠ 線を切る判定に使う区間長も、画面の設定値ではなくその区間の実測を使う。
    //    ログ間隔を上げた直後に、まだ短い区間で測っていた行が「飛んだ」と誤判定される
    const intervalMs = Number.isFinite(rec.intervalSec) ? rec.intervalSec * 1000 : null;
    series.push(seriesPointOf(rec, series[series.length - 1] || null, intervalMs));
    series = pruneSeries(series, Date.now(), GRAPH_WINDOW_SEC * 1000);

    if (wasEmpty) updateButtonStates();
    // ⚠ 統計に入れるのは rawDb（記録される生値）である。
    //    表示用の db を使うと、表示下限を変えただけで統計が動いてしまう
    //    （addStatsRecord が rawDb を読む）
    updateStats(rec);
    // 超音波帯の現在値は、記録した区間そのもの（CSVに書く値）から出す（第2弾c0）
    lastRecord = rec;
    renderUltraNow();
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
      // 行を出す条件で使った値そのもの（この区間を測ったときの間隔）
      intervalSec: lastIntervalSec,
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

    // ⚠ キャッシュ用の版番号を index.html とそろえる。付けないと、公開直後に
    //    古いワークレットと新しい logic.js が組み合わさることがある
    await audioCtx.audioWorklet.addModule('./worklet/meter-processor.js?v=3.9');
    workletNode = new AudioWorkletNode(audioCtx, 'meter-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: {
        intervalFrames: framesForInterval(currentIntervalSec(), audioCtx.sampleRate),
        // 帯域の集計（第2弾b1）。FFT の長さとビンの割り当ては logic.js の bandPlan が決める。
        // ワークレットは logic.js を読めないので、同じ値を向こうに書かずにここで渡す。
        // ?bands=off なら帯域を計算しない（実機で帯域あり・なしの valid_ratio を比べるため）。
        // CSVでは帯域の3列が空欄になり、ヘッダーが`# bands=off`になる（第2弾b2）。
        // 画面では凡例と注意書きに「止めています」と出す（第2弾b3）
        bands: bandsEnabledFromQuery(window.location.search),
        bandPlan: bandPlan(audioCtx.sampleRate)
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

  // 取得の取り消し。UI を待機状態へ戻す（文言は辞書のキーで渡す）
  function cancelConnect(key, kind, params) {
    attemptGate.cancel();
    finishConnecting();
    setRunButtons(true);
    updateButtonStates();
    setStatus(key, kind || 'warn', params);
  }

  async function start() {
    if (running || connecting) return;

    // この試行の世代番号。取り消されたら以降の処理をすべて捨てる
    const token = attemptGate.begin();
    connecting = true;
    setRunButtons(false);       // 接続中も「停止」で取り消せる
    updateButtonStates();       // 接続中はリセットさせない
    setStatus('status.connecting', 'warn');

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
      setStatus('status.preparing', 'warn');
      // 少し待ってから再試行
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!attemptGate.isCurrent(token)) return;

    try {
      setStatus('status.connecting', 'warn');

      // 許可ダイアログを放置されたときの案内。これが無いと
      // 「マイクに接続中…」のまま何が起きているのか分からない
      clearConnectHint();
      connectHintId = setTimeout(() => {
        if (attemptGate.isCurrent(token)) {
          setStatus('status.promptHint', 'warn');
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
        cancelConnect('status.timeout', 'err', { sec: Math.round(CONNECT_TIMEOUT_MS / 1000) });
        return;
      }
      if (outcome.error) throw outcome.error;
      mediaStream = outcome.value;
      finishConnecting();

      // デバイス喪失の監視（記録中に切断されたら止める）
      deviceLoss = null;
      deviceMuted = false;
      closeNotice();   // 前のセッションの開閉を持ち越さない
      attachTrackWatch(mediaStream);

      // 新しいAudioContextを作成
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = METER_WINDOW_SAMPLES;

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
        console.warn('AudioWorklet could not be loaded; running in fallback mode', workletErr);
        workletNode = null;
      }
      // 測定条件を1セッションぶん記録する（CSV の列は増やさない）。
      // 要求した制約ではなく、track.getSettings() の実値を残すのが要点である
      sessionMeta = captureSessionMeta();
      // 超音波帯の現在値は、このセッションの最初の区間が届くまで「--.- dBFS」にする（前のセッションの値を残さない）
      lastRecord = null;
      // 記録できる上限は、このセッションのサンプルレートで決まる（第2弾b3）
      renderBandInfo();

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
      graphFrozenMs = null;
      setRunButtons(false);
      updateButtonStates(); // ボタン状態を更新（記録中はCSV書き出し無効）

      setStatus('status.measuring', 'ok');
      animate();
    } catch (err) {
      console.error(err);
      
      // パーミッション関連のエラーの場合、特別なメッセージを表示
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        setStatus('status.denied', 'err');
      } else if (err.name === 'NotFoundError') {
        setStatus('status.notFound', 'err');
      } else {
        // メッセージはブラウザーから来る文字列なので、辞書に入れずにそのまま出す
        setStatus('status.error', 'err', { message: String(err.message || err) });
      }
      
      running = false;
      finishConnecting();
      setRunButtons(true);
      updateButtonStates(); // エラー時にもボタン状態を更新
      await cleanup();
    }
  }

  async function stop() {
    // 接続中なら、記録の停止ではなく取得の取り消しとして扱う
    if (connecting) {
      cancelConnect('status.canceled');
      return;
    }
    if (!running) return;
    running = false;
    lastStopTime = Date.now();  // 停止時刻を記録
    graphFrozenMs = lastStopTime; // 停止中のグラフは、止めた時刻を右端にして描く
    setStatus('status.stopped', 'warn');
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    
    // 少し遅延を入れてからクリーンアップ（ブラウザーの状態更新を待つ）
    setTimeout(async () => {
      await cleanup();
    }, 100);
    
    setRunButtons(true);
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
        console.warn('Could not close the AudioContext', e);
      }
      audioCtx = null;
    }
  }

  // 大型表示とメーター。表示下限で切るのは表示だけ（記録される値は動かない）
  let lastMeterDb = null;
  function renderMeter(db) {
    if (db === null || db === undefined) return;   // まだ一度も測っていない
    const floorDb = getFloorDb();
    const dispDb = Math.max(db, floorDb);
    bigValue.textContent = Number.isFinite(db) ? `${dispDb.toFixed(1)} dBFS` : '--.- dBFS';
    const pct = dbToPercent(dispDb, floorDb);
    meterBar.style.width = `${pct.toFixed(1)}%`;
    // カラー（しきい値：-40dBFS, -20dBFS）
    if (db >= -20) meterBar.style.filter = 'hue-rotate(0deg)';        // 赤寄り
    else if (db >= -40) meterBar.style.filter = 'hue-rotate(-25deg)'; // 黄寄り
    else meterBar.style.filter = 'hue-rotate(-60deg)';                 // 緑寄り
  }

  // rAF は描画専用。記録はワークレットのオーディオクロックが担う
  function animate() {
    if (!running) return;

    const db = computeDb(); // dBFS (負の値、0が最大)
    lastMeterDb = db;
    renderMeter(db);
    const floorDb = getFloorDb();

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

  // crypto.subtle は安全なコンテキストでしか使えない。使えないときは
  // 鎖そのものを作らない（hash 列は空、`# hash=` の行も出ない）。
  // ⚠ file:// は安全なコンテキストである。Chromium で実測したところ
  //    isSecureContext は true で crypto.subtle も使え、file:// のまま
  //    書き出した CSV の hash 列は埋まった。ここで落ちるのは https でない
  //    ホスト名つきの URL（http://192.168.1.10:8000/ など）のほうである。
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
    // 組み立ては logic.js の chainHeaderMeta（報告しない項目があれば unknown と書く）
    return chainHeaderMeta({
      sessionMeta,
      firstRec,
      engineMode,
      hashAlgo: hashAvailable() ? HASH_ALGO_LABEL : null
    });
  }

  // 記録が終わってから分かる事実。トレーラー行へ出す。
  // ⚠ 起点（ヘッダー）に混ぜてはいけない。混ぜると、同じセッションを2回
  //    書き出したときに同じ行のハッシュが変わる。
  function csvTrailerExtraOf() {
    return {
      // 書き出し時点の設定でも、行を採ったときの設定でもなく、
      // 「その区間を実際に測ったときの間隔」を行から組み直す。
      // 変わったところだけを seq つきで並べる（例 1@0+3@12）
      intervalSec: intervalRunsLabel(logs)
    };
  }

  async function exportCSV() {
    if (!logs.length) {
      setStatus('status.noLogs', 'warn');
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
    for (const e of hashChain.errors) console.warn('Hash chain', e);

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

    setStatus('status.exported', 'ok', { count: logs.length });
  }

  // 記録の母集団をまとめて捨てる。
  //
  // ⚠ 捨てるのは記録を止めてから（書き出しボタンと同じ条件）。
  //    改修前は記録中にも押せた。ワークレットの seq は続くので CSV の seq が
  //    0 から始まらず、捨てた点と新しい点がグラフ上で1本の線につながった。
  // ⚠ ログ・統計・グラフ・注意書きを一緒に捨てる。
  //    改修前は logs と統計だけを捨てていたので、グラフの点（series）と
  //    時刻の跳び・切断の注意書きが、もう存在しないログについて残り続けた。
  //    グラフの点は pushRecord で CSV の行と同じ源から積んでいるので、母集団も同じである
  function resetAllStats() {
    if (running || connecting) return;
    resetStats();
    logs.length = 0;
    seqCounter = 0;
    seqBase = 0;
    seqMax = -1;
    // ログを捨てたら鎖も捨てる。次の1行目で新しい起点を凍結する
    hashChain.reset();
    // グラフの点を捨てて描き直す。停止中は rAF が止まっているので、
    // ここで描き直さないと画面が変わらない
    series = [];
    graphFrozenMs = null;
    drawSeries();
    // 捨てたログについての注意書きの元も捨ててから、注意書きを出し直す
    clockBreaks = [];
    pendingClockBreak = null;
    deviceLoss = null;
    deviceMuted = false;
    sessionMeta = null;
    startedAt = 0;
    // 超音波帯の現在値も最初の状態に戻す（renderBandInfoが描き直す。第2弾c0）
    lastRecord = null;
    closeNotice();
    renderRecordNotice();
    // 上限の表示も、捨てた測定条件から出ているので消す
    renderBandInfo();
    updateButtonStates();
    setStatus('status.reset', 'ok');
  }

  // ボタン状態の管理
  function updateButtonStates() {
    // ⚠ Chromiumは押せなくなったボタンからその場でフォーカスを外す（統計リセットを押した直後など）。
    //    「その他」の中にフォーカスがあったかは、押せる状態を変える前に見ておく（第2弾c0）
    const menuHadFocus = !!moreMenuEl && moreMenuEl.contains(document.activeElement);

    // CSV書き出しボタンは記録停止中かつログが存在する場合のみ有効
    exportBtn.disabled = running || logs.length === 0;

    // リセットも記録を止めてから（接続中も押させない）。ログが無ければ押せない
    resetBtn.disabled = running || connecting || logs.length === 0;

    // 記録開始と停止は同じ場所に置き、押せるほうだけを見せる（第2弾c0）
    renderStartStop();
    // 「その他」の中身がどちらも押せなくなったら閉じる（統計リセットのあと・記録を始めたとき）
    applyMoreMenu('items', { focusInside: menuHadFocus });
  }

  // 記録開始と停止の押せる状態（第2弾c0で1か所にまとめた）。2つはいつも逆になる
  // （記録前・停止後は記録開始だけ、接続中・記録中は停止だけが押せる）。
  // ⚠ Chromiumは、フォーカスのあるボタンをdisabledにした瞬間にフォーカスを外す（document.activeElementがbodyになる。
  //    手元のChromiumで確かめた）。出し分けのあとで「押したボタンにフォーカスがあったか」を見ても分からないので、
  //    押せる状態を変える前に覚えておく（renderStartStopが使う）
  let runFocusPending = false;
  function setRunButtons(startEnabled) {
    const focused = document.activeElement;
    if (focused === startBtn || focused === stopBtn) runFocusPending = true;
    startBtn.disabled = !startEnabled;
    stopBtn.disabled = !!startEnabled;
  }

  // 記録開始と停止の出し分け（第2弾c0）。どちらを見せるかはlogic.jsのstartStopViewが決める
  // （接続中は「停止」で取り消せるので、停止を見せる）。見せないほうはhiddenで支援技術からも隠す。
  // ⚠ 押したボタンが隠れると、フォーカスが行き場を失う。同じ場所に出たほうへ移し、キーボードで続けて操作できるようにする
  //    （フォーカスが記録開始か停止にあったときだけ。ほかの場所にある利用者のフォーカスは奪わない）
  function renderStartStop() {
    const view = startStopView({ running, connecting });
    const focused = document.activeElement;
    const hadFocus = runFocusPending || focused === startBtn || focused === stopBtn;
    runFocusPending = false;
    startBtn.hidden = !view.start;
    stopBtn.hidden = !view.stop;
    const shown = view.stop ? stopBtn : startBtn;
    if (hadFocus && focused !== shown && !shown.disabled) shown.focus();
  }

  // 「その他」の開閉（第2弾c0）。開いているかはaria-expandedだけで持ち、CSSも同じ属性で中身を出し入れする。
  // 判定はlogic.jsのmoreMenuNext（Escで閉じたら、フォーカスが中身か「その他」にあったときだけ「その他」へ戻す・
  // 幅481px以上では何もしない など）
  const compactQuery = (typeof window.matchMedia === 'function') ? window.matchMedia(COMPACT_MEDIA_QUERY) : null;
  function moreMenuOpen() {
    return !!moreBtn && moreBtn.getAttribute('aria-expanded') === 'true';
  }
  // seen.focusInsideを渡すと、いまのフォーカスの代わりにそれを使う（押せる状態を変える前に見た値）
  function applyMoreMenu(event, seen) {
    if (!moreBtn || !moreMenuEl) return;
    const next = moreMenuNext({
      open: moreMenuOpen(),
      compact: !!(compactQuery && compactQuery.matches),
      modalOpen: !!(helpModal && helpModal.classList.contains('show')),
      itemsEnabled: !exportBtn.disabled || !resetBtn.disabled,
      focusInside: (seen && typeof seen.focusInside === 'boolean')
        ? seen.focusInside
        : moreMenuEl.contains(document.activeElement),
      // Escで「その他」へフォーカスを戻すのは、フォーカスが中身か「その他」にあるときだけ（外にあるフォーカスは奪わない）
      focusOnToggle: document.activeElement === moreBtn
    }, event);
    if (moreMenuOpen() !== next.open) moreBtn.setAttribute('aria-expanded', String(next.open));
    if (next.focusToggle) moreBtn.focus();
  }

  function setupMoreMenu() {
    if (!moreBtn || !moreMenuEl) return;
    moreBtn.addEventListener('click', () => applyMoreMenu('toggle'));
    // ⚠ 捕獲（capture）で受ける。ヘルプのEsc（バブリング）より先に呼ばれるので、ヘルプが開いているかを
    //    閉じられる前に見られる（ヘルプを閉じるEscで「その他」まで閉じて、フォーカスを奪わない）
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') applyMoreMenu('escape');
    }, true);
    // 「その他」と中身の外を押したら閉じる。⚠ pointerdownではなくclickで受ける。
    //    押した瞬間に閉じると中身の行が消えて下の画面が上がり、指の下の要素が入れ替わって別のものを押してしまう
    //    ⚠ 利用者の操作でないclick（isTrustedがfalse）では閉じない。CSV書き出しはダウンロードのために
    //    リンクを作ってclick()を呼ぶので、それで閉じると、押した書き出しボタンが隠れてフォーカスを失う
    document.addEventListener('click', (e) => {
      if (!e.isTrusted) return;
      if (moreBtn.contains(e.target) || moreMenuEl.contains(e.target)) return;
      applyMoreMenu('outside');
    });
    // 幅481px以上へ広げたら閉じておく（中身は並んで見えている。狭めたときに開いたまま出てこないように）
    if (compactQuery && typeof compactQuery.addEventListener === 'function') {
      compactQuery.addEventListener('change', () => applyMoreMenu('layout'));
    }
  }

  // テーマ切り替え
  // ⚠ localStorage が使えない環境（保存の拒否など）では、読み書きが例外を投げる。ここで止まると
  //    初期化の残り（ボタンの状態など）まで動かなくなるので、読めなければ既定（ライト）で続ける（第2弾c3a）
  let isDarkMode = false;
  
  function toggleTheme() {
    isDarkMode = !isDarkMode;
    if (isDarkMode) {
      document.body.classList.remove('light');
    } else {
      document.body.classList.add('light');
    }
    try { localStorage.setItem('theme', isDarkMode ? 'dark' : 'light'); } catch { /* 保存できなくても切り替えはできる */ }
    drawSeries();
  }
  
  function applyTheme() {
    let savedTheme = null;
    try { savedTheme = localStorage.getItem('theme'); } catch { savedTheme = null; }
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
  // 表示下限を変えたら、目盛りと（停止中でも）グラフを描き直す
  floorDbInput.addEventListener('input', renderMeterScale);
  // 停止中でも、メーターのバー・大型表示・グラフを新しい下限で描き直す
  // （目盛りだけが変わってバーと食い違うのを防ぐ。公開前の点検で見つかった）
  floorDbInput.addEventListener('input', () => { renderMeter(lastMeterDb); drawSeries(); });
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
        setMessage(toggleText, 'controls.hide');
        toggleIcon.textContent = '▲';
      } else {
        controls.classList.add('collapsed');
        setMessage(toggleText, 'controls.show');
        toggleIcon.textContent = '▼';
      }
    });
  }
  
  // ⚠ 幅480pxでヘルプとテーマのボタンの親要素を付け替える仕組み（handleMobileButtonLayout）は、
  //    第2弾c0で廃止した。resizeが届かない経路で不整合が固定される壊れやすい仕組みだったので、
  //    どの幅でも同じ.actionsに置き、並びはstyle.cssだけで決める

  // 「その他」の開閉（第2弾c0）
  setupMoreMenu();

  // ヘルプモーダル機能を初期化
  setupHelpModal();
  
  // コントロール折りたたみ機能を初期化
  setupControlsToggle();

  // リサイズ対応
  window.addEventListener('resize', () => {
    resizeCanvas();
    drawSeries();
  });

  // 表示の言語を反映する（第2弾c3a）。HTML の文言と、logic.js で組み立てる文言（言語を引数で渡す）の両方を描き直す。
  // ⚠ 記録・統計・グラフの点・ハッシュチェーンには触らない（描き直すのは表示だけ）
  function applyLanguage() {
    document.documentElement.lang = lang;
    applyStaticText();
    renderMeterScale();
    renderEngineMode();
    renderBandInfo();
    renderIntegrity();
    // 注意書きの元の文字列も新しい言語にそろえておく（次の区間で同じ中身を描き直さないため）
    statsNoticeText = statsWarnings(stats, lang).join('\n');
    renderRecordNotice();
  }

  // 言語の切り替えボタン。選んだ言語は保存し、URL に ?lang= があれば書き換える（再読み込みで戻らないように）
  function switchLanguage() {
    lang = lang === 'ja' ? 'en' : 'ja';
    saveLang(lang);
    const search = searchWithLang(window.location.search, lang);
    if (search !== window.location.search) {
      try { history.replaceState(history.state, '', search + window.location.hash); } catch { /* 書き換えられなくても表示は切り替える */ }
    }
    applyLanguage();
  }
  if (langToggle) langToggle.addEventListener('click', switchLanguage);

  // HTML の日本語を、初期言語で入れ直してから初期の描画に入る
  document.documentElement.lang = lang;
  applyStaticText();

  // 初期
  renderEngineMode();
  renderBandInfo();
  // 表示下限の既定を入れてから目盛りを描く（第2弾c0）。defaultValue（value属性）を書き換えるので、
  // ブラウザーが入力欄の値を復元したとき（利用者が変えた値）は上書きしない
  floorDbInput.defaultValue = String(floorDbDefault);
  renderMeterScale();
  applyTheme();
  resizeCanvas();
  observeCanvasSize();
  drawSeries();
  updateButtonStates(); // 初期状態でのボタン状態設定

  // 権限が拒否された場合のヒント
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus('status.unsupported', 'err');
    startBtn.disabled = true;
  }
})();
