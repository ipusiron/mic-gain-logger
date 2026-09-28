// README が実装と実ファイルからずれたら落とす。
//
// この弾で廃止した TECHNICAL.md は、実在しない関数の擬似コードを載せたまま
// 1年以上公開されていた。散文で書いた説明は、誰も直さないので必ず腐る。
// 機械で照合できる約束だけでも機械に見張らせる。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'script.js'), 'utf8');
const logic = require('../logic.js');

// ---- ディレクトリー構成図の読み取り ----
//
// 1段は「│   」または「    」の4文字。名前のうしろの「# 説明」は必須である
// （このシリーズの決まり。全ファイル・全ディレクトリーに1行の説明を付ける）。
const ENTRY = /^([\s│]*)([├└])── (\S+)(?:\s+# ?(.*?))?\s*$/;

function readTreeBlock() {
  const head = readme.indexOf('## \u{1f4c2} ディレクトリー構成');
  assert.notEqual(head, -1, 'ディレクトリー構成の見出しが無い');
  const open = readme.indexOf('```', head);
  const close = readme.indexOf('```', open + 3);
  assert.ok(open !== -1 && close !== -1, 'ディレクトリー構成のコードブロックが無い');
  return readme.slice(open + 3, close).split('\n');
}

function parseTree() {
  const lines = readTreeBlock().filter(l => l.trim().length);
  assert.match(lines[0], /^mic-gain-logger\/$/, '構成図の1行目がリポジトリー名ではない');

  const entries = [];
  const stack = [];
  for (const line of lines.slice(1)) {
    const m = line.match(ENTRY);
    assert.ok(m, `構成図として読めない行がある: ${JSON.stringify(line)}`);
    const depth = m[1].length / 4;
    assert.ok(Number.isInteger(depth), `字下げが4の倍数でない: ${JSON.stringify(line)}`);
    const name = m[3];
    const comment = (m[4] || '').trim();
    stack.length = depth;
    const rel = [...stack, name.replace(/\/$/, '')].join('/');
    if (name.endsWith('/')) stack[depth] = name.slice(0, -1);
    entries.push({ rel, name, comment, isDir: name.endsWith('/'), line });
  }
  return entries;
}

// 実ファイル側。.git と node_modules、git 管理外の .claude は数えない
const SKIP = new Set(['.git', 'node_modules', '.claude']);

function walk(dir, base, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIP.has(ent.name)) continue;
    const rel = base ? `${base}/${ent.name}` : ent.name;
    out.push({ rel, isDir: ent.isDirectory() });
    if (ent.isDirectory()) walk(path.join(dir, ent.name), rel, out);
  }
  return out;
}

test('構成図に載っているものが実在する', () => {
  for (const e of parseTree()) {
    const abs = path.join(root, e.rel);
    assert.ok(fs.existsSync(abs), `構成図に載っているが実在しない: ${e.rel}`);
    assert.equal(
      fs.statSync(abs).isDirectory(),
      e.isDir,
      `ディレクトリーかどうかが構成図と食い違う: ${e.rel}`
    );
  }
});

test('実在するものが構成図に載っている', () => {
  const listed = new Set(parseTree().map(e => e.rel));
  for (const f of walk(root, '', [])) {
    assert.ok(listed.has(f.rel), `構成図に載っていない: ${f.rel}`);
  }
});

test('構成図の全項目に1行の説明が付いている', () => {
  for (const e of parseTree()) {
    assert.ok(e.comment.length > 0, `説明が無い: ${e.rel}`);
  }
});

// ---- README の記述と実装の照合 ----

test('廃止した TECHNICAL.md を README が参照していない', () => {
  assert.ok(!readme.includes('TECHNICAL.md'), 'README が TECHNICAL.md を参照している');
  assert.ok(!fs.existsSync(path.join(root, 'TECHNICAL.md')), 'TECHNICAL.md が残っている');
});

test('README の CSV の列が実装と一致する', () => {
  // ⚠ A列=timestamp・B列=dbfs は Excel の手順が前提にしている。順序ごと照合する
  const cols = logic.CSV_COLUMNS || null;
  assert.ok(Array.isArray(cols) && cols.length, 'logic.js が CSV_COLUMNS を公開していない');
  assert.equal(cols[0], 'timestamp');
  assert.equal(cols[1], 'dbfs');
  assert.ok(readme.includes(cols.join(',')), `README に列の並び ${cols.join(',')} が無い`);
  for (const c of cols) {
    assert.ok(readme.includes('`' + c + '`'), `README が列 ${c} を説明していない`);
  }
});

test('README が言う CSP を index.html が宣言している', () => {
  const m = html.match(/http-equiv="Content-Security-Policy"[\s\S]{0,200}?content="([^"]+)"/);
  assert.ok(m, 'index.html に CSP の meta が無い');
  assert.match(m[1], /connect-src 'none'/, 'CSP に connect-src \'none\' が無い');
  assert.ok(readme.includes("`connect-src 'none'`"), 'README が CSP に触れていない');
});

test('記録中は CSV を書き出せない（README の手順がこれを前提にしている）', () => {
  // 書き出しボタンは running のあいだ無効である。
  // ここが変わったら README のシナリオ1の手順6を直すこと
  assert.match(
    script,
    /exportBtn\.disabled\s*=\s*running\s*\|\|/,
    '書き出しボタンの無効化が running を見ていない'
  );
  assert.ok(
    readme.includes('記録中は書き出しボタンが押せない'),
    'README が「記録中は書き出せない」と書いていない'
  );
});

test('撤回した法的な誤りが README に残っていない', () => {
  // 刑法第133条は信書開封罪であり、会話の傍受の条文ではない。
  // 第134条は身分犯で、利用者一般には及ばない。
  // 労働安全衛生法に職場監視の同意・通知を定めた条文は無い。
  const withdrawn = [
    '他人の会話を故意に傍受する行為は処罰対象',
    '職務上知り得た秘密を漏らす行為の禁止',
    '職場での監視に関する労働者の同意と通知義務',
    '探偵業務における適正な調査方法の義務付け'
  ];
  for (const s of withdrawn) {
    assert.ok(!readme.includes(s), `撤回したはずの記述が残っている: ${s}`);
  }
  assert.ok(readme.includes('過去の版にあった誤りの訂正'), '訂正の節が無い');
});

test('dBFS を端末に依存しない値として説明していない', () => {
  assert.ok(
    !readme.includes('使用デバイスに関係なく一貫した音量比較'),
    'dBFS が端末に依存しないという誤りが残っている'
  );
  assert.ok(readme.includes('同じ音を別の端末で測れば、別のdBFS値が出ます'), 'dBFS の限界を書いていない');
});

test('モバイルを検証済みと書いていない', () => {
  const table = readme.slice(readme.indexOf('### ブラウザー対応状況'));
  assert.ok(
    !/モバイル[\s\S]{0,400}?完全対応/.test(table.slice(0, 900)),
    'モバイルを「完全対応」と書いている'
  );
  assert.ok(
    readme.includes('iOS・Androidの実機では検証していません'),
    '実機未検証であることを書いていない'
  );
});

test('ハッシュチェーンの限界を README が書いている', () => {
  assert.ok(readme.includes('改ざんを防ぐ」ものではありません'), 'ハッシュチェーンの限界が書かれていない');
  assert.ok(readme.includes(logic.HASH_ALGO_LABEL), `README に ${logic.HASH_ALGO_LABEL} が無い`);
});

// ---- 画面内のヘルプと実装の照合 ----
//
// ⚠ README だけ直しても、利用者がその場で読むのは画面のほうである。
// 「説明と注意事項」とヘルプモーダルは CSV v2 になったあとも2列のまま残っていた。

function helpItem(label) {
  const i = html.indexOf('<strong>' + label + '</strong>');
  assert.notEqual(i, -1, `ヘルプに「${label}」の項目が無い`);
  const end = html.indexOf('</li>', i);
  assert.notEqual(end, -1, `「${label}」の項目が閉じていない`);
  return html.slice(i, end);
}

test('画面内のヘルプが CSV を2列だと言っていない', () => {
  assert.ok(
    !html.includes('タイムスタンプと音量（dBFS）が出力されます'),
    '「説明と注意事項」が2列のまま'
  );
  assert.ok(
    !html.includes('タイムスタンプと音量（dBFS）のペアで出力'),
    'ヘルプの「データの取り扱い」が2列のまま'
  );
});

test('ヘルプの CSV の説明が7列とヘッダー・トレーラーに触れている', () => {
  const item = helpItem('CSV形式：');
  for (const c of logic.CSV_COLUMNS) {
    assert.ok(item.includes(c), `ヘルプが列 ${c} を書いていない`);
  }
  assert.match(item, /ヘッダー行/, 'ヘルプがヘッダー行に触れていない');
  // ⚠ トレーラーはデータ行の「下」に付く。ここを書かないと、
  //    取り込みのときに末尾の `#` 行を見落とす
  assert.match(item, /トレーラー行/, 'ヘルプがトレーラー行に触れていない');
  assert.match(html, /CSVには7列/, '「説明と注意事項」が7列だと書いていない');
  assert.match(html, /下には[^<]*トレーラー行/, '「説明と注意事項」がトレーラー行の位置を書いていない');
});

test('README が CSV の4つの部分を説明している', () => {
  // ⚠ 起点とトレーラーの区別が README から消えると、受け取った側は
  //    検証の手順を組めない（`#` の行をまとめて起点にしてしまう）
  assert.ok(readme.includes('# trailerHash='), 'README がトレーラーのハッシュに触れていない');
  assert.ok(readme.includes('# rows='), 'README が行数のトレーラー行に触れていない');
  assert.ok(
    readme.includes('同じセッションを2回書き出すと同じ行のハッシュが変わります'),
    'README が「起点にあとから分かる事実を入れるとどうなるか」を書いていない'
  );
  // 起点の説明が「#で始まる行すべて」に戻っていないこと
  assert.ok(
    !readme.includes('起点はメタ行そのもの'),
    '起点を「メタ行そのもの」と書いた古い説明が残っている'
  );
  // 列のヘッダーより上だけが起点である、と言っている
  assert.ok(
    readme.includes('その上にある`#`の行が起点'),
    'README が起点の範囲（列のヘッダーより上）を書いていない'
  );
});

test('README の検証手順が実装のハッシュの作り方と合っている', () => {
  // 行の材料はコンマ区切り、トレーラーの材料は改行区切りである
  assert.equal(logic.hashInput('ab', ['x', 'y']), 'ab|x,y');
  assert.equal(logic.trailerHashInput('ab', ['# p=1', '# q=2']), 'ab|# p=1\n# q=2');
  assert.ok(
    readme.includes('その行の6つのフィールドをコンマで連結'),
    'README が行の材料の作り方を書いていない'
  );
  assert.ok(
    readme.includes('ファイルに並んでいる順のまま改行で連結'),
    'README がトレーラーの材料の作り方を書いていない'
  );
});

test('キャンバスの説明が実装の横軸と合っている', () => {
  const m = html.match(/id="levelCanvas"[^>]*title="([^"]+)"/);
  assert.ok(m, 'キャンバスの title が無い');
  assert.ok(!m[1].includes('経過時間の秒数'), '横軸を「経過時間の秒数」と書いている');
  assert.ok(
    m[1].includes('-' + logic.GRAPH_WINDOW_SEC + 's'),
    `横軸の左端（-${logic.GRAPH_WINDOW_SEC}s）が書かれていない`
  );
  assert.ok(m[1].includes('0s'), '横軸の右端（0s＝いま）が書かれていない');
});

test('ヘルプの表示下限が「記録される値は動かない」と書いている', () => {
  // 表示下限は表示のための設定である。記録するのは rawDb（生値）のほう
  assert.match(helpItem('表示下限：'), /記録される値は動きません/);
});

test('ヘルプの簡易モードが file:// に触れている', () => {
  // ブラウザーの未対応より、file:// で直接開いたときのほうが遭遇しやすい
  assert.match(helpItem('計測エンジンの表示：'), /file:\/\//);
});

test('画面へ出す文言の区切りに半角コロンを使っていない', () => {
  // index.html のヘルプは全角「：」で書いてある。script.js だけ半角で割れていた
  const lines = script.split('\n').filter(l => /setStatus\(|textContent = /.test(l));
  for (const l of lines) {
    assert.ok(
      !/[ぁ-んァ-ヶ一-龥][^\n]*: /.test(l),
      `半角コロンが残っている: ${l.trim()}`
    );
  }
});
