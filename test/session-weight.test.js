'use strict';

// 「CSV から画面と同じ値を出せる」を本当にするための検証。
//
// ⚠⚠ 第2弾の途中まで、README の重み付け手順は
//    「C列に `=(A3-A2)*86400`（timestamp の差）を入れて区間長とする」だった。
//    timestamp は区間の終わりなので、同じセッションの中ならこれで正しい。
//    ところが記録を止めて再開すると、AudioContext を作り直して壁時計のアンカーも
//    取り直すので、その差に休止時間がまるごと入る。
//    画面のヘルプは「画面の値とCSVから計算し直した値は一致する」と言い切っていた。
//    嘘だった。
//
// ここでは
//   1. 手順どおりに計算するとどれだけ外れるか（向きと大きさ）
//   2. 直した手順（境界の行だけ `# intervalSec=` を使う）なら一致すること
//   3. README に書いた検算値が、実際に計算した値と合っていること
// を固定する。
//
// ⚠ 列は増やさない。境界の位置は `# sessionStartAt=` と `# clockBreakAt=` で示す。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const logic = require('../logic.js');
const {
  buildIntervalRecord, buildCsv, csvTrailerLines, createStats, addStatsRecord,
  statsLeq, intervalRunsLabel, sessionStartSeqs, reanchorClock, CLOCK_BREAK_SUSPEND,
  CSV_COLUMNS
} = logic;

const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

const SR = 48000;
const T0 = Date.UTC(2026, 8, 29, 3, 0, 0);

// spec = [{ db, lenSec }] を1セッションぶんの区間レコードにする。
// ⚠ audioCtx はセッションごとに作り直されるので、オーディオクロックは 0 から始まる。
//    壁時計は anchorWallMs から始まる（休止時間はここに乗る）
function session(spec, anchorWallMs, seqBase, metaId, breakAt) {
  let frame = 0;
  let anchor = { epoch: 0, audioTime: 0, wallMs: anchorWallMs };
  return spec.map((s, i) => {
    const frames = Math.round(s.lenSec * SR);
    const rms = (s.db === -Infinity) ? 0 : Math.pow(10, s.db / 20);
    let brk = null;
    if (breakAt && breakAt.index === i) {
      // 中断を検出してアンカーを取り直す（この行の直前）。壁時計だけが跳ぶ
      anchor = reanchorClock(
        anchor, frame / SR, anchor.wallMs + (frame / SR) * 1000 + breakAt.jumpMs
      );
      brk = { kind: CLOCK_BREAK_SUSPEND, jumpMs: breakAt.jumpMs };
    }
    const rec = buildIntervalRecord({
      type: 'interval', seq: i, sampleRate: SR,
      startFrame: frame, endFrame: frame + frames,
      expected: frames, count: frames,
      sumSq: frames * rms * rms, peak: rms * Math.SQRT2, clip: 0, emittedAt: 0
    }, anchor, -60, { seqBase, meta: { id: metaId }, clockBreak: brk });
    frame += frames;
    return rec;
  });
}

const quiet = (n, base = -52, len = 1) =>
  Array.from({ length: n }, (_, i) => ({ db: base + (i % 3), lenSec: len }));
const loud = (n, base = -22, len = 1) =>
  Array.from({ length: n }, (_, i) => ({ db: base + (i % 4), lenSec: len }));

function screenLeq(logs) {
  const st = createStats();
  for (const r of logs) addStatsRecord(st, r);
  return { leq: statsLeq(st), weightSec: st.weightSec };
}

function csvOf(logs) {
  return buildCsv(logs, {
    engine: 'worklet',
    meta: { started: logs[0].ts.toISOString(), sampleRate: SR },
    intervalSec: intervalRunsLabel(logs)
  });
}

// ---- CSV のテキストだけを読む「第三者」 ----
//
// README の手順をそのまま機械にやらせる。
//   H列 = (A_i - A_{i-1}) * 86400
//   ただし `# sessionStartAt=` と `# clockBreakAt=` の seq の行は
//   `# intervalSec=` のランから読んだ値を入れる
function readCsv(csvText) {
  const lines = csvText.split('\n').filter(l => l.length);
  const pick = (k) => lines
    .filter(l => l.startsWith(`# ${k}=`))
    .map(l => l.slice(`# ${k}=`.length))[0];

  const runs = String(pick('intervalSec') || '').split('+').filter(Boolean).map(t => {
    const [sec, seq] = t.split('@');
    return { sec: Number(sec), seq: Number(seq) };
  });
  const intervalOf = (seq) => {
    let v = null;
    for (const r of runs) if (r.seq <= seq) v = r.sec;
    return v;
  };
  const seqSet = (k) => new Set(
    String(pick(k) || '').split(',').filter(t => t.length).map(Number)
  );
  const boundary = new Set([...seqSet('sessionStartAt'), ...seqSet('clockBreakAt')]);

  const data = lines.filter(l => !l.startsWith('#'));
  assert.equal(data[0], CSV_COLUMNS.join(','), 'ヘッダーが違う');
  const rows = data.slice(1).map(l => {
    const c = l.split(',');
    return {
      tMs: Date.parse(c[0]),
      db: (c[1] === '-Infinity') ? -Infinity : Number(c[1]),
      seq: Number(c[2])
    };
  });
  return { rows, boundary, intervalOf, runs };
}

// 区間長の列（H列）を組む。fixBoundary=false なら手順の改修前と同じになる
function weightsOf(parsed, fixBoundary) {
  return parsed.rows.map((r, i) => {
    if (fixBoundary && parsed.boundary.has(r.seq)) return parsed.intervalOf(r.seq);
    if (i === 0) return parsed.intervalOf(r.seq);   // 1行目は前の行が無い
    return (r.tMs - parsed.rows[i - 1].tMs) / 1000;
  });
}

function leqOf(parsed, weights) {
  let e = 0;
  let w = 0;
  parsed.rows.forEach((r, i) => {
    assert.ok(weights[i] > 0, `区間長が正でない seq=${r.seq}`);
    e += ((r.db === -Infinity) ? 0 : Math.pow(10, r.db / 10)) * weights[i];
    w += weights[i];
  });
  return { leq: (e > 0) ? 10 * Math.log10(e / w) : -Infinity, weightSec: w };
}

// ---- 境界の出し方 ----

test('セッションの先頭行の seq を取れる（1行目は必ず入る）', () => {
  const a = session(loud(3), T0, 0, 's1');
  const b = session(quiet(2), T0 + 60000, 3, 's2');
  assert.deepEqual(sessionStartSeqs(a), [0]);
  assert.deepEqual(sessionStartSeqs(a.concat(b)), [0, 3]);
  // 測定条件が取れなかった記録（metaId が null）では、1行目だけを境界とする
  const noMeta = a.map(r => Object.assign({}, r, { metaId: null }));
  assert.deepEqual(sessionStartSeqs(noMeta), [0]);
  assert.deepEqual(sessionStartSeqs([]), []);
});

test('トレーラーに # sessionStartAt= が出る（1セッションでも出す）', () => {
  const one = session(loud(3), T0, 0, 's1');
  assert.ok(csvTrailerLines(one, {}).includes('# sessionStartAt=0'));
  const two = one.concat(session(quiet(2), T0 + 60000, 3, 's2'));
  const t = csvTrailerLines(two, {});
  assert.ok(t.includes('# sessionStartAt=0,3'), t.join(' / '));
  assert.ok(t.includes('# sessions=2'), t.join(' / '));
  // 行が無ければ出さない
  assert.ok(!csvTrailerLines([], {}).some(l => l.startsWith('# sessionStartAt=')));
});

// ---- 手順どおりに計算すると外れる ----

test('⭐停止→再開の境界で、timestamp の差を重みにすると Leq が外れる', () => {
  const PAUSE = 59.032;
  const logs = session(loud(10), T0, 0, 's1')
    .concat(session(quiet(7), T0 + (10 + PAUSE) * 1000, 10, 's2'));
  const parsed = readCsv(csvOf(logs));
  const screen = screenLeq(logs);

  // 境界の timestamp の差は「休止時間 ＋ その区間の長さ」になる
  const gapSec = (parsed.rows[10].tMs - parsed.rows[9].tMs) / 1000;
  assert.equal(gapSec.toFixed(3), '60.032');
  assert.equal(gapSec.toFixed(3), (PAUSE + 1).toFixed(3));

  const naive = leqOf(parsed, weightsOf(parsed, false));
  const fixed = leqOf(parsed, weightsOf(parsed, true));

  assert.equal(parsed.rows.length, 17);
  assert.equal(screen.weightSec, 17, '画面の重みの総和が記録された実時間でない');
  assert.equal(naive.weightSec.toFixed(3), '76.032', '休止時間が重みに入っていない');
  assert.equal(fixed.weightSec, 17);

  // ⭐手順どおりだと 6.49 dB 低く出る（README の表がこの値を載せている）
  assert.equal(screen.leq.toFixed(4), '-22.8601');
  assert.equal(naive.leq.toFixed(4), '-29.3472');
  assert.equal((naive.leq - screen.leq).toFixed(2), '-6.49');
  // ⭐直した手順なら小数10桁まで一致する
  assert.equal(fixed.leq.toFixed(10), screen.leq.toFixed(10));
});

test('⭐ずれの向きは記録の中身で変わる（境界の行が大きければ高く出る）', () => {
  const PAUSE = 59.032;
  // 再開してすぐ大きい音。休止時間がその行の重みになるので高く出る
  const logs = session(quiet(10), T0, 0, 's1')
    .concat(session(loud(7), T0 + (10 + PAUSE) * 1000, 10, 's2'));
  const parsed = readCsv(csvOf(logs));
  const screen = screenLeq(logs);
  const naive = leqOf(parsed, weightsOf(parsed, false));
  const fixed = leqOf(parsed, weightsOf(parsed, true));
  assert.equal((naive.leq - screen.leq).toFixed(2), '2.00');
  assert.equal(fixed.leq.toFixed(10), screen.leq.toFixed(10));
});

test('⭐休止が長いほど大きく外れる（600秒で 15.42 dB）', () => {
  const logs = session(loud(10), T0, 0, 's1')
    .concat(session(quiet(7), T0 + (10 + 600) * 1000, 10, 's2'));
  const parsed = readCsv(csvOf(logs));
  const screen = screenLeq(logs);
  const naive = leqOf(parsed, weightsOf(parsed, false));
  assert.equal((naive.leq - screen.leq).toFixed(2), '-15.42');
  assert.equal(leqOf(parsed, weightsOf(parsed, true)).leq.toFixed(10), screen.leq.toFixed(10));
});

// ---- 直した手順が、あらゆる並びで一致すること ----

test('⭐直した手順は6件すべてで画面と小数10桁まで一致する', () => {
  const cases = [
    ['単一セッション 1秒×10', session(quiet(10), T0, 0, 's1')],
    ['2セッション（境界の差 60.032秒）',
      session(loud(10), T0, 0, 's1')
        .concat(session(quiet(7), T0 + (10 + 59.032) * 1000, 10, 's2'))],
    ['3セッション・1秒→3秒→1秒',
      session(loud(5), T0, 0, 's1')
        .concat(session(quiet(4, -52, 3), T0 + (5 + 30) * 1000, 5, 's2'))
        .concat(session(loud(6), T0 + (5 + 30 + 12 + 90) * 1000, 9, 's3'))],
    ['1セッション内でログ間隔を 1→3 へ変更',
      session(loud(4).concat(quiet(4, -52, 3)), T0, 0, 's1')],
    ['アンカーの取り直しをまたぐ（5行目の直前に +4200ms）',
      session(loud(10), T0, 0, 's1', { index: 4, jumpMs: 4200 })],
    ['無音を含む2セッション',
      session([{ db: -20, lenSec: 1 }, { db: -Infinity, lenSec: 1 }, { db: -Infinity, lenSec: 1 }],
        T0, 0, 's1')
        .concat(session([{ db: -Infinity, lenSec: 9 }], T0 + (3 + 44.5) * 1000, 3, 's2'))]
  ];
  assert.equal(cases.length, 6, 'README が6件と書いている');
  for (const [label, logs] of cases) {
    const parsed = readCsv(csvOf(logs));
    const screen = screenLeq(logs);
    const fixed = leqOf(parsed, weightsOf(parsed, true));
    assert.equal(fixed.leq.toFixed(10), screen.leq.toFixed(10), label);
    assert.equal(fixed.weightSec.toFixed(9), screen.weightSec.toFixed(9), label);
  }
});

test('アンカーを取り直した行も、timestamp の差では取れない', () => {
  const logs = session(loud(10), T0, 0, 's1', { index: 4, jumpMs: 4200 });
  const parsed = readCsv(csvOf(logs));
  // その行は # clockBreakAt= に出る
  assert.ok(parsed.boundary.has(4), [...parsed.boundary].join(','));
  // 差には跳んだぶん（4.2秒）が乗っている
  assert.equal(((parsed.rows[4].tMs - parsed.rows[3].tMs) / 1000).toFixed(3), '5.200');
  const screen = screenLeq(logs);
  assert.notEqual(
    leqOf(parsed, weightsOf(parsed, false)).leq.toFixed(4), screen.leq.toFixed(4)
  );
  assert.equal(leqOf(parsed, weightsOf(parsed, true)).leq.toFixed(10), screen.leq.toFixed(10));
});

// ---- 区間長がそろっていれば、等重みの式でも一致する ----
//
// ⚠ 重みが定数なら、重み付きと等重みは同じ値になる。記録を止めて再開していても
//    等重みの式は timestamp を見ないので影響を受けない。README の分岐がこれを前提にする。

test('⭐等重みの式は、区間長がそろった記録6件すべてで画面と小数4桁まで一致する', () => {
  // README が「ログ間隔がそろった記録6件すべてで小数4桁まで一致した」と書いている
  const uniform = [
    [{ db: -20, lenSec: 1 }, { db: -35, lenSec: 1 }, { db: -50, lenSec: 1 }],
    [{ db: -20, lenSec: 10 }, { db: -35, lenSec: 10 }, { db: -50, lenSec: 10 }],
    [{ db: -6, lenSec: 3 }, { db: -Infinity, lenSec: 3 },
      { db: -41.5, lenSec: 3 }, { db: -12.25, lenSec: 3 }],
    [{ db: -60, lenSec: 0.5 }, { db: -3, lenSec: 0.5 }],
    Array.from({ length: 20 }, (_, i) => ({ db: -60 + i * 2.5, lenSec: 1 })),
    [{ db: -Infinity, lenSec: 1 }, { db: -Infinity, lenSec: 1 }, { db: -30, lenSec: 1 }]
  ];
  assert.equal(uniform.length, 6, 'README が6件と書いている');
  for (const spec of uniform) {
    const logs = session(spec, T0, 0, 's1');
    // 区間長がそろっているので、トレーラーに `+` は入らない
    assert.equal(intervalRunsLabel(logs).includes('+'), false, JSON.stringify(spec));
    // 等重みの式（README の1本目）
    let p = 0;
    for (const r of logs) p += (r.rawDb === -Infinity) ? 0 : Math.pow(10, r.rawDb / 10);
    const equal = 10 * Math.log10(p / logs.length);
    assert.equal(equal.toFixed(4), screenLeq(logs).leq.toFixed(4), JSON.stringify(spec));
  }
});

test('区間長がそろっていれば、停止→再開をまたいでも等重みの式で一致する', () => {
  const logs = session(loud(10), T0, 0, 's1')
    .concat(session(quiet(7), T0 + (10 + 59.032) * 1000, 10, 's2'));
  const parsed = readCsv(csvOf(logs));
  // # intervalSec= に `+` が入っていない＝区間長がそろっている、と読める
  assert.equal(parsed.runs.length, 1, '前提が崩れている');
  let p = 0;
  for (const r of parsed.rows) p += (r.db === -Infinity) ? 0 : Math.pow(10, r.db / 10);
  const equal = 10 * Math.log10(p / parsed.rows.length);
  assert.equal(equal.toFixed(10), screenLeq(logs).leq.toFixed(10));
});

// ---- README の検算値 ----

const norm = (s) => s.replace(/\*\*/g, '').replace(/`/g, '').trim();

function tableRows(headerLine) {
  const i = readme.indexOf(headerLine);
  assert.notEqual(i, -1, `表が見つからない: ${headerLine}`);
  const rows = [];
  // ⚠ 箇条書きの中の表はインデントが付く。行頭の空白を落としてから見る
  for (const raw of readme.slice(i).split('\n').slice(2)) {
    const l = raw.trim();
    if (l[0] !== '|') break;
    rows.push(l.split('|').slice(1, -1).map(norm));
  }
  assert.ok(rows.length, `表の中身が無い: ${headerLine}`);
  return rows;
}

// Excel の式を定義から独立に組む（実装の積み上げ方を借りない）
const SUB = -999;                                      // -Infinity の置き換え値
const cellB = (s) => (s.db === -Infinity ? SUB : s.db);
const pw = (db) => Math.pow(10, db / 10);
const excelAverage = (spec) => spec.reduce((a, s) => a + cellB(s), 0) / spec.length;
const excelLeqEqual = (spec) =>
  10 * Math.log10(spec.reduce((a, s) => a + pw(cellB(s)), 0) / spec.length);
const excelLeqWeighted = (spec) => {
  let e = 0;
  let w = 0;
  for (const s of spec) { e += pw(cellB(s)) * s.lenSec; w += s.lenSec; }
  return 10 * Math.log10(e / w);
};

// 表の1列目の書き方から、記録（spec）を組み立てる
const SPECS = {
  '60行の-60 dBFSのうち1行だけ-3 dBFS（無音なし）':
    [...Array(59).fill({ db: -60, lenSec: 1 }), { db: -3, lenSec: 1 }],
  '4行中1行が無音、残り3行が-30 dBFS':
    [...Array(3).fill({ db: -30, lenSec: 1 }), { db: -Infinity, lenSec: 1 }],
  '10行中9行が無音、残り1行が-20 dBFS':
    [{ db: -20, lenSec: 1 }, ...Array(9).fill({ db: -Infinity, lenSec: 1 })],
  '1秒×3行(-40)のあと3秒×1行(-10)':
    [...Array(3).fill({ db: -40, lenSec: 1 }), { db: -10, lenSec: 3 }],
  '1秒×3行(-40)のあと10秒×3行(-10)':
    [...Array(3).fill({ db: -40, lenSec: 1 }), ...Array(3).fill({ db: -10, lenSec: 10 })],
  '3秒×4行(-25)のあと1秒×12行(-45)':
    [...Array(4).fill({ db: -25, lenSec: 3 }), ...Array(12).fill({ db: -45, lenSec: 1 })],
  '1秒×1行(-20)のあと9秒×1行の無音':
    [{ db: -20, lenSec: 1 }, { db: -Infinity, lenSec: 9 }],
  '1秒×1行(-6)のあと10秒×1行(-60)':
    [{ db: -6, lenSec: 1 }, { db: -60, lenSec: 10 }],
  '1秒×1行(-6)のあと10秒×5行(-60)':
    [{ db: -6, lenSec: 1 }, ...Array(5).fill({ db: -60, lenSec: 10 })]
};

test('⭐README の「算術平均と Leq のずれ」の表が、実際に計算した値と一致する', () => {
  const rows = tableRows('| 記録 | 算術平均 | Leq | 差 |');
  assert.equal(rows.length, 3, '表の行数が変わっている（増やしたなら計算し直すこと）');
  for (const [label, avgCell, leqCell, diffCell] of rows) {
    const spec = SPECS[label];
    assert.ok(spec, `この記録を機械が再現できない（SPECS に足すこと）: ${label}`);
    const avg = excelAverage(spec);
    const leq = excelLeqEqual(spec);
    assert.equal(avg.toFixed(4), avgCell, `算術平均が違う: ${label}`);
    assert.equal(leq.toFixed(4), leqCell, `Leq が違う: ${label}`);
    // 差の列は「算術平均がXdB低い／高い」という文
    const m = diffCell.match(/算術平均が([\d.]+)dB(低い|高い)/);
    assert.ok(m, `差の書き方が読めない: ${diffCell}`);
    assert.equal(Math.abs(avg - leq).toFixed(4), m[1], `差が違う: ${label}`);
    assert.equal(avg < leq ? '低い' : '高い', m[2], `差の向きが違う: ${label}`);
  }
});

test('⭐README の「重み付けを省いたときのずれ」の表が、実際に計算した値と一致する', () => {
  const rows = tableRows('| 記録 | 重み付き（画面と同じ） | 等重み | ずれ |');
  assert.equal(rows.length, 6, '表の行数が変わっている（増やしたなら計算し直すこと）');
  for (const [label, wCell, eCell, diffCell] of rows) {
    const spec = SPECS[label];
    assert.ok(spec, `この記録を機械が再現できない（SPECS に足すこと）: ${label}`);
    const w = excelLeqWeighted(spec);
    const e = excelLeqEqual(spec);
    assert.equal(w.toFixed(4), wCell, `重み付きが違う: ${label}`);
    assert.equal(e.toFixed(4), eCell, `等重みが違う: ${label}`);
    const m = diffCell.match(/([\d.]+)dB(低い|高い)/);
    assert.ok(m, `ずれの書き方が読めない: ${diffCell}`);
    assert.equal(Math.abs(e - w).toFixed(4), m[1], `ずれが違う: ${label}`);
    assert.equal(e < w ? '低い' : '高い', m[2], `ずれの向きが違う: ${label}`);
    // 重み付きは画面の値と一致していること（区間レコードを通して確かめる）
    let frame = 0;
    const recs = spec.map((s, i) => {
      const frames = Math.round(s.lenSec * SR);
      const rms = (s.db === -Infinity) ? 0 : Math.pow(10, s.db / 20);
      const rec = buildIntervalRecord({
        type: 'interval', seq: i, sampleRate: SR,
        startFrame: frame, endFrame: frame + frames,
        expected: frames, count: frames,
        sumSq: frames * rms * rms, peak: rms * Math.SQRT2, clip: 0, emittedAt: 0
      }, { epoch: 0, audioTime: 0, wallMs: T0 }, -60, { seqBase: 0, meta: { id: 's1' } });
      frame += frames;
      return rec;
    });
    assert.equal(screenLeq(recs).leq.toFixed(4), wCell, `画面と一致しない: ${label}`);
  }
});

test('⭐無音の行を消したときの上がり幅は、行の値によらず重みの比で決まる', () => {
  // README が「1.2494dB」「10.0000dB」と書いている2件
  for (const [total, silent, want] of [[4, 1, '1.2494'], [10, 9, '10.0000']]) {
    const rise = 10 * Math.log10(total / (total - silent));
    assert.equal(rise.toFixed(4), want, `${total}行中${silent}行`);
    // 行の値を変えても同じ幅になる（実際に落として計算する）
    for (const db of [-20, -6, -55]) {
      const spec = [
        ...Array(total - silent).fill({ db, lenSec: 1 }),
        ...Array(silent).fill({ db: -Infinity, lenSec: 1 })
      ];
      const kept = spec.filter(s => s.db !== -Infinity);
      const got = excelLeqWeighted(kept) - excelLeqWeighted(spec);
      assert.ok(Math.abs(got - rise) < 1e-9, `値に依存している db=${db}`);
    }
    assert.ok(readme.includes(`${want}dB`), `README に ${want}dB が無い`);
  }
});

test('⭐置き換えを飛ばすと AVERAGE が無音の行を無視する（README の数値）', () => {
  // AVERAGE は文字列のセルを黙って無視する＝数値の行だけの平均になる
  const skipText = (spec) => {
    const num = spec.filter(s => s.db !== -Infinity);
    return num.reduce((a, s) => a + s.db, 0) / num.length;
  };
  for (const [label, wantAvg, wantGap] of [
    ['4行中1行が無音、残り3行が-30 dBFS', '-30.0000', '1.2494'],
    ['10行中9行が無音、残り1行が-20 dBFS', '-20.0000', '10.0000']
  ]) {
    const spec = SPECS[label];
    const avg = skipText(spec);
    const leq = excelLeqEqual(spec);
    assert.equal(avg.toFixed(4), wantAvg, label);
    assert.equal((avg - leq).toFixed(4), wantGap, label);
    assert.ok(readme.includes(`${wantAvg}（Leqより**${wantGap}dB高い**）`), `README と違う: ${label}`);
  }
});

test('⭐置き換え値を変えても Leq は動かない（README の「小数12桁まで同じ」）', () => {
  const spec = [{ db: -20, lenSec: 1 }, ...Array(3).fill({ db: -Infinity, lenSec: 1 })];
  const at = (sub) => {
    const e = spec.reduce((a, s) => a + pw(s.db === -Infinity ? sub : s.db), 0) / spec.length;
    return (10 * Math.log10(e)).toFixed(12);
  };
  const base = at(-999);
  for (const sub of [-300, -1000, -1000000]) assert.equal(at(sub), base, `sub=${sub}`);
  assert.ok(readme.includes('小数12桁まで同じ値になった'));
});

test('⭐1行目の重みを落とすと、README が書いた範囲（+0.79〜-969.00 dB）に収まる', () => {
  const blankFirst = (spec) => {
    let e = 0;
    let w = 0;
    spec.forEach((s, i) => {
      const len = (i === 0) ? 0 : s.lenSec;
      e += pw(cellB(s)) * len;
      w += len;
    });
    return 10 * Math.log10(e / w);
  };
  const labels = [
    '1秒×3行(-40)のあと3秒×1行(-10)',
    '1秒×3行(-40)のあと10秒×3行(-10)',
    '3秒×4行(-25)のあと1秒×12行(-45)',
    '1秒×1行(-20)のあと9秒×1行の無音',
    '1秒×1行(-6)のあと10秒×1行(-60)',
    '1秒×1行(-6)のあと10秒×5行(-60)'
  ];
  const diffs = labels.map(l => blankFirst(SPECS[l]) - excelLeqWeighted(SPECS[l]));
  assert.equal(Math.max(...diffs).toFixed(2), '0.79');
  assert.equal(Math.min(...diffs).toFixed(2), '-969.00');
  assert.ok(readme.includes('0.79dB高い'), 'README の上限が違う');
  assert.ok(readme.includes('969.00dB低い'), 'README の下限が違う');
  // 1行目だけが有限な記録では、答えが置き換え値そのものになる
  const only1 = [{ db: -20, lenSec: 1 }, ...Array(3).fill({ db: -Infinity, lenSec: 1 })];
  assert.equal(blankFirst(only1).toFixed(4), SUB.toFixed(4));
});

// ---- 画面のヘルプ ----

test('⭐README の「セッションの境界」の表が、実際に計算した値と一致する', () => {
  const rows = tableRows('| 区間長の取り方 | Leq | 重みの総和 |');
  assert.equal(rows.length, 3, '表の行数が変わっている');
  const logs = session(loud(10), T0, 0, 's1')
    .concat(session(quiet(7), T0 + (10 + 59.032) * 1000, 10, 's2'));
  const parsed = readCsv(csvOf(logs));
  const screen = screenLeq(logs);
  const naive = leqOf(parsed, weightsOf(parsed, false));
  const fixed = leqOf(parsed, weightsOf(parsed, true));
  const want = [
    [screen.leq, screen.weightSec],
    [naive.leq, naive.weightSec],
    [fixed.leq, fixed.weightSec]
  ];
  rows.forEach(([, leqCell, wCell], i) => {
    assert.ok(leqCell.includes(want[i][0].toFixed(4)), `${i}行目の Leq: ${leqCell}`);
    assert.ok(
      wCell.includes(want[i][1].toFixed(3)) || wCell.includes(String(want[i][1])),
      `${i}行目の重みの総和: ${wCell}`
    );
  });
  assert.ok(rows[1][2].includes('76.032'), '休止時間が重みに入った値が表に無い');
});

test('README のログ間隔の切り替えの表が、実測（1,1,1,3,3）と一致する', () => {
  const rows = tableRows('| `seq` | 実際に測った区間長 | 画面の設定値 |');
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map(r => r[1]), [
    '1.000000秒', '1.000000秒', '1.000000秒', '3.000000秒', '3.000000秒'
  ]);
  assert.deepEqual(rows.map(r => r[2]), ['1', '1', '3（設定はもう3になっている）', '3', '3']);
});

test('画面のヘルプの検算値が README とそろっている', () => {
  // ⚠ 画面だけ見た読者にも、外れ幅が伝わること
  assert.ok(html.includes('6.49dB'), 'ヘルプに境界のずれ幅が無い');
  assert.ok(html.includes('9.3dB'), 'ヘルプに重み付けを省いたときのずれ幅が無い');
});
