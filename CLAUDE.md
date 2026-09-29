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
- ⚠**FFTの土台（第2弾b0）はワークレットに置いてあるが、まだ使っていない。**`worklet/meter-processor.js`のトップレベル関数（`createFftPlan`・`fftInPlace`・`hannWindow`・`windowPowerSum`・`powerSpectrumInto`・`binFrequency`）で、b1で区間ごとの帯域の値（18〜22kHz・20〜18,000Hzの平均二乗の推定）を記録に足すときに使う。ワークレットは`logic.js`を読めないのでここに置く。⚠**`fftInPlace`と`powerSpectrumInto`の中では配列もオブジェクトも作らない**（オーディオスレッドでのGCを避ける。計画・窓・作業用の配列はコンストラクターで一度だけ作る）。`test/fft.test.js`が関数のパラメーターと本体の文字列で、配列やオブジェクトを作る代表的な書き方（`new`・リテラル・分割代入・`for…of`・許可リストに無い関数の呼び出しなど）が無いことを見ている（実行して数えてはいない。これで全部ではない）。⚠周期型Hann窓では直流の電力の1/3がビン1（48kHz・n=1024で46.875Hz）へ分かれるので、b1で20〜18,000Hzの帯域をビン1から数えるなら、フレームの平均を引くかビン2から数えるかを決める。帯域の値は「その帯域に音のエネルギーがあったか」の記録であり、超音波ビーコンの検出ではない

### CSV v2

- 列は`timestamp,dbfs,seq,peak_dbfs,clip,valid_ratio,hash`
- ⚠**A列=timestamp・B列=dbfsは動かさない。**READMEが案内しているExcelの手順（`=AVERAGE(B:B)`など）がこの位置を前提にしている。列を足すときは必ず右へ足す
- ファイルの形は**ヘッダーのメタ行 → 列のヘッダー → データ行 → トレーラー行**の4段。ヘッダーもトレーラーも`#key=value`の1行1項目で、`metaLine()`を通す
- ⚠⚠**ヘッダーとトレーラーの線引きを崩さない。**
  - **ヘッダー（`csvHeaderLines`）＝記録を始めた瞬間に確定する事実だけ**（`format` `engine` `started` `sampleRate` `device` `processing` `weighting` `hash`）。これがハッシュチェーンの起点なので、**記録中に増える値を1つでも入れると起点が動く**
  - **トレーラー（`csvTrailerLines`）＝記録が終わってから分かる事実**（`rows` `intervalSec` `engines` `sessions` `sessionStartAt` `silence` `clockBreaks` `clockBreakAt` `clockDriftMs`）
  - 新しい項目を足すときは、まず「記録開始の時点で値が決まるか」を問う。決まらないならトレーラーである。とくに`intervalSec`は記録中に変えられるので**ヘッダーへ戻さない**
- ⚠⚠**ハッシュは記録中に1区間1回だけ計算する。**`script.js`の`beginHashChain()`が1行目で起点を凍結し、`extendHashChain()`が区間ごとに伸ばして行に貼る。**書き出し（`exportCSV`）では計算し直さない**。改修前は書き出しのたびに全行を計算し直しており、起点にあとから分かる事実が混ざっていたため、**同じセッションを2回書き出すと同じ行のハッシュが変わっていた**（無音の行が1行増えるだけで1行目から変わった）
- **トレーラーが鎖の最後の輪**である。`trailerHashInput(最後の行のハッシュ, トレーラーの行)`で`# trailerHash=`を作る。これで末尾の行の削除とトレーラーの書き換えを検出できる。行の材料はコンマ区切り、トレーラーの材料は改行区切り
- ⚠**列は増やさない。**行ごとに残したい印（AudioContextの中断など）は、回数と位置をヘッダーかトレーラーの行で示す。列を足すとREADME・テスト・Excelの手順まで波が及ぶ
- `seq`は**1つのCSVの中での通し番号**である。ワークレットのカウンターは記録開始のたびに0から振り直されるので、`script.js`側で起点（`seqBase`）をずらして足す。区間を捨てたときの欠番は残す（欠番＝行が抜けた印）
- メタ行は「**その行がどういう条件で採られたか**」を書く場所である。書き出し時点の画面の設定を読まない（`# intervalSec=`がこれで嘘をついていた）。1つのCSVに複数の値が混ざるときは`+`でつないで並べる
- ⚠⚠**画面の設定値を行に貼るのも嘘である。**ログ間隔の変更が効くのは次の区間の境界からなので、設定を変えた瞬間の1区間は前の間隔で測られている（実測で1行ずれた）。行に貼るのは**その区間を実際に測ったときの間隔**（`rec.intervalSec` ＝ `intervalSecOfFrames(endFrame - startFrame, sampleRate)`）で、トレーラーは書き出しのときに`intervalRunsLabel(logs)`で組み直す。控えを別に持つとまた実態とずれる
- **`# intervalSec=`は`間隔@開始seq`のラン**である（例`1@0+3@12`）。変わったところだけを出すので、`+`が入っていなければ全区間が同じ間隔である
- ⚠⚠**`# sessionStartAt=`（各セッションの先頭行の`seq`）を消さない。**`timestamp`は区間の終わりなので隣の行との差が区間長になるが、**記録を止めて再開した境界では差に休止時間がまるごと入る**。実測17行・境界の差60.032秒で**Leqが6.49dB外れた**（向きは境界の行の大小で変わる。逆の並びでは+2.00dB、休止600秒では-15.42dB）。アンカーを取り直した行（`# clockBreakAt=`）も同じである。READMEのExcel手順は、この2つの`seq`の行だけ`# intervalSec=`の値を重みにする
- ⚠**Excelの作業列はH以降**である。A〜Gがデータの7列で、**C列は`seq`**。以前の手順は区間長をC列に入れると書いていたが、上書きすると境界の行を見つける手がかりが消える
- ⚠⚠**ハッシュチェーンの名乗りは「CSVがそのまま渡ってきたときの、うっかりの破損・部分的な欠落・順序の入れ替わりの検出」までとする。**「改ざん検知」「改変の検出」「第三者による改変の検出」とは書かない
  - **主体で限定してはいけない。**「作った本人は作り直せるが第三者には検出できる」は誤りである。鍵も外部アンカーも無く、鎖の作り方をREADMEで公開しているので、**誰でも再計算で鎖を張り直せる**（39行のスクリプトで実証済み。README「分からないこと」の表が実測）
  - 分かれ目は「本人か第三者か」ではなく「**ハッシュを再計算するかどうか**」である
  - 限界を変えるには秘密鍵での署名か外部タイムスタンプ機関しかないが、**外部へ預けるのは`connect-src 'none'`の作りを壊すので採らない**
  - 同じ趣旨を**README・画面のヘルプ・`logic.js`のコメント・このCLAUDE.md**の4か所でそろえる。片方だけ直すと必ず食い違う
- **CSVの形を変えたら、READMEの「受け取ったCSVを検証する」に載せているPythonの検証器も直し、実際に動かして確かめる**（そのままなら通る／改変すると落ちる、の両方）。トレーラーに行を足したら`# trailerHash=`が変わるので、READMEの見本CSVの値も計算し直す
- ⚠⚠**「CSVから同じ値が出る」は条件つきで書く。**画面のヘルプは「画面の値とCSVから計算し直した値は一致します」と無条件に言い切っていたが、停止→再開をまたぐと嘘になる。成り立つ条件（区間長の取り方、境界の行の扱い）を添える
- **README・画面のヘルプ・テスト・このCLAUDE.mdの4か所をそろえる。**READMEの検算値は`test/session-weight.test.js`が表を読んで実際の計算と突き合わせるので、**値を書き換えるときは必ず計算し直す**

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
- **Mobile responsiveness**: 480pxで`handleMobileButtonLayout()`がボタンの親要素を付け替える。⚠この仕組みは壊れやすい（resizeが届かない経路で不整合が固定される）ので、3つ目のボタンをここへ乗せない

## Documentation

- **README.mdがユーザー向けの唯一の説明である。**TECHNICAL.mdは廃止した。実在しない関数（`updateDisplay`・`shouldLog`・`createLogEntry`）の擬似コードが載っており、第1弾の改修で記述のほぼ全部が実装と食い違ったためである
- 実装の理由はコードのコメントとテストに書く。READMEに書くのは「何ができて、何ができないか」に限る
- READMEのディレクトリー構成は`test/docs.test.js`が実ファイルと比べている。ファイルを足したらREADMEも直す（直さないとテストが落ちる）

## Browser Requirements

Requires Web Audio API and `getUserMedia`. iOS Safari needs iOS 13+. AudioWorkletが使えない環境は簡易モードで動く。iOS・Androidの実機検証は未実施である。
