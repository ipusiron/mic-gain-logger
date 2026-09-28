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
- **デジタル無音は`-Infinity`で1行残す**。行を落とすと「活動がなかった」ことを示せない
- **デバイス喪失は`MediaStreamTrack`の状態でしか検出できない**。トラックをstopしても`MediaStreamAudioSourceNode`はデジタル無音を流し続けるため、`valid_ratio`は1.0のままになる

### CSV v2

- 列は`timestamp,dbfs,seq,peak_dbfs,clip,valid_ratio,hash`
- ⚠**A列=timestamp・B列=dbfsは動かさない。**READMEが案内しているExcelの手順（`=AVERAGE(B:B)`など）がこの位置を前提にしている。列を足すときは必ず右へ足す
- ファイルの形は**ヘッダーのメタ行 → 列のヘッダー → データ行 → トレーラー行**の4段。ヘッダーもトレーラーも`#key=value`の1行1項目で、`metaLine()`を通す
- ⚠⚠**ヘッダーとトレーラーの線引きを崩さない。**
  - **ヘッダー（`csvHeaderLines`）＝記録を始めた瞬間に確定する事実だけ**（`format` `engine` `started` `sampleRate` `device` `processing` `weighting` `hash`）。これがハッシュチェーンの起点なので、**記録中に増える値を1つでも入れると起点が動く**
  - **トレーラー（`csvTrailerLines`）＝記録が終わってから分かる事実**（`rows` `intervalSec` `engines` `sessions` `silence` `clockBreaks` `clockBreakAt` `clockDriftMs`）
  - 新しい項目を足すときは、まず「記録開始の時点で値が決まるか」を問う。決まらないならトレーラーである。とくに`intervalSec`は記録中に変えられるので**ヘッダーへ戻さない**
- ⚠⚠**ハッシュは記録中に1区間1回だけ計算する。**`script.js`の`beginHashChain()`が1行目で起点を凍結し、`extendHashChain()`が区間ごとに伸ばして行に貼る。**書き出し（`exportCSV`）では計算し直さない**。改修前は書き出しのたびに全行を計算し直しており、起点にあとから分かる事実が混ざっていたため、**同じセッションを2回書き出すと同じ行のハッシュが変わっていた**（無音の行が1行増えるだけで1行目から変わった）
- **トレーラーが鎖の最後の輪**である。`trailerHashInput(最後の行のハッシュ, トレーラーの行)`で`# trailerHash=`を作る。これで末尾の行の削除とトレーラーの書き換えを検出できる。行の材料はコンマ区切り、トレーラーの材料は改行区切り
- ⚠**列は増やさない。**行ごとに残したい印（AudioContextの中断など）は、回数と位置をヘッダーかトレーラーの行で示す。列を足すとREADME・テスト・Excelの手順まで波が及ぶ
- `seq`は**1つのCSVの中での通し番号**である。ワークレットのカウンターは記録開始のたびに0から振り直されるので、`script.js`側で起点（`seqBase`）をずらして足す。区間を捨てたときの欠番は残す（欠番＝行が抜けた印）
- メタ行は「**その行がどういう条件で採られたか**」を書く場所である。書き出し時点の画面の設定を読まない（`# intervalSec=`がこれで嘘をついていた）。1つのCSVに複数の値が混ざるときは`+`でつないで並べる
- ⚠⚠**ハッシュチェーンの名乗りは「CSVがそのまま渡ってきたときの、うっかりの破損・部分的な欠落・順序の入れ替わりの検出」までとする。**「改ざん検知」「改変の検出」「第三者による改変の検出」とは書かない
  - **主体で限定してはいけない。**「作った本人は作り直せるが第三者には検出できる」は誤りである。鍵も外部アンカーも無く、鎖の作り方をREADMEで公開しているので、**誰でも再計算で鎖を張り直せる**（39行のスクリプトで実証済み。README「分からないこと」の表が実測）
  - 分かれ目は「本人か第三者か」ではなく「**ハッシュを再計算するかどうか**」である
  - 限界を変えるには秘密鍵での署名か外部タイムスタンプ機関しかないが、**外部へ預けるのは`connect-src 'none'`の作りを壊すので採らない**
  - 同じ趣旨を**README・画面のヘルプ・`logic.js`のコメント・このCLAUDE.md**の4か所でそろえる。片方だけ直すと必ず食い違う
- **CSVの形を変えたら、READMEの「受け取ったCSVを検証する」に載せているPythonの検証器も直し、実際に動かして確かめる**（そのままなら通る／改変すると落ちる、の両方）

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
