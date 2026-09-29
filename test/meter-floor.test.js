// メーターの目盛りと、表示下限の既定値（第2弾a6）。
//
// ⚠⚠ 目盛り（-60 / -40 / -20 / 0）は、公開前から一度も画面に出ていなかった。
//    .meter-scale が overflow:hidden・高さ20px の .meter の子で、下へ押し出されて
//    切られていた（実測で見えている高さ0px）。公開済みのスクリーンショットにも写っていない。
//    overflow を外すだけだと「設定を表示」ボタンに12px重なるので、.meter の外へ出す。
// ⚠⚠ 表示下限の既定（-60dBFS）が高すぎた。iPhone の実機テスト（2026-09-29）で、
//    21kHz のトーン（-65dBFS）が静寂（-76dBFS）と同じく -60 に張り付いて表示され、
//    本人は「反応がない」と読んだ。CSVには正しく残っていた。既定を -90 にする
//    （本人の判断）。目盛りも表示下限に合わせて動かす（固定の -60 のままだと嘘になる）。
// ⚠⚠ 第2弾c0：帯域を計算するとき（?bands=offでないとき）の既定を-110にした（b4の結果を受けた本人の決定）。
//    静かな部屋の超音波帯は-93〜-107dBFS（行の中央値）で、-90より下にあり、超音波帯の破線がいつも下端に張り付いていた。
//    ?bands=offのときは従来の-90のまま。決め方はlogic.jsのfloorDbDefaultFor。
//    -110でも、メーターの目盛りとグラフの縦軸の目盛りが重ならず、小数が出ないことを確かめる。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  parseFloorDb, dbToPercent, meterScaleLabels, FLOOR_DB_DEFAULT, FLOOR_DB_DEFAULT_BANDS, FLOOR_DB_MIN, FLOOR_DB_MAX,
  floorDbDefaultFor, bandsEnabledFromQuery, graphArea, dbToY, dbTicks, dbTickStep, GRAPH_TOP_DB
} = require('../logic.js');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'script.js'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

test('⭐目盛りは .meter の外（兄弟）に置く', () => {
  assert.match(html,
    /<div class="meter"[^>]*>\s*<div class="meter-bar" id="meterBar"><\/div>\s*<\/div>\s*(?:<!--[\s\S]*?-->\s*)?<div class="meter-scale"/,
    '.meter-scale が .meter の中にある（overflow:hidden で切られる）');
});

test('⭐表示下限の既定は、帯域ありで-110、?bands=offで-90 dBFS（logic.jsのfloorDbDefaultForで決める。第2弾c0）', () => {
  assert.equal(FLOOR_DB_DEFAULT, -90);          // ?bands=off（第2弾a6からの値）
  assert.equal(FLOOR_DB_DEFAULT_BANDS, -110);   // 帯域を計算するとき（第2弾c0）
  // ページのURLから決める（bandsEnabledFromQueryと同じ判定）
  assert.equal(floorDbDefaultFor(bandsEnabledFromQuery('')), FLOOR_DB_DEFAULT_BANDS);
  assert.equal(floorDbDefaultFor(bandsEnabledFromQuery('?bands=on')), FLOOR_DB_DEFAULT_BANDS);
  assert.equal(floorDbDefaultFor(bandsEnabledFromQuery('?bands=off')), FLOOR_DB_DEFAULT);
  assert.equal(floorDbDefaultFor(bandsEnabledFromQuery('?bands=OFF')), FLOOR_DB_DEFAULT);
  // どちらの既定も、入力欄で選べる範囲の中にある
  for (const d of [FLOOR_DB_DEFAULT, FLOOR_DB_DEFAULT_BANDS]) {
    assert.ok(d >= FLOOR_DB_MIN && d <= FLOOR_DB_MAX, `${d}が範囲の外`);
  }
  // 空欄・非数は、渡した既定へ戻す（渡さなければ従来の-90）
  assert.equal(parseFloorDb('', FLOOR_DB_DEFAULT_BANDS), FLOOR_DB_DEFAULT_BANDS);
  assert.equal(parseFloorDb('abc', FLOOR_DB_DEFAULT_BANDS), FLOOR_DB_DEFAULT_BANDS);
  assert.equal(parseFloorDb('', FLOOR_DB_DEFAULT), FLOOR_DB_DEFAULT);
  assert.equal(parseFloorDb(''), FLOOR_DB_DEFAULT);
  // 範囲の外の既定を渡しても、範囲へ丸める
  assert.equal(parseFloorDb('', -500), FLOOR_DB_MIN);
  // 「通常-60〜-40」の案内は、既定を下げたので残さない
  assert.doesNotMatch(html, /通常-60〜-40/);
});

test('利用者が入れた値は、既定によらずそのまま使う（表示専用の設定で、範囲の丸めだけ）', () => {
  for (const raw of ['-70', '-40.5', '-120', '-1', '-200', '5']) {
    assert.equal(parseFloorDb(raw, FLOOR_DB_DEFAULT_BANDS), parseFloorDb(raw, FLOOR_DB_DEFAULT), raw);
    assert.equal(parseFloorDb(raw, FLOOR_DB_DEFAULT_BANDS), parseFloorDb(raw), raw);
  }
});

test('HTMLの既定は帯域ありの値で、?bands=offのときはscript.jsがdefaultValueを書き換える', () => {
  const input = html.match(/<input[^>]*id="floorDb"[^>]*>/);
  assert.ok(input);
  assert.match(input[0], new RegExp(`value="${FLOOR_DB_DEFAULT_BANDS}"`));
  // titleも実態（-110／?bands=offは-90）に合わせる
  assert.ok(input[0].includes(`既定${FLOOR_DB_DEFAULT_BANDS}dBFS`), 'titleの既定が-110でない');
  assert.ok(input[0].includes(`?bands=offで開いたときは${FLOOR_DB_DEFAULT}dBFS`), 'titleに?bands=offの既定が無い');
  assert.doesNotMatch(input[0], /既定-90dBFS。静かな部屋/);
  // script.js：既定はlogic.jsで決め、空欄のときの戻り先と入力欄の初期値の両方に使う
  assert.match(script, /const floorDbDefault = floorDbDefaultFor\(bandsOnPage\);/);
  assert.match(script, /return parseFloorDb\(floorDbInput\.value, floorDbDefault\);/);
  // ⚠ valueではなくdefaultValueを書き換える（ブラウザーが復元した利用者の値を上書きしない）。目盛りを描く前に入れる
  const init = script.slice(script.indexOf('\n  // 初期\n'));
  const set = init.indexOf('floorDbInput.defaultValue = String(floorDbDefault);');
  assert.ok(set > 0 && set < init.indexOf('renderMeterScale()'), '目盛りを描く前に既定を入れていない');
  assert.doesNotMatch(script, /floorDbInput\.value\s*=/);
  // 目盛りの初期の数字も、帯域ありの既定から作ったもの（読み込み直後に数字が変わらない）
  const scale = html.match(/<div class="meter-scale"[^>]*>([\s\S]*?)<\/div>/)[1];
  const spans = [...scale.matchAll(/<span>([^<]*)<\/span>/g)].map(m => m[1]);
  assert.deepEqual(spans, meterScaleLabels(FLOOR_DB_DEFAULT_BANDS));
});

// 目盛りのラベルが重ならないか。
// メーター：ラベルは幅の0・1/3・2/3・1の位置に、左寄せ・中央・中央・右寄せで置く（style.cssの.meter-scale）。
//   1文字の幅を多めに見積もって1em（12px。.meter-scaleのfont-size）とし、それでも隣と重ならないかを見る
// グラフ：ラベルは目盛りのyを中心に描く（script.jsのdrawSeries。textBaseline='middle'）。
//   隣の目盛りとの間隔が、文字の大きさ（幅360px未満で9px、それ以外で10px）＋2px以上あるかを見る
const METER_FONT_PX = 12;
// 幅320pxの画面でのメーターの幅＝320 − .containerの左右の余白（12px×2）− .cardの左右の余白（12px×2）− 枠（1px×2）
const METER_W_MIN = 320 - 12 * 2 - 12 * 2 - 1 * 2;

function meterLabelBoxes(labels, width) {
  const w = labels.map(t => t.length * METER_FONT_PX);
  return [
    [0, w[0]],
    [width / 3 - w[1] / 2, width / 3 + w[1] / 2],
    [width * 2 / 3 - w[2] / 2, width * 2 / 3 + w[2] / 2],
    [width - w[3], width]
  ];
}

test('⭐表示下限-110でも、メーターの目盛りは重ならず、小数が出ない（第2弾c0）', () => {
  // 見積もりの前提（余白と文字の大きさ）がstyle.cssと合っている
  const flat = css.replace(/\s+/g, ' ');
  assert.match(flat, /\.meter-scale\{[^}]*font-size:12px/);
  assert.match(flat, /@media \(max-width: 480px\) \{ \.container \{ padding: 0 12px 20px; \}/);
  assert.match(flat, /@media \(max-width: 480px\) \{[^@]*\.card \{ padding: 12px;/);
  for (const floor of [FLOOR_DB_DEFAULT_BANDS, FLOOR_DB_DEFAULT]) {
    const labels = meterScaleLabels(floor);
    for (const t of labels) assert.match(t, /^-?\d+$/, `下限${floor}の目盛り${t}に小数が出ている`);
    // 位置の換算はメーターの幅と同じ（式から出す）
    assert.deepEqual(labels, [floor, floor * 2 / 3, floor / 3, 0].map(v => String(Math.round(v) || 0)));
    const boxes = meterLabelBoxes(labels, METER_W_MIN);
    for (let i = 1; i < boxes.length; i++) {
      assert.ok(boxes[i - 1][1] + 4 <= boxes[i][0],
        `下限${floor}・幅${METER_W_MIN}px：${labels[i - 1]}と${labels[i]}が重なる（${boxes[i - 1][1]} > ${boxes[i][0]}）`);
    }
  }
});

test('⭐表示下限-110でも、グラフの縦軸の目盛りは重ならず、小数が出ない（第2弾c0）', () => {
  // スマートフォン幅（高さ120px）とそれ以外（220px）。幅は360px未満と以上の両方
  const heights = [120, 220];
  const widths = [296, 351, 406, 800];
  for (const floor of [FLOOR_DB_DEFAULT_BANDS, FLOOR_DB_DEFAULT]) {
    const ticks = dbTicks(floor, GRAPH_TOP_DB, dbTickStep(GRAPH_TOP_DB - floor));
    for (const t of ticks) assert.match(t.label, /^-?\d+$/, `下限${floor}の目盛り${t.label}に小数が出ている`);
    assert.equal(ticks[0].db, GRAPH_TOP_DB, '上端が0 dBFSでない');
    assert.equal(ticks[ticks.length - 1].db, floor, '下端が表示下限でない');
    for (const h of heights) {
      for (const w of widths) {
        const area = graphArea(w, h);
        const fontPx = w < 360 ? 9 : 10;
        const ys = ticks.map(t => dbToY(t.db, floor, GRAPH_TOP_DB, area));
        for (let i = 1; i < ys.length; i++) {
          assert.ok(ys[i] - ys[i - 1] >= fontPx + 2,
            `下限${floor}・${w}×${h}：${ticks[i - 1].label}と${ticks[i].label}の間隔が${(ys[i] - ys[i - 1]).toFixed(1)}px`);
        }
      }
    }
  }
});

test('目盛りは表示下限から作る（4本、下限と0を含む）', () => {
  assert.deepEqual(meterScaleLabels(-90), ['-90', '-60', '-30', '0']);
  assert.deepEqual(meterScaleLabels(-60), ['-60', '-40', '-20', '0']);
  assert.deepEqual(meterScaleLabels(-45), ['-45', '-30', '-15', '0']);
  // 割り切れない下限は丸める
  assert.deepEqual(meterScaleLabels(-50), ['-50', '-33', '-17', '0']);
});

test('目盛りの位置とメーターの幅が同じ換算を使う', () => {
  // 目盛りは space-between で等間隔に並ぶ。メーターの幅も下限〜0を0〜100%に写すので、
  // 2本目（下限の2/3）は 1/3 の位置、3本目は 2/3 の位置に来る
  assert.equal(Math.round(dbToPercent(-60, -90)), 33);
  assert.equal(Math.round(dbToPercent(-30, -90)), 67);
});

test('script.js は表示下限が変わるたびに目盛りとメーターの説明を描き直す', () => {
  assert.match(script, /function renderMeterScale\(/);
  const body = script.slice(script.indexOf('function renderMeterScale('));
  const fn = body.slice(0, body.indexOf('\n  }') + 4);
  assert.match(fn, /getFloorDb\(\)/);
  assert.match(fn, /meterScaleLabels\(/);
  // 入力が変わったら描き直す
  assert.match(script, /floorDbInput\.addEventListener\('input',[^)]*renderMeterScale/);
  // 初期化でも1回描く
  const init = script.slice(script.indexOf('\n  // 初期\n'));
  assert.match(init, /renderMeterScale\(\)/);
});

test('メーターの説明に -60 を決め打ちしない', () => {
  const meter = html.match(/<div class="meter"[^>]*>/);
  assert.ok(meter);
  assert.doesNotMatch(meter[0], /-60dBFS/);
});

test('READMEとヘルプも、既定の表示下限を-110（?bands=offは-90）と書いている', () => {
  assert.ok(readme.includes(`表示下限（既定${FLOOR_DB_DEFAULT_BANDS}dBFS。\`?bands=off\`では${FLOOR_DB_DEFAULT}dBFS）`),
    'READMEのトラブルシューティングの既定が古い');
  assert.doesNotMatch(readme, /表示下限（既定-90dBFS）/);
  assert.doesNotMatch(readme, /表示下限（既定-60dBFS）/);
  const at = html.indexOf('<strong>表示下限：</strong>');
  const help = html.slice(at, html.indexOf('</li>', at));
  assert.ok(help.includes(`既定は${FLOOR_DB_DEFAULT_BANDS}dBFS`), 'ヘルプの既定が-110でない');
  assert.ok(help.includes(`?bands=off</code>で開いたときは${FLOOR_DB_DEFAULT}dBFS`), 'ヘルプに?bands=offの既定が無い');
  assert.doesNotMatch(help, /既定-90dBFS/);
});

test('表示下限の入力欄は、ブラウザーに値を戻させない（戻る操作で目盛りと食い違わない。第2弾c0）', () => {
  // ⚠ 公開前の最終確認で見つかった（第2弾c0。改修前から）。表示下限を変えてほかのページへ移り、
  //    「戻る」で開き直すと、Chromium はスクリプトが目盛りを描いたあとで入力欄の値だけを戻していた。
  //    入力欄は -100、目盛りと title は既定のまま、という食い違いが出た。値を戻させず、既定から始める
  const m = html.match(/<input[^>]*id="floorDb"[^>]*>/);
  assert.ok(m, '#floorDb が無い');
  assert.match(m[0], /autocomplete="off"/);
});
