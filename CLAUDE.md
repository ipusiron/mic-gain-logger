# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Mic Gain Logger is a web-based audio level monitoring tool designed for physical security and acoustic surveillance. It visualizes and logs microphone input levels (in dBFS) without recording actual audio, making it suitable for field investigations and security monitoring.

Part of the "生成AIで作るセキュリティツール100" (100 Security Tools with AI) project - Day041.

The tool records **relative** levels. dBFS is not dB SPL, and its output must not be presented as a measurement that can be compared with regulatory limits. READMEの「🚫 規制値・基準値とは比較できない」と「⚖️ 利用上の注意（法的な助言ではありません）」を読んでから、ツールが何を示せるかに関わる文言に触れること。

## Architecture

Client-side only web application (vanilla JavaScript, no build step):

```
index.html ──> logic.js                      純ロジック（DOMに触らない・Nodeから読める）
           ──> script.js                     DOMとブラウザーAPI（IIFE・logic.jsを読む）
           ──> style.css                     テーマとレイアウト
           ──> worklet/meter-processor.js    オーディオスレッドでの区間集計
test/                                        node:test（依存パッケージなし）
```

### どこに何を書くか（この約束を崩さない）

- **`logic.js`**: 純ロジックだけを置く。`document`・`window`・`navigator`・`localStorage`に触らない。Nodeから`require`できる状態を保つ（末尾の`module.exports`が命綱）。新しい計算・整形・判定はまずここへ書き、テストを付ける
- **`script.js`**: DOMとブラウザーAPI。単一のIIFE。計算をここに書かない。`logic.js`から取り出した関数を呼ぶだけにする
- **`worklet/meter-processor.js`**: `AudioWorkletProcessor`。区間の集計だけを行い、dBFSへの換算はしない（換算は`logic.js`）。別スレッドなので`logic.js`を読み込めない。共有したい値は両方に書くのではなく`processorOptions`で渡す
- **`test/`**: `npm test`（`node --test`）。1ファイル＝1テーマ。冒頭のコメントに「どの段階で何を直したか」を書く
- **`package.json`**: 依存パッケージを増やさない。`node --test`だけで完結させる

### 計測の要点

- 計測は**AudioWorklet**（オーディオスレッド）で行う。128サンプルごとに必ず呼ばれるので、`requestAnimationFrame`が止まっても記録は続く。区間の切れ目はオーディオクロックのフレーム番号で決め、理想の境界をそのまま次の開始点にするので、ずれが積み上がらない
- **`requestAnimationFrame`は描画専用**である。ここで統計を進めたり記録を作ったりしない（改修前は毎フレーム加算していて、統計の母集団がCSVの行と食い違っていた）
- AudioWorkletを読み込めない環境では**簡易モード**（`ENGINE_FALLBACK`）へ切り替わる。簡易モードは描画ループで記録するので欠測しうる。どちらで動いたかは画面（`#engineMode`）とCSVのメタ行（`# engine=`）に出す
- **表示下限（floorDb）は表示専用**である。記録する値（`rawDb`）を丸めてはいけない。記録中に表示の設定を変えるとログそのものが変質する
  - 既定は**帯域を計算するとき-110dBFS、`?bands=off`のとき-90dBFS**（第2弾c0。決め方は`logic.js`の`floorDbDefaultFor`、定数は`FLOOR_DB_DEFAULT_BANDS`・`FLOOR_DB_DEFAULT`）。b4で静かな部屋の超音波帯が-93〜-107dBFS（行の中央値）と-90より下にあり、超音波帯の破線がいつも下端に張り付いたため。`index.html`の`value`は-110で、`script.js`が初期化で`floorDbInput.defaultValue`を書き換える（`value`を直接書かない。ブラウザーが復元した利用者の値を上書きしないため）。空欄・非数も同じ既定へ戻す（`parseFloorDb(raw, fallback)`）
  - -110でも、メーターの目盛りは`-110 / -73 / -37 / 0`（下限〜0の等分）、グラフの縦軸は`0 / -20 / -40 / -60 / -80 / -110`（下限の手前10dBの-100は`dbTicks`が間引く）になる。重ならないこと・小数が出ないことは`test/meter-floor.test.js`が見ている
- **統計はエネルギー平均（Leq）**である。dBの算術平均ではない。無音は電力0として数える
- ⚠**Leqの重みは行数ではなく区間長（秒）**である。ログ間隔は記録中に変えられるので、等重みだと実時間に比例しない値が出る（手元の検算で最大9.29dB）。重みは`recordDurationSec(rec) = endTime - startTime`（オーディオクロックの差）から取る
- ⚠**記録の穴の表示は両側で出す**（`statsIntegrity`）。クリップと欠測が「あるときだけ」出す片側表示にしない。穴が無いときも「記録の穴なし（クリップ0区間／有効サンプル率は{n}区間すべて1.000）」と出し、簡易モードの行は「測れません」と区別する。測れないことを「異常なし」として出さない
- ⚠**ワークレットの1区間めの起点は、コンストラクターではなく最初の`process()`で取る。**`AudioWorkletNode`を作ってからレンダーグラフへ繋ぐまでのあいだ`process()`は呼ばれないので、その間のフレームが`expected`にだけ入って`count`に入らない。改修前は記録開始直後の1行目だけ`valid_ratio=0.979`になり、欠測でないものを欠測として警告していた（逆算すると48kHzで8クォンタム＝21.3ミリ秒ぶん。`node:vm`でワークレットを動かして再現済み）。⚠第1弾で「ヘッドレスのChromeでは再現しない（出力デバイスが無いあいだ`currentFrame`が進まない）」と書いたのは誤り。ヘッドレスでも`currentFrame`は進む。再現しなかったのは手元のサーバーから読み込んで遅れが無かったためである（第2弾a8）
- **デジタル無音は`-Infinity`で1行残す**。行を落とすと「活動がなかった」ことを示せない
- ⚠**1区間めの起点は、さらに「入力に音が載った最初の`process()`」まで待つ**（第2弾a3）。入力が空（チャンネルなし・長さ0）のまま`process()`が呼ばれるあいだは区間を始めない。1秒待っても音が来なければ最初の`process()`を起点にし、届かなかったぶんを欠測として残す。塞いだのは「入力が空で届く」場合だけで、`process()`そのものが呼ばれない場合は本当の欠測として残す。⚠入力が空で届く状況は、Chromiumでは観測していない
- ⚠⚠**起点は、`currentFrame`が前の呼び出しの終わりとつながった呼び出しで決める**（第2弾a8）。Chromium 145では、ノードを作ったあと最初の`process()`だけ`currentFrame`が0で届き、2回目で実際の位置へ飛ぶ。`addModule`の読み込みに時間がかかるほど飛ぶ幅が広く、GitHub Pagesから開くと1行目が0.8前後になった。最初の1回は起点に使わない（2.7ミリ秒を捨てる）。つながらない呼び出しが16回を超えたら確かめずに始める
- ⚠⚠**記録開始直後の挙動を比べるときは、どの版も同じサーバーから、同じ遅れで読み込む。**a3のときは旧版をGitHub Pagesから、改修版を手元から読み込んで比べ、読み込みの遅れの差を版の差と取り違えた。手元のサーバーでワークレットの読み込みだけを遅らせる（0ミリ秒と200ミリ秒）と、差が出る条件を作れる
- ⚠**CSVのヘッダーの`processing`は3値で書く**（`logic.js`の`processingLabel`）。`off`は3項目すべてが無効と報告されたときだけ。Safari（WebKit）の`getSettings()`は`echoCancellation`しか返さないので、`unknown:autoGainControl+noiseSuppression`になる。画面の注意書きとヘッダーの組み立ては`logic.js`の`recordNoticeItems`・`chainHeaderMeta`で行い、テストは振る舞いで確かめる
- **注意書きの入れ物（details）は一度だけ作り、変わった文字だけを差し替える**。作り直すとフォーカス・開閉の操作・読み上げが乱れる。読み上げは要約が変わったときだけ`#recordNoticeLive`で流す
- **停止中のグラフは、止めた時刻を右端にして描く**（`graphNowMs`）。「いま」で描き直すと、線が左へずれて60秒で見えなくなる
- **デバイス喪失は`MediaStreamTrack`の状態でしか検出できない**。トラックをstopしても`MediaStreamAudioSourceNode`はデジタル無音を流し続けるため、`valid_ratio`は1.0のままになる
- ⚠**帯域の集計（第2弾b1）はワークレットで行う。**区間ごとに、帯域ごとの電力の和（`bandPower`）・数えたフレーム数（`bandFrames`）・数えるはずだったフレーム数（`bandExpected`）を送り、dBFSと`band_valid_ratio`への換算は`logic.js`の`buildIntervalRecord`で行う（帯域の平均二乗＝電力の和÷`bandFrames`。レコードの`bandDb`・`bandValidRatio`）。FFTは`worklet/meter-processor.js`のトップレベル関数（第2弾b0の土台）で、ワークレットは`logic.js`を読めないのでここに置く。帯域の定義（`BAND_DEFS`）・FFTの長さN（約21.3ミリ秒になる2の累乗。44.1kHz・48kHzで1024、88.2kHz・96kHzで2048）・ビンの割り当て（中心周波数がlo以上hi未満のビン。直流のビン0は入れない。ビンが無い帯域はnull）は`logic.js`の`bandPlan`が決め、`script.js`が`processorOptions.bandPlan`で渡す。ワークレットに同じ値を書かない。帯域の値は「その帯域に音のエネルギーがあったか」の記録であり、超音波ビーコンの検出ではない。CSVの列は第2弾b2で足した（下の「CSV v3」）。画面と統計は第2弾b3で足した（下の「画面の帯域」）
  - 窓は周期型Hann、ずらし幅N/4（75%の重なり）。Hann窓の2乗を重ねた和がどの時刻でも1.5で一定になり、途切れのあいだと記録の起点のそばを除き、どのサンプルも同じ重みで数える。音のエネルギーが両帯域のビンの中（約100Hz〜超音波帯の上端より2ビンほど下）にだけある定常な信号では、全帯域を足した値が時間領域の平均二乗と一致する（`test/band.test.js`）。ビン0と、超音波帯の上端（22kHz）より上のビンはどの帯域にも入らないので、それ以外の信号では一致しない（白色雑音で48kHzは-0.4dB、96kHzは22〜48kHzが入らず-3.4dB）。N/2だと0.5〜1.0と揺れ、フレームの端に来た1ミリ秒の衝撃音が帯域の値から消えかける
  - フレームの区切りはオーディオクロックのフレーム番号で固定する。番号gがN/4の倍数の位置をフレームの終わりとし、終わりがgのフレームはサンプル[g-N, g)である。⚠**各フレームは終わりgを含む区間（startFrame ≤ g < endFrame）に数える。**中心で数えると、区間の最後の約10ミリ秒のフレームが区間の終わりまでに計算し終わらず、行を作る（ハッシュを付ける）時点に間に合わない。そのかわり、境目の前の約21ミリ秒の音が後ろの区間の値に入ることがある。そのため、dbfsが`-Infinity`（デジタル無音）の行でも帯域の値が有限になりうる（`test/band.test.js`。READMEの「帯域の列」に書いた。Chromiumの疑似マイクでも、音から無音へ切り替わった直後の区間で`dbfs`が`-Infinity`・帯域が`-51.02`／`-40.58`になった）
  - フレームごとに平均を引いてから窓を掛ける（SciPyのwelchの既定`detrend='constant'`と同じ）。周期型Hann窓では直流の電力の1/3がビン1（48kHz・N=1024で46.875Hz）へ入り、可聴帯（20〜18,000Hz）の値に混ざるため。⚠平均を引くと、約100Hzより下の音は値が大きく変わる（48kHzの正弦波で20Hz -8.0dB・30Hz -4.3dB・40Hz -1.9dB・70Hz +0.46dB）。フレームに1〜2周期しか入らない音は、フレームの平均がその音自身の一部になるためである。ビン0を入れないので、平均を引かなくても20Hzは-3.2dBになる。約100Hzより上では、引いた平均が窓でビン1へ広がり、わずかに大きく出る（440Hzで電力の比+3.2e-4＝0.0014dB）。READMEの「帯域の列」には「可聴帯の実際の下端は約50Hz」と書いた（b2）
  - ⚠クォンタムが落ちたとき・入力が空のときは、そのサンプルを含むフレームを数えない（0で埋めると「音が無かった」ことになる）。リングバッファは途切れずに届いたサンプル数を持ち、Nに満たないフレームは計算しない。記録の起点より前のサンプルが要るフレームは、数えるはずのフレームに入れない（1行目を見せかけの欠測にしない）。⚠そのかわり、起点から最大Nサンプル（48kHzで約21ミリ秒）の音は重みが1.5に届かない（起点に近いほど小さい）。起点から6.3ミリ秒の1ミリ秒の衝撃音は約33%しか入らず、`band_valid_ratio`には出ない（記録を始めるたびに起きる。READMEの「帯域の列」に書いた）
  - コンストラクター（`setupBands`）で`powerSpectrumInto`を前もって64回呼ぶ。Node 22で測ると、最適化前の1回目はN=1024で約2ミリ秒（1ブロックの76%）、N=2048では1ブロックを超えた。記録の起点は第2弾a8の「前の呼び出しとつながった呼び出し」で決まるので、コンストラクターが遅れても1行目は欠測にならない
  - ⚠**`fftInPlace`・`powerSpectrumInto`と、フレームごとに通る`feedBands`・`analyzeBandFrame`・`addBandFrame`・`process()`の中では配列もオブジェクトも作らない**（オーディオスレッドでのGCを避ける。計画・窓・リングバッファ・並べ直し用の配列はコンストラクターで一度だけ作る）。`test/fft.test.js`がパラメーターと本体の文字列で、配列やオブジェクトを作る代表的な書き方（`new`・リテラル・分割代入・`for…of`・許可リストに無い関数の呼び出しなど）が無いことを見ている（実行して数えてはいない。これで全部ではない）。区間ごとに1回のメッセージ（`emitInterval`）は対象にしない。第1弾からメッセージのオブジェクトを作っており、第2弾b1で帯域の電力の和の配列（`bandPowerList`）も区間ごとに1つ作るようにした（フレームごとには作らない）
  - `?bands=off`で帯域の計算を止められる（`logic.js`の`bandsEnabledFromQuery`→`processorOptions.bands=false`。FFTを計算せず、帯域の値はnull）。同じ版で帯域あり・なしの`valid_ratio`を実機で比べるためである。止めたときCSVは帯域の3列が空欄、ヘッダーが`# bands=off`になる（`# fftSize=`は出ない。第2弾b2）。画面では凡例と注意書きに「止めています」と出す（第2弾b3）
- ⚠**画面の帯域（第2弾b3）。**計算・判定・文言は`logic.js`、`script.js`はDOMに入れるだけ（`test/band-ui.test.js`）
  - グラフは本体の音量（実線、`--plot`）に超音波帯の値（破線、`--plot-ultra`）を重ねる。線の形は`GRAPH_LINE_STYLES`で、凡例（`index.html`のSVGの`stroke-dasharray`）も同じ値にする。凡例はキャンバスの外のHTMLで、色と線の形の両方で示す。点の組み立ては`graphLinePoints`
  - ⚠**超音波帯の線を描くかどうかは`ultraBandState`（`on`／`off`／`fallback`／`noBins`）の1つの判定で決める。**凡例の見本の線（`ultraSwatchShown`）・凡例の文言・キャンバスの`aria-label`・注意書きが同じ判定を使う。第2弾b3の最初の実装は`?bands=off`だけを見ていたので、簡易モードと超音波帯にビンが無いサンプルレートで、描かれない破線を凡例と`aria-label`が「ある」と言っていた（点検で見つかった。「超音波帯に音が無かった」と読める）
  - ⚠**値の無い点で線を切る。**欠測の行（`rawDb`が`null`）は、第2弾b2まで`dbToY`が下端に置いていたので、デジタル無音と同じ線に見えた。帯域の値が無い区間（簡易モード・`?bands=off`・数えたフレームが0）も破線を切る。デジタル無音（`-Infinity`）は測った値なので下端に描く。前後どちらともつながらない点は`alone`で、描画側が小さな丸で描く
  - 統計の「超音波帯の最大」（`formatUltraMax`）は`band_ultra_dbfs`の最大。⚠**デジタル無音・欠測の行に付いた帯域の値も数える**（区間の境目の前の約21ミリ秒の実際の音で、架空の値ではない）。値のある行が無ければ`--.- dBFS`（簡易モード・`?bands=off`）。`-Infinity`だけならサンプルピークと同じく`-∞ dBFS`。`formatStats`には入れていない（既存の統計の母集団と別の数え方のため）
  - 注意書き＝帯域の有効率が1.0未満の区間（`statsWarningItems`の`bandValid`）、サンプルレートの食い違い・`?bands=off`・簡易モード・超音波帯にビンが無い（`bandNoticeItems`。セッションのメタだけから決まるので、`recordNoticeItems`の入力は増やしていない）
  - 「この端末で記録できる上限」（`recordableUpperHz`・`upperLimitText`）＝min(AudioContext÷2, トラック÷2)。トラックが報告しなければAudioContextの半分で「トラックの値は不明」を添える。⚠`# nyquistHz=`（AudioContextの半分）とは別物で、サンプルレートで決まる上限にすぎない（マイクがその高さの音を拾えることは示さない）
  - 凡例と上限の1行は読み上げ領域にしない（`aria-live`を増やさない）。キャンバスは`role="img"`で、`aria-label`は`graphAriaLabel`
- ⚠**超音波帯の現在値（第2弾c0、`#ultraNow`）。**大きな数字のすぐ下に「超音波帯（直近1秒の区間）：-91.7 dBFS」と出す。値は最後に記録した区間（`pushRecord`の`rec`）の`band_ultra_dbfs`で、CSVに書く値と同じ。文言は`logic.js`の`ultraNowText(state, rec)`（`state`は凡例と同じ`ultraBandState`）。区間の長さはレコードの`intervalSec`（その区間を実際に測った長さ）
  - 最初の区間が来るまでは`--.- dBFS`（記録開始と統計リセットで`lastRecord = null`）。値の無い区間は`--.- dBFS（この区間は値なし）`、デジタル無音は`-∞ dBFS`。`?bands=off`・簡易モード・ビンなしでは値の代わりに凡例と同じ理由を出す
  - ⚠読み上げ領域（`aria-live`）にしない。区間ごとに変わるので、読み上げ続けてほかの読み上げを妨げる（`test/ultra-now.test.js`が`aria-live`の数を見ている）
- ⚠**画面の大きな数字（`#bigValue`）は、直近`METER_WINDOW_SAMPLES`（2048）サンプルの全帯域のRMSである**（48kHzで約43ミリ秒。`AnalyserNode`から毎フレーム読む）。高精度モードのCSVの`dbfs`は区間全体のエネルギー平均なので、窓が違う（⚠簡易モードのCSVの`dbfs`は、`animate()`が同じ窓から読んだ値をそのまま`recordFallbackInterval`へ渡しているので、窓の違いは無い。説明はどこでも「高精度モードの」と条件を付ける）。ときどき大きくなる音では、エネルギー平均が大きな瞬間に引っぱられるので、大きな数字のほうが低く見える時間が長い。README・ヘルプ・`#bigValue`のtitleの3か所で言う。サンプル数を変えたら3か所も直す（`test/ultra-now.test.js`が定数から組み立てた文字列で見ている）
- ⚠**操作ボタン（第2弾c0、設計書§3のQ3）。**判定は`logic.js`（`startStopView`・`moreMenuNext`・`COMPACT_MEDIA_QUERY`）、`script.js`は属性を付け外しするだけ（`test/mobile-view.test.js`）
  - 記録開始（`#startBtn`）と停止（`#stopBtn`）は隣に置き、`startStopView({ running, connecting })`で押せるほうだけを見せる（見せないほうは`hidden`）。接続中は停止（取り消し）を見せる。**IDは変えない**（テストと測定のスクリプトが使っている）。押したボタンが隠れたら、同じ場所に出たほうへフォーカスを移す（`renderStartStop`）
  - CSV書き出しと統計リセットは`#moreMenu`に入れ、`#moreBtn`（「その他」、`aria-expanded`・`aria-controls`）の**直後**に置く。開閉は`aria-expanded`だけで持ち、CSSも`.more-btn[aria-expanded="false"] + .more-menu{display:none}`（480px以下）で同じ属性を見る。481px以上では`.more-btn{display:none}`・`.more-menu{display:contents}`で、これまでどおり1列に並ぶ。押せる条件は`updateButtonStates`のまま変えていない
  - Escで閉じたらフォーカスを「その他」へ戻す。⚠戻すのはフォーカスが中身か「その他」にあったときだけで、Tabで外（ヘルプ・設定の入力欄など）へ移ったあとのEscは閉じるだけにする（`moreMenuNext`の`focusInside`・`focusOnToggle`）。外から移すと、設定の入力欄にいた利用者の画面が先頭まで戻る（第2弾c0の点検で直した）。481px以上とヘルプを開いているあいだはEscを受けない（`keydown`は捕獲で受け、ヘルプのEscより先に状態を見る）。外を押したら閉じる（⚠`pointerdown`ではなく`click`で受ける。押した瞬間に閉じると下の画面が上がり、指の下の要素が入れ替わる）。中身がどちらも押せなくなったら閉じる

### CSV v3

- 列は`timestamp,dbfs,seq,peak_dbfs,clip,valid_ratio,band_ultra_dbfs,band_audible_dbfs,band_valid_ratio,hash`（10列。`logic.js`の`CSV_COLUMNS`）。`# format=mic-gain-logger/3`
  - 第2弾b2で帯域の3列を**`hash`の左に挿した**（v2は7列）。帯域の2列の並びは`BAND_DEFS`の順（超音波帯・可聴帯）で、ヘッダーの`# bands=`の並びと同じ
  - ⚠**ハッシュの材料は「`hash`列より左のフィールド」**である（v3は9つ、v2は6つ）。READMEの検証器は列のヘッダー行から`hash`の位置を読み、v2とv3の両方を1本で確かめる。**`hash`の位置（v2の7列目）や「6つのフィールド」を決め打ちしない**
  - ⚠**列のヘッダー行はハッシュの材料に入らない**（起点は`csvHeaderLines`だけ）。列名を入れ替えても鎖は通るので、READMEの検証器は、列のヘッダー行が起点の`# format=`の版の列（検証器の`KNOWN`）と同じかを先に確かめる（第2弾b2の点検で追加）。`# format=`の版を上げたら`KNOWN`にも足し、検証器の実測表を採り直す。`test/csv-v3.test.js`が`KNOWN`と`CSV_COLUMNS`・v2の見本の列が同じかを見ている
  - 帯域の2列の書式は`dbfs`と同じ（小数2桁、電力0なら`-Infinity`）。数えたフレームが0・その帯域にビンが無いときは空欄。`band_valid_ratio`は`valid_ratio`と同じ書式（小数3桁）で、数えるはずのフレームが0なら空欄。簡易モードの行と`?bands=off`では3列とも空欄
- ⚠**A列=timestamp・B列=dbfsは動かさない。**READMEが案内しているExcelの手順（`=AVERAGE(B:B)`など）がこの位置を前提にしている。列を足すときはB列より右へ足す
- ファイルの形は**ヘッダーのメタ行 → 列のヘッダー → データ行 → トレーラー行**の4段。ヘッダーもトレーラーも`#key=value`の1行1項目で、`metaLine()`を通す
- ⚠⚠**ヘッダーとトレーラーの線引きを崩さない。**
  - **ヘッダー（`csvHeaderLines`）＝記録を始めた瞬間に確定する事実だけ**（`format` `engine` `started` `sampleRate` `nyquistHz` `device` `processing` `settingsRaw` `weighting` `bands` `fftSize` `hash`）。組み立ては`logic.js`の`chainHeaderMeta`。これがハッシュチェーンの起点なので、**記録中に増える値を1つでも入れると起点が動く**
  - **トレーラー（`csvTrailerLines`）＝記録が終わってから分かる事実**（`rows` `intervalSec` `engines` `sessions` `sessionStartAt` `silence` `clockBreaks` `clockBreakAt` `clockDriftMs`）
  - 新しい項目を足すときは、まず「記録開始の時点で値が決まるか」を問う。決まらないならトレーラーである。とくに`intervalSec`は記録中に変えられるので**ヘッダーへ戻さない**。帯域の欠測の区間数のような事後の値も、出すならトレーラーである（v3では出していない。行ごとの`band_valid_ratio`で見る）
  - 第2弾b2で足した4項目：`nyquistHz`＝AudioContextのサンプルレートの半分（44.1kHzでは22kHzがそのすぐ下になるため）。⚠帯域を計算できる上限であって、「この端末で表せる上限」とは書かない。マイクの音声トラックの`sampleRate`（`settingsRaw`）がこれより低いと、実際に届く上限はその半分になる（Chromiumの疑似マイクで音声トラック44.1kHz・AudioContext 48kHzのとき、-20dBFSのトーンが21kHzで`band_ultra_dbfs` -53.78、23kHzで`dbfs` -101.99。READMEの「帯域の列」に書いた）。`bands`＝`BAND_DEFS`から作る定義（`18000-22000,20-18000`。`?bands=off`なら`off`。セッションのメタの`bandsEnabled`が分からなければ出さない）。`fftSize`＝帯域を計算するとき（高精度モードで`?bands=off`でない）だけ出す。ワークレットへ渡すのと同じ`bandPlan`から取る。`settingsRaw`＝下の項目
  - ⚠⚠**`# settingsRaw=`には`getSettings()`の生の値のうち`SETTINGS_RAW_KEYS`の5項目（`echoCancellation` `autoGainControl` `noiseSuppression` `sampleRate` `channelCount`）だけを出す。`deviceId`・`groupId`は決して入れない**（端末を特定できる値のため。一覧に無い項目は出さない作り）。報告しない項目は`unreported`。解釈（`# processing=`のoff／active／unknown）と生の値を分けて持つ。Chromiumの疑似マイクでは、音声トラックの`sampleRate`が44100、AudioContextが48000と食い違った
- ⚠⚠**音が1つも届かなかった区間（count=0）は、`dbfs`・`peak_dbfs`・`clip`を空欄にする**（第2弾b2。第2弾aの公開前の点検から持ち越したW#4）。`valid_ratio`は`0.000`のまま出す。改修前は`-Infinity`（デジタル無音）と同じ値を書いており、欠測を無音として残していた。レコードは`missing: true`で`rawDb`・`db`・`peakDb`・`clipCount`が`null`
  - **統計（Leq・最大・最小）には入れない**（`addStatsRecord`は`missingN`だけ数える）。無音として数えると、測っていない時間のぶんLeqが下がる。有効サンプル率には数えるので、記録の穴として画面に出る
  - デジタル無音（count>0でsumSq=0）はこれまでどおり`-Infinity`で1行残す。トレーラーの`# silence=`も欠測の行では付かない
  - READMEのExcel手順では、B列が空欄の行はK列（重み）を0にする（空のセルは0として扱われ、`POWER(10,0)`＝0 dBFSが足し込まれるため）
- ⚠⚠**ハッシュは記録中に1区間1回だけ計算する。**`script.js`の`pushRecord`が1行目で`hashChain.begin()`を呼んで起点を凍結し、区間ごとに`hashChain.extend()`で伸ばして行に貼る（入れ物は`logic.js`の`createHashChain`）。**書き出し（`exportCSV`）では計算し直さない**。改修前は書き出しのたびに全行を計算し直しており、起点にあとから分かる事実が混ざっていたため、**同じセッションを2回書き出すと同じ行のハッシュが変わっていた**（無音の行が1行増えるだけで1行目から変わった）
- **トレーラーが鎖の最後の輪**である。`trailerHashInput(最後の行のハッシュ, トレーラーの行)`で`# trailerHash=`を作る。これで末尾の行の削除とトレーラーの書き換えを検出できる。行の材料はコンマ区切り、トレーラーの材料は改行区切り
- ⚠**列はむやみに増やさない。**行ごとに残したい印（AudioContextの中断など）は、回数と位置をヘッダーかトレーラーの行で示す。列を足すとREADME（列の表・見本・検証器とその実測表・Excelの手順）・テスト・画面のヘルプまで波が及ぶ。足すのは`# format=`の版を上げるときだけにする（v3で帯域の3列を足したのが最初の例）
- `seq`は**1つのCSVの中での通し番号**である。ワークレットのカウンターは記録開始のたびに0から振り直されるので、`script.js`側で起点（`seqBase`）をずらして足す。区間を捨てたときの欠番は残す（欠番＝行が抜けた印）
- メタ行は「**その行がどういう条件で採られたか**」を書く場所である。書き出し時点の画面の設定を読まない（`# intervalSec=`がこれで嘘をついていた）。1つのCSVに複数の値が混ざるときは`+`でつないで並べる
- ⚠⚠**画面の設定値を行に貼るのも嘘である。**ログ間隔の変更が効くのは次の区間の境界からなので、設定を変えた瞬間の1区間は前の間隔で測られている（実測で1行ずれた）。行に貼るのは**その区間を実際に測ったときの間隔**（`rec.intervalSec` ＝ `intervalSecOfFrames(endFrame - startFrame, sampleRate)`）で、トレーラーは書き出しのときに`intervalRunsLabel(logs)`で組み直す。控えを別に持つとまた実態とずれる
- **`# intervalSec=`は`間隔@開始seq`のラン**である（例`1@0+3@12`）。変わったところだけを出すので、`+`が入っていなければ全区間が同じ間隔である
- ⚠⚠**`# sessionStartAt=`（各セッションの先頭行の`seq`）を消さない。**`timestamp`は区間の終わりなので隣の行との差が区間長になるが、**記録を止めて再開した境界では差に休止時間がまるごと入る**。実測17行・境界の差60.032秒で**Leqが6.49dB外れた**（向きは境界の行の大小で変わる。逆の並びでは+2.00dB、休止600秒では-15.42dB）。アンカーを取り直した行（`# clockBreakAt=`）も同じである。READMEのExcel手順は、この2つの`seq`の行だけ`# intervalSec=`の値を重みにする
- ⚠**Excelの作業列はK以降**である。A〜Jがデータの10列で、**C列は`seq`**、**H列は`band_audible_dbfs`**。v2のころは作業列をH以降に置いていたが、v3でH列に帯域の値が入った。さらに前の手順は区間長をC列に入れると書いていたが、上書きすると境界の行を見つける手がかりが消える
- ⚠⚠**ハッシュチェーンの名乗りは「CSVがそのまま渡ってきたときの、うっかりの破損・部分的な欠落・順序の入れ替わりの検出」までとする。**「改ざん検知」「改変の検出」「第三者による改変の検出」とは書かない
  - **主体で限定してはいけない。**「作った本人は作り直せるが第三者には検出できる」は誤りである。鍵も外部アンカーも無く、鎖の作り方をREADMEで公開しているので、**誰でも再計算で鎖を張り直せる**（第1弾に39行のスクリプトで実証済み。README「分からないこと」の表は、第2弾b2でv3の見本に同じ改変を加え、別のスクリプトで張り直して採り直した実測）
  - 分かれ目は「本人か第三者か」ではなく「**ハッシュを再計算するかどうか**」である
  - 限界を変えるには秘密鍵での署名か外部タイムスタンプ機関しかないが、**外部へ預けるのは`connect-src 'none'`の作りを壊すので採らない**
  - 同じ趣旨を**README・画面のヘルプ・`logic.js`のコメント・このCLAUDE.md**の4か所でそろえる。片方だけ直すと必ず食い違う
- **CSVの形を変えたら、READMEの「受け取ったCSVを検証する」に載せているPythonの検証器も直し、実際に動かして確かめる**（そのままなら通る／改変すると落ちる、の両方）。トレーラーに行を足したら`# trailerHash=`が変わるので、READMEの見本CSVの値も計算し直す
  - 第2弾b2では、見本CSVを手で書かず、Chromiumの疑似マイク（`--use-file-for-fake-audio-capture`）で実際に書き出したものに差し替え、seqを0から振った（第2弾aまでの見本はseqが1から始まっていた）。検証器の実測表は、READMEから切り出した検証器と見本を別プロセスで動かした出力から写した。v2の見本は`test/fixtures/sample_v2.csv`に残し、`test/csv-v3.test.js`がv2も同じ手順で通ることを見ている
- ⚠⚠**「CSVから同じ値が出る」は条件つきで書く。**画面のヘルプは「画面の値とCSVから計算し直した値は一致します」と無条件に言い切っていたが、停止→再開をまたぐと嘘になる。成り立つ条件（区間長の取り方、境界の行の扱い）を添える
- **README・画面のヘルプ・テスト・このCLAUDE.mdの4か所をそろえる。**READMEの検算値は`test/session-weight.test.js`が表を読んで実際の計算と比べるので、**値を書き換えるときは必ず計算し直す**

## Development Commands

```bash
# テスト（依存パッケージなし・Node.js 22以上）
npm test

# ローカルで開く。file:// では AudioWorklet のモジュールを読み込めず簡易モードになるので HTTP 経由にする
# ⚠ crypto.subtle は file:// でも使える（Chromium で実測）。hash 列が空になるのは https でないホスト名つきの URL のとき
python -m http.server 8000
# or
npx serve .
```

CIは`.github/workflows/test.yml`（pushとpull requestで`npm test`）。

## Key Implementation Notes

- **Audio constraints**: 加工はすべて無効を要求する（`echoCancellation`・`noiseSuppression`・`autoGainControl`=false）。ただし要求が通るとは限らないので、`track.getSettings()`の実値をセッションのメタデータに残し、加工が有効なままなら画面で警告する
- **dBFS range**: -∞から0。0がデジタル最大。端末に依存する相対値であり、dB SPLへは変換できない
- **CSP**: `index.html`のmetaで`connect-src 'none'`を宣言している。外部送信をブラウザーの機能として止めるためのものなので、`fetch`や外部CDNを足さない（足すと無言で壊れる）
- **crypto.subtle**: 安全なコンテキストでしか使えない。**httpsでないホスト名やIPアドレスつきのURL**（`http://192.168.1.10:8000/`など）で開くとハッシュ列が空になり、`# hash=`の行も出ない。⚠**`file://`は安全なコンテキストである**（Chromiumで実測。`isSecureContext`は`true`で、`file://`のまま書き出したCSVのハッシュ列は埋まった）。`file://`で落ちるのはAudioWorkletのモジュールの読み込みのほうである
- **Microphone acquisition**: 20秒のタイムアウトと取り消しを入れてある（許可プロンプト放置でUIが固まっていた）
- **Microphone reconnection**: 停止と再開の間に300ms空ける（ブラウザーの状態の問題を避けるため。`lastStopTime`）
- **High-DPI Canvas**: `devicePixelRatio`を使う。CSSのピクセル値を直に書き込まない
- **Theme persistence**: localStorageの`theme`キー。既定はライト
- **Mobile responsiveness**: 幅480px以下では、記録開始／停止・「その他」・ヘルプ・テーマの切り替えを`.actions`の1行に並べ、CSV書き出しと統計リセットを「その他」に畳む（第2弾c0）。並びはstyle.cssだけで決める。⚠かつては`handleMobileButtonLayout()`が480pxでヘルプとテーマの親要素を付け替えていたが、resizeが届かない経路で不整合が固定される壊れやすい仕組みだったので、第2弾c0で廃止した。親要素を付け替える仕組みを戻さない。ボタンを足すときは本人の決定を経て、`test/stats-notice.test.js`のボタンの一覧を直す
- **画面の高さ**: `vh`を使う箇所は、後ろに同じ値の`dvh`を書く（dvhを読めないブラウザーは前のvhのまま。`test/mobile-view.test.js`）。iOS Safariのvhはツールバーを畳んだときの高さなので、モーダルの下が画面の外へ出る。`viewport-fit=cover`は入れていない（セーフエリアの扱いは実機で`innerWidth × innerHeight`を測ってから決める）

## Documentation

- **README.mdがユーザー向けの唯一の説明である。**TECHNICAL.mdは廃止した。実在しない関数（`updateDisplay`・`shouldLog`・`createLogEntry`）の擬似コードが載っており、第1弾の改修で記述のほぼ全部が実装と食い違ったためである
- 実装の理由はコードのコメントとテストに書く。READMEに書くのは「何ができて、何ができないか」に限る
- READMEのディレクトリー構造（`## 📁 ディレクトリー構造`）は`test/docs.test.js`が実ファイルと比べている。ファイルを足したらREADMEも直す（直さないとテストが落ちる）
- ⚠**READMEの構成は「生成AIで作るセキュリティツール100」のシリーズ標準に合わせる**（第2弾c1）。前半はH1・バッジ5種・Day行・概要・`## 🌐 デモページ`・`## 📸 スクリーンショット`。中間は`## ✨ 主な機能`→`## 🔬 計測の作りと実測値`→`## 📱 実機テスト（iPhone 18 Pro Max）`→`## 🔒 セキュリティ的背景`→`## 🎯 ユースケース`（`### 👥 想定ターゲット層`・`### 🎯 想定する使い方`・`### 🚫 規制値・基準値とは比較できない`・`### 🧭 活用例`・`### 📋 具体的なシナリオ例`）→`## 📚 技術的な基礎知識`→`## ⚖️ 利用上の注意`→`## 🔧 トラブルシューティング`→`## 💡 将来的な追加アイデア`→`## 📊 CSVデータの活用方法`→`## 🌐 技術スタック`。後半は`## 🧪 テスト`→`## 📁 ディレクトリー構造`→`## 💻 動作環境`→`## 📄 ライセンス`→`## 🛠️ このツールについて`の固定順。`test/readme-structure.test.js`が前半と後半の順を見ている。見出しの名前を変えたら、READMEの中の「前述の」「後述の」の参照と、見出しで節を切り出しているテスト（`docs.test.js`・`readme-*.test.js`ほか）も直す
- **「どこまで確かめたか」は、`## 💻 動作環境`の「ブラウザー対応状況」が唯一の記載場所である。**実機で測った値と測り方は`## 📱 実機テスト`に置く。実機テストの値の正は、リポジトリーの外に保管している実機の記録（測定メモと実機のCSV）で、`test/readme-realdevice.test.js`がREADMEの表をその値と比べる。実機テストをやり直したら、実機の記録→テストの期待値→READMEの順に直す。⚠画面の見え方（実機で見た数字・破線）はCSVに残らないので、「実機のCSVで確かめた」に含めない。筆者の記憶として分けて書く（第2弾c1の点検で直した）。「確かめていないこと」（Android・画面ロック中・バックグラウンド・長時間・ほかのiPhone・第2弾c0の画面）は、実機テストの節とブラウザー対応状況の両方に同じものを書く
- ⚠⚠**実機のCSVはリポジトリーに入れない。**筆者の部屋で採った記録だからである。READMEに載せるのは数値だけで、実機のCSVの行も貼らない（`test/readme-realdevice.test.js`が見ている）
- ⚠⚠**CSVのレシピ（「📊 CSVデータの活用方法」のPython・コマンドライン）の出力は、実際に動かして写す。手で書かない。**見本CSVにかけた出力は`test/readme-recipes.test.js`がJSで計算し直して1文字ずつ比べる。実機のCSVにかけた出力は計算し直せないので、動かし直して写した全文を同じテストの`REAL_OUT`に持ち、READMEと1文字ずつ比べる（あわせて実機テストの表と矛盾しないことも見る）。レシピか実機の記録を変えたら、動かし直してREADMEと`REAL_OUT`の両方を写し直す（第2弾c1では、Excelの日本時間の式のミリ秒の位置を`MID(A2,20,3)`と書きかけ、Pythonで同じ計算をして`MID(A2,21,3)`だと分かった。Excel・Google Sheetsの実物では確かめていないことも、READMEに書いてある）
- レシピはPythonの標準ライブラリー（`csv`・`datetime`・`math`・`sys`）だけで書く。pandasは使わない（本人の指示）。共通のモジュール`mgl.py`は1本のCSVを1回で読み、境界の行（1行目・`# sessionStartAt=`・`# clockBreakAt=`）の区間長を`# intervalSec=`から取る（画面の「平均（Leq）」と同じ重み）。複数のCSVは1本ずつ読んでからつなぐ（ファイルをまたいで`timestamp`の差を取らない）
  - ⚠帯域の有無は`# bands=`で決めない。簡易モードでも帯域の計算を止めていなければ`# bands=18000-22000,20-18000`が出て、帯域の列は空欄になる。中央値が`None`になったら計算の前に理由を出して止める（`ultra_only.py`・`over.py`の`+`付き。第2弾c1の点検でTypeErrorを指摘された）
  - ⚠`compare.py`の「ヘッダーの違い=なし」はヘッダーの文字列が同じというだけである。`# processing=`が`off`でない記録（Safariの`unknown:`など）があれば「注意：」の行を出す（AGCが動いていると平時との差が縮む）。出力は`cp932`のコンソールへリダイレクトしても落ちないよう、`⚠`などの記号をprintしない
- **活用例（`### 🧭 活用例`）はシリーズ共通の必須項目である**（本人の指示2026-09-29）。平時との比較・音の方向探知・エアギャップの監査は必ず入れ、限界のある用途は同じ項目に限界を添える（24kHzより上はその周波数として記録できない、何の音か区別できない、2台の端末のdBFSは比べられない、方向はマイク1本では分からない）。⚠**用途と限界を狭めない。作者の意図は「悪用を勧めない」とだけ書く**（本人の判断 2026-09-29：好ましいか・適法かは国や人によって違う）。渚から、人を害することを目的とした用途を新しく提案しない
  - 1項目＝「誰が・何をして・何が分かるか」を、最初の⚠より前の1〜2文で書く（`test/readme-structure.test.js`が主語と文の数を見ている）。限界は⚠の後ろに置く
  - ⚠24kHzより上の音を「どの列にも残らない」と言い切らない。変換器のフィルターが落としきれなかったぶんは、24kHzより下へ折り返して記録に入りうる（実機では測っていない）。22kHzを超える音は帯域の列にほとんど入らず、全帯域の`dbfs`にだけ入る
  - ⚠エアギャップの監査で記録の連続を言うときは、条件（高精度モード。簡易モードでは帯域の値が残らない。実機の画面ロック中・バックグラウンドは未確認）を同じ項目に書く
  - 「📋 具体的なシナリオ例」のシナリオ1（探偵の調査）は第1弾からある例で、道具の例として妥当なので残す（本人の判断 2026-09-29）。「**作者の意図**：」の一文（悪用を勧めない・記録してよいかは国・地域の法令や状況で異なる）だけを添え、法令を並べて用途を狭めない
- **Tone Sweep（実機テストの音源のページ）へのリンクは、単体のツールとして公開するまで張らない**（本人の指示）。公開したら「実機テストのやり方」にリンクを張り、`test/readme-realdevice.test.js`の「リンクはまだ張らず」のテストを直す

## Browser Requirements

Requires Web Audio API and `getUserMedia`. iOS Safari needs iOS 13+. AudioWorkletが使えない環境は簡易モードで動く。実機で確かめたのはiPhone 18 Pro Max（iOS Safari）の1台だけである（2026-09-29、公開版`c7b6bad`と`090648f`）。Android・実機の画面ロック中・バックグラウンド・長時間の記録と、第2弾c0の画面の変更は確かめていない。範囲はREADMEの「ブラウザー対応状況」に1か所でまとめる。
