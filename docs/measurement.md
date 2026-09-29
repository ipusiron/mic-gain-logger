# 🔬 計測の作りと技術的な基礎知識

[READMEへ戻る](../README.md) · [English](en/measurement.md)

計測の作り（AudioWorkletでの区間の集計）と実測値、dBFSの基礎知識、画面の数字とCSVの値の違い、セキュリティ的背景、技術スタックをまとめます。

## 🔬 計測の作りと実測値

### 計測エンジン

区間の集計はAudioWorklet（オーディオスレッド）で行います。128サンプルごとに必ず呼ばれるため、タブが背面に回って`requestAnimationFrame`が止まっても記録は続きます。区間の切れ目はオーディオクロックのフレーム番号で決めるので、区間長のずれが積み上がりません。描画は表示のためだけに行われます。

AudioWorkletを読み込めない環境（古いブラウザー、`file://`で直接開いた場合など）では簡易モードへ切り替わります。簡易モードは描画ループで記録するため、描画が止まると記録も止まります。どちらで動いているかは、画面上部の表示とCSVのヘッダー`# engine=`でわかります（記録中にモードが変わった場合は、トレーラーに`# engines=worklet+fallback`が付きます）。

### 実測値

| 測ったこと | 結果 |
|---|---|
| `requestAnimationFrame`を20秒止めたとき | 記録の穴ゼロ（区間は1つも欠けない） |
| CPUを20倍にスロットルしたとき | 区間はきっかり設定どおり |
| AudioContextの中断 | 検出してCSVのトレーラー行に残し、アンカーを取り直す |
| 基準音に対するdBFSの計算精度 | ±0.0002dB |
| スマートフォン幅（320〜414px）での操作 | 起動→ログ間隔1秒→記録→停止→CSVまで通る |

dBFSの±0.0002dBは「デジタルサンプルからdBFSを求める計算が正しい」ことを示す数字です。音の大きさを正しく測れていることを示すものではありません。詳しくは後述の「dBFSでできる比較・できない比較」をご覧ください。

⚠**いずれもデスクトップのChromium（Playwright）で採った値です。**最後の行の「スマートフォン幅」は画面幅を320〜414pxにしたもので、実機ではありません。検証の範囲は[README](../README.md)の「ブラウザー対応状況」に1か所まとめてあります。iPhoneの実機で採った値は、[実機テストの資料](real-device-test.md)にあります。

### スムージングの設定を置かない理由

音の揺れをならす「スムージング」の設定は置いていません。Web Audio APIでならす手段の`AnalyserNode.smoothingTimeConstant`は周波数領域の値にしか作用せず、時間領域のRMSで測る本ツールでは、表示にも記録にも反映されないためです。音の揺れをならす扱いは、時間重み（Fast=125ms／Slow=1s）として入れる案があります（[将来案の資料](roadmap.md)の「その先の案」）。⚠**入れるとしても表示までです。**区間のLeqは区間の完全な要約なので、時間重みをかけても区間の平均は変わりません。記録に追加で載せられるのは、区間内のLFmax／LSmaxまでです。

## 📚 技術的な基礎知識

### dBFSとは？
dBFS（decibels relative to Full Scale）は、デジタル音響システムで使用される音量の単位です。

- **基準点**：デジタル系での最大音量を0 dBFSとする
- **表現範囲**：通常は-∞ dBFSから0 dBFSまでの負の値で表現
- **実用的な範囲**：以下の目安は、一般的なノートPCの内蔵マイクで手元の環境を測ったときの感覚値である。マイクが違えば10dB以上ずれるため、絶対的な基準としては使えない
  - **-60 dBFS以下**：ほぼ無音（環境ノイズレベル）
  - **-40 dBFS**：静かな環境（図書館・深夜の住宅）
  - **-20 dBFS**：一般的な会話・BGM
  - **-10 dBFS**：やや大きな音（活発な議論・音楽）
  - **0 dBFS**：デジタル上の最大音量（クリッピング直前）

### dBFSでできる比較・できない比較

dBFSは、そのデジタル系で表せる最大振幅を0 dBFSとしたときの相対値です。0 dBFSが何Paの音圧に当たるかは、マイクの感度、プリアンプの利得、OS側のミキサーの設定、自動ゲイン調整（AGC）の有無で変わります。本ツールはブラウザーからこれらの絶対値を取得できないため、dBFSをdB SPLへ変換できません。

したがって、**同じ音を別の端末で測れば、別のdBFS値が出ます。**メーカーの違うマイクどうしはもちろん、同じ端末でも外付けマイクを挿し替えれば値は変わります。

言えるのは、次の範囲までです。

- **同一端末・同一セッション内の相対比較**：記録中にマイクを替えず、OSの入力音量も動かしていなければ、「いまの音は3分前より12dB大きい」は正しく読める
- **セッションをまたぐ比較**：測定条件がそろっている場合に限られる。本ツールはCSVのメタ行に、デバイス名・サンプルレート・`getSettings()`が返した実際の値（AGC・ノイズ抑制・エコーキャンセルの適用状態）を書き出す。この3つが一致していれば、同じ端末の別セッションどうしは比較できる。1つでも違えば比較できない。⚠`# processing=`に`unknown:`の項目がある記録（iPhoneのSafariなど）では、その項目が実際にどうだったかが分からないので、メタ行の文字列が同じでも条件がそろったとは言い切れない
- **絶対的な音の大きさ**：出せない。「-35 dBFSだったから静かなオフィスである」とは言えない。マイクの感度が10dB違えば、同じオフィスで-25 dBFSにも-45 dBFSにもなる

なお、dBFSの計算そのものの精度は基準音に対して±0.0002dBです。これは「デジタルサンプルからdBFSを求める計算が正しい」ことを示す数字であって、「音の大きさを正しく測れている」ことを示す数字ではありません。この2つは別の話です。

### ほかの音量単位との違い

| 単位 | 基準 | 何を表すか |
|---|---|---|
| dB SPL | 20μPa（人の可聴閾に由来する固定値） | 物理的な音圧。騒音規制や労働環境の基準値はこちら |
| dBFS | そのデジタル系の最大振幅 | デジタル系の中での相対的な信号レベル。端末ごとに基準が違う |

### 画面の大きな数字とCSVの`dbfs`の違い

高精度モード（AudioWorklet）では、画面の大きな数字とCSVの`dbfs`は、同じ音を別の窓で見た値です。

| | 画面の大きな数字 | CSVの`dbfs`（高精度モード） |
|---|---|---|
| 窓 | 直近2048サンプル（48kHzで約43ミリ秒） | 1区間まるごと（ログ間隔。1秒など） |
| 計算 | 窓の中のRMS | 区間全体のエネルギー平均 |
| 変わる間隔 | 画面を描き直すたび | 区間の終わりに1回 |

音の大きさが一定なら、2つはほぼ同じ値になります。ときどき大きくなる音では、エネルギー平均が大きな瞬間に引っぱられるので、画面の数字のほうが低く見える時間が長くなります。

たとえば、1秒の区間のうち0.1秒だけ-50dBFSの音が鳴り、残りの0.9秒は-80dBFSだったとします。CSVの`dbfs`は、10×log10(0.1×10^(-50/10)＋0.9×10^(-80/10))＝-59.96dBFSです。画面の数字は、0.9秒のあいだは-80前後、音が鳴った0.1秒だけ-50前後を示すので、画面を見ている時間の大半は、CSVより約20dB低い値を読むことになります。どちらも正しい値で、窓が違うだけです。

簡易モードでは、この違いはありません。簡易モードのCSVの`dbfs`は、記録した瞬間にこの窓（直近2048サンプル）から読んだ値です。

## 🔒 セキュリティ的背景

本ツールは、セキュリティ分野における物理的セキュリティ（Physical Security）の一部として位置づけられます。
とくに、音響を対象とした監視・記録を行う音響監視（Acoustic Surveillance）／技術的監視（Technical Surveillance）のカテゴリに該当します。
ただし、計測器としては簡易なもので、検定を受けた騒音計の代わりにはなりません。

現場の音環境をリアルタイムで可視化・記録することで、「会話や活動が発生しているか」の有無を把握するための支援ツールです。
セキュリティ調査や現場の下見で、音の立ち上がりと静まりを時刻つきで残す用途を想定しています。
本ツールの出力は活動の有無を示す記録であって、音圧の測定値でも、手続きに使える証明でもありません。

## 🌐 技術スタック
- **HTML / CSS / JavaScript**：フロントエンド基盤（VanillaJS・ビルド工程なし）
- **Web Audio API / AudioWorklet**：音声入力・オーディオスレッドでの区間集計
- **Canvas API**：リアルタイムグラフ描画
- **Web Crypto API（`crypto.subtle`）**：ハッシュチェーンのSHA-256
- **Blob API**：CSV出力・ファイルダウンロード
- **CSS Grid & Flexbox**：レスポンシブレイアウト
- **LocalStorage**：テーマと表示の言語の保存（使えない環境でも、保存しないだけで動く）
- **Content Security Policy**：`connect-src 'none'`で外部への送信を遮断
- **node:test**：依存パッケージなしのテスト（`npm test`）

### 📖 実装の詳細を読むには

実装の理由（なぜそう書いたか）は、コードのコメントとテストに書いてあります。

| 知りたいこと | 読む場所 |
|---|---|
| 区間の切り方（1行＝1区間） | `worklet/meter-processor.js`、`logic.js`の「区間」の節、`test/interval.test.js` |
| dBFSの求め方と統計（Leq） | `logic.js`の「統計」の節、`test/dbfs-fixture.test.js`・`test/stats-csv.test.js` |
| 統計（Leq）の重み＝区間長 | `logic.js`の「統計」の節、`test/stats-weight.test.js` |
| 停止→再開をまたいだ重み（`# sessionStartAt=`） | `logic.js`の「セッションの境界」の節、`test/session-weight.test.js` |
| 行に貼るログ間隔（`# intervalSec=1@0+3@12`） | `logic.js`の「ログ間隔のラン」の節、`test/interval-label.test.js` |
| ピーク・クリップ・有効サンプル率と記録の穴の表示 | `logic.js`の`statsWarnings`・`statsIntegrity`、`test/stats-notice.test.js` |
| 時刻のアンカーと取り直し | `logic.js`の「時刻のアンカー」の節、`test/clock.test.js` |
| デジタル無音・デバイス喪失 | `logic.js`の「デジタル無音の扱い」「マイクのデバイス喪失」の節、`test/silence.test.js`・`test/device.test.js` |
| 測定条件のメタデータ | `logic.js`の「測定条件」の節、`test/meta.test.js` |
| CSV v3とハッシュチェーン | `logic.js`の「CSV」の節、`test/hashchain.test.js` |
| 帯域の集計（FFT・ビンの割り当て・フレームの重ね方・途切れの扱い） | `worklet/meter-processor.js`の「FFTの土台」「帯域の集計」の節、`logic.js`の「帯域」の節（`BAND_DEFS`・`bandPlan`）、`test/fft.test.js`・`test/band.test.js` |
| CSVの帯域の3列、ヘッダーに足した4項目（`# nyquistHz=`・`# settingsRaw=`・`# bands=`・`# fftSize=`）、欠測の空欄化、v2とv3の検証 | `logic.js`の`csvDataFields`・`chainHeaderMeta`と「getSettings()の生の値」の節、`test/csv-v3.test.js` |
| 記録中に鎖を進める入れ物 | `logic.js`の`createHashChain`、`test/chain-runner.test.js` |
| グラフの座標・目盛り・キャンバス | `logic.js`の「グラフ」「キャンバスの大きさ」の節、`test/graph.test.js`・`test/canvas.test.js` |
| 統計リセット（ログ・統計・グラフ・注意書きをまとめて捨てる） | `script.js`の`resetAllStats`、`test/reset.test.js` |
| 注意書きの項目と、加工の状態の書き方（`off`／`active:`／`unknown:`） | `logic.js`の`recordNoticeItems`・`chainHeaderMeta`・`processingLabel`、`test/processing-label.test.js`・`test/notice-details.test.js` |
| クリップの単発と連続 | `worklet/meter-processor.js`の`clipRun`、`logic.js`の`statsWarningItems`、`test/clip-notice.test.js`・`test/meter-processor.test.js` |
| 画面の帯域（超音波帯の破線・欠測で線を切る・超音波帯の最大・帯域の注意書き・記録できる上限・`?bands=off`の表示） | `logic.js`の`graphLinePoints`・`formatUltraMax`・`ultraBandState`・`bandNoticeItems`・`statsWarningItems`・`recordableUpperHz`・`upperLimitText`と「画面の帯域」の節、`script.js`の`drawSeries`・`renderBandInfo`、`test/band-ui.test.js` |
| 幅で切り替えるCSSの記述順 | `style.css`の末尾、`test/css-order.test.js` |
| メーターの目盛りと表示下限（既定は帯域あり-110dBFS・`?bands=off`で-90dBFS） | `logic.js`の`meterScaleLabels`・`floorDbDefaultFor`、`test/meter-floor.test.js`・`test/review-ui.test.js` |
| ボタンの配置（記録開始と停止を1つの場所に・「その他」） | `logic.js`の`startStopView`・`moreMenuNext`、`script.js`の`updateButtonStates`・`applyMoreMenu`、`test/mobile-view.test.js` |
| 超音波帯の現在値と、大きな数字の窓（2048サンプル） | `logic.js`の`ultraNowText`・`METER_WINDOW_SAMPLES`、`script.js`の`renderUltraNow`、`test/ultra-now.test.js` |
| 画面の日英対応（辞書・言語の決め方・`?lang=`・`<html lang>`の切り替え） | `messages.js`の`DICTIONARIES`・`t`・`initialLang`、`script.js`の`applyStaticText`・`applyLanguage`・`switchLanguage`、`test/i18n.test.js` |
| READMEとdocs/の実機テストの表・CSVのレシピの出力・見出しの順と活用例・分割の約束 | `test/readme-realdevice.test.js`・`test/readme-recipes.test.js`・`test/readme-structure.test.js`・`test/readme-docs.test.js` |
| 開発時の約束ごと（どのファイルに何を書くか） | [CLAUDE.md](../CLAUDE.md) |

テストの動かし方と、テストが確かめている表は、[README](../README.md)の「🧪 テスト」にあります。

### 参考資料

- [MDN Web Audio API](https://developer.mozilla.org/ja/docs/Web/API/Web_Audio_API)
- [MDN AudioWorklet](https://developer.mozilla.org/ja/docs/Web/API/AudioWorklet)
- [W3C Web Audio API Specification](https://www.w3.org/TR/webaudio/)
- [MDN Canvas API](https://developer.mozilla.org/ja/docs/Web/API/Canvas_API)
- [MDN SubtleCrypto](https://developer.mozilla.org/ja/docs/Web/API/SubtleCrypto)
- [dBFS - Wikipedia](https://en.wikipedia.org/wiki/DBFS)
