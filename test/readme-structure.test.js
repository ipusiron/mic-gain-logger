'use strict';

// READMEの構成と活用例（第2弾c1）。
//
// 「生成AIで作るセキュリティツール100」のシリーズ標準の構成に合わせた。前半は H1・バッジ5種・Day行・概要・デモページ・
// スクリーンショット、後半は「📁 ディレクトリー構造 → 💻 動作環境 → 📄 ライセンス → 🛠️ このツールについて」の固定順で、
// その前に「🧪 テスト」を置く。中間の節はツールごとに増えるので、順は前半と後半だけを見る。
// 活用例（本人の指示 2026-09-29。全Dayの必須項目）は「🎯 ユースケース」の中の「🧭 活用例」に置いた。
// 平時との比較（本人の指摘）・音の方向探知（本人の発案）・エアギャップの監査（本人の質問）は必ず入れ、
// 限界のある用途は同じ項目に限界を添える（24kHzより上は記録できない、何の音か区別できない、
// 2台の端末のdBFSは比べられない、方向はマイク1本では分からない、など）。
// 画面の大きな数字とCSVのdbfsの違い（第2弾c0で1〜2文を足した）は、技術的な基礎知識の節に例を添えて書いた。
// この段階で足した節には、使わないと決めた語と、英字と日本語のあいだの半角空白が無いことも見る。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { METER_WINDOW_SAMPLES } = require('../logic.js');

const root = path.join(__dirname, '..');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const lines = readme.split('\n');

// コードブロックの外の行だけ（コードの `#` 行やCSVの見本を見出しと取り違えないため）
function outsideFences(text) {
  let fence = false;
  return text.split('\n').filter(l => {
    if (/^\s*```/.test(l)) { fence = !fence; return false; }
    return !fence;
  });
}

function section(head) {
  const start = lines.indexOf(head);
  assert.notEqual(start, -1, `見出しが無い: ${head}`);
  const level = head.match(/^#+/)[0].length;
  let fence = false;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { fence = !fence; continue; }
    if (fence) continue;
    const m = lines[i].match(/^(#+) /);
    if (m && m[1].length <= level) return lines.slice(start, i).join('\n');
  }
  return lines.slice(start).join('\n');
}

const h2 = outsideFences(readme).filter(l => l.startsWith('## '));

// ---- シリーズ標準の構成 ----

test('前半が、H1・バッジ5種・Day行・デモページ・スクリーンショットの順になっている', () => {
  assert.ok(lines.includes('# Mic Gain Logger - マイク音量ロガー'), 'H1 が「ToolName - 日本語の説明」の形でない');
  const h1At = lines.indexOf('# Mic Gain Logger - マイク音量ロガー');
  const badges = lines.slice(h1At, h1At + 8).filter(l => /img\.shields\.io/.test(l));
  assert.equal(badges.length, 5, 'バッジが5種ない');
  for (const k of ['stars', 'forks', 'last-commit', 'license', 'GitHub%20Pages']) {
    assert.ok(badges.some(b => b.includes(k)), `バッジ ${k} が無い`);
  }
  assert.ok(readme.includes('**Day041 - 生成AIで作るセキュリティツール100**'));
  assert.deepEqual(h2.slice(0, 2), ['## 🌐 デモページ', '## 📸 スクリーンショット']);
});

test('後半が、テスト → ディレクトリー構造 → 動作環境 → ライセンス → このツールについて の順になっている', () => {
  assert.deepEqual(h2.slice(-5), [
    '## 🧪 テスト',
    '## 📁 ディレクトリー構造',
    '## 💻 動作環境',
    '## 📄 ライセンス',
    '## 🛠️ このツールについて'
  ]);
  const about = section('## 🛠️ このツールについて');
  assert.ok(about.includes('「生成AIで作るセキュリティツール100」'));
  assert.ok(about.includes('https://akademeia.info/?page_id=42163'), 'Day001〜100 のリンクでない');
});

test('中間の見出しに、主な機能・実機テスト・ユースケースがある（見出しの名前を変えたら相互参照も直す）', () => {
  for (const h of ['## ✨ 主な機能', '## 📱 実機テスト（iPhone 18 Pro Max）', '## 🎯 ユースケース', '## 📊 CSVデータの活用方法']) {
    assert.ok(h2.includes(h), `見出しが無い: ${h}`);
  }
  assert.ok(!h2.includes('## 🎯 主な機能'), '主な機能の絵文字がユースケースと重なっている');
  assert.ok(!h2.includes('## 📂 ディレクトリー構成'), '旧い見出し（ディレクトリー構成）が残っている');
  // ユースケースの中に、想定ターゲット層・想定する使い方・規制値・活用例・シナリオ例がそろっている
  const usecase = section('## 🎯 ユースケース');
  for (const h of ['### 👥 想定ターゲット層', '### 🎯 想定する使い方', '### 🚫 規制値・基準値とは比較できない',
    '### 🧭 活用例', '### 📋 具体的なシナリオ例']) {
    assert.ok(usecase.includes('\n' + h), `ユースケースに ${h} が無い`);
  }
});

test('テストの節が、npm test・Node 22以上・依存なし・GitHub Actions・READMEの表の検証を書いている', () => {
  const t = section('## 🧪 テスト');
  for (const s of ['npm test', 'Node.js 22以上', '依存パッケージはなく', 'GitHub Actions', 'READMEの表と数値も確かめる']) {
    assert.ok(t.includes(s), `テストの節に「${s}」が無い`);
  }
  // 名前を挙げたテストファイルが実在する
  for (const m of t.matchAll(/`(test\/[\w.-]+\.test\.js)`/g)) {
    assert.ok(fs.existsSync(path.join(root, m[1])), `実在しないテストを挙げている: ${m[1]}`);
  }
});

test('フロントマターの説明とタグが、第2弾の帯域の記録に合っている', () => {
  const fm = readme.match(/^<!--\n---\n([\s\S]*?)\n---\n-->/)[1];
  assert.match(fm, /^description_ja: "[^"]*18〜22kHz[^"]*"$/m);
  assert.match(fm, /^description_en: "[^"]*18-22 kHz[^"]*"$/m);
  assert.match(fm, /何の音かは判別しない/);
  // タグはブロック形式（「  - 」）のまま
  const tags = fm.slice(fm.indexOf('tags:\n') + 6).split('\n').filter(l => l.startsWith('  - ')).map(l => l.slice(4));
  for (const t of ['ultrasonic', 'fft', 'dbfs', 'csv-export']) assert.ok(tags.includes(t), `タグ ${t} が無い`);
  // 変えてはいけない値
  for (const s of ['id: day041', 'slug: mic-gain-logger', 'repo_url: "https://github.com/ipusiron/mic-gain-logger"',
    'demo_url: "https://ipusiron.github.io/mic-gain-logger/"', 'hub: true']) {
    assert.ok(fm.includes('\n' + s + '\n') || fm.startsWith(s + '\n') || fm.endsWith('\n' + s), `フロントマターの ${s} が変わっている`);
  }
});

// ---- 活用例 ----

const USES = section('### 🧭 活用例（暮らし・教育・仕事・趣味・研究）');
const items = outsideFences(USES).filter(l => l.startsWith('- **'));
const item = label => {
  const found = items.filter(l => l.startsWith('- **' + label));
  assert.equal(found.length, 1, `活用例に「${label}」の項目が1つない`);
  return found[0];
};

test('活用例が、教育・仕事・暮らし・趣味・研究・ほかのツールとの組み合わせまで広がっている', () => {
  const groups = outsideFences(USES).filter(l => l.startsWith('#### '));
  for (const g of ['平時', '暮らし', '教育', '仕事', '趣味', '研究', 'ほかのツールや記事との組み合わせ']) {
    assert.ok(groups.some(h => h.includes(g)), `活用例の小見出しに「${g}」が無い`);
  }
  assert.ok(items.length >= 18, `活用例の項目が少ない（${items.length}）`);
  // 1項目＝「何をして、何が分かるか」。名前だけの行にしない
  for (const l of items) assert.ok(l.length > 60, `説明の短い項目がある: ${l}`);
});

// 項目の本文（ラベルのあと、最初の⚠より前）。括弧の中は数えない
function itemBody(l) {
  let s = l.slice(l.indexOf('**：') + 2);
  if (s.includes('⚠')) s = s.slice(0, s.indexOf('⚠'));
  for (let prev = null; prev !== s;) { prev = s; s = s.replace(/（[^（）]*）/g, ''); }
  return s;
}

test('活用例の各項目が「誰が・何をして・何が分かるか」を1〜2文で書いている（TEMPLATEの⑤）', () => {
  // 第2弾c1の点検で、主語の無い項目（平時との比較など4項目）と、⚠より前が3〜4文の項目（方向探知など）を指摘された。
  // 限界の注記（⚠）は数に入れない
  for (const l of items) {
    const body = itemBody(l);
    const first = body.split('。')[0];
    assert.match(first, /(人|者|担当|教員|飼い主|どうし)が/, `最初の文に「誰が」が無い: ${l.slice(0, 40)}`);
    const n = body.split('。').filter(x => x.trim()).length;
    assert.ok(n >= 1 && n <= 2, `⚠より前が${n}文ある: ${l.slice(0, 40)}`);
  }
});

test('活用例に、平時との比較・方向探知・エアギャップの監査が、限界の注記つきで入っている', () => {
  const normal = item('平時との比較');
  // 約3.8dBは、実機テストのcompare.pyの出力（dbfsの中央値の差+3.78）。第2弾c1の点検まで「約4dB」と書いていた
  for (const s of ['同じ端末・同じ置き場所・同じログ間隔', '約3.8dB', '何の音かは分からない',
    '自動ゲイン調整（AGC）が切れていたかを報告しない']) {
    assert.ok(normal.includes(s), `平時との比較に「${s}」が無い`);
  }
  assert.ok(readme.includes('差 +3.78 dB'), '平時との比較の約3.8dBの出どころ（compare.pyの出力）が無い');
  // 超音波帯を平時と比べるのは compare.py＋over.py。ultra_only.py は平時の記録を読まない（第2弾c1の点検で直した）
  const ultraNormal = item('超音波帯の平時との比較');
  assert.ok(ultraNormal.includes('`compare.py`') && ultraNormal.includes('`over.py`'));
  assert.ok(!ultraNormal.includes('ultra_only'), 'ultra_only.py を平時との比較に挙げている');
  const dir = item('音の方向探知');
  for (const s of ['2地点', '交点', 'マイク1本では方向は分からない', '2台の端末のdBFSは比べられない', 'TDOA', '反射']) {
    assert.ok(dir.includes(s), `方向探知に「${s}」が無い`);
  }
  const air = item('エアギャップの監査');
  for (const s of ['許可を得た', '識別も、中身の解読もできない', '正規の機器', '24kHzより上', '音以外の経路',
    '平時の記録と比べて', '22kHzを超える音（24kHzまで）は帯域の列にほとんど入らず', '高精度モード（AudioWorklet）で動いているあいだは',
    '`# clockBreakAt=`', '簡易モード（`# engine=fallback`）では帯域の値が残らない', '画面ロック中・バックグラウンドは確かめていない']) {
    assert.ok(air.includes(s), `エアギャップの監査に「${s}」が無い`);
  }
  // 条件をつけずに「穴なく」「必ず1行残り」と言い切らない（簡易モード・画面ロック中は別）
  assert.ok(!air.includes('穴なく') && !air.includes('必ず1行'), 'エアギャップの監査で記録の連続を言い切っている');
});

test('24kHzより上の音を「どの列にも残らない」と言い切らない（折り返しの可能性を書く）', () => {
  // 第2弾c1の点検で、変換器のフィルターが落としきれなかったぶんは折り返して記録に入りうる、と指摘された。実機では測っていない
  assert.ok(!USES.includes('どの列にも残りません'));
  assert.ok(USES.includes('その周波数として記録できません'));
  assert.ok(USES.includes('24kHzより下の別の周波数に折り返して記録に入ることがあります（実機では確かめていません）'));
  assert.ok(!/コウモリ[^。]*記録に残らない/.test(USES), 'コウモリの声を「記録に残らない」と言い切っている');
});

test('シナリオ1（探偵の調査）は残し、作者の意図は「悪用を勧めない」とだけ書く（用途と限界を狭めない）', () => {
  // 本人の判断（2026-09-29）：「あくまで道具の使える例であり、それが好ましくないかどうかは国や人それぞれ。
  // 法律面でも同様。悪用を推奨しないとしてだけ作者の意図を伝えつつ、ツールの用途や限界を狭めないようにする」。
  // 第2弾c1の点検のあとで一時的に入れていた、法令を並べた「前提」の段落と、活用例を「自分の場所・関係者が知っている場所」に
  // 限る書き方をやめた
  const sc = section('### 📋 具体的なシナリオ例');
  const s1 = sc.slice(sc.indexOf('#### シナリオ1'), sc.indexOf('#### シナリオ2'));
  assert.ok(s1.includes('探偵'), 'シナリオ1（第1弾からある例）が無い');
  for (const s of ['**作者の意図**：', '作者は悪用を勧めません', '国・地域の法令や状況によって異なります']) {
    assert.ok(s1.includes(s), `シナリオ1に「${s}」が無い`);
  }
  assert.ok(!s1.includes('**前提**：'), 'シナリオ1に、用途を狭める前提の段落が残っている');
  assert.ok(USES.includes('作者は悪用を勧めません'));
  assert.ok(!USES.includes('関係者が知っている場所で使うもので'), '活用例を、関係者が知っている場所に限っている');
  assert.ok(!USES.includes('研究室での再現に限る'), 'エアギャップの監査を、研究室での再現に限っている');
});

test('『エアギャップ・ブリッジ』2冊と、送る側のデモを組み合わせの項目に書いている（本人の判断＝いま名前を出す）', () => {
  const book = item('『エアギャップ・ブリッジ』との組み合わせ');
  for (const s of ['『エアギャップ・ブリッジ　隔離環境のデータ入力技法』', '『エアギャップ・ブリッジ　隔離環境のデータ出力技法』',
    'ミライ・ハッキング・ラボ', '技術書典21', '頒布予定', '超音波データ送受信デモ', '中身を読まない']) {
    assert.ok(book.includes(s), `本の組み合わせの項目に「${s}」が無い`);
  }
});

test('限界のある活用例に、同じ項目で限界を添えている', () => {
  assert.match(item('身の回りの機器の高い音'), /24kHzより上[\s\S]{0,40}その周波数としては記録に残らない/);
  assert.match(item('ペットの留守番'), /何の音かは区別できない/);
  assert.match(item('鳥が鳴き始める時刻'), /種の識別はできない/);
  assert.match(item('鳥が鳴き始める時刻'), /コウモリ/);
  assert.match(item('聴力の気づき'), /聴力の検査ではない/);
  assert.match(item('dBFSとdB SPLの違い'), /別のdBFSが出る/);
  // 超音波加湿器（1MHz以上の振動）は範囲の外なので例に挙げない（第2弾の設計で渚が誤って挙げていた）
  assert.ok(!USES.includes('加湿器'), '範囲外の超音波加湿器を例に挙げている');
  // 前提（相対値・何の音かは分からない・証明に使えない・作者は悪用を勧めない）を冒頭に置いている
  for (const s of ['規制値・基準値とは比べられない', '何の音かは分からない', '証明に使えない', '作者は悪用を勧めません']) {
    assert.ok(USES.includes(s), `活用例の前提に「${s}」が無い`);
  }
});

// ---- 画面の大きな数字とCSVの値の違い ----

test('画面の大きな数字とCSVのdbfsの違いを、計算した例と簡易モードの条件つきで書いている', () => {
  const w = section('### 画面の大きな数字とCSVの`dbfs`の違い');
  assert.ok(w.includes(`直近${METER_WINDOW_SAMPLES}サンプル`), '窓のサンプル数が定数と合わない');
  // 例：1秒の区間のうち0.1秒が-50dBFS、0.9秒が-80dBFS
  const leq = 10 * Math.log10(0.1 * 10 ** (-50 / 10) + 0.9 * 10 ** (-80 / 10));
  assert.ok(w.includes(`＝${leq.toFixed(2)}dBFS`), `例のLeq（${leq.toFixed(2)}）が本文と合わない`);
  assert.equal(Math.round(-80 - leq), -20);
  assert.ok(w.includes('約20dB低い値を読む'));
  assert.ok(w.includes('低く見える時間が長く'));
  assert.ok(w.includes('簡易モードでは、この違いはありません'));
});

// ---- この段階で足した節の文言 ----

const NEW_SECTIONS = [
  '## 📱 実機テスト（iPhone 18 Pro Max）',
  '### 🧭 活用例（暮らし・教育・仕事・趣味・研究）',
  '### 画面の大きな数字とCSVの`dbfs`の違い',
  '### 第2弾で入れたもの',
  '### 第3弾の案',
  '### 加工する前に確かめること',
  '### 時刻を日本時間へ直す',
  '### コマンドラインで表だけにする',
  '### Pythonのレシピ（標準ライブラリーだけ）',
  '### 複数のCSVをつなぐ',
  '### 2台の端末の記録を並べる',
  '## 🧪 テスト',
  '## 💻 動作環境'
];
const prose = () => NEW_SECTIONS.flatMap(h => outsideFences(section(h)).map(l => [h, l]));

test('この段階で足した節が、使わないと決めた語を含まない', () => {
  const BANNED = ['効く', '効い', '効か', '効き', '効け', '効こ', '走る', '走ら', '走り', '走っ', '走れ', '照合', '突き合わせ', '断定', '踏み込',
    '構図', '落とし穴', '破綻', '潰す', '潰し', '正直に', '結論から言うと', '持ち帰れ', '既定で', '全て', '既に'];
  for (const [h, l] of prose()) {
    for (const w of BANNED) assert.ok(!l.includes(w), `${h} に「${w}」がある: ${l}`);
    assert.ok(!/てみ[るたてよま]/.test(l), `${h} に「〜てみる」がある: ${l}`);
    // 第2弾で入れたものの競合の表は、第1弾からの文をそのまま残している
    if (h !== '### 第2弾で入れたもの') assert.ok(!l.includes('無い'), `${h} に「無い」がある（「ない」と書く）: ${l}`);
  }
});

test('この段階で足した節で、英字と日本語のあいだに半角空白を入れていない', () => {
  const JA = '[ぁ-ゖァ-ヺー一-龯々〆（）「」、。・]';
  const bad = new RegExp(`${JA} [A-Za-z0-9\`?#]|[A-Za-z0-9\`] ${JA}`);
  for (const [h, l] of prose()) {
    if (h === '### 第2弾で入れたもの' && l.startsWith('|')) continue;   // 競合の表は第1弾からの文
    assert.ok(!bad.test(l), `${h} に英字と日本語のあいだの半角空白がある: ${l}`);
  }
});
