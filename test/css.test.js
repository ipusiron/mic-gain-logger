// style.css の静的検証。
//
// 段階3-1 で直した不具合は「セレクターの詳細度が同じなら、あとに書いたほうが勝つ」
// という CSS の基本則をメディアクエリーが変えない、という一点に尽きる。
// `@media (max-width:480px)` の中の `.controls-toggle{display:flex}` より後ろに
// 素の `.controls-toggle{display:none}` があると、幅によらず none が勝ち、
// スマートフォンで設定を1つも開けなくなっていた。
//
// 同じ型（Day019 でも踏んだ）を二度と入れないように、機械で縛る。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');

// コメントを外す（セレクターの直前のコメントが head に混ざるのを防ぐ）
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

// style.css を「トップレベルの規則」と「@media ブロック」に分ける。
// 入れ子の @media は使っていないので、波括弧の数え上げで足りる。
function splitBlocks(src) {
  const css = stripComments(src);
  const top = [];       // { selector, body }
  const media = [];     // { query, body }
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open === -1) break;
    const head = css.slice(i, open).trim();
    // 対応する閉じ括弧を探す
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth += 1;
      else if (css[j] === '}') depth -= 1;
      j += 1;
    }
    const body = css.slice(open + 1, j - 1);
    if (head.startsWith('@media')) media.push({ query: head, body });
    else top.push({ selector: head, body });
    i = j;
  }
  return { top, media };
}

// セレクターの一覧に、目的のセレクターが（カンマ区切りの一員として）含まれるか
function hasSelector(selectorList, wanted) {
  return selectorList.split(',').map(s => s.trim()).includes(wanted);
}

// ブロック本文から、そのセレクターのプロパティ値を拾う
function declFor(body, selector, prop) {
  const { top } = splitBlocks(body);
  for (const rule of top) {
    if (!hasSelector(rule.selector, selector)) continue;
    const m = rule.body.match(new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;]+)'));
    if (m) return m[1].trim();
  }
  return null;
}

const { top, media } = splitBlocks(CSS);

test('CSS: .controls-toggle{display:none} はトップレベルに置かない（480px以下の表示指定を打ち消すため）', () => {
  const offenders = top.filter(r => hasSelector(r.selector, '.controls-toggle')
    && /display\s*:\s*none/.test(r.body));
  assert.equal(offenders.length, 0,
    'トップレベルの .controls-toggle{display:none} は、480px以下の display:flex を順序で打ち消す');
});

test('CSS: .controls-toggle を隠すのは min-width のメディアクエリーの中だけ', () => {
  const hides = media.filter(m => declFor(m.body, '.controls-toggle', 'display') === 'none');
  assert.ok(hides.length >= 1, '481px以上で折りたたみボタンを隠す規則がない');
  for (const m of hides) {
    assert.ok(/min-width/.test(m.query), `隠す規則が min-width の外にある: ${m.query}`);
  }
});

test('CSS: 480px以下では .controls-toggle が display:flex である', () => {
  const small = media.filter(m => /max-width\s*:\s*480px/.test(m.query));
  assert.ok(small.length >= 1, '480px以下のメディアクエリーがない');
  const shown = small.some(m => declFor(m.body, '.controls-toggle', 'display') === 'flex');
  assert.ok(shown, '480px以下で折りたたみボタンを表示する規則がない');
});

test('CSS: 表示と非表示の幅が重ならない（480px以下＝表示、481px以上＝非表示）', () => {
  const showQueries = media
    .filter(m => declFor(m.body, '.controls-toggle', 'display') === 'flex')
    .map(m => m.query);
  const hideQueries = media
    .filter(m => declFor(m.body, '.controls-toggle', 'display') === 'none')
    .map(m => m.query);
  const maxOf = q => { const m = q.match(/max-width\s*:\s*(\d+)px/); return m ? Number(m[1]) : null; };
  const minOf = q => { const m = q.match(/min-width\s*:\s*(\d+)px/); return m ? Number(m[1]) : null; };
  for (const sq of showQueries) {
    for (const hq of hideQueries) {
      const smax = maxOf(sq);
      const hmin = minOf(hq);
      assert.ok(smax !== null && hmin !== null, `幅の境界を読み取れない: ${sq} / ${hq}`);
      assert.ok(hmin > smax, `表示（〜${smax}px）と非表示（${hmin}px〜）の範囲が重なる`);
    }
  }
});

module.exports = { splitBlocks, hasSelector, declFor };
