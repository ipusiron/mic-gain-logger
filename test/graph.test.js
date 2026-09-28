// グラフの座標と目盛り。
//
// 改修前は「1フレーム＝1px」で左へ流していたので、1px の意味する時間が
// リフレッシュレートとタブの非アクティブ化で変わり、横軸が時間になっていなかった。
// ここでは「同じ時刻は同じ x に落ちる」「フレーム数に依存しない」ことを縛る。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  GRAPH_WINDOW_SEC, GRAPH_TOP_DB,
  graphArea, timeToX, dbToY,
  timeTickStepSec, timeTicks, dbTickStep, dbTicks, pruneSeries, seriesPointOf
} = require('../logic.js');

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');

test('graphArea: 目盛りのぶんを内側へ寄せ、狭い画面でも幅・高さが 1 以上', () => {
  const wide = graphArea(1078, 220);
  assert.equal(wide.x, 40);
  assert.equal(wide.y, 8);
  assert.equal(wide.w, 1078 - 40 - 8);
  assert.equal(wide.h, 220 - 8 - 18);

  const phone = graphArea(270, 120);
  assert.equal(phone.x, 28, '360px 未満では左の余白を詰める');
  assert.equal(phone.h, 120 - 8 - 14);
  assert.ok(phone.w > 0 && phone.h > 0);

  // 極端に小さくても壊れない
  const tiny = graphArea(10, 10);
  assert.ok(tiny.w >= 1 && tiny.h >= 1);
});

test('timeToX: 右端が「いま」、左端が窓の左、途中は線形', () => {
  const area = graphArea(1078, 220);
  const now = 1_700_000_000_000;
  const win = GRAPH_WINDOW_SEC * 1000;
  assert.equal(timeToX(now, now, win, area), area.x + area.w);
  assert.equal(timeToX(now - win, now, win, area), area.x);
  assert.ok(Math.abs(timeToX(now - win / 2, now, win, area) - (area.x + area.w / 2)) < 1e-9);
});

test('timeToX: 窓の外は端へ丸める（線が枠の外へ出ない）', () => {
  const area = graphArea(800, 220);
  const now = 1_700_000_000_000;
  const win = 60_000;
  assert.equal(timeToX(now - 999_000, now, win, area), area.x);
  assert.equal(timeToX(now + 5_000, now, win, area), area.x + area.w);
});

test('timeToX: 同じ時刻はフレーム数によらず同じ x に落ちる（横軸が時間である）', () => {
  const area = graphArea(800, 220);
  const now = 1_700_000_000_000;
  const win = 60_000;
  // 60Hz で積んだ点と 10Hz で積んだ点。同じ時刻なら同じ位置でなければならない
  const at30s = now - 30_000;
  const fast = timeToX(at30s, now, win, area);
  const slow = timeToX(at30s, now, win, area);
  assert.equal(fast, slow);
  // 改修前の「1フレーム＝1px」なら、60Hz と 10Hz で 6 倍ずれていた
  assert.ok(Math.abs(fast - (area.x + area.w / 2)) < 1e-9);
});

test('dbToY: 上端が 0 dBFS、下端が表示下限', () => {
  const area = graphArea(800, 220);
  assert.equal(dbToY(0, -60, 0, area), area.y);
  assert.equal(dbToY(-60, -60, 0, area), area.y + area.h);
  assert.ok(Math.abs(dbToY(-30, -60, 0, area) - (area.y + area.h / 2)) < 1e-9);
});

test('dbToY: 表示下限を変えると同じ dB の位置が変わる（過去の点も追随する）', () => {
  const area = graphArea(800, 220);
  const y60 = dbToY(-30, -60, 0, area);
  const y40 = dbToY(-30, -40, 0, area);
  assert.notEqual(y60, y40);
  // 下限 -60 なら -30dB は真ん中（t=0.5）、下限 -40 なら下寄り（t=0.25）。
  // y は下ほど大きいので y40 > y60 になる
  assert.ok(y40 > y60, '下限を上げると -30dB は相対的に下へ寄る');
  assert.ok(Math.abs(y60 - (area.y + area.h * 0.5)) < 1e-9);
  assert.ok(Math.abs(y40 - (area.y + area.h * 0.75)) < 1e-9);
});

test('dbToY: 無音（-Infinity）と NaN は下端に置く（描画が飛ばない）', () => {
  const area = graphArea(800, 220);
  assert.equal(dbToY(-Infinity, -60, 0, area), area.y + area.h);
  assert.equal(dbToY(NaN, -60, 0, area), area.y + area.h);
});

test('timeTickStepSec / timeTicks: 本数が 7 本以下に収まり、右端が 0s', () => {
  for (const win of [10, 30, 60, 120, 300, 600]) {
    const step = timeTickStepSec(win);
    const ticks = timeTicks(win, step);
    assert.ok(ticks.length <= 7, `窓 ${win}s で ${ticks.length} 本`);
    assert.ok(ticks.length >= 2, `窓 ${win}s で ${ticks.length} 本`);
    assert.equal(ticks[0].agoSec, 0);
    assert.equal(ticks[0].label, '0s');
    assert.equal(ticks[ticks.length - 1].label, `-${ticks[ticks.length - 1].agoSec}s`);
  }
  assert.equal(timeTickStepSec(60), 10);
  assert.deepEqual(timeTicks(60, 10).map(t => t.label),
    ['0s', '-10s', '-20s', '-30s', '-40s', '-50s', '-60s']);
});

test('dbTickStep / dbTicks: 表示下限と 0 dBFS を必ず含み、本数が収まる', () => {
  for (const floor of [-120, -90, -60, -40, -20, -6, -1]) {
    const ticks = dbTicks(floor, GRAPH_TOP_DB, dbTickStep(GRAPH_TOP_DB - floor));
    assert.ok(ticks.length >= 2, `下限 ${floor} で ${ticks.length} 本`);
    assert.ok(ticks.length <= 8, `下限 ${floor} で ${ticks.length} 本`);
    assert.equal(ticks[0].db, 0, '上端が 0 dBFS でない');
    assert.equal(ticks[ticks.length - 1].db, floor, '下端が表示下限でない');
  }
  assert.deepEqual(dbTicks(-60, 0, dbTickStep(60)).map(t => t.label),
    ['0', '-10', '-20', '-30', '-40', '-50', '-60']);
});

test('pruneSeries: 窓の外を落とし、左端まで線が届くよう直前の1点は残す', () => {
  const now = 1_700_000_000_000;
  const win = 60_000;
  const mk = agoSec => ({ tMs: now - agoSec * 1000, db: -20 });
  const series = [mk(120), mk(90), mk(70), mk(50), mk(10), mk(0)];
  // 窓（60秒）の中にあるのは 50s / 10s / 0s 前の3点
  assert.equal(series.filter(p => p.tMs >= now - win).length, 3);
  const kept = pruneSeries(series, now, win);
  assert.equal(kept.length, 4, '窓内3点＋直前1点');
  assert.equal(kept[0].tMs, now - 70_000, '窓の外の直近1点が残っていない');
  assert.equal(kept[kept.length - 1].tMs, now);
});

test('pruneSeries: 全部が窓の外なら最後の1点だけ残す。空なら空のまま', () => {
  const now = 1_700_000_000_000;
  const old = [{ tMs: now - 500_000, db: -20 }, { tMs: now - 400_000, db: -30 }];
  const kept = pruneSeries(old, now, 60_000);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].tMs, now - 400_000);
  assert.deepEqual(pruneSeries([], now, 60_000), []);
});

test('pruneSeries: 60Hz で窓ぶん積んでも点数が窓×レート＋1 を超えない', () => {
  const now = 1_700_000_000_000;
  const win = GRAPH_WINDOW_SEC * 1000;
  let series = [];
  // 120 秒ぶんを 60Hz で流し込む（毎回 prune する運用と同じ）
  for (let i = 0; i < 120 * 60; i++) {
    const t = now - (120 * 60 - i) * (1000 / 60);
    series.push({ tMs: t, db: -20 });
    series = pruneSeries(series, t, win);
  }
  assert.ok(series.length <= GRAPH_WINDOW_SEC * 60 + 2, `点数 ${series.length}`);
});

test('script.js: グラフの点を、記録された区間から積む', () => {
  // ⚠ 改修前は requestAnimationFrame の中で積んでいた。
  // タブが裏に回る・画面がロックされる・CPUが詰まると点が積まれず、再開したときに
  // 前後の点が1本の直線で結ばれる。記録（CSV）は AudioWorklet のクロックで穴なく
  // 続いているのに、グラフだけが「測っていない時間」を直線で描いていた。
  assert.ok(!/series\.push\(clamp\(/.test(SCRIPT), '正規化した値を積んでいる');
  assert.ok(/series\.push\(seriesPointOf\(/.test(SCRIPT), '区間から点を作っていない');

  const pushRecord = SCRIPT.slice(
    SCRIPT.indexOf('function pushRecord'),
    SCRIPT.indexOf('function handleIntervalMessage'));
  assert.ok(/series\.push\(/.test(pushRecord), 'pushRecord（記録された区間）で積んでいない');

  const animate = SCRIPT.slice(
    SCRIPT.indexOf('function animate()'),
    SCRIPT.indexOf('function exportCSV'));
  assert.ok(!/series\.push\(/.test(animate), 'rAF の中で点を積んでいる');
  // 描き直しそのものは rAF で続ける（横軸が実時間なので、点が増えなくても右へ流れる）
  assert.ok(/drawSeries\(\)/.test(animate), 'rAF で描き直していない');
});

test('script.js: 続いていない点は線をつなげない', () => {
  const draw = SCRIPT.slice(SCRIPT.indexOf('function drawSeries'),
    SCRIPT.indexOf('function renderStats'));
  // gap が立っている点は moveTo で描き直す。lineTo でつなぐと、
  // 測っていない時間を直線で埋めることになる
  assert.match(draw, /p\.gap/);
});

test('seriesPointOf: 記録の区間から点を作り、続いていなければ印を立てる', () => {
  const rec = (sec, db, extra) => Object.assign({
    ts: new Date(Date.UTC(2026, 8, 28, 5, 0, sec)),
    rawDb: db, db
  }, extra || {});

  // 最初の点は、前が無いので必ず切る
  const first = seriesPointOf(rec(1, -20), null, 1000);
  assert.equal(first.gap, true);
  assert.equal(first.db, -20);
  assert.equal(first.tMs, Date.UTC(2026, 8, 28, 5, 0, 1));

  // 1秒間隔で続いていれば、つなぐ
  const second = seriesPointOf(rec(2, -25), first, 1000);
  assert.equal(second.gap, false);

  // 区間が飛んだら切る（1.5倍を超えたとき）
  assert.equal(seriesPointOf(rec(4, -25), second, 1000).gap, true);
  assert.equal(seriesPointOf(rec(3, -25), second, 1000).gap, false);

  // 時刻の跳びがあった区間は、間隔が詰まっていても切る
  const jumped = seriesPointOf(rec(3, -25, { clockBreakKind: 'suspend' }), second, 1000);
  assert.equal(jumped.gap, true);

  // 無音は -Infinity のまま持つ（下端へ張り付かせるのは描画側）
  assert.equal(seriesPointOf(rec(4, -Infinity), second, 1000).db, -Infinity);

  // 間隔が分からないときは1秒とみなす
  assert.equal(seriesPointOf(rec(2, -25), first, null).gap, false);
  assert.equal(seriesPointOf(rec(4, -25), first, null).gap, true);
});

test('script.js: キャンバスの色をベタ書きしない（テーマ変数から取る）', () => {
  // 改修前は grid が rgba(255,255,255,0.06)、折れ線が #4da3ff のベタ書きで、
  // ライトテーマでは grid が白地に白（1.00:1）になっていた
  const draw = SCRIPT.slice(SCRIPT.indexOf('function drawSeries'),
    SCRIPT.indexOf('function renderStats'));
  assert.ok(!/rgba\(255,\s*255,\s*255/.test(draw), 'drawSeries に白のベタ書きが残っている');
  assert.ok(!/#4da3ff/.test(draw), 'drawSeries に折れ線色のベタ書きが残っている');
  assert.ok(/getPropertyValue\('--grid'\)|--grid/.test(SCRIPT), '--grid を読んでいない');
  assert.ok(/--plot/.test(SCRIPT), '--plot を読んでいない');
});

test('style.css: --grid と --plot が両テーマで定義されている', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
  const root = css.slice(css.indexOf(':root{'), css.indexOf('}', css.indexOf(':root{')));
  const light = css.slice(css.indexOf('body.light{'));
  for (const token of ['--grid', '--plot']) {
    assert.ok(root.includes(token), `:root に ${token} がない`);
    assert.ok(light.includes(token), `body.light に ${token} がない`);
  }
});
