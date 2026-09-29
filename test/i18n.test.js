'use strict';

// 画面の日英対応（第2弾c3a）。
//
// 画面に出る文言を messages.js の日本語（ja）と英語（en）の辞書に集め、?lang=ja|en → 保存した選択 → ブラウザーの言語
// の順で初期言語を決め、ヘッダーの右上のボタンで切り替える（TEMPLATE ④。手本は day025 morse-tree-visualizer）。
// ここで見ること：
//  - 辞書：日英のキーと置き換える値の名前がそろう／英語の値に日本語の文字が無い／タグは <strong>・<code>・<em> だけ
//  - index.html：画面に出る日本語はすべて辞書のキー（data-i18n・data-i18n-rich・data-i18n-<属性名>）で差し替えられ、
//    HTML の日本語と ja の値が同じ（片方だけ直すと落ちる）
//  - script.js・logic.js：コメントの外に日本語の文字列が無い（文言は辞書から引く）
//  - logic.js の文言を返す関数を英語で呼ぶと、どの状態でも日本語が出ない。CSV を組み立てる関数は辞書を使わない
//  - 言語の決め方の順番と、<html lang> の切り替え（script.js を node:vm と小さな偽の DOM で実際に動かして確かめる）
// 期待値は手で書かず、辞書・HTML・logic.js の関数から出す。
//
// 点検で足したこと（第2弾c3a）：
//  - 言語の切り替えボタンの名前（aria-label）は見えている文字（EN／JA）で始める（WCAG 2.5.3 Label in Name）
//  - 英語の単数・複数（1区間で「in all 1 interval」「those intervals」と出ていた）
//  - フッターの括弧の内側に空白を出さない（HTML の要素のあいだの空白が、英語の「( … )」に残っていた）
//  - 用語の表の対応をキーごとに見る（辞書のどこかに1回出てくるかだけでは、1か所の言い換えを見逃す）
//  - 記録して止めたあとに切り替えても、計測エンジン・記録の穴・注意書きを描き直す（待機中のページだけでは、
//    applyLanguage からこの3つの描き直しを外しても通っていた）

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const M = require('../messages.js');
const logic = require('../logic.js');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const HTML = read('index.html');
const SCRIPT = read('script.js');
const LOGIC = read('logic.js');
const MESSAGES = read('messages.js');
const CSS = read('style.css');
const CLAUDE_MD = read('CLAUDE.md');

const { DICTIONARIES, I18N_ATTRS } = M;
const JA = DICTIONARIES.ja;
const EN = DICTIONARIES.en;

// 日本語の文字：ひらがな・カタカナ（半角を含む）・漢字・和文の記号（U+3000〜U+303F）・全角の英数字と記号・「※」
const JAPANESE = /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\u203b]/;

// ---- HTML を読む（依存パッケージなしの小さな読み取り） ----

const VOID = new Set(['meta', 'link', 'input', 'br', 'hr', 'img', 'source', 'wbr']);

function decodeEntities(s) {
  return s.replace(/&nbsp;/g, '\u00a0').replace(/&times;/g, '\u00d7').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

// 要素（名前・属性・中身の HTML）と、文字（直近の親要素つき）を並べる。コメントは読まない
function parseHtml(src) {
  const elements = [];
  const texts = [];
  const stack = [];
  for (const m of src.matchAll(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g)) {
    const tok = m[0];
    if (tok.startsWith('<!')) continue;
    if (tok.startsWith('</')) {
      const name = tok.slice(2, -1).trim().toLowerCase();
      while (stack.length) {
        const el = stack.pop();
        el.inner = src.slice(el.start, m.index);
        if (el.name === name) break;
      }
      continue;
    }
    if (tok.startsWith('<')) {
      const name = tok.match(/^<([\w-]+)/)[1].toLowerCase();
      const attrs = {};
      for (const a of tok.slice(1 + name.length).matchAll(/([^\s=/>]+)(?:="([^"]*)")?/g)) {
        attrs[a[1]] = a[2] === undefined ? '' : decodeEntities(a[2]);
      }
      const el = { name, attrs, start: m.index + tok.length, inner: '', parent: stack[stack.length - 1] || null };
      elements.push(el);
      if (!VOID.has(name) && !tok.endsWith('/>')) stack.push(el);
      continue;
    }
    texts.push({ text: decodeEntities(tok), parent: stack[stack.length - 1] || null });
  }
  return { elements, texts };
}

const PARSED = parseHtml(HTML);

// 起動時に script.js が logic.js の関数で書き換える要素（HTML の値は、その関数の日本語の結果と同じにしておく）
const DYNAMIC = {
  ultraNow: { text: () => logic.ultraNowText(logic.ULTRA_STATE.ON, null) },
  legendUltraText: { text: () => logic.ultraLegendText(logic.ULTRA_STATE.ON) },
  levelCanvas: { 'aria-label': () => logic.graphAriaLabel(logic.ULTRA_STATE.ON) },
  // メーターの説明は表示下限の数字が入るので、HTML には一般の言い方を置き、起動時に renderMeterScale が書き換える
  meter: { title: null }
};

function ancestorWith(el, attr) {
  for (let p = el; p; p = p.parent) if (Object.prototype.hasOwnProperty.call(p.attrs, attr)) return p;
  return null;
}

// ---- 辞書 ----

test('辞書：日英のキーと、置き換える値の名前がそろっていて、値は空でない', () => {
  assert.deepEqual(Object.keys(EN).sort(), Object.keys(JA).sort());
  for (const key of Object.keys(JA)) {
    assert.ok(JA[key].trim() && EN[key].trim(), `空の値: ${key}`);
    assert.deepEqual(M.placeholderNames(EN[key]), M.placeholderNames(JA[key]), `置き換える値の名前が違う: ${key}`);
  }
  assert.deepEqual(M.LANGS, ['ja', 'en']);
  assert.equal(M.DEFAULT_LANG, 'ja');
});

test('辞書：英語の値に日本語の文字（ひらがな・カタカナ・漢字・全角の記号）が無い', () => {
  for (const [key, value] of Object.entries(EN)) {
    assert.doesNotMatch(value, JAPANESE, `${key}: ${value}`);
  }
  // 検査の式そのものが日本語を拾えること（空振りしていない）
  for (const s of ['あ', 'ア', 'ｱ', '漢', '（', '：', '〜', '、', '※', '０']) assert.match(s, JAPANESE, s);
  for (const s of ['–', '→', '÷', '∞', '⚠', '✓', '🎯', '|', '"', '…']) assert.doesNotMatch(s, JAPANESE, s);
});

test('辞書：t は知らない言語・キー・足りない値を例外にし、{n|one|other} で英語の単数・複数を選ぶ', () => {
  assert.throws(() => M.t('fr', 'btn.stop'), RangeError);
  assert.throws(() => M.t('en', 'no.such.key'), /Unknown message/);
  assert.throws(() => M.t('en', 'status.exported'), /Missing parameter: count/);
  assert.equal(M.t('en', 'status.exported', { count: 1 }), EN['status.exported'].replace('{count} {count|row|rows}', '1 row'));
  assert.equal(M.t('en', 'status.exported', { count: 3 }), EN['status.exported'].replace('{count} {count|row|rows}', '3 rows'));
  assert.equal(M.t('ja', 'status.exported', { count: 3 }), JA['status.exported'].replace('{count}', '3'));
});

test('辞書：タグを含む値（data-i18n-rich）は <strong>・<code>・<em> だけで、入れ子にしない。文字だけの値にはタグが無い', () => {
  const richKeys = new Set(PARSED.elements.filter(e => e.attrs['data-i18n-rich']).map(e => e.attrs['data-i18n-rich']));
  assert.ok(richKeys.size > 40, `data-i18n-rich が少ない（${richKeys.size}）`);
  for (const key of richKeys) {
    for (const lang of M.LANGS) {
      const segs = M.richSegments(DICTIONARIES[lang][key]);
      assert.ok(segs.length > 0, `${lang} ${key}`);
      for (const s of segs) assert.ok(s.tag === null || M.RICH_TAGS.includes(s.tag), `${lang} ${key}: ${s.tag}`);
    }
    // 日英で強調（<strong>）の数をそろえる（見出しの「ラベル：」を片方だけ落とさない）
    const strong = (v) => M.richSegments(v).filter(s => s.tag === 'strong').length;
    assert.equal(strong(EN[key]), strong(JA[key]), `<strong> の数が日英で違う: ${key}`);
  }
  for (const [key, value] of Object.entries(EN)) {
    if (richKeys.has(key)) continue;
    assert.doesNotMatch(value, /<\/?(strong|code|em)>/, `文字だけの値にタグがある: ${key}`);
    assert.doesNotMatch(JA[key], /<\/?(strong|code|em)>/, `文字だけの値にタグがある: ${key}`);
  }
  assert.throws(() => M.richSegments('<strong>a<code>b</code></strong>'), /Nested/);
  assert.throws(() => M.richSegments('<strong>a'), /Unclosed/);
  assert.throws(() => M.richSegments('a<b>c</b>'), /Unknown markup/);
  assert.equal(M.richPlainText('<strong>A：</strong>b<code>c</code>'), 'A：bc');
});

test('辞書：用語（英語）は CLAUDE.md の一覧どおりで、使わないと決めた訳語が無い', () => {
  const at = CLAUDE_MD.indexOf('### 用語の一覧');
  assert.ok(at > 0, 'CLAUDE.md に用語の一覧が無い');
  // 表は次の見出しまで（ほかの節の表を読まない）
  const end = CLAUDE_MD.indexOf('\n#', at + 1);
  const rows = CLAUDE_MD.slice(at, end < 0 ? undefined : end).split('\n').filter(l => /^\| [^-|]/.test(l)).slice(1)
    .map(l => l.split('|').map(c => c.trim())).map(c => ({ ja: c[1], en: c[2].replace(/`/g, '') }))
    .filter(r => r.ja && r.en);
  assert.ok(rows.length >= 20, `用語の一覧が短い（${rows.length}行）`);
  const all = Object.values(EN).join('\n').toLowerCase();
  for (const r of rows) assert.ok(all.includes(r.en.toLowerCase()), `英語の辞書に「${r.en}」（${r.ja}）が無い`);
  // ボタンの名前は一覧の語そのもの
  const term = (ja) => rows.find(r => r.ja === ja).en;
  assert.equal(EN['btn.start'], term('記録開始'));
  assert.equal(EN['btn.stop'], term('停止'));
  assert.equal(EN['btn.export'], term('CSV書き出し'));
  assert.equal(EN['btn.reset'], term('統計リセット'));
  assert.equal(EN['btn.more'], term('その他'));
  // 使わない訳語（簡易モード・高精度モード・有効サンプル率の別の言い方、ハッシュチェーンの名乗りを超える語）
  for (const bad of [/simple mode/i, /lite mode/i, /high[- ]accuracy/i, /effective sample/i, /tamper/i, /detect/i]) {
    assert.doesNotMatch(Object.values(EN).join('\n'), bad);
  }
});

// CLAUDE.md の用語の一覧（表）を読む
function termRows() {
  const at = CLAUDE_MD.indexOf('### 用語の一覧');
  const end = CLAUDE_MD.indexOf('\n#', at + 1);
  return CLAUDE_MD.slice(at, end < 0 ? undefined : end).split('\n').filter(l => /^\| [^-|]/.test(l)).slice(1)
    .map(l => l.split('|').map(c => c.trim())).map(c => ({ ja: c[1], en: c[2].replace(/`/g, '') }))
    .filter(r => r.ja && r.en);
}

// 表の日本語を含むキーの英語に、表の英語が入っているかを見るときの例外（キー → 見ない日本語の用語と、その理由）
const TERM_EXCEPTIONS = {
  'stats.uptime.title': { ja: '記録開始', why: '「記録開始からの経過時間」の記録開始は時点を指す名詞で、ボタンの名前ではない（since recording started）' },
  'help.stats.uptime': { ja: '記録開始', why: '同上（ヘルプの稼働時間の説明）' }
};

test('辞書：用語の表の日本語を含むキーは、英語の値にも表の英語を含む（キーごとの対応）', () => {
  const rows = termRows();
  const plain = (v) => M.richPlainText(v);
  // 英語はタグを除き、小文字にし、ハイフンを空白にそろえる。表の英語は括弧の注記を除いた核で比べる
  const norm = (v) => plain(v).toLowerCase().replace(/-/g, ' ').replace(/\s+/g, ' ');
  const core = (en) => en.replace(/\s*\([^)]*\)/g, '').toLowerCase().replace(/-/g, ' ').trim();
  let checked = 0;
  const misses = [];
  for (const r of rows) {
    for (const key of Object.keys(JA)) {
      let ja = plain(JA[key]);
      if (!ja.includes(r.ja)) continue;
      // 表のもっと長い語（例：超音波帯の最大 → Ultrasonic max）の一部として出ているぶんは、その長い語の行で見る
      for (const longer of rows) {
        if (longer !== r && longer.ja.length > r.ja.length && longer.ja.includes(r.ja) && norm(EN[key]).includes(core(longer.en))) {
          ja = ja.split(longer.ja).join('');
        }
      }
      if (!ja.includes(r.ja)) continue;
      const ex = TERM_EXCEPTIONS[key];
      if (ex && ex.ja === r.ja) continue;
      checked += 1;
      if (!norm(EN[key]).includes(core(r.en))) misses.push(`${key}: 「${r.ja}」→「${core(r.en)}」が無い: ${plain(EN[key]).slice(0, 80)}`);
    }
  }
  assert.deepEqual(misses, []);
  assert.ok(checked > 100, `見たキーが少ない（${checked}）`);
  // 例外は、いまも日本語の用語を含み、英語の値に表の英語が無いものだけ（直ったら一覧から外す）
  for (const [key, ex] of Object.entries(TERM_EXCEPTIONS)) {
    const r = rows.find(x => x.ja === ex.ja);
    assert.ok(r && plain(JA[key]).includes(ex.ja), `例外の ${key} に「${ex.ja}」が無い`);
    assert.ok(!norm(EN[key]).includes(core(r.en)), `例外の ${key} は表の英語を含むので、一覧から外す`);
    assert.ok(ex.why, `例外の ${key} に理由が無い`);
  }
  // 検査が1か所の言い換えを拾うこと（点検の変異テストで素通りしていた2つ）
  const swapped = {
    'notice.valid.short': EN['notice.valid.short'].replace(/valid sample ratio/i, 'Effective ratio'),
    'notice.summary': EN['notice.summary'].replace(/recording notes/i, 'Recording warnings')
  };
  for (const [key, value] of Object.entries(swapped)) {
    const r = rows.find(x => plain(JA[key]).includes(x.ja) && norm(EN[key]).includes(core(x.en)));
    assert.ok(r, `${key} に表の語が無い`);
    assert.ok(!norm(value).includes(core(r.en)), `${key} の言い換えを拾えない`);
  }
});

test('辞書：日本語の値に、使わないと決めた語が無い', () => {
  const banned = ['効く', '効き', '効い', '走る', '走っ', '照合', '突き合わせ', '断定', '踏み込', '構図', '落とし穴', '破綻', '潰'];
  for (const [key, value] of Object.entries(JA)) {
    for (const w of banned) assert.ok(!value.includes(w), `「${w}」が入っている: ${key}`);
  }
});

// ---- index.html ----

test('index.html：画面に出る日本語は、すべて辞書のキー（data 属性）で差し替えられる', () => {
  for (const t of PARSED.texts) {
    if (!JAPANESE.test(t.text)) continue;
    const el = t.parent;
    const covered = (el && (el.attrs['data-i18n'] !== undefined || ancestorWith(el, 'data-i18n-rich')))
      || (el && DYNAMIC[el.attrs.id] && DYNAMIC[el.attrs.id].text);
    assert.ok(covered, `辞書のキーの無い文字: <${el ? el.name : '?'}> ${t.text.trim().slice(0, 60)}`);
  }
  for (const el of PARSED.elements) {
    for (const attr of I18N_ATTRS) {
      const v = el.attrs[attr];
      if (v === undefined || !JAPANESE.test(v)) continue;
      const covered = el.attrs[`data-i18n-${attr}`] !== undefined
        || (DYNAMIC[el.attrs.id] && Object.prototype.hasOwnProperty.call(DYNAMIC[el.attrs.id], attr));
      assert.ok(covered, `辞書のキーの無い属性: <${el.name} id="${el.attrs.id || ''}"> ${attr}="${v.slice(0, 40)}"`);
    }
  }
});

test('index.html：使っているキーは日英の辞書にあり、HTML の日本語は ja の値と同じ', () => {
  let n = 0;
  for (const el of PARSED.elements) {
    const key = el.attrs['data-i18n'];
    if (key !== undefined) {
      assert.ok(Object.prototype.hasOwnProperty.call(JA, key), `辞書に無いキー: ${key}`);
      assert.doesNotMatch(el.inner, /</, `data-i18n の要素に子要素がある（文字を入れ替えると消える）: ${key}`);
      assert.equal(decodeEntities(el.inner), JA[key], `HTML と辞書の日本語が違う: ${key}`);
      n += 1;
    }
    const rich = el.attrs['data-i18n-rich'];
    if (rich !== undefined) {
      assert.ok(Object.prototype.hasOwnProperty.call(JA, rich), `辞書に無いキー: ${rich}`);
      assert.equal(decodeEntities(el.inner), JA[rich], `HTML と辞書の日本語が違う: ${rich}`);
      n += 1;
    }
    for (const attr of I18N_ATTRS) {
      const k = el.attrs[`data-i18n-${attr}`];
      if (k === undefined) continue;
      assert.ok(Object.prototype.hasOwnProperty.call(JA, k), `辞書に無いキー: ${k}`);
      assert.equal(el.attrs[attr], JA[k], `HTML と辞書の日本語が違う: ${k}`);
      n += 1;
    }
  }
  assert.ok(n > 100, `辞書のキーを付けた箇所が少ない（${n}）`);
  // 起動時に logic.js の関数で書き換える要素は、HTML の値をその関数の日本語の結果とそろえる（読み込み直後に文字が変わらない）
  for (const [id, spec] of Object.entries(DYNAMIC)) {
    const el = PARSED.elements.find(e => e.attrs.id === id);
    assert.ok(el, `#${id} が無い`);
    if (spec.text) assert.equal(decodeEntities(el.inner), spec.text(), `#${id} の初期の文字`);
    if (spec['aria-label']) assert.equal(el.attrs['aria-label'], spec['aria-label'](), `#${id} の初期の aria-label`);
  }
  assert.match(SCRIPT, /meterEl\.title = tr\('meter\.title', \{ floor: labels\[0\] \}\);/);
});

test('index.html：言語の切り替えボタンはヘッダーの右上にあり、.actions の行（幅480px以下で1行）には入れない', () => {
  const header = HTML.slice(HTML.indexOf('<header class="app-header">'), HTML.indexOf('</header>'));
  assert.match(header, /<button id="langToggle" class="lang-toggle" type="button"[^>]*data-i18n="lang\.toggle"[^>]*>EN<\/button>/);
  const actions = HTML.slice(HTML.indexOf('<div class="actions">'), HTML.indexOf('<section class="card grid">'));
  assert.doesNotMatch(actions, /langToggle/);
  // 文字は切り替え先の言語（日本語の表示ではEN、英語の表示ではJA）
  assert.equal(JA['lang.toggle'], 'EN');
  assert.equal(EN['lang.toggle'], 'JA');
  // messages.js は logic.js より先に読む（logic.js が文言を組み立てるときに使う）
  const order = ['messages.js', 'logic.js', 'script.js'].map(f => HTML.indexOf(`<script src="./${f}?v=`));
  assert.ok(order.every(i => i > 0) && order[0] < order[1] && order[1] < order[2], `script タグの順: ${order}`);
});

test('言語の切り替えボタン：名前（aria-label）は見えている文字（EN／JA）で始まる（WCAG 2.5.3 Label in Name）', () => {
  for (const lang of M.LANGS) {
    const d = DICTIONARIES[lang];
    assert.ok(d['lang.toggle.aria'].startsWith(d['lang.toggle']), `${lang}: 「${d['lang.toggle.aria']}」が「${d['lang.toggle']}」で始まらない`);
  }
  const el = PARSED.elements.find(e => e.attrs.id === 'langToggle');
  assert.ok(el.attrs['aria-label'].startsWith(decodeEntities(el.inner)), 'index.html の aria-label が見えている文字で始まらない');
});

test('英語の単数・複数：1区間・2区間でも「all 1」「those intervals」などが出ない', () => {
  // 記録の穴の1行：区間が1つ・2つ・3つ（どれも穴なし）
  for (const n of [1, 2, 3]) {
    const s = statsOf(Array.from({ length: n }, (_, i) => recordOf(i)));
    const text = logic.statsIntegrity(s, 'en').text;
    assert.ok(text.includes(M.t('en', 'integrity.validAll', { known: n })), text);
    assert.doesNotMatch(text, /\ball [12]\b/, text);
  }
  // 注意書き：該当する区間が1つのときは単数で言う
  const single = {
    lowValidMissing: statsOf([recordOf(0, { count: 0, sumSq: 0 })]),
    lowValid: statsOf([recordOf(0, { count: 47000 })]),
    lowBand: statsOf([recordOf(0, { bandFrames: 100, bandExpected: 188 })]),
    clip: statsOf([recordOf(0, { peak: 1, clip: 5, clipRun: 5 })])
  };
  for (const [k, s] of Object.entries(single)) {
    const texts = logic.statsWarningItems(s, 'en').flatMap(it => [it.short, it.full]).concat(logic.statsIntegrity(s, 'en').text);
    assert.ok(texts.length > 1, k);
    for (const t of texts) assert.doesNotMatch(t, /\bthose intervals\b|\bof them\b|\b1 intervals\b/i, `${k}: ${t}`);
  }
  // 状態を網羅した英語の文言でも、数と名詞の数が合う
  for (const t of allTexts('en')) {
    assert.doesNotMatch(t.text, /\b1 (intervals|samples|rows)\b|\ball 1\b/, `${t.where}: ${t.text}`);
    assert.doesNotMatch(t.text, /(?<![\d.])(0|[2-9]|\d{2,}) (interval|sample|row)\b(?!s)/, `${t.where}: ${t.text}`);
  }
});

test('フッター：要素のあいだに空白を置かず、英語の括弧の内側に空白が出ない（日本語は「（ … ）」のまま）', () => {
  // HTML の span と a のあいだの空白は、どちらの言語でも同じ文字として残るので置かない。空白が要るなら辞書の値に入れる
  assert.match(HTML, /<span data-i18n="footer\.repoLead">[^<]*<\/span><a [^>]*>ipusiron\/mic-gain-logger<\/a><span data-i18n="footer\.repoTail">/);
  const footerText = (lang) => {
    const page = openPage({ search: `?lang=${lang}`, languages: ['ja-JP'] });
    return page.doc.querySelector('.footer').textContent.trim();
  };
  for (const lang of M.LANGS) {
    const d = DICTIONARIES[lang];
    assert.equal(footerText(lang), d['footer.repoLead'] + 'ipusiron/mic-gain-logger' + d['footer.repoTail']);
  }
  assert.doesNotMatch(footerText('en'), /\( | \)/);
});

test('style.css：言語の切り替えは幅の@mediaより前に基本の規則があり、幅480px以下では44pxにする', () => {
  const stripped = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const firstMedia = stripped.search(/@media\s*\(\s*max-width/);
  const base = stripped.indexOf('.lang-toggle{');
  assert.ok(base > 0 && base < firstMedia, '.lang-toggle の基本の規則が@mediaの後ろにある');
  assert.match(stripped.slice(base, stripped.indexOf('}', base)), /position:absolute/);
  const compact = stripped.slice(stripped.search(/@media\s*\(max-width:\s*480px\)/));
  const rule = compact.match(/\.lang-toggle\s*\{([^}]*)\}/);
  assert.ok(rule, '幅480px以下の .lang-toggle の規則が無い');
  for (const prop of ['min-width', 'min-height']) {
    const v = parseFloat((rule[1].match(new RegExp(`${prop}:\\s*([\\d.]+)px`)) || [])[1]);
    assert.ok(v >= 44, `.lang-toggle の ${prop} が ${v}px`);
  }
  // 色はテーマのトークンだけ（両テーマの定義は test/contrast.test.js が見ている）
  assert.doesNotMatch(stripped.slice(base, stripped.indexOf('}', base)), /#[0-9a-fA-F]{3,6}\b/);
});

// ---- script.js・logic.js ----

// JS の文字列リテラル（'…'・"…"・`…`）を、コメント・正規表現を飛ばして並べる
function stringLiterals(src) {
  const out = [];
  let i = 0;
  let line = 1;
  let last = '';
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line += 1; i += 1; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      line += (src.slice(i, e).match(/\n/g) || []).length;
      i = e + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c) { if (src[j] === '\\') j += 1; j += 1; }
      out.push({ line, text: src.slice(i, j + 1) });
      i = j + 1; last = 'str';
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      const startLine = line;
      let depth = 0;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '`' && depth === 0) break;
        if (src[j] === '$' && src[j + 1] === '{') { depth += 1; j += 2; continue; }
        if (src[j] === '}' && depth > 0) { depth -= 1; j += 1; continue; }
        if (src[j] === '\n') line += 1;
        j += 1;
      }
      out.push({ line: startLine, text: src.slice(i, j + 1) });
      i = j + 1; last = 'str';
      continue;
    }
    if (c === '/' && (/[=(,:;!&|?{}[+\-*%<>~^]$/.test(last) || last === '' || last === 'return')) {
      let j = i + 1;
      let cls = false;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') cls = true;
        else if (src[j] === ']') cls = false;
        else if (src[j] === '/' && !cls) break;
        j += 1;
      }
      i = j + 1; last = 'rx';
      continue;
    }
    if (!/\s/.test(c)) {
      if (/[A-Za-z0-9_$]/.test(c)) {
        let j = i;
        while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j += 1;
        last = src.slice(i, j);
        i = j;
        continue;
      }
      last = c;
    }
    i += 1;
  }
  return out;
}

test('script.js と logic.js：コメントの外に日本語の文字列が無い（画面の文言は辞書から引く）', () => {
  for (const [name, src] of [['script.js', SCRIPT], ['logic.js', LOGIC]]) {
    const lits = stringLiterals(src);
    assert.ok(lits.length > 50, `${name} の文字列の読み取りが空振りしている（${lits.length}）`);
    const hits = lits.filter(l => JAPANESE.test(l.text)).map(l => `${name}:${l.line} ${l.text.slice(0, 60)}`);
    assert.deepEqual(hits, []);
  }
  // 読み取りそのものが日本語の文字列を拾えること（コメントは飛ばす）
  const probe = stringLiterals("// 'コメント'\nconst a = 'あ'; /* \"い\" */ const b = `う${x}`; const r = /え/;");
  assert.deepEqual(probe.map(p => p.text), ["'あ'", '`う${x}`']);
});

test('logic.js：文言は辞書から引き、CSV を組み立てる関数は辞書を使わない（CSV の中身は言語によらず同じ）', () => {
  assert.match(LOGIC, /const Messages = \(typeof MicGainMessages !== 'undefined'\) \? MicGainMessages : require\('\.\/messages\.js'\);/);
  const bodyOf = (name) => {
    const start = LOGIC.indexOf(`  function ${name}(`);
    assert.ok(start > 0, `${name} が無い`);
    const end = LOGIC.indexOf('\n  }\n', start);
    return LOGIC.slice(start, end);
  };
  for (const name of ['csvHeaderLines', 'csvTrailerLines', 'clockTrailerLines', 'buildCsv', 'csvFileName', 'metaLine',
    'chainHeaderMeta', 'csvDataFields', 'formatCsvDb', 'processingLabel', 'settingsRawLabel', 'bandsLabel']) {
    assert.doesNotMatch(bodyOf(name), /\bmsg\(|Messages\./, `${name} が辞書を使っている`);
  }
  // messages.js は DOM・window・navigator・localStorage に触らない（コメントの外）
  const code = MESSAGES.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  assert.doesNotMatch(code, /\b(document|window|navigator|localStorage|location)\s*\./);
});

// logic.js の文言を返す関数を、状態を網羅して呼ぶ
function recordOf(seq, over) {
  const SR = 48000;
  const rms = 0.1;
  const msg = Object.assign({
    type: 'interval', seq, sampleRate: SR, startFrame: seq * SR, endFrame: (seq + 1) * SR,
    expected: SR, count: SR, sumSq: SR * rms * rms, peak: rms * Math.SQRT2, clip: 0, emittedAt: seq + 1,
    bandPower: [1e-6 * 256, 1e-3 * 256], bandFrames: 256, bandExpected: 256
  }, over);
  return logic.buildIntervalRecord(msg, { epoch: 0, audioTime: 0, wallMs: Date.UTC(2026, 8, 29) }, -110);
}
function statsOf(recs) {
  const s = logic.createStats();
  for (const r of recs) logic.addStatsRecord(s, r);
  return s;
}
function metaOf(over) {
  return logic.buildSessionMeta(Object.assign({
    id: 's1', startedWallMs: 0, engine: logic.ENGINE_WORKLET, contextSampleRate: 48000,
    settings: { echoCancellation: false, autoGainControl: false, noiseSuppression: false, sampleRate: 48000 },
    bandsEnabled: true
  }, over));
}

function allTexts(lang) {
  const out = [];
  const noticeKinds = new Set();
  const push = (where, v) => out.push({ where, text: String(v) });
  const S = logic.ULTRA_STATE;
  const recs = {
    none: null,
    sec1: recordOf(0),
    noValue: recordOf(0, { bandFrames: 0 }),
    silent: recordOf(0, { sumSq: 0, bandPower: [0, 0] }),
    sec3: Object.assign(recordOf(0), { intervalSec: 3 })
  };
  for (const state of Object.values(S)) {
    push(`ultraLegendText ${state}`, logic.ultraLegendText(state, lang));
    push(`graphAriaLabel ${state}`, logic.graphAriaLabel(state, lang));
    for (const [k, rec] of Object.entries(recs)) push(`ultraNowText ${state} ${k}`, logic.ultraNowText(state, rec, lang));
  }
  for (const m of [
    {}, { contextSampleRate: 48000 }, { contextSampleRate: 48000, trackSampleRate: 48000 },
    { contextSampleRate: 48000, trackSampleRate: 44100 }, { contextSampleRate: 44100, trackSampleRate: 48000 }
  ]) push(`upperLimitText ${JSON.stringify(m)}`, logic.upperLimitText(m, lang));
  push('bandRangeLabel', logic.bandRangeLabel(logic.BAND_DEFS[0], lang));

  const statsCases = {
    empty: statsOf([]),
    clean: statsOf([recordOf(0), recordOf(1)]),
    clipSingle: statsOf([recordOf(0, { peak: 1, clip: 1, clipRun: 1 }), recordOf(1)]),
    clipSustained: statsOf([recordOf(0, { peak: 1, clip: 5, clipRun: 5 }), recordOf(1, { peak: 1, clip: 1, clipRun: 1 })]),
    clipTiny: statsOf([recordOf(0, { peak: 1, clip: 1, clipRun: 1, count: 48000 * 10, expected: 48000 * 10 })]),
    lowValid: statsOf([recordOf(0, { count: 47000 }), recordOf(1, { count: 0, sumSq: 0 })]),
    lowBand: statsOf([recordOf(0, { bandFrames: 100, bandExpected: 188 })]),
    fallback: statsOf([logic.buildFallbackRecord({
      seq: 0, db: -40, floorDb: -110, startTime: 0, endTime: 1, startWallMs: 0, endWallMs: 1000,
      expectedSamples: 48000, intervalSec: 1, clockEpoch: 0, clockBreak: null, meta: null
    })]),
    mixed: (() => {
      const s = statsOf([recordOf(0)]);
      logic.addStatsRecord(s, logic.buildFallbackRecord({
        seq: 1, db: -40, floorDb: -110, startTime: 1, endTime: 2, startWallMs: 1000, endWallMs: 2000,
        expectedSamples: 48000, intervalSec: 1, clockEpoch: 0, clockBreak: null, meta: null
      }));
      return s;
    })()
  };
  for (const [k, s] of Object.entries(statsCases)) {
    push(`statsIntegrity ${k}`, logic.statsIntegrity(s, lang).text);
    for (const it of logic.statsWarningItems(s, lang)) { push(`statsWarningItems ${k} short`, it.short); push(`statsWarningItems ${k} full`, it.full); }
    push(`statsWarnings ${k}`, logic.statsWarnings(s, lang).join('\n'));
  }

  const metas = {
    on: metaOf(),
    mismatch: metaOf({ settings: { sampleRate: 44100 } }),
    mismatchBelow: metaOf({ settings: { sampleRate: 32000 } }),
    off: metaOf({ bandsEnabled: false }),
    fallback: metaOf({ engine: logic.ENGINE_FALLBACK }),
    noBins: metaOf({ contextSampleRate: 16000, settings: { sampleRate: 16000 } }),
    processingActive: metaOf({ settings: { echoCancellation: true, autoGainControl: true, noiseSuppression: false } }),
    processingUnknown: metaOf({ settings: { echoCancellation: false } })
  };
  const inputs = [
    { deviceLoss: { reason: logic.DEVICE_LOST_ENDED, rowsKept: 12 } },
    { deviceLoss: { reason: logic.DEVICE_LOST_GONE, rowsKept: 1 } },
    { deviceMuted: true },
    { clockBreaks: [{ jumpMs: 1500 }, { jumpMs: 250 }] },
    { clockBreaks: [{ jumpMs: 400 }] },
    { stats: statsCases.clipSustained },
    { stats: statsCases.lowValid },
    { stats: statsCases.lowBand }
  ];
  for (const [k, meta] of Object.entries(metas)) {
    for (const it of logic.bandNoticeItems(meta, lang)) { push(`bandNoticeItems ${k}`, it.short); push(`bandNoticeItems ${k}`, it.full); }
    inputs.push({ sessionMeta: meta });
  }
  for (const input of inputs) {
    const items = logic.recordNoticeItems(Object.assign({ lang }, input));
    for (const it of items) {
      push(`recordNoticeItems ${JSON.stringify(Object.keys(input))}`, it.short);
      push('recordNoticeItems full', it.full);
      noticeKinds.add(it.kind || 'stats');
    }
    push('noticeSummary', logic.noticeSummary(items, lang));
  }
  out.noticeKinds = noticeKinds;
  return out;
}

test('logic.js：文言を返す関数を英語で呼ぶと、どの状態でも日本語が出ない', () => {
  const texts = allTexts('en');
  assert.ok(texts.length > 100, `呼んだ数が少ない（${texts.length}）`);
  // 注意書きの項目を、種類ごとにすべて通している（kind の無いクリップ・有効サンプル率は 'stats'）
  for (const kind of ['deviceLoss', 'deviceMuted', 'processingActive', 'processingUnknown', 'sampleRateMismatch',
    'bandsOff', 'bandsFallback', 'ultraUnavailable', 'clockBreak', 'bandValid', 'stats']) {
    assert.ok(texts.noticeKinds.has(kind), `注意書きの「${kind}」を通していない`);
  }
  const kinds = new Set(texts.filter(t => t.text).map(t => t.where.split(' ')[0]));
  for (const fn of ['ultraLegendText', 'graphAriaLabel', 'ultraNowText', 'upperLimitText', 'bandRangeLabel',
    'statsIntegrity', 'statsWarningItems', 'bandNoticeItems', 'recordNoticeItems', 'noticeSummary']) {
    assert.ok(kinds.has(fn), `${fn} を呼べていない（または空の文言しか返していない）`);
  }
  for (const t of texts) assert.doesNotMatch(t.text, JAPANESE, `${t.where}: ${t.text}`);
  // ごく少ないクリップの割合（formatShare の「未満」）も通っている
  assert.ok(texts.some(t => t.where.startsWith('statsWarningItems clipTiny') && t.text.includes(EN['share.tiny'])), 'clipTiny が「<0.01%」を通っていない');
  // 日本語で呼ぶと日本語が出る（言語を省略したときと同じ）ことも、同じ網羅で見る
  const ja = allTexts('ja');
  const def = allTexts(undefined);
  assert.deepEqual(def.map(t => t.text), ja.map(t => t.text));
  assert.ok(ja.some(t => JAPANESE.test(t.text)));
  // 英語の文言は、同じ状態の日本語と同じ数だけ出る（片方の言語だけ項目が増減しない）
  assert.equal(texts.length, ja.length);
  for (let i = 0; i < ja.length; i++) assert.equal(texts[i].text === '', ja[i].text === '', ja[i].where);
});

test('logic.js：項目の kind・記録の穴の level は言語によらない', () => {
  const stats = statsOf([recordOf(0, { peak: 1, clip: 5, clipRun: 5 }), recordOf(1, { count: 0, sumSq: 0 }),
    recordOf(2, { bandFrames: 100, bandExpected: 188 })]);
  const input = { sessionMeta: metaOf({ settings: { sampleRate: 44100, echoCancellation: false } }), stats, deviceMuted: true,
    clockBreaks: [{ jumpMs: 900 }] };
  const kinds = (lang) => logic.recordNoticeItems(Object.assign({ lang }, input)).map(it => it.kind || null);
  assert.deepEqual(kinds('en'), kinds('ja'));
  assert.equal(logic.statsIntegrity(stats, 'en').level, logic.statsIntegrity(stats, 'ja').level);
});

// ---- 言語の決め方 ----

test('言語の決め方：?lang= → 保存した選択 → ブラウザーの言語（先頭が日本語なら日本語、それ以外は英語）', () => {
  const cases = [
    // [search, saved, languages, expected]
    ['?lang=en', 'ja', ['ja-JP'], 'en'],
    ['?lang=ja', 'en', ['en-US'], 'ja'],
    ['?lang=EN', null, ['ja'], 'en'],
    ['?bands=off&lang=en', null, ['ja'], 'en'],
    ['?lang=fr', 'en', ['ja'], 'en'],        // 知らない ?lang= は飛ばして、保存した選択へ
    ['?lang=', null, ['ja-JP'], 'ja'],
    ['', 'en', ['ja-JP'], 'en'],
    ['', 'ja', ['en-US'], 'ja'],
    ['', 'xx', ['ja-JP'], 'ja'],             // 保存した値が壊れていたら、ブラウザーの言語へ
    ['', null, ['ja-JP', 'en'], 'ja'],
    ['', null, ['ja'], 'ja'],
    ['', null, ['en-US', 'ja-JP'], 'en'],    // 先頭だけを見る
    ['', null, ['fr-FR'], 'en'],
    ['', null, ['jav'], 'en'],               // ja で始まっても別の言語（ジャワ語）
    ['', null, [], 'en'],
    ['', null, undefined, 'en'],
    ['', null, 'ja-JP', 'ja']                // navigator.language を1つだけ渡したとき
  ];
  for (const [search, saved, languages, expected] of cases) {
    assert.equal(M.initialLang({ search, saved, languages }), expected, JSON.stringify([search, saved, languages]));
  }
  // 順番を式から確かめる：?lang= があればそれ、無ければ保存、どちらも無ければブラウザー
  for (const q of [null, 'ja', 'en']) {
    for (const s of [null, 'ja', 'en']) {
      for (const nav of [['ja-JP'], ['en-US']]) {
        const want = q || s || (nav[0].startsWith('ja') ? 'ja' : 'en');
        assert.equal(M.initialLang({ search: q ? `?lang=${q}` : '', saved: s, languages: nav }), want);
      }
    }
  }
});

test('言語を切り替えたときの URL：?lang= があれば書き換え、無ければそのまま（?bands=off は変えない）', () => {
  assert.equal(M.searchWithLang('?lang=ja', 'en'), '?lang=en');
  assert.equal(M.searchWithLang('?bands=off&lang=ja', 'en'), '?bands=off&lang=en');
  assert.equal(M.searchWithLang('?bands=off', 'en'), '?bands=off');
  assert.equal(M.searchWithLang('', 'ja'), '');
});

// ---- script.js を偽の DOM で動かす ----
//
// index.html を要素の木にし、messages.js・logic.js・script.js を同じ node:vm の文脈で読む（ブラウザーと同じ順）。
// マイクは無い（navigator.mediaDevices が無い）ので、起動すると「対応していません」の状態になる。

class FakeText {
  constructor(data) { this.nodeType = 3; this.data = String(data); this.parentNode = null; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}

class FakeElement {
  constructor(doc, name, attrs) {
    this.nodeType = 1;
    this.ownerDocument = doc;
    this.localName = name;
    this.tagName = name.toUpperCase();
    this.attrs = new Map(Object.entries(attrs || {}));
    this.childNodes = [];
    this.parentNode = null;
    this.listeners = {};
    this.style = {};
    this.open = false;
    const el = this;
    this.classList = {
      list: () => (el.getAttribute('class') || '').split(/\s+/).filter(Boolean),
      add(...c) { el.setAttribute('class', [...new Set(this.list().concat(c))].join(' ')); },
      remove(...c) { el.setAttribute('class', this.list().filter(x => !c.includes(x)).join(' ')); },
      contains(c) { return this.list().includes(c); },
      toggle(c, force) {
        const on = force === undefined ? !this.contains(c) : !!force;
        if (on) this.add(c); else this.remove(c);
        return on;
      }
    };
    this.dataset = new Proxy({}, {
      get: (_, k) => el.getAttribute('data-' + String(k).replace(/[A-Z]/g, ch => '-' + ch.toLowerCase())) ?? undefined
    });
  }
  getAttribute(n) { return this.attrs.has(n) ? this.attrs.get(n) : null; }
  setAttribute(n, v) { this.attrs.set(n, String(v)); }
  removeAttribute(n) { this.attrs.delete(n); }
  hasAttribute(n) { return this.attrs.has(n); }
  get id() { return this.getAttribute('id') || ''; }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v); }
  get lang() { return this.getAttribute('lang') || ''; }
  set lang(v) { this.setAttribute('lang', v); }
  get title() { return this.getAttribute('title') || ''; }
  set title(v) { this.setAttribute('title', v); }
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(v) { if (v) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
  get disabled() { return this.hasAttribute('disabled'); }
  set disabled(v) { if (v) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }
  get value() { return this._value !== undefined ? this._value : (this.getAttribute('value') || ''); }
  set value(v) { this._value = String(v); }
  get defaultValue() { return this.getAttribute('value') || ''; }
  set defaultValue(v) { this.setAttribute('value', v); }
  get width() { return Number(this.getAttribute('width')) || 0; }
  set width(v) { this.setAttribute('width', v); }
  get height() { return Number(this.getAttribute('height')) || 0; }
  set height(v) { this.setAttribute('height', v); }
  get textContent() { return this.childNodes.map(c => c.textContent).join(''); }
  set textContent(v) { this.replaceChildren(new FakeText(v)); }
  get children() { return this.childNodes.filter(c => c.nodeType === 1); }
  get lastElementChild() { const c = this.children; return c[c.length - 1] || null; }
  appendChild(n) { if (n.parentNode) n.parentNode.childNodes.splice(n.parentNode.childNodes.indexOf(n), 1); n.parentNode = this; this.childNodes.push(n); return n; }
  append(...ns) { for (const n of ns) this.appendChild(n); }
  replaceChildren(...ns) { for (const c of this.childNodes) c.parentNode = null; this.childNodes = []; this.append(...ns); }
  remove() { if (this.parentNode) { this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1); this.parentNode = null; } }
  contains(n) { for (let p = n; p; p = p.parentNode) if (p === this) return true; return false; }
  descendants() { const out = []; for (const c of this.children) { out.push(c); out.push(...c.descendants()); } return out; }
  matches(sel) {
    const m = sel.match(/^\[([\w-]+)\]$/);
    if (m) return this.hasAttribute(m[1]);
    if (sel.startsWith('.')) return this.classList.contains(sel.slice(1));
    if (sel.startsWith('#')) return this.id === sel.slice(1);
    return this.localName === sel.toLowerCase();
  }
  querySelectorAll(sel) { return this.descendants().filter(e => e.matches(sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  removeEventListener() {}
  click() { for (const fn of this.listeners.click || []) fn({ isTrusted: true, target: this }); }
  focus() { this.ownerDocument.activeElement = this; }
  getBoundingClientRect() { return { width: 320, height: 120, x: 0, y: 0, top: 0, left: 0 }; }
  getContext() {
    return new Proxy({}, {
      get: (target, k) => (k in target ? target[k] : (k === 'measureText' ? () => ({ width: 20 }) : () => {})),
      set: (target, k, v) => { target[k] = v; return true; }
    });
  }
}

function buildDocument(src) {
  const doc = { activeElement: null, listeners: {}, visibilityState: 'visible' };
  const root = new FakeElement(doc, '#root', {});
  const stack = [root];
  for (const m of src.matchAll(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g)) {
    const tok = m[0];
    if (tok.startsWith('<!')) continue;
    if (tok.startsWith('</')) {
      const name = tok.slice(2, -1).trim().toLowerCase();
      while (stack.length > 1) { const el = stack.pop(); if (el.localName === name) break; }
      continue;
    }
    if (tok.startsWith('<')) {
      const name = tok.match(/^<([\w-]+)/)[1].toLowerCase();
      const attrs = {};
      for (const a of tok.slice(1 + name.length).matchAll(/([^\s=/>]+)(?:="([^"]*)")?/g)) {
        attrs[a[1]] = a[2] === undefined ? '' : decodeEntities(a[2]);
      }
      const el = new FakeElement(doc, name, attrs);
      stack[stack.length - 1].appendChild(el);
      if (!VOID.has(name) && !tok.endsWith('/>')) stack.push(el);
      continue;
    }
    stack[stack.length - 1].appendChild(new FakeText(decodeEntities(tok)));
  }
  doc.root = root;
  doc.documentElement = root.querySelector('html');
  doc.body = root.querySelector('body');
  doc.activeElement = doc.body;
  doc.getElementById = (id) => root.descendants().find(e => e.id === id) || null;
  doc.querySelectorAll = (sel) => root.querySelectorAll(sel);
  doc.querySelector = (sel) => root.querySelector(sel);
  doc.createElement = (name) => new FakeElement(doc, name, {});
  doc.createTextNode = (data) => new FakeText(data);
  doc.addEventListener = (type, fn) => { (doc.listeners[type] = doc.listeners[type] || []).push(fn); };
  return doc;
}

// ページを1回開く。storage は { value } か 'throw'（読み書きが例外を投げる）
// env は sandbox へ足すもの（偽のマイク・AudioContext・タイマーなど。mediaDevices は navigator に入れる）
function openPage({ search = '', saved = null, languages = ['ja-JP'], language, storage, env } = {}) {
  const doc = buildDocument(HTML);
  const store = new Map();
  if (saved !== null) store.set(M.LANG_STORAGE_KEY, saved);
  const localStorage = storage === 'throw'
    ? { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } }
    : { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  const urls = [];
  const location = { search, hash: '' };
  const sandbox = {
    document: doc,
    navigator: { languages, language: language || (languages && languages[0]) || '', userAgent: 'test' },
    localStorage,
    location,
    history: { state: null, replaceState(state, title, url) { urls.push(url); } },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    devicePixelRatio: 1,
    performance: { now: () => 0 },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    URLSearchParams,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    addEventListener() {}
  };
  if (env) {
    const { mediaDevices, ...rest } = env;
    if (mediaDevices) sandbox.navigator.mediaDevices = mediaDevices;
    Object.assign(sandbox, rest);
  }
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const f of ['messages.js', 'logic.js', 'script.js']) vm.runInContext(read(f), sandbox, { filename: f });
  return { doc, sandbox, store, urls, html: doc.documentElement };
}

// 表示している文字と、訳す属性をすべて集める（非表示の要素も含める）
function pageStrings(doc) {
  const out = [];
  const walk = (node) => {
    for (const c of node.childNodes) {
      if (c.nodeType === 3) { if (c.data.trim()) out.push({ where: `<${node.localName} id="${node.id}">`, text: c.data }); continue; }
      for (const attr of I18N_ATTRS) {
        const v = c.getAttribute(attr);
        if (v) out.push({ where: `<${c.localName} id="${c.id}"> ${attr}`, text: v });
      }
      walk(c);
    }
  };
  walk(doc.root);
  return out;
}

test('script.js：初期言語を ?lang= → 保存した選択 → ブラウザーの言語で決め、<html lang> と画面をその言語にする', () => {
  const cases = [
    [{ search: '?lang=en', saved: 'ja', languages: ['ja-JP'] }, 'en'],
    [{ search: '?lang=ja', saved: 'en', languages: ['en-US'] }, 'ja'],
    [{ saved: 'en', languages: ['ja-JP'] }, 'en'],
    [{ saved: 'ja', languages: ['en-US'] }, 'ja'],
    [{ languages: ['en-US', 'ja'] }, 'en'],
    [{ languages: ['ja-JP'] }, 'ja'],
    [{ languages: [], language: 'ja' }, 'ja'],
    // localStorage が例外を投げても、?lang= とブラウザーの言語で決まり、画面は動く
    [{ storage: 'throw', languages: ['en-US'] }, 'en'],
    [{ storage: 'throw', search: '?lang=ja', languages: ['en-US'] }, 'ja']
  ];
  for (const [opts, expected] of cases) {
    const page = openPage(opts);
    assert.equal(page.html.getAttribute('lang'), expected, JSON.stringify(opts));
    const start = page.doc.getElementById('startBtn');
    assert.equal(start.textContent, M.t(expected, 'btn.start'));
    assert.equal(page.doc.getElementById('status').textContent, M.t(expected, 'status.unsupported'));
    assert.equal(page.doc.getElementById('langToggle').textContent, M.t(expected, 'lang.toggle'));
  }
});

test('script.js：英語の表示では、ページのどこにも日本語の文字が残らない（非表示の要素・title・aria-label を含む）', () => {
  const page = openPage({ search: '?lang=en', languages: ['ja-JP'] });
  const strings = pageStrings(page.doc);
  assert.ok(strings.length > 150, `集めた文字が少ない（${strings.length}）`);
  const hits = strings.filter(s => JAPANESE.test(s.text)).map(s => `${s.where}: ${s.text.slice(0, 50)}`);
  assert.deepEqual(hits, []);
  // ヘルプ（非表示のモーダル）・「その他」の中身・説明と注意事項も英語になっている
  assert.equal(page.doc.getElementById('helpModalTitle').textContent, EN['help.title']);
  assert.equal(page.doc.getElementById('exportBtn').textContent, EN['btn.export']);
  const notes = page.doc.querySelector('details');
  assert.equal(notes.querySelector('summary').textContent, EN['notes.summary']);
  // タグを含む文言は要素として組み立てる（<strong> がそのまま文字で出ない）
  const li = page.doc.querySelectorAll('[data-i18n-rich]').find(e => e.getAttribute('data-i18n-rich') === 'help.stats.ultraMax');
  assert.equal(li.textContent, M.richPlainText(EN['help.stats.ultraMax']));
  assert.deepEqual(li.children.map(c => c.localName), M.richSegments(EN['help.stats.ultraMax']).filter(s => s.tag).map(s => s.tag));
});

test('script.js：ボタンで切り替えると <html lang> と画面が変わり、選択を保存し、日本語へ戻すと HTML の文言に戻る', () => {
  const page = openPage({ search: '?bands=off&lang=ja', languages: ['ja-JP'] });
  const before = pageStrings(page.doc).map(s => s.text);
  assert.equal(page.html.getAttribute('lang'), 'ja');
  const toggle = page.doc.getElementById('langToggle');
  toggle.click();
  assert.equal(page.html.getAttribute('lang'), 'en');
  assert.equal(page.store.get(M.LANG_STORAGE_KEY), 'en');
  // ?lang= を書き換える（再読み込みで戻らないように）。?bands=off は残す
  assert.deepEqual(page.urls, ['?bands=off&lang=en']);
  assert.equal(toggle.textContent, 'JA');
  assert.equal(toggle.getAttribute('aria-label'), EN['lang.toggle.aria']);
  const en = pageStrings(page.doc);
  assert.deepEqual(en.filter(s => JAPANESE.test(s.text)).map(s => s.where), []);
  // ?bands=off の凡例・キャンバスの説明も英語で描き直す
  assert.equal(page.doc.getElementById('legendUltraText').textContent, logic.ultraLegendText(logic.ULTRA_STATE.OFF, 'en'));
  assert.equal(page.doc.getElementById('levelCanvas').getAttribute('aria-label'), logic.graphAriaLabel(logic.ULTRA_STATE.OFF, 'en'));
  toggle.click();
  assert.equal(page.html.getAttribute('lang'), 'ja');
  assert.equal(page.store.get(M.LANG_STORAGE_KEY), 'ja');
  assert.deepEqual(pageStrings(page.doc).map(s => s.text), before);
});

test('script.js：保存できない環境でも、ボタンで切り替えられる', () => {
  const page = openPage({ storage: 'throw', languages: ['ja-JP'] });
  page.doc.getElementById('langToggle').click();
  assert.equal(page.html.getAttribute('lang'), 'en');
  assert.equal(page.doc.getElementById('startBtn').textContent, EN['btn.start']);
});

test('script.js：言語の切り替えは表示だけを描き直し、記録・統計・グラフの点・ハッシュチェーンに触らない', () => {
  const start = SCRIPT.indexOf('function applyLanguage()');
  const end = SCRIPT.indexOf('if (langToggle) langToggle.addEventListener', start);
  assert.ok(start > 0 && end > start);
  const body = SCRIPT.slice(start, end).split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  assert.doesNotMatch(body, /\b(logs|series|hashChain|seqBase|seqMax|seqCounter|sessionMeta|lastRecord|deviceLoss|clockBreaks)\s*(=|\.(push|length\s*=|reset|begin|extend))/);
  assert.doesNotMatch(body, /\b(resetStats|resetAllStats|createStats|addStatsRecord|pushRecord|start|stop|cleanup)\(/);
  assert.doesNotMatch(body, /\bstats\s*=/);
  assert.match(body, /document\.documentElement\.lang = lang;/);
});

test('script.js：言語の切り替えは、計測エンジン・凡例・記録の穴・注意書きなど、logic.js の文言をすべて描き直す', () => {
  const start = SCRIPT.indexOf('function applyLanguage()');
  const end = SCRIPT.indexOf('if (langToggle) langToggle.addEventListener', start);
  const body = SCRIPT.slice(start, end).split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  for (const call of ['applyStaticText', 'renderMeterScale', 'renderEngineMode', 'renderBandInfo', 'renderIntegrity', 'renderRecordNotice']) {
    assert.match(body, new RegExp(`\\b${call}\\(\\);`), `applyLanguage が ${call}() を呼んでいない`);
  }
  // 注意書きの元の文字列も新しい言語にそろえる（次の区間で、同じ中身を「変わった」と読んで描き直さないため）
  assert.match(body, /statsNoticeText = statsWarnings\(stats, lang\)\.join\('\\n'\);/);
});

// 偽のマイクと、audioWorklet の無い AudioContext（簡易モードで記録する）。時刻・描画のフレーム・タイマーは手で進める
function fakeAudioEnv() {
  let nowMs = 1000;
  let raf = null;
  const timers = new Map();
  let nextId = 1;
  const track = {
    kind: 'audio', label: 'Fake Mic', readyState: 'live', muted: false, enabled: true,
    getSettings: () => ({ echoCancellation: false, autoGainControl: false, noiseSuppression: false, sampleRate: 48000, channelCount: 1 }),
    addEventListener() {}, removeEventListener() {}, stop() { this.readyState = 'ended'; }
  };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  class FakeAudioContext {
    constructor() { this.sampleRate = 48000; this.currentTime = 0; this.state = 'running'; this.destination = {}; }
    createAnalyser() { return { fftSize: 0, connect() {}, disconnect() {}, getFloatTimeDomainData(buf) { buf.fill(0.1); } }; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    addEventListener() {}
    removeEventListener() {}
    resume() { return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
  }
  return {
    env: {
      mediaDevices: { getUserMedia: () => Promise.resolve(stream) },
      AudioContext: FakeAudioContext,
      performance: { now: () => nowMs },
      requestAnimationFrame: (fn) => { raf = fn; return 1; },
      cancelAnimationFrame: () => { raf = null; },
      setTimeout: (fn) => { const id = nextId++; timers.set(id, fn); return id; },
      clearTimeout: (id) => { timers.delete(id); },
      // 時刻の監視（1秒ごと）は動かさない
      setInterval: () => nextId++,
      clearInterval: () => {}
    },
    frame(ms) { nowMs += ms; const fn = raf; raf = null; if (fn) fn(nowMs); },
    runTimers() { const fns = [...timers.values()]; timers.clear(); for (const fn of fns) fn(); }
  };
}

const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r)); };

test('script.js：記録して止めたあとに切り替えても、計測エンジン・記録の穴・注意書きを新しい言語で描き直し、記録は変わらない', async () => {
  const audio = fakeAudioEnv();
  const page = openPage({ search: '?lang=ja', languages: ['ja-JP'], env: audio.env });
  const $ = (id) => page.doc.getElementById(id);
  $('startBtn').click();
  await settle();
  assert.equal($('status').textContent, M.t('ja', 'status.measuring'));
  assert.equal($('engineMode').textContent, M.t('ja', 'engine.fallback'));
  // 簡易モードは描画のフレームで行を作る（ログ間隔1秒）
  for (let i = 0; i < 3; i++) audio.frame(1100);
  const rows = Number($('count').textContent);
  assert.equal(rows, 3);
  $('stopBtn').click();
  audio.runTimers();
  await settle();
  assert.equal($('status').textContent, M.t('ja', 'status.stopped'));

  // 期待値は logic.js から出す（同じ条件の簡易モードの行と、セッションの測定条件）
  const fallbackStats = statsOf(Array.from({ length: rows }, (_, i) => logic.buildFallbackRecord({
    seq: i, db: -20, floorDb: -110, startTime: i, endTime: i + 1, startWallMs: i * 1000, endWallMs: (i + 1) * 1000,
    expectedSamples: 48000, intervalSec: 1, clockEpoch: 0, clockBreak: null, meta: null
  })));
  const meta = metaOf({
    engine: logic.ENGINE_FALLBACK,
    settings: { echoCancellation: false, autoGainControl: false, noiseSuppression: false, sampleRate: 48000, channelCount: 1 }
  });
  const expected = (lang) => {
    const items = logic.recordNoticeItems({ sessionMeta: meta, stats: fallbackStats, lang });
    return {
      engineMode: M.t(lang, 'engine.fallback'),
      integrityNote: logic.statsIntegrity(fallbackStats, lang).text,
      summary: '⚠ ' + logic.noticeSummary(items, lang),
      items: items.map(it => it.full)
    };
  };
  const shown = () => {
    const notice = $('recordNotice');
    return {
      engineMode: $('engineMode').textContent,
      integrityNote: $('integrityNote').textContent,
      summary: notice.querySelector('summary').textContent,
      items: notice.querySelectorAll('li').map(li => li.textContent)
    };
  };
  const ja = shown();
  assert.deepEqual(ja, expected('ja'));
  assert.ok(ja.items.length > 0, '注意書きが出ていない（簡易モードの注意があるはず）');

  $('langToggle').click();
  assert.equal(page.html.getAttribute('lang'), 'en');
  assert.deepEqual(shown(), expected('en'));
  assert.equal($('status').textContent, M.t('en', 'status.stopped'));
  assert.equal($('recordNoticeLive').textContent, expected('en').summary);
  const hits = pageStrings(page.doc).filter(s => JAPANESE.test(s.text)).map(s => `${s.where}: ${s.text.slice(0, 50)}`);
  assert.deepEqual(hits, []);
  // 記録には触らない（行数は同じ。CSV の中身が言語によらないことは csvHeaderLines などのテストで見ている）
  assert.equal(Number($('count').textContent), rows);

  // 日本語へ戻すと、切り替える前と同じ文言に戻る
  $('langToggle').click();
  assert.deepEqual(shown(), ja);
});
