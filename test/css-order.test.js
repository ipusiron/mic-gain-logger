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

function offenders() {
  const all = blocks(CSS);
  const found = [];
  all.forEach((media, mi) => {
    if (!/^@media[^{]*max-width/.test(media.head)) return;
    for (const inner of blocks(media.body)) {
      const innerDecls = decls(inner.body);
      for (const sel of selectors(inner.head)) {
        for (const [prop, val] of Object.entries(innerDecls)) {
          for (let k = mi + 1; k < all.length; k++) {
            const later = all[k];
            if (later.head.startsWith('@')) continue;
            if (!selectors(later.head).includes(sel)) continue;
            const lv = decls(later.body)[prop];
            if (lv !== undefined && lv !== val) {
              found.push(`${media.head} の ${sel} { ${prop}: ${val} } が、後ろの ${sel} { ${prop}: ${lv} } に打ち消される`);
            }
          }
        }
      }
    }
  });
  return found;
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
