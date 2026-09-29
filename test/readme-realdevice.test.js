'use strict';

// READMEの「📱 実機テスト」の表と数値が、実機の記録と同じか（第2弾c1）。
//
// 実機の記録の正は、リポジトリーの外に保管している測定メモと実機のCSVである。実機のCSVは筆者の部屋で採った
// 記録なので、リポジトリーには入れない（READMEに載せるのは数値だけ）。下の期待値は、その記録の表から写した。
// ⚠ 実機テストをやり直したら、記録のほうを先に直し、ここの期待値とREADMEを合わせる。READMEだけ直して
//    ここを合わせてはいけない。
// あわせて、「ブラウザー対応状況」に残っていた「第2弾bは実機では未確認」の古い記述が消えたこと、
// Tone Sweep（実機テストの音源のページ）へのリンクをまだ張っていないこと（公開したら張る。本人の指示）、
// 実機のCSVがリポジトリーに入っていないことを見る。
// 本文の「約7.3dB」「+1.9dB」「約36〜38dB」「約34〜36dB」「約3.8dB・約3.4dB」は、表の値から計算し直して確かめる
// （手で丸めた値が表と食い違わないように）。22kHzが帯域の端で低く出るぶん（約2dB）は、bandPlanのビンの割り当てと
// 周期型Hann窓から計算し直す（第2弾c1の点検で、36〜38dBをまるごと音源側か受音側のせいにしていたと指摘された）。
// 第2弾c1bで、実機テストの節はdocs/real-device-test.mdへ移した（READMEは入口。ブラウザー対応状況はREADMEに残る）。
// 過去の版の説明を消したので、画面で見えなかった理由は「記録した版（090648f）の表示下限」と条件で書き、
// いまの表示下限の既定は、変えた経緯ではなく、いまの設定として書く。
// 確かめていない画面は、開発の段階名（第2弾c0・第2弾c3a）ではなく「実機テストの版（090648f）より後に入れた画面」
// 「日英の切り替え」と書く（段階名はREADME・docs/のどこにも説明が無いため。第2弾c1bの点検で直した）。
// READMEのブラウザー対応状況は、である調の箇条書きにした（行数と valid_ratio の値は docs/real-device-test.md）。
// 叩いたときの超音波帯（帯域ありの seq 17）と、c7b6bad の記録のクリップ（8区間・延べ385サンプル）も、
// 実機の記録の値と同じかを見る（第2弾c1bの点検で、書き換えてもテストが落ちないと指摘された）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { bandPlan } = require('../logic.js');

const root = path.join(__dirname, '..');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
// 第2弾c1bでREADMEを入口にし、詳しい説明をdocs/へ分けた。READMEとdocs/を合わせたものが、分ける前のREADMEにあたる
const docsText = name => fs.readFileSync(path.join(root, 'docs', name), 'utf8');
const readmeAndDocs = [readme, ...fs.readdirSync(path.join(root, 'docs')).filter(n => n.endsWith('.md')).map(docsText)].join('\n');
const roadmapText = docsText('roadmap.md');
const realDoc = docsText('real-device-test.md');

// 見出しから、同じか上の階層の次の見出しまで（コードブロックの中の `#` 行は見出しに数えない）
function section(text, head) {
  const lines = text.split('\n');
  const start = lines.indexOf(head);
  assert.notEqual(start, -1, `見出しが無い: ${head}`);
  const level = head.match(/^#+/)[0].length;
  let fence = false;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { fence = !fence; continue; }
    if (fence) continue;
    const m = lines[i].match(/^(#+) /);
    if (m && m[1].length <= level) return lines.slice(start, i).join('\n');
  }
  return lines.slice(start).join('\n');
}

const norm = s => s.replace(/\*\*/g, '').replace(/`/g, '').trim();

function tableRows(text, headerLine) {
  const lines = text.split('\n');
  const i = lines.indexOf(headerLine);
  assert.notEqual(i, -1, `表が見つからない: ${headerLine}`);
  const rows = [];
  for (const l of lines.slice(i + 2)) {
    if (l[0] !== '|') break;
    rows.push(l.split('|').slice(1, -1).map(norm));
  }
  assert.ok(rows.length, `表の中身が無い: ${headerLine}`);
  return rows;
}

// セルの中の数値を順に取り出す（「+1.25（直後の静寂とは+1.9）」→ [1.25, 1.9]）
const nums = cell => (cell.match(/[+-]?\d+(?:\.\d+)?/g) || []).map(Number);
const p = db => 10 ** (db / 10);
const db = pw => 10 * Math.log10(pw);

// 周波数fの正弦波のうち、超音波帯のビン（bandPlan(48000)）に入る電力。周期型Hann窓・N=fftSizeのDFTで計算する
function ultraShare(f) {
  const plan = bandPlan(48000);
  const N = plan.fftSize;
  const band = plan.bands.find(b => b.key === 'ultra');
  const x = Array.from({ length: N }, (_, n) => Math.sin(2 * Math.PI * f * n / 48000 + 0.3) * (0.5 - 0.5 * Math.cos(2 * Math.PI * n / N)));
  let sum = 0;
  for (let k = band.binLo; k <= band.binHi; k++) {
    let re = 0, im = 0;
    for (let n = 0; n < N; n++) { re += x[n] * Math.cos(2 * Math.PI * k * n / N); im -= x[n] * Math.sin(2 * Math.PI * k * n / N); }
    sum += re * re + im * im;
  }
  return sum;
}

const HEAD = '# 📱 実機テスト（iPhone 18 Pro Max）';
const REAL = section(realDoc, HEAD);

// ---- 実機の記録（2026-09-29の測定メモ）から写した値 ----

// 22kHzの測り直し（第2弾b4）。周波数・行（seq）・全帯域・超音波帯・静寂との差（超音波帯）・可聴帯
const STEPS = [
  ['静寂（前）', [0, 16], -73.72, -92.99, [0], -74.21],
  ['1kHz', [19, 22], -37.50, -93.61, [-0.62], -37.50],
  ['15kHz', [26, 29], -58.55, -93.85, [-0.86], -58.57],
  ['16kHz', [33, 36], -66.46, -93.87, [-0.88], -66.54],
  ['17kHz', [40, 43], -58.69, -93.88, [-0.89], -58.71],
  ['18kHz', [47, 50], -63.24, -64.37, [28.61], -69.75],
  ['19kHz', [54, 57], -60.08, -60.23, [32.75], -75.14],
  ['20kHz', [61, 64], -51.73, -51.75, [41.24], -75.24],
  ['21kHz', [68, 71], -59.83, -59.97, [33.01], -75.27],
  ['22kHz', [75, 78], -74.66, -91.74, [1.25, 1.9], -75.24],
  ['静寂（後）', [80, 99], null, -93.66, null, null]
];

// 実機の関門（帯域あり／?bands=off）。行の頭の数値だけを見る（READMEは「（約1分）」などを添えている）
const GATE = [
  ['記録した行', [60], [114]],
  ['`valid_ratio`が1.000未満の行', [0, 60], [0, 114]],
  ['`band_valid_ratio`が1.000未満の行', [0, 60], []],
  ['1行目の`valid_ratio`', [1.0], [1.0]],
  ['静かな行の`dbfs`の中央値', [-75.67], [-75.44]],
  ['静かな行の超音波帯の中央値', [-101.74], []],
  ['静かな行の可聴帯の中央値', [-76.27], []],
  ['`clip`が0でない行', [0], [0]],
  ['叩いた行の`peak_dbfs`', [-41.28, -49.60, -41.80], [-38.10, -38.90, -31.48]]
];

// 扇風機とスピーカーのオン／オフ（同じ場所、行の中央値）。全帯域・可聴帯・超音波帯
const FAN = [
  ['扇風機オン・スピーカーオン', -74.68, -75.24, -93.67],
  ['扇風機オン・スピーカーオフ', -75.92, -76.47, -104.02],
  ['扇風機オフ・スピーカーオン', -79.67, -79.84, -105.05]
];

// 叩いたとき。帯域ありの記録（60行）の seq 17 の band_ultra_dbfs と、c7b6bad の版で採った別の記録のクリップ
// （CSVは残っていない。測定メモの値）
const TAP_ULTRA_SEQ = 17;
const TAP_ULTRA = -93.93;
const C7B6BAD_CLIP = { intervals: 8, samples: 385 };

const SETTINGS_RAW = '# settingsRaw=echoCancellation:false;autoGainControl:unreported;noiseSuppression:unreported;sampleRate:48000;channelCount:unreported';
const PROCESSING = '# processing=unknown:autoGainControl+noiseSuppression';

// ---- 表 ----

test('階段シーケンスの表が、実機の記録の値と同じ', () => {
  const rows = tableRows(REAL, '| 周波数 | 行（`seq`） | 全帯域 | 超音波帯 | 静寂との差（超音波帯） | 可聴帯 |');
  assert.equal(rows.length, STEPS.length, '段の数が違う');
  STEPS.forEach(([label, seq, full, ultra, diff, audible], i) => {
    const r = rows[i];
    assert.equal(r[0], label, `${i + 1}行目の周波数`);
    assert.deepEqual(nums(r[1]).map(Math.abs), seq, `${label}の行（seq）`);
    if (full === null) assert.equal(r[2], '—'); else assert.deepEqual(nums(r[2]), [full], `${label}の全帯域`);
    assert.equal(nums(r[3])[0], ultra, `${label}の超音波帯`);
    if (diff === null) assert.equal(r[4], '—'); else assert.deepEqual(nums(r[4]), diff, `${label}の静寂との差`);
    if (audible === null) assert.equal(r[5], '—'); else assert.deepEqual(nums(r[5]), [audible], `${label}の可聴帯`);
  });
});

test('実機の関門の表が、実機の記録の値と同じ', () => {
  const rows = tableRows(REAL, '| 項目 | 帯域あり | `?bands=off` |');
  assert.equal(rows.length, GATE.length);
  GATE.forEach(([label, on, off], i) => {
    assert.equal(rows[i][0], norm(label));
    assert.deepEqual(nums(rows[i][1]).slice(0, on.length), on, `${label}（帯域あり）`);
    if (off.length) assert.deepEqual(nums(rows[i][2]).slice(0, off.length), off, `${label}（?bands=off）`);
    else assert.equal(rows[i][2], '（空欄）', `${label}（?bands=off）は空欄`);
  });
});

test('扇風機とスピーカーの表が、実機の記録の値と同じ', () => {
  const rows = tableRows(REAL, '| 条件 | 全帯域 | 可聴帯 | 超音波帯 |');
  assert.equal(rows.length, FAN.length);
  FAN.forEach(([label, full, audible, ultra], i) => {
    assert.ok(rows[i][0].startsWith(label), `${i + 1}行目の条件: ${rows[i][0]}`);
    assert.deepEqual([nums(rows[i][1])[0], nums(rows[i][2])[0], nums(rows[i][3])[0]], [full, audible, ultra], label);
  });
  // 扇風機を止めたまま採った2本（音声の出力が動いたまま・音源のページを閉じた）の超音波帯の中央値
  assert.ok(REAL.includes('超音波帯の中央値は-107.0と-106.0'), '残りの2本の値が無い');
});

// ---- 本文の数値を表から計算し直す ----

test('本文の数値が、表の値から計算した値と合う', () => {
  const step = label => STEPS.find(s => s[0] === label);
  const quiet = step('静寂（前）');
  const after = step('静寂（後）');

  // 18〜21kHzは静かなときより+29〜+41dB
  const rises = ['18kHz', '19kHz', '20kHz', '21kHz'].map(l => step(l)[4][0]);
  assert.equal(Math.round(Math.min(...rises)), 29);
  assert.equal(Math.round(Math.max(...rises)), 41);
  assert.ok(REAL.includes('+29〜+41dB'));

  // 22kHzは直後の静寂より約+1.9dB
  const up22 = step('22kHz')[3] - after[3];
  assert.equal(up22.toFixed(1), '1.9');
  assert.ok(REAL.includes('直後の静寂（-93.66、行ごとのばらつきσ≈0.1dB）より約+1.9dB高く'));

  // 22kHzのトーンだけの強さ（前後どちらの静寂から引くか）と、21kHzからの落ち方
  const toneAfter = db(p(step('22kHz')[3]) - p(after[3]));
  const toneBefore = db(p(step('22kHz')[3]) - p(quiet[3]));
  assert.equal(Math.round(toneAfter), -96);
  assert.equal(Math.round(toneBefore), -98);
  assert.ok(REAL.includes('約-96〜-98dBFS'));
  const drop = [step('21kHz')[3] - toneAfter, step('21kHz')[3] - toneBefore].map(Math.round);
  assert.deepEqual(drop, [36, 38]);
  assert.ok(REAL.includes('約36〜38dB落ちている'));
  // そのうち約2dBは、22kHzが超音波帯の上端に乗って本ツールの側で低く読むぶん。21kHzは帯域の内側なので0
  const edge = f => -db(ultraShare(f) / ultraShare(20000));
  assert.equal(Math.round(edge(22000)), 2);
  assert.ok(Math.abs(edge(21000)) < 0.01, `21kHzでも帯域の端で落ちている: ${edge(21000)}`);
  assert.ok(REAL.includes('36〜38dBのうち約2dBは、本ツールの側で低く読んだぶんである'));
  const rest = [step('21kHz')[3] - toneAfter, step('21kHz')[3] - toneBefore].map(d => Math.round(d - edge(22000)));
  assert.deepEqual(rest, [34, 36]);
  assert.ok(REAL.includes('残りの約34〜36dB'));

  // 18kHzの境目：可聴帯から静寂のぶんを引いた値と超音波帯の差が約7.3dB、計算（5/6と1/6）は7.0dB
  const audibleOnly = db(p(step('18kHz')[5]) - p(quiet[5]));
  assert.equal(audibleOnly.toFixed(1), '-71.7');
  assert.equal((step('18kHz')[3] - audibleOnly).toFixed(1), '7.3');
  assert.equal(db(5).toFixed(1), '7.0');
  assert.ok(REAL.includes('約7.3dB') && REAL.includes('差7.0dB'));

  // 扇風機は全帯域を約3.8dB、可聴帯を約3.4dB上げる（扇風機オン・スピーカーオフと、扇風機オフ・スピーカーオンの差）。
  // 第2弾c1の点検で、可聴帯（3.37dB）まで「約4dB」とまとめていたのを直した
  const fanFull = (FAN[1][1] - FAN[2][1]).toFixed(1);
  const fanAudible = (FAN[1][2] - FAN[2][2]).toFixed(1);
  assert.deepEqual([fanFull, fanAudible], ['3.8', '3.4']);
  assert.ok(REAL.includes(`全帯域を約${fanFull}dB、可聴帯を約${fanAudible}dB上げる`));
  assert.ok(!readmeAndDocs.includes('全帯域と可聴帯を約4dB'), '可聴帯まで約4dBとまとめた古い記述が残っている');
});

test('Safariが報告した測定条件を、実物のメタ行で載せている', () => {
  assert.ok(REAL.includes('```\n' + PROCESSING + '\n' + SETTINGS_RAW + '\n```'), '# processing= と # settingsRaw= の実物が無い');
  // 音の加工の3項目のうち echoCancellation しか報告しない（sampleRate は報告した）
  assert.ok(REAL.includes('音の加工の3項目のうち`echoCancellation`しか報告しなかった'));
  assert.ok(REAL.includes('音声トラックのサンプルレートは48000Hzで、AudioContext（`# sampleRate=48000`）と同じだった'));
});

test('使った端末と条件・22kHzの原因・画面で見えなかった理由・叩いたときの値を書いている', () => {
  for (const s of [
    'iPhone 18 Pro Max（1台）のSafari', '`090648f`', '| ログ間隔 | 1秒 |', 'スピーカーの正面10cm以内',
    '扇風機・PCのファン・別室の洗濯機の音がある部屋',
    '22kHzで落ちている原因が音源側か受音側かは、分けられない', '48000Hzどうし',
    '記録した版（`090648f`）の表示下限の既定（-90dBFS）より下なので、グラフの下端に張り付いて見えなかった',
    '表示下限の既定は-110dBFS（`?bands=off`では-90dBFS）', '上限の0dBFSまで30dB以上あり',
    '何の音かは分からなかった', '約0.84秒'
  ]) {
    assert.ok(REAL.includes(s), `実機テストの節に「${s}」が無い`);
  }
});

test('叩いたときの本文の値が、実機の記録と表の値に合う', () => {
  const gate = label => GATE.find(g => g[0] === label);
  // 叩いた行の peak_dbfs（帯域あり・?bands=off の6つ）は -31〜-50dBFS で、0dBFS まで30dB以上ある
  const peaks = [...gate('叩いた行の`peak_dbfs`')[1], ...gate('叩いた行の`peak_dbfs`')[2]];
  assert.deepEqual([Math.round(Math.max(...peaks)), Math.floor(Math.min(...peaks))], [-31, -50]);
  assert.ok(0 - Math.max(...peaks) >= 30, '叩いた行の peak_dbfs が 0dBFS まで30dB以上ない');
  assert.ok(REAL.includes('`peak_dbfs`は-31〜-50dBFSで、上限の0dBFSまで30dB以上あり、クリップした行はありませんでした'));
  assert.deepEqual(gate('`clip`が0でない行').slice(1), [[0], [0]]);
  // 叩いた音は超音波帯にも少し出る。静かな行の超音波帯の中央値（-101.74）より約8dB上
  const up = Math.round(TAP_ULTRA - gate('静かな行の超音波帯の中央値')[1][0]);
  assert.equal(up, 8);
  assert.ok(REAL.includes(`帯域ありのseq ${TAP_ULTRA_SEQ}で${TAP_ULTRA.toFixed(2)}dBFS、静かな行より約${up}dB上`),
    '叩いたときの超音波帯の値が、実機の記録と違う');
  // c7b6bad の版で採った別の記録のクリップ
  assert.ok(REAL.includes(`クリップが${C7B6BAD_CLIP.intervals}区間・延べ${C7B6BAD_CLIP.samples}サンプル出ていました`),
    'c7b6bad の記録のクリップの値が、測定メモと違う');
  assert.ok(REAL.includes('そのときのCSVは残っていないので、原因は確かめられていません'));
});

test('画面の見え方は筆者の記憶として書き、CSVで確かめたことと分けている', () => {
  // 第2弾c1の点検で、画面の超音波帯の線を「実機のCSVで確かめた」と書いていたと指摘された（CSVに描画の記録は無い）
  assert.ok(REAL.includes('（筆者の記憶によります。CSVの値から考えても、同じ見え方になります）'));
  const browser = section(readme, '### ブラウザー対応状況');
  assert.ok(!browser.includes('CSV v3・画面の超音波帯の線'), '画面の線をCSVで確かめたと書いている');
  // READMEのブラウザー対応状況は、である調の箇条書き（第2弾c1bの点検で、1段落1,390字を分けた）
  const seen = browser.split('\n').find(l => l.startsWith('- 画面で見たこと（筆者の記憶による）：'));
  assert.ok(seen, 'ブラウザー対応状況に「画面で見たこと（筆者の記憶による）」の項目が無い');
  assert.ok(seen.includes('画面の超音波帯の破線は、CSVでは確かめられない'));
  assert.ok(seen.includes('22kHzでは記録した版の表示下限（-90dBFS）の下端に張り付いて見えなかった'));
  // CSVで確かめたことの項目に、画面の見え方を混ぜない
  const csvLine = browser.split('\n').find(l => l.startsWith('- 実機のCSVで確かめたこと：'));
  assert.ok(csvLine, 'ブラウザー対応状況に「実機のCSVで確かめたこと」の項目が無い');
  assert.ok(!/破線|画面で/.test(csvLine), 'CSVで確かめたことの項目に、画面の見え方が入っている');
});

// ---- 確かめていないこと・古い記述 ----

// 第2弾c3aで、日英の切り替え（デスクトップのChromiumでだけ確かめた）を足した。
// 第2弾c1bの点検で、開発の段階名（第2弾c0・第2弾c3a）を、機能の名前と確かめた版との前後の書き方に直した
const UNVERIFIED = ['Android', '画面ロック中・バックグラウンド', '長時間の記録', 'ほかのiPhone',
  '実機テストの版（`090648f`）より後に入れた画面（表示下限の既定-110dBFS・超音波帯の現在値・ボタンの配置）',
  '日英の切り替え（デスクトップのChromiumでだけ確かめた）'];

test('実機で確かめていないことを、実機テストの節とブラウザー対応状況の両方に書いている', () => {
  const list = section(realDoc, '## 実機で確かめていないこと');
  const browser = section(readme, '### ブラウザー対応状況');
  const notYet = browser.split('\n').find(l => l.startsWith('- 確かめていないこと：'));
  assert.ok(notYet, 'ブラウザー対応状況に「確かめていないこと」の項目が無い');
  for (const s of UNVERIFIED) {
    assert.ok(list.includes(s), `実機テストの節に「${s}」が無い`);
    assert.ok(notYet.includes(s), `ブラウザー対応状況の「確かめていないこと」に「${s}」が無い`);
  }
});

test('READMEとdocs/に、説明の無い開発の段階名（第2弾c0・第2弾c3aなど）を書いていない', () => {
  const m = readmeAndDocs.match(/第\d弾[a-z]\d[a-z]?/);
  assert.equal(m, null, `開発の段階名がある: ${m && m[0]}`);
  // 「第1弾」「第2弾b」も、読む人には説明が無い。確かめた公開版はコミットの番号で示す。
  // 段階ごとに何を入れたかを書く将来案の資料（docs/roadmap.md）だけは、段階の名前を使う
  // README の中で roadmap.md の中身（見出し）を説明する行も、将来案の資料の話なので外す
  const outside = readmeAndDocs.replace(roadmapText, '').split('\n').filter(l => !l.includes('roadmap.md')).join('\n');
  const s = outside.match(/第\d弾[a-z]?/);
  assert.equal(s, null, `将来案の資料の外に段階名がある: ${s && s[0]}`);
});

test('ブラウザー対応状況に、第2弾bを実機で確かめていないという古い記述が残っていない', () => {
  const browser = section(readme, '### ブラウザー対応状況');
  for (const s of [
    '実機ではまだ確かめていません。とくに、FFTを足したことで',
    'iPhoneの実機のCSVではまだ確かめていない',
    '確かめたのは公開版c7b6bad（第2弾aの前）です'
  ]) {
    assert.ok(!browser.includes(s), `古い記述が残っている: ${s}`);
  }
  assert.ok(browser.includes('`090648f`'), '帯域の記録が入った公開版で確かめたことが書かれていない');
  assert.ok(!readmeAndDocs.includes('第2弾の帯域の値で測り直します'), '将来案に「測り直します」が残っている');
});

// ---- Tone Sweep と実機のCSV ----

test('Tone Sweep へのリンクはまだ張らず、公開したら張ることを書いている', () => {
  // 本人の指示（2026-09-29）。単体のツールとして公開したら、ここを「リンクがある」に変える
  assert.ok(readmeAndDocs.includes('Tone Sweep'), 'Tone Sweep に触れていない');
  assert.ok(REAL.includes('後日、単体のツールとして公開する予定で、公開したらここにリンクを張ります'));
  for (const m of readmeAndDocs.matchAll(/\[([^\]]*)\]\(([^)]*)\)/g)) {
    assert.ok(!/tone|sweep/i.test(m[1]) && !/tone|sweep/i.test(m[2]), `Tone Sweep へのリンクがある: ${m[0]}`);
  }
  // Markdownのリンクだけでなく、HTMLの<a>と、GitHubがリンクにするむき出しのURLも見る（第2弾c1の点検で追加）
  assert.ok(!/href="[^"]*(tone|sweep)/i.test(readmeAndDocs), 'HTMLの<a>で Tone Sweep へのリンクがある');
  assert.ok(!/https?:\/\/\S*(tone|sweep)/i.test(readmeAndDocs), 'Tone Sweep のURLがある');
  assert.ok(!readmeAndDocs.includes('tone_sweep.html'), '内部のページのファイル名が残っている');
});

test('実機のCSVをリポジトリーに入れていない', () => {
  const SKIP = new Set(['.git', 'node_modules', '.claude']);
  const walk = (dir, out) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs, out); else out.push(path.relative(root, abs).split(path.sep).join('/'));
    }
    return out;
  };
  const files = walk(root, []);
  // 実機の記録は、リポジトリーの外で realdevice/iphone18pm_*.csv の名前で保管している
  for (const f of files) assert.ok(!/iphone|realdevice\//i.test(f), `実機の記録らしいファイルがある: ${f}`);
  assert.deepEqual(files.filter(f => f.endsWith('.csv')), ['test/fixtures/sample_v2.csv'], 'CSVが増えている');
  // 実機の記録の行をREADMEに貼っていない。載せてよいのは数値だけ。
  // 時刻では見分けない（実機のv2のCSVはUTCの20時台で、05時台・06時台だけを見ていた。第2弾c1の点検で直した）。
  // データ行の形（timestamp,dbfs,seq,…）の行が、見本CSV（# format=mic-gain-logger/3 のブロック）の4行のほかに無いことを見る
  const ROW = /^\d{4}-\d\d-\d\dT[\d:.]+Z,[^,]*,\d+,/;
  const sample = readmeAndDocs.match(/```\n(# format=mic-gain-logger\/3\n[\s\S]*?)```/)[1];
  const allowed = new Set(sample.split('\n').filter(l => ROW.test(l)));
  assert.equal(allowed.size, 4, '見本CSVのデータ行が4行でない');
  for (const l of readmeAndDocs.split('\n').filter(x => ROW.test(x))) {
    assert.ok(allowed.has(l), `見本CSVにない行がREADMEにある: ${l}`);
  }
});
