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

const COLUMNS = 'timestamp,dbfs,seq,peak_dbfs,clip,valid_ratio,hash';
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
  const block = fencedBlocks().find(b => b.startsWith('# format=mic-gain-logger/2'));
  assert.ok(block, 'README に見本CSVが無い');
  const lines = block.split('\n').filter(l => l.length);
  const at = lines.indexOf(COLUMNS);
  assert.notEqual(at, -1, '見本CSVに列のヘッダー行が無い');
  const rest = lines.slice(at + 1);
  return {
    head: lines.slice(0, at),
    data: rest.filter(l => l[0] !== '#'),
    trailer: rest.filter(l => l[0] === '#')
  };
}

const SAMPLE = samplePartsFromReadme();
const clone = p => ({ head: [...p.head], data: [...p.data], trailer: [...p.trailer] });
const setCell = (line, i, v) => {
  const c = line.split(',');
  c[i] = v;
  return c.join(',');
};

// README が載せている Python の検証器と同じ手順。実装を写さず、ここで独立に組む
function verify(p) {
  const hashCell = l => {
    const c = l.split(',');
    return c.length > 6 ? c[6] : '';
  };
  // ⚠ 鎖のないCSVを、改変と混同しないよう先に分ける
  if (!p.data.some(l => hashCell(l))) {
    return 'hash列が全行で空です。鎖のないCSVなので、この検証器では確かめられません';
  }
  let prev = h(p.head.join('\n'));
  for (let i = 0; i < p.data.length; i++) {
    const cells = p.data[i].split(',');
    const want = h(prev + '|' + cells.slice(0, 6).join(','));
    if (cells[6] !== want) return `${i + 1}行目から合いません（期待 ${want}／実際 ${cells[6]}）`;
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
    cells[6] = h(prev + '|' + cells.slice(0, 6).join(','));
    prev = cells[6];
    return cells.join(',');
  });
  const MARK = '# trailerHash=';
  const trailer = p.trailer
    .filter(l => !l.startsWith(MARK))
    .map(l => (l.startsWith('# rows=') ? `# rows=${data.length}` : l));
  trailer.push(MARK + h(prev + '|' + trailer.join('\n')));
  return { head: p.head, data, trailer };
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
  'dbfsを-42.13から-12.00へ書き換える': p => ({
    ...p,
    data: p.data.map(l => l.replace('-42.13', '-12.00'))
  }),
  '無音の行を消す': p => ({ ...p, data: p.data.filter(l => !l.includes('-Infinity')) }),
  '末尾2行を切り落とす': p => ({ ...p, data: p.data.slice(0, 2) }),
  '最後の行を消す': p => ({ ...p, data: p.data.slice(0, -1) }),
  'データ行の時刻を1時間ずらす': p => ({
    ...p,
    data: p.data.map(l => l.replace('T09:', 'T10:'))
  }),
  'ヘッダーの# sampleRate=を偽る': p => ({
    ...p,
    head: p.head.map(l => l.replace('48000', '44100'))
  }),
  'ヘッダーの# device=を削る': p => ({
    ...p,
    head: p.head.filter(l => !l.startsWith('# device='))
  }),
  'ヘッダーの# device=を差し替える': p => ({
    ...p,
    head: p.head.map(l => (l.startsWith('# device=') ? '# device=X' : l))
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
  'hash列が全行で空（鎖のないCSV）': p => ({
    ...p,
    data: p.data.map(l => setCell(l, 6, ''))
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
  assert.equal(rows.length, 12, '表の行数が変わっている（増やしたなら実測し直すこと）');
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
