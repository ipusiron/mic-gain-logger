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
// 第2弾c1bでREADMEを入口にし、詳しい説明をdocs/へ分けた。READMEとdocs/を合わせたものが、分ける前のREADMEにあたる
const docsText = name => fs.readFileSync(path.join(root, 'docs', name), 'utf8');
const readmeAndDocs = [readme, ...fs.readdirSync(path.join(root, 'docs')).filter(n => n.endsWith('.md')).map(docsText)].join('\n');
const csvDoc = docsText('csv.md');

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

// ---- 振る舞いで確かめる（第2弾a7）----
// ⚠ 公開前の点検で、ソースの文字列だけを見るテストでは、unknown の一覧を落として
//    off に戻しても、画面の条件を反転させても通ることが分かった。
//    組み立てを logic.js の純関数へ出し、Safari 相当の設定を渡して結果を見る

const { chainHeaderMeta, recordNoticeItems } = require('../logic.js');
const SAFARI = { echoCancellation: false };   // WebKit の getSettings が返すのは echoCancellation だけ
const firstRec = { engine: 'worklet', ts: new Date(Date.UTC(2026, 8, 29, 0, 0, 1)) };

test('⭐Safari 相当の設定では、ヘッダーの processing が unknown:autoGainControl+noiseSuppression', () => {
  const meta = chainHeaderMeta({ sessionMeta: metaOf(SAFARI), firstRec, engineMode: 'worklet', hashAlgo: 'x' });
  assert.equal(meta.processing, 'unknown:autoGainControl+noiseSuppression');
  assert.equal(meta.started, '2026-09-29T00:00:01.000Z');
});

test('3項目とも無効と報告されたときだけ、ヘッダーが off', () => {
  const meta = chainHeaderMeta({
    sessionMeta: metaOf({ autoGainControl: false, noiseSuppression: false, echoCancellation: false }),
    firstRec
  });
  assert.equal(meta.processing, 'off');
});

test('一覧が欠けた形を渡しても off と推し量らない', () => {
  // 点検で使われた書き換え（unknown の一覧を落とす）を、関数の入口で止める
  assert.equal(processingLabel({ processingActive: [] }), 'unknown');
  assert.equal(processingLabel({ processingUnknown: [] }), 'unknown');
});

test('⭐注意書き: unknown なら「不明」の項目を出し、off なら出さない', () => {
  const unk = recordNoticeItems({ sessionMeta: metaOf(SAFARI) });
  assert.deepEqual(unk.map(i => i.kind), ['processingUnknown']);
  assert.equal(unk[0].short, '音の加工の状態が不明（autoGainControl, noiseSuppression）');
  const off = recordNoticeItems({
    sessionMeta: metaOf({ autoGainControl: false, noiseSuppression: false, echoCancellation: false })
  });
  assert.deepEqual(off, []);
  const act = recordNoticeItems({ sessionMeta: metaOf({ echoCancellation: true, noiseSuppression: false, autoGainControl: false }) });
  assert.deepEqual(act.map(i => i.kind), ['processingActive']);
  // 記録を始める前（測定条件なし）は加工の注意を出さない
  assert.deepEqual(recordNoticeItems({}), []);
});

test('script.js はヘッダーと注意書きを logic.js の関数で組み立てる', () => {
  const chain = script.slice(script.indexOf('function chainMetaOf'), script.indexOf('function csvTrailerExtraOf'));
  assert.match(chain, /chainHeaderMeta\(\{/);
  assert.doesNotMatch(chain, /'off'/, "chainMetaOf に 'off' の決め打ちが残っている");
  const render = script.slice(script.indexOf('function renderRecordNotice'), script.indexOf('function ensureNoticeDom'));
  // 第2弾c3aから、画面の言語（lang）も渡す
  assert.match(render, /recordNoticeItems\(\{\s*deviceLoss, deviceMuted, sessionMeta, clockBreaks, stats, lang\s*\}\)/);
});

test('docs/csv.md の processing の説明が3つの書き方を言い、過去の版の書き方には触れていない', () => {
  const row = csvDoc.split('\n').find(l => l.startsWith('| `processing` |'));
  assert.ok(row, 'processing の行が無い');
  for (const w of ['off', 'active:', 'unknown:']) assert.ok(row.includes(w), `${w} が無い`);
  // 第2弾c1bで、過去の版の説明（c7b6bad までの版は報告しない項目があっても off と書いていた）を消した。
  // README・docs/ にはいまの版で正しいことだけを書く（本人の指示 2026-09-29）。経緯は CLAUDE.md にある
  assert.doesNotMatch(readmeAndDocs, /c7b6bad[^\n]*processing=off/);
  assert.ok(!row.includes('までの版'), 'processing の行に過去の版の説明が残っている');
});
