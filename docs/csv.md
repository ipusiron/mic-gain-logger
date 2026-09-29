# 📊 CSVデータの形式と活用方法

[READMEへ戻る](../README.md)

書き出したCSVの形式、ハッシュチェーンで分かること・分からないこと、受け取ったCSVの検証、表計算ソフトとPythonでの集計の手順をまとめます。

## CSVの形式（v3）

ファイルは4つの部分でできています。ヘッダー（`#`で始まる行）→列のヘッダー→データ行→トレーラー（`#`で始まる行）の順です。

- **ヘッダー**：記録を始めた時点で決まる測定条件である。ハッシュチェーンの起点でもある
- **トレーラー**：記録が終わってはじめてわかる事実である（行数、どのseqをどのログ間隔で測ったか、セッションの境界、無音があったか、時刻の跳びがあったか）

次の見本は、手で書いたものではなく、実際に書き出したCSVそのものです。Chromiumの疑似マイク（`--use-file-for-fake-audio-capture`）に、1kHz（-20dBFS）と19kHz（-30dBFS）の合成音を2秒、デジタル無音を2秒と繰り返し流し、ログ間隔1秒で4区間を記録しました。3行目がデジタル無音の区間です。

```
# format=mic-gain-logger/3
# engine=worklet
# started=2026-09-29T03:06:21.680Z
# sampleRate=48000
# nyquistHz=24000
# device=Fake Default Audio Input
# processing=off
# settingsRaw=echoCancellation:false;autoGainControl:false;noiseSuppression:false;sampleRate:44100;channelCount:2
# weighting=Z
# bands=18000-22000,20-18000
# fftSize=1024
# hash=sha-256-chain-16
timestamp,dbfs,seq,peak_dbfs,clip,valid_ratio,band_ultra_dbfs,band_audible_dbfs,band_valid_ratio,hash
2026-09-29T03:06:21.680Z,-19.70,0,-14.83,0,1.000,-30.44,-20.03,1.000,030554522ee00119
2026-09-29T03:06:22.680Z,-19.72,1,-14.83,0,1.000,-30.45,-20.05,1.000,b274e8d3ca7e6a0e
2026-09-29T03:06:23.680Z,-Infinity,2,-Infinity,0,1.000,-Infinity,-Infinity,1.000,9381a0b301d41f3c
2026-09-29T03:06:24.680Z,-37.54,3,-14.83,0,1.000,-53.05,-42.59,1.000,bfe90bfc6ddf9b43
# rows=4
# intervalSec=1@0
# sessionStartAt=0
# silence=-Infinity
# trailerHash=8fc5d56a3447408a
```

`# settingsRaw=`の`sampleRate:44100;channelCount:2`は、疑似マイクの音声トラックが報告した値です。AudioContextのサンプルレート（`# sampleRate=48000`）とは別のもので、このように食い違うことがあります。音声トラックのほうが低いと、超音波帯の値が下がります（後述の「帯域の列」）。

⚠**あとからわかる事実をヘッダーへ入れてはいけません。**これは設計上の都合ではなく、ハッシュチェーンが成り立つための条件です。記録が終わってから増える値をヘッダーに置くと、起点が動いてしまい、同じセッションを2回書き出すと同じ行のハッシュが変わります。受け取った側からは、改変されたように見えます。後述の「なぜ起点をヘッダーとトレーラーに分けたのか」で詳しく説明します。

列の意味は以下のとおりです。

| 列 | 意味 |
|---|---|
| `timestamp` | 区間の終わりの時刻（ISO 8601・UTC） |
| `dbfs` | 区間のエネルギー平均（生値）。小数2桁に丸めて書き出す。デジタル無音は`-Infinity`。音が1つも届かなかった区間（欠測）は空欄（後述の「欠測の区間」） |
| `seq` | 区間の通し番号。1つのCSVの中で0から通しで振る（記録開始→停止→記録開始を繰り返しても、続きの番号から振る）。欠番があれば行が抜けている |
| `peak_dbfs` | 区間内のピーク。簡易モードで採った行と、欠測の区間では空欄 |
| `clip` | 0 dBFSに張り付いたサンプルの数。簡易モードで採った行と、欠測の区間では空欄 |
| `valid_ratio` | その区間で実際に集計できたサンプルの割合。1.000を下回っていれば、その区間の音の一部が届いていない（レンダークォンタムを落とした、入力が途切れたなど）。欠測の区間は`0.000`。記録開始直後は、オーディオクロックが1ブロックずつ途切れずに進むことを確かめてから区間を始める（最初の数ミリ秒は記録しない）。入力に音が載るまでも始めず、1秒待っても音が来なければそこから区間を始め、届かなかったぶんを欠測として残す。簡易モードで採った行では空欄 |
| `band_ultra_dbfs` | 超音波帯（18,000〜22,000Hz）の、区間のエネルギー平均。書式は`dbfs`と同じ（小数2桁、電力0なら`-Infinity`）。値がないときは空欄（後述の「帯域の列」） |
| `band_audible_dbfs` | 可聴帯（20〜18,000Hz）の、区間のエネルギー平均。超音波帯の値が高いか低いかを読むための対比として並べる。書式は`band_ultra_dbfs`と同じ |
| `band_valid_ratio` | 帯域の計算に使えたフレームの割合（数えたフレーム数÷数えるはずだったフレーム数）。書式は`valid_ratio`と同じ（小数3桁） |
| `hash` | ハッシュチェーンの値（SHA-256の先頭16文字）。安全なコンテキストでない場所で開いた場合は空欄（後述の「ハッシュが計算できない場所」を参照） |

⚠簡易モードでは`peak_dbfs`・`clip`・`valid_ratio`と帯域の3列が空欄になります。簡易モードは描画ループで1区間につき1つの値を受け取るだけなので、区間内のピークもクリップ数もサンプルの取りこぼしも数えられず、帯域にも分けられません。どちらのモードで採ったCSVかは、ヘッダーの`# engine=`でわかります。

`peak_dbfs`・`clip`・`valid_ratio`の3列は画面にも出ます。`peak_dbfs`の最大が統計欄の「サンプルピーク」、`clip`と`valid_ratio`の異常が状態表示の警告です。簡易モードでは測れないため、「サンプルピーク」は`--.-`のままになり、警告も出ません（測れないことを「異常なし」として出さないためです）。帯域の列も画面に出ます。`band_ultra_dbfs`はグラフの破線と統計欄の「超音波帯の最大」に、`band_valid_ratio`が1.000を下回った区間は注意書きに出ます。`band_audible_dbfs`はCSVにだけ出ます。

⚠`peak_dbfs`は0 dBFSを超えることがあります。Web Audioが渡すサンプルは浮動小数点なので、リサンプリングの跳ね返りで振幅が1.0を超えるためです。フルスケールの矩形波を流した実測では`peak_dbfs`が`1.70`（+1.7 dBFS）になり、同じ区間の`clip`は23,263サンプルでした。0 dBFSを超えていたら、その区間には振幅が1.0を超えた標本があります。上流で頭打ちになっていれば、その区間の`dbfs`は本来の音と違います。

A列が時刻、B列が音量です。新しい列はB列より右へ足す方針なので、この2列は動かしません。帯域の3列は`hash`列の左に置いてあり、`hash`列はJ列です。ハッシュの材料を「`hash`列より左のフィールド」とし、帯域の値も鎖に入れるためです。

ただし、**列のヘッダー行はファイルの1行目ではありません。**上に`#`から始まるヘッダーが並ぶからです。ヘッダーはふつう12行（値のない項目は行そのものが出ません）。データ行の下にもトレーラーが3〜10行付きます。表計算ソフトへ取り込むときは、後述の「Excel/Google Sheetsでの分析手順」のとおりに`#`から始まる行を読み飛ばしてください。

### 欠測の区間（`dbfs`が空欄の行）

音が1つも届かなかった区間（オーディオスレッドが区間のあいだずっとレンダークォンタムを落とした、記録開始から1秒待っても入力が届かなかった、など）は、`dbfs`・`peak_dbfs`・`clip`を空欄にし、`valid_ratio`を`0.000`にします。

欠測を`-Infinity`（デジタル無音）として残すと、「音がなかった」と「記録していなかった」をCSVの上で区別できないため、空欄にしています。画面の統計（平均・最大・最小）にも、この区間は入れません。無音として数えると、測っていない時間のぶん平均（Leq）が下がるためです。記録の穴としては数え、画面の注意書きと`valid_ratio`に残ります。

デジタル無音（サンプルは届いたが、振幅がすべて0）は、`-Infinity`で1行残します。

### 帯域の列（`band_ultra_dbfs`・`band_audible_dbfs`・`band_valid_ratio`）

⚠**帯域の値は、その帯域に音のエネルギーがあったかの記録です。**何の音かは分かりません。超音波ビーコンを検出するものでもありません。値は`dbfs`と同じく、端末（マイク・変換器・サンプルレート）に依存する相対値で、規制値・基準値とは比べられません（[ユースケースの資料](use-cases.md)の「規制値・基準値とは比較できない」）。

- **帯域の定義**：超音波帯は18,000Hz以上22,000Hz未満、可聴帯は20Hz以上18,000Hz未満である。ヘッダーの`# bands=18000-22000,20-18000`は、同じ定義を列の順に並べたもの
- **作り**：オーディオスレッドで、約21ミリ秒ぶんのサンプル（48kHzで1,024個。長さはヘッダーの`# fftSize=`）を1フレームとし、周期型のHann窓を掛けてFFTで周波数ごとの強さに分け、帯域ごとに足す。フレームは4分の1（約5ミリ秒）ずつずらして重ねるので、途切れのない区間では、どの時刻の音も同じ重みで数えられる
- **可聴帯の実際の下端**：約50Hzである。フレームごとに平均を引いてから計算するので、約100Hzより下の音は値が変わる。約50Hzより下は低めに読まれ、50〜100Hzでは±0.5dBほど上下する（48kHzで20Hzは約-8dB、30Hzは約-4dB、50Hzは約-0.4dB、70Hzは約+0.5dB）。`# bands=`の`20`は定義の値で、実際の感度ではない
- **22kHzちょうどの音**：帯域の端に乗るので低く出る（48kHzで約-2dB、44.1kHzで約-6dB）。超音波帯の上端より外へ漏れたぶんは、どの帯域にも入らない。44.1kHzでは22kHzがナイキスト周波数（22.05kHz）のすぐ下になる
- **ヘッダーの`# nyquistHz=`**：AudioContextのサンプルレートの半分である。帯域を計算できる上限ではあるが、実際に届く音の上限とは限らない。マイクの音声トラックのサンプルレート（`# settingsRaw=`の`sampleRate`）がこれより低いと、実際に届く上限はそちらの半分になり、その手前から値が下がることがある。疑似マイク（音声トラック44.1kHz・AudioContext 48kHz）に-20dBFSのトーンを流すと、1kHzは`dbfs`・`band_audible_dbfs`とも`-20.00`だったが、21kHzは`band_ultra_dbfs`が`-53.78`まで下がり、23kHzは`dbfs`が`-101.99`で残らなかった（どれも`# nyquistHz=24000`のまま）。超音波帯の値は、`# nyquistHz=`と、`# settingsRaw=`の`sampleRate`の半分の、小さいほうと並べて読む
- **画面の注意書き**：この食い違いは注意書きに出る。マイクの音声トラックのサンプルレートとAudioContextのサンプルレートが違うと、「サンプルレートの変換で、上限に近い高い音は低く記録されます」と両方の値が出る（上の疑似マイクの例では、-20dBFSの21kHzが約-54dBFSで記録された）。凡例の下の「この端末で記録できる上限」は、上の「小さいほう」（AudioContextとトラックのサンプルレートの小さいほうの半分）である。トラックがサンプルレートを報告しないときは、注意書きは出ず、上限はAudioContextの半分に「トラックの値は不明」を添えて出す
- **18kHzの境目**：約94Hzの範囲の音が隣の帯域へ分かれて入る（窓の漏れによる。両帯域を合わせた量は変わらない）
- **区間の境目の前の音**：約21ミリ秒の音が、後ろの区間の値に入ることがある。フレームを「フレームの終わりを含む区間」に数えるためである（区間が終わった時点で計算を終え、その行にハッシュを付けられるようにするため）。そのため、`dbfs`が`-Infinity`（デジタル無音）の行にも帯域の値が付くことがある。疑似マイクで音から無音へ切り替わった直後の区間を書き出すと、`dbfs`は`-Infinity`で、帯域は`-51.02`・`-40.58`だった
- **「超音波帯の最大」の数え方**：画面の統計「超音波帯の最大」は、デジタル無音の行に付いた帯域の値も数える。その値は境目の前の約21ミリ秒の実際の音であり、架空の値ではないためである（音が1つも届かなかった区間の行に付いた値も、同じ理由で数える）。一方、統計の「最大」「最小」は無音の行を外す
- **記録の起点の近くの音**：記録の起点から約21ミリ秒以内の音は、重みが下がる。起点から6.3ミリ秒の位置にある1ミリ秒の音は、約33%しか入らない。1行目を見せかけの欠測にしないための引き換えで、`band_valid_ratio`には出ない（記録を始めるたびに起きる）
- **`band_valid_ratio`**：数えたフレーム数÷数えるはずだったフレーム数である。1.000を下回るのは、レンダークォンタムを落としたとき・入力が空で届いたときで、そのサンプルを含むフレームを数えない（0で埋めると「音がなかった」ことになるため）。数えたフレームが0なら帯域の2列は空欄、数えるはずのフレームが0なら`band_valid_ratio`も空欄になる
- **`?bands=off`**：URLに付けて開くと、帯域を計算しない（同じ版で帯域あり・なしの`valid_ratio`を比べるためのもの）。このとき帯域の3列はすべて空欄になり、ヘッダーは`# bands=off`になる（`# fftSize=`は出ない）。画面では、凡例と注意書きに「止めています」と出て、グラフの破線は描かれず、統計の「超音波帯の最大」は`--.-`のままになる
- **超音波帯を測れないサンプルレート**：AudioContextのサンプルレートが低く、超音波帯にあたるビンが1つもないとき（ナイキスト周波数が18kHzに届かないとき）は、`band_ultra_dbfs`が空欄になり、画面の注意書きに「超音波帯を測れない」、凡例に「このサンプルレートでは測れません」と出る
- **簡易モード**：簡易モードで採った行も、帯域の3列は空欄である（測れないものを「異常なし」として出さない）。画面では、凡例に「簡易モードでは測れません」、注意書きに「帯域を計算していない（簡易モード）」と出る

### ヘッダー（記録開始時に確定する。ハッシュチェーンの起点）

| キー | 意味 |
|---|---|
| `format` | CSVの版（`mic-gain-logger/3`）。後述の「受け取ったCSVを検証する」の検証器は、7列の`mic-gain-logger/2`（v2）も確かめられる |
| `engine` | 記録を始めたときの計測モード。`worklet`（AudioWorklet）／`fallback`（簡易モード） |
| `started` | 最初の区間の時刻 |
| `sampleRate` | AudioContextのサンプルレート |
| `nyquistHz` | AudioContextのサンプルレート（上の`sampleRate`）の半分。帯域を計算できる上限の周波数である。44.1kHzなら`22050`で、超音波帯の上端（22,000Hz）がそのすぐ下になる。⚠マイクの音声トラックのサンプルレート（下の`settingsRaw`の`sampleRate`）がこれより低いと、実際に届く上限はそちらの半分になる（前述の「帯域の列」） |
| `device` | マイクのデバイス名 |
| `processing` | マイク側の音の加工（AGC・ノイズ抑制・エコーキャンセル）について、ブラウザーの`getSettings()`が報告した状態。`off`＝3項目すべてが無効と報告された。`active:<項目>`＝有効と報告された項目。`unknown:<項目>`＝ブラウザーが報告しなかった項目（WebKitのソースを読むと、Safariは`autoGainControl`と`noiseSuppression`を報告しない作りになっている。iPhone 18 Pro Maxの実機のCSVでも、この2項目は報告されなかった）。両方あるときは`active:echoCancellation;unknown:autoGainControl`のように`;`でつなぐ |
| `settingsRaw` | `getSettings()`が報告した生の値のうち、音の加工とサンプルレートに関わる5項目（`echoCancellation`・`autoGainControl`・`noiseSuppression`・`sampleRate`・`channelCount`）。報告しない項目は`unreported`。`processing`は解釈、こちらは生の値で、両方を残す。ここの`sampleRate`はマイクの音声トラックの値で、上の`sampleRate`（AudioContext）と違うことがある。⚠端末を特定できる`deviceId`・`groupId`は入れない |
| `weighting` | 周波数の重み付け。本ツールは重み付けをしないので常に`Z` |
| `bands` | 帯域の定義（Hz、下限以上・上限未満）。列の順に超音波帯・可聴帯を並べる（`18000-22000,20-18000`）。`?bands=off`で開いたときは`off` |
| `fftSize` | 帯域の計算に使ったFFTの長さ（44.1kHz・48kHzで`1024`、88.2kHz・96kHzで`2048`。どれも約21〜23ミリ秒）。帯域を計算しないとき（`?bands=off`・簡易モード）は行そのものが出ない |
| `hash` | ハッシュチェーンの方式。鎖を作れなかった記録では行そのものが出ない |

### トレーラー（記録が終わってからわかる）

| キー | 意味 |
|---|---|
| `rows` | データ行の数。行数が合わなければ末尾が落とされている |
| `intervalSec` | その区間を実際に測ったときのログ間隔（秒）を、`間隔@開始seq`の形で並べる（例：`1@0+3@12`＝seq 0から1秒、seq 12から3秒）。変わったところだけを出すので、`+`が入っていなければ全区間が同じ間隔である。ログ間隔は記録中でも変えられ、ログはセッションをまたいで累積するので、1つのCSVに複数の間隔が混ざることがある。⚠**画面の設定値ではない**（後述の「ログ間隔の切り替えと行のラベル」） |
| `engines` | 計測モードが途中で変わった記録にだけ付く（例：`worklet+fallback`）。ヘッダーの`engine`は記録を始めたときの値なので、その差をここで示す |
| `sessions` | このCSVに入っている計測セッションの数。「記録開始→停止→記録開始」を繰り返すと増える。1つのセッションで採った記録には付かない。⚠この行が付いていたら、ヘッダーは1つめのセッションの条件でしかない（2つめ以降で別のマイクへ差し替えていても、ヘッダーからは分からない） |
| `sessionStartAt` | 各計測セッションの先頭行の`seq`（カンマ区切り）。1行目は前の行がないので必ず入る。⭐**この`seq`の行では、区間長を`timestamp`の差で取ってはいけない**（記録を止めて再開した境界では、差に休止時間がまるごと入る）。後述の「Excel/Google Sheetsでの分析手順」で使う |
| `silence` | 無音の書き方。無音を含む記録にだけ付く（`-Infinity`） |
| `clockBreaks` | AudioContextの中断を検出した回数。検出しなかった記録には付かない |
| `clockBreakAt` | 中断を跨いだ区間の`seq`（カンマ区切り）。その行の直前でアンカーを取り直している |
| `clockDriftMs` | 検出した跳びの累計（ミリ秒） |
| `trailerHash` | トレーラー自身のハッシュ。鎖の最後の輪である（後述の「ハッシュチェーンで何が分かるか」） |

画面のロックやタブの休止でAudioContextが止まると、オーディオクロックだけが遅れて、そのままではタイムスタンプが無言でずれます。本ツールはこれを検出してアンカーを取り直し、跨いだ区間を`# clockBreakAt=`に残します。この`seq`の行をまたいで時刻が飛んでいるのは正常です。

```
# clockBreaks=2
# clockBreakAt=11,25
# clockDriftMs=880
```

### ログ間隔の切り替えと行のラベル

ログ間隔は記録中に変えられます。ただし、**変更が反映されるのは次の区間の境界からです。**区間の集計はオーディオスレッドで行っているので、画面の設定を変えた瞬間に測りかけの区間を切ることはできません。

そのため、画面の設定値と、その区間を実際に測った間隔が食い違う区間ができます。ワークレット本体を通した実測では、1秒で2区間を採ってから3秒へ切り替えたとき、次の1区間（seq 2）はまだ1秒で測られていました。

| `seq` | 実際に測った区間長 | 画面の設定値 |
|---|---|---|
| 0 | 1.000000秒 | 1 |
| 1 | 1.000000秒 | 1 |
| 2 | 1.000000秒 | 3（設定はもう3になっている） |
| 3 | 3.000000秒 | 3 |
| 4 | 3.000000秒 | 3 |

行のラベル（トレーラーの`# intervalSec=`）は、画面の設定値ではなく、区間レコードが持つ`startFrame`／`endFrame`の差、つまり実測の区間長から決めます。トレーラーには変わったところだけを`間隔@開始seq`で並べるので、上の記録は`# intervalSec=1@0+3@3`になり、seq 2が1秒で測られたことを読み取れます。区間ごとの間隔の列は設けず、トレーラーの1行で示します。

### セッションの境界（`# sessionStartAt=`）

`timestamp`は区間の終わりの時刻なので、隣の行との差がそのまま区間長になります。**ただし記録を止めて再開した境界では成り立ちません。**セッションごとに`AudioContext`を作り直し、壁時計のアンカーも取り直すので、その差に休止時間がまるごと入ります。

実測（17行・1秒間隔・2セッション・境界の`timestamp`の差が60.032秒＝休止59.032秒＋その区間の1秒）。

| 区間長の取り方 | Leq | 重みの総和 |
|---|---|---|
| 画面の値（区間レコードの`endTime - startTime`） | -22.8601 dBFS | 17秒 |
| `timestamp`の差をそのまま重みにする | -29.3472 dBFS（6.49dB低い） | 76.032秒 |
| 境界の行だけ`# intervalSec=`の値にする | -22.8601 dBFS（画面と一致） | 17秒 |

⚠ずれの向きは記録の中身で変わります。境界の行が静かなら低く、大きければ高く出ます。同じ休止時間で並びを入れ替えた記録では+2.00dBでした。休止が長いほど大きくなり、600秒の休止では-15.42dBでした。

そこで、各セッションの先頭行の`seq`を`# sessionStartAt=`に出しています。**この行と、`# clockBreakAt=`の行では、区間長を差から取らないでください。**後述の「Excel/Google Sheetsでの分析手順」に組み込んであります。

## ⚠ CSVを人に渡す前に中身を確かめる

ヘッダーの`# device=`には、マイクのデバイス名がそのまま入ります。**機器名に利用者の名前が含まれていることがあります**（「〇〇のAirPods」など）。渡す前にこの行を開いて確認し、必要なら削ってください。

ただし、ハッシュチェーンの起点はヘッダーそのものです。ヘッダーを書き換えると、ハッシュの再計算は1行目から通らなくなります。

## ハッシュチェーンで何が分かるか

各行のハッシュは「前の行のハッシュ＋その行のデータ」から計算します。鎖は3つでできています。

1. **起点＝ヘッダー**：記録を始めた時点で確定するので、記録中も書き出し後も動かない
2. **データ行**：前の行のハッシュを材料に混ぜて、上から順につながる
3. **トレーラー＝最後の輪**：最後のデータ行のハッシュを材料に混ぜて計算する。これがあるので、末尾の行をまとめて落としたことも分かる

### 分かること

⭐**分かるのは、CSVがそのまま渡ってきたときに、うっかりの破損・部分的な欠落・順序の入れ替わりを見つけることまでです。**この範囲でなら、次のように役に立ちます。

- 転送や保存の途中で壊れた・一部が欠けたことに気づける
- Excelで編集して保存し直したものを、原本と取り違えない（`#`の行を外した時点で検証は通らなくなるので、加工したファイルだと分かる）
- 行を消したまま渡された場合に、**消したことに気づいていない相手**なら分かる

`seq`の欠番も、これとは別の手がかりになります。

### 分からないこと

⚠⚠**意図的な改変には、相手が誰であっても耐えません。**分かれ目は「本人か第三者か」ではなく、ハッシュを再計算するかどうかです。

鎖の作り方は、後述の「受け取ったCSVを検証する」に全部書いてあります。値を書き換えたあとに同じ手順でハッシュを計算し直せば、検証はそのまま通ります。下の表は、上の見本CSVに改変を加え、別のスクリプトで鎖を張り直してから、後述の「受け取ったCSVを検証する」の検証器にかけた結果です（v2の見本でも同じ結果でした）。

| 改変の内容 | 改変しただけ | 鎖を張り直したあと |
|---|---|---|
| 2行目を消す | `2行目から合いません` | `3行すべて通りました（トレーラーも一致）` |
| 2行目と3行目を入れ替える | `2行目から合いません` | `4行すべて通りました（トレーラーも一致）` |
| 1行目の`dbfs`を`-19.70`から`-12.00`へ書き換える | `1行目から合いません` | `4行すべて通りました（トレーラーも一致）` |
| 末尾2行を切り落とす | `トレーラーが合いません` | `2行すべて通りました（トレーラーも一致）` |
| 無音の行を消す | `3行目から合いません` | `3行すべて通りました（トレーラーも一致）` |
| ヘッダーの`# device=`を差し替える | `1行目から合いません` | `4行すべて通りました（トレーラーも一致）` |
| データ行の時刻を1時間ずらす | `1行目から合いません` | `4行すべて通りました（トレーラーも一致）` |

これを変える手は2つしかありません。秘密鍵で署名するか、外部のタイムスタンプ機関にハッシュを預けるかです。

⚠どちらも本ツールでは採りません。外部へ預けるには外部通信が必要で、それは「端末内で完結し、外へ何も送らない」という本ツールの作り（CSPで`connect-src 'none'`を宣言していること）を壊します。署名のほうも、鍵を端末内でどう守るかという別の問題を丸ごと抱え込みます。

したがって、このCSVは**記録が正しいことの証明にはなりません**。証明が要る用途には、署名やタイムスタンプ機関を備えた別の仕組みを使ってください。

### ハッシュが計算できない場所

ハッシュには`crypto.subtle`を使います。これは安全なコンテキストでしか使えないので、httpsでないホスト名やIPアドレスつきのURL（`http://192.168.1.10:8000/`など）で開くと`hash`列が空になり、`# hash=`と`# trailerHash=`の行も出ません。Chromiumで`http://notlocalhost:8765/`（名前解決だけを`127.0.0.1`へ向けたもの）を開いて測ると、`window.isSecureContext`が`false`、`crypto.subtle`は`undefined`で、`navigator.mediaDevices`も`undefined`でした。**この場所ではマイクも取れません。**

⚠**`file://`はこれに当てはまりません。**同じChromiumで`file:///D:/…/index.html`を開くと`window.isSecureContext`は`true`で、`crypto.subtle.digest('SHA-256', 'abc')`も通りました（先頭16文字は`ba7816bf8f01cfea`）。実際に`file://`のまま5秒ほど記録してCSVを書き出したところ、`hash`列は埋まり、`# hash=`と`# trailerHash=`の行も出て、後述の「受け取ったCSVを検証する」の検証器が`4行すべて通りました（トレーラーも一致）`と答えました。

`file://`で落ちるのはAudioWorkletのモジュールの読み込みのほうです（`AbortError: Unable to load a worklet's module.`）。この場合は簡易モードへ切り替わるので、`# engine=fallback`になり、`peak_dbfs`・`clip`・`valid_ratio`と帯域の3列が空欄になります。ハッシュとは別の話です。

### なぜ起点をヘッダーとトレーラーに分けたのか

起点は、記録を始めた時点で確定するヘッダーに限り、あとからわかる事実はトレーラーへ出しています。`# silence=`（無音の行があったか）・`# clockBreaks=`（時刻の跳びが何回あったか）・`# intervalSec=`（使ったログ間隔）のような、記録が終わってはじめてわかる事実を起点に入れると、記録を続けるだけで起点が変わり、すでに書き出した行のハッシュまで変わるためです。受け取った側からは改変されたように見えるので、記録を残す道具としては成り立ちません。

次の手順で、同じセッションを2回書き出しても行のハッシュが変わらないことを確かめられます。

1. ログ間隔1秒で6秒ぶん記録し、停止してCSVを書き出す
2. 記録を再開し、無音の区間へ入るまで回して、途中でログ間隔を3秒へ変える
3. 停止してもう一度CSVを書き出す

2回目のCSVでは、無音の行とログ間隔の変更がトレーラー（`# silence=`・`# intervalSec=`）に出ますが、1回目に書き出した6行のハッシュは6行とも同じ値のままです。**同じセッションを何度書き出しても、同じ行のハッシュは同じ値になります。**ハッシュは記録中に1区間につき1回だけ計算し、書き出しでは計算し直しません。

## 受け取ったCSVを検証する

受け取った側は、次の手順で`hash`列を再計算できます。本ツールは不要です。v3（10列）とv2（7列）のどちらのCSVも同じ手順で確かめられます。

1. 列のヘッダー行（`timestamp,dbfs,...`）を探す。その上にある`#`の行が起点である。ファイルに並んでいる順のまま、改行（`\n`）で連結して1つの文字列にする
2. ⚠**列のヘッダー行は、ハッシュの材料に入らない。**そのため、起点の`# format=`の版の列と同じかを先に見る。`mic-gain-logger/3`なら`timestamp,dbfs,seq,peak_dbfs,clip,valid_ratio,band_ultra_dbfs,band_audible_dbfs,band_valid_ratio,hash`（10列）、`mic-gain-logger/2`なら`timestamp,dbfs,seq,peak_dbfs,clip,valid_ratio,hash`（7列）である。これを見ないと、列名を入れ替えても鎖は通る（`# format=`は起点に入っているので、こちらを書き換えれば鎖が合わなくなる）
3. 起点の文字列のSHA-256を16進小文字で求め、先頭16文字を「前のハッシュ」とする
4. データ行を上から順に見る。その行のハッシュは`SHA-256(前のハッシュ + "|" + その行の`hash`列より左のフィールドをコンマで連結)`の先頭16文字である。`hash`列の位置は列のヘッダー行から読む。`hash`列より左のフィールドは、v3なら9つ、v2なら6つである。CSVに書かれている文字列をそのまま使う（数値に直さない。空欄も空の文字列のまま使う）
5. 求めた値を、その行の`hash`列と比べる。一致したら、その値を次の行の「前のハッシュ」にする
6. データ行を終えたら、トレーラーを確かめる。`# trailerHash=`の行を除いたトレーラーの行を、ファイルに並んでいる順のまま改行で連結し、`SHA-256(最後の行のハッシュ + "|" + その文字列)`の先頭16文字を求めて`# trailerHash=`の値と比べる。`# rows=`がデータ行の数と合っているかも見る

最初に合わなくなった行が、削除・並べ替え・書き換えの起きた位置です。

```python
# verify_mic_gain_log.py — 標準ライブラリーだけで動く（Python 3.6以上）
# 使い方: python verify_mic_gain_log.py mic-gain-logs-2026-09-29T03-06-26-000Z.csv
# v3（10列）とv2（7列）のどちらのCSVも確かめられる。hash列の位置は列のヘッダー行から読む
import hashlib
import sys

# 版ごとの列。列のヘッダー行はハッシュの材料に入らないので、起点の # format= の版と合っているかをこれで見る
KNOWN = {
    "# format=mic-gain-logger/3": "timestamp,dbfs,seq,peak_dbfs,clip,valid_ratio,band_ultra_dbfs,band_audible_dbfs,band_valid_ratio,hash",
    "# format=mic-gain-logger/2": "timestamp,dbfs,seq,peak_dbfs,clip,valid_ratio,hash",
}

lines = [l for l in open(sys.argv[1], encoding="utf-8").read().splitlines() if l]
cols = [l for l in lines if l.startswith("timestamp,") and "hash" in l.split(",")]
if not cols:
    sys.exit("列のヘッダー行がありません（このツールのCSVではありません）")
at = lines.index(cols[0])
hx = cols[0].split(",").index("hash")      # hash列の位置（v3は10列目、v2は7列目）
head = lines[:at]                          # 起点。記録開始時に確定するメタ行
rest = lines[at + 1:]
data = [l for l in rest if l[0] != "#"]    # データ行
trailer = [l for l in rest if l[0] == "#"] # トレーラー行

# ⚠ 列名を入れ替えても鎖は通るので、先に確かめる。知らない版（KNOWN に無い）では確かめない
fmt = [l for l in head if l in KNOWN]
if fmt and cols[0] != KNOWN[fmt[0]]:
    sys.exit("列のヘッダー行が # format= の版の列と合いません")


def h(s):
    return hashlib.sha256(s.encode("utf-8")).hexdigest()[:16]


def hash_cell(line):
    cells = line.split(",")
    return cells[hx] if len(cells) > hx else ""


# ⚠ 鎖のないCSVを、改変と混同しないよう先に分ける。
# hash 列が全行で空なら、記録した環境で crypto.subtle が使えなかったということである
if not any(hash_cell(l) for l in data):
    sys.exit("hash列が全行で空です。鎖のないCSVなので、この検証器では確かめられません")

prev = h("\n".join(head))
for i, line in enumerate(data, 1):
    want = h(prev + "|" + ",".join(line.split(",")[:hx]))   # hash列より左のフィールド
    if hash_cell(line) != want:
        sys.exit("%d行目から合いません（期待 %s／実際 %s）" % (i, want, hash_cell(line)))
    prev = want

# トレーラーが鎖の最後の輪。最後の行のハッシュを材料に混ぜてある
mark = "# trailerHash="
found = [l for l in trailer if l.startswith(mark)]
if not found:
    sys.exit("トレーラーのハッシュがありません（末尾が落とされています）")
want = h(prev + "|" + "\n".join(l for l in trailer if not l.startswith(mark)))
if found[0] != mark + want:
    sys.exit("トレーラーが合いません（期待 %s／実際 %s）" % (want, found[0][len(mark):]))
if ("# rows=%d" % len(data)) not in trailer:
    sys.exit("行数がトレーラーと合いません（データ行は %d 行）" % len(data))
print("%d行すべて通りました（トレーラーも一致）" % len(data))
```

上に載せた見本CSV（4行・3行目がデジタル無音）をそのまま保存して、この検証器にかけた結果です。

⚠この表の値は、実際に検証器を動かして採ったものです。手で書いてはいけません。`test/chain-claim.test.js`が、この表の行と、同じ手順をJavaScriptで組んだものの出力を毎回比べます。

| 渡したもの | 出力 |
|---|---|
| そのまま | `4行すべて通りました（トレーラーも一致）` |
| 2行目を消す | `2行目から合いません（期待 d354201d…／実際 9381a0b3…）` |
| 2行目と3行目を入れ替える | `2行目から合いません` |
| 2行目の`dbfs`を書き換える | `2行目から合いません` |
| 無音の行を消す | `3行目から合いません` |
| ヘッダーの`# sampleRate=`を偽る | `1行目から合いません` |
| ヘッダーの`# device=`を削る | `1行目から合いません` |
| 列のヘッダー行の`band_ultra_dbfs`と`band_audible_dbfs`を入れ替える | `列のヘッダー行が # format= の版の列と合いません` |
| 最後の行を消す | `トレーラーが合いません` |
| トレーラーの`# intervalSec=`を偽る | `トレーラーが合いません` |
| トレーラーの`# silence=`を消す | `トレーラーが合いません` |
| トレーラーを丸ごと落とす | `トレーラーのハッシュがありません（末尾が落とされています）` |
| `hash`列が全行で空（鎖のないCSV） | `hash列が全行で空です。鎖のないCSVなので、この検証器では確かめられません` |

v2のCSVも、同じ検証器で確かめられます。v2の見本（4行。`test/fixtures/sample_v2.csv`）では`4行すべて通りました（トレーラーも一致）`、iPhone 18 Pro Maxの実機で2026-09-29に書き出したCSV（v2・86行）では`86行すべて通りました（トレーラーも一致）`と出ました。v2の見本に上の表と同じ改変を加えたときも、出力はハッシュの値を除いて表と同じでした（v2には帯域の列がないので、列名の入れ替えは`dbfs`と`peak_dbfs`で確かめました）。

⚠**鎖のないCSVは、改変とは別のものです。**`hash`列が空のCSVをそのまま鎖の検証にかけると「1行目から合いません」と出て、改変されたファイルと見分けられません。検証器は、鎖があるかどうかを先に見て、別のメッセージを返します。

⚠ヘッダーもトレーラーも検証の対象です。`# device=`を削って渡すと、受け取った側の再計算は通りません。人に渡す前に削る必要があるなら、削ったファイルと元のファイルの両方を用意してください。`hash`列が空のCSVは検証できません。多くは鎖を作れない場所（httpsでないホスト名やIPアドレスつきのURL）で書き出したものですが、鎖つきのCSVから`hash`列だけを消しても同じ結果になります。どちらかは、ヘッダーに`# hash=`の行があるかどうかで見分けてください（あれば、書き出したときには鎖がありました）。

⚠列のヘッダー行だけは、ハッシュの材料に入っていません。列名を入れ替えても鎖は通るので、検証器は、列のヘッダー行が起点の`# format=`の版の列と同じかを先に確かめます（上の表の「列のヘッダー行の…を入れ替える」）。検証器が知っている版はv2とv3だけで、ほかの版では確かめません。帯域の2列の並びは、起点に入っている`# bands=`の並びとも同じです。

## Excel/Google Sheetsでの分析手順

⚠そのまま開くと、1行目は列のヘッダーではありません。`#`から始まるヘッダーが12行ほど上に入り、データ行の下にもトレーラーが3〜10行付きます。まずこれを外してから集計してください。

1. **`#`の行を外す**：Excelは「データ」→「テキストまたはCSVから」で読み込み、Power Queryの画面で`#`から始まる行を除外してから「1行目をヘッダーとして使用」を押す。ヘッダーとトレーラーはどちらも`#`で始まるので、この1回の除外で両方とも外れる。Google Sheetsは「ファイル」→「インポート」で取り込んだあと、先頭のヘッダーと末尾のトレーラーを選んで行ごと削除する。⚠`#`の行を外したファイルは、前述の「受け取ったCSVを検証する」の検証を通らない。検証用に元のCSVを別に残しておく
2. **データインポート**：CSVファイルを開く際、「カンマ区切り」「UTF-8エンコーディング」を選択
3. **タイムスタンプ変換**：ISO形式の日時を認識させるため、該当列を「日時」形式に変更
4. **基本統計作成**

   ⚠作業用の列はK列以降に置く。取り込んだ10列はA列`timestamp`・B列`dbfs`・C列`seq`・D列`peak_dbfs`・E列`clip`・F列`valid_ratio`・G列`band_ultra_dbfs`・H列`band_audible_dbfs`・I列`band_valid_ratio`・J列`hash`である。C列（`seq`）やH列（`band_audible_dbfs`）を作業用に上書きすると、帯域の値や、後述の境界の行を見つける手がかりが消える。

   ⚠先にB列の`-Infinity`を`-999`へ置き換える。`-Infinity`は数値ではないので、置き換えないとエネルギー平均の式が`#VALUE!`になる。無音を電力0として数えるのが定義であり、`-999`は電力に直せばほぼ0なので、平均をほとんど変えない（`-300`でも`-1000`でも`-1000000`でも、手元の検算では小数12桁まで同じ値になった）。⚠無音の行を「行ごと」消してはいけない。分母の時間が縮んで平均が上がる。上がり幅は行の値によらず`10*LOG10(全行の重みの和 ÷ 残った行の重みの和)`で決まるので、区間長がそろっていれば行数の比で決まる（4行中1行が無音の記録で1.2494dB、10行中9行が無音の記録で10.0000dB高く出る）。

   ⚠B列が空欄の行は欠測である（音が1つも届かなかった区間。`valid_ratio`は`0.000`）。無音（`-Infinity`）とは別物で、測っていないのでLeqに入れない（画面の統計も入れていない）。⚠空欄のままLeqの式に入れてはいけない。空のセルは0として扱われるので、`POWER(10,0)`＝1（0 dBFS相当）が足し込まれる。等間隔の式（下）を使うなら、先に欠測の行を外す（区間長がそろっていれば重みに`timestamp`の差を使わないので、行ごと外してよい）。重み付けの式（下）を使うなら、欠測の行は消さずに、K列の区間長を`0`にする（行ごと消すと、次の行の`timestamp`の差に欠測の区間が入る）。`=MAX()`・`=MIN()`は空のセルを数えないので、そのままでよい。

   - **最大値・最小値・変動幅**：`=MAX($B$2:$B$100)`／`=MIN($B$2:$B$100)`／その差である。画面の「最大」「最小」「変動幅」は無音の区間を外した値なので、`-999`へ置き換えたあとの`=MIN()`とは一致しない。そろえるには無音の行を範囲から外す
   - ⚠**`=AVERAGE($B$2:$B$100)`は画面の「平均（Leq）」ではない。**これはdBの算術平均である。dBは対数なので、足して行数で割った値はどの物理量にも対応しない。しかも上の手順で`-Infinity`を`-999`へ置き換えているので、無音の行があると置き換え値そのものが平均へ入り、答えは物理量から完全に外れる。手元で同じCSVを両方の式にかけた結果（すべて1秒間隔・`-999`へ置き換えたあと）。

     | 記録 | 算術平均 | Leq | 差 |
     |---|---|---|---|
     | 60行の-60 dBFSのうち1行だけ-3 dBFS（無音なし） | -59.0500 | -20.7810 | 算術平均が38.2690dB低い |
     | 4行中1行が無音、残り3行が-30 dBFS | -272.2500 | -31.2494 | 算術平均が241.0006dB低い |
     | 10行中9行が無音、残り1行が-20 dBFS | -901.1000 | -30.0000 | 算術平均が871.1000dB低い |

     ずれの向きも大きさも記録の中身で変わるので、あとから補正できない。⚠置き換えを飛ばしても直らない。`=AVERAGE()`は文字列のセルを警告なしで無視するので、`-Infinity`のまま残した無音の行が集計から落ちる。上の表の2件目なら-30.0000（Leqより1.2494dB高い）、3件目なら-20.0000（Leqより10.0000dB高い）が出る。値が数値に見えるので気づけない
   - **区間長がそろっている場合**：トレーラーの`# intervalSec=`に`+`が入っていなければ（記録中にログ間隔を変えていなければ）、次の1本で画面と一致する。記録を止めて再開していてもよい（重みが定数なら、重み付きと等重みは同じ値になる）
     ```excel
     =10*LOG10(SUMPRODUCT(POWER(10,$B$2:$B$100/10))/COUNT($B$2:$B$100))
     ```
     手元の検算では、ログ間隔がそろった記録6件すべてで画面の「平均（Leq）」と一致した。⚠CSVの`dbfs`は小数2桁に丸めて書き出すので、そこから組み直した値には丸めのぶんの差が残る。画面は小数1桁で表示するため、その範囲では一致する。`=10*LOG10(AVERAGE(POWER(10,$B$2:$B$100/10)))`でも同じ値になるが、古いExcelでは配列数式としての確定（Ctrl+Shift+Enter）が要る。SUMPRODUCTならそれが要らない
   - **範囲の指定**：⚠`B:B`のように列ごと指定してはいけない。空のセルは0として扱われるので、`POWER(10,0)`＝1（0 dBFS相当）が空行のぶんだけ足し込まれる。データのある行にぴったり合わせる
   - **ログ間隔が混ざっている場合**：`# intervalSec=`が`1@0+3@12`のように`+`でつながっていたら、上の式は使えない。区間長で重み付けする
     - **K列**：区間長（秒）を入れる。`timestamp`は区間の終わりなので、K3に`=(A3-A2)*86400`と入れて下までコピーする
     - ⭐**境界の行だけは、この差を使ってはいけない。**トレーラーの`# sessionStartAt=`と`# clockBreakAt=`に並ぶ`seq`（C列）の行は、K列を手で書き換える。入れる値は`# intervalSec=`のランから読む（`1@0+3@12`なら、seq 0〜11は`1`、seq 12以降は`3`）。境界の数はセッションの数＋中断の回数なので、手で直せる件数にとどまる
       - **1行目**：前の行がないので差が取れない（`# started=`は1行目の区間の終わりの時刻なので、差を取ると0になる）。`# sessionStartAt=`には必ず1行目の`seq`が入っているので、同じ扱いで埋まる
       - **記録を止めて再開した境界**：`timestamp`の差に休止時間がまるごと入る。実測（17行・境界の差60.032秒）で6.49dB低く出た。並びを入れ替えた記録では2.00dB高く、休止600秒の記録では15.42dB低く出た
       - **時刻のアンカーを取り直した行**：跳んだぶん（`# clockDriftMs=`）が入る
       - **欠測の行（B列が空欄）**：K列を`0`にする（前述）
       - K2を空のままにすると1行目の重みが落ちる。手元の検算では0.79dB高いものから969.00dB低いものまで散り、1行目だけが無音でない記録では答えが置き換え用の`-999`そのものになった
     - **Leq**：`=10*LOG10(SUMPRODUCT($K$2:$K$100,POWER(10,$B$2:$B$100/10))/SUM($K$2:$K$100))`
     - 手元の検算では、この式は画面の「平均（Leq）」と6件すべてで一致した（1セッション／2セッション／3セッション＋間隔混在／1セッション内でのログ間隔変更／アンカーの取り直し／無音を含む2セッション）。⚠丸めていない値どうしなら小数10桁まで合うが、CSVの`dbfs`は小数2桁に丸めてあるので、実際のCSVから組み直すとその差が残る
     - 重み付けを省くと（等重みの式を当てると）次のようにずれた。⚠向きは記録の中身で変わるので、あとから補正できない

       | 記録 | 重み付き（画面と同じ） | 等重み | ずれ |
       |---|---|---|---|
       | 1秒×3行(-40)のあと3秒×1行(-10) | -13.0060 | -16.0076 | 3.0016dB低い |
       | 1秒×3行(-40)のあと10秒×3行(-10) | -10.4135 | -13.0060 | 2.5925dB低い |
       | 3秒×4行(-25)のあと1秒×12行(-45) | -27.9671 | -30.8922 | 2.9251dB低い |
       | 1秒×1行(-20)のあと9秒×1行の無音 | -30.0000 | -23.0103 | 6.9897dB高い |
       | 1秒×1行(-6)のあと10秒×1行(-60) | -16.4138 | -9.0103 | 7.4035dB高い |
       | 1秒×1行(-6)のあと10秒×5行(-60) | -23.0748 | -13.7814 | 9.2934dB高い |
5. **時系列グラフ作成**：A列（時間）をX軸、B列（dBFS値）をY軸として散布図を作成
6. **時間帯別分析**：時間帯ごとに上のLeqの式を当てて、活動のパターンを見る。⚠時間帯ごとの平均も、dBの算術平均では意味を持たない

## 推奨分析手法
- **移動平均**：短期の揺れをならして傾向を見る。⚠**dB値をそのまま平均しない。**`POWER(10,B/10)`で電力に直してから平均し、`10*LOG10()`でdBへ戻す
- **閾値分析**：設定レベル（例：-30dBFS）を超えた時間帯の特定。大小の順序はdBと電力で変わらないので、閾値の比較はdBのまま行ってよい
- **ピーク検出**：急な音量変化のタイミングの抽出。区間内のサンプルピーク（標本点の最大値。ITU-R BS.1770のトゥルーピークとは別物）は`peak_dbfs`列にある（簡易モードで採った行は空欄）
- **頻度分布**：dBFSの出現頻度をヒストグラムで表示。⚠**これはL10／L50／L90ではない。**それらはA特性音圧レベルの分布として定義された指標であり、dBFSの分位点に同じ名前を付けると規制値と比べられるものだと誤読される

## 加工する前に確かめること

- ⚠**書き出したCSVは、加工する前にそのまま別の場所へ複製しておく。**`#`の行を外したファイルや、表計算ソフトで保存し直したファイルは、前述の「受け取ったCSVを検証する」の検証器を通らない。検証が要るときは、この元のファイルを使う
- 集計の前に、`dbfs`が空欄の行（欠測）・`clip`が0でない行・`valid_ratio`と`band_valid_ratio`が1.000未満の行を洗い出し、読んでよい区間を決める（後述の「読んでよい区間を決める（`check.py`）」）。クリップが3サンプル以上続いた区間は、値が本来の音と違う（[機能の資料](features.md)の「記録の穴の有無を、両側で表示」）
- ヘッダーの`# engine=`が`fallback`（簡易モード）の記録と、トレーラーに`# engines=worklet+fallback`がある記録では、簡易モードの行の`clip`・`valid_ratio`が空欄なので、この確かめ方が使えない
- 記録どうしを比べるときは、ヘッダーの`# device=`・`# sampleRate=`・`# processing=`・`# settingsRaw=`がそろっているかを先に見る（[計測の資料](measurement.md)の「dBFSでできる比較・できない比較」）

## 時刻を日本時間へ直す

`timestamp`はUTC（末尾の`Z`）で、区間の終わりの時刻です。日本時間は、これに9時間を足した時刻です。区間の始まりは、終わりから区間長（前述の「セッションの境界」）を引いた時刻になります。

- **Excel・Google Sheets**：A列が`2026-09-29T03:06:21.680Z`のような文字列のまま入っているとき、作業用の列に次の式を入れ、セルの表示形式を`yyyy-mm-dd hh:mm:ss.000`にする

  ```excel
  =DATEVALUE(LEFT(A2,10))+TIMEVALUE(MID(A2,12,8))+MID(A2,21,3)/86400000+9/24
  ```

  見本の1行目は`2026-09-29 12:06:21.680`になる。この値は、式と同じ計算をPythonで行って確かめたもので、Excel・Google Sheetsの実物では確かめていない。取り込みのときに表計算ソフトがA列を日時に変えていたら、その値がUTCのままかを先に確かめる
- **Python**：後述の`mgl.py`の`parse_time()`と`jst()`で直す（`to_jst.py`の出力を参照）

## コマンドラインで表だけにする

`#`から始まる行（ヘッダーとトレーラー）を外すと、列のヘッダー行とデータ行だけの表になります。ほかのツールへ渡すときに使います。

```sh
grep -v '^#' mic-gain-logs.csv > table.csv
```

見本CSVを`sample.csv`として保存し、実際にかけた出力です。

```text
$ grep -v '^#' sample.csv
timestamp,dbfs,seq,peak_dbfs,clip,valid_ratio,band_ultra_dbfs,band_audible_dbfs,band_valid_ratio,hash
2026-09-29T03:06:21.680Z,-19.70,0,-14.83,0,1.000,-30.44,-20.03,1.000,030554522ee00119
2026-09-29T03:06:22.680Z,-19.72,1,-14.83,0,1.000,-30.45,-20.05,1.000,b274e8d3ca7e6a0e
2026-09-29T03:06:23.680Z,-Infinity,2,-Infinity,0,1.000,-Infinity,-Infinity,1.000,9381a0b301d41f3c
2026-09-29T03:06:24.680Z,-37.54,3,-14.83,0,1.000,-53.05,-42.59,1.000,bfe90bfc6ddf9b43
```

Windows PowerShell 5.1では次のとおりです。`>`は初期設定ではUTF-16で保存するので、`Set-Content`で文字コードを指定します。

```powershell
Get-Content mic-gain-logs.csv -Encoding UTF8 | Where-Object { $_ -notmatch '^#' } | Set-Content table.csv -Encoding UTF8
```

見本CSVにかけると、中身は上と同じ5行になりました。ただし、Windows PowerShell 5.1の`-Encoding UTF8`はファイルの先頭にBOM（3バイト）を付け、改行はCRLFになります。Excelはそのまま読めますが、BOMを読み飛ばさないツールでは、1列目の名前が`timestamp`として読まれません（Pythonの`csv`で読むときは`encoding="utf-8-sig"`にします）。BOMを付けずに保存するときは、次のようにします（改行はCRLFのままです。見本CSVにかけ、CRを除くと`grep`の出力と1バイトも違わないことを確かめました）。

```powershell
$rows = Get-Content mic-gain-logs.csv -Encoding UTF8 | Where-Object { $_ -notmatch '^#' }
[IO.File]::WriteAllLines("$PWD\table.csv", [string[]]$rows)
```

⚠`table.csv`は、ハッシュチェーンの検証を通りません（起点のヘッダーがないため）。元のCSVも残しておいてください。

## Pythonのレシピ（標準ライブラリーだけ）

次のレシピは、Pythonの標準ライブラリー（`csv`・`datetime`・`math`・`sys`）だけで動きます（Python 3.7以上。手元では3.10.6で動かしました）。pandasなどの外部のライブラリーは使いません。共通のモジュール`mgl.py`を同じフォルダーに置き、各レシピから読み込みます。

⚠出力は、実際に動かしたものをそのまま写しています。手で書いていません。上の見本CSVを`sample.csv`として保存して動かしました。見本は4行しかないので、超音波帯だけが上がった時間帯・平時との比較・2台の端末の比べ方は、実機テストで書き出したCSV（[実機テストの資料](real-device-test.md)。CSVはリポジトリーには入れていません）にかけた出力を載せます。

### 共通のモジュール（`mgl.py`）

```python
# mgl.py - Mic Gain Logger のCSVを読むモジュール（標準ライブラリーだけ。Python 3.7以上）
# レシピはこのファイルと同じフォルダーに置いて import する
import csv
import datetime
import math

JST = datetime.timezone(datetime.timedelta(hours=9))
NAME = {"db": "dbfs", "ultra": "band_ultra_dbfs", "audible": "band_audible_dbfs"}


def parse_time(s):
    # 末尾の Z は UTC。Python 3.10 までの fromisoformat は Z を読めないので +00:00 に直す
    return datetime.datetime.fromisoformat(s.replace("Z", "+00:00"))


def jst(t, fmt="%Y-%m-%d %H:%M:%S"):
    return t.astimezone(JST).strftime(fmt)


def num(cell):
    # 空欄は None（欠測・測れない区間）。-Infinity はデジタル無音で、float() が -inf にする
    return float(cell) if cell else None


def read_log(path):
    """1本のCSVを読み、メタ行の辞書と行のリストを返す。行には区間の始まり・終わり・長さ（秒）を付ける"""
    lines = open(path, encoding="utf-8").read().splitlines()
    meta = dict(l[2:].split("=", 1) for l in lines if l.startswith("# ") and "=" in l)
    rows = list(csv.DictReader(l for l in lines if l and not l.startswith("#")))
    runs = [p.split("@") for p in meta["intervalSec"].split("+")]   # 例 1@0+3@12
    edges = {int(s) for k in ("sessionStartAt", "clockBreakAt")
             for s in meta.get(k, "").split(",") if s}
    prev = None
    for r in rows:
        seq = int(r["seq"])
        r["end"] = parse_time(r["timestamp"])          # timestamp は区間の終わり
        if prev is None or seq in edges:
            # 境界の行は timestamp の差を使わず、# intervalSec= のランから読む
            r["sec"] = [float(s) for s, at in runs if int(at) <= seq][-1]
        else:
            r["sec"] = (r["end"] - prev["end"]).total_seconds()
        r["start"] = r["end"] - datetime.timedelta(seconds=r["sec"])
        r["db"] = num(r["dbfs"])                        # 数値にした値は別の名前で持つ
        r["ultra"] = num(r.get("band_ultra_dbfs", ""))  # v2 には帯域の列がない
        r["audible"] = num(r.get("band_audible_dbfs", ""))
        prev = r
    return meta, rows


def leq(rows, key="db"):
    """区間長で重み付けしたエネルギー平均（Leq）。空欄の行は入れず、無音（-inf）は電力0で数える"""
    pairs = [(r["sec"], r[key]) for r in rows if r[key] is not None]
    total = sum(sec for sec, _ in pairs)
    if total == 0:
        return None
    power = sum(sec * 10 ** (db / 10) for sec, db in pairs) / total
    return 10 * math.log10(power) if power > 0 else -math.inf


def median(rows, key="db"):
    vals = sorted(r[key] for r in rows if r[key] is not None)
    if not vals:
        return None
    mid = len(vals) // 2
    return vals[mid] if len(vals) % 2 else (vals[mid - 1] + vals[mid]) / 2


def spans(rows, hit):
    """hit(r) が真の行を、切れ目なくつながるひとまとまりごとのリストにする"""
    out = []
    for r in rows:
        if not hit(r):
            continue
        if out and out[-1][-1]["end"] == r["start"]:
            out[-1].append(r)
        else:
            out.append([r])
    return out
```

- `read_log()`は1本のCSVを読み、各行に区間の始まり（`start`）・終わり（`end`）・長さ（`sec`、秒）と、数値にした`db`・`ultra`・`audible`を付ける。`dbfs`などの元の文字列はそのまま残す
- 区間長は、隣の行との`timestamp`の差で取る。ただし1行目と、トレーラーの`# sessionStartAt=`・`# clockBreakAt=`に並ぶ行は、`# intervalSec=`のランから取る（前述の「セッションの境界」）。画面の「平均（Leq）」と同じ重みになる
- `leq()`は区間長で重み付けしたエネルギー平均である。欠測（空欄）の行は入れず、デジタル無音（`-Infinity`）は電力0として数える。dBの算術平均はしない
- v2（7列）のCSVも読める。帯域の値は`None`になる

### 読んでよい区間を決める（`check.py`）

```python
# check.py - 集計の前に、気をつける行（欠測・クリップ・有効率が1.000未満）を洗い出す
# 使い方: python check.py log.csv
import sys
from mgl import read_log, jst

meta, rows = read_log(sys.argv[1])
print("計測エンジン=%s  加工の状態=%s" % (meta.get("engines", meta["engine"]), meta.get("processing")))
n = 0
for r in rows:
    why = []
    if r["db"] is None:
        why.append("欠測")
    if r["clip"] not in ("", "0"):
        why.append("clip=" + r["clip"])
    for k in ("valid_ratio", "band_valid_ratio"):
        if r.get(k) and float(r[k]) < 1:
            why.append(k + "=" + r[k])
    if why:
        n += 1
        print("seq %s  %s  %s" % (r["seq"], jst(r["end"]), " ".join(why)))
print("気をつける行 %d / %d行" % (n, len(rows)))
```

```text
$ python check.py sample.csv
計測エンジン=worklet  加工の状態=off
気をつける行 0 / 4行
```

見本には、欠測・クリップ・有効率が1.000未満の行がありません。気をつける行があれば、`seq`と時刻と理由が1行ずつ出ます。

### 日本時間の一覧（`to_jst.py`）

```python
# to_jst.py - 各行の区間を日本時間で出す（timestamp は区間の終わり・UTC）
# 使い方: python to_jst.py log.csv
import sys
from mgl import read_log, jst

meta, rows = read_log(sys.argv[1])
for r in rows:
    print("seq %s  %s - %s  %.3f秒  dbfs %s" % (
        r["seq"], jst(r["start"], "%Y-%m-%d %H:%M:%S.%f")[:-3],
        jst(r["end"], "%H:%M:%S.%f")[:-3], r["sec"], r["dbfs"]))
```

```text
$ python to_jst.py sample.csv
seq 0  2026-09-29 12:06:20.680 - 12:06:21.680  1.000秒  dbfs -19.70
seq 1  2026-09-29 12:06:21.680 - 12:06:22.680  1.000秒  dbfs -19.72
seq 2  2026-09-29 12:06:22.680 - 12:06:23.680  1.000秒  dbfs -Infinity
seq 3  2026-09-29 12:06:23.680 - 12:06:24.680  1.000秒  dbfs -37.54
```

1行目は前の行がないので、区間長を`# intervalSec=`（1秒）から取っています。

### 時間帯ごとのLeq（`hourly.py`）

```python
# hourly.py - 時間帯（日本時間の1時間）ごとの Leq。区間の始まりの時刻で振り分ける
# 使い方: python hourly.py log.csv
import sys
from mgl import read_log, leq, jst

meta, rows = read_log(sys.argv[1])
groups = {}
for r in rows:
    groups.setdefault(jst(r["start"], "%Y-%m-%d %H時"), []).append(r)
for key in sorted(groups):
    g = groups[key]
    v, u = leq(g), leq(g, "ultra")
    print("%s  %d行  Leq %s  超音波帯 %s" % (
        key, len(g), "なし" if v is None else "%.2f dBFS" % v,
        "なし" if u is None else "%.2f dBFS" % u))
```

```text
$ python hourly.py sample.csv
2026-09-29 12時  4行  Leq -22.68 dBFS  超音波帯 -33.44 dBFS
```

区間の始まりの時刻で、日本時間の1時間ごとに振り分けます。ログ間隔が長いと、時間帯の境目をまたぐ区間は始まりの側に入ります。見本は約4秒ぶんなので1行だけです。無音（`-Infinity`）の行は電力0として数えるので、Leqは無音の行を除いたときより低くなります。

### 閾値を超えた時間帯の一覧（`over.py`）

```python
# over.py - 閾値を超えた時間帯を「何時何分から何秒間」の一覧にする
# 使い方: python over.py log.csv -30            （dbfs が -30 dBFS 以上）
#         python over.py log.csv +10 [ultra]    （その記録の中央値より10dB以上高い。ultra は超音波帯）
import sys
from mgl import read_log, median, spans, jst, NAME

meta, rows = read_log(sys.argv[1])
key = sys.argv[3] if len(sys.argv) > 3 else "db"
if sys.argv[2].startswith("+"):
    base = median(rows, key)
    if base is None:            # その列に値がない（簡易モードの帯域の列など）
        sys.exit("%s の値がない記録です" % NAME[key])
    limit = base + float(sys.argv[2])
    print("%s の中央値 %.2f + %s dB = %.2f dBFS 以上" % (NAME[key], base, sys.argv[2][1:], limit))
else:
    limit = float(sys.argv[2])
    print("%s が %.2f dBFS 以上" % (NAME[key], limit))
found = spans(rows, lambda r: r[key] is not None and r[key] >= limit)
for g in found:
    print("%s - %s  %d秒  seq %s-%s  最大 %.2f dBFS" % (
        jst(g[0]["start"], "%m-%d %H:%M:%S"), jst(g[-1]["end"], "%H:%M:%S"),
        (g[-1]["end"] - g[0]["start"]).total_seconds(), g[0]["seq"], g[-1]["seq"],
        max(r[key] for r in g)))
print("%d回  合計 %d秒" % (len(found), sum((g[-1]["end"] - g[0]["start"]).total_seconds() for g in found)))
```

```text
$ python over.py sample.csv -30
dbfs が -30.00 dBFS 以上
09-29 12:06:20 - 12:06:22  2秒  seq 0-1  最大 -19.70 dBFS
1回  合計 2秒
```

前の区間と切れ目なくつながる行をまとめて、「何時何分から何秒間」の形にします。欠測の行や、記録を止めて再開した境界ではまとまりが切れます。閾値を`+10`のように`+`付きで渡すと、その記録の中央値からの差で閾値を決めます（後述の「2台の端末の記録を並べる」）。大小の順序はdBと電力で変わらないので、閾値の比較はdBのまま行ってかまいません。

### 時刻×曜日の表（`week.py`）

```python
# week.py - 時刻（日本時間）×曜日の Leq の表。タブ区切りなので、表計算ソフトに貼って色を付ける
# 使い方: python week.py 1日目.csv 2日目.csv ...
import sys
from mgl import read_log, leq, JST

cells = {}
for path in sys.argv[1:]:
    meta, rows = read_log(path)     # 1本ずつ読む（ファイルをまたいで timestamp の差を取らない）
    for r in rows:
        t = r["start"].astimezone(JST)
        cells.setdefault((t.hour, t.weekday()), []).append(r)
print("時\t" + "\t".join("月火水木金土日"))
for h in sorted({h for h, _ in cells}):
    vals = [leq(cells[(h, d)]) if (h, d) in cells else None for d in range(7)]
    print("%d\t" % h + "\t".join("-" if v is None else "%.1f" % v for v in vals))
```

```text
$ python week.py sample.csv
時	月	火	水	木	金	土	日
12	-	-22.7	-	-	-	-	-
```

出力はタブ区切りです。表計算ソフトに貼り付けてカラースケールで色を付けると、時刻×曜日のヒートマップになります。複数日のCSVを並べて渡すと、1本ずつ読んでから同じマスに入れます。見本は約4秒ぶん（12時台に収まる）なので、火曜の12時の1マスだけです。

### 超音波帯だけが上がった時間帯（`ultra_only.py`）

```python
# ultra_only.py - 超音波帯だけが上がった時間帯（可聴帯は一緒に上がっていない）を抜き出す
# 使い方: python ultra_only.py log.csv
import sys
from mgl import read_log, median, spans, jst

meta, rows = read_log(sys.argv[1])
bu, ba = median(rows, "ultra"), median(rows, "audible")
if bu is None or ba is None:    # 簡易モード・?bands=off・v2・超音波帯を測れないサンプルレートでは空欄
    sys.exit("帯域の値がない記録です")
print("中央値  超音波帯 %.2f  可聴帯 %.2f dBFS" % (bu, ba))


def rise(r):
    u, a = r["ultra"], r["audible"]
    # 超音波帯が中央値より10dB以上高く、その上がり幅が可聴帯の上がり幅より10dB以上大きい
    return u is not None and a is not None and u - bu >= 10 and (u - bu) - (a - ba) >= 10


for g in spans(rows, rise):
    top = max(g, key=lambda r: r["ultra"])
    print("%s - %s  seq %s-%s  超音波帯 最大 %+.1f dB  そのとき可聴帯 %+.1f dB" % (
        jst(g[0]["start"], "%H:%M:%S"), jst(g[-1]["end"], "%H:%M:%S"), g[0]["seq"], g[-1]["seq"],
        top["ultra"] - bu, top["audible"] - ba))
```

条件は「超音波帯がその記録の中央値より10dB以上高く、その上がり幅が可聴帯の上がり幅より10dB以上大きい」です。可聴帯と一緒に上がった区間（話し声・叩いた音など、広い帯域に出る音）は外れます。見本CSVでは、超音波帯が上がった行で可聴帯も一緒に上がっているので、中央値の行のほかは何も出ません。

```text
$ python ultra_only.py sample.csv
中央値  超音波帯 -41.75  可聴帯 -31.32 dBFS
```

次の出力は、実機テストの階段シーケンスのCSVにかけたものです。

```text
$ python ultra_only.py iphone18pm_sweep_bands_20260929.csv
中央値  超音波帯 -93.50  可聴帯 -74.72 dBFS
14:50:52 - 14:50:58  seq 46-51  超音波帯 最大 +29.3 dB  そのとき可聴帯 +5.2 dB
14:50:59 - 14:51:05  seq 53-58  超音波帯 最大 +33.4 dB  そのとき可聴帯 +0.0 dB
14:51:06 - 14:51:12  seq 60-65  超音波帯 最大 +41.9 dB  そのとき可聴帯 -0.2 dB
14:51:13 - 14:51:19  seq 67-72  超音波帯 最大 +33.6 dB  そのとき可聴帯 -0.8 dB
```

- 4つのまとまりは、18・19・20・21kHzの段である（[実機テストの資料](real-device-test.md)の「階段シーケンス：18〜22kHzのトーンの記録」の表のseq 47-50・54-57・61-64・68-71を含む）。前後に1行ずつ広いのは、段の最初と最後の行にもトーンが一部入っているためである
- 18kHzの段で可聴帯も+5.2dB上がっているのは、18kHzちょうどの音の1/6が可聴帯に入るためである（[実機テストの資料](real-device-test.md)の「階段シーケンス：18〜22kHzのトーンの記録」）
- 22kHzの段（静寂より約+1.9dB）は、この条件（10dB以上）では出ない。条件を緩めれば拾えるが、そのぶん平時の揺れも拾いやすくなる
- ⚠抜き出せるのは「超音波帯にエネルギーがあった時間帯」までで、何の音かは分からない

### 平時と比べる（`compare.py`）

平時の記録を、調べたい記録と同じ端末・同じ置き場所・同じログ間隔で採っておき、並べて比べます。dBFSは端末ごとの相対値なので、値そのものはほかの端末や場所と比べられませんが、同じ条件の平時とは比べられます。比べるのは、中央値とLeqのほか、時間帯ごとのLeq（`hourly.py`）、閾値を超えた回数と長さ（`over.py`）、値が上がり始めた時刻です。超音波帯は、この出力の平時の中央値に10dBなどを足して`over.py`の閾値に渡すと、平時より上がった時間帯の一覧になります（例`python over.py log.csv -96 ultra`）。前述の`ultra_only.py`は平時の記録を使わず、1本の記録の中で超音波帯だけが上がった時間帯を出すものです。

```python
# compare.py - 平時の記録と比べる（同じ端末・同じ置き場所・同じログ間隔で採ったもの）
# 使い方: python compare.py 調べる記録.csv 平時1.csv [平時2.csv ...]
import sys
from mgl import read_log, leq, median, NAME

SAME = ("device", "sampleRate", "processing", "settingsRaw", "bands")


def load(paths):
    metas, rows = [], []
    for p in paths:
        m, r = read_log(p)      # 1本ずつ読んでからつなぐ（ファイルをまたいで timestamp の差を取らない）
        metas.append(m)
        rows += r
    return metas, rows


tm, target = load(sys.argv[1:2])
bm, base = load(sys.argv[2:])
diff = sorted({k for m in bm for k in SAME if m.get(k) != tm[0].get(k)})
print("平時 %d本 %d行 / 調べる記録 %d行" % (len(bm), len(base), len(target)))
print("ヘッダーの違い=%s" % ("なし" if not diff else " ".join(diff) + "（値は比べられない）"))
# off 以外は、自動ゲイン調整などが切れていたと確かめられない（unknown: は報告なし、active: は有効）
proc = sorted({m.get("processing", "不明") for m in tm + bm} - {"off"})
if proc:
    print("注意：加工が切れていたと確かめられない記録がある（processing=%s）" % " ".join(proc))
for key in ("db", "audible", "ultra"):
    b, t = median(base, key), median(target, key)
    if b is not None and t is not None:
        print("%s の中央値  平時 %.2f  調べる記録 %.2f  差 %+.2f dB" % (NAME[key], b, t, t - b))
b, t = leq(base), leq(target)
if b is not None and t is not None:
    print("dbfs の Leq  平時 %.2f  調べる記録 %.2f  差 %+.2f dB" % (b, t, t - b))
```

次の出力は、実機テストの扇風機とスピーカーのCSVにかけたものです。扇風機を止めた3本（スピーカーの電源は入れたまま）をつないで平時とし、扇風機を回した1本（スピーカーの電源は切った）と比べました。4本とも同じ場所で採っています。

```text
$ python compare.py iphone18pm_noise_fan-on_spk-off_20260929.csv iphone18pm_noise_fan-off_spk-on_20260929.csv iphone18pm_noise_fan-off_spk-on_tab-closed_20260929.csv iphone18pm_noise_fan-off_spk-on_stream-active_20260929.csv
平時 3本 94行 / 調べる記録 31行
ヘッダーの違い=なし
注意：加工が切れていたと確かめられない記録がある（processing=unknown:autoGainControl+noiseSuppression）
dbfs の中央値  平時 -79.70  調べる記録 -75.92  差 +3.78 dB
band_audible_dbfs の中央値  平時 -79.95  調べる記録 -76.47  差 +3.48 dB
band_ultra_dbfs の中央値  平時 -106.05  調べる記録 -104.02  差 +2.03 dB
dbfs の Leq  平時 -79.63  調べる記録 -75.89  差 +3.73 dB
```

- 全帯域と可聴帯は、平時より約3.5〜3.8dB高い。扇風機を回したぶんと読める（スピーカーの電源の違いは、全帯域への寄与が小さいとみなした）
- 超音波帯は約+2dBで、扇風機を回しても大きくは上がらなかった
- ⚠`compare.py`はヘッダーの`# device=`・`# sampleRate=`・`# processing=`・`# settingsRaw=`・`# bands=`の文字列を比べ、違う項目があれば出す。置き場所とログ間隔の設定はCSVのヘッダーからは分からないので、採った人が記録しておく
- ⚠「ヘッダーの違い=なし」は、測定条件が同じだったことの保証ではない。`# processing=`が`off`でない記録があると「注意：」の行が出る。上の4本はiPhoneのSafariで採ったので`unknown:autoGainControl+noiseSuppression`で、自動ゲイン調整（AGC）が切れていたか、利得が一定だったかはCSVからは確かめられない。AGCが動いていると、平時との差が縮んだり変わったりする
- 平時を複数本つなぐと、平時の揺れも基準に入る（上の出力は3本・94行）。つなぎ方は後述の「複数のCSVをつなぐ」

### 外部の記録と時刻で重ねる（`memo.py`）

行動メモ・音源のログ・ほかの機器の記録など、本ツールの外で残した記録と時刻で並べます。メモは日本時間で書き、`日本時間,内容`の1行ずつにします。[実機テスト](real-device-test.md)でも、PC側の音源のログ（各段の開始時刻）とCSVの行を、同じ考え方で合わせました。端末どうしの時計のずれと、音が届くまでの遅れがあるので（実機テストでは合わせて約0.84秒）、1〜2秒の幅で読んでください。

```python
# memo.py - 外部の記録（メモ）と時刻で重ねる。行とメモを1本の時系列に並べる
# 使い方: python memo.py log.csv memo.txt
# memo.txt は1行に「日本時間,内容」（例 2026-09-29 12:06:23,内容）
import sys
import datetime
from mgl import read_log, jst, JST

meta, rows = read_log(sys.argv[1])
events = [(r["start"], "%s - %s  seq %s  dbfs %s" % (
    jst(r["start"], "%H:%M:%S.%f")[:-3], jst(r["end"], "%H:%M:%S.%f")[:-3], r["seq"], r["dbfs"]))
    for r in rows]
for line in open(sys.argv[2], encoding="utf-8"):
    t, _, text = line.strip().partition(",")
    if t:
        when = datetime.datetime.strptime(t, "%Y-%m-%d %H:%M:%S").replace(tzinfo=JST)
        events.append((when, "%s  [メモ] %s" % (jst(when, "%H:%M:%S"), text)))
for when, text in sorted(events, key=lambda e: e[0]):
    print(text)
```

次の出力は、見本CSVに、説明のために作った2行のメモ（`memo.txt`）を重ねたものです。

```text
$ cat memo.txt
2026-09-29 12:06:21,外部の記録A
2026-09-29 12:06:24,外部の記録B
```

```text
$ python memo.py sample.csv memo.txt
12:06:20.680 - 12:06:21.680  seq 0  dbfs -19.70
12:06:21  [メモ] 外部の記録A
12:06:21.680 - 12:06:22.680  seq 1  dbfs -19.72
12:06:22.680 - 12:06:23.680  seq 2  dbfs -Infinity
12:06:23.680 - 12:06:24.680  seq 3  dbfs -37.54
12:06:24  [メモ] 外部の記録B
```

## 複数のCSVをつなぐ

- ⚠**1本ずつ読んでから、行をつなぐ。**各ファイルの1行目はセッションの先頭（トレーラーの`# sessionStartAt=`に必ず入る）なので、ファイルをまたいで`timestamp`の差を取らない。差を取ると、ファイルのあいだの時間がまるごと区間長に入り、Leqがずれる（前述の「セッションの境界」）。`week.py`と`compare.py`は、この読み方をしている
- つなぐ前に、ヘッダーの`# device=`・`# sampleRate=`・`# processing=`・`# settingsRaw=`・`# bands=`がそろっているかを見る。1つでも違えば、値どうしは比べられない
- 表計算ソフトでつなぐときは、`#`の行を外した表を縦に貼り合わせ、各ファイルの1行目の区間長（前述の「Excel/Google Sheetsでの分析手順」のK列）を`# intervalSec=`の値で埋める
- `seq`はファイルごとに0から振り直されるので、どのファイルの行かを示す列を足しておく
- 元のCSVは、つなぐ前のまま残す（つないだファイルは検証器を通らない）

## 2台の端末の記録を並べる

2台の端末で同じ時間に記録したときは、値ではなく、値が上がった時刻・下がった時刻を比べます。dBFSは端末ごとの相対値なので、同じ音でも端末が違えば別の値が出るからです（[計測の資料](measurement.md)の「dBFSでできる比較・できない比較」）。

`over.py`の閾値を`+10`のように`+`付きで渡すと、端末ごとの中央値から閾値を決めるので、どちらの端末でも「その端末にとって上がった時間帯」が出ます。端末ごとの出力を並べ、時刻の列だけを比べてください。端末どうしの時計はずれているので（実機テストのiPhoneとPCでは、音が届く遅れを含めて約0.84秒）、1〜2秒の差は同じ出来事とみなします。

2台で同時に採った記録は手元にないので、1台ぶんの出力だけを載せます（実機テストの階段シーケンスのCSV）。

```text
$ python over.py iphone18pm_sweep_bands_20260929.csv +10
dbfs の中央値 -72.77 + 10 dB = -62.77 dBFS 以上
09-29 14:50:24 - 14:50:30  6秒  seq 18-23  最大 -37.48 dBFS
09-29 14:50:31 - 14:50:36  5秒  seq 25-29  最大 -58.41 dBFS
09-29 14:50:45 - 14:50:50  5秒  seq 39-43  最大 -58.40 dBFS
09-29 14:50:59 - 14:51:04  5秒  seq 53-57  最大 -59.94 dBFS
09-29 14:51:06 - 14:51:12  6秒  seq 60-65  最大 -51.59 dBFS
09-29 14:51:13 - 14:51:18  5秒  seq 67-71  最大 -59.79 dBFS
6回  合計 32秒
```

- 1kHz・15kHz・17kHz・19〜21kHzの段が出た。18kHzの段（全帯域-63.24）と16kHzの段（-66.46）は閾値に届いていない。全帯域の値で比べると、どの段が「上がった」に入るかは、端末と暗騒音で変わる
