'use strict';

// 英語版のREADMEと資料（README.en.md・docs/en/）が、日本語版と同じ中身になっているか（第2弾c3b）。
//
// 英語版は要約にせず、日本語版と同じ節（見出しの数・順・階層）で全文を訳す（シリーズの決まり。day027では、英語版が
// 日本語版の30見出しのうち12を落とした要約になっていた）。訳した結果のうち、機械で見られるものをここで縛る。
//  - 対になるファイルがそろい、言語のリンクで互いに行き来できる
//  - 見出しの数・順・階層（H1〜H4）と頭の絵文字、節ごとの本文の行数、表の数値が日本語版と同じ
//  - 日本語の文字が無い（言語のリンクと、書名の原題に (Japanese-language book) を添えた行だけは許す）
//  - 相対リンクの行き先が実在し、英語版どうしでつながっている（日本語版へは言語のリンクだけ）。
//    「"見出し" in the [… document](….md)」「"…" above/below」は、行き先の見出しか項目名を指す
//  - コードの処理が日本語版と同じ（Pythonはコメントと文字列リテラルを除いて比べ、書式の指定の並びもそろえる）。
//    見本CSVなどのデータは1文字も変えない
//  - レシピの出力は、英語のコードを動かして写したもの。見本CSVにかけた出力はJSで計算し直して1文字ずつ比べ、
//    実機のCSVにかけた出力は、動かし直して写した全文を REAL_OUT_EN に持つ（日本語版の test/readme-recipes.test.js と同じやり方）
//  - 検証器の2つの表は、日本語版の表（test/chain-claim.test.js が実測と比べている）と同じ種類の出力・同じ数値
//  - 強調は節ごとに2か所以下、過去の版を説明する言い回しを使わない、CLAUDE.mdの用語の一覧の英語を使う
// ⚠ 英語版のレシピか検証器を変えたら、Pythonで見本CSVと実機のCSVにかけて出力を写し直し、RECIPE_SHA256_EN・
//    VERIFIER_SHA256_EN・REAL_OUT_EN を直す（手で書かない）。日本語版を変えたら、英語版も同じ節を直す。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const exists = rel => fs.existsSync(path.join(root, rel));
const DOC_NAMES = fs.readdirSync(path.join(root, 'docs')).filter(n => n.endsWith('.md')).sort();
// 日本語版 → 英語版
const PAIRS = [['README.md', 'README.en.md'], ...DOC_NAMES.map(n => [`docs/${n}`, `docs/en/${n}`])];
const JA_FILES = PAIRS.map(p => p[0]);
const EN_FILES = PAIRS.map(p => p[1]);
const jaOf = en => PAIRS.find(p => p[1] === en)[0];
const TEXT = {};
for (const rel of [...JA_FILES, ...EN_FILES]) if (exists(rel)) TEXT[rel] = read(rel);
const CLAUDE_MD = read('CLAUDE.md');
// 本文。README.md の先頭のYAMLメタデータ（HTMLコメント。英語版には置かない）を除く
const BODY = rel => (rel === 'README.md' ? TEXT[rel].slice(TEXT[rel].indexOf('\n-->\n') + 5) : TEXT[rel]);

// ---- 読み取りの道具 ----

// コードブロックの外の行（行番号つき）。箇条書きの中の字下げしたコードブロックも数える
function outside(text) {
  let fence = false;
  const out = [];
  text.split('\n').forEach((l, i) => {
    if (/^\s*```/.test(l)) { fence = !fence; return; }
    if (!fence) out.push({ n: i + 1, l });
  });
  return out;
}
const outsideLines = text => outside(text).map(x => x.l);

function headings(text) {
  return outsideLines(text).map(l => l.match(/^(#{1,6}) (.+)$/)).filter(Boolean)
    .map(m => ({ level: m[1].length, text: m[2].trim() }));
}
// 見出しの頭の絵文字（無ければ空文字）
const headIcon = t => t.match(/^[^\p{L}\p{N}`?"(（「『]*/u)[0].trim();

// H1〜H(max)の見出しで区切った節。head は見出しの行、lines はその下の本文の行（コードブロックの外）
function sections(text, max = 4) {
  const out = [{ head: '(先頭)', lines: [] }];
  for (const l of outsideLines(text)) {
    const m = l.match(/^(#{1,6}) /);
    if (m && m[1].length <= max) { out.push({ head: l, lines: [] }); continue; }
    out[out.length - 1].lines.push(l);
  }
  return out;
}

function codeBlocks(text) {
  const out = [];
  let cur = null;
  text.split('\n').forEach((l, i) => {
    const m = l.match(/^\s*```(\S*)\s*$/);
    if (m) {
      if (cur) { out.push(cur); cur = null; } else cur = { lang: m[1], line: i + 1, lines: [] };
      return;
    }
    if (cur) cur.lines.push(l);
  });
  return out;
}

// 表の行（区切りの行を除く）→ セルの配列。`\|` はセルの区切りにしない
function tableRows(text) {
  return outsideLines(text).map(l => l.trim())
    .filter(l => l.startsWith('|') && !/^\|\s*:?-{3,}/.test(l))
    .map(l => l.split(/(?<!\\)\|/).slice(1, -1).map(c => c.trim()));
}

// 表のセルの数値の比べ方。訳すと語順が変わるので、並びは問わない。英語の数値はすべて日本語にあり、日本語の数値のうち
// 英語にないのは 0〜2 の整数だけ（「1行目」「1つも」「1回」「電力0」は first・not a single・once・zero power のように語で書く）
function sameNumbers(jaNums, enNums) {
  const rest = [...jaNums];
  for (const x of enNums) {
    const i = rest.indexOf(x);
    if (i < 0) return false;
    rest.splice(i, 1);
  }
  return rest.every(x => /^[012]$/.test(x));
}
// 数値の並び。符号は見ない。英語で語にした小さな数（one〜ten）は数字に直して比べる
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
function numbers(s, lang) {
  const t = lang === 'en' ? s.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/gi, w => WORDS[w.toLowerCase()]) : s;
  return t.match(/(?<![\w.])\d+(?:\.\d+)?/g) || [];
}

// Pythonのコードの形：コメントを除き、文字列リテラルを <STR> に置き換えて、行ごとに「字下げ|トークン」にする。
// 空行とコメントだけの行は数えない。複数行の文字列（docstring）は1つの <STR> になる。strings は文字列の中身の並び
function pyScan(src) {
  let s = '';
  const strings = [];
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    const m = /^([rRbBuUfF]{0,2})("""|'''|"|')/.exec(src.slice(i, i + 5));
    if (m && (m[1] === '' || !/\w/.test(src[i - 1] || ''))) {
      assert.ok(!/f/i.test(m[1]), 'f文字列を使っている（中の式が <STR> に隠れるので、この比べ方では見られない）');
      const q = m[2];
      let j = i + m[0].length;
      while (j < src.length && !src.startsWith(q, j)) j += src[j] === '\\' ? 2 : 1;
      assert.ok(j < src.length, '文字列リテラルが閉じていない');
      strings.push(src.slice(i + m[0].length, j));
      s += '<STR>';
      i = j + q.length;
      continue;
    }
    s += c;
    i++;
  }
  const shape = s.split('\n').map(l => ({ indent: l.match(/^ */)[0].length, toks: l.match(/<STR>|\w+|\S/g) }))
    .filter(x => x.toks).map(x => `${x.indent}|${x.toks.join(' ')}`);
  return { shape, strings };
}
// 文字列の中の書式の指定（%d・%.2f・%+.1f・%Y など）の並び
const specs = s => s.match(/%[-+ #0]*\d*(?:\.\d+)?[a-zA-Z%]/g) || [];

// 見出しの文字と、強調した項目名（参照の行き先の候補）
function targetsOf(text) {
  const lines = outsideLines(text);
  const heads = lines.filter(l => /^#{1,6} /.test(l)).map(l => l.replace(/^#+ /, ''));
  const labels = [];
  for (const l of lines) for (const m of l.matchAll(/\*\*([^*]+)\*\*/g)) labels.push(m[1]);
  return [...heads, ...labels];
}
const pointsTo = (text, name) => targetsOf(text).some(t => t.includes(name));

function relLinks(text) {
  const out = [];
  for (const { n, l } of outside(text)) {
    for (const m of l.matchAll(/\]\(([^)\s]+)\)/g)) out.push({ n, l, t: m[1] });
    for (const m of l.matchAll(/(?:href|src)="([^"]+)"/g)) out.push({ n, l, t: m[1] });
  }
  return out.filter(x => !/^(https?:|mailto:|#)/.test(x.t));
}
const resolve = (from, t) => path.posix.normalize(path.posix.join(path.posix.dirname(from), t.split('#')[0]));

// ---- 対になるファイルと言語のリンク ----

test('英語版のファイルが日本語版とそろっている（README.en.md と、docs/ と同じ名前の docs/en/*.md）', () => {
  assert.ok(DOC_NAMES.length >= 5, `docs/のファイルが少ない（${DOC_NAMES.length}）`);
  for (const en of EN_FILES) assert.ok(TEXT[en] !== undefined, `英語版がない: ${en}`);
  const names = fs.readdirSync(path.join(root, 'docs', 'en'), { withFileTypes: true });
  for (const e of names) assert.ok(e.isFile() && e.name.endsWith('.md'), `docs/en/にMarkdown以外がある: ${e.name}`);
  assert.deepEqual(names.map(e => e.name).sort(), DOC_NAMES, 'docs/en/のファイル名がdocs/と食い違う');
});

test('言語のリンクで、対になるファイルを互いに行き来できる（YAMLメタデータはREADME.mdだけ）', () => {
  // README.md：手本（day025）と同じく、YAMLメタデータ（HTMLコメント）の直後、H1の直前に置く
  const ja = TEXT['README.md'].split('\n');
  const h1 = ja.findIndex(l => /^# /.test(l));
  assert.deepEqual(ja.slice(h1 - 4, h1), ['-->', '', '[English](README.en.md) · 日本語', ''],
    'README.mdの言語のリンクが、YAMLメタデータのあと・H1の前にない');
  const en = TEXT['README.en.md'].split('\n');
  assert.deepEqual(en.slice(0, 2), ['English · [日本語](README.md)', ''], 'README.en.mdの1行目が言語のリンクでない');
  assert.match(en[2], /^# Mic Gain Logger - /);
  // hackinglab.online が読むのは README.md のYAMLメタデータ。英語版に置くと二重になる
  assert.ok(!TEXT['README.en.md'].includes('<!--'), 'README.en.mdにHTMLコメント（YAMLメタデータ）がある');
  assert.ok(!/^(id|slug|repo_url): /m.test(TEXT['README.en.md']), 'README.en.mdにYAMLメタデータのキーがある');
  for (const n of DOC_NAMES) {
    assert.equal(TEXT[`docs/${n}`].split('\n')[2], `[READMEへ戻る](../README.md) · [English](en/${n})`,
      `docs/${n} の3行目に英語版へのリンクがない`);
    const e = TEXT[`docs/en/${n}`].split('\n');
    assert.match(e[0], /^# \S/, `docs/en/${n} の1行目がH1でない`);
    assert.equal(e[2], `[Back to README](../../README.en.md) · [日本語](../${n})`,
      `docs/en/${n} の3行目が、英語のREADMEへ戻るリンクと日本語版へのリンクでない`);
  }
});

// ---- 節の対応（要約にしていないこと） ----

test('見出しの数・順・階層（H1〜H4）と頭の絵文字が、日本語版と同じ', () => {
  for (const [ja, en] of PAIRS) {
    const a = headings(TEXT[ja]);
    const b = headings(TEXT[en]);
    const show = h => `${'#'.repeat(h.level)} ${h.text}`;
    assert.equal(b.length, a.length, `${en} の見出しが${b.length}個ある（日本語版は${a.length}個）`);
    a.forEach((x, i) => {
      assert.equal(b[i].level, x.level, `${en} の${i + 1}番目の見出しの階層が違う: 「${show(b[i])}」／「${show(x)}」`);
      assert.equal(headIcon(b[i].text), headIcon(x.text), `${en} の${i + 1}番目の見出しの絵文字が違う: 「${show(b[i])}」／「${show(x)}」`);
    });
    assert.equal(b.filter(h => h.level === 1).length, 1, `${en} のH1が1つでない`);
    assert.ok(a.some(h => h.level >= 2), `${ja} の見出しを読めていない`);
  }
  // 見つけ方の確かめ：絵文字と、絵文字の無い見出し
  assert.equal(headIcon('⚖️ 利用上の注意（法的な助言ではありません）'), '⚖️');
  assert.equal(headIcon('帯域の計算を止める（`?bands=off`）'), '');
  assert.equal(headIcon('Stopping band computation (`?bands=off`)'), '');
});

test('節ごとの本文の行数（空行を除く）が日本語版と同じ（全文を訳し、要約にしていない）', () => {
  const count = s => s.lines.filter(l => l.trim()).length;
  let n = 0;
  for (const [ja, en] of PAIRS) {
    const a = sections(BODY(ja));
    const b = sections(BODY(en));
    assert.equal(b.length, a.length, `${en} の節の数が違う`);
    a.forEach((s, i) => {
      const want = count(s);
      assert.equal(count(b[i]), want, `${en} の「${b[i].head}」の本文が${count(b[i])}行ある（日本語版の「${s.head}」は${want}行）`);
      n++;
    });
  }
  assert.ok(n >= 100, `節を数えていない（${n}）`);
});

test('表の行・列の数と、各セルの数値が日本語版と同じ', () => {
  let cells = 0;
  for (const [ja, en] of PAIRS) {
    const a = tableRows(TEXT[ja]);
    const b = tableRows(TEXT[en]);
    assert.equal(b.length, a.length, `${en} の表の行が${b.length}行ある（日本語版は${a.length}行）`);
    a.forEach((row, i) => {
      assert.equal(b[i].length, row.length, `${en} の表の行の列数が違う: ${b[i].join(' | ')}`);
      row.forEach((cell, j) => {
        assert.ok(sameNumbers(numbers(cell, 'ja'), numbers(b[i][j], 'en')), `${en} の表のセルの数値が違う:\n  英語  : ${b[i][j]}\n  日本語: ${cell}`);
        cells++;
      });
    });
  }
  assert.ok(cells >= 400, `見たセルが少ない（${cells}）`);
  // 数え方の確かめ
  assert.deepEqual(numbers('`1@0+3@12`＝seq 0から1秒', 'ja'), ['1', '0', '3', '12', '0', '1']);
  assert.deepEqual(numbers('`1@0+3@12` = 1 second from seq 0', 'en'), ['1', '0', '3', '12', '1', '0']);
  assert.deepEqual(numbers('18〜22kHz・-19.70・v3・c7b6bad', 'ja'), ['18', '22', '19.70']);
  assert.deepEqual(numbers('one iPhone, 18–22 kHz', 'en'), ['1', '18', '22']);
  assert.ok(sameNumbers(['1', '2'], ['2']) && sameNumbers(['22', '18'], ['18', '22']));
  assert.ok(!sameNumbers(['-19.70'], ['-19.72']) && !sameNumbers(['3'], []) && !sameNumbers(['2'], ['2', '4']));
});

// ---- 日本語の文字 ----

const JA_CHAR = /[\u3000-\u303F\u3040-\u30FF\u31F0-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF※]/;

test('英語版に日本語の文字がない（言語のリンクと、書名の原題に (Japanese-language book) を添えた行は除く）', () => {
  let books = 0;
  for (const en of EN_FILES) {
    TEXT[en].split('\n').forEach((l, i) => {
      const rest = l.replace(/\[日本語\]\((?:\.\.\/)?[\w.-]+\.md\)/, '[](x)');
      if (!JA_CHAR.test(rest)) return;
      if (rest.includes('(Japanese-language book)')) { books++; return; }
      assert.fail(`${en}:${i + 1} に日本語の文字がある: ${l.slice(0, 100)}`);
    });
    // 書名（『…』）には、同じ行のうしろに (Japanese-language book) を添える
    for (const l of TEXT[en].split('\n')) {
      for (const m of l.matchAll(/『[^』]+』/g)) {
        assert.ok(l.slice(m.index).includes('(Japanese-language book)'), `${en} の書名 ${m[0]} に (Japanese-language book) がない`);
      }
    }
  }
  assert.ok(books >= 2, '書名の行を数えていない');
  // 書名の原題は日本語版と同じ文字で残し、英語の意味と注記を添える（2冊とも）
  const uc = TEXT['docs/en/use-cases.md'];
  for (const t of ['『エアギャップ・ブリッジ　隔離環境のデータ入力技法』', '『エアギャップ・ブリッジ　隔離環境のデータ出力技法』']) {
    assert.ok(TEXT['docs/use-cases.md'].includes(t), `前提：日本語版に ${t} がある`);
    assert.ok(new RegExp(`${t} \\(\\*[^*]+\\*\\) \\(Japanese-language book\\)`).test(uc), `英語版の ${t} が「原題 (*英語の意味*) (Japanese-language book)」の形でない`);
  }
  // 見つけ方の確かめ
  assert.ok(JA_CHAR.test('（計量法）') && JA_CHAR.test('「区間」') && JA_CHAR.test('※') && !JA_CHAR.test('18–22 kHz · μPa'));
});

// ---- リンクと相互参照 ----

test('英語版の相対リンクの行き先が実在し、資料へのリンクは英語版どうしでつながっている', () => {
  let n = 0;
  let lang = 0;
  for (const en of EN_FILES) {
    for (const { n: line, t } of relLinks(TEXT[en])) {
      const target = resolve(en, t);
      assert.ok(exists(target), `${en}:${line} のリンクの行き先がない: ${t}`);
      n++;
      if (!target.endsWith('.md')) continue;
      if (target === jaOf(en)) {   // 言語のリンク（先頭の行だけ）
        assert.ok(line <= 3, `${en}:${line} が日本語版を指している（言語のリンクは先頭に1つだけ）`);
        lang++;
        continue;
      }
      // 資料は英語版を指す（CLAUDE.md のような開発者向けのファイルは日英の対がないので、そのまま指してよい）
      assert.ok(!JA_FILES.includes(target), `${en}:${line} が日本語版の資料を指している（英語版を指す）: ${t}`);
    }
  }
  assert.equal(lang, EN_FILES.length, '言語のリンクの数が英語版のファイルの数と合わない');
  assert.ok(n >= 60, `相対リンクが少ない（${n}）`);
  // 日本語版から英語版へのリンクは、言語のリンクの行だけ
  for (const ja of JA_FILES) {
    for (const { n: line, l, t } of relLinks(TEXT[ja])) {
      if (EN_FILES.includes(resolve(ja, t))) assert.ok(l.includes('[English]('), `${ja}:${line} が本文から英語版を指している: ${t}`);
    }
  }
});

test('英語版の参照「"名前" in the [… document](….md)」「"名前" above/below」が、行き先の見出しか項目名を指している', () => {
  let cross = 0;
  let local = 0;
  for (const en of EN_FILES) {
    const body = outsideLines(TEXT[en]).join('\n');
    let c = 0;
    let l = 0;
    for (const m of body.matchAll(/"([^"\n]+)" in (?:the )?\[[^\]]+\]\(([^)\s#]+\.md)(?:#[^)]*)?\)/g)) {
      const target = resolve(en, m[2]);
      assert.ok(EN_FILES.includes(target), `${en} の参照が英語版の資料を指していない: ${m[2]}`);
      assert.ok(pointsTo(TEXT[target], m[1]), `${en} の参照 "${m[1]}" が ${target} の見出しにも項目名にもない`);
      c++;
    }
    for (const m of body.matchAll(/"([^"\n]+)" (?:above|below)\b/g)) {
      assert.ok(pointsTo(TEXT[en], m[1]), `${en} の ${m[0]} が、同じファイルの見出しにも項目名にもない`);
      l++;
    }
    // 参照を落としていない：ファイルをまたぐ参照は日本語版の「[…](….md)の「…」」と同じ数、同じファイルの中は「前述・後述」以上
    const ja = outsideLines(TEXT[jaOf(en)]).join('\n');
    assert.equal(c, (ja.match(/\]\([^)\s#]+\.md(?:#[^)]*)?\)の「[^」]+」/g) || []).length, `${en} のファイルをまたぐ参照の数が日本語版と違う`);
    assert.ok(l >= (ja.match(/(?:前述|後述)の「/g) || []).length, `${en} の同じファイルの中の参照が日本語版より少ない`);
    cross += c;
    local += l;
  }
  assert.ok(cross >= 30, `ファイルをまたぐ参照が少ない（${cross}）`);
  assert.ok(local >= 20, `同じファイルの中の参照が少ない（${local}）`);
  // 見つけ方の確かめ：見出しの一部だけ違う参照を拾う
  assert.ok(!pointsTo(TEXT['docs/en/use-cases.md'], 'Cannot be compared with regulatory limits or standards'));
});

// ---- コード（処理は日本語版と同じ・データは同じ文字） ----

test('コードの処理が日本語版と同じ（Pythonはコメントと文字列リテラルを除いて比べる。見本・データは1文字も変えない）', () => {
  let py = 0;
  let strs = 0;
  for (const [ja, en] of PAIRS) {
    const a = codeBlocks(TEXT[ja]);
    const b = codeBlocks(TEXT[en]);
    assert.equal(b.length, a.length, `${en} のコードブロックが${b.length}個ある（日本語版は${a.length}個）`);
    a.forEach((x, i) => {
      const y = b[i];
      const where = `${en} の${y.line}行目のコードブロック`;
      assert.equal(y.lang, x.lang, `${where}の言語が違う`);
      if (x.lang === 'python') {
        py++;
        const A = pyScan(x.lines.join('\n'));
        const B = pyScan(y.lines.join('\n'));
        assert.deepEqual(B.shape, A.shape, `${where}の処理が日本語版と違う（コメントと文字列を除いて比べた）`);
        // 行の数と空行の位置も同じ（読者が写すコードの形をそろえる。PEP 8の2行空けも保つ）
        const blanks = ls => ls.map((l, k) => (l.trim() ? -1 : k)).filter(k => k >= 0);
        assert.equal(y.lines.length, x.lines.length, `${where}の行数が違う`);
        assert.deepEqual(blanks(y.lines), blanks(x.lines), `${where}の空行の位置が違う`);
        // 訳した文字列でも、書式の指定（%d・%.2f・%Y など）の並びは同じ（出す値と桁をそろえる）
        assert.equal(B.strings.length, A.strings.length);
        A.strings.forEach((s, k) => {
          assert.deepEqual(specs(B.strings[k]), specs(s), `${where}の文字列の書式の指定が違う: ${B.strings[k]} ／ ${s}`);
          strs++;
        });
      } else if (['sh', 'bash', 'powershell', 'excel'].includes(x.lang)) {
        const cmd = ls => ls.filter(l => !/^\s*#/.test(l));   // コメントの行だけが違ってよい
        assert.deepEqual(cmd(y.lines), cmd(x.lines), `${where}のコマンドが日本語版と違う`);
      } else if (x.lang === 'text' && x.lines[0].startsWith('$ python ')) {
        assert.equal(y.lines[0], x.lines[0], `${where}のコマンドが違う`);   // 出力は下のレシピのテストで見る
      } else if (x.lang === 'text' && x.lines[0] === '$ cat memo.txt') {
        // 説明のために作ったメモ。本文は訳してよく、時刻は同じ
        const times = ls => ls.map(l => l.split(',')[0]);
        assert.deepEqual(times(y.lines), times(x.lines), `${where}のメモの時刻が違う`);
      } else if (x.lang === '' && x.lines[0] === 'mic-gain-logger/') {
        // ディレクトリー構造（説明の列は訳す。項目は下のテストで見る）
      } else {
        assert.equal(y.lines.join('\n'), x.lines.join('\n'), `${where}（見本・データ・出力）が日本語版と違う`);
      }
    });
  }
  assert.equal(py, 10, 'Pythonのブロックの数が違う（検証器と9本のレシピ）');
  assert.ok(strs >= 150, `文字列を比べていない（${strs}）`);
  // 見つけ方の確かめ：コメントと文字列の違いは許し、処理・字下げの違いは拾う
  assert.deepEqual(pyScan('x = "a#b"  # c\n').shape, pyScan("x = 'dd'\n").shape);
  assert.deepEqual(pyScan('"""doc\nmore"""\nx = 1\n').shape, pyScan('"""other"""\nx = 1\n').shape);
  assert.notDeepEqual(pyScan('x = y[:16]\n').shape, pyScan('x = y[:12]\n').shape);
  assert.notDeepEqual(pyScan('h(prev + "|" + s)\n').shape, pyScan('h(prev + s)\n').shape);
  assert.notDeepEqual(pyScan('if a:\n    b()\n').shape, pyScan('if a:\nb()\n').shape);
  assert.deepEqual(specs('%s  %d行  Leq %.2f'), specs('%s  rows %d  Leq %.2f'));
  assert.notDeepEqual(specs('%+.1f dB'), specs('%+.2f dB'));
});

// ---- レシピの出力（英語のコードを動かして写したもの） ----

function fenced(text) {
  const out = [];
  const re = /```([a-z]*)\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push({ lang: m[1], body: m[2] });
  return out;
}
const CSV_JA = TEXT['docs/csv.md'];
const CSV_EN = TEXT['docs/en/csv.md'];
const BLOCKS_JA = fenced(CSV_JA);
const BLOCKS_EN = fenced(CSV_EN);

// 「$ python over.py sample.csv -30」の出力（コマンドの行を除いた部分）
function output(blocks, command) {
  const b = blocks.filter(x => x.lang === 'text' && x.body.startsWith('$ ' + command + '\n'));
  assert.equal(b.length, 1, `出力が1つない: ${command}`);
  return b[0].body.slice(command.length + 3);
}
function code(blocks, name) {
  const b = blocks.filter(x => x.lang === 'python' && x.body.startsWith(`# ${name} `));
  assert.equal(b.length, 1, `コードが1つない: ${name}`);
  return b[0].body;
}

// 見本CSVを、mgl.py の read_log と同じ手順で読む（test/readme-recipes.test.js と同じ手順）
function readLog(text) {
  const lines = text.split('\n').filter(l => l);
  const meta = {};
  for (const l of lines) {
    if (l.startsWith('# ') && l.includes('=')) {
      const i = l.indexOf('=');
      meta[l.slice(2, i)] = l.slice(i + 1);
    }
  }
  const table = lines.filter(l => !l.startsWith('#'));
  const cols = table[0].split(',');
  const runs = meta.intervalSec.split('+').map(p => p.split('@'));
  const edges = new Set(['sessionStartAt', 'clockBreakAt']
    .flatMap(k => (meta[k] || '').split(',').filter(Boolean).map(Number)));
  const num = c => (c === '' ? null : Number(c === '-Infinity' ? -Infinity : c));
  const rows = [];
  let prev = null;
  for (const l of table.slice(1)) {
    const r = Object.fromEntries(cols.map((c, i) => [c, l.split(',')[i]]));
    const seq = Number(r.seq);
    r.end = Date.parse(r.timestamp);
    r.sec = (prev === null || edges.has(seq))
      ? Number(runs.filter(([, at]) => Number(at) <= seq).pop()[0])
      : (r.end - prev.end) / 1000;
    r.start = r.end - r.sec * 1000;
    r.db = num(r.dbfs);
    r.ultra = num(r.band_ultra_dbfs || '');
    r.audible = num(r.band_audible_dbfs || '');
    rows.push(r);
    prev = r;
  }
  return { meta, rows };
}
const pad = (n, w = 2) => String(n).padStart(w, '0');
// Python の strftime と同じ書式（%f はマイクロ秒6桁）で、日本時間にして書く
function jst(ms, fmt) {
  const d = new Date(ms + 9 * 3600 * 1000);
  return fmt
    .replace('%Y', d.getUTCFullYear()).replace('%m', pad(d.getUTCMonth() + 1)).replace('%d', pad(d.getUTCDate()))
    .replace('%H', pad(d.getUTCHours())).replace('%M', pad(d.getUTCMinutes())).replace('%S', pad(d.getUTCSeconds()))
    .replace('%f', pad(d.getUTCMilliseconds() * 1000, 6));
}
function leq(rows, key = 'db') {
  const pairs = rows.filter(r => r[key] !== null).map(r => [r.sec, r[key]]);
  const total = pairs.reduce((a, [s]) => a + s, 0);
  if (total === 0) return null;
  const power = pairs.reduce((a, [s, v]) => a + s * 10 ** (v / 10), 0) / total;
  return power > 0 ? 10 * Math.log10(power) : -Infinity;
}
function median(rows, key = 'db') {
  const v = rows.filter(r => r[key] !== null).map(r => r[key]).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}
function spans(rows, hit) {
  const out = [];
  for (const r of rows) {
    if (!hit(r)) continue;
    const last = out.length ? out[out.length - 1] : null;
    if (last && last[last.length - 1].end === r.start) last.push(r); else out.push([r]);
  }
  return out;
}

const SAMPLE_TEXT = BLOCKS_EN.find(b => b.body.startsWith('# format=mic-gain-logger/3')).body;
const SAMPLE = readLog(SAMPLE_TEXT);
const joinLines = arr => arr.join('\n') + '\n';

test('英語版の見本CSVは日本語版と同じ4行で、コマンドラインの出力も同じ', () => {
  assert.equal(SAMPLE_TEXT, BLOCKS_JA.find(b => b.body.startsWith('# format=mic-gain-logger/3')).body);
  assert.equal(SAMPLE.rows.length, 4);
  const want = SAMPLE_TEXT.split('\n').filter(l => l && !l.startsWith('#')).join('\n') + '\n';
  assert.equal(output(BLOCKS_EN, "grep -v '^#' sample.csv"), want);
});

test('英語版の check.py・to_jst.py・hourly.py の出力が、見本CSVから計算したものと同じ', () => {
  const { meta, rows } = SAMPLE;
  const out = [`Engine=${meta.engines || meta.engine}  Audio processing=${meta.processing}`];
  let n = 0;
  for (const r of rows) {
    const why = [];
    if (r.db === null) why.push('missing');
    if (!['', '0'].includes(r.clip)) why.push('clip=' + r.clip);
    for (const k of ['valid_ratio', 'band_valid_ratio']) if (r[k] && Number(r[k]) < 1) why.push(`${k}=${r[k]}`);
    if (why.length) { n++; out.push(`seq ${r.seq}  ${jst(r.end, '%Y-%m-%d %H:%M:%S')}  ${why.join(' ')}`); }
  }
  out.push(`Rows to watch: ${n} / ${rows.length}`);
  assert.equal(output(BLOCKS_EN, 'python check.py sample.csv'), joinLines(out));

  assert.equal(output(BLOCKS_EN, 'python to_jst.py sample.csv'), joinLines(rows.map(r =>
    `seq ${r.seq}  ${jst(r.start, '%Y-%m-%d %H:%M:%S.%f').slice(0, -3)} - ${jst(r.end, '%H:%M:%S.%f').slice(0, -3)}  `
    + `${r.sec.toFixed(3)} s  dbfs ${r.dbfs}`)));

  const groups = new Map();
  for (const r of rows) {
    const k = jst(r.start, '%Y-%m-%d %H:00');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const f = v => (v === null ? 'none' : `${v.toFixed(2)} dBFS`);
  assert.equal(output(BLOCKS_EN, 'python hourly.py sample.csv'), joinLines([...groups.keys()].sort().map(k =>
    `${k}  rows ${groups.get(k).length}  Leq ${f(leq(groups.get(k)))}  ultrasonic band ${f(leq(groups.get(k), 'ultra'))}`)));
});

test('英語版の over.py・week.py・ultra_only.py・memo.py の出力が、見本CSVから計算したものと同じ', () => {
  const { rows } = SAMPLE;
  const limit = -30;
  const found = spans(rows, r => r.db !== null && r.db >= limit);
  const out = [`dbfs at ${limit.toFixed(2)} dBFS or higher`];
  for (const g of found) {
    const a = g[0];
    const z = g[g.length - 1];
    out.push(`${jst(a.start, '%m-%d %H:%M:%S')} - ${jst(z.end, '%H:%M:%S')}  ${Math.trunc((z.end - a.start) / 1000)} s  `
      + `seq ${a.seq}-${z.seq}  max ${Math.max(...g.map(r => r.db)).toFixed(2)} dBFS`);
  }
  const total = found.reduce((s, g) => s + (g[g.length - 1].end - g[0].start) / 1000, 0);
  out.push(`Periods: ${found.length}  total ${Math.trunc(total)} s`);
  assert.equal(output(BLOCKS_EN, 'python over.py sample.csv -30'), joinLines(out));

  const cells = new Map();
  for (const r of rows) {
    const d = new Date(r.start + 9 * 3600 * 1000);
    const key = `${d.getUTCHours()},${(d.getUTCDay() + 6) % 7}`;   // Python の weekday()（月曜＝0）
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(r);
  }
  const hours = [...new Set([...cells.keys()].map(k => Number(k.split(',')[0])))].sort((a, b) => a - b);
  const week = ['Hour\t' + [...'MTWTFSS'].join('\t')];
  for (const h of hours) {
    const vals = [0, 1, 2, 3, 4, 5, 6].map(d => (cells.has(`${h},${d}`) ? leq(cells.get(`${h},${d}`)) : null));
    week.push(`${h}\t` + vals.map(v => (v === null ? '-' : v.toFixed(1))).join('\t'));
  }
  assert.equal(output(BLOCKS_EN, 'python week.py sample.csv'), joinLines(week));

  const bu = median(rows, 'ultra');
  const ba = median(rows, 'audible');
  const hit = spans(rows, r => r.ultra !== null && r.audible !== null && r.ultra - bu >= 10 && (r.ultra - bu) - (r.audible - ba) >= 10);
  assert.equal(hit.length, 0);
  assert.equal(output(BLOCKS_EN, 'python ultra_only.py sample.csv'), `Median  ultrasonic band ${bu.toFixed(2)}  audible band ${ba.toFixed(2)} dBFS\n`);

  const memo = output(BLOCKS_EN, 'cat memo.txt').split('\n').filter(Boolean);
  assert.equal(memo.length, 2);
  const ev = rows.map(r => [r.start, `${jst(r.start, '%H:%M:%S.%f').slice(0, -3)} - ${jst(r.end, '%H:%M:%S.%f').slice(0, -3)}  seq ${r.seq}  dbfs ${r.dbfs}`]);
  for (const l of memo) {
    const when = Date.parse(l.slice(0, l.indexOf(',')).replace(' ', 'T') + '+09:00');
    ev.push([when, `${jst(when, '%H:%M:%S')}  [memo] ${l.slice(l.indexOf(',') + 1)}`]);
  }
  ev.sort((a, b) => a[0] - b[0]);   // 同じ時刻なら元の順（Python の sorted と同じく安定）
  assert.equal(output(BLOCKS_EN, 'python memo.py sample.csv memo.txt'), joinLines(ev.map(e => e[1])));
});

test('英語版の見本の1行目の日本時間（Excelの式を当てた値）が日本語版と同じ', () => {
  const m = CSV_JA.match(/見本の1行目は`([^`]+)`になる/);
  assert.ok(m, '前提：日本語版に見本の1行目の時刻がある');
  assert.ok(CSV_EN.includes(`The first row of the sample becomes \`${m[1]}\``), `英語版の見本の1行目の時刻が ${m[1]} でない`);
  assert.ok(CSV_EN.includes('it has not been checked in actual Excel or Google Sheets'), '英語版に、確かめた範囲がない');
});

// 実機のCSVにかけた出力（動かし直して写した全文。実機のCSVはリポジトリーの外にある）
const REAL_OUT_EN = {
  'python ultra_only.py iphone18pm_sweep_bands_20260929.csv': [
    'Median  ultrasonic band -93.50  audible band -74.72 dBFS',
    '14:50:52 - 14:50:58  seq 46-51  ultrasonic band max +29.3 dB  audible band at that point +5.2 dB',
    '14:50:59 - 14:51:05  seq 53-58  ultrasonic band max +33.4 dB  audible band at that point +0.0 dB',
    '14:51:06 - 14:51:12  seq 60-65  ultrasonic band max +41.9 dB  audible band at that point -0.2 dB',
    '14:51:13 - 14:51:19  seq 67-72  ultrasonic band max +33.6 dB  audible band at that point -0.8 dB'
  ],
  ['python compare.py iphone18pm_noise_fan-on_spk-off_20260929.csv iphone18pm_noise_fan-off_spk-on_20260929.csv '
    + 'iphone18pm_noise_fan-off_spk-on_tab-closed_20260929.csv iphone18pm_noise_fan-off_spk-on_stream-active_20260929.csv']: [
    'Baseline: files 3, rows 94 / target: rows 31',
    'Header differences=none',
    'Note: some records cannot confirm that audio processing was off (processing=unknown:autoGainControl+noiseSuppression)',
    'dbfs median  baseline -79.70  target -75.92  diff +3.78 dB',
    'band_audible_dbfs median  baseline -79.95  target -76.47  diff +3.48 dB',
    'band_ultra_dbfs median  baseline -106.05  target -104.02  diff +2.03 dB',
    'dbfs Leq  baseline -79.63  target -75.89  diff +3.73 dB'
  ],
  'python over.py iphone18pm_sweep_bands_20260929.csv +10': [
    'dbfs median -72.77 + 10 dB = -62.77 dBFS or higher',
    '09-29 14:50:24 - 14:50:30  6 s  seq 18-23  max -37.48 dBFS',
    '09-29 14:50:31 - 14:50:36  5 s  seq 25-29  max -58.41 dBFS',
    '09-29 14:50:45 - 14:50:50  5 s  seq 39-43  max -58.40 dBFS',
    '09-29 14:50:59 - 14:51:04  5 s  seq 53-57  max -59.94 dBFS',
    '09-29 14:51:06 - 14:51:12  6 s  seq 60-65  max -51.59 dBFS',
    '09-29 14:51:13 - 14:51:18  5 s  seq 67-71  max -59.79 dBFS',
    'Periods: 6  total 32 s'
  ]
};

test('英語版の、実機のCSVにかけた出力が、動かし直して写した全文と同じで、数値は日本語版と同じ', () => {
  for (const [cmd, want] of Object.entries(REAL_OUT_EN)) {
    const got = output(BLOCKS_EN, cmd);
    assert.equal(got, joinLines(want), cmd);
    assert.deepEqual(numbers(got, 'en'), numbers(output(BLOCKS_JA, cmd), 'ja'), `日本語版と数値が違う: ${cmd}`);
  }
  // 実機のCSVにかけたレシピの出力は、この3本だけ（増やしたら、ここにも写す）
  const real = BLOCKS_EN.filter(b => b.lang === 'text' && /^\$ python \S+ iphone18pm/.test(b.body));
  assert.equal(real.length, Object.keys(REAL_OUT_EN).length);
});

// 出力を写したときの英語のコードの SHA-256。コードを書き換えても、上のJSの計算は変わらないので落ちない。
// ⚠ 英語のレシピか検証器を変えたら、Pythonで見本CSVと実機のCSVにかけ直し、出力と検証器の表を写し直してから直す
const sha256 = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const RECIPE_SHA256_EN = {
  'mgl.py': '7aaa925a9577a7b8ca67b5f62f0e74a7a27015e4c78fe570d5bb7036be653f06',
  'check.py': '101daa4540ecc3cc9bdabb3bf1c3ca9d607667a5aeead9aa3e1458e3d28ea6e1',
  'to_jst.py': 'c26e7908e3271e83ce95fd78f0fec1ceae66461d19e6ca23bcaf99514a006dbf',
  'hourly.py': '123c8ea9a9dea6ce7c95eb5901a50eaec5e3496ca4c0c2d6b4586b0c86a788c1',
  'over.py': '2665e4e8fab5b2f6a55558aad9048e86df8293f68e9b2002d619384f568ecacc',
  'week.py': '2dd0328a39794207cc8a23b642eb0e33729cceed3fc4091d05d863d882c1981e',
  'ultra_only.py': '19f40e2205f4e1ad2c4030735adc9d3b9ecc8d077136937a590e990a22e3af7a',
  'compare.py': 'ac95b08ebc0332cecbc62e0643281ae483db06e812e20b45668c6145ace51fa5',
  'memo.py': '15207da0ade769244ee2b24b6fe4cfb102dae6a826815472254f5ea6a2e83640'
};
const VERIFIER_SHA256_EN = '00f88c8393d29fb04182720b63628a4bef7cfb2e4a48710a48ef75374f50ad64';

test('英語版のレシピと検証器のコードが、出力を写したときのコードと同じ', () => {
  for (const [n, sha] of Object.entries(RECIPE_SHA256_EN)) {
    assert.equal(sha256(code(BLOCKS_EN, n)), sha, `${n} のコードが、出力を写したときのものと違う（変えたなら動かし直して出力を写し直す）`);
  }
  assert.equal(sha256(code(BLOCKS_EN, 'verify_mic_gain_log.py')), VERIFIER_SHA256_EN,
    '英語の検証器が、表を採り直したときのものと違う（変えたなら Python で見本CSVと表を採り直す）');
  const names = blocks => blocks.filter(b => b.lang === 'python').map(b => b.body.match(/^# (\S+)/)[1]);
  assert.deepEqual(names(BLOCKS_EN), names(BLOCKS_JA));
  assert.ok(CSV_EN.includes('The outputs are copied exactly as produced by actually running the code.'), '出力の出どころを書いていない');
});

// ---- 検証器の2つの表 ----

// 検証器が出す文言（sys.exit と print の文字列）。日英のコードは文字列を除いて同じなので、位置で対にできる
const verifierMessages = blocks => [...code(blocks, 'verify_mic_gain_log.py').matchAll(/(?:sys\.exit|print)\("([^"]+)"/g)].map(m => m[1]);
// 数字・16進のハッシュ・書式の指定を § にそろえた形。表のセルは途中で切った（…）ものがあるので、前方一致で種類を決める
const shapeOf = s => s.replace(/`/g, '').replace(/…/g, '').replace(/%[ds]/g, '§').replace(/\b[0-9a-f]{8,}\b/g, '§').replace(/\d+/g, '§').trim();
function kindOf(cell, messages) {
  const c = shapeOf(cell);
  const hits = messages.map((m, i) => (c && shapeOf(m).startsWith(c) ? i : -1)).filter(i => i >= 0);
  assert.equal(hits.length, 1, `検証器の文言のどれか1つに当てはまらない: ${cell}`);
  return hits[0];
}
function tableAfter(text, header) {
  const ls = text.split('\n');
  const i = ls.indexOf(header);
  assert.notEqual(i, -1, `表が見つからない: ${header}`);
  const rows = [];
  for (const l of ls.slice(i + 2)) {
    if (l[0] !== '|') break;
    rows.push(l.split('|').slice(1, -1).map(c => c.trim()));
  }
  return rows;
}

test('英語版の検証器の2つの表が、日本語版の表（実測と比べている）と同じ種類の出力・同じ数値になっている', () => {
  const ja = verifierMessages(BLOCKS_JA);
  const en = verifierMessages(BLOCKS_EN);
  assert.equal(en.length, ja.length, '検証器の文言の数が違う');
  assert.ok(ja.length >= 8, `検証器の文言を読めていない（${ja.length}）`);
  ja.forEach((m, i) => assert.deepEqual(specs(en[i]), specs(m), `検証器の文言の書式が違う: ${en[i]}`));
  for (const [hj, he, w] of [
    ['| 渡したもの | 出力 |', '| Input | Output |', 13],
    ['| 改変の内容 | 改変しただけ | 鎖を張り直したあと |', '| Change | Only changed | After re-linking the chain |', 7]
  ]) {
    const a = tableAfter(CSV_JA, hj);
    const b = tableAfter(CSV_EN, he);
    assert.equal(a.length, w, `日本語版の表の行数が変わった: ${hj}`);
    assert.equal(b.length, a.length, `英語版の表の行数が違う: ${he}`);
    a.forEach((row, r) => {
      assert.deepEqual(numbers(b[r][0], 'en'), numbers(row[0], 'ja'), `渡したものの数値が違う: ${b[r][0]} ／ ${row[0]}`);
      for (let c = 1; c < row.length; c++) {
        assert.equal(kindOf(b[r][c], en), kindOf(row[c], ja), `出力の種類が違う: ${b[r][c]} ／ ${row[c]}`);
        assert.deepEqual(numbers(b[r][c], 'en'), numbers(row[c], 'ja'), `出力の数値が違う: ${b[r][c]} ／ ${row[c]}`);
      }
    });
  }
  // 見つけ方の確かめ：途中で切ったセルも、1つの文言に決まる
  assert.equal(kindOf('`Mismatch starting at row 2`', en), kindOf('`2行目から合いません（期待 d354201d…／実際 9381a0b3…）`', ja));
  assert.notEqual(kindOf('`Trailer mismatch`', en), kindOf('`Mismatch starting at row 1`', en));
});

// ---- 強調・過去の版・用語 ----

// 箇条書き（番号付きを含む）の先頭の項目名。「- **Name**:」と「- **Name**」＋改行
const LEAD_EN = /^(\s*(?:[-*]|\d+\.)\s+)\*\*[^*]+\*\*(?=:|\s*$)/;
function emphasisIn(line) {
  const s = line.replace(LEAD_EN, '$1').replace(/`[^`]*`/g, '');
  return Math.floor((s.match(/\*\*/g) || []).length / 2);
}

test('英語版の各節（H1〜H3で区切る）で、強調（**）は2か所以下', () => {
  let total = 0;
  for (const en of EN_FILES) {
    const ls = TEXT[en].split('\n');
    let head = '(先頭)';
    let n = 0;
    let fence = false;
    const check = () => assert.ok(n <= 2, `${en} の「${head}」に強調が${n}か所ある（2か所以下にする）`);
    ls.forEach((l, i) => {
      if (/^\s*```/.test(l)) { fence = !fence; return; }
      if (fence) return;
      if (/^#{1,3} /.test(l)) { check(); head = l; n = 0; return; }
      if (l.trimStart().startsWith('|') && /^\s*\|\s*:?-+/.test(ls[i + 1] || '')) return;   // 表の見出しの行
      const k = emphasisIn(l);
      n += k;
      total += k;
    });
    check();
  }
  assert.ok(total > 0, '強調を1つも数えていない（数え方が壊れている）');
  assert.equal(emphasisIn('- **Name**: text'), 0);
  assert.equal(emphasisIn('1. **Name**: text'), 0);
  assert.equal(emphasisIn('- **Name**: **strong**'), 1);
  assert.equal(emphasisIn('⚠**It does not withstand intentional changes.** The dividing line'), 1);
});

// 過去の版との比較・訂正の経緯を書く言い回し（日本語版は test/readme-docs.test.js が見ている）と、開発の段階名
const PAST_EN = [
  /\bpreviously\b/i, /\bused to\b/i, /\b(?:earlier|old|older|previous|prior|former) versions?\b/i, /\bformerly\b/i,
  /\boriginally\b/i, /\binitial(?:ly| implementation| version)\b/i, /\bfirst (?:implementation|version)\b/i,
  /\bbefore the (?:fix|change|update)\b/i, /\b(?:was|were|has been|have been) fixed\b/i, /\bin the past\b/i, /\blegacy\b/i,
  /\b(?:up to|until) (?:version|Phase)\b/i, /\bPhase [12][a-c]\d?[a-z]?\b/
];
// 分ける前のREADMEにあった過去の版の説明に固有の断片（言語によらない）
const REMOVED_EN = ['74.9%', '6466410a', 'c3e434fc84e0bb87', '+0.98 dB', '20.41 s', '`# intervalSec=1+3`'];
// Excelの版の話で、このツールの過去の版ではない（日本語版の「古いExcelでは」）
const PAST_OK_EN = ['older versions of Excel'];
const pastHitsEn = text => {
  const t = PAST_OK_EN.reduce((s, w) => s.split(w).join(''), text);
  return [...PAST_EN.filter(re => re.test(t)).map(String), ...REMOVED_EN.filter(w => t.includes(w))];
};

test('英語版に、過去の版を説明する言い回しと開発の段階名がない', () => {
  for (const en of EN_FILES) assert.deepEqual(pastHitsEn(TEXT[en]), [], `${en} に過去の版を説明する言い回しがある`);
  for (const s of ['Previously, the default log interval was 3 seconds.', 'The slider used to move only the display.',
    'The old version wrote `off` even when items were not reported.', 'In the initial implementation, the origin moved.',
    'This was fixed in the next release.', 'Up to Phase 2a, the hash column was column G.', 'Added in Phase 2c3a.']) {
    assert.ok(pastHitsEn(s).length > 0, `過去の版の説明を見つけられない: ${s}`);
  }
  for (const s of ['What Phase 2 added', 'ideas for Phase 3', 'older versions of Excel need it to be confirmed',
    'the log interval with which each interval was actually measured', 'the check no longer passes']) {
    assert.deepEqual(pastHitsEn(s), [], `残してよい言い回しを拾っている: ${s}`);
  }
});

function termRows() {
  const at = CLAUDE_MD.indexOf('### 用語の一覧');
  assert.ok(at > 0, 'CLAUDE.md に用語の一覧が無い');
  const end = CLAUDE_MD.indexOf('\n#', at + 1);
  return CLAUDE_MD.slice(at, end < 0 ? undefined : end).split('\n').filter(l => /^\| [^-|]/.test(l)).slice(1)
    .map(l => l.split('|').map(c => c.trim())).map(c => ({ ja: c[1], en: c[2].replace(/`/g, ''), note: c[3] || '' }))
    .filter(r => r.ja && r.en);
}
// 表の英語の核（括弧の注記を除く）を、単数・複数とハイフンの違いを許して探す正規表現
const core = en => en.replace(/\s*\([^)]*\)/g, '').trim();
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const termRe = en => new RegExp(core(en).split(/[\s-]+/).map(w => escapeRe(w.replace(/s$/, '')) + '(?:s|es)?').join('[\\s-]+'), 'i');

test('英語版が、CLAUDE.mdの用語の一覧の英語を使っている（日本語版の節に用語があれば、英語版の同じ節にも表の英語がある）', () => {
  const rows = termRows();
  assert.ok(rows.length >= 20, `用語の一覧が短い（${rows.length}行）`);
  const misses = [];
  let checked = 0;
  for (const [ja, en] of PAIRS) {
    const a = sections(BODY(ja));
    const b = sections(BODY(en));
    a.forEach((s, i) => {
      const enText = [b[i].head, ...b[i].lines].join('\n');
      for (const r of rows) {
        let jaText = [s.head, ...s.lines].join('\n');
        // 表のもっと長い語（例：超音波帯の最大 → Ultrasonic max）の一部として出ているぶんは、その長い語の行で見る
        for (const longer of rows) {
          if (longer !== r && longer.ja.length > r.ja.length && longer.ja.includes(r.ja)) jaText = jaText.split(longer.ja).join('');
        }
        // ボタンの名前は、日本語版で「」に入れてボタンを指している箇所だけを見る（「記録開始時」のような時点は別の語）
        const isButton = r.note.startsWith('ボタン');
        if (!(isButton ? jaText.includes(`「${r.ja}」`) : jaText.includes(r.ja))) continue;
        checked++;
        const ok = isButton ? enText.includes(core(r.en)) : termRe(r.en).test(enText);
        if (!ok) misses.push(`${en}「${b[i].head}」: 「${r.ja}」→「${core(r.en)}」がない`);
      }
    });
  }
  assert.deepEqual(misses, []);
  assert.ok(checked >= 200, `見た用語が少ない（${checked}）`);
  // 見つけ方の確かめ
  assert.match('three clock jumps', termRe('clock jump'));
  assert.match('the header line `# device=`', termRe('header lines'));
  assert.match('high-precision mode', termRe('high-precision mode (AudioWorklet)'));
  assert.doesNotMatch('the simple mode', termRe('fallback mode'));
});

test('英語版が、使わないと決めた訳語を使わず、ボタンの名前は画面の英語と同じ文字で書いている', () => {
  // 製品名とURLの Detector は訳語ではないので除く（日本語版にも同じ名前がある）
  const PRODUCTS = ['Ultrasonic Leak Detector', 'frequencydetector.com'];
  for (const p of PRODUCTS) assert.ok(TEXT['docs/roadmap.md'].includes(p), `前提：日本語版に ${p} がある`);
  for (const en of EN_FILES) {
    const t = PRODUCTS.reduce((s, p) => s.split(p).join(''), TEXT[en]);
    for (const bad of [/tamper/i, /detect/i, /simple mode/i, /lite mode/i, /high[- ]accuracy/i, /effective sample/i,
      /ultrasonic line/i, /ultrasound band/i]) {
      assert.doesNotMatch(t, bad, `${en} に使わない訳語がある`);
    }
  }
  // ボタンの名前は画面の英語（messages.js の en）と同じ文字。引用符に入れた名前の大文字・小文字も同じ
  const EN = require('../messages.js').DICTIONARIES.en;
  const all = EN_FILES.map(f => TEXT[f]).join('\n');
  for (const key of ['btn.start', 'btn.stop', 'btn.export', 'btn.reset', 'btn.more']) {
    const label = EN[key];
    assert.ok(all.includes(`"${label}"`), `英語版がボタン「${label}」を画面と同じ文字で書いていない`);
    for (const m of all.matchAll(new RegExp(`"(${escapeRe(label)})"`, 'gi'))) {
      assert.equal(m[1], label, `ボタンの名前の大文字・小文字が画面と違う: ${m[0]}`);
    }
  }
});

// ---- README.en.md の構成 ----

const ENTRY = /^([\s│]*)([├└])── (\S+)(?:\s+# ?(.*?))?\s*$/;
function tree(text, head) {
  const at = text.indexOf(head);
  assert.notEqual(at, -1, `見出しがない: ${head}`);
  const open = text.indexOf('```', at);
  const close = text.indexOf('```', open + 3);
  const ls = text.slice(open + 3, close).split('\n').filter(l => l.trim());
  assert.equal(ls[0], 'mic-gain-logger/');
  const stack = [];
  return ls.slice(1).map(line => {
    const m = line.match(ENTRY);
    assert.ok(m, `構成図として読めない行: ${line}`);
    const depth = m[1].length / 4;
    stack.length = depth;
    const rel = [...stack, m[3].replace(/\/$/, '')].join('/');
    if (m[3].endsWith('/')) stack[depth] = m[3].slice(0, -1);
    return { rel, comment: (m[4] || '').trim(), line };
  });
}

test('README.en.mdのディレクトリー構造が、README.mdと同じ項目を同じ順に並べ、全行に説明があり、#の桁がそろっている', () => {
  const a = tree(TEXT['README.md'], '## 📁 ディレクトリー構造');
  const b = tree(TEXT['README.en.md'], '## 📁 Directory structure');
  assert.deepEqual(b.map(e => e.rel), a.map(e => e.rel));
  for (const e of b) assert.ok(e.comment.length > 0, `説明がない: ${e.rel}`);
  for (const rel of ['README.en.md', 'docs/en', ...DOC_NAMES.map(n => `docs/en/${n}`), 'test/readme-en.test.js']) {
    assert.ok(a.some(e => e.rel === rel), `構成図に ${rel} がない`);
  }
  for (const [name, t] of [['README.md', a], ['README.en.md', b]]) {
    const cols = new Set(t.map(e => e.line.indexOf(' # ') + 1));
    assert.equal(cols.size, 1, `${name} の構成図の # の桁がそろっていない`);
  }
});

test('README.en.mdが、シリーズ標準の英語版の構成（H1・バッジ5種・Day行・固定のH2）になっている', () => {
  const en = TEXT['README.en.md'];
  const ls = en.split('\n');
  assert.equal(ls[2], '# Mic Gain Logger - Microphone level logger');
  const badges = ls.slice(3, 11).filter(l => /img\.shields\.io/.test(l));
  assert.equal(badges.length, 5, 'バッジが5種ない');
  assert.deepEqual(badges, TEXT['README.md'].split('\n').filter(l => /img\.shields\.io/.test(l)), 'バッジが日本語版と違う');
  assert.ok(en.includes('\n**Day041 - 100 Security Tools with Generative AI**\n'));
  assert.deepEqual(headings(en).filter(h => h.level === 2).map(h => h.text), [
    '🌐 Demo', '📸 Screenshots', '✨ Features', '📖 Usage', '🎯 Use cases', '⚖️ Usage notes (not legal advice)',
    '📚 Documents (docs/en/)', '🧪 Tests', '📁 Directory structure', '💻 Requirements', '📄 License', '🛠️ About this tool'
  ]);
  const about = en.slice(en.indexOf('## 🛠️ About this tool'));
  assert.ok(about.includes('"100 Security Tools with Generative AI"'));
  assert.ok(about.includes('https://akademeia.info/?page_id=42163'), 'Day001〜100 のリンクでない');
  // スクリーンショットは、英語の画面を撮るまで日本語版と同じ画像を指す（そのことを書いている）
  const imgs = t => [...t.matchAll(/<img src="([^"]+)"/g)].map(m => m[1]);
  // 英語版は英語の画面（assets/en/）を指す。日本語版と同じ名前・同じ並び（第2弾c2）
  assert.deepEqual(imgs(en), imgs(TEXT['README.md']).map(s => s.replace('assets/', 'assets/en/')));
  assert.ok(!en.includes('These screenshots show the Japanese display.'), '英語の画面に差し替えたのに、日本語の画面だと書いている');
});

test('英語版が、ツールの立場（相対値・改変に耐えない・何の音かは分からない・証明に使えない）を日本語版と同じく書いている', () => {
  const readme = TEXT['README.en.md'];
  for (const [where, text, s] of [
    ['README.en.md', readme, 'it is not sound pressure (dB SPL), so it cannot be set side by side with regulatory limits or standard values'],
    ['README.en.md', readme, '(they do not withstand intentional changes)'],
    ['README.en.md', readme, 'The band values record sound energy; they cannot tell what the sound is'],
    ['README.en.md', readme, 'the records cannot be used as proof. The author does not encourage misuse.'],
    ['docs/en/csv.md', CSV_EN, 'It does not withstand intentional changes, whoever makes them.'],
    ['docs/en/csv.md', CSV_EN, 'The dividing line is not "the author or a third party" but whether the hashes are recomputed.'],
    ['docs/en/csv.md', CSV_EN, 'does not prove that a record is correct'],
    ['docs/en/use-cases.md', TEXT['docs/en/use-cases.md'], 'The author does not encourage misuse.']
  ]) {
    assert.ok(text.includes(s), `${where} に「${s}」がない`);
  }
  // 反対の言い方を、打ち消しのない文で書かない（「cannot be compared」「does not prove」は立場どおり）
  const sentences = EN_FILES.flatMap(f => TEXT[f].split(/(?<=[.!?])\s+|\n/));
  const NEG = /\b(?:not|cannot|can't|never|no|misreading|without)\b/i;
  const CLAIMS = [/\bcan (?:be )?compared? with regulatory/i, /\b(?:can|will) (?:identify|tell) what the sound is/i,
    /\bproves? that (?:the|a) record is (?:correct|genuine)/i, /\bcan be used as (?:proof|evidence)/i];
  const opposite = s => CLAIMS.some(re => re.test(s)) && !NEG.test(s);
  for (const s of sentences) assert.ok(!opposite(s), `ツールの立場と反対の言い方がある: ${s.slice(0, 120)}`);
  assert.ok(opposite('The records can be used as proof.') && !opposite('The records cannot be used as proof.'));
});
