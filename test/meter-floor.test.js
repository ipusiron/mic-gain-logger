// メーターの目盛りと、表示下限の既定値（第2弾a6）。
//
// ⚠⚠ 目盛り（-60 / -40 / -20 / 0）は、公開前から一度も画面に出ていなかった。
//    .meter-scale が overflow:hidden・高さ20px の .meter の子で、下へ押し出されて
//    切られていた（実測で見えている高さ0px）。公開済みのスクリーンショットにも写っていない。
//    overflow を外すだけだと「設定を表示」ボタンに12px重なるので、.meter の外へ出す。
// ⚠⚠ 表示下限の既定（-60dBFS）が高すぎた。iPhone の実機テスト（2026-09-29）で、
//    21kHz のトーン（-65dBFS）が静寂（-76dBFS）と同じく -60 に張り付いて表示され、
//    本人は「反応がない」と読んだ。CSVには正しく残っていた。既定を -90 にする
//    （本人の判断）。目盛りも表示下限に合わせて動かす（固定の -60 のままだと嘘になる）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseFloorDb, dbToPercent, meterScaleLabels, FLOOR_DB_DEFAULT } = require('../logic.js');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'script.js'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

test('⭐目盛りは .meter の外（兄弟）に置く', () => {
  assert.match(html,
    /<div class="meter"[^>]*>\s*<div class="meter-bar" id="meterBar"><\/div>\s*<\/div>\s*(?:<!--[\s\S]*?-->\s*)?<div class="meter-scale"/,
    '.meter-scale が .meter の中にある（overflow:hidden で切られる）');
});

test('表示下限の既定は -90 dBFS（1か所の定数から出す）', () => {
  assert.equal(FLOOR_DB_DEFAULT, -90);
  assert.equal(parseFloorDb(''), -90);
  assert.equal(parseFloorDb('abc'), -90);
  const input = html.match(/<input[^>]*id="floorDb"[^>]*>/);
  assert.ok(input);
  assert.match(input[0], /value="-90"/);
  // 「通常-60〜-40」の案内は、既定を下げたので残さない
  assert.doesNotMatch(html, /通常-60〜-40/);
});

test('目盛りは表示下限から作る（4本、下限と0を含む）', () => {
  assert.deepEqual(meterScaleLabels(-90), ['-90', '-60', '-30', '0']);
  assert.deepEqual(meterScaleLabels(-60), ['-60', '-40', '-20', '0']);
  assert.deepEqual(meterScaleLabels(-45), ['-45', '-30', '-15', '0']);
  // 割り切れない下限は丸める
  assert.deepEqual(meterScaleLabels(-50), ['-50', '-33', '-17', '0']);
});

test('目盛りの位置とメーターの幅が同じ換算を使う', () => {
  // 目盛りは space-between で等間隔に並ぶ。メーターの幅も下限〜0を0〜100%に写すので、
  // 2本目（下限の2/3）は 1/3 の位置、3本目は 2/3 の位置に来る
  assert.equal(Math.round(dbToPercent(-60, -90)), 33);
  assert.equal(Math.round(dbToPercent(-30, -90)), 67);
});

test('script.js は表示下限が変わるたびに目盛りとメーターの説明を描き直す', () => {
  assert.match(script, /function renderMeterScale\(/);
  const body = script.slice(script.indexOf('function renderMeterScale('));
  const fn = body.slice(0, body.indexOf('\n  }') + 4);
  assert.match(fn, /getFloorDb\(\)/);
  assert.match(fn, /meterScaleLabels\(/);
  // 入力が変わったら描き直す
  assert.match(script, /floorDbInput\.addEventListener\('input',[^)]*renderMeterScale/);
  // 初期化でも1回描く
  const init = script.slice(script.indexOf('\n  // 初期\n'));
  assert.match(init, /renderMeterScale\(\)/);
});

test('メーターの説明に -60 を決め打ちしない', () => {
  const meter = html.match(/<div class="meter"[^>]*>/);
  assert.ok(meter);
  assert.doesNotMatch(meter[0], /-60dBFS/);
});

test('README も既定の表示下限を -90 と書いている', () => {
  assert.match(readme, /表示下限（既定-90dBFS）/);
  assert.doesNotMatch(readme, /表示下限（既定-60dBFS）/);
});
