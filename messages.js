// Day041 - Mic Gain Logger / 画面の文言の辞書（第2弾c3a）
// 画面に出る文言を日本語（ja）と英語（en）の辞書に集める。logic.js と同じく、ブラウザーでは通常のスクリプト
// （index.html で logic.js より先に読む）として、テストでは CommonJS の require で読む。
// DOM・window・navigator・localStorage には触らない（言語の決め方も、材料を引数で受け取る純ロジックにする）。
//
// ⚠ 約束
//  - 画面に出る文言は、この辞書から出す。script.js に日本語の文字列を書かない（test/i18n.test.js が見ている）
//  - ja と en のキーの集合と、置き換える値（{name}）の名前をそろえる。en の値に日本語の文字を入れない
//  - index.html の日本語の文言は、読み込み直後（script.js が動く前）の表示と、スクリプトが動かないときのためにそのまま残す。
//    HTML の文言と ja の値が同じであることは test/i18n.test.js が見ている（片方だけ直すと落ちる）
//  - 値の中の {name} は引数で置き換える。{name|one|other} は、name の値が1なら one、それ以外なら other を出す
//    （英語の単数・複数のため。数そのものは別に {name} で出す）
//  - data-i18n-rich の値に使えるタグは <strong>・<code>・<em> だけで、入れ子にしない。
//    script.js は richSegments の結果から要素を作る（innerHTML は使わない）
//  - CSV の中身（ヘッダーの key=value・列名）と書き出すファイル名は、言語によらず同じにする。この辞書から出さない
//
// 用語（英語）は CLAUDE.md の「画面の日英対応」の一覧にそろえる（README.en.md でも同じ用語を使う）。

'use strict';

const MicGainMessages = (() => {
  const LANGS = Object.freeze(['ja', 'en']);
  const DEFAULT_LANG = 'ja';
  // 画面で選んだ言語を保存する localStorage のキー（テーマの 'theme' と並べる）
  const LANG_STORAGE_KEY = 'mic-gain-logger-lang';
  // data-i18n-<属性名> で差し替える属性
  const I18N_ATTRS = Object.freeze(['title', 'aria-label', 'alt', 'placeholder', 'content']);
  // data-i18n-rich の値に使えるタグ
  const RICH_TAGS = Object.freeze(['strong', 'code', 'em']);

  const ja = {
    // ---- index.html（読み込み直後の表示と同じ値。test/i18n.test.js が HTML と比べる） ----
    "app.description": "Web Audio API を使ったマイク音量ロガー（録音なし／リアルタイム表示／CSV出力）",
    "app.subtitle": "マイク音量ロガー（録音なし・リアルタイム表示・CSV出力）",
    "lang.toggle.title": "表示を英語に切り替えます（English）",
    "lang.toggle.aria": "EN：表示を英語に切り替えます",
    "lang.toggle": "EN",
    "btn.start.title": "マイクから音量の記録を開始します",
    "btn.start": "記録開始",
    "btn.stop.title": "音量の記録を停止します（マイクに接続中なら、接続を取り消します）",
    "btn.stop": "停止",
    "btn.more.title": "CSV書き出しと統計リセットを表示します",
    "btn.more": "その他",
    "btn.export.title": "記録した音量データをCSVファイルでダウンロードします（記録を停止してから押せます）",
    "btn.export": "CSV書き出し",
    "btn.reset.title": "ログ・統計・グラフ・注意書きをまとめてクリアします（記録を停止してから押せます）",
    "btn.reset": "統計リセット",
    "btn.help.title": "使い方とヘルプを表示します",
    "btn.help.aria": "ヘルプ",
    "btn.theme.title": "ダークモード/ライトモードを切り替えます",
    "btn.theme.aria": "テーマ切り替え",
    "level.heading": "現在の音量",
    "level.bigValue.title": "現在のマイク入力音量（dBFS）。直近2048サンプル（48kHzで約43ミリ秒。サンプルレートで変わる）の全帯域のRMSで、高精度モードのCSVのdbfs（区間全体のエネルギー平均）とは窓が違います。ときどき大きくなる音（扇風機のうなり・洗濯機など）では、エネルギー平均が大きな瞬間に引っぱられるので、この数字のほうがCSVの値より低く見える時間が長くなります。簡易モードでは、CSVのdbfsも記録した瞬間のこの窓の値です",
    "ultraNow.title": "最後に記録した区間の、超音波帯（18〜22kHz）のエネルギー平均です（CSVのband_ultra_dbfsと同じ値）。区間の長さはログ間隔です。上の大きな数字（直近2048サンプルの全帯域のRMS。48kHzで約43ミリ秒で、サンプルレートで変わる）とは、窓も帯域も違います。数dBの小さな変化は、グラフよりこの数字で読んでください。その帯域に音のエネルギーがあったかの記録で、何の音かは分かりません",
    "controls.show": "設定を表示",
    "settings.interval.labelTitle": "CSVログに記録する間隔（秒単位）",
    "settings.interval.label": "ログ間隔（秒）",
    "settings.interval.inputTitle": "音量データをログに記録する間隔を指定します（短いほど詳細、長いほどファイルサイズ小）",
    "preset.1.title": "1秒間隔",
    "preset.3.title": "3秒間隔",
    "preset.5.title": "5秒間隔",
    "preset.10.title": "10秒間隔",
    "preset.60.title": "1分間隔",
    "settings.floor.labelTitle": "表示する最小音量レベル",
    "settings.floor.label": "表示下限（dBFS）",
    "settings.floor.inputTitle": "この値未満の音量は下端に張り付いて表示されます（既定-110dBFS。?bands=offで開いたときは-90dBFS。静かな部屋の超音波帯や、弱い高い音も見えるようにしています）。表示だけの設定で、記録される値は変わりません",
    "status.idle": "待機中",
    "graph.heading": "リアルタイムグラフ",
    "graph.canvas.title": "音量推移グラフ（横軸=-60s〜0s＝いまから何秒前、縦軸=音量レベル dBFS。線の見分け方はグラフの下の凡例にあります）",
    "graph.legend.aria": "グラフの凡例",
    "graph.legend.level.title": "区間ごとの音量（全帯域のエネルギー平均。CSVのdbfs）。音が1つも届かなかった区間は線を切り、デジタル無音は下端に描きます",
    "graph.legend.level": "実線：音量（全帯域）",
    "graph.legend.ultra.title": "超音波帯（18,000〜22,000Hz）の、区間ごとのエネルギー平均（CSVのband_ultra_dbfs）。その帯域に音のエネルギーがあったかの記録で、何の音かは分かりません。値の無い区間は線を切ります",
    "graph.upperLimit.title": "AudioContextとマイクの音声トラックのサンプルレートの、小さいほうの半分です。サンプルレートで決まる上限で、マイクがその高さの音を拾えることは示しません",
    "stats.heading": "統計",
    "stats.uptime.title": "記録開始からの経過時間",
    "stats.uptime": "稼働時間",
    "stats.count.title": "CSVに記録されたデータポイントの総数",
    "stats.count": "ログ件数",
    "stats.avg.title": "記録された行のエネルギー平均（Leq）。重みは行数ではなく区間長（秒）である。無音の行は電力0として数える",
    "stats.avg": "平均（Leq）",
    "stats.max.title": "記録された行のうち、有限値の行での最大音量レベル",
    "stats.max": "最大",
    "stats.min.title": "記録された行のうち、有限値の行での最小音量レベル",
    "stats.min": "最小",
    "stats.range.title": "最大値と最小値の差（有限値の行での変動幅）",
    "stats.range": "変動幅",
    "stats.peak.title": "区間内の標本点の最大絶対振幅（サンプルピーク）のうち、最も大きかったもの。上の「最大」はRMSなので別の値になる。ITU-R BS.1770 のトゥルーピーク（標本の間のピーク）とは別物で、トゥルーピークはこれ以上になる。0 dBFSを超えることがある（浮動小数点の音声なので、上流のリサンプリングの跳ね返りで振幅が1.0を超える）。簡易モードでは測れないため「--.-」のまま",
    "stats.peak": "サンプルピーク",
    "stats.ultraMax.title": "超音波帯（18〜22kHz）の区間ごとの値（CSVのband_ultra_dbfs）のうち、最も大きかったもの。その帯域に音のエネルギーがあったかの記録で、何の音かは分からない。デジタル無音の行に付いた値も数える（区間の境目の前の約21ミリ秒の実際の音が、後ろの区間に入るため）。音が1つも届かなかった区間の行に付いた値も、同じ理由で数える。簡易モードと?bands=offでは測れないため「--.-」のまま",
    "stats.ultraMax": "超音波帯の最大",
    "stats.integrity.title": "クリップした区間と、有効サンプル率が1.000未満だった区間の数。どちらも0なら「穴なし」と出る",
    "notes.summary": "説明と注意事項",
    "notes.noRecording": "本ツールは<strong>録音しません</strong>。音量（dBFS）を可視化・記録します。",
    "notes.relative": "表示は機器・環境に依存します。絶対値ではなく<strong>相対変化</strong>の把握を主目的としてください。",
    "notes.csv": "CSVには10列（時刻・音量・区間の通し番号・ピーク・クリップ数・有効サンプル率・超音波帯と可聴帯の値・帯域の有効率・ハッシュ）が出力されます。データ行の上には測定条件のヘッダー行、下には行数や無音の有無を残すトレーラー行が、どちらも「#」から始まる形で付きます。帯域の値は、その帯域に音のエネルギーがあったかの記録で、何の音かは分かりません。",
    "notes.restart": "<strong>停止直後の再開について：</strong>ブラウザーの仕様により、停止直後に「記録開始」を押してもマイクダイアログが表示されない場合があります。その場合は、URL付近のマイクアイコンを押してマイクダイアログを再表示するか、ページをリロードしてください。",
    "footer.repoLead": "🔗 GitHubリポジトリはこちら（ ",
    "footer.repoTail": " ）",
    "help.title": "ヘルプ - Mic Gain Logger",
    "help.close.aria": "閉じる",
    "help.basic.heading": "🎯 基本的な使い方",
    "help.basic.start": "<strong>「記録開始」</strong>ボタンを押してマイクアクセスを許可",
    "help.basic.live": "音量がリアルタイムで表示・記録されます",
    "help.basic.stop": "<strong>「停止」</strong>で記録を停止（データは保持されます）。「停止」は「記録開始」と同じ場所に出ます",
    "help.basic.export": "<strong>「CSV書き出し」</strong>でデータをダウンロード（スマートフォンなど幅480px以下では「その他」を押すと出ます）",
    "help.basic.reset": "<strong>「統計リセット」</strong>で、ログ・統計・グラフ・注意書きをまとめてクリア（記録を停止してから押せます。幅480px以下では「その他」の中にあります）",
    "help.settings.heading": "⚙️ 設定項目",
    "help.settings.interval": "<strong>ログ間隔：</strong>記録する間隔（秒単位）。プリセットボタン（1s/3s/5s/10s/1m）で素早く設定可能",
    "help.settings.floor": "<strong>表示下限：</strong>表示する最小音量レベル。既定は-110dBFSで、<code>?bands=off</code>で開いたときは-90dBFSです（静かな部屋の超音波帯は-90dBFSより低いことがあり、-90では超音波帯の破線が下端に張り付いたため）。これより静かな値は下端に張り付いて見えます。表示だけの設定で、CSVに記録される値は動きません",
    "help.settings.lang": "<strong>表示の言語：</strong>右上のボタン（日本語の表示ではEN、英語の表示ではJA）で日本語と英語を切り替えます。URLに<code>?lang=en</code>か<code>?lang=ja</code>を付けて開いても選べます。ボタンで選んだ言語はこのブラウザーに保存し、次に開いたときに使います（<code>?lang=</code>があればそちらを優先し、どちらも無ければブラウザーの言語に合わせます）。記録・統計・CSVの中身は、言語によって変わりません",
    "help.settings.noteLive": "※ すべての設定は記録中でも変更可能で即座に反映されます",
    "help.settings.noteMobile": "※ スマートフォンでは「設定を表示」ボタンで設定項目を開閉できます",
    "help.stats.heading": "📊 統計と表示",
    "help.stats.bigValue": "<strong>現在の音量（大きな数字）：</strong>直近2048サンプル（48kHzで約43ミリ秒。サンプルレートで変わる）の全帯域のRMSです。高精度モードのCSVの<code>dbfs</code>は区間全体のエネルギー平均なので、窓が違います。ときどき大きくなる音（扇風機のうなり・洗濯機など）では、エネルギー平均が大きな瞬間に引っぱられるので、大きな数字のほうがCSVの値より低く見える時間が長くなります。簡易モードでは、CSVの<code>dbfs</code>も記録した瞬間のこの窓の値です",
    "help.stats.ultraNow": "<strong>超音波帯（直近の区間）：</strong>大きな数字の下の1行です。最後に記録した区間の超音波帯（18〜22kHz）の値で、CSVの<code>band_ultra_dbfs</code>と同じです。区間の長さはログ間隔で、「超音波帯（直近1秒の区間）」のように添えます。大きな数字とは窓も帯域も違います。数dBの小さな変化は、グラフよりこの数字で読んでください。最初の区間が届くまでは「--.- dBFS」、値の無い区間では「（この区間は値なし）」と出ます。<code>?bands=off</code>・簡易モード・超音波帯を測れないサンプルレートでは、値の代わりに理由（「簡易モードでは測れません」など）が出ます。統計リセットで最初の状態に戻ります",
    "help.stats.uptime": "<strong>稼働時間：</strong>記録開始からの経過時間",
    "help.stats.count": "<strong>ログ件数：</strong>CSVに記録されたデータポイント総数",
    "help.stats.avg": "<strong>平均（Leq）：</strong>記録された行のエネルギー平均。⚠<strong>重みは行数ではなく区間長（秒）です。</strong>ログ間隔は記録中に変えられるので、1秒の区間と3秒の区間を同じ重みで平均すると実時間に比例しない値になります（手元の検算では最大9.3dBずれました）。dBは対数なので算術平均にも物理的な意味がなく、無音の行を-999などへ置き換えて平均すると数百dB外れます。無音の行は電力0として数えます。音が1つも届かなかった区間（CSVの<code>dbfs</code>が空欄の行）は、測っていないので入れません",
    "help.stats.maxMin": "<strong>最大/最小/変動幅：</strong>記録された行のうち、有限値の行での最大・最小とその差。無音（-∞ dBFS）の区間は外します",
    "help.stats.peak": "<strong>サンプルピーク：</strong>区間内の標本点の最大絶対振幅のうち、最も大きかったもの。上の「最大」はRMSなので別の値になります。ITU-R BS.1770 のトゥルーピーク（標本の間のピーク）とは別物で、トゥルーピークはこれ以上になります。0 dBFSを超えることがあります（上流のリサンプリングの跳ね返りで振幅が1.0を超えるため）。簡易モードでは測れないため「--.-」のままです",
    "help.stats.ultraMax": "<strong>超音波帯の最大：</strong>CSVの<code>band_ultra_dbfs</code>（超音波帯18〜22kHzの、区間ごとの値）のうち、最も大きかったもの。その帯域に音のエネルギーがあったかの記録で、何の音かは分かりません。デジタル無音の行（<code>dbfs</code>が<code>-Infinity</code>）に付いた値も数えます。区間の境目の前の約21ミリ秒の実際の音が後ろの区間に入るためで、架空の値ではありません。音が1つも届かなかった区間の行に付いた値も、同じ理由で数えます。簡易モードと<code>?bands=off</code>では測れないため「--.-」のままです",
    "help.stats.integrity": "<strong>記録の穴：</strong>統計の下に1行で出ます。<strong>クリップした区間</strong>（|振幅|が1.0に届いたサンプルを含む区間。1〜2サンプルの単発なら区間の値への影響は小さく、3サンプル以上続いていれば波形がつぶれて値は本来の音と違います。注意書きには、記録した全サンプルに対する割合も出ます）と、<strong>有効サンプル率</strong>（届いたサンプル数÷期待サンプル数。1.000未満＝その区間の音の一部が届いていない）の区間数を示します。どちらも0なら「記録の穴なし」と出ます",
    "help.stats.graph": "<strong>リアルタイムグラフ：</strong>時系列での音量推移を可視化。実線が音量（全帯域）、破線が超音波帯（18〜22kHz）の値です（グラフの下の凡例に、色と線の形があります）。音が1つも届かなかった区間と、帯域の値が無い区間は線を切ります。デジタル無音は下端に描きます。簡易モード・<code>?bands=off</code>・超音波帯を測れないサンプルレートでは超音波帯の線を描かず、凡例に見本の線の代わりに理由（「簡易モードでは測れません」など）が出ます",
    "help.stats.upperLimit": "<strong>記録できる上限：</strong>記録を始めると、凡例の下に「この端末で記録できる上限：約◯◯kHz」と出ます。AudioContextとマイクの音声トラックのサンプルレートの、小さいほうの半分です（トラックがサンプルレートを報告しないときはAudioContextの半分で、「トラックの値は不明」と添えます）。サンプルレートで決まる上限で、マイクがその高さの音を拾えることは示しません",
    "help.stats.bandNotice": "<strong>帯域の注意書き：</strong>次のときに、記録の注意として出ます。帯域の有効率（CSVの<code>band_valid_ratio</code>）が1.0を下回った区間があるとき（件数と最小値）。マイクの音声トラックとAudioContextのサンプルレートが違うとき（サンプルレートの変換で、上限に近い高い音は低く記録されます）。サンプルレートが低くて超音波帯を測れないとき。<code>?bands=off</code>で帯域の計算を止めているとき。簡易モードで帯域を計算していないとき",
    "help.stats.bandsOff": "<strong>?bands=off：</strong>URLの末尾に<code>?bands=off</code>を付けて開くと、帯域の計算を止めます（帯域あり・なしで有効サンプル率を比べるためのものです）。凡例と注意書きに「止めています」と出て、超音波帯の線は描かれず、「超音波帯の最大」は「--.-」のままです。CSVの帯域の3列は空欄になります",
    "help.stats.meter": "<strong>音量メーター：</strong>現在の音量を色分けで表示（緑→黄→赤）",
    "help.stats.noteRows": "※ 統計はCSVに書き出される行（区間）だけから計算します",
    "help.stats.noteCsv": "※ CSVから同じ値を出せますが、条件があります。区間長はtimestamp（区間の終わり）の差で作れる一方、トレーラーの<code>#\u00a0sessionStartAt=</code>と<code>#\u00a0clockBreakAt=</code>に並ぶseqの行だけは差を使えません。記録を止めて再開した境界では差に休止時間がまるごと入り、時刻のアンカーを取り直した行では跳んだぶんが入るためです。その行は<code>#\u00a0intervalSec=</code>のログ間隔を重みにしてください（<code>1@0+3@12</code>＝seq\u00a00から1秒、seq\u00a012から3秒）。手元の実測では、この置き換えをしないと17行の記録で6.49dB外れ、置き換えると小数10桁まで一致しました。音が1つも届かなかった区間（<code>dbfs</code>が空欄の行）は統計に入れていないので、その行の重みは0にしてください。手順はREADMEにあります",
    "help.stats.noteSessions": "※ 複数回の記録セッション（記録開始→停止→記録開始）でデータは累積されます",
    "help.data.heading": "💾 データの取り扱い",
    "help.data.noRecording": "<strong>録音なし：</strong>音声は一切記録されず、音量データのみを扱います",
    "help.data.csv": "<strong>CSV形式：</strong>10列（timestamp・dbfs・seq・peak_dbfs・clip・valid_ratio・band_ultra_dbfs・band_audible_dbfs・band_valid_ratio・hash）を、測定条件のヘッダー行と、行数・ログ間隔・セッションの境界・無音の有無を残すトレーラー行（どちらも「#」から始まる）で挟んで出力。音が1つも届かなかった区間は<code>dbfs</code>を空欄にします（デジタル無音の<code>-Infinity</code>とは別です）",
    "help.data.chain": "<strong>ハッシュチェーン：</strong>各行のハッシュに前の行のハッシュを混ぜています。CSVがそのまま渡ってきたときに、うっかりの破損・部分的な欠落・順序の入れ替わりを見つけられます。⚠<strong>意図的な改変には、相手が誰であっても耐えません。</strong>鎖の作り方をREADMEで公開しているので、値を書き換えたあとにハッシュを計算し直せば検証は通ります。記録が正しいことの証明には使えません",
    "help.data.cumulative": "<strong>累積記録：</strong>停止→再開しても前回データは保持されます",
    "help.data.privacy": "<strong>プライバシー配慮：</strong>すべての処理はブラウザー内で完結",
    "help.trouble.heading": "🔧 トラブルシューティング",
    "help.trouble.dialog": "<strong>マイクダイアログが表示されない：</strong>ブラウザーのURL付近のマイクアイコンを押すか、ページをリロード",
    "help.trouble.noValue": "<strong>音量が「--.- dBFS」のまま：</strong>マイクが正しく接続・選択されているか確認",
    "help.trouble.engine": "<strong>計測エンジンの表示：</strong>「高精度モード」はオーディオスレッドで区間ごとに集計するため、タブが背面になっても記録が途切れません。「簡易モード」はAudioWorkletのモジュールを読み込めないときの代替で、描画が止まると記録も欠けます。ブラウザーが未対応のときより、file:// で直接開いたときのほうが遭遇しやすいので、https または localhost 経由で開き直してください。なお file:// で落ちるのはモジュールの読み込みだけで、ハッシュのほうは file:// でも計算されます",
    "help.trouble.graph": "<strong>グラフが表示されない：</strong>ページをリロードして再試行",
    "help.trouble.phone": "<strong>スマートフォンで操作しにくい：</strong>画面を縦向きにして使用してください",
    "help.mobile.heading": "📱 モバイル利用について",
    "help.mobile.responsive": "<strong>レスポンシブ対応：</strong>スマートフォンとタブレットに最適化",
    "help.mobile.touch": "<strong>タッチ操作：</strong>主要な操作ボタンは44px以上、プリセットなど補助的なボタンは24px以上（WCAG 2.2 の 2.5.8 に準拠）",
    "help.mobile.collapse": "<strong>設定の折りたたみ：</strong>「設定を表示/隠す」で画面を有効活用",
    "help.mobile.buttons": "<strong>ボタンの配置：</strong>「記録開始」と「停止」は同じ場所に出て、そのとき押せるほうだけが見えます。幅480px以下では「CSV書き出し」と「統計リセット」を「その他」にまとめ、ヘルプとテーマの切り替えを同じ行に並べます。「その他」はEscキーでも閉じられます",
    "help.mobile.battery": "<strong>バッテリー考慮：</strong>不要時は停止してバッテリー消費を抑制",
    "help.caution.heading": "⚠️ 重要な注意事項",
    "help.caution.noRecording": "<strong>録音機能なし：</strong>音声そのものは保存されません（音量レベルのみ）",
    "help.caution.env": "<strong>環境依存：</strong>表示値は機器・環境により変動するため、絶対値でなく相対変化を参考に",
    "help.caution.purpose": "<strong>用途制限：</strong>本ツールは物理セキュリティ・音響監視の補助用途を想定",
    "help.caution.proof": "<strong>証明には使えません：</strong>CSVのハッシュチェーンは、うっかりの破損や欠落に気づくためのものです。意図的な改変には耐えないため、記録が正しいことの証明には使えません",
    "help.caution.legal": "<strong>法的配慮：</strong>使用時は適用される法律・規制を遵守してください。音量のみの記録でも、記録する場所と目的によっては制約がかかります",

    // ---- script.js（状態の文・エラーの文・計測エンジン・設定の開閉・メーターの説明） ----
    "controls.hide": "設定を隠す",
    "meter.title": "音量レベルメーター（{floor}dBFS〜0dBFS）",
    "engine.worklet": "計測エンジン：高精度モード（AudioWorklet・オーディオクロック基準）",
    "engine.fallback": "計測エンジン：簡易モード（欠測の可能性あり）",
    "status.deviceLost": "マイクが切断されました。記録を停止しました",
    "status.suspended": "計測が中断しています（画面のロックなど）",
    "status.resumed": "計測中（中断から復帰しました）",
    "status.connecting": "マイクに接続中…",
    "status.preparing": "マイク接続の準備中...少しお待ちください",
    "status.promptHint": "マイクの許可ダイアログに応答してください（「停止」で取り消せます）",
    "status.timeout": "マイクを{sec}秒以内に取得できませんでした。許可ダイアログに応答してから、もう一度お試しください",
    "status.measuring": "計測中",
    "status.denied": "マイクへのアクセスが拒否されました。ブラウザーのURL欄のマイクアイコンを確認してください",
    "status.notFound": "マイクが見つかりません。デバイスを確認してください",
    "status.error": "エラー：{message}",
    "status.canceled": "マイクの取得を取り消しました",
    "status.stopped": "停止しました",
    "status.noLogs": "書き出すログがありません",
    "status.exported": "CSVを書き出しました（{count}件）",
    "status.reset": "統計・ログ・グラフをリセットしました",
    "status.unsupported": "このブラウザーはマイク取得に対応していません",

    // ---- logic.js（注意書き・記録の穴・凡例・超音波帯の現在値・上限の表示） ----
    "share.tiny": "0.01%未満",
    "notice.clip.share": "＝記録した全サンプルの{share}",
    "notice.clip.head": "クリップを{rows}区間で検出しました（延べ{samples}サンプル{share}）。",
    "notice.clip.sustained": "連続して頭打ちになった箇所があります（最長{run}サンプル）。その区間は波形がつぶれていて、値は本来の音と違います。",
    "notice.clip.single": "いずれも単発（連続{n}サンプル未満）で、区間の値への影響は小さいと見られます。",
    "notice.clip.cause": "マイクへの接触・端末の操作音・風や息のほか、音が大きすぎて波の山が1.0に届いている場合があります。後者なら端末を音源から離してください",
    "notice.clip.kindSustained": "（連続あり）",
    "notice.clip.kindSingle": "（単発のみ）",
    "notice.clip.short": "クリップ{rows}区間{kind}",
    "notice.valid.short": "有効サンプル率 最小{pct}%",
    "notice.valid.full": "有効サンプル率が1.0を下回った区間が{rows}件あります（最小 {pct}%）。その区間は音の一部が届いていません（CSVの valid_ratio 列に残ります）",
    "notice.valid.missing": "。うち{missing}区間は音が1つも届かず、CSVの dbfs を空欄にしています（無音とは別で、平均には入れません）",
    "notice.bandValid.short": "帯域の有効率 最小{pct}%",
    "notice.bandValid.full": "帯域の有効率が1.0を下回った区間が{rows}件あります（最小 {pct}%）。その区間の帯域の値には、計算に入らなかった時間があります（CSVのband_valid_ratio列に残ります）",
    "notice.summary": "記録の注意 {count}件：{items}",
    "notice.summarySep": "／",
    "integrity.unknown": "記録の穴は確かめられません（簡易モードの{total}区間だけなので、クリップ数も有効サンプル率も測れません）",
    "integrity.clip": "クリップ{rows}区間",
    "integrity.validLow": "有効サンプル率が1.000未満の区間{rows}件・最小{min}",
    "integrity.validAll": "有効サンプル率は{known}区間すべて1.000",
    "integrity.fallbackTail": "／簡易モードの{unknown}区間は測れません",
    "integrity.clean": "記録の穴なし",
    "integrity.dirty": "記録に穴あり",
    "integrity.line": "{head}（{clip}／{valid}）{tail}",
    "band.range": "{lo}〜{hi}kHz",
    "upper.head": "この端末で記録できる上限：約{khz}kHz",
    "upper.trackUnknown": "{head}（AudioContext {ctx}kHzの半分。トラックの値は不明）",
    "upper.same": "{head}（サンプルレート{ctx}kHzの半分）",
    "upper.min": "{head}（マイク{track}kHz・AudioContext {ctx}kHzの小さいほうの半分）",
    "ultra.reason.off": "止めています（?bands=off）",
    "ultra.reason.fallback": "簡易モードでは測れません",
    "ultra.reason.noBins": "このサンプルレートでは測れません",
    "legend.ultra": "破線：超音波帯（{range}）",
    "legend.ultraStopped": "超音波帯（{range}）：{reason}",
    "aria.lines.on": "実線は音量（全帯域）、破線は超音波帯（{range}）の値",
    "aria.lines.off": "実線は音量（全帯域）。超音波帯（{range}）の線は描きません（{reason}）",
    "aria.graph": "音量推移グラフ。{lines}。横軸は直近{sec}秒、縦軸はdBFS",
    "ultraNow.headSec": "超音波帯（直近{sec}秒の区間）：",
    "ultraNow.head": "超音波帯（直近の区間）：",
    "ultraNow.noValue": "（この区間は値なし）",
    "bandNotice.below": "。超音波帯（{range}）はこの上限より上にあり、その帯域の値は超音波帯の音を表しません",
    "bandNotice.mismatch.short": "サンプルレートの変換あり（マイク{track}kHz／AudioContext {ctx}kHz）",
    "bandNotice.mismatch.full": "マイクの音声トラック（{track}kHz）とAudioContext（{ctx}kHz）のサンプルレートが違います。サンプルレートの変換で、上限に近い高い音は低く記録されます（この端末で記録できる上限は約{limit}kHz）",
    "bandNotice.off.short": "帯域の計算を停止中（?bands=off）",
    "bandNotice.off.full": "帯域の計算を止めています（?bands=off）。CSVの帯域の3列は空欄になり、グラフの超音波帯の線は描かれず、統計の「超音波帯の最大」は「--.-」のままです",
    "bandNotice.fallback.short": "帯域を計算していない（簡易モード）",
    "bandNotice.fallback.full": "簡易モードでは帯域を計算しません。CSVの帯域の3列は空欄になり、グラフの超音波帯の線は描かれず、統計の「超音波帯の最大」は「--.-」のままです",
    "bandNotice.noBins.short": "超音波帯を測れない（サンプルレート{ctx}kHz）",
    "bandNotice.noBins.full": "AudioContextのサンプルレート（{ctx}kHz）では、超音波帯（{range}）の周波数を表せません（表せる上限は約{half}kHz）。CSVのband_ultra_dbfsは空欄になり、グラフの超音波帯の線も出ません",
    "device.gone": "音声トラックが無くなりました",
    "device.lost": "マイクが切断されました",
    "notice.deviceLoss.short": "{label}（{rows}行目まで記録）",
    "notice.deviceLoss.full": "{label}。{rows}行目までを記録し、そのあとは記録していません（ここまでのログは書き出せます）",
    "notice.muted.short": "マイクが無音化されている",
    "notice.muted.full": "マイクが供給元で無音化されています（通話の割り込みなど）。この間の記録はデジタル無音になります",
    "notice.processingActive.short": "音の加工が有効（{keys}）",
    "notice.processingActive.full": "マイク側の音の加工が有効です（{keys}）。利得が自動で動くため、この記録の dBFS は絶対値として扱えません",
    "notice.processingUnknown.short": "音の加工の状態が不明（{keys}）",
    "notice.processingUnknown.full": "マイク側の音の加工（{keys}）の状態を、このブラウザーは報告しません。利得が自動で動いていても、この画面とCSVからは分かりません",
    "notice.clock.short": "時刻の跳び{count}回",
    "notice.clock.full": "時刻の跳びを{count}回検出（累計 {sec} 秒）。以降の時刻は取り直したアンカーで出し、該当区間はCSVのメタ行（# clockBreaks / # clockBreakAt / # clockDriftMs）に残ります"
  };

  const en = {
    // ---- index.html ----
    "app.description": "Microphone level logger built on the Web Audio API (no audio recording / live display / CSV export)",
    "app.subtitle": "Mic level logger (no audio recording, live view, CSV export)",
    "lang.toggle.title": "Switch the display to Japanese",
    "lang.toggle.aria": "JA: Switch the display to Japanese",
    "lang.toggle": "JA",
    "btn.start.title": "Start recording the level from the microphone",
    "btn.start": "Start recording",
    "btn.stop.title": "Stop recording (or cancel while connecting to the microphone)",
    "btn.stop": "Stop",
    "btn.more.title": "Show Export CSV and Reset stats",
    "btn.more": "More",
    "btn.export.title": "Download the recorded level data as a CSV file (available after you stop recording)",
    "btn.export": "Export CSV",
    "btn.reset.title": "Clear the log, statistics, graph and notes at once (available after you stop recording)",
    "btn.reset": "Reset stats",
    "btn.help.title": "Show usage and help",
    "btn.help.aria": "Help",
    "btn.theme.title": "Switch between dark mode and light mode",
    "btn.theme.aria": "Switch theme",
    "level.heading": "Current level",
    "level.bigValue.title": "Current microphone input level (dBFS): the full-band RMS of the latest 2048 samples (about 43 ms at 48 kHz; depends on the sample rate). Its window differs from the dbfs in the high-precision mode CSV (the energy average over the whole interval). For sounds that get loud now and then (a fan's hum, a washing machine), the energy average is pulled up by the loud moments, so this number looks lower than the CSV value for longer stretches. In fallback mode, the CSV dbfs is also this window's value at the moment of recording",
    "ultraNow.title": "Energy average of the ultrasonic band (18–22 kHz) in the last recorded interval (the same value as band_ultra_dbfs in the CSV). The interval length is the log interval. Both the window and the band differ from the big number above (the full-band RMS of the latest 2048 samples; about 43 ms at 48 kHz, depending on the sample rate). Read small changes of a few dB from this number rather than from the graph. It records whether there was sound energy in that band; it cannot tell what the sound is",
    "controls.show": "Show settings",
    "settings.interval.labelTitle": "How often a row is written to the CSV log (seconds)",
    "settings.interval.label": "Log interval (s)",
    "settings.interval.inputTitle": "Set how often the level is written to the log (shorter = more detail, longer = smaller file)",
    "preset.1.title": "Every 1 second",
    "preset.3.title": "Every 3 seconds",
    "preset.5.title": "Every 5 seconds",
    "preset.10.title": "Every 10 seconds",
    "preset.60.title": "Every 1 minute",
    "settings.floor.labelTitle": "Lowest level shown on the screen",
    "settings.floor.label": "Display floor (dBFS)",
    "settings.floor.inputTitle": "Levels below this value stick to the bottom of the display (default -110 dBFS, so that the ultrasonic band in a quiet room and weak high-pitched sounds stay visible; -90 dBFS when opened with ?bands=off). Display only: recorded values do not change",
    "status.idle": "Idle",
    "graph.heading": "Live graph",
    "graph.canvas.title": "Level graph (horizontal axis: -60s to 0s = seconds ago; vertical axis: level in dBFS. The legend below the graph shows how to tell the lines apart)",
    "graph.legend.aria": "Graph legend",
    "graph.legend.level.title": "Level of each interval (full-band energy average; dbfs in the CSV). The line breaks at intervals where no sample arrived; digital silence is drawn at the bottom",
    "graph.legend.level": "Solid: level (full band)",
    "graph.legend.ultra.title": "Energy average of the ultrasonic band (18,000–22,000 Hz) for each interval (band_ultra_dbfs in the CSV). It records whether there was sound energy in that band; it cannot tell what the sound is. The line breaks at intervals without a value",
    "graph.upperLimit.title": "Half of the smaller of the AudioContext and microphone track sample rates. This limit comes from the sample rate; it does not mean the microphone can pick up sounds that high",
    "stats.heading": "Statistics",
    "stats.uptime.title": "Time elapsed since recording started",
    "stats.uptime": "Elapsed",
    "stats.count.title": "Total number of data points written to the CSV",
    "stats.count": "Log rows",
    "stats.avg.title": "Energy average (Leq) of the recorded rows, weighted by interval length (seconds), not by row count. Silent rows count as zero power",
    "stats.avg": "Average (Leq)",
    "stats.max.title": "Highest level among the recorded rows with finite values",
    "stats.max": "Max",
    "stats.min.title": "Lowest level among the recorded rows with finite values",
    "stats.min": "Min",
    "stats.range.title": "Difference between max and min (range over the rows with finite values)",
    "stats.range": "Range",
    "stats.peak.title": "The largest per-interval sample peak (the largest absolute sample value in an interval). \"Max\" above is RMS, so the values differ. This is not the ITU-R BS.1770 true peak (the peak between samples); the true peak is at least this high. It can exceed 0 dBFS (the audio is floating point, so overshoot from upstream resampling can push the amplitude above 1.0). Not measured in fallback mode, so it stays \"--.-\"",
    "stats.peak": "Sample peak",
    "stats.ultraMax.title": "The largest per-interval value of the ultrasonic band (18–22 kHz) (band_ultra_dbfs in the CSV). It records whether there was sound energy in that band; it cannot tell what the sound is. Values attached to digital-silence rows count too (up to about 21 ms of real sound just before an interval boundary goes into the following interval). Values attached to rows of intervals where no sample arrived count for the same reason. Not measured in fallback mode or with ?bands=off, so it stays \"--.-\"",
    "stats.ultraMax": "Ultrasonic max",
    "stats.integrity.title": "Number of intervals with clipping and of intervals whose valid sample ratio was below 1.000. When both are 0, it says \"No recording gaps\"",
    "notes.summary": "About this tool and notes",
    "notes.noRecording": "This tool <strong>does not record audio</strong>. It visualizes and logs the level (dBFS).",
    "notes.relative": "Readings depend on the device and environment. Use them mainly to follow <strong>relative changes</strong>, not absolute values.",
    "notes.csv": "The CSV has 10 columns (time, level, interval sequence number, peak, clip count, valid sample ratio, ultrasonic band and audible band values, band valid ratio, hash). Header lines with the measurement conditions come above the data rows, and trailer lines with the row count and whether there was silence come below them; both start with \"#\". A band value records whether there was sound energy in that band; it cannot tell what the sound is.",
    "notes.restart": "<strong>Restarting right after stopping:</strong> because of browser behavior, pressing \"Start recording\" right after stopping may not show the microphone dialog. In that case, click the microphone icon near the URL to show the dialog again, or reload the page.",
    "footer.repoLead": "🔗 GitHub repository (",
    "footer.repoTail": ")",
    "help.title": "Help - Mic Gain Logger",
    "help.close.aria": "Close",
    "help.basic.heading": "🎯 Basic usage",
    "help.basic.start": "Press <strong>\"Start recording\"</strong> and allow microphone access",
    "help.basic.live": "The level is shown and recorded in real time",
    "help.basic.stop": "<strong>\"Stop\"</strong> stops recording (the data is kept). \"Stop\" appears in the same place as \"Start recording\"",
    "help.basic.export": "<strong>\"Export CSV\"</strong> downloads the data (on screens 480px wide or narrower, such as phones, press \"More\" to show it)",
    "help.basic.reset": "<strong>\"Reset stats\"</strong> clears the log, statistics, graph and notes at once (available after you stop recording; on screens 480px wide or narrower it is under \"More\")",
    "help.settings.heading": "⚙️ Settings",
    "help.settings.interval": "<strong>Log interval:</strong> how often a row is recorded (seconds). The preset buttons (1s/3s/5s/10s/1m) set it quickly",
    "help.settings.floor": "<strong>Display floor:</strong> the lowest level shown. The default is -110 dBFS, or -90 dBFS when opened with <code>?bands=off</code> (the ultrasonic band in a quiet room can be below -90 dBFS, and at -90 its dashed line stuck to the bottom). Quieter values stick to the bottom of the display. Display only: the values recorded in the CSV do not change",
    "help.settings.lang": "<strong>Display language:</strong> the button at the top right (EN on the Japanese display, JA on the English display) switches between Japanese and English. You can also open the page with <code>?lang=en</code> or <code>?lang=ja</code> in the URL. The language chosen with the button is saved in this browser and used the next time (<code>?lang=</code> takes priority; with neither, the browser language is used). Recording, statistics and the CSV contents do not depend on the language",
    "help.settings.noteLive": "Note: all settings can be changed during recording and apply immediately",
    "help.settings.noteMobile": "Note: on phones, the \"Show settings\" button opens and closes the settings",
    "help.stats.heading": "📊 Statistics and display",
    "help.stats.bigValue": "<strong>Current level (big number):</strong> the full-band RMS of the latest 2048 samples (about 43 ms at 48 kHz; depends on the sample rate). The <code>dbfs</code> in the high-precision mode CSV is the energy average over the whole interval, so the window differs. For sounds that get loud now and then (a fan's hum, a washing machine), the energy average is pulled up by the loud moments, so the big number looks lower than the CSV value for longer stretches. In fallback mode, the CSV <code>dbfs</code> is also this window's value at the moment of recording",
    "help.stats.ultraNow": "<strong>Ultrasonic band (last interval):</strong> the line under the big number. It is the ultrasonic band (18–22 kHz) value of the last recorded interval, the same as <code>band_ultra_dbfs</code> in the CSV. The interval length is the log interval, shown as in \"Ultrasonic band (last 1 s interval)\". Both the window and the band differ from the big number. Read small changes of a few dB from this number rather than from the graph. Until the first interval arrives it shows \"--.- dBFS\", and for an interval without a value it adds \"(no value for this interval)\". With <code>?bands=off</code>, in fallback mode, or at a sample rate that cannot measure the ultrasonic band, a reason (such as \"not measured in fallback mode\") appears instead of a value. Reset stats returns it to the initial state",
    "help.stats.uptime": "<strong>Elapsed:</strong> time elapsed since recording started",
    "help.stats.count": "<strong>Log rows:</strong> total number of data points written to the CSV",
    "help.stats.avg": "<strong>Average (Leq):</strong> the energy average of the recorded rows. ⚠<strong>It is weighted by interval length (seconds), not by row count.</strong> The log interval can change during recording, so averaging 1-second and 3-second intervals with equal weight gives a value that is not proportional to real time (up to 9.3 dB off in our own check). dB is logarithmic, so an arithmetic mean has no physical meaning either, and replacing silent rows with -999 or similar before averaging is off by hundreds of dB. Silent rows count as zero power. Intervals where no sample arrived (rows whose CSV <code>dbfs</code> is empty) are left out because nothing was measured",
    "help.stats.maxMin": "<strong>Max/Min/Range:</strong> the maximum, the minimum and their difference among the recorded rows with finite values. Silent (-∞ dBFS) intervals are excluded",
    "help.stats.peak": "<strong>Sample peak:</strong> the largest per-interval sample peak (the largest absolute sample value in an interval). \"Max\" above is RMS, so the values differ. This is not the ITU-R BS.1770 true peak (the peak between samples); the true peak is at least this high. It can exceed 0 dBFS (overshoot from upstream resampling can push the amplitude above 1.0). Not measured in fallback mode, so it stays \"--.-\"",
    "help.stats.ultraMax": "<strong>Ultrasonic max:</strong> the largest value of <code>band_ultra_dbfs</code> in the CSV (the per-interval value of the ultrasonic band, 18–22 kHz). It records whether there was sound energy in that band; it cannot tell what the sound is. Values attached to digital-silence rows (<code>dbfs</code> is <code>-Infinity</code>) count too: up to about 21 ms of real sound just before an interval boundary goes into the following interval, so the value is not fictitious. Values attached to rows of intervals where no sample arrived count for the same reason. Not measured in fallback mode or with <code>?bands=off</code>, so it stays \"--.-\"",
    "help.stats.integrity": "<strong>Recording gaps:</strong> one line under the statistics. It shows how many intervals had <strong>clipping</strong> (a sample whose |amplitude| reached 1.0; a single hit of 1–2 samples has little effect on the interval's value, but 3 or more samples in a row flatten the waveform and the value differs from the real sound; the recording notes also show the share of all recorded samples) and how many had a <strong>valid sample ratio</strong> below 1.000 (samples received ÷ samples expected; below 1.000 means part of that interval's sound did not arrive). When both are 0, it says \"No recording gaps\"",
    "help.stats.graph": "<strong>Live graph:</strong> shows how the level changes over time. The solid line is the level (full band) and the dashed line is the ultrasonic band (18–22 kHz) (the legend below the graph shows the colors and line styles). The lines break at intervals where no sample arrived and at intervals without a band value. Digital silence is drawn at the bottom. In fallback mode, with <code>?bands=off</code>, or at a sample rate that cannot measure the ultrasonic band, the ultrasonic band line is not drawn, and the legend shows a reason (such as \"not measured in fallback mode\") instead of the sample line",
    "help.stats.upperLimit": "<strong>Recordable limit:</strong> once recording starts, \"Recordable limit on this device: about NN kHz\" appears under the legend. It is half of the smaller of the AudioContext and microphone track sample rates (if the track does not report its sample rate, half of the AudioContext rate, with \"track rate unknown\" added). This limit comes from the sample rate; it does not mean the microphone can pick up sounds that high",
    "help.stats.bandNotice": "<strong>Band notes:</strong> these appear as recording notes when some interval's band valid ratio (<code>band_valid_ratio</code> in the CSV) fell below 1.0 (with the count and the minimum); when the microphone track and the AudioContext have different sample rates (sample rate conversion records high sounds near the limit lower); when the sample rate is too low to measure the ultrasonic band; when band computation is stopped with <code>?bands=off</code>; and when bands are not computed in fallback mode",
    "help.stats.bandsOff": "<strong>?bands=off:</strong> opening the page with <code>?bands=off</code> at the end of the URL stops band computation (to compare the valid sample ratio with and without bands). The legend and the notes say it is stopped, the ultrasonic band line is not drawn, and \"Ultrasonic max\" stays \"--.-\". The three band columns in the CSV are empty",
    "help.stats.meter": "<strong>Level meter:</strong> shows the current level with colors (green → yellow → red)",
    "help.stats.noteRows": "Note: the statistics are computed only from the rows (intervals) written to the CSV",
    "help.stats.noteCsv": "Note: you can get the same values from the CSV, with conditions. Interval lengths can be made from differences of timestamp (the end of each interval), except for the rows whose seq is listed in the trailer's <code>#\u00a0sessionStartAt=</code> and <code>#\u00a0clockBreakAt=</code>: at a boundary where recording stopped and resumed, the difference includes the whole pause, and at a row where the clock anchor was reset, it includes the jump. For those rows, use the log interval from <code>#\u00a0intervalSec=</code> as the weight (<code>1@0+3@12</code> = 1 s from seq\u00a00, 3 s from seq\u00a012). In our own measurement, a 17-row recording was 6.49 dB off without this replacement and matched to 10 decimal places with it. Intervals where no sample arrived (rows whose <code>dbfs</code> is empty) are not in the statistics, so give those rows a weight of 0. The steps are in the README",
    "help.stats.noteSessions": "Note: data accumulates over multiple recording sessions (Start recording → Stop → Start recording)",
    "help.data.heading": "💾 Data handling",
    "help.data.noRecording": "<strong>No audio recording:</strong> no audio is recorded; only level data is handled",
    "help.data.csv": "<strong>CSV format:</strong> 10 columns (timestamp, dbfs, seq, peak_dbfs, clip, valid_ratio, band_ultra_dbfs, band_audible_dbfs, band_valid_ratio, hash) between header lines with the measurement conditions and trailer lines with the row count, log intervals, session boundaries and whether there was silence (both start with \"#\"). For an interval where no sample arrived, <code>dbfs</code> is left empty (unlike digital silence, <code>-Infinity</code>)",
    "help.data.chain": "<strong>Hash chain:</strong> each row's hash includes the previous row's hash. When the CSV arrives as it was, this reveals accidental corruption, partial loss and reordering. ⚠<strong>It does not withstand intentional changes, whoever makes them.</strong> The README publishes how the chain is built, so rewriting values and recomputing the hashes passes the check. It cannot prove that a record is correct",
    "help.data.cumulative": "<strong>Cumulative recording:</strong> earlier data is kept when you stop and start again",
    "help.data.privacy": "<strong>Privacy:</strong> all processing stays in the browser",
    "help.trouble.heading": "🔧 Troubleshooting",
    "help.trouble.dialog": "<strong>The microphone dialog does not appear:</strong> click the microphone icon near the browser's URL, or reload the page",
    "help.trouble.noValue": "<strong>The level stays at \"--.- dBFS\":</strong> check that a microphone is connected and selected",
    "help.trouble.engine": "<strong>Engine display:</strong> \"high-precision mode\" aggregates each interval on the audio thread, so recording continues even when the tab is in the background. \"Fallback mode\" is the substitute used when the AudioWorklet module cannot be loaded; when drawing stops, the recording has gaps too. You are more likely to meet it by opening the file directly with file:// than because of an unsupported browser, so reopen it via https or localhost. On file://, only the module loading fails; the hashes are still computed",
    "help.trouble.graph": "<strong>The graph does not appear:</strong> reload the page and try again",
    "help.trouble.phone": "<strong>Hard to use on a phone:</strong> hold the phone in portrait orientation",
    "help.mobile.heading": "📱 Using on mobile",
    "help.mobile.responsive": "<strong>Responsive:</strong> optimized for phones and tablets",
    "help.mobile.touch": "<strong>Touch:</strong> main buttons are 44px or larger, and auxiliary buttons such as the presets are 24px or larger (WCAG 2.2, 2.5.8)",
    "help.mobile.collapse": "<strong>Collapsible settings:</strong> \"Show/Hide settings\" saves screen space",
    "help.mobile.buttons": "<strong>Button layout:</strong> \"Start recording\" and \"Stop\" appear in the same place, and only the one you can press is shown. On screens 480px wide or narrower, \"Export CSV\" and \"Reset stats\" are grouped under \"More\", and the help and theme buttons sit on the same row. \"More\" also closes with the Esc key",
    "help.mobile.battery": "<strong>Battery:</strong> stop recording when you do not need it, to save battery",
    "help.caution.heading": "⚠️ Important notes",
    "help.caution.noRecording": "<strong>No audio recording:</strong> the audio itself is not saved (level only)",
    "help.caution.env": "<strong>Environment-dependent:</strong> readings vary with the device and environment, so rely on relative changes rather than absolute values",
    "help.caution.purpose": "<strong>Intended use:</strong> this tool is meant as an aid for physical security and acoustic monitoring",
    "help.caution.proof": "<strong>Not proof:</strong> the CSV hash chain is for noticing accidental corruption or loss. It does not withstand intentional changes, so it cannot prove that a record is correct",
    "help.caution.legal": "<strong>Legal considerations:</strong> follow the applicable laws and regulations when you use it. Even a level-only record can be restricted depending on where and why you record",

    // ---- script.js ----
    "controls.hide": "Hide settings",
    "meter.title": "Level meter ({floor} to 0 dBFS)",
    "engine.worklet": "Engine: high-precision mode (AudioWorklet), based on the audio clock",
    "engine.fallback": "Engine: fallback mode (samples may be missing)",
    "status.deviceLost": "The microphone was disconnected. Recording stopped",
    "status.suspended": "Measurement is suspended (screen lock, etc.)",
    "status.resumed": "Measuring (resumed after a suspension)",
    "status.connecting": "Connecting to the microphone…",
    "status.preparing": "Preparing the microphone connection... please wait",
    "status.promptHint": "Please respond to the microphone permission dialog (\"Stop\" cancels)",
    "status.timeout": "Could not get the microphone within {sec} seconds. Respond to the permission dialog, then try again",
    "status.measuring": "Measuring",
    "status.denied": "Microphone access was denied. Check the microphone icon in the browser's address bar",
    "status.notFound": "No microphone was found. Check your device",
    "status.error": "Error: {message}",
    "status.canceled": "Microphone request canceled",
    "status.stopped": "Stopped",
    "status.noLogs": "There is no log to export",
    "status.exported": "Exported the CSV ({count} {count|row|rows})",
    "status.reset": "Statistics, log and graph were reset",
    "status.unsupported": "This browser does not support microphone access",

    // ---- logic.js ----
    "share.tiny": "<0.01%",
    "notice.clip.share": ", {share} of all recorded samples",
    "notice.clip.head": "Clipping in {rows} {rows|interval|intervals} ({samples} {samples|sample|samples} in total{share}). ",
    "notice.clip.sustained": "Some samples hit the limit in a row (longest {run} {run|sample|samples}). The waveform is flattened there, so the value of each affected interval differs from the real sound. ",
    "notice.clip.single": "All were single hits (fewer than {n} samples in a row), so the effect on the interval values is likely small. ",
    "notice.clip.cause": "Causes include touching the microphone, handling noise, wind or breath, or a sound so loud that the wave peaks reach 1.0. In the last case, move the device away from the source",
    "notice.clip.kindSustained": " (sustained)",
    "notice.clip.kindSingle": " (single hits only)",
    "notice.clip.short": "Clipped intervals: {rows}{kind}",
    "notice.valid.short": "Valid sample ratio min {pct}%",
    "notice.valid.full": "The valid sample ratio fell below 1.0 in {rows} {rows|interval|intervals} (min {pct}%). Part of the sound in {rows|that interval|those intervals} did not arrive (kept in the valid_ratio column of the CSV)",
    "notice.valid.missing": ". No sample arrived at all in {missing} {missing|interval|intervals}, so dbfs is empty in the CSV (not silence; left out of the average)",
    "notice.bandValid.short": "Band valid ratio min {pct}%",
    "notice.bandValid.full": "The band valid ratio fell below 1.0 in {rows} {rows|interval|intervals} (min {pct}%). The band values for {rows|that interval|those intervals} leave out part of the time (kept in the band_valid_ratio column of the CSV)",
    "notice.summary": "Recording notes ({count}): {items}",
    "notice.summarySep": " / ",
    "integrity.unknown": "Recording gaps cannot be checked (only {total} fallback-mode {total|interval|intervals}, where neither clipping nor the valid sample ratio is measured)",
    "integrity.clip": "clipping in {rows} {rows|interval|intervals}",
    "integrity.validLow": "valid sample ratio below 1.000 in {rows} {rows|interval|intervals}, min {min}",
    "integrity.validAll": "valid sample ratio 1.000 in {known} of {known} {known|interval|intervals}",
    "integrity.fallbackTail": "; {unknown} fallback-mode {unknown|interval|intervals} not measured",
    "integrity.clean": "No recording gaps",
    "integrity.dirty": "Recording gaps found",
    "integrity.line": "{head} ({clip}; {valid}){tail}",
    "band.range": "{lo}–{hi} kHz",
    "upper.head": "Recordable limit on this device: about {khz} kHz",
    "upper.trackUnknown": "{head} (half of AudioContext {ctx} kHz; track rate unknown)",
    "upper.same": "{head} (half of the {ctx} kHz sample rate)",
    "upper.min": "{head} (half of the smaller of mic {track} kHz and AudioContext {ctx} kHz)",
    "ultra.reason.off": "stopped (?bands=off)",
    "ultra.reason.fallback": "not measured in fallback mode",
    "ultra.reason.noBins": "not measurable at this sample rate",
    "legend.ultra": "Dashed: ultrasonic band ({range})",
    "legend.ultraStopped": "Ultrasonic band ({range}): {reason}",
    "aria.lines.on": "The solid line is the level (full band) and the dashed line is the ultrasonic band ({range})",
    "aria.lines.off": "The solid line is the level (full band). The ultrasonic band ({range}) line is not drawn ({reason})",
    "aria.graph": "Level graph. {lines}. Horizontal axis: the last {sec} seconds; vertical axis: dBFS",
    "ultraNow.headSec": "Ultrasonic band (last {sec} s interval): ",
    "ultraNow.head": "Ultrasonic band (last interval): ",
    "ultraNow.noValue": " (no value for this interval)",
    "bandNotice.below": ". The ultrasonic band ({range}) is above this limit, so its values do not represent ultrasonic sound",
    "bandNotice.mismatch.short": "Sample rate conversion (mic {track} kHz / AudioContext {ctx} kHz)",
    "bandNotice.mismatch.full": "The sample rates of the microphone track ({track} kHz) and the AudioContext ({ctx} kHz) differ. Sample rate conversion records high sounds near the limit lower (the recordable limit on this device is about {limit} kHz)",
    "bandNotice.off.short": "Band computation stopped (?bands=off)",
    "bandNotice.off.full": "Band computation is stopped (?bands=off). The three band columns in the CSV are empty, the ultrasonic band line is not drawn on the graph, and \"Ultrasonic max\" in the statistics stays \"--.-\"",
    "bandNotice.fallback.short": "Bands not computed (fallback mode)",
    "bandNotice.fallback.full": "Fallback mode does not compute bands. The three band columns in the CSV are empty, the ultrasonic band line is not drawn on the graph, and \"Ultrasonic max\" in the statistics stays \"--.-\"",
    "bandNotice.noBins.short": "Ultrasonic band not measurable (sample rate {ctx} kHz)",
    "bandNotice.noBins.full": "The AudioContext sample rate ({ctx} kHz) cannot represent the ultrasonic band ({range}) (its limit is about {half} kHz). band_ultra_dbfs in the CSV is empty, and the ultrasonic band line does not appear on the graph",
    "device.gone": "The audio track is gone",
    "device.lost": "The microphone was disconnected",
    "notice.deviceLoss.short": "{label} (recorded up to row {rows})",
    "notice.deviceLoss.full": "{label}. Recorded up to row {rows} and nothing after that (the log so far can be exported)",
    "notice.muted.short": "Microphone muted",
    "notice.muted.full": "The microphone is muted at the source (for example, by an incoming call). Rows recorded during this time are digital silence",
    "notice.processingActive.short": "Audio processing on ({keys})",
    "notice.processingActive.full": "Audio processing on the microphone side is on ({keys}). The gain changes automatically, so the dBFS values in this record cannot be treated as absolute",
    "notice.processingUnknown.short": "Audio processing state unknown ({keys})",
    "notice.processingUnknown.full": "This browser does not report the state of audio processing on the microphone side ({keys}). Even if the gain changes automatically, this screen and the CSV cannot show it",
    "notice.clock.short": "Clock jumps: {count}",
    "notice.clock.full": "Clock jumps: {count} (total {sec} s). Later times use the reset anchor, and the affected intervals are kept in the CSV meta lines (# clockBreaks / # clockBreakAt / # clockDriftMs)"
  };

  const DICTIONARIES = Object.freeze({ ja: Object.freeze(ja), en: Object.freeze(en) });

  const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

  // 言語の文字列を 'ja' / 'en' にそろえる。それ以外（空・未対応の言語）は null
  function normalizeLang(value) {
    if (typeof value !== 'string') return null;
    const v = value.trim().toLowerCase();
    return LANGS.indexOf(v) >= 0 ? v : null;
  }

  // 辞書を引いて、{name} を置き換える。
  // ⚠ 知らない言語・知らないキー・足りない引数は例外にする（黙って空文字や日本語を出さない）
  function t(lang, key, params) {
    if (!hasOwn(DICTIONARIES, lang)) throw new RangeError(`Unknown language: ${lang}`);
    const dict = DICTIONARIES[lang];
    if (!hasOwn(dict, key)) throw new Error(`Unknown message: ${key}`);
    const p = params || {};
    return dict[key].replace(/\{(\w+)(?:\|([^|{}]*)\|([^|{}]*))?\}/g, (_, name, one, other) => {
      if (!hasOwn(p, name)) throw new Error(`Missing parameter: ${name} (${key})`);
      if (one !== undefined) return Number(p[name]) === 1 ? one : other;
      return String(p[name]);
    });
  }

  // 値に出てくる引数の名前（重複なし・並べ替え済み）。日英で同じかをテストが見る
  function placeholderNames(text) {
    const names = new Set();
    for (const m of String(text).matchAll(/\{(\w+)(?:\|[^|{}]*\|[^|{}]*)?\}/g)) names.add(m[1]);
    return [...names].sort();
  }

  // ---- 言語の決め方（TEMPLATE ④）----
  // 初期言語は ?lang=ja|en → 保存した選択 → ブラウザーの言語（navigator.languages の先頭が日本語なら日本語、それ以外は英語）。
  // 材料は script.js が集めて渡す（ここでは location・localStorage・navigator を読まない）。
  //   search     location.search（?lang= を見る。大文字・前後の空白は許す。ja・en 以外は無視して次へ）
  //   saved      localStorage に保存した値（読めなかったら null。ja・en 以外は無視して次へ）
  //   languages  navigator.languages（無ければ [navigator.language]）
  function langFromQuery(search) {
    try {
      return normalizeLang(new URLSearchParams(typeof search === 'string' ? search : '').get('lang'));
    } catch (e) {
      return null;
    }
  }

  // ブラウザーの言語の先頭が日本語（ja・ja-JP など）なら 'ja'、それ以外（空も含む）は 'en'
  function langFromNavigator(languages) {
    const list = Array.isArray(languages) ? languages : (typeof languages === 'string' ? [languages] : []);
    const first = list.find(v => typeof v === 'string' && v.trim() !== '');
    return (first && /^ja(?:[-_]|$)/i.test(first.trim())) ? 'ja' : 'en';
  }

  function initialLang(input) {
    const src = input || {};
    return langFromQuery(src.search) || normalizeLang(src.saved) || langFromNavigator(src.languages);
  }

  // 言語を切り替えたときの URL の検索部。?lang= が付いていれば新しい言語に書き換え、付いていなければそのまま返す
  // （?lang= が残っていると、再読み込みで切り替えが戻るため。?bands=off などほかの値は変えない）
  function searchWithLang(search, lang) {
    const s = typeof search === 'string' ? search : '';
    let params;
    try {
      params = new URLSearchParams(s);
    } catch (e) {
      return s;
    }
    if (!params.has('lang')) return s;
    params.set('lang', lang);
    return '?' + params.toString();
  }

  // ---- data-i18n-rich の値 ----
  // <strong>・<code>・<em> だけを認め、[{ tag: null|'strong'|'code'|'em', text }] に分ける。
  // 入れ子・閉じ忘れ・知らないタグ（< や > が残る）は例外にする（script.js は結果から要素を作るだけ）
  function richSegments(text) {
    const src = String(text);
    const out = [];
    const re = /<(\/?)(strong|code|em)>/g;
    let pos = 0;
    let open = null;
    let m;
    while ((m = re.exec(src)) !== null) {
      const chunk = src.slice(pos, m.index);
      if (chunk) out.push({ tag: open, text: chunk });
      if (m[1]) {
        if (open !== m[2]) throw new Error(`Unbalanced </${m[2]}> in: ${src}`);
        open = null;
      } else {
        if (open) throw new Error(`Nested <${m[2]}> in: ${src}`);
        open = m[2];
      }
      pos = re.lastIndex;
    }
    if (open) throw new Error(`Unclosed <${open}> in: ${src}`);
    const rest = src.slice(pos);
    if (rest) out.push({ tag: null, text: rest });
    for (const seg of out) {
      if (/[<>]/.test(seg.text)) throw new Error(`Unknown markup in: ${src}`);
    }
    return out;
  }

  // data-i18n-rich の値の文字だけ（タグを除いたもの）
  function richPlainText(text) {
    return richSegments(text).map(s => s.text).join('');
  }

  return {
    LANGS,
    DEFAULT_LANG,
    LANG_STORAGE_KEY,
    I18N_ATTRS,
    RICH_TAGS,
    DICTIONARIES,
    normalizeLang,
    t,
    placeholderNames,
    langFromQuery,
    langFromNavigator,
    initialLang,
    searchWithLang,
    richSegments,
    richPlainText
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = MicGainMessages;
}
