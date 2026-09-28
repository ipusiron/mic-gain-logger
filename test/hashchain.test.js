// CSV のハッシュチェーン。
//
// ⚠⚠ これは「改ざんを防ぐ」ものではない。
// ログを作った本人はチェーンごと作り直せるので、提出者自身が疑われる場面
// （探偵が自分で採ったログを裁判資料に出す、など）では主張が立たない。
// 守れるのは「配布されたあとに、第三者が一部を消す／並べ替える」ことの検出だけである。
//
// 名乗りを下げたことを README に書くだけでなく、ここで機械にも示しておく。
// 最後のテストが「作り直せてしまう」ことを固定しているのは、そのためである。
//
// ⚠⚠ 2026-09-29 に起点を作り直した。
// それまでの起点は buildCsv の出力（＝メタ行そのもの）だった。メタ行には
// 記録が終わってから分かる事実（`# silence=` `# clockBreaks=` `# intervalSec=`）が
// 混ざるので、同じセッションを2回書き出すと同じ行のハッシュが変わっていた。
// 実測では「途中で10行を書き出したあと、無音の行が1行増えるだけで1行目の
// ハッシュまで変わった」。受け取った側には改変されたように見える。
// いまは
//   起点＝記録開始時に確定するヘッダーのメタ行だけ
//   あとから分かる事実＝末尾のトレーラー行（鎖の最後の輪）
// である。「2回書き出しても同じハッシュ」をこのファイルで縛る。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCsv, csvDataFields, csvSeed, csvHeaderLines, csvTrailerLines,
  hashInput, trailerHashInput, HASH_HEX_LEN, HASH_ALGO_LABEL, CSV_COLUMNS
} = require('../logic.js');

function rec(seq, db, ms) {
  return {
    ts: new Date(Date.UTC(2026, 8, 28, 5, 0, seq, 0) + (ms || 0)),
    rawDb: db, db, seq, peakDb: db + 3, clipCount: 0, validRatio: 1
  };
}

// script.js の sha256Hex と同じ手順。実装を写さず、ここで独立に組む。
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

const short = async (text) => (await sha256Hex(text)).slice(0, HASH_HEX_LEN);

// 記録中に1区間1回だけ計算する（script.js の extendHashChain と同じ進め方）
async function chainOf(rows, seed) {
  let prev = await short(seed);
  const out = [];
  for (const r of rows) {
    prev = await short(hashInput(prev, csvDataFields(r)));
    out.push(prev);
  }
  return out;
}

const HEADER = CSV_COLUMNS.join(',');

function partsOf(csv) {
  const lines = csv.split('\n').filter(l => l.length);
  const at = lines.indexOf(HEADER);
  if (at === -1) return { head: lines, data: [], trailer: [], at };
  const rest = lines.slice(at + 1);
  return {
    head: lines.slice(0, at),
    data: rest.filter(l => l.charAt(0) !== '#'),
    trailer: rest.filter(l => l.charAt(0) === '#'),
    at
  };
}

function rebuild(p) {
  return p.head.concat([HEADER], p.data, p.trailer).join('\n') + '\n';
}

// CSVを読み直して、チェーンが通っているかを確かめる（受け取った側の立場）。
// README が載せている Python の検証器と同じ手順である。
async function verifyCsv(csv) {
  const p = partsOf(csv);
  if (p.at === -1) return { ok: false, brokeAt: -1, where: 'header' };

  let prev = await short(p.head.join('\n'));
  for (let i = 0; i < p.data.length; i++) {
    const cells = p.data[i].split(',');
    const fields = cells.slice(0, CSV_COLUMNS.length - 1);
    const want = await short(hashInput(prev, fields));
    if (cells[CSV_COLUMNS.length - 1] !== want) return { ok: false, brokeAt: i, where: 'row' };
    prev = want;
  }
  // トレーラーが鎖の最後の輪。最後の行のハッシュを材料に混ぜてある
  const isHash = (l) => l.indexOf('# trailerHash=') === 0;
  const hashLine = p.trailer.filter(isHash);
  if (!hashLine.length) return { ok: false, brokeAt: p.data.length, where: 'trailer-missing' };
  const want = await short(trailerHashInput(prev, p.trailer.filter(l => !isHash(l))));
  if (hashLine[0] !== '# trailerHash=' + want) {
    return { ok: false, brokeAt: p.data.length, where: 'trailer' };
  }
  return { ok: true, brokeAt: -1, where: null };
}

const ROWS = [rec(1, -20), rec(2, -25), rec(3, -18), rec(4, -30)];
const META = { engine: 'worklet', sampleRate: 48000, device: 'Fake Mic', processing: 'off' };
const EXTRA = { intervalSec: '1' };
const SEEDED = Object.assign({}, META, { hashAlgo: HASH_ALGO_LABEL });

// メタ行と鎖の起点をそろえた CSV を作る（script.js の exportCSV と同じ組み立て）
async function buildVerifiable(rows, extra) {
  const logs = rows || ROWS;
  const ex = extra || EXTRA;
  // ⚠ 起点は csvSeed で作る。実装（script.js の beginHashChain）も同じ関数を通す
  const hashes = await chainOf(logs, csvSeed(SEEDED));
  const trailerHash = hashes.length
    ? await short(trailerHashInput(hashes[hashes.length - 1], csvTrailerLines(logs, ex)))
    : null;
  return buildCsv(logs, { meta: META, hashes, intervalSec: ex.intervalSec, trailerHash });
}

test('hashInput: 前のハッシュを材料に混ぜる（鎖になる）', () => {
  const f = ['2026-09-28T05:00:01.000Z', '-20.00', '1', '-17.00', '0', '1.000'];
  assert.equal(hashInput('abc', f), 'abc|' + f.join(','));
  // 前のハッシュが違えば材料も違う＝以降の値が連鎖して変わる
  assert.notEqual(hashInput('abc', f), hashInput('abd', f));
  // 最初の行は空で始まってよい
  assert.equal(hashInput(null, f), '|' + f.join(','));
});

test('trailerHashInput: 最後の行のハッシュを材料に混ぜる', () => {
  const lines = ['# rows=4', '# intervalSec=1'];
  assert.equal(trailerHashInput('abc', lines), 'abc|# rows=4\n# intervalSec=1');
  assert.notEqual(trailerHashInput('abc', lines), trailerHashInput('abd', lines));
  assert.notEqual(trailerHashInput('abc', lines), trailerHashInput('abc', ['# rows=5']));
});

test('ハッシュ列がCSVに入り、ヘッダーにアルゴリズムが出る', async () => {
  const csv = await buildVerifiable();
  const p = partsOf(csv);
  assert.ok(p.head.includes('# hash=' + HASH_ALGO_LABEL), p.head.join(' / '));
  assert.equal(p.data.length, ROWS.length);
  for (const line of p.data) {
    const cells = line.split(',');
    assert.equal(cells.length, CSV_COLUMNS.length);
    assert.equal(cells[cells.length - 1].length, HASH_HEX_LEN);
  }
});

test('CSV の形は ヘッダー→列→データ→トレーラー の順である', async () => {
  const csv = await buildVerifiable();
  const lines = csv.split('\n').filter(l => l.length);
  const at = lines.indexOf(HEADER);
  assert.ok(at > 0, '列のヘッダーが無い');
  // 起点は列のヘッダーより上だけ
  for (const l of lines.slice(0, at)) assert.equal(l.charAt(0), '#');
  const rest = lines.slice(at + 1);
  const firstTrailer = rest.findIndex(l => l.charAt(0) === '#');
  assert.ok(firstTrailer > 0, 'トレーラー行が無い');
  // トレーラーはデータ行より後ろにまとまっている（間に挟まらない）
  for (const l of rest.slice(firstTrailer)) assert.equal(l.charAt(0), '#');
  assert.equal(rest[rest.length - 1].indexOf('# trailerHash='), 0);
  // 末尾は改行で終わる
  assert.ok(csv.endsWith('\n'));
});

test('そのまま読み直せば、チェーンは通る', async () => {
  const v = await verifyCsv(await buildVerifiable());
  assert.equal(v.ok, true, `${v.where} / ${v.brokeAt} 行目で切れた`);
});

test('途中の行を消すと、そこから先が合わなくなる', async () => {
  const p = partsOf(await buildVerifiable());
  p.data = p.data.slice(0, 1).concat(p.data.slice(2));   // データ2行目を削る
  const v = await verifyCsv(rebuild(p));
  assert.equal(v.ok, false, '消したのに通ってしまった');
  assert.equal(v.brokeAt, 1, '切れた位置が違う');
});

test('行を入れ替えると合わなくなる', async () => {
  const p = partsOf(await buildVerifiable());
  p.data = [p.data[1], p.data[0]].concat(p.data.slice(2));
  const v = await verifyCsv(rebuild(p));
  assert.equal(v.ok, false, '並べ替えたのに通ってしまった');
});

test('値を1つ書き換えると合わなくなる', async () => {
  const csv = await buildVerifiable();
  const v = await verifyCsv(csv.replace(',-25.00,', ',-05.00,'));
  assert.equal(v.ok, false, '書き換えたのに通ってしまった');
});

test('ヘッダーのメタ行を書き換えると、1行目から合わなくなる', async () => {
  // 鎖の起点は記録の条件そのもの。条件を偽ると全部が崩れる
  const csv = await buildVerifiable();
  const v = await verifyCsv(csv.replace('# sampleRate=48000', '# sampleRate=44100'));
  assert.equal(v.ok, false);
  assert.equal(v.brokeAt, 0);
});

// ---- トレーラーが鎖の最後の輪である ----
//
// 起点をヘッダーへ移すと、あとから分かる事実（無音・中断・ログ間隔）は
// 鎖の外へ出る。そのままでは末尾を書き換えられても気づけないので、
// トレーラー自身を最後の輪にする。

test('トレーラーを書き換えると検出できる', async () => {
  const csv = await buildVerifiable();
  const v = await verifyCsv(csv.replace('# intervalSec=1', '# intervalSec=3'));
  assert.equal(v.ok, false, 'トレーラーを書き換えたのに通ってしまった');
  assert.equal(v.where, 'trailer');
});

test('末尾のデータ行を削ると検出できる', async () => {
  // ⚠ 起点だけの鎖では、最後の行を削っても残りはすべて通ってしまっていた。
  //    トレーラーを最後の輪にしたので、ここで止まる
  const p = partsOf(await buildVerifiable());
  p.data = p.data.slice(0, p.data.length - 1);
  const v = await verifyCsv(rebuild(p));
  assert.equal(v.ok, false, '末尾を削ったのに通ってしまった');
  assert.equal(v.where, 'trailer');
});

test('トレーラーを丸ごと落とすと検出できる', async () => {
  const p = partsOf(await buildVerifiable());
  p.trailer = [];
  const v = await verifyCsv(rebuild(p));
  assert.equal(v.ok, false, 'トレーラーが無いのに通ってしまった');
  assert.equal(v.where, 'trailer-missing');
});

test('トレーラーの行数は実際の行数と合う', async () => {
  const p = partsOf(await buildVerifiable());
  assert.ok(p.trailer.includes('# rows=' + p.data.length), p.trailer.join(' / '));
});

// ---- ⭐ 同じセッションを2回書き出しても同じハッシュになる ----
//
// 2026-09-29 に直した不具合そのもの。
// 起点がメタ行だったころは、無音の行が1行増える・中断が1回起きる・
// ログ間隔を変えるだけで、すでに書き出した行のハッシュまで変わっていた。

test('⭐ 同じ行は、2回書き出しても同じハッシュになる', async () => {
  const seed = csvSeed(SEEDED);
  // 1回目：4行で書き出す
  const first = await chainOf(ROWS, seed);
  // 2回目：同じ起点のまま、そのあとの行を足して書き出す
  const second = await chainOf(ROWS.concat([rec(5, -22), rec(6, -21)]), seed);
  assert.deepEqual(second.slice(0, first.length), first, '先に書き出した行のハッシュが変わった');
});

test('⭐ 無音の行が1行増えても、それより前の行のハッシュは変わらない', async () => {
  // ⚠ これが起点をメタ行にしていたときの実際の失敗である。
  //    `# silence=-Infinity` が足されて起点が変わり、1行目から崩れた。
  const before = await buildVerifiable(ROWS, EXTRA);
  const after = await buildVerifiable(ROWS.concat([rec(5, -Infinity)]), EXTRA);
  const hashesOf = (csv) => partsOf(csv).data.map(l => l.split(',')[CSV_COLUMNS.length - 1]);

  const a = hashesOf(before);
  const b = hashesOf(after);
  assert.equal(a.length, ROWS.length);
  assert.equal(b.length, ROWS.length + 1);
  assert.deepEqual(b.slice(0, a.length), a, '無音の行が増えただけで前の行のハッシュが変わった');
  // 無音の印はトレーラーへ出る（起点には出ない）
  assert.ok(!before.includes('# silence='), '無音が無いのに印が出ている');
  assert.ok(partsOf(after).trailer.includes('# silence=-Infinity'), '無音の印がトレーラーに無い');
  assert.equal(csvSeed(SEEDED).indexOf('silence'), -1, '起点に無音の印が混ざっている');
  // どちらもそのまま検証を通る
  assert.equal((await verifyCsv(before)).ok, true);
  assert.equal((await verifyCsv(after)).ok, true);
});

test('⭐ ログ間隔を途中で変えても、前の行のハッシュは変わらない', async () => {
  const before = await buildVerifiable(ROWS, { intervalSec: '1' });
  const after = await buildVerifiable(ROWS, { intervalSec: '1+3' });
  assert.deepEqual(partsOf(after).data, partsOf(before).data, 'ログ間隔を変えたら行が変わった');
  assert.ok(partsOf(after).trailer.includes('# intervalSec=1+3'));
  assert.equal(partsOf(after).head.join('\n').indexOf('intervalSec'), -1,
    '起点にログ間隔が混ざっている');
});

test('⭐ 起点は CSV を組み立てずに取れる', () => {
  // ⚠ 改修前の csvSeed は、起点を取り出すためだけに buildCsv を丸ごと呼んで
  //    全行を組み立てていた。起点はヘッダーだけで決まるので、ログは要らない
  assert.equal(csvSeed(META), csvHeaderLines(META).join('\n'));
  assert.equal(csvSeed.length, 1, 'csvSeed がログを受け取っている');
});

test('⭐ 起点に「あとから分かる事実」が入らない', () => {
  const full = {
    engine: 'worklet', started: '2026-09-28T05:00:01.000Z', sampleRate: 48000,
    device: 'Fake Mic', processing: 'off', hashAlgo: HASH_ALGO_LABEL,
    // 起点に混ぜてはいけない値を、わざと渡す
    intervalSec: '1+3', silence: '-Infinity', clockBreaks: 2, rows: 4
  };
  const seed = csvSeed(full);
  for (const key of ['intervalSec', 'silence', 'clockBreaks', 'rows', 'sessions', 'engines']) {
    assert.equal(seed.indexOf(key), -1, `起点に ${key} が入っている`);
  }
  assert.deepEqual(seed.split('\n'), [
    '# format=mic-gain-logger/2',
    '# engine=worklet',
    '# started=2026-09-28T05:00:01.000Z',
    '# sampleRate=48000',
    '# device=Fake Mic',
    '# processing=off',
    '# weighting=Z',
    '# hash=' + HASH_ALGO_LABEL
  ]);
});

test('CSV のトレーラーは csvTrailerLines の出力そのもの（ハッシュの行を除く）', async () => {
  // 実装とテストで組み立てが分かれると、トレーラーのハッシュが合わなくなる
  const p = partsOf(await buildVerifiable());
  assert.deepEqual(
    p.trailer.filter(l => l.indexOf('# trailerHash=') !== 0),
    csvTrailerLines(ROWS, EXTRA)
  );
});

test('⚠ 作った本人は、チェーンごと作り直せてしまう', async () => {
  // これがこの仕組みの限界である。「改ざんを防ぐ」とは名乗れない。
  // 値を書き換えたうえで、ハッシュを計算し直せば、検証は通ってしまう。
  const tampered = ROWS.map((r, i) => (i === 1 ? Object.assign({}, r, { rawDb: -5, db: -5 }) : r));
  const csv = await buildVerifiable(tampered, EXTRA);
  const v = await verifyCsv(csv);
  assert.equal(v.ok, true, '作り直したのに検出できてしまった（前提の説明が違う）');
  assert.ok(csv.includes(',-5.00,'), '書き換えた値が入っていない');
});
