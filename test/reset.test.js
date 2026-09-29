// 「統計リセット」は、記録の母集団をまとめて捨てる。
//
// ⚠⚠ 改修前（c7b6bad）は logs と統計だけを捨てていた。グラフの点（series）は
//    pushRecord で CSV の行と同じ源から積んでいるのに、リセットでは残った。
//    停止中に押すと絵が固まり、テーマの切り替えなどで描き直すと、捨てた点が
//    左端に縦線として出た（timeToX が窓の外の点を左端へ寄せるため）。
//    記録中に押すと、捨てた点と新しい点が1本の線につながった。
//    時刻の跳び・切断の注意書きも、消したログについて言い続けた
//    （「ここまでのログは書き出せます」「CSVのメタ行に残ります」）。
//    さらに記録中に押すと、ワークレットの seq が続くので CSV の seq が 0 から始まらなかった。
//    利用者の指摘（2026-09-29「リセットしたのにグラフが残るのは正常？」）で見つかった。
//
// 直し方（本人の判断 2026-09-29）＝記録を止めてから押せる形にし、押したら母集団ごと捨てる。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const script = fs.readFileSync(path.join(root, 'script.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
// 第2弾c1bでREADMEを入口にし、詳しい説明をdocs/へ分けた。READMEとdocs/を合わせたものが、分ける前のREADMEにあたる
const docsText = name => fs.readFileSync(path.join(root, 'docs', name), 'utf8');
const readmeAndDocs = [readme, ...fs.readdirSync(path.join(root, 'docs')).filter(n => n.endsWith('.md')).map(docsText)].join('\n');
const features = docsText('features.md');

// ⚠ コメントを外してから照合する。公開前の点検で、`// series = [];` のように
//    コメントアウトしても正規表現が一致してテストが通ることが分かった
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
}

function bodyOf(name) {
  const start = script.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} が見つからない`);
  // 次の function 宣言の手前までを本体とみなす
  const next = script.indexOf('\n  function ', start + 10);
  const nextAsync = script.indexOf('\n  async function ', start + 10);
  const ends = [next, nextAsync].filter(i => i > 0);
  return stripComments(script.slice(start, ends.length ? Math.min(...ends) : undefined));
}

test('リセットボタンは記録中・接続中に押せない（書き出しボタンと同じ条件）', () => {
  const body = bodyOf('updateButtonStates');
  assert.match(body, /resetBtn\.disabled\s*=\s*running\s*\|\|\s*connecting\s*\|\|\s*logs\.length\s*===\s*0/);
  // ボタンを無効にするだけでなく、関数の入口でも止める（キーボード操作や古い状態に備える）
  assert.match(bodyOf('resetAllStats'), /if\s*\(\s*running\s*\|\|\s*connecting\s*\)\s*return/);
});

test('接続を始めた時点でボタンの状態を更新する（接続中にリセットさせない）', () => {
  const start = bodyOf('start');
  const i = start.indexOf('connecting = true');
  assert.ok(i >= 0);
  const j = start.indexOf('updateButtonStates()', i);
  const k = start.indexOf('getUserMedia', i);
  assert.ok(j > i && j < k, '接続を始めてから getUserMedia までに updateButtonStates() を呼んでいない');
});

test('⭐リセットでグラフの点も捨て、その場で描き直す', () => {
  const body = bodyOf('resetAllStats');
  assert.match(body, /series\s*=\s*\[\]/, 'series を捨てていない');
  // 停止中は rAF が止まっているので、描き直さないと画面が変わらない
  const i = body.indexOf('series = []');
  const j = body.indexOf('drawSeries()', i);
  assert.ok(j > i, 'series を捨てたあとで drawSeries() を呼んでいない');
});

test('⭐リセットで、捨てたログについての注意書きの元も捨てる', () => {
  const body = bodyOf('resetAllStats');
  for (const re of [
    /clockBreaks\s*=\s*\[\]/,
    /pendingClockBreak\s*=\s*null/,
    /deviceLoss\s*=\s*null/,
    /deviceMuted\s*=\s*false/,
    /sessionMeta\s*=\s*null/,
    /startedAt\s*=\s*0/
  ]) {
    assert.match(body, re, `${re} が無い`);
  }
  // 前のセッションの注意書きの開閉を持ち越さない（公開前の点検で見つかった）
  assert.match(body, /closeNotice\(\)/);
  // 元を捨ててから注意書きを出し直す（順番が逆だと古い文が残る）
  const cleared = body.indexOf('clockBreaks = []');
  const redraw = body.lastIndexOf('renderRecordNotice()');
  assert.ok(redraw > cleared, '注意書きの元を捨てる前に描き直している');
});

test('コメントアウトした行は、捨てたことにならない（検査が空振りしていない）', () => {
  const probe = stripComments('  function x() {\n    // series = [];\n    /* deviceLoss = null; */\n  }');
  assert.doesNotMatch(probe, /series\s*=\s*\[\]/);
  assert.doesNotMatch(probe, /deviceLoss\s*=\s*null/);
});

test('記録を始めるときにも、注意書きの開閉を戻す', () => {
  assert.match(bodyOf('start'), /closeNotice\(\)/);
});

test('ボタンの説明とヘルプが、実際に捨てるものを言っている', () => {
  const btn = html.match(/<button id="resetBtn"[^>]*>/);
  assert.ok(btn);
  assert.match(btn[0], /グラフ/);
  assert.match(btn[0], /停止/);
  assert.doesNotMatch(html, /「統計リセット」<\/strong>ですべてのデータをクリア/);
  assert.match(html, /「統計リセット」<\/strong>[^<]*グラフ[^<]*停止/);
});

test('docs/features.md も、記録を止めてから押すこととグラフも消えることを書いている', () => {
  const line = features.split('\n').find(l => l.includes('統計とログデータは累積され続ける'));
  assert.ok(line, '累積の説明の行が無い');
  // README の使い方にも、止めてから押すことと、グラフまで消すことを書いている
  const usage = readme.split('\n').find(l => l.startsWith('- 「統計リセット」は'));
  assert.ok(usage && /止めて/.test(usage) && /グラフ/.test(usage), 'READMEの使い方に統計リセットの説明が無い');
  assert.match(line, /停止/);
  assert.match(line, /グラフ/);
});
