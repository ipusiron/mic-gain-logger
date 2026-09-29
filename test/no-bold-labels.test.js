'use strict';

// 箇条書きの先頭の項目名を太字にしない（本人の判断 2026-09-30）。
// 強調を一節に二か所までにしたあとも、「- **名前**：」の形の太字が README と docs に約200か所あり、
// 見た目の太字はまだ多かった。項目名は「- 名前：」「- 名前」＋改行の形で書く。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const mdFiles = ['README.md', 'README.en.md']
  .concat(fs.readdirSync(path.join(root, 'docs')).filter(n => n.endsWith('.md')).map(n => 'docs/' + n))
  .concat(fs.readdirSync(path.join(root, 'docs', 'en')).filter(n => n.endsWith('.md')).map(n => 'docs/en/' + n));

const LEAD = /^\s*(?:[-*]|\d+\.)\s+\*\*[^*\n]+\*\*/;

function outsideFences(text) {
  let inCode = false;
  return text.split('\n').filter(l => {
    if (l.trimStart().startsWith('```')) { inCode = !inCode; return false; }
    return !inCode;
  });
}

test('README と docs（日英）の箇条書きの先頭の項目名が太字になっていない', () => {
  const found = [];
  for (const rel of mdFiles) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    outsideFences(text).forEach(l => { if (LEAD.test(l)) found.push(`${rel}: ${l.slice(0, 50)}`); });
  }
  assert.deepEqual(found, [], `項目名が太字になっている行が ${found.length} 行ある`);
});

test('検査が空振りしていない（太字の項目名を見つける）', () => {
  assert.ok(LEAD.test('- **名前**：本文'));
  assert.ok(LEAD.test('1. **Name**: text'));
  assert.ok(!LEAD.test('- 名前：**強調**'));
});
