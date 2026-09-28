const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const script = fs.readFileSync(path.join(root, 'script.js'), 'utf8');

// WCAG 2.2 の相対輝度。色を変えたときにここが落ちる。
function luminance(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const ch = [0, 2, 4].map(i => {
    const v = parseInt(full.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

function contrast(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// 宣言ブロックから --トークン を拾う
function tokensOf(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = css.match(new RegExp(escaped + '\\s*\\{([\\s\\S]*?)\\}'));
  assert.ok(m, `${selector} のブロックが見つからない`);
  const out = {};
  for (const line of m[1].split('\n')) {
    const t = line.match(/^\s*--([\w-]+)\s*:\s*([^;]+);/);
    if (t) out[t[1]] = t[2].trim();
  }
  return out;
}

const dark = tokensOf(':root');
const light = tokensOf('body.light');

// 前景トークン, 背景トークン, 必要な比, 何に使うか
const PAIRS = [
  ['title', 'card', 4.5, '.section-title の見出し'],
  ['fg', 'card', 4.5, '本文'],
  ['muted', 'card', 4.5, '補助的な説明文'],
  ['accent', 'card', 4.5, 'リンクと強調'],
  ['ok', 'card', 4.5, '#engineMode の高精度モード（12px）'],
  ['warn', 'card', 4.5, '#engineMode の簡易モード（12px）'],
  ['err', 'card', 4.5, 'エラー表示'],
  ['on-accent', 'accent', 4.5, '.preset-btn.active（面の上の文字）'],
  ['plot', 'card', 3.0, 'グラフの線（図形なので3:1）'],
];

test('両テーマのすべての組み合わせがWCAG 2.2の基準を満たす', () => {
  const failures = [];
  for (const [name, tokens] of [['dark', dark], ['light', light]]) {
    for (const [fg, bg, need, use] of PAIRS) {
      assert.ok(tokens[fg], `${name} に --${fg} が無い`);
      assert.ok(tokens[bg], `${name} に --${bg} が無い`);
      const r = contrast(tokens[fg], tokens[bg]);
      if (r < need) {
        failures.push(`${name}: --${fg} on --${bg} = ${r.toFixed(2)}（要 ${need}:1、${use}）`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

test('ライトテーマの見出しが、改修前の1.28:1から回復している', () => {
  // 初回訪問はライトになるので、最初に見る画面のコントラストがいちばん効く。
  // 改修前は .section-title が #cfe6ff のベタ書きで、白いカード上で 1.28:1 だった。
  const r = contrast(light.title, light.card);
  assert.ok(r >= 4.5, `ライトの見出しが ${r.toFixed(2)}:1 しかない`);
  assert.ok(contrast('#cfe6ff', '#ffffff') < 1.5, '比較用の旧値の計算が狂っている');
});

// 同じセレクターがメディアクエリ内にもあるので、全部集めて見る
function blocksOf(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(escaped + '\\s*\\{([\\s\\S]*?)\\}', 'g');
  const out = [...css.matchAll(re)].map(m => m[1]);
  assert.ok(out.length > 0, `${selector} のブロックが見つからない`);
  return out;
}

test('見出しの色をベタ書きしていない', () => {
  // ベタ書きするとテーマの片方で読めなくなる（改修前は #cfe6ff 固定で 1.28:1 だった）
  const blocks = blocksOf('.section-title');
  const withColor = blocks.filter(b => /color\s*:/.test(b));
  assert.equal(withColor.length, 1, 'color を持つ .section-title は1か所にする');
  assert.match(withColor[0], /color\s*:\s*var\(--title\)/);
  for (const b of blocks) {
    assert.doesNotMatch(b, /color\s*:\s*#/, '.section-title に色のベタ書きがある');
  }
});

test('面の上の文字を white で固定していない', () => {
  // ダークの --accent は明るいので、white を載せると 2.24:1 になる
  const blocks = blocksOf('.preset-btn.active');
  const withColor = blocks.filter(b => /color\s*:/.test(b));
  assert.ok(withColor.length > 0, '.preset-btn.active に color が無い');
  for (const b of withColor) {
    assert.match(b, /color\s*:\s*var\(--on-accent\)/);
    assert.doesNotMatch(b, /color\s*:\s*(white|#fff)/i);
  }
});

test('キャンバスの描画色をJSがベタ書きしていない', () => {
  // getComputedStyle から読む形になっていること。
  // フォールバック値は CSS 変数が読めないときだけ使う。
  for (const token of ['--card', '--grid', '--muted', '--plot']) {
    assert.ok(
      script.includes(`pick('${token}'`),
      `script.js が ${token} を pick() で読んでいない`
    );
  }
  // 色リテラルは pick() の第2引数（フォールバック）だけに現れる
  const literals = [...script.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)];
  for (const lit of literals) {
    const line = script.slice(0, lit.index).split('\n').pop() + lit[0];
    assert.match(line, /pick\(/, `色リテラル ${lit[0]} が pick() の外にある`);
  }
});

test('ライトテーマのトークンが、ダークの値をそのまま使い回していない', () => {
  // 片方だけ直して満足する事故を防ぐ
  const shared = PAIRS.map(p => p[0]).filter(t => dark[t] === light[t]);
  assert.deepEqual(shared, [], `両テーマで同じ値のトークン: ${shared.join(', ')}`);
});
