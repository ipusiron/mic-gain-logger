'use strict';

// サンプルピーク・クリップ数・有効サンプル率を画面へ出すことの検証。
//
// この3つは段階1から区間レコードに入っていて CSV にも書いていたのに、
// 画面ではひとつも使っていなかった。追加の計測をせずに、記録の信用に
// 直結する情報が手に入る状態だったということである。
//
//   ピーク       統計の項目にする（区間のサンプルピークの最大。第2弾a5で「真のピーク」から改名）
//   クリップ     注意書きにする。クリップした区間は波形が ±1.0 で頭打ちになり、
//                そこで生まれた高調波が広い帯域へ散るので、その区間の値は読めない
//   有効サンプル率 注意書きにする（1.0 を下回った区間＝欠測のあった区間）
//
// ⚠ ボタンは増やさない（style.css の 480px 分岐と handleMobileButtonLayout が
//    壊れやすいため）。統計欄の項目と、既存の状態表示（#recordNotice）に載せる。
//    第2弾c0で「その他」（#moreBtn）を1つ足した（設計書§3のQ3、本人の決定）。同時に
//    handleMobileButtonLayoutは廃止し、並びはstyle.cssだけで決めるようにした（test/mobile-view.test.js）

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  createStats, addStatsRecord, formatStats, statsWarnings, statsIntegrity,
  emptyStatsText, buildIntervalRecord, buildFallbackRecord
} = require('../logic.js');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'script.js'), 'utf8');

const SR = 48000;
const ANCHOR = { epoch: 0, audioTime: 0, wallMs: Date.UTC(2026, 8, 29, 0, 0, 0) };

// over で peak / clip / count を差し替えられる1区間（既定は 1 秒・-20 dBFS・欠測なし）
function recordOf(seq, over) {
  const rms = 0.1;   // -20 dBFS
  const msg = Object.assign({
    type: 'interval',
    seq,
    sampleRate: SR,
    startFrame: seq * SR,
    endFrame: (seq + 1) * SR,
    expected: SR,
    count: SR,
    sumSq: SR * rms * rms,
    peak: rms * Math.SQRT2,
    clip: 0,
    emittedAt: seq + 1
  }, over);
  return buildIntervalRecord(msg, ANCHOR, -60);
}

function statsOf(recs) {
  const stats = createStats();
  for (const r of recs) addStatsRecord(stats, r);
  return stats;
}

// ---- ピーク ----

test('ピーク: 区間のサンプルピークの最大を統計に出す（RMS の最大とは別の値）', () => {
  // 3区間とも RMS は -20 dBFS。2つめだけ瞬間的に大きい
  const recs = [
    recordOf(0, { peak: 0.1 * Math.SQRT2 }),   // -17.0 dBFS
    recordOf(1, { peak: 0.5 }),                // -6.0 dBFS
    recordOf(2, { peak: 0.1 * Math.SQRT2 })
  ];
  const text = formatStats(statsOf(recs), recs.length);
  assert.equal(text.max, '-20.0 dBFS', 'RMS の最大が動いている');
  assert.equal(text.peak, '-6.0 dBFS');
  // ピークは必ず RMS 以上である（同じ区間の中で）
  assert.ok(statsOf(recs).peakMaxDb > statsOf(recs).maxDb);
});

test('ピーク: 0 dBFS（フルスケール）まで出る', () => {
  const text = formatStats(statsOf([recordOf(0, { peak: 1 })]), 1);
  assert.equal(text.peak, '0.0 dBFS');
});

test('ピーク: 無音だけなら -∞。簡易モードでは「不明」のまま', () => {
  const silent = statsOf([recordOf(0, { sumSq: 0, peak: 0 })]);
  assert.equal(formatStats(silent, 1).peak, '-∞ dBFS');

  // 簡易モードは瞬時値しか無いので peakDb が null で来る
  const fb = buildFallbackRecord({
    seq: 0, db: -20, floorDb: -60,
    startTime: 0, endTime: 1,
    startWallMs: ANCHOR.wallMs, endWallMs: ANCHOR.wallMs + 1000,
    expectedSamples: SR
  });
  assert.equal(fb.peakDb, null);
  const stats = statsOf([fb]);
  assert.equal(stats.peakKnownN, 0);
  assert.equal(formatStats(stats, 1).peak, '--.- dBFS', '測れないのに値を出している');
  assert.equal(emptyStatsText().peak, '--.- dBFS');
});

// ---- クリップ ----

test('クリップ: 1区間でもあれば注意書きを出し、区間の数と延べサンプル数を言う', () => {
  const recs = [
    recordOf(0),
    recordOf(1, { peak: 1, clip: 12 }),
    recordOf(2),
    recordOf(3, { peak: 1, clip: 5 })
  ];
  const warns = statsWarnings(statsOf(recs));
  assert.equal(warns.length, 1);
  assert.match(warns[0], /クリップを2区間で検出/);
  assert.match(warns[0], /延べ17サンプル/);
  // 第2弾a5 から、延べの数には分母（記録した全サンプルに対する割合）を添える。
  // ⚠ 以前はここで「その区間の値は読めません」と言い切ることを求めていたが、
  //    1サンプルの単発まで同じ文で言うのは言い過ぎだった。単発と連続の言い分けは
  //    test/clip-notice.test.js が縛る
  assert.match(warns[0], /記録した全サンプルの/);
});

test('クリップ: 無ければ何も出さない', () => {
  assert.deepEqual(statsWarnings(statsOf([recordOf(0), recordOf(1)])), []);
  assert.deepEqual(statsWarnings(createStats()), []);
  assert.deepEqual(statsWarnings(null), []);
});

// ---- 有効サンプル率 ----

test('有効サンプル率: 1.0 を下回った区間があれば、件数と最小値を出す', () => {
  const recs = [
    recordOf(0),                          // 48000/48000 = 1.0
    recordOf(1, { count: SR - 128 }),     // 0.99733…
    recordOf(2, { count: SR / 2 })        // 0.5
  ];
  const stats = statsOf(recs);
  assert.equal(stats.validKnownN, 3);
  assert.equal(stats.lowValidRows, 2);
  assert.equal(stats.minValidRatio, 0.5);
  const warns = statsWarnings(stats);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /1\.0を下回った区間が2件/);
  assert.match(warns[0], /最小 50\.0%/);
  assert.match(warns[0], /valid_ratio/, 'CSV のどの列を見ればよいか書いていない');
});

test('有効サンプル率: ちょうど 1.0 の区間は数えない', () => {
  const stats = statsOf([recordOf(0), recordOf(1), recordOf(2)]);
  assert.equal(stats.lowValidRows, 0);
  assert.equal(stats.minValidRatio, 1);
  assert.deepEqual(statsWarnings(stats), []);
});

test('有効サンプル率: 簡易モードは「不明」として数に入れない', () => {
  const fb = buildFallbackRecord({
    seq: 0, db: -20, floorDb: -60,
    startTime: 0, endTime: 1,
    startWallMs: ANCHOR.wallMs, endWallMs: ANCHOR.wallMs + 1000,
    expectedSamples: SR
  });
  assert.equal(fb.validRatio, null);
  const stats = statsOf([fb]);
  assert.equal(stats.validKnownN, 0);
  assert.equal(stats.lowValidRows, 0);
  assert.deepEqual(statsWarnings(stats), [], '測れないのに欠測だと言っている');
});

test('クリップと欠測が同時にあれば2件出る', () => {
  const recs = [recordOf(0, { peak: 1, clip: 3, count: SR - 1 })];
  assert.equal(statsWarnings(statsOf(recs)).length, 2);
});

// ---- 画面との結線 ----

test('画面: 統計欄にピークの枠があり、script.js が書き込んでいる', () => {
  assert.match(html, /id="peakDb"/, 'index.html にピークの枠が無い');
  // 第2弾c3aで見出しに辞書のキー（data-i18n）を付けたので、属性を許して見る
  assert.match(html, /<div class="stat-label"[^>]*>サンプルピーク<\/div>/);
  assert.match(script, /peakEl\.textContent = text\.peak/, 'script.js がピークを書いていない');
  // ピークの枠には「RMS とは別物である」ことの説明を付ける
  const m = html.match(/<div class="stat"[^>]*\stitle="([^"]*)"[^>]*>\s*<div class="stat-label"[^>]*>サンプルピーク/);
  assert.ok(m, 'ピークの枠に title が無い');
  assert.match(m[1], /RMS/);
});

test('画面: クリップと欠測は既存の状態表示へ出す（ボタンを増やさない）', () => {
  // ⚠ 3つ目のボタンをhandleMobileButtonLayoutへ乗せない、という約束があった。
  //    第2弾c0で、本人の決定（設計書§3のQ3）により「その他」（moreBtn）だけを足した。
  //    handleMobileButtonLayoutは同時に廃止した。ボタンを足すときは、本人の決定を経てここを直す
  //    第2弾c3aで、表示の言語の切り替え（langToggle）を足した（日英対応はシリーズの必須項目。TEMPLATE ④）。
  //    .actionsの行には入れず、ヘッダーの右上に置いた（幅480px以下の1行を崩さないため。test/i18n.test.js）
  const ids = [...html.matchAll(/<button[^>]*id="([^"]+)"/g)].map(m => m[1]).sort();
  assert.deepEqual(ids, [
    'controlsToggle', 'exportBtn', 'helpBtn', 'langToggle', 'moreBtn', 'resetBtn',
    'startBtn', 'stopBtn', 'themeToggle'
  ]);
  // 注意書きは #recordNotice にまとめる
  // 第2弾a7 から、項目は logic.js の recordNoticeItems で作る。統計の注意が入ることを振る舞いで確かめる
  const { recordNoticeItems } = require('../logic.js');
  const items = recordNoticeItems({ stats: statsOf([recordOf(0, { peak: 1, clip: 3 })]) });
  assert.ok(items.some(it => /クリップを1区間で検出/.test(it.full)),
    '注意書きの項目に統計の注意が入っていない');
  assert.match(script, /recordNoticeItems\(\{[^}]*stats[^}]*\}\)/,
    'renderRecordNotice が統計を渡していない');
  // 出たその区間で画面へ出す（停止まで待たない）
  const upd = script.slice(script.indexOf('function updateStats'), script.indexOf('function resetStats'));
  assert.match(upd, /renderRecordNotice\(\)/, 'updateStats が注意書きを更新していない');
  // 統計リセットで注意書きも消す（統計と同じ母集団から出ているため）
  const reset = script.slice(script.indexOf('function resetStats'), script.indexOf('function setStatus'));
  assert.match(reset, /statsNoticeText = ''/);
  assert.match(reset, /renderRecordNotice\(\)/);
});

test('画面: 注意書きは件数ではなく文字列で比べて組み直す', () => {
  // ⚠ 件数で比べると、クリップした区間が2つ目・3つ目と増えても警告は1本のまま
  //    なので、画面が最初の「1区間」で止まる。ブラウザーの実測で、4区間
  //    クリップしているのに「クリップを1区間で検出しました」と出た
  const upd = script.slice(script.indexOf('function updateStats'), script.indexOf('function resetStats'));
  assert.ok(!/statsWarnings\(stats\)\.length/.test(upd), '注意書きを件数で比べている');
  // 第2弾c3aから、画面の言語（lang）で組み立てる
  assert.match(upd, /statsWarnings\(stats, lang\)\.join\(/, '注意書きを文字列にしていない');

  // 区間が増えても警告は1本のまま。文字列だけが変わる
  const one = statsOf([recordOf(0, { peak: 1, clip: 7 })]);
  const two = statsOf([recordOf(0, { peak: 1, clip: 7 }), recordOf(1, { peak: 1, clip: 7 })]);
  assert.equal(statsWarnings(one).length, 1);
  assert.equal(statsWarnings(two).length, 1);
  assert.notEqual(statsWarnings(one).join('\n'), statsWarnings(two).join('\n'),
    '区間が増えても文字列が変わらない');
  assert.match(statsWarnings(two)[0], /クリップを2区間で検出/);
});

test('画面: クレストファクターは出さない（第3弾の診断へ回す）', () => {
  // 判断の記録。ピーク − Leq は計算できるが、
  //   1. セッション全体の最大ピークと全体の Leq の差は、音響で言うクレストファクター
  //      （区間ごとのピーク／RMS 比）ではない。3時間の記録では「いちばん大きかった
  //      一発が全体平均より何dB上か」になり、衝撃音と定常音の切り分けにはならない
  //   2. 区間ごとの分布を持たせれば正しく出せるが、それは新しい計算であり、
  //      検出・診断は第3弾の範囲である
  // ので、この弾では出さない。出すときは項目名を「クレストファクター」にせず、
  // 区間ごとの値の分布から作ること
  assert.ok(!html.includes('クレストファクター'), 'クレストファクターの枠が増えている');
  assert.ok(!('crest' in emptyStatsText()), '統計にクレストファクターが入っている');
});


// ---- 記録の穴の有無を、両側で出す ----
//
// ⚠⚠ statsWarnings は「悪いときだけ」出る片側表示だった。記録がきれいなときは
//    画面に何も出ないので、利用者は「穴が無い」と「まだ調べていない」を
//    区別できない。「欠測のない記録」を名乗る道具として、これは足りない。
//    穴の有無を必ず1行で言い切る（statsIntegrity）。

function fallbackOf(seq) {
  return buildFallbackRecord({
    seq, db: -20, floorDb: -60,
    startTime: seq, endTime: seq + 1,
    startWallMs: ANCHOR.wallMs + seq * 1000,
    endWallMs: ANCHOR.wallMs + (seq + 1) * 1000,
    expectedSamples: SR, intervalSec: 1,
    clockEpoch: 0, clockBreak: null, meta: { id: 's1' }
  });
}

test('穴の有無: 記録がまだ無ければ何も出さない', () => {
  const v = statsIntegrity(createStats());
  assert.equal(v.level, 'none');
  assert.equal(v.text, '');
  // null を渡しても落ちない（リセット直後の経路）
  assert.equal(statsIntegrity(null).level, 'none');
});

test('⭐穴の有無: きれいな記録では「穴なし」と肯定的に出す', () => {
  const stats = statsOf([recordOf(0), recordOf(1), recordOf(2)]);
  const v = statsIntegrity(stats);
  assert.equal(v.level, 'ok');
  assert.match(v.text, /記録の穴なし/);
  // 何区間ぶんを確かめたのかを出す（「0件」だけでは調べた範囲が分からない）
  assert.match(v.text, /クリップ0区間/);
  assert.match(v.text, /有効サンプル率は3区間すべて1\.000/);
  // ⚠ 警告のほうは空のまま（両者の役割を混ぜない）
  assert.deepEqual(statsWarnings(stats), []);
});

test('⭐穴の有無: クリップがあっても、欠測が無いほうは肯定的に言い切る', () => {
  // ⚠ 実測（疑似マイク・5区間）でクリップ5区間・欠測0区間の記録が出た。
  //    改修前はここで「有効サンプル率が1.000未満の区間0件・最小1.000」と出していて、
  //    穴が無いのに穴があるように読めた。2つの観点は別々に言う
  const v = statsIntegrity(statsOf([recordOf(0, { clip: 3 }), recordOf(1, { clip: 12 })]));
  assert.equal(v.level, 'warn');
  assert.match(v.text, /記録に穴あり/);
  assert.match(v.text, /クリップ2区間/);
  assert.match(v.text, /有効サンプル率は2区間すべて1\.000/);
  assert.ok(!/1\.000未満の区間0件/.test(v.text), `穴が無いのに件数を出している: ${v.text}`);
});

test('穴の有無: クリップが無く欠測だけなら、クリップ側を0区間と言い切る', () => {
  const v = statsIntegrity(statsOf([
    recordOf(0),
    recordOf(1, { count: Math.round(SR * 0.5) })
  ]));
  assert.equal(v.level, 'warn');
  assert.match(v.text, /クリップ0区間/);
  assert.match(v.text, /有効サンプル率が1\.000未満の区間1件・最小0\.500/);
});

test('穴の有無: 欠測があれば件数と最小の率を出す', () => {
  const v = statsIntegrity(statsOf([
    recordOf(0),
    recordOf(1, { count: Math.round(SR * 0.979) })
  ]));
  assert.equal(v.level, 'warn');
  assert.match(v.text, /有効サンプル率が1\.000未満の区間1件・最小0\.979/);
});

test('穴の有無: 簡易モードだけの記録は「確かめられません」と出す', () => {
  // ⚠ 測れないことを「異常なし」として出さない
  const v = statsIntegrity(statsOf([fallbackOf(0), fallbackOf(1)]));
  assert.equal(v.level, 'unknown');
  assert.match(v.text, /確かめられません/);
  assert.match(v.text, /簡易モードの2区間/);
});

test('穴の有無: モードが混ざったら、測れない区間の数を添える', () => {
  const v = statsIntegrity(statsOf([recordOf(0), recordOf(1), fallbackOf(2)]));
  assert.equal(v.level, 'ok');
  assert.match(v.text, /有効サンプル率は2区間すべて1\.000/);
  assert.match(v.text, /簡易モードの1区間は測れません/);
});

test('穴の有無: 画面に出す場所と配線がある', () => {
  assert.match(html, /id="integrityNote"/, '穴の有無を出す要素が無い');
  // ⚠ ボタンは増やさない（style.cssの480px分岐が壊れやすい）。
  //    第2弾c0で「その他」の1つだけ足した（本人の決定。上の「ボタンを増やさない」のテストを参照）
  //    第2弾c3aで言語の切り替え（langToggle）を足した（ヘッダーの右上。.actionsの行には入れていない）
  const buttons = (html.match(/<button/g) || []).length;
  assert.equal(buttons, 15, `ボタンの数が変わっている: ${buttons}`);
  assert.match(script, /statsIntegrity\(stats, lang\)/, 'script.js が穴の有無を出していない');
  assert.match(script, /renderIntegrity\(\)/, '穴の有無を出し直す関数が無い');
  // 行が増えるたびに出し直す（0区間→1区間で文言が変わる）
  const upd = script.slice(script.indexOf('function updateStats'));
  assert.match(upd.slice(0, upd.indexOf('\n  }')), /renderIntegrity\(\)/,
    '行が増えたときに出し直していない');
  // リセットでも消す
  const rst = script.slice(script.indexOf('function resetStats'));
  assert.match(rst.slice(0, rst.indexOf('\n  }')), /renderIntegrity\(\)/,
    'リセットで消していない');
});

test('穴の有無: 色は既存のトークンだけを使う（コントラスト検査の範囲に収める）', () => {
  const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
  const block = css.slice(css.indexOf('.integrity-note{'));
  const head = block.slice(0, block.indexOf('.stats-grid'));
  assert.ok(head.includes('.integrity-note:empty{display:none}'), '空のとき隠していない');
  for (const m of head.matchAll(/color:\s*([^;}]+)/g)) {
    assert.match(m[1].trim(), /^var\(--(muted|ok|warn|err)\)$/, `生の色が入っている: ${m[1]}`);
  }
});
