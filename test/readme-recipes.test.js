'use strict';

// READMEの「CSVデータの活用方法」に載せたレシピの出力が、実際の計算と合っているか（第2弾c1）。
//
// レシピ（Python・コマンドライン）の出力は、見本CSVと実機のCSVで実際に動かして、そのまま写した（手で書かない）。
// 手で書くと、式の取り違えがそのまま残る（Excelの日本時間の式は、ミリ秒の位置を MID(A2,20,3) と書きかけ、
// Pythonで同じ計算をして MID(A2,21,3) だと分かった）。
// ここでは、見本CSVにかけた出力を、同じ手順をJavaScriptで組んだものと1文字ずつ比べる。
// 実機のCSVにかけた出力（超音波帯だけが上がった時間帯・平時との比較・2台の端末の比べ方）は、CSVが
// リポジトリーに無いので計算し直せない。そのかわり、実際に動かした出力の全文を下の REAL_OUT に写して1文字ずつ比べ、
// あわせてREADMEの「📱 実機テスト」の表と矛盾しないことを見る（第2弾c1の点検で、全文を縛るよう直した）。
// ⚠ 実機のCSVはリポジトリーの外にある。レシピか実機の記録を変えたら、動かし直して REAL_OUT とREADMEを写し直す。
// レシピは標準ライブラリーだけで書く（pandasを使わない。本人の指示）。
// 第2弾c1bで、見本CSV・レシピ・Excelの手順はdocs/csv.md、実機テストの表はdocs/real-device-test.mdへ移した（READMEは入口）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
// 第2弾c1bでREADMEを入口にし、詳しい説明をdocs/へ分けた。READMEとdocs/を合わせたものが、分ける前のREADMEにあたる
const docsText = name => fs.readFileSync(path.join(root, 'docs', name), 'utf8');
const readmeAndDocs = [readme, ...fs.readdirSync(path.join(root, 'docs')).filter(n => n.endsWith('.md')).map(docsText)].join('\n');
const csvDoc = docsText('csv.md');
const realDoc = docsText('real-device-test.md');

function fencedBlocks() {
  const out = [];
  const re = /```([a-z]*)\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(csvDoc)) !== null) out.push({ lang: m[1], body: m[2] });
  return out;
}
const BLOCKS = fencedBlocks();

// 「$ python over.py sample.csv -30」の出力（コマンドの行を除いた部分）
function output(command) {
  const b = BLOCKS.filter(x => x.lang === 'text' && x.body.startsWith('$ ' + command + '\n'));
  assert.equal(b.length, 1, `出力が1つない: ${command}`);
  return b[0].body.slice(command.length + 3);
}

function code(name) {
  const b = BLOCKS.filter(x => x.lang === 'python' && x.body.startsWith(`# ${name} - `));
  assert.equal(b.length, 1, `レシピのコードが1つない: ${name}`);
  return b[0].body;
}

// ---- 見本CSVを、mgl.py の read_log と同じ手順で読む ----

function readLog(text) {
  const lines = text.split('\n').filter(l => l);
  const meta = {};
  for (const l of lines) {
    if (l.startsWith('# ') && l.includes('=')) {
      const i = l.indexOf('=');
      meta[l.slice(2, i)] = l.slice(i + 1);
    }
  }
  const table = lines.filter(l => !l.startsWith('#'));
  const cols = table[0].split(',');
  const runs = meta.intervalSec.split('+').map(p => p.split('@'));
  const edges = new Set(['sessionStartAt', 'clockBreakAt']
    .flatMap(k => (meta[k] || '').split(',').filter(Boolean).map(Number)));
  const num = c => (c === '' ? null : Number(c === '-Infinity' ? -Infinity : c));
  const rows = [];
  let prev = null;
  for (const l of table.slice(1)) {
    const r = Object.fromEntries(cols.map((c, i) => [c, l.split(',')[i]]));
    const seq = Number(r.seq);
    r.end = Date.parse(r.timestamp);
    r.sec = (prev === null || edges.has(seq))
      ? Number(runs.filter(([, at]) => Number(at) <= seq).pop()[0])
      : (r.end - prev.end) / 1000;
    r.start = r.end - r.sec * 1000;
    r.db = num(r.dbfs);
    r.ultra = num(r.band_ultra_dbfs || '');
    r.audible = num(r.band_audible_dbfs || '');
    rows.push(r);
    prev = r;
  }
  return { meta, rows };
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
// Python の strftime と同じ書式（%f はマイクロ秒6桁）で、日本時間にして書く
function jst(ms, fmt) {
  const d = new Date(ms + 9 * 3600 * 1000);
  return fmt
    .replace('%Y', d.getUTCFullYear()).replace('%m', pad(d.getUTCMonth() + 1)).replace('%d', pad(d.getUTCDate()))
    .replace('%H', pad(d.getUTCHours())).replace('%M', pad(d.getUTCMinutes())).replace('%S', pad(d.getUTCSeconds()))
    .replace('%f', pad(d.getUTCMilliseconds() * 1000, 6));
}

function leq(rows, key = 'db') {
  const pairs = rows.filter(r => r[key] !== null).map(r => [r.sec, r[key]]);
  const total = pairs.reduce((a, [s]) => a + s, 0);
  if (total === 0) return null;
  const power = pairs.reduce((a, [s, v]) => a + s * 10 ** (v / 10), 0) / total;
  return power > 0 ? 10 * Math.log10(power) : -Infinity;
}

function median(rows, key = 'db') {
  const v = rows.filter(r => r[key] !== null).map(r => r[key]).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function spans(rows, hit) {
  const out = [];
  for (const r of rows) {
    if (!hit(r)) continue;
    const last = out.length ? out[out.length - 1] : null;
    if (last && last[last.length - 1].end === r.start) last.push(r); else out.push([r]);
  }
  return out;
}

const SAMPLE_TEXT = BLOCKS.find(b => b.body.startsWith('# format=mic-gain-logger/3')).body;
const SAMPLE = readLog(SAMPLE_TEXT);

// ---- 見本CSVにかけた出力 ----

test('見本CSVは4行で、読み方の前提（1行目の区間長は # intervalSec= から）がそろっている', () => {
  assert.equal(SAMPLE.rows.length, 4);
  assert.deepEqual(SAMPLE.rows.map(r => r.sec), [1, 1, 1, 1]);
  assert.equal(SAMPLE.meta.intervalSec, '1@0');
});

test('grep -v の出力が、見本CSVから # の行を外したものと同じ', () => {
  const want = SAMPLE_TEXT.split('\n').filter(l => l && !l.startsWith('#')).join('\n') + '\n';
  assert.equal(output("grep -v '^#' sample.csv"), want);
});

test('check.py の出力が、見本CSVから計算したものと同じ', () => {
  const { meta, rows } = SAMPLE;
  const out = [`計測エンジン=${meta.engines || meta.engine}  加工の状態=${meta.processing}`];
  let n = 0;
  for (const r of rows) {
    const why = [];
    if (r.db === null) why.push('欠測');
    if (!['', '0'].includes(r.clip)) why.push('clip=' + r.clip);
    for (const k of ['valid_ratio', 'band_valid_ratio']) if (r[k] && Number(r[k]) < 1) why.push(`${k}=${r[k]}`);
    if (why.length) { n++; out.push(`seq ${r.seq}  ${jst(r.end, '%Y-%m-%d %H:%M:%S')}  ${why.join(' ')}`); }
  }
  out.push(`気をつける行 ${n} / ${rows.length}行`);
  assert.equal(output('python check.py sample.csv'), out.join('\n') + '\n');
});

test('to_jst.py の出力が、見本CSVから計算したものと同じ（日本時間＝UTC＋9時間）', () => {
  const out = SAMPLE.rows.map(r => `seq ${r.seq}  ${jst(r.start, '%Y-%m-%d %H:%M:%S.%f').slice(0, -3)} - `
    + `${jst(r.end, '%H:%M:%S.%f').slice(0, -3)}  ${r.sec.toFixed(3)}秒  dbfs ${r.dbfs}`);
  assert.equal(output('python to_jst.py sample.csv'), out.join('\n') + '\n');
});

test('hourly.py の出力が、区間長で重み付けした Leq と同じ', () => {
  const groups = new Map();
  for (const r of SAMPLE.rows) {
    const k = jst(r.start, '%Y-%m-%d %H時');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const f = v => (v === null ? 'なし' : `${v.toFixed(2)} dBFS`);
  const out = [...groups.keys()].sort().map(k => `${k}  ${groups.get(k).length}行  Leq ${f(leq(groups.get(k)))}  超音波帯 ${f(leq(groups.get(k), 'ultra'))}`);
  assert.equal(output('python hourly.py sample.csv'), out.join('\n') + '\n');
  // dBの算術平均ではない（無音の行を電力0で数える）
  assert.notEqual(leq(SAMPLE.rows).toFixed(2), '-Infinity');
});

test('over.py -30 の出力が、閾値を超えた行を切れ目なくつないだものと同じ', () => {
  const limit = -30;
  const found = spans(SAMPLE.rows, r => r.db !== null && r.db >= limit);
  const out = [`dbfs が ${limit.toFixed(2)} dBFS 以上`];
  for (const g of found) {
    const a = g[0], z = g[g.length - 1];
    out.push(`${jst(a.start, '%m-%d %H:%M:%S')} - ${jst(z.end, '%H:%M:%S')}  ${Math.trunc((z.end - a.start) / 1000)}秒  `
      + `seq ${a.seq}-${z.seq}  最大 ${Math.max(...g.map(r => r.db)).toFixed(2)} dBFS`);
  }
  const total = found.reduce((s, g) => s + (g[g.length - 1].end - g[0].start) / 1000, 0);
  out.push(`${found.length}回  合計 ${Math.trunc(total)}秒`);
  assert.equal(output('python over.py sample.csv -30'), out.join('\n') + '\n');
});

test('week.py の出力が、時刻（日本時間）×曜日の Leq の表と同じ', () => {
  const cells = new Map();
  for (const r of SAMPLE.rows) {
    const d = new Date(r.start + 9 * 3600 * 1000);
    const key = `${d.getUTCHours()},${(d.getUTCDay() + 6) % 7}`;   // Python の weekday()（月曜＝0）
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(r);
  }
  const hours = [...new Set([...cells.keys()].map(k => Number(k.split(',')[0])))].sort((a, b) => a - b);
  const out = ['時\t' + [...'月火水木金土日'].join('\t')];
  for (const h of hours) {
    const vals = [0, 1, 2, 3, 4, 5, 6].map(d => (cells.has(`${h},${d}`) ? leq(cells.get(`${h},${d}`)) : null));
    out.push(`${h}\t` + vals.map(v => (v === null ? '-' : v.toFixed(1))).join('\t'));
  }
  assert.equal(output('python week.py sample.csv'), out.join('\n') + '\n');
  // 見本の長さの説明が、見本の実際の長さ（1秒×4行）と合っている（第2弾c1の点検で「1時間ぶん」の誤りを直した）
  const first = SAMPLE.rows[0], last = SAMPLE.rows[SAMPLE.rows.length - 1];
  assert.equal((last.end - first.start) / 1000, 4);
  assert.ok(csvDoc.includes('見本は約4秒ぶんなので1行だけです'), 'hourly.py の説明');
  assert.ok(csvDoc.includes('見本は約4秒ぶん（12時台に収まる）なので、火曜の12時の1マスだけです'), 'week.py の説明');
  assert.ok(!readmeAndDocs.includes('見本は1時間ぶん'), '古い説明が残っている');
});

test('ultra_only.py を見本CSVにかけると、中央値の行だけが出る', () => {
  const bu = median(SAMPLE.rows, 'ultra');
  const ba = median(SAMPLE.rows, 'audible');
  const hit = spans(SAMPLE.rows, r => r.ultra !== null && r.audible !== null
    && r.ultra - bu >= 10 && (r.ultra - bu) - (r.audible - ba) >= 10);
  assert.equal(hit.length, 0);
  assert.equal(output('python ultra_only.py sample.csv'), `中央値  超音波帯 ${bu.toFixed(2)}  可聴帯 ${ba.toFixed(2)} dBFS\n`);
});

test('memo.py の出力が、見本CSVの行とメモを時刻の順に並べたものと同じ', () => {
  const memo = output('cat memo.txt').split('\n').filter(Boolean);
  assert.equal(memo.length, 2);
  const ev = SAMPLE.rows.map(r => [r.start, `${jst(r.start, '%H:%M:%S.%f').slice(0, -3)} - ${jst(r.end, '%H:%M:%S.%f').slice(0, -3)}  seq ${r.seq}  dbfs ${r.dbfs}`]);
  for (const l of memo) {
    const [t, text] = [l.slice(0, l.indexOf(',')), l.slice(l.indexOf(',') + 1)];
    const when = Date.parse(t.replace(' ', 'T') + '+09:00');
    ev.push([when, `${jst(when, '%H:%M:%S')}  [メモ] ${text}`]);
  }
  ev.sort((a, b) => a[0] - b[0]);   // 同じ時刻なら元の順（Python の sorted と同じく安定）
  assert.equal(output('python memo.py sample.csv memo.txt'), ev.map(e => e[1]).join('\n') + '\n');
});

test('Excel の日本時間の式を見本の1行目に当てると、README に書いた時刻になる', () => {
  const m = csvDoc.match(/=DATEVALUE\(LEFT\(A2,(\d+)\)\)\+TIMEVALUE\(MID\(A2,(\d+),(\d+)\)\)\+MID\(A2,(\d+),(\d+)\)\/86400000\+9\/24/);
  assert.ok(m, 'Excel の式が無い');
  const [, left, t0, tn, f0, fn] = m.map(Number);
  const a2 = SAMPLE.rows[0].timestamp;
  const MID = (s, at, n) => s.slice(at - 1, at - 1 + n);   // Excel の MID は1から数える
  const date = a2.slice(0, left);
  const time = MID(a2, t0, tn);
  const frac = MID(a2, f0, fn);
  assert.match(date, /^\d{4}-\d{2}-\d{2}$/, 'LEFT の桁数が日付と合わない');
  assert.match(time, /^\d{2}:\d{2}:\d{2}$/, 'TIMEVALUE に渡す位置が時刻と合わない');
  assert.match(frac, /^\d{3}$/, 'ミリ秒の位置が合わない');
  const ms = Date.parse(`${date}T${time}Z`) + Number(frac) + 9 * 3600 * 1000;
  const d = new Date(ms);
  const shown = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} `
    + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;
  assert.ok(csvDoc.includes(`見本の1行目は\`${shown}\`になる`), `docs/csv.md の時刻が ${shown} でない`);
  assert.ok(csvDoc.includes('Excel・Google Sheetsの実物では確かめていない'), '確かめた範囲を書いていない');
});

// ---- 実機のCSVにかけた出力（計算し直せないので、実機テストの表と矛盾しないことを見る） ----

// 実機テストの階段シーケンスの表（周波数 → 行・全帯域）
function stepTable() {
  const lines = realDoc.split('\n');
  const i = lines.indexOf('| 周波数 | 行（`seq`） | 全帯域 | 超音波帯 | 静寂との差（超音波帯） | 可聴帯 |');
  assert.notEqual(i, -1);
  const out = {};
  for (const l of lines.slice(i + 2)) {
    if (l[0] !== '|') break;
    const c = l.split('|').slice(1, -1).map(s => s.replace(/`/g, '').trim());
    const [a, b] = c[1].split('-').map(Number);
    out[c[0]] = { from: a, to: b, full: c[2] === '—' ? null : Number(c[2]) };
  }
  return out;
}
const STEP = stepTable();
const SPAN = /seq (\d+)-(\d+)/;
const spanList = text => text.split('\n').filter(l => SPAN.test(l)).map(l => l.match(SPAN).slice(1, 3).map(Number));
const covers = (list, a, b) => list.some(([x, y]) => x <= a && b <= y);
const touches = (list, a, b) => list.some(([x, y]) => !(y < a || b < x));

test('ultra_only.py の実機の出力が、18〜21kHzの段を拾い、22kHzと可聴域の段を拾っていない', () => {
  const out = output('python ultra_only.py iphone18pm_sweep_bands_20260929.csv');
  const list = spanList(out);
  assert.equal(list.length, 4);
  for (const f of ['18kHz', '19kHz', '20kHz', '21kHz']) assert.ok(covers(list, STEP[f].from, STEP[f].to), `${f} の段を拾っていない`);
  for (const f of ['22kHz', '1kHz', '15kHz', '16kHz', '17kHz']) assert.ok(!touches(list, STEP[f].from, STEP[f].to), `${f} の段を拾っている`);
});

test('over.py +10 の実機の出力が、実機テストの表の全帯域の値と閾値の大小に合っている', () => {
  const out = output('python over.py iphone18pm_sweep_bands_20260929.csv +10');
  const limit = Number(out.match(/= (-?\d+\.\d+) dBFS 以上/)[1]);
  const list = spanList(out);
  for (const [f, s] of Object.entries(STEP)) {
    if (s.full === null || f.startsWith('静寂')) continue;
    if (s.full >= limit) assert.ok(covers(list, s.from, s.to), `${f}（${s.full}）が出ていない`);
    else assert.ok(!touches(list, s.from, s.to), `${f}（${s.full}）が閾値 ${limit} より低いのに出ている`);
  }
});

test('compare.py の実機の出力が、実機テストの扇風機の表（扇風機オン・スピーカーオフ）と同じ値を出している', () => {
  const out = output('python compare.py iphone18pm_noise_fan-on_spk-off_20260929.csv iphone18pm_noise_fan-off_spk-on_20260929.csv '
    + 'iphone18pm_noise_fan-off_spk-on_tab-closed_20260929.csv iphone18pm_noise_fan-off_spk-on_stream-active_20260929.csv');
  const row = realDoc.split('\n').find(l => l.startsWith('| 扇風機オン・スピーカーオフ |'));
  const [full, audible, ultra] = row.split('|').slice(2, 5).map(s => Number(s.trim()));
  const target = key => Number(out.match(new RegExp(`^${key} の中央値  平時 \\S+  調べる記録 (\\S+)`, 'm'))[1]);
  assert.equal(target('dbfs'), full);
  assert.equal(target('band_audible_dbfs'), audible);
  assert.equal(target('band_ultra_dbfs'), ultra);
  // ヘッダーの文字列が同じでも、processing が off でない記録（Safariの unknown:）では注意の行が出る。
  // 第2弾c1の点検で、unknown: どうしを「測定条件の違い=なし」と出し、同じ条件だと読めると指摘された
  assert.match(out, /^ヘッダーの違い=なし$/m);
  assert.match(out, /^注意：加工が切れていたと確かめられない記録がある（processing=unknown:autoGainControl\+noiseSuppression）$/m);
  assert.ok(!readmeAndDocs.includes('測定条件の違い=なし'), '古い出力が残っている');
  assert.match(out, /^平時 3本 /m);
  // 本文とREADMEの活用例に、SafariではAGCが切れていたかを確かめられないことを添えている
  assert.ok(csvDoc.includes('「ヘッダーの違い=なし」は、測定条件が同じだったことの保証ではない'));
});

// ---- 実機のCSVにかけた出力の全文（動かし直して写した。実機のCSVはリポジトリーの外） ----

const REAL_OUT = {
  'python ultra_only.py iphone18pm_sweep_bands_20260929.csv': [
    '中央値  超音波帯 -93.50  可聴帯 -74.72 dBFS',
    '14:50:52 - 14:50:58  seq 46-51  超音波帯 最大 +29.3 dB  そのとき可聴帯 +5.2 dB',
    '14:50:59 - 14:51:05  seq 53-58  超音波帯 最大 +33.4 dB  そのとき可聴帯 +0.0 dB',
    '14:51:06 - 14:51:12  seq 60-65  超音波帯 最大 +41.9 dB  そのとき可聴帯 -0.2 dB',
    '14:51:13 - 14:51:19  seq 67-72  超音波帯 最大 +33.6 dB  そのとき可聴帯 -0.8 dB'
  ],
  ['python compare.py iphone18pm_noise_fan-on_spk-off_20260929.csv iphone18pm_noise_fan-off_spk-on_20260929.csv '
    + 'iphone18pm_noise_fan-off_spk-on_tab-closed_20260929.csv iphone18pm_noise_fan-off_spk-on_stream-active_20260929.csv']: [
    '平時 3本 94行 / 調べる記録 31行',
    'ヘッダーの違い=なし',
    '注意：加工が切れていたと確かめられない記録がある（processing=unknown:autoGainControl+noiseSuppression）',
    'dbfs の中央値  平時 -79.70  調べる記録 -75.92  差 +3.78 dB',
    'band_audible_dbfs の中央値  平時 -79.95  調べる記録 -76.47  差 +3.48 dB',
    'band_ultra_dbfs の中央値  平時 -106.05  調べる記録 -104.02  差 +2.03 dB',
    'dbfs の Leq  平時 -79.63  調べる記録 -75.89  差 +3.73 dB'
  ],
  'python over.py iphone18pm_sweep_bands_20260929.csv +10': [
    'dbfs の中央値 -72.77 + 10 dB = -62.77 dBFS 以上',
    '09-29 14:50:24 - 14:50:30  6秒  seq 18-23  最大 -37.48 dBFS',
    '09-29 14:50:31 - 14:50:36  5秒  seq 25-29  最大 -58.41 dBFS',
    '09-29 14:50:45 - 14:50:50  5秒  seq 39-43  最大 -58.40 dBFS',
    '09-29 14:50:59 - 14:51:04  5秒  seq 53-57  最大 -59.94 dBFS',
    '09-29 14:51:06 - 14:51:12  6秒  seq 60-65  最大 -51.59 dBFS',
    '09-29 14:51:13 - 14:51:18  5秒  seq 67-71  最大 -59.79 dBFS',
    '6回  合計 32秒'
  ]
};

test('実機のCSVにかけた出力が、動かし直して写した全文と1文字ずつ同じ', () => {
  for (const [cmd, lines] of Object.entries(REAL_OUT)) {
    assert.equal(output(cmd), lines.join('\n') + '\n', cmd);
  }
});

test('帯域の値がない記録で、ultra_only.py と over.py の + 付きが止まらずに理由を出す', () => {
  // 簡易モードでも、帯域の計算を止めていなければ # bands=18000-22000,20-18000 が出て、帯域の列は空欄になる。
  // 第2弾c1の点検で、この形のCSVを渡すと中央値が None のまま計算して TypeError で止まると指摘された
  const { chainHeaderMeta, ENGINE_FALLBACK } = require('../logic.js');
  const meta = chainHeaderMeta({ sessionMeta: { bandsEnabled: true, contextSampleRate: 48000 }, firstRec: { engine: ENGINE_FALLBACK, ts: new Date(0) } });
  assert.equal(meta.bands, '18000-22000,20-18000', '簡易モードのヘッダーに # bands= が出ていない（前提が変わった）');
  assert.match(code('ultra_only.py'), /bu, ba = median\(rows, "ultra"\), median\(rows, "audible"\)\nif bu is None or ba is None:/);
  assert.ok(!code('ultra_only.py').includes('meta.get("bands", "off") == "off"'), '# bands= だけで判定している');
  assert.match(code('over.py'), /base = median\(rows, key\)\n {4}if base is None:/);
  assert.match(code('compare.py'), /if b is not None and t is not None:\n {4}print\("dbfs の Leq/);
});

test('PowerShellの手順に、BOMとCRLFが付くことと、BOMを付けない書き方を添えている', () => {
  // 第2弾c1の点検で、Set-Content -Encoding UTF8（Windows PowerShell 5.1）はBOMを付けると指摘された。
  // 見本CSVにかけ、Set-Content は先頭が EF BB BF・CRが5つ、WriteAllLines はBOMなし・CRが5つで、CRを除くと grep の出力と同じだった
  assert.ok(csvDoc.includes('`-Encoding UTF8`はファイルの先頭にBOM（3バイト）を付け、改行はCRLFになります'));
  assert.ok(csvDoc.includes('`encoding="utf-8-sig"`'));
  assert.ok(csvDoc.includes('[IO.File]::WriteAllLines("$PWD\\table.csv", [string[]]$rows)'));
});

// ---- コードの約束 ----

// ---- コードそのもの ----
//
// 出力は、見本CSVにかけたものをJavaScriptで計算し直して比べている。ただし、レシピのコード（たとえば mgl.py の
// leq の 10 ** (db / 10)）を書き換えても、JavaScriptの計算は変わらないので落ちない（第2弾c1bの点検で指摘された）。
// そこで、出力を写したときのコードの SHA-256 を持つ。
// ⚠ レシピを変えたら、見本CSVと実機のCSVで動かし直し、docs/csv.md と REAL_OUT を写し直してから、ここの値を直す。
const crypto = require('node:crypto');
const sha256 = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const RECIPE_SHA256 = {
  'mgl.py': '3f6d91b9e50d6b2ecb0b9187bb1df59622033f8622e08b8d606b19499629aa81',
  'check.py': '136914c1d1fc2d3e98bcaf34e5c045f3e468a02c780593d900b4829deac09d4f',
  'to_jst.py': '9929bb78f6d36322d15161d7e101ef3a356809e9dfe32f394432a3660cd982e4',
  'hourly.py': '06761cfb5e9fdcd85b3641921dac287494420497f683bf12a57c2fb71b58d610',
  'over.py': 'd502df0430107b7b656af9d906e3dac602cbbd5ec52034596c05fce88563508e',
  'week.py': '18b73d754da71203244db69b6f47d8c3fa531d3c2a678966a41b3c465ba11356',
  'ultra_only.py': 'b47a08abc1cde44e0a6a48ef590740dea560df3ffb83f6da8386e5238d88d59c',
  'compare.py': '6bc2efc96a67658939238a7446e7fb74758819cb6e95fbe538069b49eee38da5',
  'memo.py': 'f0382eeea43f4c24df069bbd3fe6aa9c937de8880788e237304f5677b3e37750'
};

test('レシピのコードが、出力を写したときのコードと同じ', () => {
  for (const [n, sha] of Object.entries(RECIPE_SHA256)) {
    assert.equal(sha256(code(n)), sha, `${n} のコードが、出力を写したときのものと違う（変えたなら動かし直して出力を写し直す）`);
  }
  // docs/csv.md の Python は、この9本と検証器（test/chain-claim.test.js が見る）だけ
  const names = BLOCKS.filter(b => b.lang === 'python').map(b => b.body.split('\n')[0].match(/^# (\S+)/)[1]);
  assert.deepEqual([...names].sort(), [...Object.keys(RECIPE_SHA256), 'verify_mic_gain_log.py'].sort());
  // 結果を決める行（エネルギー平均と中央値）
  const mgl = code('mgl.py');
  assert.ok(mgl.includes('    power = sum(sec * 10 ** (db / 10) for sec, db in pairs) / total\n'), 'leq が電力の区間長重み付き平均でない');
  assert.ok(mgl.includes('    return 10 * math.log10(power) if power > 0 else -math.inf\n'));
  assert.ok(mgl.includes('    return vals[mid] if len(vals) % 2 else (vals[mid - 1] + vals[mid]) / 2\n'));
});

test('Pythonのブロックで、トップレベルの関数の前後に空行が2行ある（PEP 8。読者がそのまま写すコード）', () => {
  // 第2弾c1bでREADMEからdocs/へ分けたとき、連続した空行が1行に詰まった（14か所。動作は同じ）。点検で指摘されたので戻した
  const found = {};
  for (const b of BLOCKS.filter(x => x.lang === 'python')) {
    const name = b.body.split('\n')[0].match(/^# (\S+)/)[1];
    const ls = b.body.split('\n');
    let inDef = false;
    const blanksBefore = i => { let n = 0; while (i - n - 1 >= 0 && ls[i - n - 1] === '') n++; return n; };
    ls.forEach((l, i) => {
      if (l === '' || /^\s/.test(l)) return;
      if (l.startsWith('def ')) {
        (found[name] = found[name] || []).push(l.match(/^def (\w+)/)[1]);
        assert.equal(blanksBefore(i), 2, `${name} の「${l}」の前の空行が2行でない`);
        inDef = true;
      } else if (inDef) {
        assert.equal(blanksBefore(i), 2, `${name} の関数のあとの「${l}」の前の空行が2行でない`);
        inDef = false;
      }
    });
    assert.ok(!/\n\n\n\n/.test(b.body), `${name} に3行以上続く空行がある`);
  }
  assert.deepEqual(found, {
    'verify_mic_gain_log.py': ['h', 'hash_cell'],
    'mgl.py': ['parse_time', 'jst', 'num', 'read_log', 'leq', 'median', 'spans'],
    'ultra_only.py': ['rise'],
    'compare.py': ['load']
  });
});

test('レシピは標準ライブラリーだけを使い、1本のCSVを1回で読むモジュール（mgl.py）を共有している', () => {
  const names = ['mgl.py', 'check.py', 'to_jst.py', 'hourly.py', 'over.py', 'week.py', 'ultra_only.py', 'compare.py', 'memo.py'];
  const STD = new Set(['csv', 'datetime', 'math', 'sys']);
  for (const n of names) {
    const c = code(n);
    for (const m of c.matchAll(/^import (\w+)/gm)) assert.ok(STD.has(m[1]), `${n} が ${m[1]} を読んでいる`);
    for (const m of c.matchAll(/^from (\w+) import/gm)) assert.ok(m[1] === 'mgl', `${n} が ${m[1]} から読んでいる`);
    assert.ok(!/pandas|numpy/.test(c), `${n} が pandas・numpy を使っている`);
  }
  const mgl = code('mgl.py');
  // 境界の行（1行目・# sessionStartAt=・# clockBreakAt=）は、timestamp の差でなく # intervalSec= から区間長を取る
  assert.match(mgl, /sessionStartAt", "clockBreakAt"/);
  assert.match(mgl, /if prev is None or seq in edges:/);
  // 欠測（空欄）は None、無音（-Infinity）は電力0
  assert.match(mgl, /return float\(cell\) if cell else None/);
  assert.match(mgl, /if r\[key\] is not None/);
  // 実行した出力がある（見本CSVの6本・実機のCSVの3本）
  for (const c of ['python check.py sample.csv', 'python to_jst.py sample.csv', 'python hourly.py sample.csv',
    'python over.py sample.csv -30', 'python week.py sample.csv', 'python memo.py sample.csv memo.txt']) {
    assert.ok(output(c).length > 0, `出力が空: ${c}`);
  }
  assert.ok(csvDoc.includes('出力は、実際に動かしたものをそのまま写しています。'), '出力の出どころを書いていない');
});
