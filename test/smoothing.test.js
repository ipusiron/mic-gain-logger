'use strict';

// 第1弾の締め: 効いていなかった「スムージング」設定の廃止を縛る。
//
// このスライダーが動かしていたのは AnalyserNode.smoothingTimeConstant だけで、
// これは周波数領域の値（getByteFrequencyData など）にしか作用しない。
// 本ツールの計測は時間領域の RMS なので、表示にも記録にも一切効いていなかった。
// 効かない設定を残すと、README・画面の注意事項・ヘルプの計5か所が嘘をつき続ける。
//
// ⚠ 黙って消すと、使っていた人には「設定が無くなった」としか見えない。
// 置かない理由と、時間重みとして入れる案を説明に残す約束も、ここで縛る。
// 第2弾c1bで、説明はdocs/measurement.mdの「スムージングの設定を置かない理由」へ移し、過去の版（スライダーがあったこと）には
// 触れず、いまの作りの理由として書き直した（本人の指示 2026-09-29「今の版で正しいことを書けば良いだけ」）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'script.js'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const measurement = fs.readFileSync(path.join(root, 'docs', 'measurement.md'), 'utf8');
const features = fs.readFileSync(path.join(root, 'docs', 'features.md'), 'utf8');

const SECTION = '### スムージングの設定を置かない理由';

function reasonSection() {
  const head = measurement.indexOf(SECTION);
  assert.notEqual(head, -1, 'スムージングを置かない理由の節が無い');
  const rest = measurement.slice(head + SECTION.length);
  const end = rest.search(/\n#{1,3} /);
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

test('docs/measurement.md が「なぜスムージングの設定を置かないか」を、いまの作りの理由として書いている', () => {
  const body = reasonSection();
  assert.match(body, /smoothingTimeConstant/, '何が反映されないのかを書いていない');
  // 「効く」は直訳調の語なので「反映されない」と書く
  assert.match(body, /表示にも記録にも反映されない/, '表示にも記録にも反映されないことを書いていない');
  assert.match(body, /時間重み/, '時間重みとして入れる案を書いていない');
  // 過去の版（スライダーがあったこと・外したこと）には触れない
  assert.doesNotMatch(body, /以前|外しました|廃止|反映されていませんでした/, '過去の版の説明が残っている');
});

test('README と docs/features.md の設定の一覧にスムージングが無い', () => {
  for (const [where, text] of [['README', readme], ['docs/features.md', features]]) {
    const head = text.indexOf('- **リアルタイム設定変更**');
    assert.notEqual(head, -1, `${where}に「リアルタイム設定変更」の項目が無い`);
    const item = text.slice(head, head + 300);
    assert.ok(!item.includes('スムージング'), `${where}の設定の一覧にスムージングが残っている`);
  }
});
