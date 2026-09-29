'use strict';

// スマートフォンのファーストビュー（第2弾c0）。
//
// 設計書§3のQ3（本人の決定 2026-09-29）＝開始と停止を1つの場所にまとめ、書き出しとリセットは「その他」へ寄せる。
// 改修前（090648f）は幅375px・430pxのどちらでも、ヘッダーとボタンが画面の上から242.6pxを使っていた
// （ヘッダー81.6px → ヘルプとテーマの行 → 記録開始・停止の行 → 書き出し・リセットの行）。
//  - 記録開始（#startBtn）と停止（#stopBtn）は同じ場所に置き、そのとき押せるほうだけを見せる。
//    見せないほうはhiddenで支援技術からも隠す。IDは変えない（テストと測定のスクリプトが使っている）
//  - CSV書き出し（#exportBtn）と統計リセット（#resetBtn）は、幅480px以下では「その他」（#moreBtn）で開く
//    #moreMenuにまとめる。481px以上ではこれまでどおり並べる。押せる条件は変えない
//  - 「その他」はaria-expanded・aria-controlsを持ち、Escで閉じてフォーカスを「その他」へ戻す
//    （フォーカスが中身か「その他」にあったときだけ。Tabで外へ移ったあとのEscは閉じるだけで、フォーカスを奪わない）
//  - ヘルプとテーマの切り替えを480pxで別の行へ付け替えていたhandleMobileButtonLayoutは廃止した
//    （resizeが届かない経路で不整合が固定される壊れやすい仕組みだった）。並びはstyle.cssだけで決める
//  - モーダルの高さはvhのあとにdvhを書く（iOS Safariのvhはツールバーを畳んだときの高さ）
// 判定はlogic.jsのstartStopView・moreMenuNextで行い、ここで振る舞いを確かめる。script.jsはDOMに入れるだけ。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { startStopView, moreMenuNext, COMPACT_MEDIA_QUERY } = require('../logic.js');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'script.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

// コメントを外した関数の本体（次のfunction宣言の手前まで）
function bodyOf(name) {
  const start = script.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name}が見つからない`);
  const next = script.indexOf('\n  function ', start + 10);
  const nextAsync = script.indexOf('\n  async function ', start + 10);
  const ends = [next, nextAsync].filter(i => i > 0);
  return script.slice(start, ends.length ? Math.min(...ends) : undefined)
    .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
}

// style.cssを並び順つきで「トップレベルの規則」と「@mediaブロック」に分ける（test/css-order.test.jsと同じ数え方）
function blocks(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1) break;
    const head = src.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < src.length && depth > 0) {
      if (src[j] === '{') depth += 1;
      else if (src[j] === '}') depth -= 1;
      j += 1;
    }
    out.push({ head, body: src.slice(open + 1, j - 1) });
    i = j;
  }
  return out;
}

function declOf(body, prop) {
  const m = body.match(new RegExp('(?:^|;|\\s)' + prop + '\\s*:\\s*([^;]+)'));
  return m ? m[1].trim() : null;
}

// セレクター（完全一致）の宣言を、トップレベルか、指定した@mediaの中から拾う
function ruleIn(list, selector) {
  return list.find(b => b.head.split(',').map(s => s.replace(/\s+/g, ' ').trim()).includes(selector)) || null;
}

const all = blocks(css);
const top = all.filter(b => !b.head.startsWith('@'));
const compactPx = parseInt(COMPACT_MEDIA_QUERY.match(/max-width:\s*(\d+)px/)[1], 10);
const compactBlocks = all
  .filter(b => b.head.startsWith('@media') && new RegExp(`max-width:\\s*${compactPx}px`).test(b.head))
  .map(b => blocks(b.body));
const compactRules = [].concat(...compactBlocks);

// ---- 記録開始と停止の出し分け ----

// script.jsが各状態で入れているdisabledを、状態の遷移の素朴な表として持つ。
// 「そのとき押せるほうだけを見せる」を、この表の押せるボタンとstartStopViewの見せるボタンが同じかで確かめる
const TRANSITIONS = [
  // [場面, running, connecting, 記録開始が押せるか, 停止が押せるか]
  ['記録前', false, false, true, false],
  ['接続中（許可ダイアログを待っているあいだ。停止で取り消せる）', false, true, false, true],
  ['記録中', true, false, false, true],
  ['停止後', false, false, true, false],
  ['接続の取り消し・時間切れ・エラーのあと', false, false, true, false]
];

test('⭐記録前・接続中・記録中・停止後で、押せるほうだけを見せる', () => {
  for (const [label, running, connecting, startEnabled, stopEnabled] of TRANSITIONS) {
    const v = startStopView({ running, connecting });
    assert.equal(v.start, startEnabled, `${label}: 記録開始の出し分け`);
    assert.equal(v.stop, stopEnabled, `${label}: 停止の出し分け`);
    // いつもどちらか1つだけ（同じ場所に2つ並ばない・どちらも消えない）
    assert.equal(Number(v.start) + Number(v.stop), 1, `${label}: 見せるボタンが1つでない`);
  }
  // 引数が無くても記録前として扱う（初期化の途中で呼ばれても落ちない）
  assert.deepEqual(startStopView(), { start: true, stop: false });
});

test('script.jsのdisabledの入れ方が、上の表と同じ（押せるほうと見せるほうがずれない）', () => {
  // 押せる状態はsetRunButtonsの1か所で入れる（2つはいつも逆）
  const set = bodyOf('setRunButtons');
  assert.match(set, /startBtn\.disabled = !startEnabled;/);
  assert.match(set, /stopBtn\.disabled = !!startEnabled;/);
  // 表の「記録開始が押せるか」で呼ぶ（呼んだ直後に出し分ける）
  const start = bodyOf('start');
  const i = start.indexOf('connecting = true');
  assert.match(start.slice(i), /^connecting = true;\s*setRunButtons\(false\);\s*updateButtonStates\(\);/);
  const r = start.indexOf('running = true');
  const upd = 'updateButtonStates();';
  assert.match(start.slice(r, start.indexOf(upd, r) + upd.length), /setRunButtons\(false\);\s*updateButtonStates\(\);$/);
  // 停止したら：記録開始が押せ、停止は押せない
  const stop = bodyOf('stop');
  assert.ok(stop.indexOf('running = false') < stop.indexOf('updateButtonStates()'));
  assert.match(stop, /setRunButtons\(true\);\s*updateButtonStates\(\);/);
  // 取り消し：接続の状態を戻してから出し分ける
  const cancel = bodyOf('cancelConnect');
  assert.ok(cancel.indexOf('finishConnecting()') < cancel.indexOf('updateButtonStates()'));
  assert.match(cancel, /setRunButtons\(true\);\s*updateButtonStates\(\);/);
  // エラー：記録前に戻す
  assert.match(start, /finishConnecting\(\);\s*setRunButtons\(true\);\s*updateButtonStates\(\);/);
  // ほかの場所で記録開始・停止のdisabledを個別に書き換えない（マイク取得に対応していないときの記録開始だけは別）
  const code = script.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  const writes = [...code.matchAll(/(startBtn|stopBtn)\.disabled = [^;]+;/g)].map(m => m[0]);
  assert.deepEqual(writes, ['startBtn.disabled = !startEnabled;', 'stopBtn.disabled = !!startEnabled;', 'startBtn.disabled = true;']);
});

test('⭐Chromiumはフォーカスのあるボタンをdisabledにした瞬間にフォーカスを外すので、変える前に覚えておく', () => {
  const set = bodyOf('setRunButtons');
  const at = set.indexOf('document.activeElement');
  assert.ok(at > 0 && at < set.indexOf('.disabled ='), 'disabledを変える前にフォーカスを見ていない');
  assert.match(set, /if \(focused === startBtn \|\| focused === stopBtn\) runFocusPending = true;/);
  const render = bodyOf('renderStartStop');
  assert.match(render, /const hadFocus = runFocusPending \|\| focused === startBtn \|\| focused === stopBtn;/);
  assert.match(render, /runFocusPending = false;/);
});

test('⭐updateButtonStatesは、startStopViewの結果でhiddenを付け外しする（見せないほうは支援技術からも隠す）', () => {
  assert.match(bodyOf('updateButtonStates'), /renderStartStop\(\);/);
  const body = bodyOf('renderStartStop');
  assert.match(body, /const view = startStopView\(\{ running, connecting \}\);/);
  assert.match(body, /startBtn\.hidden = !view\.start;/);
  assert.match(body, /stopBtn\.hidden = !view\.stop;/);
  // 押したボタンが隠れたら、同じ場所に出たほうへフォーカスを移す（押せないときは移さない）
  assert.match(body, /const shown = view\.stop \? stopBtn : startBtn;/);
  assert.match(body, /if \(hadFocus && focused !== shown && !shown\.disabled\) shown\.focus\(\);/);
  // CSSでもhiddenを確実に隠す（.btnにdisplayを足したときの備え）
  assert.ok(ruleIn(top, '.btn[hidden]'), '.btn[hidden]の規則が無い');
  assert.equal(declOf(ruleIn(top, '.btn[hidden]').body, 'display'), 'none');
});

test('HTML：記録開始と停止は隣り合い、停止は最初からhidden。IDは変えない', () => {
  const m = html.match(/<button id="startBtn"[^>]*>[^<]*<\/button>\s*<button id="stopBtn"[^>]*>/);
  assert.ok(m, '記録開始と停止が隣り合っていない');
  const stopTag = html.match(/<button id="stopBtn"[^>]*>/)[0];
  assert.match(stopTag, /\shidden(\s|>)/, '停止が最初から隠れていない');
  assert.match(stopTag, /\sdisabled(\s|>)/);
  const startTag = html.match(/<button id="startBtn"[^>]*>/)[0];
  assert.doesNotMatch(startTag, /\shidden(\s|>)/);
  // 2つとも同じ幅の下限を持つ（入れ替えても右のボタンが横へずれない）
  for (const tag of [startTag, stopTag]) assert.match(tag, /class="[^"]*\brun-btn\b/);
  assert.ok(ruleIn(top, '.run-btn') && declOf(ruleIn(top, '.run-btn').body, 'min-width'), '.run-btnの幅の下限が無い');
});

// ---- 「その他」 ----

test('HTML：「その他」はaria-expanded="false" とaria-controlsを持ち、直後に中身（書き出し・リセット）がある', () => {
  const more = html.match(/<button id="moreBtn"[^>]*>/);
  assert.ok(more, '「その他」が無い');
  assert.match(more[0], /aria-expanded="false"/);
  assert.match(more[0], /aria-controls="moreMenu"/);
  assert.match(more[0], /type="button"/);
  // CSSの隣接セレクター（.more-btn[aria-expanded="false"] + .more-menu）が当たるように、「その他」の直後に置く
  const pair = html.match(/<button id="moreBtn"[^>]*>[\s\S]*?<\/button>\s*<div id="moreMenu" class="more-menu">([\s\S]*?)<\/div>/);
  assert.ok(pair, '「その他」の直後に#moreMenuが無い');
  const ids = [...pair[1].matchAll(/<button id="([^"]+)"/g)].map(x => x[1]);
  assert.deepEqual(ids, ['exportBtn', 'resetBtn']);
  // 中身も.actionsの中（481px以上では、これまでどおり1列に並ぶ）
  const actions = html.slice(html.indexOf('<div class="actions">'), html.indexOf('<section class="card grid">'));
  for (const id of ['startBtn', 'stopBtn', 'moreBtn', 'moreMenu', 'exportBtn', 'resetBtn', 'helpBtn', 'themeToggle']) {
    assert.ok(actions.includes(`id="${id}"`), `${id}が.actionsの中に無い`);
  }
  // 矢印は飾り（読み上げない）
  assert.match(html, /<span class="more-icon" aria-hidden="true">/);
});

test('⭐「その他」の開閉：押すたびに開閉し、Escで閉じたらフォーカスを「その他」へ戻す（フォーカスが中身か「その他」にあったときだけ）', () => {
  const base = { compact: true, modalOpen: false, itemsEnabled: true, focusInside: false, focusOnToggle: false };
  assert.deepEqual(moreMenuNext({ ...base, open: false }, 'toggle'), { open: true, focusToggle: false });
  assert.deepEqual(moreMenuNext({ ...base, open: true }, 'toggle'), { open: false, focusToggle: false });
  // Esc：開いていれば閉じる。フォーカスを「その他」へ戻すのは、フォーカスが中身か「その他」にあったときだけ
  // （期待値は「中身にある または 「その他」にある」の素朴な式から出す）
  for (const focusInside of [false, true]) {
    for (const focusOnToggle of [false, true]) {
      assert.deepEqual(moreMenuNext({ ...base, open: true, focusInside, focusOnToggle }, 'escape'),
        { open: false, focusToggle: focusInside || focusOnToggle },
        `Esc（中身：${focusInside}・「その他」：${focusOnToggle}）`);
      // 閉じているときのEscは何もしない（ほかの操作のフォーカスを奪わない）
      assert.deepEqual(moreMenuNext({ ...base, open: false, focusInside, focusOnToggle }, 'escape'),
        { open: false, focusToggle: false });
    }
  }
  // ⚠ Tabで外（ヘルプ・設定の入力欄など）へ移ったあとのEscは、閉じるだけでフォーカスを動かさない（第2弾c0の点検）。
  //    外から「その他」へ移すと、設定の入力欄にいた利用者の画面が先頭まで戻る
  assert.deepEqual(moreMenuNext({ ...base, open: true }, 'escape'), { open: false, focusToggle: false });
});

test('「その他」のEsc：481px以上（「その他」を出していない）と、ヘルプを開いているときは受けない', () => {
  // 中身にフォーカスがあっても受けない（481px以上では中身が並んで見えている。ヘルプのEscはヘルプを閉じるもの）
  const base = { open: true, itemsEnabled: true, focusInside: true, focusOnToggle: false };
  assert.deepEqual(moreMenuNext({ ...base, compact: false, modalOpen: false }, 'escape'), { open: true, focusToggle: false });
  assert.deepEqual(moreMenuNext({ ...base, compact: true, modalOpen: true }, 'escape'), { open: true, focusToggle: false });
});

test('「その他」は、外を押したとき・中身がどちらも押せなくなったとき・481px以上へ広げたときに閉じる', () => {
  const base = { compact: true, modalOpen: false, itemsEnabled: true, focusInside: false };
  assert.deepEqual(moreMenuNext({ ...base, open: true }, 'outside'), { open: false, focusToggle: false });
  assert.deepEqual(moreMenuNext({ ...base, open: false }, 'outside'), { open: false, focusToggle: false });
  // 統計リセットのあと（書き出しもリセットも押せない）。中にフォーカスがあれば「その他」へ戻す
  assert.deepEqual(moreMenuNext({ ...base, open: true, itemsEnabled: false, focusInside: true }, 'items'), { open: false, focusToggle: true });
  assert.deepEqual(moreMenuNext({ ...base, open: true, itemsEnabled: false, focusInside: false }, 'items'), { open: false, focusToggle: false });
  // 押せるボタンが残っていれば開いたまま
  assert.deepEqual(moreMenuNext({ ...base, open: true, itemsEnabled: true }, 'items'), { open: true, focusToggle: false });
  // 幅：狭いままなら開いたまま、広げたら閉じる（481px以上ではフォーカスを動かさない）
  assert.deepEqual(moreMenuNext({ ...base, open: true }, 'layout'), { open: true, focusToggle: false });
  assert.deepEqual(moreMenuNext({ ...base, open: true, compact: false }, 'layout'), { open: false, focusToggle: false });
  // 知らない出来事では何も変えない
  assert.deepEqual(moreMenuNext({ ...base, open: true }, 'unknown'), { open: true, focusToggle: false });
});

test('script.js：開閉はaria-expandedだけで持ち、Escは捕獲で受け、外の操作はclickで受ける', () => {
  const apply = bodyOf('applyMoreMenu');
  assert.match(apply, /moreMenuNext\(\{/);
  assert.match(apply, /compact: !!\(compactQuery && compactQuery\.matches\)/);
  assert.match(apply, /modalOpen: !!\(helpModal && helpModal\.classList\.contains\('show'\)\)/);
  assert.match(apply, /itemsEnabled: !exportBtn\.disabled \|\| !resetBtn\.disabled/);
  assert.match(apply, /focusInside: \(seen && typeof seen\.focusInside === 'boolean'\)\s*\?\s*seen\.focusInside\s*:\s*moreMenuEl\.contains\(document\.activeElement\)/);
  // Escで「その他」へフォーカスを戻してよいかを決めるため、「その他」にフォーカスがあるかも渡す（第2弾c0の点検）
  assert.match(apply, /focusOnToggle: document\.activeElement === moreBtn/);
  assert.match(apply, /moreBtn\.setAttribute\('aria-expanded', String\(next\.open\)\)/);
  assert.match(apply, /if \(next\.focusToggle\) moreBtn\.focus\(\);/);
  assert.match(script, /const compactQuery = [^;]*window\.matchMedia\(COMPACT_MEDIA_QUERY\)/);
  const setup = bodyOf('setupMoreMenu');
  assert.match(setup, /moreBtn\.addEventListener\('click', \(\) => applyMoreMenu\('toggle'\)\)/);
  // ヘルプのEsc（バブリング）より先に、ヘルプが開いているかを見る
  assert.match(setup, /document\.addEventListener\('keydown', \(e\) => \{\s*if \(e\.key === 'Escape'\) applyMoreMenu\('escape'\);\s*\}, true\);/);
  // 押した瞬間に閉じると下の画面が上がって別のものを押してしまうので、pointerdownでは閉じない
  assert.match(setup, /document\.addEventListener\('click', \(e\) => \{/);
  assert.doesNotMatch(setup, /pointerdown|mousedown|touchstart/);
  assert.match(setup, /applyMoreMenu\('outside'\)/);
  // CSV書き出しのダウンロード（リンクのclick()）で閉じない。利用者の操作のclickだけを受ける
  assert.match(setup, /if \(!e\.isTrusted\) return;\s*if \(moreBtn\.contains\(e\.target\) \|\| moreMenuEl\.contains\(e\.target\)\) return;\s*applyMoreMenu\('outside'\);/);
  assert.match(script, /a\.click\(\);/, '書き出しがリンクのclick()を使っていない（前提が変わったらisTrustedの判定を見直す）');
  assert.match(setup, /compactQuery\.addEventListener\('change', \(\) => applyMoreMenu\('layout'\)\)/);
  // 中身の押せる状態が変わるところ（updateButtonStates）で閉じるかを見る。
  // ⚠ Chromiumは押せなくなったボタンからその場でフォーカスを外すので、中にフォーカスがあったかはdisabledを変える前に見る
  const upd = bodyOf('updateButtonStates');
  assert.match(upd, /applyMoreMenu\('items', \{ focusInside: menuHadFocus \}\);/);
  const seen = upd.indexOf('const menuHadFocus = !!moreMenuEl && moreMenuEl.contains(document.activeElement);');
  assert.ok(seen >= 0 && seen < upd.indexOf('exportBtn.disabled'), '押せる状態を変える前にフォーカスを見ていない');
  // ヘルプより先に「その他」を組み立てる（どちらも初期化で1回だけ）
  const init = script.slice(script.indexOf('\n  setupMoreMenu();'));
  assert.ok(init.indexOf('setupMoreMenu();') < init.indexOf('setupHelpModal();'));
});

test('⭐CSS：「その他」は幅480px以下でだけ出し、閉じているあいだは中身を隠す。481px以上では中身を並べる', () => {
  // logic.jsの幅と、style.cssの@mediaの幅が同じ
  assert.ok(compactBlocks.length >= 1, `@media (max-width: ${compactPx}px)が無い`);
  // 基本の規則（481px以上でも当てはまる）：「その他」は出さず、中身はdisplay:contentsで.actionsの並びに入る
  assert.equal(declOf(ruleIn(top, '.more-btn').body, 'display'), 'none');
  assert.equal(declOf(ruleIn(top, '.more-menu').body, 'display'), 'contents');
  // 480px以下：「その他」を出し、閉じているあいだは中身を隠し、開いたら次の行に2列で出す
  assert.equal(declOf(ruleIn(compactRules, '.more-btn').body, 'display'), 'inline-flex');
  const closed = ruleIn(compactRules, '.more-btn[aria-expanded="false"] + .more-menu');
  assert.ok(closed, '閉じているときに中身を隠す規則が無い');
  assert.equal(declOf(closed.body, 'display'), 'none');
  const menu = ruleIn(compactRules, '.more-menu');
  assert.equal(declOf(menu.body, 'display'), 'grid');
  assert.equal(declOf(menu.body, 'flex-basis'), '100%');
  // 基本の規則は、打ち消す相手の@media (max-width: 480px)より前にある（test/css-order.test.jsの約束）
  const firstCompact = css.search(new RegExp(`@media\\s*\\(\\s*max-width:\\s*${compactPx}px`));
  assert.ok(firstCompact > 0);
  for (const sel of ['.more-btn{', '.more-menu{', '.btn[hidden]{', '.run-btn{']) {
    const at = css.indexOf(sel);
    assert.ok(at > 0 && at < firstCompact, `${sel}が@media (max-width: ${compactPx}px)の後ろにある`);
  }
});

test('CSS：480px以下では、記録開始／停止・「その他」・ヘルプ・テーマを1行に並べる（タッチターゲット44px）', () => {
  const actions = ruleIn(compactRules, '.actions');
  assert.equal(declOf(actions.body, 'display'), 'flex');
  assert.equal(declOf(actions.body, 'flex-wrap'), 'wrap');
  assert.equal(declOf(ruleIn(compactRules, '.run-btn').body, 'flex'), '1 1 auto');
  const icons = ruleIn(compactRules, '.help-btn');
  for (const prop of ['min-width', 'min-height']) {
    const v = parseFloat(declOf(icons.body, prop));
    assert.ok(v >= 44, `.help-btn・.theme-toggleの${prop}が${v}px`);
  }
  assert.ok(parseFloat(declOf(ruleIn(compactRules, '.actions .btn').body, 'min-height')) >= 44);
});

test('⭐handleMobileButtonLayoutと#mobileControlsを廃止した（親要素の付け替えをしない）', () => {
  const code = script.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  assert.doesNotMatch(code, /handleMobileButtonLayout|setupMobileButtonLayout|mobileControls/);
  assert.doesNotMatch(code, /appendChild\(helpBtn\)|appendChild\(themeToggle\)/);
  assert.doesNotMatch(html, /id="mobileControls"|class="mobile-controls"/);
  assert.doesNotMatch(css, /\.mobile-controls/);
  // ヘルプとテーマは.actionsの中（どの幅でも）
  const actions = html.slice(html.indexOf('<div class="actions">'), html.indexOf('<section class="card grid">'));
  assert.match(actions, /<button id="helpBtn"/);
  assert.match(actions, /<button id="themeToggle"/);
});

// ---- iOSの画面の高さ ----

test('vhを使う箇所は、後ろにdvhを書く（dvhを読めないブラウザーはvhのまま）', () => {
  const lines = css.split('\n');
  const uses = [];
  lines.forEach((line, i) => {
    const m = line.match(/^\s*([-\w]+)\s*:\s*(\d+(?:\.\d+)?)vh\s*;/);
    if (m) uses.push({ i, prop: m[1], n: m[2] });
  });
  assert.ok(uses.length > 0, 'vhを使う箇所が見つからない（検査の前提が崩れた）');
  for (const u of uses) {
    const next = lines[u.i + 1] || '';
    assert.match(next, new RegExp(`^\\s*${u.prop}\\s*:\\s*${u.n.replace('.', '\\.')}dvh\\s*;`),
      `${u.prop}: ${u.n}vhの後ろに${u.n}dvhが無い（${u.i + 1}行目）`);
  }
  // dvhだけ（vhの前置きなし）で書かない
  lines.forEach((line, i) => {
    const m = line.match(/^\s*([-\w]+)\s*:\s*(\d+(?:\.\d+)?)dvh\s*;/);
    if (!m) return;
    assert.match(lines[i - 1] || '', new RegExp(`^\\s*${m[1]}\\s*:\\s*${m[2].replace('.', '\\.')}vh\\s*;`),
      `${i + 1}行目のdvhの前にvhが無い`);
  });
});

test('viewport-fit=coverは入れない（セーフエリアの扱いは実機で測ってから決める）', () => {
  const meta = html.match(/<meta name="viewport"[^>]*>/);
  assert.ok(meta);
  assert.doesNotMatch(meta[0], /viewport-fit/);
});

// ---- ヘルプ・README ----

test('ヘルプとREADMEが、ボタンの配置（同じ場所の記録開始と停止・「その他」）を説明している', () => {
  // 第2弾c3aで見出しに辞書のキー（data-i18n）を付けたので、属性を許して探す
  const mobile = html.slice(html.search(/<h3[^>]*>📱 モバイル利用について<\/h3>/), html.search(/<h3[^>]*>⚠️ 重要な注意事項<\/h3>/));
  assert.match(mobile, /<strong>ボタンの配置：<\/strong>[^<]*「その他」/);
  assert.match(mobile, /同じ場所/);
  assert.match(mobile, /Esc/);
  const basic = html.slice(html.search(/<h3[^>]*>🎯 基本的な使い方<\/h3>/), html.search(/<h3[^>]*>⚙️ 設定項目<\/h3>/));
  assert.match(basic, /「CSV書き出し」<\/strong>[^<]*「その他」/);
  assert.match(basic, /「統計リセット」<\/strong>[^<]*「その他」/);
  assert.match(readme, /「その他」/);
  assert.ok(readme.includes('記録開始と停止は同じ場所'), 'READMEに記録開始と停止の置き方が無い');
});
