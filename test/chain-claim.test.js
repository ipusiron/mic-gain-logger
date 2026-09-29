'use strict';

// ハッシュチェーンの名乗りを、README・画面・コード・CLAUDE.md の4か所で縛る。
//
// ⚠⚠ ここまでの README は「配布されたあとに第三者が行を消す・並べ替える・
// 書き換えると検出できる」と書き、限界を「ログを作った本人はチェーンごと
// 作り直せる」と主体で限定していた。これは誤りである。鍵も外部アンカーも
// 無く、鎖の作り方を README で公開しているので、誰でも再計算で張り直せる。
// 分かれ目は「本人か第三者か」ではなく「ハッシュを再計算するかどうか」である。
//
// ⭐ 表の値は実際に動かして確かめてから書く。ここでは README から見本CSVと
// 2つの表を切り出し、検証器の手順と鎖の張り直しをこのファイルで独立に組んで、
// 表のセルと突き合わせる。
// （初期の版は「2行目と3行目を入れ替える」を `1行目から合いません` と
//   書いていたが、実測は `2行目から` だった。手で書くとこうなる）

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.join(__dirname, '..');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const logicSrc = fs.readFileSync(path.join(root, 'logic.js'), 'utf8');
const scriptSrc = fs.readFileSync(path.join(root, 'script.js'), 'utf8');
const claudeMd = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');

// ---- 名乗り（README）----

test('README が「第三者の改変を検出できる」と書いていない', () => {
  const banned = [
    '第三者が行を消す',
    '第三者による改変',
    '第三者による部分削除',
    '改ざん検知',
    '改変の検出',
    '手を離れたあとの第三者'
  ];
  for (const s of banned) {
    assert.ok(!readme.includes(s), `主体で限定した古い名乗りが残っている: ${s}`);
  }
});

test('README の限界の説明が、主体ではなく再計算で書かれている', () => {
  assert.ok(
    !readme.includes('ログを作った本人はチェーンごと作り直せる'),
    '限界を「作った本人」に限った説明が残っている'
  );
  assert.ok(
    readme.includes('意図的な改変には、相手が誰であっても耐えません'),
    '「相手が誰であっても耐えない」と書いていない'
  );
  assert.ok(
    readme.includes('分かれ目は「本人か第三者か」ではなく'),
    '分かれ目が主体でないことを書いていない'
  );
  assert.ok(
    readme.includes('ハッシュを再計算するかどうか'),
    '分かれ目が再計算であることを書いていない'
  );
});

test('README が、名乗りの代わりに何の役に立つのかを書いている', () => {
  // 下げるだけで終わらせない。この範囲でなら役に立つ、と書く
  assert.ok(
    readme.includes('うっかりの破損・部分的な欠落・順序の入れ替わり'),
    '分かる範囲が書かれていない'
  );
  assert.ok(readme.includes('消したことに気づいていない相手'), '役に立つ場面が書かれていない');
  assert.ok(
    readme.includes('記録が正しいことの証明にはなりません'),
    '証明に使えないことを書いていない'
  );
});

test('README が、限界を変えられない理由を書いている', () => {
  assert.ok(readme.includes('秘密鍵で署名する'), '署名という手が書かれていない');
  assert.ok(readme.includes('外部のタイムスタンプ機関'), 'タイムスタンプ機関が書かれていない');
  assert.ok(readme.includes('どちらも本ツールでは採りません'), '採らないと書いていない');
  // ⚠ 外部へ預けるのは、端末内で完結するという作りを壊す
  assert.ok(readme.includes("connect-src 'none'"), '採らない理由が書かれていない');
});

// ---- README を直したのに、コードのコメントと画面が残る事故を止める ----
//
// 点検で「README は下げたのに logic.js のコメントに『証拠保全を掲げる
// ツールとして』『探偵が自分で採ったログを裁判資料に出す』が残っている」と
// 指摘された。散文と同じで、名乗りも誰も直さないので腐る。

test('コードのコメントが「証拠保全」「裁判資料」を名乗っていない', () => {
  for (const [name, src] of [['logic.js', logicSrc], ['script.js', scriptSrc]]) {
    for (const s of ['証拠保全', '裁判資料', '探偵', '証拠・監査']) {
      assert.ok(!src.includes(s), `${name} のコメントに ${s} が残っている`);
    }
  }
});

test('logic.js のコメントが、名乗りを README と同じところまで下げている', () => {
  assert.ok(!logicSrc.includes('第三者が一部を消す'), 'logic.js が主体で限定したまま');
  assert.ok(
    logicSrc.includes('「ハッシュを再計算するかどうか」である'),
    'logic.js が分かれ目を再計算で書いていない'
  );
  assert.ok(
    logicSrc.includes('意図的な改変には相手が誰であっても耐えない'),
    'logic.js が限界を書いていない'
  );
});

test('script.js のコメントが、鎖の限界を主体で限定していない', () => {
  assert.ok(
    !scriptSrc.includes('防げるのは第三者による後からの改変だけ'),
    'script.js が主体で限定したまま'
  );
  assert.ok(
    scriptSrc.includes('相手が誰であっても耐えない'),
    'script.js が限界を書いていない'
  );
});

test('画面のヘルプがハッシュチェーンの限界を書いている', () => {
  // README だけ直しても、利用者がその場で読むのは画面のほうである
  const i = html.indexOf('<strong>ハッシュチェーン：</strong>');
  assert.notEqual(i, -1, 'ヘルプに「ハッシュチェーン」の項目が無い');
  const item = html.slice(i, html.indexOf('</li>', i));
  assert.match(item, /うっかりの破損/, 'ヘルプが分かる範囲を書いていない');
  assert.match(item, /相手が誰であっても耐えません/, 'ヘルプが限界を書いていない');
  assert.match(item, /証明には使えません/, 'ヘルプが証明に使えないことを書いていない');
});

test('CLAUDE.md の名乗りのルールが、主体で限定していない', () => {
  assert.ok(
    !claudeMd.includes('配布後の第三者による部分削除'),
    'CLAUDE.md に主体で限定した古いルールが残っている'
  );
  assert.ok(claudeMd.includes('主体で限定してはいけない'), 'CLAUDE.md が主体での限定を禁じていない');
  assert.ok(claudeMd.includes('誰でも再計算で鎖を張り直せる'), 'CLAUDE.md が理由を書いていない');
});

// ---- file:// の実態 ----
//
// ⚠ 「file:// では crypto.subtle が使えない」は Chromium では成り立たない。
// 実測では isSecureContext が true で SHA-256 も通り、file:// のまま書き出した
// CSV の hash 列は埋まって検証器も通った。落ちるのは AudioWorklet のほうである。

test('README が「file:// ではハッシュが計算できない」と書いていない', () => {
  const banned = [
    '`file://`で開いた場合は空欄',
    '`file://`で開いた場合は行そのものが出ない',
    '`file://`で直接開いた場合、`hash`列は空になり',
    '`file://`で開くとマイクが使えず、ハッシュ列も空になる',
    '`hash`列が空のCSVは`file://`で書き出したもので'
  ];
  for (const s of banned) {
    assert.ok(!readme.includes(s), `file:// についての誤りが残っている: ${s}`);
  }
  assert.ok(
    readme.includes('`file://`はこれに当てはまりません'),
    'file:// が例外であることを書いていない'
  );
  assert.ok(readme.includes('isSecureContext'), '実測した中身が書かれていない');
  assert.ok(
    readme.includes("Unable to load a worklet's module."),
    'file:// で実際に落ちるもの（AudioWorklet）が書かれていない'
  );
});

test('script.js のコメントが file:// を原因にしていない', () => {
  assert.ok(
    !scriptSrc.includes('file:// で開いたときはハッシュを計算できない'),
    'script.js に file:// の誤りが残っている'
  );
  assert.ok(
    scriptSrc.includes('file:// は安全なコンテキストである'),
    'script.js が実態を書いていない'
  );
});

test('CLAUDE.md が file:// を crypto.subtle の原因にしていない', () => {
  // ⚠ 開発コマンドの行と Key Implementation Notes の行の2か所にあった。
  //    片方だけ直すと、次に読む者がもう片方を信じる
  const banned = [
    'file:// では AudioWorklet も crypto.subtle も使えない',
    '`file://`ではハッシュ列が空になる'
  ];
  for (const s of banned) {
    assert.ok(!claudeMd.includes(s), `CLAUDE.md に file:// の誤りが残っている: ${s}`);
  }
  assert.ok(
    claudeMd.includes('`file://`は安全なコンテキストである'),
    'CLAUDE.md が file:// の実態を書いていない'
  );
});

test('テストのコメントが file:// を「鎖を作れない環境」にしていない', () => {
  const chainRunner = fs.readFileSync(path.join(root, 'test', 'chain-runner.test.js'), 'utf8');
  assert.ok(
    !chainRunner.includes('鎖を作れない環境（file:// など）'),
    'chain-runner.test.js に file:// の誤りが残っている'
  );
});

// ---- ⭐ 表の値を、実際に動かして確かめる ----
//
// ⚠ 第2弾b2で CSV を v3（10列）にした。README の見本も v3 にし、表は実際に書き出した見本と
//    README の検証器で採り直した。ここの模型も、README の検証器と同じく hash 列の位置を
//    列のヘッダー行から読む（v2 の7列目を決め打ちしない）。v2 の CSV も同じ手順で確かめられることは
//    test/csv-v3.test.js で見ている
// ⚠ 列のヘッダー行はハッシュの材料に入らない（起点は `#` の行だけ）。列名を入れ替えても鎖は通るので、
//    README の検証器は、列のヘッダー行が起点の `# format=` の版の列と同じかを先に確かめる（第2弾b2 の点検で追加）。
//    模型も同じ確かめをする。版ごとの列は、v3 が実装の CSV_COLUMNS、v2 が第2弾a までの見本（fixtures/sample_v2.csv）

const { CSV_COLUMNS } = require('../logic.js');
const COLUMNS = CSV_COLUMNS.join(',');
const V2_COLUMNS = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample_v2.csv'), 'utf8')
  .split('\n').find(l => l.startsWith('timestamp,'));
const KNOWN = {
  '# format=mic-gain-logger/3': COLUMNS,
  '# format=mic-gain-logger/2': V2_COLUMNS
};
const h = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);

function fencedBlocks() {
  const out = [];
  const re = /```[a-z]*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(readme)) !== null) out.push(m[1]);
  return out;
}

// README の見本CSVを、ヘッダー・データ行・トレーラーに切り分ける
function samplePartsFromReadme() {
  const block = fencedBlocks().find(b => b.startsWith('# format=mic-gain-logger/3'));
  assert.ok(block, 'README に見本CSV（v3）が無い');
  const lines = block.split('\n').filter(l => l.length);
  const at = lines.findIndex(l => l.startsWith('timestamp,'));
  assert.notEqual(at, -1, '見本CSVに列のヘッダー行が無い');
  // 見本の列は実装の列と同じ（README の見本が古い版のまま残らないように）
  assert.equal(lines[at], COLUMNS, '見本CSVの列が実装と違う');
  const rest = lines.slice(at + 1);
  return {
    head: lines.slice(0, at),
    cols: lines[at],
    data: rest.filter(l => l[0] !== '#'),
    trailer: rest.filter(l => l[0] === '#'),
    // hash 列の位置は列のヘッダー行から読む（v3 は10列目）
    hx: lines[at].split(',').indexOf('hash')
  };
}

const SAMPLE = samplePartsFromReadme();
const clone = p => ({ head: [...p.head], cols: p.cols, data: [...p.data], trailer: [...p.trailer], hx: p.hx });
const swapNames = (cols, a, b) => {
  const c = cols.split(',');
  const i = c.indexOf(a);
  const j = c.indexOf(b);
  assert.ok(i !== -1 && j !== -1, `列名が無い: ${a} / ${b}`);
  [c[i], c[j]] = [c[j], c[i]];
  return c.join(',');
};
const setCell = (line, i, v) => {
  const c = line.split(',');
  c[i] = v;
  return c.join(',');
};

// README が載せている Python の検証器と同じ手順。実装を写さず、ここで独立に組む
function verify(p) {
  // ⚠ 列のヘッダー行はハッシュの材料に入らないので、起点の # format= の版の列と同じかを先に見る。
  //    知らない版では確かめない
  const fmt = p.head.find(l => Object.prototype.hasOwnProperty.call(KNOWN, l));
  if (fmt && p.cols !== KNOWN[fmt]) return '列のヘッダー行が # format= の版の列と合いません';
  const hashCell = l => {
    const c = l.split(',');
    return c.length > p.hx ? c[p.hx] : '';
  };
  // ⚠ 鎖のないCSVを、改変と混同しないよう先に分ける
  if (!p.data.some(l => hashCell(l))) {
    return 'hash列が全行で空です。鎖のないCSVなので、この検証器では確かめられません';
  }
  let prev = h(p.head.join('\n'));
  for (let i = 0; i < p.data.length; i++) {
    // 材料は hash 列より左のフィールド
    const want = h(prev + '|' + p.data[i].split(',').slice(0, p.hx).join(','));
    if (hashCell(p.data[i]) !== want) return `${i + 1}行目から合いません（期待 ${want}／実際 ${hashCell(p.data[i])}）`;
    prev = want;
  }
  const MARK = '# trailerHash=';
  const found = p.trailer.filter(l => l.startsWith(MARK));
  if (!found.length) return 'トレーラーのハッシュがありません（末尾が落とされています）';
  const want = h(prev + '|' + p.trailer.filter(l => !l.startsWith(MARK)).join('\n'));
  if (found[0] !== MARK + want) {
    return `トレーラーが合いません（期待 ${want}／実際 ${found[0].slice(MARK.length)}）`;
  }
  if (!p.trailer.includes(`# rows=${p.data.length}`)) {
    return `行数がトレーラーと合いません（データ行は ${p.data.length} 行）`;
  }
  return `${p.data.length}行すべて通りました（トレーラーも一致）`;
}

// ⚠⚠ README の算法だけで鎖を張り直す。これができてしまうことが、この仕組みの限界である
function rechain(p) {
  let prev = h(p.head.join('\n'));
  const data = p.data.map(l => {
    const cells = l.split(',');
    cells[p.hx] = h(prev + '|' + cells.slice(0, p.hx).join(','));
    prev = cells[p.hx];
    return cells.join(',');
  });
  const MARK = '# trailerHash=';
  const trailer = p.trailer
    .filter(l => !l.startsWith(MARK))
    .map(l => (l.startsWith('# rows=') ? `# rows=${data.length}` : l));
  trailer.push(MARK + h(prev + '|' + trailer.join('\n')));
  return { head: p.head, cols: p.cols, data, trailer, hx: p.hx };
}

// 表の見出しの文言 → 同じ改変を機械で再現する手続き。
// ⚠ 表に行を足したら、ここにも足す（足さないとテストが落ちる）
const MUTATIONS = {
  'そのまま': p => p,
  '2行目を消す': p => ({ ...p, data: p.data.filter((_, i) => i !== 1) }),
  '2行目と3行目を入れ替える': p => ({
    ...p,
    data: [p.data[0], p.data[2], p.data[1], ...p.data.slice(3)]
  }),
  '2行目のdbfsを書き換える': p => ({
    ...p,
    data: p.data.map((l, i) => (i === 1 ? setCell(l, 1, '-30.00') : l))
  }),
  '1行目のdbfsを-19.70から-12.00へ書き換える': p => {
    // 表の見出しの値が見本と食い違ったら、ここで落とす（見本を差し替えたら見出しも直す）
    assert.equal(p.data[0].split(',')[1], '-19.70', '見本の1行目の dbfs が表の見出しと違う');
    return { ...p, data: p.data.map((l, i) => (i === 0 ? setCell(l, 1, '-12.00') : l)) };
  },
  '無音の行を消す': p => ({ ...p, data: p.data.filter(l => !l.includes('-Infinity')) }),
  '末尾2行を切り落とす': p => ({ ...p, data: p.data.slice(0, 2) }),
  '最後の行を消す': p => ({ ...p, data: p.data.slice(0, -1) }),
  'データ行の時刻を1時間ずらす': p => ({
    ...p,
    data: p.data.map(l => setCell(l, 0, new Date(Date.parse(l.split(',')[0]) + 3600 * 1000).toISOString()))
  }),
  'ヘッダーの# sampleRate=を偽る': p => ({
    ...p,
    head: p.head.map(l => (l.startsWith('# sampleRate=') ? l.replace('48000', '44100') : l))
  }),
  'ヘッダーの# device=を削る': p => ({
    ...p,
    head: p.head.filter(l => !l.startsWith('# device='))
  }),
  'ヘッダーの# device=を差し替える': p => ({
    ...p,
    head: p.head.map(l => (l.startsWith('# device=') ? '# device=X' : l))
  }),
  // 列のヘッダー行はハッシュの材料に入らない。検証器が # format= の版の列と比べるので落ちる
  '列のヘッダー行のband_ultra_dbfsとband_audible_dbfsを入れ替える': p => ({
    ...p,
    cols: swapNames(p.cols, 'band_ultra_dbfs', 'band_audible_dbfs')
  }),
  'トレーラーの# intervalSec=を偽る': p => ({
    ...p,
    trailer: p.trailer.map(l => l.replace('# intervalSec=1', '# intervalSec=3'))
  }),
  'トレーラーの# silence=を消す': p => ({
    ...p,
    trailer: p.trailer.filter(l => !l.startsWith('# silence='))
  }),
  'トレーラーを丸ごと落とす': p => ({ ...p, trailer: [] }),
  // ⚠ 「鎖のないCSV」は、ヘッダーからも `# hash=` / `# trailerHash=` が消えたものである。
  // データ行の hash 列を空にしただけでは、それは「鎖つきCSVから列を削ったもの」であって
  // 別物になる。検証器の出力は同じでも、ヘッダーを見れば見分けられる（README に書いた）。
  // 両方を別々に置いて、取り違えないようにする。
  'hash列が全行で空（鎖のないCSV）': p => ({
    ...p,
    head: p.head.filter(l => !l.startsWith('# hash=')),
    data: p.data.map(l => setCell(l, p.hx, '')),
    trailer: p.trailer.filter(l => !l.startsWith('# trailerHash='))
  }),
  '鎖つきCSVから hash 列だけを消す': p => ({
    ...p,
    data: p.data.map(l => setCell(l, p.hx, ''))
  })
};

const norm = s => s.replace(/\*\*/g, '').replace(/`/g, '').trim();

function tableRows(headerLine) {
  const i = readme.indexOf(headerLine);
  assert.notEqual(i, -1, `表が見つからない: ${headerLine}`);
  const rows = [];
  for (const l of readme.slice(i).split('\n').slice(2)) {
    if (l[0] !== '|') break;
    rows.push(l.split('|').slice(1, -1).map(norm));
  }
  assert.ok(rows.length, `表の中身が無い: ${headerLine}`);
  return rows;
}

// 表のセルは `…` で省略してある。省略されていない部分が順に現れることを見る
function matchesCell(actual, cell) {
  let at = 0;
  for (const chunk of cell.split('…')) {
    if (!chunk) continue;
    const found = actual.indexOf(chunk, at);
    if (found === -1) return false;
    at = found + chunk.length;
  }
  return true;
}

function mutationFor(label) {
  const f = MUTATIONS[label];
  assert.ok(f, `この改変を機械が再現できない（MUTATIONS に足すこと）: ${label}`);
  return f;
}

test('見本CSVは、そのままなら鎖が通る', () => {
  assert.equal(verify(clone(SAMPLE)), '4行すべて通りました（トレーラーも一致）');
});

test('⭐ 検証器の出力一覧表が、実際に動かした結果と一致する', () => {
  const rows = tableRows('| 渡したもの | 出力 |');
  assert.equal(rows.length, 13, '表の行数が変わっている（増やしたなら実測し直すこと）');
  for (const [label, expected] of rows) {
    const actual = verify(mutationFor(label)(clone(SAMPLE)));
    assert.ok(
      matchesCell(actual, expected),
      `表の値が実測と違う: ${label}\n  表   : ${expected}\n  実測 : ${actual}`
    );
  }
});

test('⭐ 鎖を張り直すと全部通ってしまう（「分からないこと」の表が実測と一致する）', () => {
  const rows = tableRows('| 改変の内容 | 改変しただけ | 鎖を張り直したあと |');
  assert.equal(rows.length, 7, '表の行数が変わっている（増やしたなら実測し直すこと）');
  for (const [label, before, after] of rows) {
    const tampered = mutationFor(label)(clone(SAMPLE));

    const got = verify(tampered);
    assert.ok(
      matchesCell(got, before),
      `改変しただけの列が実測と違う: ${label}\n  表   : ${before}\n  実測 : ${got}`
    );

    const restitched = verify(rechain(tampered));
    assert.ok(
      matchesCell(restitched, after),
      `張り直したあとの列が実測と違う: ${label}\n  表   : ${after}\n  実測 : ${restitched}`
    );
    // ⚠ ここが通ってしまうのが名乗りの根拠である。通らなくなったら名乗りを見直すこと
    assert.match(restitched, /通りました/, `鎖を張り直しても通らない: ${label}`);
  }
});

test('列のヘッダー行はハッシュの材料に入らない。版の列と比べないと、列名を入れ替えても鎖は通る', () => {
  const swapped = MUTATIONS['列のヘッダー行のband_ultra_dbfsとband_audible_dbfsを入れ替える'](clone(SAMPLE));
  assert.equal(verify(swapped), '列のヘッダー行が # format= の版の列と合いません');
  // 鎖そのものは列名に左右されない。入れ替えたまま README の算法で張り直しても、行のハッシュも
  // トレーラーのハッシュも元と同じになる（版の列と比べる手順が無ければ通ってしまう）
  const restitched = rechain(swapped);
  assert.deepEqual(restitched.data, SAMPLE.data);
  assert.deepEqual(restitched.trailer, SAMPLE.trailer);
  assert.ok(
    readme.includes('列のヘッダー行だけは、ハッシュの材料に入っていません'),
    'README が、列のヘッダー行が材料に入らないことを書いていない'
  );
});

test('鎖のないCSVを、改変と区別している', () => {
  const chainless = MUTATIONS['hash列が全行で空（鎖のないCSV）'](clone(SAMPLE));
  const got = verify(chainless);
  assert.ok(!/行目から合いません/.test(got), `鎖のないCSVを改変として報告している: ${got}`);
  assert.match(got, /鎖のないCSV/, `鎖が無いことを言っていない: ${got}`);
  assert.ok(readme.includes('鎖のないCSVは、改変とは別のものです'), 'README が区別を説明していない');
});

test('README の検証器が、鎖の有無を行ごとの照合より先に見ている', () => {
  const py = fencedBlocks().find(b => b.includes('verify_mic_gain_log.py'));
  assert.ok(py, 'README に検証器が無い');
  const guard = py.indexOf('hash列が全行で空です');
  const loop = py.indexOf('for i, line in enumerate(data, 1)');
  assert.notEqual(guard, -1, '鎖のないCSVの判別が無い');
  assert.notEqual(loop, -1, '行ごとの照合が無い');
  assert.ok(guard < loop, '鎖の判別が、行ごとの照合より後ろにある');
  // 公開している検証器と、この模型のメッセージがずれないようにする
  assert.ok(
    py.includes('hash列が全行で空です。鎖のないCSVなので、この検証器では確かめられません'),
    '検証器のメッセージが、この模型と食い違っている'
  );
});

test('表の値を手で書かないという約束が README に残っている', () => {
  assert.ok(
    readme.includes('この表の値は、実際に検証器を動かして採ったものです'),
    '表を実測で採る約束が書かれていない'
  );
});
