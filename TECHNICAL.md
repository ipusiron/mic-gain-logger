# 技術実装解説 - Mic Gain Logger

本ドキュメントでは、Mic Gain Loggerの技術的な実装について詳しく解説します。

---

## 🏗️ アーキテクチャ概要

### システム構成
```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   ユーザー      │    │    ブラウザー   │    │  Web Audio API │
│   インターフェース│◄──►│   エンジン      │◄──►│   処理系        │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         ▲                       │                       │
         │                       ▼                       ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   CSV出力       │    │   Canvas API    │    │  マイクロフォン │
│   (Blob API)    │    │   (可視化)      │    │   ハードウェア  │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

### 主要コンポーネント
1. **UI Controller** - ユーザーインターフェイス制御
2. **Audio Processor** - Web Audio APIによる音声処理
3. **Data Manager** - 統計・ログデータ管理
4. **Canvas Renderer** - リアルタイムグラフ描画
5. **Export Handler** - CSV出力処理

---

## 🎵 Web Audio API実装詳解

### AudioContextの初期化
```javascript
// AudioContextの作成（ブラウザー互換性考慮）
audioCtx = new (window.AudioContext || window.webkitAudioContext)();

// アナライザーノードの設定
analyser = audioCtx.createAnalyser();
analyser.fftSize = 2048;  // FFTサイズ（2048 = 高解像度）
analyser.smoothingTimeConstant = 0.5;  // 平滑化レベル
```

### メディアストリーム処理
```javascript
// マイクアクセス取得
mediaStream = await navigator.mediaDevices.getUserMedia({
  audio: {
    echoCancellation: false,    // エコー除去無効
    noiseSuppression: false,    // ノイズ除去無効  
    autoGainControl: false      // 自動音量調整無効
  }
});

// ソースノードとアナライザーの接続
sourceNode = audioCtx.createMediaStreamSource(mediaStream);
sourceNode.connect(analyser);
```

### 音量計算アルゴリズム
```javascript
function computeDb() {
  // 時間領域データ取得（2048サンプル）
  analyser.getFloatTimeDomainData(buffer);
  
  // RMS（二乗平均平方根）計算
  let sumSq = 0;
  for (let i = 0; i < buffer.length; i++) {
    const x = buffer[i];
    sumSq += x * x;
  }
  const rms = Math.sqrt(sumSq / buffer.length);
  
  // dBFS変換: 20 * log10(RMS)
  return rms <= 1e-8 ? -Infinity : 20 * Math.log10(rms);
}
```

---

## 📊 データ処理とアルゴリズム

### 統計計算の実装
```javascript
// 累積統計の更新
function updateStats(db) {
  if (!Number.isFinite(db)) return;
  
  sum += db;                    // 累積和
  n += 1;                       // サンプル数
  minDb = Math.min(minDb, db);  // 最小値更新
  maxDb = Math.max(maxDb, db);  // 最大値更新
  
  // 平均値計算
  const avg = sum / n;
  
  // 変動幅計算
  const range = maxDb - minDb;
}
```

### ログデータ構造
```javascript
// ログエントリ形式
const logEntry = {
  ts: new Date(),           // タイムスタンプ（ISO8601形式）
  db: Math.max(db, floorDb) // 音量レベル（表示下限適用）
};

// CSV出力形式
"timestamp,dbfs"
"2024-01-15T10:30:15.123Z,-42.3"
"2024-01-15T10:30:16.123Z,-38.7"
```

---

## 🎨 Canvas描画システム

### レスポンシブキャンバス実装
```javascript
function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;  // デバイスピクセル比
  
  // 実際のピクセルサイズ設定（高DPI対応）
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  
  // CSS表示サイズ
  canvas.style.width = rect.width + 'px';
  canvas.style.height = rect.height + 'px';
  
  // 描画コンテキストスケール調整
  ctx.scale(dpr, dpr);
}
```

### リアルタイムグラフ描画
```javascript
function drawSeries() {
  // 背景クリア
  ctx.fillStyle = getComputedStyle(document.body)
    .getPropertyValue('--card');
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  
  // グリッド線描画
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  for (let x = 0; x < WIDTH; x += 80) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, HEIGHT);
  }
  
  // 音量波形描画
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#4da3ff';
  ctx.beginPath();
  
  for (let x = 0; x < WIDTH; x++) {
    const v = series[x];  // 0-1の正規化値
    const y = HEIGHT - (HEIGHT * v);
    
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}
```

---

## 📱 レスポンシブデザイン実装

### CSS Grid レイアウト戦略
```css
/* デスクトップレイアウト */
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;     /* 2列レイアウト */
  grid-template-rows: auto auto;       /* 2行レイアウト */
}

/* タブレットレイアウト (768px以下) */
@media (max-width: 768px) {
  .grid {
    grid-template-columns: 1fr;       /* 1列レイアウト */
    grid-template-rows: auto auto auto; /* 3行レイアウト */
  }
}
```

### モバイル最適化技術
```css
/* スマートフォン最適化 (480px以下) */
@media (max-width: 480px) {
  /* タッチターゲットサイズ確保 */
  .btn {
    min-height: 44px;  /* iOS推奨最小タッチサイズ */
    min-width: 44px;
  }
  
  /* コンテンツ折りたたみ */
  .controls.collapsed {
    display: none;
  }
  
  /* 動的ボタン配置 */
  .mobile-controls {
    display: flex;
    justify-content: center;
    gap: 12px;
  }
}
```

### JavaScript動的レイアウト制御
```javascript
function handleMobileButtonLayout() {
  const isMobile = window.innerWidth <= 480;
  
  if (isMobile) {
    // モバイル: 専用エリアに移動
    mobileControls.appendChild(helpBtn);
    mobileControls.appendChild(themeToggle);
  } else {
    // デスクトップ: 元の位置に復帰
    actions.appendChild(helpBtn);
    actions.appendChild(themeToggle);
  }
}
```

---

## 💾 データ永続化とエクスポート

### LocalStorage活用
```javascript
// テーマ設定の永続化
function saveTheme(theme) {
  localStorage.setItem('theme', theme);
}

function loadTheme() {
  return localStorage.getItem('theme') || 'dark';
}
```

### CSV生成アルゴリズム
```javascript
function exportCSV() {
  // CSVヘッダー
  const header = 'timestamp,dbfs\n';
  
  // データ行生成
  const lines = logs.map(entry => 
    `${entry.ts.toISOString()},${entry.db.toFixed(2)}`
  ).join('\n');
  
  // Blob作成（UTF-8 BOM付き）
  const csv = '\uFEFF' + header + lines;  // BOM for Excel
  const blob = new Blob([csv], {
    type: 'text/csv;charset=utf-8'
  });
  
  // ダウンロード実行
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `mic-gain-logs-${timestamp}.csv`;
  a.click();
  
  // メモリクリーンアップ
  URL.revokeObjectURL(url);
}
```

---

## 🔧 パフォーマンス最適化

### アニメーションループ最適化
```javascript
function animate() {
  if (!running) return;
  
  // 60fps制限（ブラウザーのrequestAnimationFrame使用）
  rafId = requestAnimationFrame(animate);
  
  // 音量計算（軽量化）
  const db = computeDb();
  
  // UI更新（最小限）
  updateDisplay(db);
  
  // ログ記録（間隔制御）
  if (shouldLog()) {
    logs.push(createLogEntry(db));
  }
}
```

### メモリ管理
```javascript
async function cleanup() {
  // 重要：正しい順序でクリーンアップ
  
  // 1. メディアストリーム停止
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }
  
  // 2. オーディオノード切断
  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }
  
  // 3. AudioContext終了
  if (audioCtx && audioCtx.state !== 'closed') {
    await audioCtx.close();
    audioCtx = null;
  }
}
```

---

## 🛡️ エラーハンドリング戦略

### マイクアクセス例外処理
```javascript
try {
  mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
} catch (err) {
  // エラー種別に応じた処理
  switch (err.name) {
    case 'NotAllowedError':
      setStatus('マイクアクセスが拒否されました', 'err');
      break;
    case 'NotFoundError':
      setStatus('マイクが見つかりません', 'err');
      break;
    case 'NotReadableError':
      setStatus('マイクが他のアプリで使用中です', 'err');
      break;
    default:
      setStatus(`予期しないエラー: ${err.message}`, 'err');
  }
}
```

### ブラウザー互換性対策
```javascript
// Web Audio API対応確認
if (!window.AudioContext && !window.webkitAudioContext) {
  setStatus('このブラウザーは音声処理に対応していません', 'err');
  return;
}

// getUserMedia対応確認
if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
  setStatus('このブラウザーはマイクアクセスに対応していません', 'err');
  return;
}
```

---

## 📐 設計原則と品質保証

### コードの設計原則
1. **Single Responsibility** - 各関数は単一の責務を持つ
2. **Error First** - エラーハンドリングを最優先で実装
3. **Progressive Enhancement** - 基本機能から段階的に拡張
4. **Performance Budget** - メモリ使用量を常に監視

### テストしやすい設計
```javascript
// 純粋関数として実装（テスタブル）
function rmsToDbfs(rms) {
  if (rms <= 1e-8) return -Infinity;
  return 20 * Math.log10(rms);
}

// 依存関係の注入
function createAudioProcessor(audioContext, analyser) {
  return {
    computeVolume: () => computeDb(analyser),
    cleanup: () => cleanup(audioContext)
  };
}
```

---

## 🔮 将来拡張の考慮点

### 拡張可能なアーキテクチャ
- **プラグインシステム**: 新しい分析手法の追加
- **ワーカースレッド**: 重い計算処理のオフロード
- **IndexedDB**: 大容量ログデータの永続化
- **WebRTC**: リアルタイム音声ストリーミング

### パフォーマンス改善余地
- **Web Workers**: 音声処理の並列化
- **OffscreenCanvas**: 描画処理の最適化
- **Compression**: ログデータの圧縮
- **Caching**: 計算結果のキャッシュ化

---

## 📚 参考資料とドキュメント

### Web Audio API
- [MDN Web Audio API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API)
- [W3C Web Audio API Specification](https://www.w3.org/TR/webaudio/)

### Canvas API
- [MDN Canvas API](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API)
- [HTML5 Canvas Deep Dive](https://joshondesign.com/p/books/canvasdeepdive/title.html)

### 音響学・信号処理
- [Digital Signal Processing](https://www.dspguide.com/)
- [dBFS Specification](https://en.wikipedia.org/wiki/DBFS)

---

*このドキュメントは、Mic Gain Loggerの技術実装を理解し、保守・拡張するためのリファレンスとして作成されました。*