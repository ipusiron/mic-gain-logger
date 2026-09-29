// 幅で切り替える規則（@media (max-width: …)）が、後ろにある同じセレクターの
// 素の規則に打ち消されていないこと（第2弾a6）。
//
// ⚠⚠ メディアクエリーは詳細度を上げない。同じ詳細度なら、あとに書いたほうが勝つ。
//    改修前（c7b6bad）は `@media (max-width: 480px)` のブロックが style.css の中ほどにあり、
//    その後ろに素の規則が並んでいた。スマートフォン用に書いた指定の多くが効かず、
//    320px 幅では統計が1列7行（高さ617.9px）になっていた（書いてあった 1fr 1fr が効いていれば2列）。
//    段階3-1 で .controls-toggle について同じ型を直していた（test/css.test.js）が、
//    残りのブロックに同じ罠が残っていた。1か所ずつ縛るのではなく、全部を機械で縛る。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

// 並び順つきで「トップレベルの規則」と「@media ブロック」に分ける
function blocks(css) {
  const out = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open === -1) break;
    const head = css.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth += 1;
      else if (css[j] === '}') depth -= 1;
      j += 1;
    }
    out.push({ head, body: css.slice(open + 1, j - 1), at: open });
    i = j;
  }
  return out;
}

function decls(body) {
  const out = {};
  for (const part of body.split(';')) {
    const m = part.match(/^\s*([-\w]+)\s*:\s*(.+?)\s*$/s);
    if (m) out[m[1]] = m[2].replace(/\s+/g, ' ');
  }
  return out;
}

const selectors = (head) => head.split(',').map(s => s.replace(/\s+/g, ' ').trim());

const maxWidthOf = (head) => {
  const m = head.match(/max-width:\s*(\d+)px/);
  return m ? parseInt(m[1], 10) : null;
};

// 後ろのセレクター s2 が、sel と同じ要素に同じか高い詳細度で当たるか。
// ⚠ 公開前の点検（第2弾a7）で、同じ文字列しか比べていないと、後ろに書いた
//    もっと詳細なセレクター（.stats .stats-grid）による打ち消しを見逃すことが分かった
const hitsSameElement = (s2, sel) => s2 === sel || s2.endsWith(' ' + sel) || s2.endsWith('>' + sel);

// 後ろにある規則のうち、幅 w 以下で効くものを並べる（素の規則と、max-width が w 以上の @media の中）
// ⚠ 公開前の点検で、後ろにある幅の広い @media（max-width:768px）による打ち消しを見逃すことが分かった
function laterRulesAt(all, from, w) {
  const out = [];
  for (let k = from; k < all.length; k++) {
    const b = all[k];
    if (!b.head.startsWith('@')) { out.push(b); continue; }
    if (!b.head.startsWith('@media')) continue;
    if (/min-width/.test(b.head)) continue;
    const mw = maxWidthOf(b.head);
    if (mw !== null && mw >= w) out.push(...blocks(b.body));
  }
  return out;
}

function offendersIn(src) {
  const all = blocks(src);
  const found = [];
  all.forEach((media, mi) => {
    if (!/^@media[^{]*max-width/.test(media.head)) return;
    const w = maxWidthOf(media.head);
    const later = laterRulesAt(all, mi + 1, w);
    for (const inner of blocks(media.body)) {
      const innerDecls = decls(inner.body);
      for (const sel of selectors(inner.head)) {
        for (const [prop, val] of Object.entries(innerDecls)) {
          for (const rule of later) {
            const s2 = selectors(rule.head).find(s => hitsSameElement(s, sel));
            if (!s2) continue;
            const lv = decls(rule.body)[prop];
            if (lv !== undefined && lv !== val) {
              found.push(`${media.head} の ${sel} { ${prop}: ${val} } が、後ろの ${s2} { ${prop}: ${lv} } に打ち消される`);
            }
          }
        }
      }
    }
  });
  return found;
}

function offenders() {
  return offendersIn(CSS);
}

test('⭐幅で切り替える規則が、後ろの素の規則に打ち消されていない', () => {
  const list = offenders();
  assert.deepEqual(list, [], `${list.length} 件\n` + list.join('\n'));
});

test('検査が空振りしていない（わざと後ろに同じ規則を置けば見つける）', () => {
  // 検査そのものの確かめ。空振りすると、上のテストは何も見ずに通る
  const probe = CSS + '\n.stat-value{font-size:99px}';
  const all = blocks(probe);
  const mediaIdx = all.findIndex(b => /max-width:\s*480px/.test(b.head)
    && blocks(b.body).some(r => selectors(r.head).includes('.stat-value')));
  assert.ok(mediaIdx >= 0, '480px のブロックに .stat-value が無い（検査の前提が崩れた）');
  const later = all.slice(mediaIdx + 1).some(b => selectors(b.head).includes('.stat-value')
    && decls(b.body)['font-size'] === '99px');
  assert.ok(later, '後ろに置いた規則を見つけられない');
});

test('検査が空振りしていない（詳細なセレクター・幅の広い @media による打ち消しも見つける）', () => {
  // 公開前の点検で使われた2つの型。どちらも 320px 幅で 480px 用の 1fr 1fr を打ち消す
  const a = offendersIn(CSS + '\n.stats .stats-grid{grid-template-columns:repeat(4,1fr)}');
  assert.ok(a.some(s => s.includes('.stats .stats-grid')), '詳細なセレクターによる打ち消しを見逃した');
  const b = offendersIn(CSS + '\n@media (max-width: 768px){.stats-grid{grid-template-columns:repeat(3,1fr)}}');
  assert.ok(b.some(s => s.includes('repeat(3,1fr)')), '幅の広い @media による打ち消しを見逃した');
  // 481px以上だけで効く規則は、480px以下の規則を打ち消さない（誤検知しない）
  const c = offendersIn(CSS + '\n@media (min-width: 481px){.stats-grid{gap:99px}}');
  assert.deepEqual(c, []);
});
