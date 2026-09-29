// 公開前の点検（第2弾a7）で見つかった画面の不具合を縛る。
//
// ・停止中に表示下限を変えると、グラフが「いま」を右端にして描き直され、
//   60秒たつと記録した線がまるごと左端へ寄って見えなくなった
// ・停止中に表示下限を変えると、目盛りだけが変わり、メーターのバーと大型表示は古い下限のままだった
// ・メーターの目盛りを space-between で並べていたので、中の2本が本来の位置より右へずれた
// ・表示下限を -1〜-2 にすると、目盛りに同じ数字が並んだ
// ・ヘルプの「主要な操作ボタンは44px以上」を、481px以上の幅で満たしていなかった
// ・480px以下で統計のラベルが10px（ページで唯一の10pxの文字）になっていた

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { meterScaleLabels, dbToPercent } = require('../logic.js');

const root = path.join(__dirname, '..');
const script = fs.readFileSync(path.join(root, 'script.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function bodyOf(name) {
  const start = script.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} が見つからない`);
  const next = script.indexOf('\n  function ', start + 10);
  const nextAsync = script.indexOf('\n  async function ', start + 10);
  const ends = [next, nextAsync].filter(i => i > 0);
  return script.slice(start, ends.length ? Math.min(...ends) : undefined)
    .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
}

test('⭐停止中のグラフは、止めた時刻を右端にして描く', () => {
  assert.match(bodyOf('drawSeries'), /const nowMs = graphNowMs\(\)/);
  assert.match(bodyOf('graphNowMs'), /if \(running \|\| graphFrozenMs === null\) return Date\.now\(\)/);
  assert.match(bodyOf('stop'), /graphFrozenMs = lastStopTime/);
  // 記録を始めたら「いま」へ戻す。リセットでも戻す
  const start = bodyOf('start');
  assert.ok(start.indexOf('graphFrozenMs = null') > start.indexOf('running = true'));
  assert.match(bodyOf('resetAllStats'), /graphFrozenMs = null/);
});

test('停止中に表示下限を変えても、メーターのバーと大型表示を描き直す', () => {
  assert.match(bodyOf('animate'), /renderMeter\(db\)/);
  assert.match(script, /floorDbInput\.addEventListener\('input', \(\) => \{ renderMeter\(lastMeterDb\); drawSeries\(\); \}\)/);
  // 一度も測っていないときは何もしない（'--.- dBFS' のまま）
  assert.match(bodyOf('renderMeter'), /if \(db === null \|\| db === undefined\) return/);
});

test('目盛りは浅い下限では小数1桁で出し、同じ数字を並べない', () => {
  assert.deepEqual(meterScaleLabels(-1), ['-1', '-0.7', '-0.3', '0']);
  assert.deepEqual(meterScaleLabels(-2), ['-2', '-1.3', '-0.7', '0']);
  assert.deepEqual(meterScaleLabels(-5), ['-5', '-3.3', '-1.7', '0']);
  assert.deepEqual(meterScaleLabels(-6), ['-6', '-4', '-2', '0']);
  assert.deepEqual(meterScaleLabels(-90), ['-90', '-60', '-30', '0']);
  for (let f = -120; f <= -1; f++) {
    const labels = meterScaleLabels(f);
    assert.equal(new Set(labels).size, 4, `下限 ${f} で目盛りが重複: ${labels.join(' / ')}`);
  }
});

test('⭐目盛りは、メーターの幅と同じ位置（0・1/3・2/3・1）に置く', () => {
  assert.match(css, /\.meter-scale\s*\{[^}]*position:\s*relative/);
  assert.match(css, /\.meter-scale span:nth-child\(2\)\s*\{\s*left:\s*33\.333%/);
  assert.match(css, /\.meter-scale span:nth-child\(3\)\s*\{\s*left:\s*66\.667%/);
  // メーターの幅の換算と同じ位置である
  assert.equal(Math.round(dbToPercent(-60, -90) * 1000) / 1000, 33.333);
  assert.equal(Math.round(dbToPercent(-30, -90) * 1000) / 1000, 66.667);
  assert.doesNotMatch(css, /\.meter-scale\s*\{[^}]*space-between/, 'space-between が残っている');
});

test('主要な操作ボタンは、どの幅でも44px以上', () => {
  const m = css.match(/(^|\n)\.btn\s*\{([^}]*)\}/);
  assert.ok(m, '.btn の本体の規則が無い');
  const h = m[2].match(/min-height\s*:\s*(\d+)px/);
  assert.ok(h, '.btn に min-height が無い');
  assert.ok(parseInt(h[1], 10) >= 44);
});

test('480px以下の統計のラベルは11px以上', () => {
  const block = css.slice(css.indexOf('@media (max-width: 480px)'));
  const m = block.match(/\.stat-label\s*\{([^}]*)\}/);
  assert.ok(m);
  const px = parseFloat(m[1].match(/font-size\s*:\s*([\d.]+)px/)[1]);
  assert.ok(px >= 11, `${px}px`);
});
