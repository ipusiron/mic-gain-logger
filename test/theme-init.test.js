'use strict';

// テーマの初期判定（theme-init.js）。
//
// テーマの判定を script.js（</body> の直前）で行うと、CSS の既定のダークで描いたあとにライトへ切り替わって見えた。
// 判定を theme-init.js へ移し、<head> の style.css のあとで同期読み込みする形にした。
// 判定は script.js にあったものと同じ: 保存値 theme が dark のときだけダーク、それ以外はライト（OS の設定は見ない）。
// <head> の時点では <body> が無いので、light は <html> に付け、CSS は「.light body」で受ける。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const source = read('theme-init.js');

// 保存値と OS の設定を差し替えた仮の環境で動かし、<html> に light が付くかを返す
function run({ saved = null, prefersDark = false, storageThrows = false } = {}) {
  const classes = new Set();
  const keys = [];
  const context = {
    localStorage: {
      getItem: key => {
        keys.push(key);
        if (storageThrows) throw new Error('blocked');
        return saved;
      }
    },
    matchMedia: () => ({ matches: prefersDark }),
    document: { documentElement: { classList: { add: c => classes.add(c) } } }
  };
  vm.runInNewContext(source, context);
  return { light: classes.has('light'), keys };
}

test('保存値がなければ、OS の設定にかかわらずライト', () => {
  assert.equal(run({ prefersDark: false }).light, true);
  assert.equal(run({ prefersDark: true }).light, true);
});

test('保存値 dark のときだけダーク、light ならライト', () => {
  assert.equal(run({ saved: 'dark', prefersDark: false }).light, false);
  assert.equal(run({ saved: 'light', prefersDark: true }).light, true);
});

test('想定外の保存値はライト', () => {
  assert.equal(run({ saved: 'blue', prefersDark: true }).light, true);
});

test('localStorage が使えなくても落ちず、ライトになる', () => {
  assert.equal(run({ storageThrows: true, prefersDark: true }).light, true);
});

test('保存キーは script.js と同じ theme', () => {
  assert.deepEqual(run().keys, ['theme']);
  assert.match(read('script.js'), /localStorage\.setItem\('theme', isDarkMode \? 'dark' : 'light'\)/);
});

test('index.html の <head> で、style.css のあとに同期読み込みする', () => {
  const html = read('index.html');
  const head = html.slice(0, html.indexOf('</head>'));
  assert.ok(head.includes('<script src="./theme-init.js"></script>'), '<head> に theme-init.js がない');
  assert.ok(head.indexOf('style.css') < head.indexOf('theme-init.js'));
});

test('light は <html> で切り替え、CSS は .light body で受ける', () => {
  const script = read('script.js');
  assert.match(script, /document\.documentElement\.classList\.toggle\('light', !isDarkMode\)/);
  assert.doesNotMatch(script, /document\.body\.classList\.(?:add|remove|toggle)\('light'/);
  const css = read('style.css');
  assert.doesNotMatch(css, /body\.light/);
  assert.match(css, /^\.light body\{/m);
});
