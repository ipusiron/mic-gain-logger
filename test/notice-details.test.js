// 注意書きは「件数と要点の1行」を出し、全文は開いて読む（第2弾a6）。
//
// ⚠ 改修前（c7b6bad）は、クリップと有効サンプル率の注意書きを ' / ' でつないだ
//    1本の文字列で出していた。iPhone の実機で430px幅に5行（90px）を占め、
//    統計が画面の外へ押し出された（320px幅では6行・108px）。
//    中身は第1弾で「限界を正しく書く」ために書いたものなので、削らずに出し方を変える。
//    要約の行には判断に使う数（件数と最悪値）だけを出し、理由と対処は全文に残す。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  createStats, addStatsRecord, statsWarnings, statsWarningItems, noticeSummary,
  buildIntervalRecord
} = require('../logic.js');

const root = path.join(__dirname, '..');
const script = fs.readFileSync(path.join(root, 'script.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

const SR = 48000;
const ANCHOR = { epoch: 0, audioTime: 0, wallMs: Date.UTC(2026, 8, 29, 0, 0, 0) };
const recordOf = (seq, over) => buildIntervalRecord(Object.assign({
  type: 'interval', seq, sampleRate: SR, startFrame: seq * SR, endFrame: (seq + 1) * SR,
  expected: SR, count: SR, sumSq: SR * 0.01, peak: 0.14, clip: 0, clipRun: 0, emittedAt: seq + 1
}, over), ANCHOR, -90);
const statsOf = (recs) => { const s = createStats(); recs.forEach(r => addStatsRecord(s, r)); return s; };

test('注意の項目は、要点（short）と全文（full）を持つ', () => {
  const items = statsWarningItems(statsOf([
    recordOf(0, { peak: 1, clip: 8, clipRun: 1 }),
    recordOf(1, { count: Math.round(SR * 0.749) })
  ]));
  assert.equal(items.length, 2);
  assert.equal(items[0].short, 'クリップ1区間（単発のみ）');
  assert.equal(items[1].short, '有効サンプル率 最小74.9%');
  for (const it of items) assert.ok(it.full.length > it.short.length);
});

test('連続したクリップがあれば、要点にも出す', () => {
  const items = statsWarningItems(statsOf([recordOf(0, { peak: 1, clip: 40, clipRun: 12 })]));
  assert.equal(items[0].short, 'クリップ1区間（連続あり）');
});

test('statsWarnings は全文の一覧のまま（既存の呼び方を変えない）', () => {
  const s = statsOf([recordOf(0, { peak: 1, clip: 3, clipRun: 1 }), recordOf(1, { count: SR / 2 })]);
  assert.deepEqual(statsWarnings(s), statsWarningItems(s).map(i => i.full));
});

test('要約の1行は件数と要点を並べる', () => {
  assert.equal(noticeSummary([{ short: 'A', full: 'a' }, { short: 'B', full: 'b' }]),
    '記録の注意 2件：A／B');
  assert.equal(noticeSummary([]), '');
});

test('⭐script.js は注意書きを details に畳み、開いた状態を描き直しで失わない', () => {
  const start = script.indexOf('function renderRecordNotice');
  const body = script.slice(start, script.indexOf('// ---- 測定条件の取得'));
  assert.match(body, /createElement\('details'\)/);
  assert.match(body, /createElement\('summary'\)/);
  assert.match(body, /noticeSummary\(/);
  // 区間ごとに組み直すので、開いていた details が毎秒閉じないようにする
  assert.match(body, /\.open\s*=\s*noticeOpen/);
  assert.match(script, /addEventListener\('toggle'/);
  // 中身は textContent で入れる（HTML として解釈させない）
  assert.doesNotMatch(body, /innerHTML/);
  // 項目は logic.js の recordNoticeItems から作る（振る舞いは test/processing-label.test.js が確かめる）
  assert.match(body, /recordNoticeItems\(/);
});

test('⭐注意書きの入れ物は一度だけ作り、中身だけを差し替える', () => {
  // 公開前の点検で見つかった。区間ごとに details を作り直していたので、フォーカスと
  // 開閉の操作が失われ、同じ要約が読み上げ直された
  const start = script.indexOf('function renderRecordNotice');
  const render = script.slice(start, script.indexOf('function ensureNoticeDom'));
  assert.doesNotMatch(render, /createElement\('details'\)/, '描画のたびに details を作っている');
  const ensure = script.slice(script.indexOf('function ensureNoticeDom'));
  assert.match(ensure.slice(0, ensure.indexOf('\n  }')), /if \(noticeDetails\) return/);
  // 変わったところだけ差し替える
  assert.match(render, /noticeSummaryEl\.textContent !== summaryText/);
  assert.match(render, /li\.textContent !== it\.full/);
});

test('読み上げは要約が変わったときだけ（注意書きそのものは読み上げ領域にしない）', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const notice = html.match(/<div id="recordNotice"[^>]*>/)[0];
  assert.doesNotMatch(notice, /aria-live|role="status"/);
  const live = html.match(/<div id="recordNoticeLive"[^>]*>/);
  assert.ok(live, '読み上げ用の要素が無い');
  assert.match(live[0], /role="status"/);
  assert.match(live[0], /class="sr-only"/);
  const start = script.indexOf('function renderRecordNotice');
  const render = script.slice(start, script.indexOf('function ensureNoticeDom'));
  assert.match(render, /summaryText !== lastNoticeSummary/);
});

test('畳んだ注意書きの見た目（押せる・箇条の余白）を CSS で持つ', () => {
  assert.match(css, /\.record-notice summary\s*\{[^}]*cursor:\s*pointer/);
  assert.match(css, /\.record-notice ul\s*\{/);
});
