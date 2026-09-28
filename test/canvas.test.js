// キャンバスの大きさと、レスポンシブ規則の置き場所の検証。
//
// 改修前は resizeCanvas() の中に3つの不具合が同居していた。
//  (1) getBoundingClientRect() の非整数を `new Array()` へ渡して RangeError
//  (2) canvas.style.width/height への px 焼き込みで CSS のレスポンシブ規則を無効化
//  (3) (2) の結果、481〜915px でキャンバスが横へはみ出す
// (1) は純関数で、(2)(3) は静的検査で縛る。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { canvasPixelSize } = require('../logic.js');
const { splitBlocks, hasSelector, declFor } = require('./css.test.js');

const ROOT = path.join(__dirname, '..');
const SCRIPT = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');

// 実機で RangeError を出した幅（Chromium 実測。ズーム 110/90/133% とスマートフォン幅）
const REAL_NON_INTEGER_WIDTHS = [553.328125, 330.25, 271.34375, 319.1875, 334.1875, 345.25];

test('canvasPixelSize: 実測で RangeError を出した幅が、すべて配列長として使える', () => {
  for (const w of REAL_NON_INTEGER_WIDTHS) {
    const size = canvasPixelSize(w, 220, 1);
    assert.ok(Number.isInteger(size.cssW), `cssW が整数でない: ${size.cssW}`);
    assert.ok(Number.isInteger(size.pixelW), `pixelW が整数でない: ${size.pixelW}`);
    // 改修前はここで RangeError: Invalid array length が飛んでいた
    assert.doesNotThrow(() => new Array(size.cssW), `幅 ${w} で配列を作れない`);
  }
});

test('canvasPixelSize: dpr 倍の内部解像度も整数になる', () => {
  for (const dpr of [1, 1.25, 1.5, 2, 2.625, 3]) {
    const size = canvasPixelSize(390.4375, 120.5, dpr);
    assert.ok(Number.isInteger(size.pixelW), `pixelW=${size.pixelW} dpr=${dpr}`);
    assert.ok(Number.isInteger(size.pixelH), `pixelH=${size.pixelH} dpr=${dpr}`);
    assert.equal(size.pixelW, Math.round(390 * dpr));
    assert.equal(size.pixelH, Math.round(121 * dpr));
  }
});

test('canvasPixelSize: 0・負・NaN・未指定でも 1 以上を返す（描画が止まらない）', () => {
  for (const bad of [0, -5, NaN, Infinity, undefined, null]) {
    const size = canvasPixelSize(bad, bad, bad);
    assert.ok(size.cssW >= 1 && size.cssH >= 1, `cssW=${size.cssW} cssH=${size.cssH}`);
    assert.ok(size.pixelW >= 1 && size.pixelH >= 1, `pixelW=${size.pixelW}`);
    assert.doesNotThrow(() => new Array(size.cssW));
  }
});

test('canvasPixelSize: 四捨五入は 0.5 の境目でも整数を返す', () => {
  assert.equal(canvasPixelSize(480.5, 220.5, 1).cssW, 481);
  assert.equal(canvasPixelSize(480.4, 220.4, 1).cssW, 480);
  assert.equal(canvasPixelSize(1, 1, 1).cssW, 1);
});

test('script.js: canvas.style.width/height へ px を焼き込まない', () => {
  // インラインスタイルは CSS のどの規則より強いので、書いた時点で
  // レスポンシブ規則が死ぬ（狭めたあと二度と広がらない）
  assert.ok(!/canvas\.style\.(width|height)\s*=/.test(SCRIPT),
    'canvas.style.width/height への代入が残っている');
});

test('script.js: 変換行列は setTransform で入れ直す（ctx.scale の累乗を避ける）', () => {
  assert.ok(/ctx\.setTransform\(/.test(SCRIPT), 'setTransform が無い');
  assert.ok(!/\bctx\.scale\(/.test(SCRIPT), 'ctx.scale が残っている（呼ぶたびに倍率が累乗になる）');
});

test('style.css: #levelCanvas の width:100% はメディアクエリーの外（＝全幅で効く）にある', () => {
  const { top } = splitBlocks(CSS);
  const base = top.filter(r => hasSelector(r.selector, '#levelCanvas'));
  assert.equal(base.length, 1, 'トップレベルの #levelCanvas 規則がちょうど1つでない');
  assert.equal(declFor(CSS, '#levelCanvas', 'width'), '100%');
  assert.equal(declFor(CSS, '#levelCanvas', 'max-width'), '100%');
  assert.equal(declFor(CSS, '#levelCanvas', 'display'), 'block');
});

test('style.css: #levelCanvas の基本規則は 480px 以下の上書きより前にある', () => {
  // メディアクエリーは詳細度を上げないので、基本規則をあとに書くと上書きを打ち消す
  const stripped = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const basePos = stripped.indexOf('#levelCanvas{');
  assert.ok(basePos > 0, '基本規則が見つからない');
  const smallPos = stripped.search(/@media\s*\(\s*max-width\s*:\s*480px\s*\)/);
  assert.ok(smallPos > 0, '480px 以下のメディアクエリーが見つからない');
  assert.ok(basePos < smallPos,
    `基本規則（${basePos}）が 480px の上書き（${smallPos}）より後ろにある`);
});

test('index.html: canvas の width/height 属性は内部解像度の初期値としてだけ残す', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const m = html.match(/<canvas id="levelCanvas"[^>]*>/);
  assert.ok(m, 'canvas 要素が見つからない');
  // 属性はあってよい（CSS が width:100% で上書きする）が、style 属性は持たせない
  assert.ok(!/\sstyle=/.test(m[0]), 'canvas に style 属性が付いている');
});
