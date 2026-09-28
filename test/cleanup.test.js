// 段階3-7（掃除）で直したものを縛る。
//
// どれも単体では小さいが、放っておくと「ヘルプに書いてあることと実装が違う」
// 「死にコードを読んだ人が意味を探す」といった負債になる。
// 機械で見られるものは機械に見させる。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'script.js'), 'utf8');

test('効果を生まない [title]:hover が残っていない', () => {
  // position:relative だけを与える規則で、擬似要素も何も伴っていなかった
  assert.doesNotMatch(css, /^\[title\]:hover\s*\{/m);
});

test('同じメディアクエリーの中に .actions が2つない', () => {
  // 後ろの display:grid が勝つので、前の justify-content は読む人を惑わせるだけだった
  const blocks = css.split(/@media[^{]*\{/);
  for (const [i, block] of blocks.entries()) {
    const hits = [...block.matchAll(/^\s*\.actions\s*\{/gm)];
    assert.ok(hits.length <= 1, `ブロック${i}に .actions が${hits.length}個ある`);
  }
});

test('数値入力のフォントが16px以上（iOS Safari の自動ズーム対策）', () => {
  // 16px を下回るとフォーカス時に勝手に拡大され、版面がずれる。
  // 本体・メディアクエリーの両方で満たす必要がある（片方だけ直すと狭い画面で戻る）
  const rules = [...css.matchAll(/\.control input\[type="number"\][^{]*\{([^}]*)\}/g)];
  assert.ok(rules.length >= 2, `.control input[type="number"] の規則が ${rules.length} 件しかない`);
  const sizes = rules
    .map(m => m[1].match(/font-size\s*:\s*(\d+(?:\.\d+)?)px/))
    .filter(Boolean)
    .map(m => parseFloat(m[1]));
  assert.ok(sizes.length >= 2, 'font-size を指定している規則が2件未満');
  for (const s of sizes) {
    assert.ok(s >= 16, `font-size: ${s}px は16px未満`);
  }
});

test('プリセットボタンが WCAG 2.2 の 2.5.8（24px）を満たす', () => {
  // 実測で 30.1x22.97px しかなく、高さが足りていなかった。
  // 5個＋数値入力が並ぶ幅では44pxに届かないので、24pxを下限とする
  const m = css.match(/^\.preset-btn\s*\{([^}]*)\}/m);
  assert.ok(m, '.preset-btn の本体規則が見つからない');
  const h = m[1].match(/min-height\s*:\s*(\d+)px/);
  assert.ok(h, '.preset-btn に min-height が無い');
  assert.ok(parseInt(h[1], 10) >= 24, `min-height: ${h[1]}px は24px未満`);
});

test('ヘルプのタッチターゲットの記述が実態と合っている', () => {
  // 「すべてのボタンは44px以上」は事実でなかった（プリセットは24px）
  assert.doesNotMatch(html, /すべてのボタンは44px以上/);
  assert.match(html, /主要な操作ボタンは44px以上/);
  assert.match(html, /24px以上/);
});

test('モーダルに aria-modal があり、開いたらフォーカスを中へ移す', () => {
  const m = html.match(/<div class="modal-content"[^>]*>/);
  assert.ok(m, 'modal-content が見つからない');
  assert.match(m[0], /role="dialog"/);
  assert.match(m[0], /aria-modal="true"/);
  // 属性だけでは足りない。フォーカスを移さないと背後を読み続ける
  assert.match(script, /aria-hidden',\s*'false'\);[\s\S]{0,200}?\.focus\(\)/);
});

test('キャッシュ用のクエリが3つのファイルでそろっている', () => {
  // logic.js が増えたので、古い index.html がキャッシュに残ると起動しない
  const vers = [...html.matchAll(/\?v=([\d.]+)/g)].map(m => m[1]);
  assert.equal(vers.length, 3, `?v= が ${vers.length} 個（style/logic/script の3つのはず）`);
  assert.equal(new Set(vers).size, 1, `バージョンがそろっていない: ${vers.join(', ')}`);
  assert.notEqual(vers[0], '2.0', 'logic.js を足したのに v2.0 のまま');
});

test('統計リセットで稼働時間も戻す', () => {
  // 稼働時間だけ残ると「何をリセットしたのか」が読めない
  const m = script.match(/function resetStats\(\)\s*\{([\s\S]*?)\n  \}/);
  assert.ok(m, 'resetStats が見つからない');
  assert.match(m[1], /uptimeEl\.textContent\s*=/);
});

test('本番コードに console.log が残っていない', () => {
  // 失敗の報告は warn / error を使う
  const hits = [...script.matchAll(/console\.log\(/g)];
  assert.deepEqual(hits.map(h => h[0]), []);
});
