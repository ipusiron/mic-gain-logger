// CSV のハッシュチェーン。
//
// ⚠⚠ これは「改ざんを防ぐ」ものではない。
// ログを作った本人はチェーンごと作り直せるので、提出者自身が疑われる場面
// （探偵が自分で採ったログを裁判資料に出す、など）では主張が立たない。
// 守れるのは「配布されたあとに、第三者が一部を消す／並べ替える」ことの検出だけである。
//
// 名乗りを下げたことを README に書くだけでなく、ここで機械にも示しておく。
// 最後のテストが「作り直せてしまう」ことを固定しているのは、そのためである。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCsv, csvDataFields, csvSeed, csvMetaLines,
  hashInput, HASH_HEX_LEN, HASH_ALGO_LABEL, CSV_COLUMNS
} = require('../logic.js');

function rec(seq, db, ms) {
  return {
    ts: new Date(Date.UTC(2026, 8, 28, 5, 0, seq, 0) + (ms || 0)),
    rawDb: db, db, seq, peakDb: db + 3, clipCount: 0, validRatio: 1
  };
}

// script.js の computeHashChain と同じ手順。実装を写さず、ここで独立に組む。
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function chainOf(rows, seed) {
  let prev = (await sha256Hex(seed)).slice(0, HASH_HEX_LEN);
  const out = [];
  for (const r of rows) {
    prev = (await sha256Hex(hashInput(prev, csvDataFields(r)))).slice(0, HASH_HEX_LEN);
    out.push(prev);
  }
  return out;
}

// CSVを読み直して、チェーンが通っているかを確かめる（受け取った側の立場）
async function verifyCsv(csv) {
  const lines = csv.split('\n');
  const seed = lines.filter(l => l.startsWith('#')).join('\n');
  const data = lines.filter(l => l && !l.startsWith('#')).slice(1);
  let prev = (await sha256Hex(seed)).slice(0, HASH_HEX_LEN);
  for (let i = 0; i < data.length; i++) {
    const cells = data[i].split(',');
    const fields = cells.slice(0, CSV_COLUMNS.length - 1);
    const want = (await sha256Hex(hashInput(prev, fields))).slice(0, HASH_HEX_LEN);
    if (cells[CSV_COLUMNS.length - 1] !== want) return { ok: false, brokeAt: i };
    prev = want;
  }
  return { ok: true, brokeAt: -1 };
}

const ROWS = [rec(1, -20), rec(2, -25), rec(3, -18), rec(4, -30)];
const META = { engine: 'worklet', sampleRate: 48000, intervalSec: 1 };

test('hashInput: 前のハッシュを材料に混ぜる（鎖になる）', () => {
  const f = ['2026-09-28T05:00:01.000Z', '-20.00', '1', '-17.00', '0', '1.000'];
  assert.equal(hashInput('abc', f), 'abc|' + f.join(','));
  // 前のハッシュが違えば材料も違う＝以降の値が連鎖して変わる
  assert.notEqual(hashInput('abc', f), hashInput('abd', f));
  // 最初の行は空で始まってよい
  assert.equal(hashInput(null, f), '|' + f.join(','));
});

test('ハッシュ列がCSVに入り、メタ行にアルゴリズムが出る', async () => {
  const seed = '# x=1';
  const hashes = await chainOf(ROWS, seed);
  const csv = buildCsv(ROWS, { meta: META, hashes });
  assert.ok(csv.includes('# hash=' + HASH_ALGO_LABEL), csv.split('\n').slice(0, 9).join(' / '));
  const data = csv.split('\n').filter(l => l && !l.startsWith('#')).slice(1);
  assert.equal(data.length, ROWS.length);
  for (let i = 0; i < data.length; i++) {
    const cells = data[i].split(',');
    assert.equal(cells.length, CSV_COLUMNS.length);
    assert.equal(cells[cells.length - 1], hashes[i]);
    assert.equal(hashes[i].length, HASH_HEX_LEN);
  }
});

test('そのまま読み直せば、チェーンは通る', async () => {
  const csv = await buildVerifiable();
  const v = await verifyCsv(csv);
  assert.equal(v.ok, true, `${v.brokeAt} 行目で切れた`);
});

test('途中の行を消すと、そこから先が合わなくなる', async () => {
  const csv = await buildVerifiable();
  const lines = csv.split('\n');
  const head = lines.filter(l => l.startsWith('#'));
  const data = lines.filter(l => l && !l.startsWith('#'));
  // データ2行目（ヘッダーの次の次）を削る
  const broken = head.concat(data.slice(0, 2), data.slice(3)).join('\n');
  const v = await verifyCsv(broken);
  assert.equal(v.ok, false, '消したのに通ってしまった');
  assert.equal(v.brokeAt, 1, '切れた位置が違う');
});

test('行を入れ替えると合わなくなる', async () => {
  const csv = await buildVerifiable();
  const lines = csv.split('\n');
  const head = lines.filter(l => l.startsWith('#'));
  const data = lines.filter(l => l && !l.startsWith('#'));
  const body = data.slice(1);
  const swapped = [body[1], body[0]].concat(body.slice(2));
  const v = await verifyCsv(head.concat([data[0]], swapped).join('\n'));
  assert.equal(v.ok, false, '並べ替えたのに通ってしまった');
});

test('値を1つ書き換えると合わなくなる', async () => {
  const csv = await buildVerifiable();
  const v = await verifyCsv(csv.replace(',-25.00,', ',-05.00,'));
  assert.equal(v.ok, false, '書き換えたのに通ってしまった');
});

test('メタ行を書き換えると、1行目から合わなくなる', async () => {
  // 鎖の起点は記録の条件そのもの。条件を偽ると全部が崩れる
  const csv = await buildVerifiable();
  const v = await verifyCsv(csv.replace('# sampleRate=48000', '# sampleRate=44100'));
  assert.equal(v.ok, false);
  assert.equal(v.brokeAt, 0);
});

test('⚠ 作った本人は、チェーンごと作り直せてしまう', async () => {
  // これがこの仕組みの限界である。「改ざんを防ぐ」とは名乗れない。
  // 値を書き換えたうえで、ハッシュを計算し直せば、検証は通ってしまう。
  const tampered = ROWS.map((r, i) => (i === 1 ? Object.assign({}, r, { rawDb: -5, db: -5 }) : r));
  const seed = ['# format=mic-gain-logger/2', '# engine=worklet',
    '# sampleRate=48000', '# intervalSec=1', '# weighting=Z',
    '# hash=' + HASH_ALGO_LABEL].join('\n');
  const hashes = await chainOf(tampered, seed);
  const csv = buildCsv(tampered, { meta: META, hashes });
  const v = await verifyCsv(csv);
  assert.equal(v.ok, true, '作り直したのに検出できてしまった（前提の説明が違う）');
});

// メタ行と鎖の起点をそろえた CSV を作る
async function buildVerifiable() {
  // ⚠ seed は csvSeed で作る。実装（script.js の exportCSV）も同じ関数を通す。
  // ここで自前に組むと、実装がずれていても気づけない（実際にずれた）
  const seed = csvSeed(ROWS, { meta: META });
  const hashes = await chainOf(ROWS, seed);
  return buildCsv(ROWS, { meta: META, hashes });
}

test('⚠ seed を自分で組むと、受け取った側の再計算と合わない', () => {
  // 2026-09-28 に実際にこれで失敗した。
  // script.js が csvMetaLines(meta) で seed を作っていたが、
  // buildCsv は出力時に `# hash=...` と `# silence=...` を足すので、
  // CSV に出るメタ行と seed が食い違い、1行目から検証が落ちた。
  const byHand = csvMetaLines(META).join('\n');
  const proper = csvSeed(ROWS, { meta: META });
  assert.notEqual(byHand, proper, '食い違いが再現しない（前提が変わった）');
  assert.ok(proper.includes('# hash='), '出力側には hash の行が入る');
  assert.ok(!byHand.includes('# hash='), '手で組むと hash の行が抜ける');
});

test('csvSeed は、実際に出力されるメタ行と一致する', () => {
  const seed = csvSeed(ROWS, { meta: META });
  const csv = buildCsv(ROWS, { meta: META, hashes: ROWS.map(() => 'x') });
  const actual = csv.split('\n').filter(l => l.startsWith('#')).join('\n');
  assert.equal(seed, actual);
});
