'use strict';

// 第1弾の締め: 効いていなかった「スムージング」設定の廃止を縛る。
//
// このスライダーが動かしていたのは AnalyserNode.smoothingTimeConstant だけで、
// これは周波数領域の値（getByteFrequencyData など）にしか作用しない。
// 本ツールの計測は時間領域の RMS なので、表示にも記録にも一切効いていなかった。
// 効かない設定を残すと、README・画面の注意事項・ヘルプの計5か所が嘘をつき続ける。
//
// ⚠ 黙って消すと、使っていた人には「設定が無くなった」としか見えない。
// 消した理由と、次の弾で時間重みとして入れ直すことを README に残す約束も、ここで縛る。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'script.js'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

const SECTION = '### 外した設定（スムージング）';

function removalSection() {
  const head = readme.indexOf(SECTION);
  assert.notEqual(head, -1, '廃止を説明する節が無い');
  const rest = readme.slice(head);
  const end = rest.indexOf('\n---');
  return end === -1 ? rest : rest.slice(0, end);
}

test('index.html にスムージングの入力が無い', () => {
  assert.ok(!html.includes('id="smoothing"'), 'スライダーが残っている');
  assert.ok(!html.includes('for="smoothing"'), 'ラベルが残っている');
});

test('script.js が smoothingTimeConstant を触っていない', () => {
  assert.ok(!script.includes('smoothingTimeConstant'), '代入が残っている');
  assert.ok(!script.includes('smoothingInput'), '入力への参照が残っている');
});

test('画面の文章がスムージングを案内していない', () => {
  // 注意事項の1行とヘルプの設定項目の1行。どちらも効かない設定を説明していた
  assert.ok(!html.includes('スムージング'), 'index.html にスムージングの記述が残っている');
});

test('README が「なぜ消したか」を書いている', () => {
  const body = removalSection();
  assert.match(body, /smoothingTimeConstant/, '何が動いていなかったのかを書いていない');
  // 「効く」は直訳調の語なので、README では「反映されていません」に言い換えた
  assert.match(body, /表示にも記録にも一切反映されていませんでした/, '反映されていなかったことを書いていない');
  assert.match(body, /時間重み/, '次の弾での置き換えを書いていない');
});

test('README の設定の一覧からスムージングが消えている', () => {
  const head = readme.indexOf('- **リアルタイム設定変更**');
  assert.notEqual(head, -1, '「リアルタイム設定変更」の項目が無い');
  const item = readme.slice(head, head + 300);
  assert.ok(!item.includes('スムージング'), '設定の一覧にスムージングが残っている');
});
