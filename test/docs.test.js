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

// ---- 第1弾で下げた名乗りに、外形が追随していること ----
//
// 第1弾で「証拠保全」「裁判資料」という名乗りを下げたのに、フロントマターと
// 想定ターゲット層と将来案がそのまま残っていた。散文と同じで、名乗りも
// 誰も直さないので腐る。機械で見られるものは機械に見させる。

// ⚠ フロントマターはハブ（hackinglab.online）の tools.json が読む。
//    README の本文だけ直しても、ハブの一覧には古い名乗りが出たままになる。
function frontMatter() {
  const m = readme.match(/^<!--\n---\n([\s\S]*?)\n---\n-->/);
  assert.ok(m, 'フロントマターの HTML コメントが見つからない');
  return m[1];
}

test('フロントマターの構造（キーと順序）が変わっていない', () => {
  // ハブ側がこのキーを読む。値を直すときに構造を動かしてはいけない
  const keys = frontMatter().split('\n')
    .filter(l => /^[a-z_]+:/.test(l))
    .map(l => l.slice(0, l.indexOf(':')));
  assert.deepEqual(keys, [
    'id', 'slug', 'title', 'subtitle_ja', 'subtitle_en',
    'description_ja', 'description_en', 'category_ja', 'category_en',
    'difficulty', 'tags', 'repo_url', 'demo_url', 'hub'
  ]);
});

test('フロントマターの説明が「調査員・探偵・法執行機関」を名乗っていない', () => {
  const fm = frontMatter();
  for (const s of ['調査員', '探偵', '法執行', 'investigator', 'law enforcement']) {
    assert.ok(!fm.includes(s), `フロントマターに ${s} が残っている`);
  }
});

test('想定ターゲット層が「調査員・探偵・法執行機関」を利用者に置いていない', () => {
  const head = readme.indexOf('## 👥 想定ターゲット層');
  const tail = readme.indexOf('### 🎯 想定する使い方');
  assert.ok(head !== -1 && tail > head, '想定ターゲット層の節が見つからない');
  const block = readme.slice(head, tail);
  for (const s of ['調査員', '探偵', '法執行']) {
    assert.ok(!block.includes(s), `想定ターゲット層に ${s} が残っている`);
  }
});

test('将来案が、入れないと決めた案を「いずれ入る」ものとして並べていない', () => {
  const head = readme.indexOf('## 💡 将来的な追加アイデア');
  const tail = readme.indexOf('## 📊 CSVデータの活用方法');
  assert.ok(head !== -1 && tail > head, '将来案の節が見つからない');
  const block = readme.slice(head, tail);

  const cut = block.indexOf('### 将来案に入れないもの');
  assert.notEqual(cut, -1, '「将来案に入れないもの」の見出しが無い');
  const plan = block.slice(0, cut);
  for (const s of ['A特性', 'キャリブレーション', 'ステルスモード', 'L10']) {
    assert.ok(!plan.includes(s), `入れないと決めた案が将来案の側に残っている: ${s}`);
  }

  // 第2弾の名乗り。スペクトログラムは主役ではなくファインダーである
  assert.ok(block.includes('聞こえない帯域を、穴の無い記録として残す'), '第2弾の名乗りが無い');
  assert.ok(block.includes('18〜22kHz'), '第2弾で扱う帯域が書かれていない');
  // ⚠ 検出・診断は第3弾である。第1弾のハッシュチェーンと同じ作法で、
  //    示せることだけを書く
  assert.ok(
    block.includes('「超音波ビーコンを検出する」とは書きません'),
    '検出を名乗らないことが書かれていない'
  );
});

test('廃止したスムージングの置き換え（時間重み）の約束が残り、記録の側だけ狭まっている', () => {
  // 時間重みは第1弾でスライダーを外したときの約束である。消してはいけない。
  // ただし「記録にも反映」は言い過ぎだった。区間 Leq は区間の完全な要約なので、
  // 時間重みをかけても区間の平均は変わらない。記録に足せるのは LFmax / LSmax
  assert.ok(readme.includes('時間重み'), '時間重みの約束が消えている');
  assert.ok(
    !readme.includes('表示と記録の両方に反映される形'),
    '記録にも反映すると約束したままになっている'
  );
  assert.ok(readme.includes('LFmax'), '記録に足せる範囲（LFmax／LSmax）が書かれていない');
});

test('Excel の手順が dB の算術平均を教えていない', () => {
  // `=AVERAGE(B:B)` は第1弾が画面で捨てた計算である。
  // しかも `-Infinity` の行はセルの上では文字列なので、警告も出ずに集計から外れる
  const head = readme.indexOf('### Excel/Google Sheetsでの分析手順');
  const tail = readme.indexOf('## 🌐 技術スタック');
  assert.ok(head !== -1 && tail > head, 'Excel の手順が見つからない');
  const block = readme.slice(head, tail);

  for (const line of block.split('\n')) {
    if (!line.includes('=AVERAGE(')) continue;
    assert.ok(
      /POWER|ではない|Ctrl\+Shift\+Enter|警告なしで無視/.test(line),
      `算術平均の式が手順として残っている: ${line.trim()}`
    );
  }
  assert.ok(
    block.includes('画面の「平均（Leq）」ではない'),
    '算術平均が画面の値でないことを書いていない'
  );
  // エネルギー平均の式。等間隔のときと、区間長で重み付けするときの2本
  assert.ok(block.includes('SUMPRODUCT(POWER(10,'), '等間隔のときの Leq の式が無い');
  // ⚠ 作業用の列は H 以降である。C 列は seq で、上書きすると
  //    境界の行（# sessionStartAt= / # clockBreakAt=）を見つけられなくなる
  assert.ok(
    block.includes('SUMPRODUCT($H$2:$H$100,POWER(10,'),
    '区間長で重み付けした Leq の式が無い'
  );
  assert.ok(block.includes('`-999`'), '無音の行（-Infinity）の扱いが書かれていない');
});

test('Excel の手順が、seq の列（C）を作業用に潰していない', () => {
  const head = readme.indexOf('### Excel/Google Sheetsでの分析手順');
  const tail = readme.indexOf('## 🌐 技術スタック');
  const block = readme.slice(head, tail);
  // CSV の列は timestamp,dbfs,seq,peak_dbfs,clip,valid_ratio,hash ＝ A〜G である
  assert.equal(logic.CSV_COLUMNS.length, 7, 'CSV の列数が変わっている（作業列の位置も見直すこと）');
  assert.equal(logic.CSV_COLUMNS[2], 'seq', 'C 列が seq でなくなっている');
  assert.ok(
    !/C列に隣の行との差/.test(block) && !/C3に`=\(A3-A2\)\*86400`/.test(block),
    '区間長を C 列（seq）へ書く手順が残っている'
  );
  assert.ok(
    block.includes('作業用の列はH列以降に置く'),
    '作業用の列の位置が書かれていない'
  );
});

test('Excel の手順が、セッションの境界とアンカーの取り直しを重みから外している', () => {
  const head = readme.indexOf('### Excel/Google Sheetsでの分析手順');
  const tail = readme.indexOf('## 🌐 技術スタック');
  const block = readme.slice(head, tail);
  assert.ok(block.includes('# sessionStartAt='), '境界の行の見つけ方（# sessionStartAt=）が無い');
  assert.ok(block.includes('# clockBreakAt='), 'アンカーの取り直した行の扱いが無い');
  // 実装がその行を出していること（README だけ直しても意味がない）
  const rows = [
    { seq: 0, metaId: 'a', ts: new Date(0), rawDb: -20, intervalSec: 1 },
    { seq: 1, metaId: 'b', ts: new Date(1000), rawDb: -20, intervalSec: 1 }
  ];
  const trailer = logic.csvTrailerLines(rows, {});
  assert.ok(trailer.includes('# sessionStartAt=0,1'), trailer.join(' / '));
});

test('トラブルシューティングが、第1弾で直した不具合の回避策を載せていない', () => {
  const head = readme.indexOf('### よくある問題と解決方法');
  const tail = readme.indexOf('### ブラウザー対応状況');
  assert.ok(head !== -1 && tail > head, 'トラブルシューティングの節が見つからない');
  const block = readme.slice(head, tail);

  // ⚠ ズームで拡大するのは、非整数の幅で RangeError を踏む側の操作だった
  assert.ok(!block.includes('ブラウザーのズーム機能で拡大'), 'ズームで拡大する回避策が残っている');
  assert.ok(!block.includes('ブラウザーのキャッシュをクリア'), 'キャッシュクリアの回避策が残っている');
  // 直したこと自体は、正体つきで残す（同じ症状が出たら別の原因である）
  assert.ok(block.includes('RangeError'), '直した不具合の正体が書かれていない');
  assert.ok(block.includes('第1弾で直した'), '第1弾で直したことが書かれていない');
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

test('シナリオ例が「画面ロック相当で実測確認」と言い切っていない', () => {
  // 画面ロック相当の状態は Chromium のエミュレーションである。
  // 同じ README の対応表が「モバイルはエミュレーションのみ」と書いているので、
  // シナリオ側が「実測で確認した」と言い切ると食い違う。
  // 未確認である旨は「ブラウザー対応状況」の1か所へ集約し、他はそこを指す
  const head = readme.indexOf('## 📋 具体的なシナリオ例');
  const tail = readme.indexOf('## 📂 ディレクトリー構成');
  assert.ok(head !== -1 && tail > head, 'シナリオ例の節が見つからない');
  const scenarios = readme.slice(head, tail);

  assert.ok(
    !scenarios.includes('確認済みの動作環境'),
    'シナリオ例が「確認済みの動作環境」と言い切っている'
  );
  assert.ok(
    !/画面ロック相当[^。]*実測で確認/.test(scenarios),
    'シナリオ例が画面ロック相当を実測で確認したと書いている'
  );
  assert.ok(
    scenarios.includes('スマートフォンの実機では確かめていない'),
    'シナリオ例が実機未確認であることを書いていない'
  );
  assert.ok(
    scenarios.includes('ブラウザー対応状況'),
    'シナリオ例が検証範囲の集約先を指していない'
  );
  // 集約先の側にも、そこが唯一の記載場所であることを書いておく
  assert.ok(
    readme.includes('「どこまで確かめたか」の唯一の記載場所です'),
    '検証範囲の集約先が明示されていない'
  );
  assert.ok(
    readme.includes('「画面ロック相当」はブラウザーのエミュレーションであり'),
    '画面ロック相当がエミュレーションであることを書いていない'
  );
});

test('ハッシュチェーンの限界を README が書いている', () => {
  assert.ok(
    readme.includes('意図的な改変には、相手が誰であっても耐えません'),
    'ハッシュチェーンの限界が書かれていない'
  );
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

test('ヘルプの「統計と表示」が、画面に出している値をすべて説明している', () => {
  // ⚠ 第2弾で足した3値（真のピーク・クリップ数・有効サンプル率）が
  //    ヘルプの一覧に無かった。画面に出ているものは、画面で説明する
  const head = html.indexOf('<h3>📊 統計と表示</h3>');
  const tail = html.indexOf('<h3>💾 データの取り扱い</h3>');
  assert.ok(head !== -1 && tail > head, 'ヘルプの「統計と表示」が見つからない');
  const block = html.slice(head, tail);
  for (const label of ['稼働時間', 'ログ件数', '平均（Leq）', '最大/最小/変動幅', '真のピーク', '記録の穴']) {
    assert.ok(block.includes('<strong>' + label + '：</strong>'), `ヘルプに「${label}」が無い`);
  }
  // クリップ数と有効サンプル率は、どこかに説明があること
  assert.ok(block.includes('クリップ'), 'クリップの説明が無い');
  assert.ok(block.includes('有効サンプル率'), '有効サンプル率の説明が無い');
});

test('ヘルプが「平均（Leq）の重みは区間長」と書いている', () => {
  // ⚠ README:92 にはあったが、画面だけ見た読者は Excel で等重みの式を組む
  assert.match(helpItem('平均（Leq）：'), /重みは行数ではなく区間長/);
});

test('ヘルプの「CSVから同じ値が出る」が、成り立つ条件つきになっている', () => {
  // ⚠ 以前は「画面の値とCSVから計算し直した値は一致します」と言い切っていた。
  //    記録を止めて再開すると timestamp の差に休止時間が入るので、嘘になる
  assert.ok(
    !html.includes('画面の値とCSVから計算し直した値は一致します'),
    '無条件に一致すると言い切ったままになっている'
  );
  const head = html.indexOf('<h3>📊 統計と表示</h3>');
  const tail = html.indexOf('<h3>💾 データの取り扱い</h3>');
  const block = html.slice(head, tail);
  assert.ok(block.includes('sessionStartAt'), '境界の行の見つけ方が画面に無い');
  assert.ok(block.includes('clockBreakAt'), 'アンカーを取り直した行の扱いが画面に無い');
  assert.match(block, /条件があります/, '条件つきだと書いていない');
});

test('favicon を参照していて、実ファイルがある', () => {
  // 参照が無いとブラウザーが /favicon.ico を取りにいって、コンソールに404が残る
  const m = html.match(/<link rel="icon" href="\.\/([^"]+)"/);
  assert.ok(m, 'index.html が favicon を参照していない');
  const file = path.join(root, m[1]);
  assert.ok(fs.existsSync(file), `favicon の実ファイルが無い: ${m[1]}`);
  // 外部への取得を増やさない（CSP の default-src 'self' に収まること）
  assert.ok(!/^https?:/.test(m[1]), 'favicon を外部から取りにいっている');
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
