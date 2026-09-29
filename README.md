<!--
---
id: day041
slug: mic-gain-logger

title: "Mic Gain Logger"

subtitle_ja: "マイク音量ロガー"
subtitle_en: "Microphone Gain Logger"

description_ja: "マイク入力の音量（dBFS）を、録音せずに区間ごとに記録し続けるWebツール。可聴域の上端（18〜22kHz）と可聴帯の帯域の値も同じ行に残し、描画が止まっても穴のあかない時系列を、ハッシュチェーン付きのCSVへ書き出す。dBFSは端末ごとの相対値であり、音圧（dB SPL）ではない。帯域の値は音のエネルギーの記録で、何の音かは判別しない。"
description_en: "A browser tool that logs microphone input level (dBFS) interval by interval without recording any audio. Each row also keeps the energy of the upper edge of the audible range (18-22 kHz) and of the audible band. The measurement runs in an AudioWorklet, so the log keeps no gaps even when rendering stalls, and each CSV row carries a hash chained to the previous row. dBFS is relative to each device full scale, not sound pressure (dB SPL), and the band values record energy only; they do not identify the source."

category_ja:
  - 物理セキュリティ
  - 音響監視
category_en:
  - Physical Security
  - Acoustic Surveillance

difficulty: 3

tags:
  - web-audio-api
  - microphone
  - dbfs
  - real-time
  - csv-export
  - privacy
  - ultrasonic
  - fft
  - audioworklet
  - hash-chain

repo_url: "https://github.com/ipusiron/mic-gain-logger"
demo_url: "https://ipusiron.github.io/mic-gain-logger/"

hub: true
---
-->

[English](README.en.md) · 日本語

# Mic Gain Logger - マイク音量ロガー

![GitHub Repo stars](https://img.shields.io/github/stars/ipusiron/mic-gain-logger?style=social)
![GitHub forks](https://img.shields.io/github/forks/ipusiron/mic-gain-logger?style=social)
![GitHub last commit](https://img.shields.io/github/last-commit/ipusiron/mic-gain-logger)
![GitHub license](https://img.shields.io/github/license/ipusiron/mic-gain-logger)
[![GitHub Pages](https://img.shields.io/badge/demo-GitHub%20Pages-blue?logo=github)](https://ipusiron.github.io/mic-gain-logger/)

**Day041 - 生成AIで作るセキュリティツール100**

**Mic Gain Logger**は、録音機能をあえて搭載せず、マイク入力の音の「存在」や「強さ」（音量のdBFS）をリアルタイムで可視化し、記録し続けるWebブラウザーベースのツールです。

出力されるのはdBFSという相対値の時系列で、音圧（dB SPL）ではないため、規制値や基準値と並べて比べることはできません。できるのは「同じ端末・同じセッションの中で、音の活動が上がった／下がった」を時刻つきで残すところまでです。

---

## 🌐 デモページ

👉 [https://ipusiron.github.io/mic-gain-logger/](https://ipusiron.github.io/mic-gain-logger/)

---

## 📸 スクリーンショット

<a href="assets/screenshot.png">
  <img src="assets/screenshot.png" alt="記録中の画面。超音波帯の現在値と、グラフの超音波帯の破線" width="760">
</a>

<sub>記録中の画面（デスクトップ）。大きな数字の下に超音波帯の現在値、グラフに超音波帯の破線が出る</sub>

<a href="assets/screenshot2.png">
  <img src="assets/screenshot2.png" alt="スマートフォン幅で設定を開いた画面" width="300">
</a>

<sub>スマートフォン幅（430px）で設定を開いたところ。書き出しとリセットは「その他」にまとまる</sub>

<a href="assets/screenshot3.png">
  <img src="assets/screenshot3.png" alt="ダークテーマで記録中の画面" width="760">
</a>

<sub>ダークテーマでの表示</sub>

<sub>いずれも、1kHz・440Hz・19kHzのテスト信号をマイクの代わりに流して撮ったものです。実際のマイクでは値が変わります。スマートフォン幅の画面はブラウザーの画面幅を430pxにしたもので、実機ではありません。英語の画面は`assets/en/`にあります。</sub>

---

## ✨ 主な機能

- 録音しない音量ロガー：マイク入力の音量（dBFS）を、音声を保存せずに区間ごとに1行ずつ記録する。CSP（`connect-src 'none'`）で、外部への送信をブラウザーの機能として止めている
- 欠測のない記録（AudioWorklet）：区間の集計をオーディオスレッドで行うので、画面の描画が止まっても記録は続く。AudioWorkletを読み込めない環境では簡易モードで動く
- 超音波帯（18〜22kHz）の記録：区間ごとに、超音波帯と可聴帯（20〜18,000Hz）のエネルギーも同じ行に残す。帯域の値は音のエネルギーの記録で、何の音かは分からない
- リアルタイム表示：大きな数字・メーター・直近60秒のグラフ（超音波帯は破線）・超音波帯の現在値を出す。大きな数字は直近2048サンプルの値で、高精度モードのCSVの`dbfs`（区間全体のエネルギー平均）とは窓が違う
- 統計：稼働時間・ログ件数・平均（Leq）・最大・最小・変動幅・サンプルピーク・超音波帯の最大を出す。平均はエネルギー平均で、重みは行数ではなく区間長（秒）である
- 記録の穴の表示：クリップと有効サンプル率の異常を、あるときもないときも画面に出す（穴がなければ「記録の穴なし」と出す）
- CSV（v3）とハッシュチェーン：データ行を、測定条件のヘッダーと、記録が終わってからわかる事実のトレーラーで挟んで書き出す。各行のハッシュで、うっかりの破損・部分的な欠落・順序の入れ替わりに気づける（意図的な改変には耐えない）
- 無音と欠測の区別：デジタル無音は`-Infinity`で1行残し、音が1つも届かなかった区間は`dbfs`を空欄にする
- マイクの切断・時刻の跳び・音の加工の検出：マイクを失った、供給元で無音化された、AudioContextが止まった、音の加工（AGC・ノイズ抑制・エコーキャンセル）が有効なまま、のいずれもその場で画面に出す（時刻の跳びと音の加工の状態はCSVにも残る）
- リアルタイム設定変更：ログ間隔（1s/3s/5s/10s/1m）と表示下限は記録中でも変えられる。表示下限は表示だけの設定で、記録する値は変わらない
- データ累積記録：「記録開始→停止→記録開始」を繰り返しても、ログと統計は積み上がる。「統計リセット」でまとめて消す
- スマートフォン対応：幅480px以下では、記録開始／停止・「その他」・ヘルプ・テーマの切り替えを1行に並べる
- 日本語・英語の表示：ヘッダーの右上のボタンか`?lang=`で切り替える。CSVの中身は言語によらず同じである
- ダークモード・ライトモード：テーマを切り替えられる（設定は保存する）

詳しい説明は[機能の資料](docs/features.md)にあります。

---

## 📖 使い方

### 記録する

1. [デモページ](https://ipusiron.github.io/mic-gain-logger/)を開き、「記録開始」を押してマイクの使用を許可する。許可のダイアログを放置すると20秒で時間切れになり、接続中は「停止」で取り消せる
2. 画面上部の「計測エンジン」で、高精度モード（AudioWorklet）で動いているかを確かめる。簡易モードでは、画面の描画が止まると記録も止まる
3. 記録中は、大きな数字・メーター・グラフ・統計が動き、区間ごとに1行ずつログがたまる
4. 終わったら「停止」を押す。もう一度「記録開始」を押すと、同じログに続けて記録する

### 設定を変える

- ログ間隔（1s/3s/5s/10s/1mのプリセットか、秒数の入力）と表示下限は、記録中でも変えられる。ログ間隔の変更は次の区間の境界から反映される
- 表示下限の既定は-110dBFS（`?bands=off`で開いたときは-90dBFS）である。表示だけの設定で、CSVに記録する値は変わらない
- 幅480px以下では設定が畳まれているので、「設定を表示」を押して開く

### CSVを書き出す

- 「停止」を押してから「CSV書き出し」を押す。記録中は書き出しボタンが押せない
- 幅480px以下では、「CSV書き出し」と「統計リセット」は「その他」の中にある
- ⚠ログはブラウザーのメモリーにしかない。タブを閉じたりリロードしたりすると消えるので、先に書き出す
- 「統計リセット」は記録を止めてから押す。ログ・統計・グラフ・注意書きをまとめて消す
- CSVの形式・検証の手順・集計のレシピは[CSVの資料](docs/csv.md)にある

### 表示の言語を切り替える

1. ボタンで切り替える：ヘッダーの右上のボタンを押す。日本語の表示では`EN`、英語の表示では`JA`と出る（押した先の言語）。選んだ言語はブラウザーの`localStorage`（キーは`mic-gain-logger-lang`）に保存し、次に開いたときに使う
2. URLで選ぶ：`?lang=en`か`?lang=ja`を付けて開く（例：`https://ipusiron.github.io/mic-gain-logger/?lang=en`）。`?bands=off`と一緒に使うときは`?bands=off&lang=en`のようにつなぐ。`?lang=`を付けて開いたままボタンで切り替えると、URLの`?lang=`も書き換える（再読み込みで元の言語に戻らないように）
3. 何も指定しないとき：保存した言語がなければ、ブラウザーの言語に合わせる。`navigator.languages`の先頭が日本語（`ja`・`ja-JP`など）なら日本語、それ以外は英語になる

- 決め方の順は「`?lang=` → 保存した言語 → ブラウザーの言語」である。`ja`・`en`以外の値（`?lang=fr`など）は無視して、次の順へ進む
- プライベートブラウズなどで`localStorage`が使えないときも、切り替えはできる。保存されないので、次に開いたときは`?lang=`かブラウザーの言語で決まる
- 切り替えで変わるのは表示だけである。記録中に切り替えても、記録・統計・グラフ・ハッシュチェーンには影響しない。いま出ている注意書き・記録の穴の1行・超音波帯の現在値・上限の表示・凡例・状態の表示も、新しい言語で描き直す
- CSVの中身（ヘッダーの`key=value`と列名）と書き出すファイル名は、言語によらず同じである。マイクの名前（`# device=`）は端末が返す文字列のままで、訳さない
- スクリプトが動く前の一瞬は、HTMLに書いてある日本語が出る（英語を選んでいても同じ）

### 帯域の計算を止める（`?bands=off`）

URLの末尾に`?bands=off`を付けて開くと（例：`https://ipusiron.github.io/mic-gain-logger/?bands=off`）、帯域（超音波帯・可聴帯）の計算を止めます。同じ版で帯域あり・なしの有効サンプル率を比べるためのものです。止めたときは、CSVの帯域の3列が空欄になり、ヘッダーが`# bands=off`になります。画面では、凡例と注意書きに「止めています」と出て、超音波帯の線は描かれず、「超音波帯の最大」は`--.-`のままです。表示下限の既定は-90dBFSになります。

---

## 🎯 ユースケース

本ツールが残すのは、dBFSという端末ごとの相対値の時系列です。音圧（dB SPL）ではないので規制値・基準値とは比べられず、帯域の値からは何の音かは分からず、記録は証明に使えません。作者は悪用を勧めません。記録してよいかどうかは、国・地域の法令や状況によって異なります（下の「⚖️ 利用上の注意（法的な助言ではありません）」）。

### 🧭 活用例（要点）

- 平時と比べる：同じ端末・同じ置き場所・同じログ間隔で採った平時の記録と並べ、いつもより音（超音波帯を含む）が上がった時間帯を探す
- 暮らし・家庭：家電が動いていた時間、ペットの留守番、自分のいびき・楽器の練習時間、身の回りの機器の高い音
- 教育・学習：dBFSとdB SPLの違い、サンプリング周波数とナイキスト周波数、FFTの窓とビン、端末ごとのマイクの上限、聴力の気づき
- 仕事・創作：収録の下準備、設備の運転時間の見当
- 趣味・電子工作・自然観察：発振回路・ブザーの確かめ、鳥が鳴き始める時刻、夜の虫の声
- 研究・セキュリティの監査：エアギャップの監査・検証、音の方向探知・発信源の絞り込み、ハッシュチェーンの限界を確かめる
- ほかのツールや記事との組み合わせ：『エアギャップ・ブリッジ』、音源ページ（Tone Sweep）、表計算ソフト・Python

⚠どの活用例にも、次の限界があります。記録できるのはサンプルレートの半分まで（48kHzなら24kHz）で、24kHzより上の音はその周波数として記録できません。2台の端末のdBFSは比べられず、マイク1本では方向は分からないので、方向探知は端末を動かしながら行います。

想定ターゲット層、想定する使い方、規制値・基準値と比べられない理由、各活用例の「誰が・何をして・何が分かるか」と限界、具体的なシナリオ例（探偵の調査で活動時刻を残す、オフィスの音が集中する時間帯を洗い出す）は、[ユースケースの資料](docs/use-cases.md)にあります。

---

## ⚖️ 利用上の注意（法的な助言ではありません）

本ツールは音量レベルだけを記録し、音声そのものは録音しません。それでも、他人の生活空間や職場の音を継続して記録する行為には、法的な制約がかかることがあります。何が問題になるかは、記録の目的、機器を置いた場所、記録した期間、記録を誰に見せるかによって変わります。

以下は、2026-09-28時点でe-Gov法令検索の原文にあたって確認できた範囲だけを書いたものです。本ドキュメントは、特定の法令が当てはまるかどうかを判断するものではありません。

### 原文で確認できた事項

- 取引・証明の用途：**本ツールの出力は、取引や証明の用途には使えない。**騒音計は計量法上の「特定計量器」である（計量法施行令 第2条第15号）。検定に合格した証印のない特定計量器、および計量器でないものは、取引または証明における計量に使用してはならず、使用に供するために所持することもできない（計量法 第16条第1項）。違反には罰則がある（同法 第172条第1号）。計量法第2条第2項は「証明」を「公に又は業務上他人に一定の事実が真実である旨を表明すること」と定義している
- 騒音規制法の規制基準：比べるには、検定に合格した騒音計が要る。規制基準の測定方法を定めた告示は、使用する計量器を「計量法第七十一条の条件に合格した騒音計」に限定し、周波数補正回路はA特性、動特性は速い動特性（FAST）を用いることとしている（特定工場等において発生する騒音の規制に関する基準・昭和43年厚生省・農林省・通商産業省・運輸省告示第1号 備考3）
- 職場の騒音の基準値：A特性音圧レベルの等価騒音レベルである。測定方法は作業環境測定基準（昭和51年労働省告示第46号）第4条が定め、「測定に用いる機器（以下「騒音計」という。）は、等価騒音レベルを測定できるものであること」「騒音計の周波数補正回路のA特性で行うこと」としている
- 探偵業の届出：業として他人の所在・行動を調べる営業には、届出義務がある（探偵業の業務の適正化に関する法律 第4条第1項）。同法第6条は「この法律により他の法令において禁止又は制限されている行為を行うことができることとなるものではないことに留意するとともに、人の生活の平穏を害する等個人の権利利益を侵害することがないようにしなければならない」と定める。届出をしても、記録行為そのものが適法になるわけではない

### 使う前に確かめてほしいこと

- 記録をとる場所に立ち入る権限があるか
- 記録をとることについて、対象となる人の同意があるか、または同意に代わる正当な根拠があるか
- 取得したデータを目的の範囲にとどめ、不要になったら削除できる状態か
- その記録を第三者へ出す予定があるなら、出してよいものかどうかを事前に確認したか

### 運用の原則（法令の話ではなく、実務上の心構えである）

- 最小限の原則：目的の達成に必要な範囲だけを記録する
- 透明性の確保：可能な限り、記録している事実と目的を明らかにする
- データ最小化：不要になった記録は速やかに削除する
- 第三者提供の制限：正当な理由なく他者へ渡さない

### ここに書いていないこと

上の列挙は、当てはまる可能性のある法令を網羅したものではありません。民事上のプライバシー侵害、記録する場所への立ち入り、個人情報の取扱い、地方公共団体の条例などは、ここでは検討していません。実際に使う前に弁護士等の専門家へご確認ください。

（確認日2026-09-28。出典はe-Gov法令検索 https://laws.e-gov.go.jp/ 、環境省 https://www.env.go.jp/hourei/07/000052.html 、厚生労働省 https://www.mhlw.go.jp/content/001089239.pdf です）

---

## 📚 資料（docs/）

READMEには入口として要点だけを書き、詳しい説明は`docs/`に分けています。

| ファイル | 中身 |
|---|---|
| [docs/features.md](docs/features.md) | 主な機能の詳しい説明（画面の表示・記録と統計・記録の中身とCSV・操作と表示の設定） |
| [docs/csv.md](docs/csv.md) | CSVの形式（列・欠測・帯域の列・ヘッダー・トレーラー・ログ間隔・セッションの境界）、ハッシュチェーンで何が分かるか、検証器、Excel/Google Sheetsの手順、推奨分析手法、Pythonのレシピ、複数のCSV・2台の端末の記録 |
| [docs/real-device-test.md](docs/real-device-test.md) | iPhone 18 Pro Maxの実機テスト（端末と条件・FFTを計算するときの有効サンプル率・18〜22kHzの階段シーケンス・扇風機とスピーカー・確かめていないこと・やり方） |
| [docs/measurement.md](docs/measurement.md) | 計測の作りと実測値、dBFSの基礎知識、画面の大きな数字とCSVの`dbfs`の違い、セキュリティ的背景、技術スタックと実装の読み方 |
| [docs/use-cases.md](docs/use-cases.md) | 想定ターゲット層、想定する使い方、規制値・基準値とは比較できない理由、活用例の全文、具体的なシナリオ例 |
| [docs/troubleshooting.md](docs/troubleshooting.md) | よくある問題と解決方法 |
| [docs/roadmap.md](docs/roadmap.md) | 第2弾で入れたもの、第3弾の案、その先の案、将来案に入れないもの |

---

## 🧪 テスト

```bash
npm test
```

- Node.js 22以上で動く。依存パッケージはなく、`package.json`は`node --test`を呼ぶだけである
- GitHub Actions（`.github/workflows/test.yml`）が、pushとpull requestのたびに同じ`npm test`を実行する
- テストは実装だけでなく、READMEとdocs/の表と数値も確かめる。検証器の実測表（`test/chain-claim.test.js`）、Leqの検算値（`test/session-weight.test.js`）、ディレクトリー構造（`test/docs.test.js`）、実機テストの表（`test/readme-realdevice.test.js`）、CSVのレシピの出力（`test/readme-recipes.test.js`）、見出しの順と活用例（`test/readme-structure.test.js`）、READMEとdocs/の分け方・相互参照・強調の数（`test/readme-docs.test.js`）である
- 件数はREADMEに書かない。`npm test`の出力で確かめる（書くと古くなるため）

---

## 📁 ディレクトリー構造

```
mic-gain-logger/
├── index.html                     # メインページ（UI・ヘルプモーダル・CSPの宣言）
├── style.css                      # スタイルシート（ダーク/ライトモード・モバイル最適化）
├── script.js                      # DOMとブラウザーAPI（マイク取得・描画・CSV書き出し）
├── logic.js                       # 純ロジック（dBFS換算・区間・統計・グラフ座標・CSV組み立て）
├── messages.js                    # 画面の文言の辞書（日本語・英語）と、表示の言語の決め方
├── worklet/                       # オーディオスレッドで動くコード
│   └── meter-processor.js         # AudioWorkletProcessor（区間ごとの集計）
├── docs/                          # 詳しい資料（日本語）。READMEの「📚 資料（docs/）」から案内する
│   ├── en/                        # 英語版の資料（docs/と同じファイル名）。README.en.mdの「📚 Documents (docs/en/)」から案内する
│   │   ├── features.md            # 主な機能の詳しい説明（英語）
│   │   ├── csv.md                 # CSVの形式・ハッシュチェーン・検証器・Excelの手順・Pythonのレシピ（英語）
│   │   ├── real-device-test.md    # iPhone 18 Pro Maxの実機テストの条件・結果・やり方（英語）
│   │   ├── measurement.md         # 計測の作りと実測値・dBFSの基礎知識・セキュリティ的背景・技術スタック（英語）
│   │   ├── use-cases.md           # 想定ターゲット層・想定する使い方・規制値と比べられない理由・活用例・シナリオ（英語）
│   │   ├── troubleshooting.md     # よくある問題と解決方法（英語）
│   │   └── roadmap.md             # 第2弾で入れたもの・第3弾の案・その先の案・将来案に入れないもの（英語）
│   ├── features.md                # 主な機能の詳しい説明
│   ├── csv.md                     # CSVの形式・ハッシュチェーン・検証器・Excelの手順・Pythonのレシピ
│   ├── real-device-test.md        # iPhone 18 Pro Maxの実機テストの条件・結果・やり方
│   ├── measurement.md             # 計測の作りと実測値・dBFSの基礎知識・セキュリティ的背景・技術スタック
│   ├── use-cases.md               # 想定ターゲット層・想定する使い方・規制値と比べられない理由・活用例・シナリオ
│   ├── troubleshooting.md         # よくある問題と解決方法
│   └── roadmap.md                 # 第2弾で入れたもの・第3弾の案・その先の案・将来案に入れないもの
├── test/                          # テスト（node:test・依存パッケージなし）
│   ├── logic.test.js              # 純関数（clamp・dBFS換算・時刻整形ほか）
│   ├── interval.test.js           # 「1行＝1区間」の組み立て
│   ├── meter-processor.test.js    # ワークレット本体をnode:vmの中で動かす
│   ├── clock.test.js              # AudioContextの中断による時刻のずれ
│   ├── silence.test.js            # デジタル無音を記録に残す
│   ├── device.test.js             # マイクのデバイス喪失の検出
│   ├── connect.test.js            # マイク取得のタイムアウトと取り消し
│   ├── meta.test.js               # 測定条件のメタデータ
│   ├── css.test.js                # セレクターの記述順（スマートフォンの設定UI）
│   ├── canvas.test.js             # キャンバスの大きさ（RangeError・pxの直書き・横はみ出し）
│   ├── graph.test.js              # 実時間の横軸・目盛りとラベル
│   ├── stats-csv.test.js          # 画面の統計とCSVから再計算した統計の一致
│   ├── contrast.test.js           # 両テーマのコントラスト比
│   ├── cleanup.test.js            # 死にコード・入力フォント・タッチターゲット
│   ├── hashchain.test.js          # ハッシュチェーン（起点・トレーラー・欠落と入れ替わりの検出）
│   ├── chain-runner.test.js       # 記録中に鎖を進める入れ物（非同期の状態機械）
│   ├── chain-claim.test.js        # 鎖の名乗りと、検証器の表の値が実測と合っているか
│   ├── smoothing.test.js          # スムージングの設定を置かないことと、その理由の説明
│   ├── stats-weight.test.js       # 統計（Leq）を区間長で重み付けする
│   ├── stats-notice.test.js       # ピーク・クリップ・有効サンプル率と記録の穴の表示
│   ├── interval-label.test.js     # 行に貼るログ間隔を実測の区間長にする
│   ├── session-weight.test.js     # 停止→再開をまたいで重みを取る手順と検算値
│   ├── reset.test.js              # 統計リセットで母集団（ログ・統計・グラフ・注意書き）をまとめて捨てる
│   ├── processing-label.test.js   # メタ行のprocessingをoff／active／unknownの3値で書く
│   ├── clip-notice.test.js        # クリップの注意書き（分母・単発と連続）とサンプルピークの呼び方
│   ├── css-order.test.js          # 幅で切り替える規則が後ろの素の規則に打ち消されていないか
│   ├── meter-floor.test.js        # メーターの目盛りと表示下限の既定（帯域あり-110dBFS・?bands=offで-90dBFS）
│   ├── notice-details.test.js     # 注意書きを「件数と要点の1行＋開くと全文」にする
│   ├── review-ui.test.js          # 画面の細部（停止中のグラフ・目盛り・ボタンの高さ）
│   ├── fft.test.js                # FFTの基本部分（素朴なDFTとの一致・片側スペクトルの正規化・配列を作らない約束）
│   ├── band.test.js               # 区間ごとの帯域の集計（ビンの割り当て・75%の重なり・途切れ・1行目の帯域の有効率）
│   ├── csv-v3.test.js             # CSV v3（帯域の3列・ヘッダーの約束・欠測の空欄化・v2とv3を1本の手順で検証）
│   ├── band-ui.test.js            # 画面の帯域（超音波帯の破線・欠測で線を切る・超音波帯の最大・注意書き・記録できる上限）
│   ├── mobile-view.test.js        # スマートフォンのファーストビュー（記録開始と停止を1つの場所に・「その他」・dvh）
│   ├── ultra-now.test.js          # 超音波帯の現在値と、画面の大きな数字とCSVの値の窓の違い
│   ├── readme-realdevice.test.js  # 実機テストの表が、実機の記録（リポジトリーの外に保管）の値と同じか
│   ├── readme-recipes.test.js     # CSVのレシピの出力を、見本CSVからJSで計算し直して比べる
│   ├── readme-structure.test.js   # シリーズ標準の見出しの順・活用例の必須項目・画面の数字とCSVの違い
│   ├── readme-docs.test.js        # READMEとdocs/の分け方（行数・案内の表・相互参照・強調の数・いまの版のことだけを書く）
│   ├── no-bold-labels.test.js     # 箇条書きの先頭の項目名を太字にしない（README・docs/の日英）
│   ├── readme-en.test.js          # 英語版のREADMEとdocs/en/が日本語版とそろっているか（見出し・表の数値・コードの処理・レシピの出力・用語）
│   ├── i18n.test.js               # 画面の日英対応（辞書のキーの一致・英語の表示に日本語が残らない・言語の決め方）
│   ├── dbfs-fixture.test.js       # 既知振幅の正弦波に対するdBFSの計算精度
│   ├── docs.test.js               # README・docs/と実装・実ファイルが合っているかの検査（構成図を含む）
│   └── fixtures/                  # テストの期待値
│       ├── expected_dbfs.json     # 既知振幅の正弦波から作った期待dBFS
│       └── sample_v2.csv          # v2（7列）の見本CSV（検証器がv2も通すことの確認用）
├── assets/                        # ファビコンとREADME.md用の画像
│   ├── favicon.svg                # ファビコン（レベルメーターの棒。外部への取得は発生しない）
│   ├── screenshot.png             # 記録中の画面（ライトテーマ）
│   ├── screenshot2.png            # スマートフォン幅で設定を開いた画面
│   ├── screenshot3.png            # 記録中の画面（ダークテーマ）
│   └── en/                        # 英語の画面（README.en.md用）
│       ├── screenshot.png         # 記録中の画面（ライトテーマ、英語）
│       ├── screenshot2.png        # スマートフォン幅で設定を開いた画面（英語）
│       └── screenshot3.png        # 記録中の画面（ダークテーマ、英語）
├── .github/                       # GitHubの設定
│   └── workflows/                 # GitHub Actionsのワークフロー
│       └── test.yml               # CI（pushとpull requestでnpm testを実行する）
├── package.json                   # npm testの定義（依存パッケージなし）
├── .nojekyll                      # GitHub PagesでJekyll処理を無効化（空ファイル）
├── .gitignore                     # Gitの除外設定
├── CLAUDE.md                      # 開発ガイド（ファイルの役割分担・計測の要点・CSVの約束・READMEとdocs/の構成）
├── README.md                      # プロジェクト説明書の入口（本ファイル）
├── README.en.md                   # 英語版のプロジェクト説明書の入口
└── LICENSE                        # MITライセンス
```

---

## 💻 動作環境

### ブラウザー対応状況

ここが「どこまで確かめたか」の唯一の記載場所です。docs/のシナリオ例・実測値・実機テストの資料は、いずれもここを指しています（[実機テストの資料](docs/real-device-test.md)にあるのは、測った値と測り方です）。

⚠**実機で確かめたのは、iPhone 18 Pro Max（iOS Safari）の1台だけです（2026-09-29）。**

- 確かめた版：公開版の`c7b6bad`と`090648f`の2つ（帯域の記録が入っているのは`090648f`）。サンプルレートは48000Hzだった
- 記録からCSVの検証まで：どちらの版でも、AudioWorkletのモジュールが読み込めて高精度モードで動き、記録→停止→CSV書き出しが通った。書き出したCSVは、すべて[CSVの資料](docs/csv.md)の「受け取ったCSVを検証する」の検証器を通った
- 実機のCSVで確かめたこと：`090648f`で、帯域の記録（ワークレットのFFT・CSV v3）、加工の状態の書き方（`unknown:`）、1行目の`valid_ratio`を確かめた。FFTを計算してもレンダークォンタムを落とさないことは、画面をつけたままの1分・2分の記録で確かめた
- 画面で見たこと（筆者の記憶による）：21kHzのときは超音波帯の破線が出て、22kHzでは記録した版の表示下限（-90dBFS）の下端に張り付いて見えなかった。画面の超音波帯の破線は、CSVでは確かめられない
- 確かめていないこと：Androidの実機と、実機での画面ロック中・バックグラウンドの挙動。長時間の記録と、ほかのiPhone（機種やiOSの版が違うもの）。実機テストの版（`090648f`）より後に入れた画面（表示下限の既定-110dBFS・超音波帯の現在値・ボタンの配置）と、日英の切り替え（デスクトップのChromiumでだけ確かめた）

行数・`valid_ratio`などの測った値は、[実機テストの資料](docs/real-device-test.md)にあります。それ以外のモバイル幅での確認は、デスクトップのChromium（Playwright）で幅320〜430px・CPU4倍/20倍のスロットル・画面ロック相当の状態を作って行ったものです。「画面ロック相当」はブラウザーのエミュレーションであり、実機の画面ロックではありません。

| ブラウザー | デスクトップ | モバイル | 備考 |
|---|---|---|---|
| Chrome / Edge（Chromium） | ✅ 実測で確認 | ⚠️ エミュレーションのみ | READMEとdocs/の実測値は、実機テストの資料と、実機のCSVにかけたレシピの出力を除いて、Chromiumで採った |
| Firefox | ⚠️ 未検証 | ⚠️ 未検証 | Web Audio APIとAudioWorkletには対応しているが、実機では確かめていない |
| Safari | ⚠️ 未検証 | ✅ iPhone 18 Pro Maxの実機1台で、記録・帯域・CSVを確認 | 画面ロック中・バックグラウンドは未確認。`getSettings()`は音の加工の3項目のうち`echoCancellation`しか報告せず、メタ行は`# processing=unknown:autoGainControl+noiseSuppression`になる（実機のCSVで確認。WebKitのソースを読んだ見立てと同じ） |
| Opera | ⚠️ 未検証 | ⚠️ 未検証 | Chromium系なので同等と見込まれるが、確かめていない |

AudioWorkletが使えない環境では簡易モードへ切り替わります。簡易モードでも記録はできますが、画面の描画が止まると記録も止まります。

### 動作の前提

- 安全なコンテキスト（https・`localhost`・`file://`）：`getUserMedia`と`crypto.subtle`がどちらも安全なコンテキストを要求する。httpsでないホスト名やIPアドレスつきのURLで開くと、マイクも取れずハッシュ列も空になる。⚠**`file://`は安全なコンテキストなので、どちらも使える。**ただしAudioWorkletのモジュールを読み込めないので簡易モードになる（Chromiumで実測）
- デスクトップ：Windows 10+, macOS 10.15+, Ubuntu 18.04+
- モバイル：iOS 13+, Android 8.0+
- メモリー：ログはすべてブラウザーのメモリーに載る。ログ間隔1秒で24時間回すと86,400行になる

### ローカルで動かす

```bash
python -m http.server 8000
# ブラウザーで http://localhost:8000/ を開く
```

- `file://`で直接開くと、AudioWorkletのモジュールを読み込めず簡易モードになる（[トラブルシューティング](docs/troubleshooting.md)の簡易モードの項）。HTTPで配信して開く
- `localhost`は安全なコンテキストなので、マイクもハッシュも使える。同じLANのスマートフォンから`http://192.168.x.x:8000/`のように開くと、マイクもハッシュも使えない（[CSVの資料](docs/csv.md)の「ハッシュが計算できない場所」）。スマートフォンで試すときは、GitHub Pagesのデモページを使う

---

## 📄 ライセンス

MIT License - 詳細は [LICENSE](LICENSE) をご覧ください。

---

## 🛠️ このツールについて

本ツールは、「生成AIで作るセキュリティツール100」プロジェクトの一環として開発されました。  
このプロジェクトでは、AIの支援を活用しながら、セキュリティに関連するさまざまなツールを100日間にわたり制作・公開していく取り組みを行っています。

プロジェクトの詳細や他のツールについては、以下のページをご覧ください。

🔗 [https://akademeia.info/?page_id=42163](https://akademeia.info/?page_id=42163)
