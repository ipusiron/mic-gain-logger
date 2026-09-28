// CSV のメタ行 `# processing=` は、getSettings() が報告した事実だけを書く。
//
// ⚠⚠ 改修前（c7b6bad）は script.js の chainMetaOf が
//    「有効と報告された項目が無ければ off」と書いていた。報告しない項目
//    （unknown）があっても off になる。logic.js は off／active／unknown の3値を
//    持っていたのに、書き出す直前で2値へ潰していた。
//    Safari は autoGainControl を報告しないことがある（WebKit Bugzilla 204444）。
//    iPhone の実機のCSVが `# processing=off` だったのを見て、渚は
//    「AEC/NS/AGC が切れたと報告されている」と読み違えた（2026-09-29）。
//    ハッシュチェーンで固めているぶん、この誤った名乗りは強く残る。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildSessionMeta, processingLabel, processingVerdict,
  PROCESSING_OFF, PROCESSING_ACTIVE, PROCESSING_UNKNOWN
} = require('../logic.js');

const root = path.join(__dirname, '..');
const script = fs.readFileSync(path.join(root, 'script.js'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

const metaOf = (settings) => buildSessionMeta({ id: 's1', settings });

test('3項目すべてが無効と報告されたときだけ off', () => {
  const m = metaOf({ autoGainControl: false, noiseSuppression: false, echoCancellation: false });
  assert.equal(processingVerdict(m), PROCESSING_OFF);
  assert.equal(processingLabel(m), 'off');
});

test('⭐報告しない項目があれば off と書かない（Safari の autoGainControl）', () => {
  const m = metaOf({ noiseSuppression: false, echoCancellation: false });
  assert.equal(processingVerdict(m), PROCESSING_UNKNOWN);
  assert.equal(processingLabel(m), 'unknown:autoGainControl');
});

test('何も報告しなければ3項目とも unknown', () => {
  assert.equal(processingLabel(metaOf({})),
    'unknown:autoGainControl+noiseSuppression+echoCancellation');
});

test('有効な項目は active、報告しない項目は unknown として両方書く', () => {
  const m = metaOf({ echoCancellation: true, noiseSuppression: false });
  assert.equal(processingVerdict(m), PROCESSING_ACTIVE);
  assert.equal(processingLabel(m), 'active:echoCancellation;unknown:autoGainControl');
});

test('任意の加工（voiceIsolation）は、有効と報告されたときだけ active に入る', () => {
  const m = metaOf({
    autoGainControl: false, noiseSuppression: false, echoCancellation: false,
    voiceIsolation: true
  });
  assert.equal(processingLabel(m), 'active:voiceIsolation');
});

test('測定条件が無ければ unknown（off と推し量らない）', () => {
  assert.equal(processingLabel(null), 'unknown');
});

test('script.js は processingLabel を通して書く（off を決め打ちしない）', () => {
  const start = script.indexOf('function chainMetaOf');
  const body = script.slice(start, script.indexOf('function csvTrailerExtraOf'));
  assert.match(body, /processing:\s*processingLabel\(/);
  assert.doesNotMatch(body, /:\s*'off'/, "chainMetaOf に 'off' の決め打ちが残っている");
});

test('報告しない項目があることを画面にも出す', () => {
  const start = script.indexOf('function renderRecordNotice');
  const body = script.slice(start, script.indexOf('// ---- 測定条件の取得'));
  assert.match(body, /PROCESSING_UNKNOWN/);
});

test('README の processing の説明が3つの書き方と過去の版の誤りを言っている', () => {
  const row = readme.split('\n').find(l => l.startsWith('| `processing` |'));
  assert.ok(row, 'processing の行が無い');
  for (const w of ['off', 'active:', 'unknown:']) assert.ok(row.includes(w), `${w} が無い`);
  assert.match(readme, /c7b6bad[^\n]*processing=off/);
});
