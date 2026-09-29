'use strict';

// READMEとdocs/の分け方（第2弾c1b）。
//
// READMEが1,700行を超え、強調（**）も300か所を超えたので、本人の決定でREADMEを入口にし、詳しい説明をdocs/へ分けた。
// ここでは分け方の約束を見る。
//  - README.mdは入口として450行以下に収める
//  - docs/のファイル名は英語の小文字とハイフン。1行目がH1で、READMEへ戻るリンクを置く
//  - docs/の全ファイルを、READMEの「📚 資料（docs/）」の表とディレクトリー構造に1行ずつ載せる
//  - 相互参照は「[CSVの資料](docs/csv.md)の「見出しの名前」」の形で書き、行き先のファイルと見出し（または項目名）が実在する。
//    同じファイルの中の「前述の「…」」「後述の「…」」は、そのファイルの見出しか項目名を指す（ほかのファイルを前述・後述で指さない）
//  - 強調（**…**）は、H1〜H3の見出しで区切った節ごとに2か所以下（箇条書きの先頭の項目名と、表の見出しの行は数えない）
//  - 過去の版との違い（「改修前は」「以前は」「初期の実装では」など）を書かない（本人の指示 2026-09-29「過去の版をわざわざ
//    見る人はいないので、訂正の差異の説明は不要。今の版で正しいことを書けば良いだけ」）。経緯はCLAUDE.mdに置く
// 第2弾c3bで英語版（README.en.mdとdocs/en/、同じファイル名）を足したので、分け方の約束を英語版にも広げた。
//  - README.en.mdも入口として450行以下に収める
//  - docs/en/のファイルはdocs/と同じ名前。1行目がH1で、英語のREADMEへ戻るリンクを置く。docs/の各ファイルは英語版へのリンクを置く
//  - docs/en/の全ファイルを、README.en.mdの「📚 Documents (docs/en/)」の表に1行ずつ載せ、両方のREADMEのディレクトリー構造にも載せる
// 英語版の中身（見出しの対応・表の数値・日本語の文字・リンク・相互参照・コード・強調・過去の版・用語）は test/readme-en.test.js が見る。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const DOCS = path.join(root, 'docs');

const README_MAX_LINES = 450;
const EMPHASIS_MAX = 2;

const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const readmeEn = fs.readFileSync(path.join(root, 'README.en.md'), 'utf8');
const docNames = fs.readdirSync(DOCS, { withFileTypes: true })
  .filter(e => e.isFile())
  .map(e => e.name)
  .sort();
const DOCS_EN = path.join(DOCS, 'en');
// 読むファイル（リポジトリーからの相対パス → 中身）
const FILES = { 'README.md': readme };
for (const n of docNames) FILES['docs/' + n] = fs.readFileSync(path.join(DOCS, n), 'utf8');

// ---- 読み取りの道具 ----

// コードブロックの外の行だけ。見本CSVやPythonのコメントの `#` 行を見出しと取り違えない
function outsideFences(text) {
  let fence = false;
  return text.split('\n').filter(l => {
    if (/^\s*```/.test(l)) { fence = !fence; return false; }
    return !fence;
  });
}

// H1〜H3の見出しで区切った節。表の見出しの行（次の行が区切りの行）は除く
function sections(text) {
  const out = [];
  let cur = { head: '(先頭)', lines: [] };
  let fence = false;
  const lines = text.split('\n');
  lines.forEach((l, i) => {
    if (/^\s*```/.test(l)) { fence = !fence; return; }
    if (fence) return;
    if (/^#{1,3} /.test(l)) { out.push(cur); cur = { head: l, lines: [] }; return; }
    if (l.trimStart().startsWith('|') && /^\s*\|\s*:?-+/.test(lines[i + 1] || '')) return;
    cur.lines.push(l);
  });
  out.push(cur);
  return out;
}

// 箇条書き（番号付きを含む）の先頭の項目名。「- **名前**：」と「- **名前**」＋改行
const LEAD = /^(\s*(?:[-*]|\d+\.)\s+)\*\*[^*]+\*\*(?=：|\s*$)/;

function emphasisIn(line) {
  const s = line.replace(LEAD, '$1').replace(/`[^`]*`/g, '');
  return Math.floor((s.match(/\*\*/g) || []).length / 2);
}

// 見出しの文字（#を除く）と、強調した項目名。参照の行き先の候補
function targetsOf(text) {
  const lines = outsideFences(text);
  const heads = lines.filter(l => /^#{1,6} /.test(l)).map(l => l.replace(/^#+ /, ''));
  const labels = [];
  for (const l of lines) for (const m of l.matchAll(/\*\*([^*]+)\*\*/g)) labels.push(m[1]);
  return [...heads, ...labels];
}
const pointsTo = (text, name) => targetsOf(text).some(t => t.includes(name));

const fileDir = rel => path.dirname(path.join(root, rel));

// ---- 入口の長さ ----

test(`README.mdとREADME.en.mdは入口として${README_MAX_LINES}行以下に収まっている`, () => {
  for (const [name, text] of [['README.md', readme], ['README.en.md', readmeEn]]) {
    const n = text.split('\n').length;
    assert.ok(n <= README_MAX_LINES, `${name}が${n}行ある（${README_MAX_LINES}行以下にする。長くなった説明はdocs/・docs/en/へ）`);
  }
});

// ---- docs/ の形 ----

test('docs/のファイル名は英語の小文字とハイフンで、1行目がH1、その下にREADMEへ戻るリンクがある', () => {
  assert.ok(docNames.length >= 5, `docs/のファイルが少ない（${docNames.length}）`);
  for (const n of docNames) {
    assert.match(n, /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/, `docs/のファイル名が英語の小文字とハイフンでない: ${n}`);
    const lines = FILES['docs/' + n].split('\n');
    assert.match(lines[0], /^# \S/, `docs/${n}の1行目がH1でない`);
    assert.ok(lines.slice(1, 5).some(l => l.includes('](../README.md)')), `docs/${n}の先頭にREADMEへ戻るリンクがない`);
    // H1は1つだけ（見出しの階層を README と同じ考え方にそろえる）
    assert.equal(outsideFences(FILES['docs/' + n]).filter(l => /^# /.test(l)).length, 1, `docs/${n}にH1が2つ以上ある`);
  }
  // docs/ の中はMarkdownと、英語版の docs/en/ だけ
  for (const e of fs.readdirSync(DOCS, { withFileTypes: true })) {
    if (e.isDirectory()) assert.equal(e.name, 'en', `docs/に想定していないディレクトリーがある: ${e.name}`);
    else assert.ok(e.name.endsWith('.md'), `docs/にMarkdown以外のファイルがある: ${e.name}`);
  }
});

test('docs/en/にはdocs/と同じ名前の英語版だけがあり、1行目がH1、その下に英語のREADMEへ戻るリンクがある', () => {
  const entries = fs.readdirSync(DOCS_EN, { withFileTypes: true });
  for (const e of entries) assert.ok(e.isFile() && e.name.endsWith('.md'), `docs/en/にMarkdown以外がある: ${e.name}`);
  assert.deepEqual(entries.map(e => e.name).sort(), docNames, 'docs/en/のファイル名がdocs/と食い違う');
  for (const n of docNames) {
    const en = fs.readFileSync(path.join(DOCS_EN, n), 'utf8');
    const lines = en.split('\n');
    assert.match(lines[0], /^# \S/, `docs/en/${n}の1行目がH1でない`);
    assert.ok(lines.slice(1, 5).some(l => l.includes('](../../README.en.md)')), `docs/en/${n}の先頭に英語のREADMEへ戻るリンクがない`);
    assert.equal(outsideFences(en).filter(l => /^# /.test(l)).length, 1, `docs/en/${n}にH1が2つ以上ある`);
    // 日本語版の先頭には、同じ名前の英語版へのリンクがある
    assert.ok(FILES['docs/' + n].split('\n').slice(1, 5).some(l => l.includes(`](en/${n})`)), `docs/${n}の先頭に英語版へのリンクがない`);
  }
});

// READMEの資料の案内の表（「| [docs/x.md](docs/x.md) | 説明 |」の行）に載っているファイル名
function docTable(text, heading, dir) {
  const lines = text.split('\n');
  const head = lines.indexOf(heading);
  assert.notEqual(head, -1, `「${heading}」がない`);
  const rows = [];
  for (const l of lines.slice(head + 1)) {
    if (/^## /.test(l)) break;
    if (l.startsWith('| [')) rows.push(l);
  }
  const d = dir.replace(/\//g, '\\/');
  return rows.map(r => {
    const m = r.match(new RegExp(`^\\| \\[${d}([^\\]]+)\\]\\(${d}([^)]+)\\) \\| (.+) \\|$`));
    assert.ok(m, `案内の表の行が読めない: ${r}`);
    assert.equal(m[1], m[2], `案内の表のリンクの文字と行き先が違う: ${r}`);
    assert.ok(m[3].trim().length >= 5, `案内の表の説明が短い: ${r}`);
    return m[1];
  });
}

test('docs/の全ファイルが、READMEの「📚 資料（docs/）」の表とディレクトリー構造に1行ずつ載っている', () => {
  assert.deepEqual([...docTable(readme, '## 📚 資料（docs/）', 'docs/')].sort(), docNames, '案内の表とdocs/の実ファイルが食い違う');
  // ディレクトリー構造（test/docs.test.js が全行の説明と実ファイルとの一致を見ている）にも載っている
  const tree = readme.slice(readme.indexOf('## 📁 ディレクトリー構造'));
  assert.match(tree, /\n├── docs\/\s+# \S/, 'ディレクトリー構造にdocs/の行がない');
  for (const n of docNames) {
    assert.ok(new RegExp(`\\n│   [├└]── ${n.replace('.', '\\.')}\\s+# \\S`).test(tree), `ディレクトリー構造にdocs/${n}の行がない`);
  }
});

test('docs/en/の全ファイルが、README.en.mdの「📚 Documents (docs/en/)」の表と、両方のREADMEのディレクトリー構造に1行ずつ載っている', () => {
  assert.deepEqual([...docTable(readmeEn, '## 📚 Documents (docs/en/)', 'docs/en/')].sort(), docNames,
    'README.en.mdの案内の表とdocs/en/の実ファイルが食い違う');
  // 日本語版の表には日本語の資料だけを載せる（英語版は README.en.md から案内する）
  assert.ok(!docTable(readme, '## 📚 資料（docs/）', 'docs/').some(n => n.startsWith('en/')), 'README.mdの表に英語版が載っている');
  for (const [name, text, head] of [['README.md', readme, '## 📁 ディレクトリー構造'], ['README.en.md', readmeEn, '## 📁 Directory structure']]) {
    const tree = text.slice(text.indexOf(head));
    assert.match(tree, /\n├── README\.en\.md\s+# \S/, `${name}のディレクトリー構造にREADME.en.mdの行がない`);
    assert.match(tree, /\n│   ├── en\/\s+# \S/, `${name}のディレクトリー構造にdocs/en/の行がない`);
    for (const n of docNames) {
      assert.ok(new RegExp(`\\n│   │   [├└]── ${n.replace('.', '\\.')}\\s+# \\S`).test(tree), `${name}のディレクトリー構造にdocs/en/${n}の行がない`);
    }
  }
});

// ---- 相互参照 ----

test('READMEとdocs/の相対リンクの行き先が実在する', () => {
  let n = 0;
  for (const [rel, text] of Object.entries(FILES)) {
    const body = outsideFences(text).join('\n');
    const targets = [
      ...[...body.matchAll(/\]\(([^)\s]+)\)/g)].map(m => m[1]),
      ...[...body.matchAll(/(?:href|src)="([^"]+)"/g)].map(m => m[1])
    ];
    for (const t of targets) {
      if (/^(https?:|mailto:|#)/.test(t)) continue;
      const file = t.split('#')[0];
      n++;
      assert.ok(fs.existsSync(path.join(fileDir(rel), file)), `${rel} のリンクの行き先がない: ${t}`);
    }
  }
  assert.ok(n >= 20, `相対リンクが少ない（${n}）`);
});

test('ファイルをまたぐ参照「[…](ファイル)の「名前」」が、行き先のファイルの見出しか項目名を指している', () => {
  let n = 0;
  for (const [rel, text] of Object.entries(FILES)) {
    for (const m of outsideFences(text).join('\n').matchAll(/\]\(([^)\s#]+\.md)(?:#[^)]*)?\)の「([^」]+)」/g)) {
      const target = path.relative(root, path.join(fileDir(rel), m[1])).split(path.sep).join('/');
      assert.ok(FILES[target] !== undefined, `${rel} の参照先のファイルがない: ${m[1]}`);
      assert.ok(pointsTo(FILES[target], m[2]), `${rel} の参照「${m[2]}」が ${target} の見出しにも項目名にもない`);
      n++;
    }
  }
  assert.ok(n >= 20, `ファイルをまたぐ参照が少ない（${n}）`);
});

test('リンクの無い「「…」を参照／にあります／の節／の項」は、同じファイルの見出しか項目名を指している', () => {
  // 第2弾c1bの点検で、リンクなしで別のファイルの見出しを指しても落ちないと指摘された。
  // 「`logic.js`の「統計」の節」のような、同じ行でJSファイルの名前のあとに続くコードの節名は、資料の見出しではないので外す
  const REF = /「([^「」\n]+)」(を参照|にあります|にある|の節|の項)/g;
  const refsIn = text => {
    const out = [];
    for (const line of outsideFences(text)) {
      for (const m of line.matchAll(REF)) {
        const before = line.slice(0, m.index);
        if (/\)の$/.test(before) || /(前述|後述)の$/.test(before)) continue;   // ほかのテストで見る形
        if (m[2] === 'の節' && /`[^`]+\.js`/.test(before)) continue;           // コードの節名
        out.push(m[1]);
      }
    }
    return out;
  };
  for (const [rel, text] of Object.entries(FILES)) {
    for (const name of refsIn(text)) {
      assert.ok(pointsTo(text, name), `${rel} の「${name}」が同じファイルにない（ほかのファイルなら[…](ファイル)の「…」で書く）`);
    }
    // リンクの無い「READMEの「…」」「〇〇の資料の「…」」を書かない（[README](../README.md)の「…」の形にする）
    const bare = outsideFences(text).join('\n').match(/(README|資料)の「/);
    assert.equal(bare, null, `${rel} にリンクの無い「${bare && bare[0]}」がある`);
  }
  // 見つけ方の確かめ：READMEに無い見出しを、リンクなしで指したら見つかる。コードの節名は拾わない
  assert.deepEqual(refsIn('詳しくは「ハッシュチェーンで何が分かるか」を参照してください。'), ['ハッシュチェーンで何が分かるか']);
  assert.ok(!pointsTo(readme, 'ハッシュチェーンで何が分かるか'), '前提：READMEにハッシュチェーンの見出しがある');
  assert.deepEqual(refsIn('| 統計 | `logic.js`の「統計」の節、`test/stats-weight.test.js` |'), []);
  assert.deepEqual(refsIn('（[CSVの資料](docs/csv.md)の「帯域の列」を参照）'), []);
});

test('「前述の「…」」「後述の「…」」は、同じファイルの見出しか項目名を指している', () => {
  for (const [rel, text] of Object.entries(FILES)) {
    for (const m of outsideFences(text).join('\n').matchAll(/(前述|後述)の「([^」]+)」/g)) {
      assert.ok(pointsTo(text, m[2]),
        `${rel} の「${m[1]}の「${m[2]}」」の行き先が、同じファイルにない（ほかのファイルなら[…](ファイル)の「…」で書く）`);
    }
  }
});

// ---- 強調 ----

test(`READMEとdocs/の各節（H1〜H3で区切る）で、強調（**）は${EMPHASIS_MAX}か所以下`, () => {
  let total = 0;
  for (const [rel, text] of Object.entries(FILES)) {
    for (const s of sections(text)) {
      const n = s.lines.reduce((a, l) => a + emphasisIn(l), 0);
      total += n;
      assert.ok(n <= EMPHASIS_MAX, `${rel} の「${s.head}」に強調が${n}か所ある（${EMPHASIS_MAX}か所以下にする）`);
    }
  }
  // 数え方の確かめ：箇条書きの先頭の項目名は数えず、文中の強調は数える
  assert.equal(emphasisIn('- **名前**：本文'), 0);
  assert.equal(emphasisIn('- **名前**  '), 0);
  assert.equal(emphasisIn('1. **名前**：本文'), 0);
  assert.equal(emphasisIn('- **名前**：**強調**'), 1);
  assert.equal(emphasisIn('- **文の頭の強調。**本文'), 1);
  assert.equal(emphasisIn('本文**強調**本文**強調**'), 2);
  assert.ok(total > 0, '強調を1つも数えていない（数え方が壊れている）');
});

// ---- 過去の版の説明 ----

// 過去の版との比較・訂正の経緯を書く言い回し。いまの作りの理由は、過去の版に触れずに書く
// 第2弾c1bの点検で、消した説明を元の文のまま戻しても通ると指摘されたので、語を足し、消した説明に固有の断片（REMOVED）も見る
const PAST = [
  '改修前', '改修後', '以前は', '以前の版', '以前あった', '初期の実装', '初期の版', '旧版', '旧バージョン', '旧い', '過去の版',
  'かつて', '当初は', 'までの版', 'までのREADME', 'のころの手順', 'さらに前の手順', 'と書いていました', 'と書いていた',
  'これまでどおり', '変わっていません', 'へ移りました', '第1弾で直', '第1弾のとき', '当時の', '外しました', '廃止', '直しました'
];
// 消した説明（分ける前のREADMEにあった過去の版との比較）に固有の断片。経緯はCLAUDE.mdの「README・docs/から外した経緯」にある。
// 「第1弾の版」を丸ごと禁じると、実機テストの条件（第1弾の版`c7b6bad`のv2）まで落ちるので、断片で書く
const REMOVED = [
  '第1弾の版の画面', '74.9%', '第1弾の版（全帯域', '+0.98dB', 'G列からJ列', '6466410a', 'c3e434fc84e0bb87', '第2弾aまで',
  'v2（7列）のころ', '39行のPython', '「スムージング」のスライダー', '真っ黒になる不具合', 'UIが固まっていた',
  '20.41秒', '86%が欠落', '10.05秒', '`# intervalSec=1+3`', '区間長をC列に入れる', '1行目から合いません`と書いて'
];
const pastHits = text => [...PAST, ...REMOVED].filter(w => text.includes(w))
  .concat(/c7b6bad[^\n]*processing=off/.test(text) ? ['c7b6bad…processing=off'] : []);

test('READMEとdocs/に、過去の版を説明する言い回しがない', () => {
  for (const [rel, text] of Object.entries(FILES)) {
    for (const w of pastHits(text)) {
      const at = text.indexOf(w);
      assert.fail(`${rel} に過去の版を説明する言い回し「${w}」がある: ${at < 0 ? '' : text.slice(Math.max(0, at - 30), at + 40)}`);
    }
  }
  // 見つけ方の確かめ：消した説明を元の文のまま戻したら見つかる（点検で、通ってしまうと指摘された文）
  for (const s of [
    '第1弾の版の画面に出たことがある「1行目の有効サンプル率74.9%」は、この版でも再現しなかった',
    '第1弾の版（全帯域の値だけ）で同じシーケンスを流したときは、22kHzは全帯域で+0.98dBにとどまり',
    'A列が時刻、B列が音量であることは変わっていません。`hash`列はG列からJ列へ移りました',
    '第2弾aまでのREADMEに載せていた見本',
    '以前の版では、ログ間隔の既定が3秒でした。',
    '旧バージョンでは、かつては',
    '改修前は毎フレーム加算していた',
    '⚠**c7b6bad（2026-09-29公開）までの版は、報告しない項目があっても`# processing=off`と書いていた。**'
  ]) {
    assert.ok(pastHits(s).length > 0, `過去の版の説明を見つけられない: ${s}`);
  }
  // 実機テストの条件は見つけない（残してよいもの）
  for (const s of ['第1弾の版`c7b6bad`のv2が1本', '公開版`c7b6bad`（第1弾）と`090648f`（第2弾b）', '## 第2弾で入れたもの',
    '記録した版（`090648f`）の表示下限の既定（-90dBFS）']) {
    assert.deepEqual(pastHits(s), [], `残してよい条件を過去の版の説明として拾っている: ${s}`);
  }
});

test('実機テストの条件の公開版（c7b6bad・090648f）と、第2弾で入れたものの一覧は残っている', () => {
  // どの版で確かめたかは条件なので残す。過去の版の説明を消すときに、条件まで消していないことを見る
  const real = FILES['docs/real-device-test.md'];
  assert.ok(real.includes('`090648f`') && real.includes('`c7b6bad`'), '実機テストの資料に、確かめた版がない');
  assert.ok(readme.includes('公開版の`c7b6bad`と`090648f`の2つ'), 'ブラウザー対応状況に、確かめた版がない');
  assert.ok(FILES['docs/roadmap.md'].includes('## 第2弾で入れたもの'), '将来案の資料に「第2弾で入れたもの」がない');
});

// ---- 使わないと決めた語 ----

test('READMEとdocs/の本文が、使わないと決めた語を含まない', () => {
  const BANNED = ['効く', '効い', '効か', '効き', '効け', '効こ', '走る', '走ら', '走り', '走っ', '走れ', '照合', '突き合わせ',
    '断定', '踏み込', '構図', '落とし穴', '破綻', '潰す', '潰し'];
  for (const [rel, text] of Object.entries(FILES)) {
    for (const raw of outsideFences(text)) {
      const l = raw.replace(/有効|無効/g, '');   // 「有効かを」の「効か」を拾わない
      for (const w of BANNED) assert.ok(!l.includes(w), `${rel} に「${w}」がある: ${raw}`);
    }
  }
});
