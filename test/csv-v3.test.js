'use strict';

// CSV v3 を固める（第2弾b2）。
//
// v3 で変えたこと：
//  - 帯域の3列（band_ultra_dbfs・band_audible_dbfs・band_valid_ratio）を hash の左に挿した。
//    ハッシュの材料は「hash 列より左のフィールド」のままで、9つになった（帯域の値も鎖で守られる）
//  - ヘッダーに nyquistHz・settingsRaw・bands・fftSize を足した。どれも記録を始めた時点で決まる値である
//  - 音が1つも届かなかった区間（count=0）の dbfs・peak_dbfs・clip を空欄にした。改修前は -Infinity
//    （デジタル無音）と同じ値を書いていた（第2弾a の公開前の点検の W#4）。統計の平均にも入れない
//
// ここで確かめること：
//  - 列の順と数（A列 timestamp・B列 dbfs は動かない。帯域の2列は BAND_DEFS の順）
//  - ハッシュの材料が hash の左の9フィールドであること（SHA-256 の鎖をこのファイルで組み直して比べる）
//  - README の検証器と同じ手順（列のヘッダー行から hash の位置を読む）で、v2（fixtures/sample_v2.csv）と
//    v3 の CSV をどちらも確かめられること
//  - 列のヘッダー行はハッシュの材料に入らないので、検証器は起点の `# format=` の版の列と同じかを先に見ること。
//    README の検証器の KNOWN が、実装の列（v3）と v2 の見本の列と同じであること（第2弾b2 の点検で追加）
//  - ヘッダーに事後の値が入らないこと（同じ記録を2回書き出して、同じ行のハッシュが同じ）
//  - count=0 の空欄化と、統計（Leq）からの除外。README の Excel の手順（欠測の行の重みを0）で画面と同じ値が出ること
//  - ?bands=off のときの空欄と `# bands=off`
//  - settingsRaw に deviceId・groupId が入らないこと
//
// ワークレット（worklet/meter-processor.js）は node:vm の中で動かす（test/band.test.js と同じ差し替え）。
// 期待値は手で書かず、実装とは別の素朴な計算（SHA-256・10*log10・toFixed・数え上げ）から出す。
// ⚠ 帯域の値は「その帯域に音のエネルギーがあったか」の記録である。何の音かは分からない。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const root = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(root, 'worklet', 'meter-processor.js'), 'utf8');
const README = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const V2_SAMPLE = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample_v2.csv'), 'utf8');
const {
  BAND_DEFS, bandPlan, CSV_COLUMNS, csvDataFields, buildCsv, buildIntervalRecord,
  buildFallbackRecord, buildSessionMeta, chainHeaderMeta, csvHeaderLines, csvTrailerLines,
  createHashChain, createStats, addStatsRecord, statsLeq, statsIntegrity, statsWarnings,
  intervalRunsLabel, HASH_ALGO_LABEL, HASH_HEX_LEN, ENGINE_WORKLET, ENGINE_FALLBACK
} = require('../logic.js');

const QUANTUM = 128;
const RATE = 48000;
const ANCHOR = { epoch: 0, audioTime: 0, wallMs: Date.UTC(2026, 8, 29, 3, 0, 0) };
// 1区間 = 48クォンタム（0.128秒）。クォンタムの落ちで区間をまるごと空にしやすい長さにする
const INTERVAL = 48 * QUANTUM;

const sha = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const short = (text) => sha(text).slice(0, HASH_HEX_LEN);

// ---- ワークレットを動かす（test/band.test.js の createHarness を縮めたもの）----
function createHarness(opts = {}) {
  const state = { frame: 0 };
  const messages = [];
  const registered = {};
  const sandbox = {
    sampleRate: RATE,
    Math,
    Number,
    console,
    registerProcessor(name, cls) { registered[name] = cls; },
    AudioWorkletProcessor: class {
      constructor() {
        this.port = { postMessage: (m) => messages.push(m), onmessage: null };
      }
    }
  };
  Object.defineProperty(sandbox, 'currentFrame', { get: () => state.frame });
  Object.defineProperty(sandbox, 'currentTime', { get: () => state.frame / RATE });
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'meter-processor.js' });
  const processorOptions = { intervalFrames: INTERVAL, bandPlan: bandPlan(RATE) };
  if (opts.bands !== undefined) processorOptions.bands = opts.bands;
  const proc = new registered['meter-processor']({ processorOptions });
  const ready = messages.find(m => m.type === 'ready');
  messages.length = 0;
  // 最初の1回は起点に使われない（第2弾a8）。数え始める1ブロック前に空の呼び出しを入れる
  state.frame = -QUANTUM;
  proc.process([[]]);
  state.frame = 0;
  return {
    ready,
    state,
    tick(fill) {
      const block = new Float32Array(QUANTUM);
      for (let i = 0; i < QUANTUM; i++) block[i] = fill(state.frame + i);
      proc.process([[block]]);
      state.frame += QUANTUM;
    },
    drop() { state.frame += QUANTUM; },
    run(fill, quanta) { for (let q = 0; q < quanta; q++) this.tick(fill); },
    take() { return messages.splice(0).filter(m => m.type === 'interval'); }
  };
}

// 1kHz（可聴帯）と19kHz（超音波帯）の和。振幅は RMS で -20dBFS と -30dBFS
const A1 = Math.SQRT2 * Math.pow(10, -20 / 20);
const A2 = Math.SQRT2 * Math.pow(10, -30 / 20);
const TONE = (t) => A1 * Math.sin(2 * Math.PI * 1000 * t / RATE) + A2 * Math.sin(2 * Math.PI * 19000 * t / RATE);
const SILENT = () => 0;

// 帯域あり・なしで同じ筋書きを流す。区間は 音・音・デジタル無音・欠測（count=0）・音・音
function scenario(bands) {
  const h = createHarness({ bands });
  h.run(TONE, 48 * 2);
  h.run(SILENT, 48);
  for (let q = 0; q < 48; q++) h.drop();      // 1区間ぶんクォンタムを落とす（届いたサンプル0）
  h.run(TONE, 48 * 2 + 1);                    // 最後の区間を閉じるために1クォンタム余分に進める
  return { h, msgs: h.take() };
}

function sessionMetaOf(opts = {}) {
  return buildSessionMeta({
    id: 's1',
    engine: ENGINE_WORKLET,
    contextSampleRate: RATE,
    deviceLabel: 'Fake Default Audio Input',
    settings: Object.assign({
      echoCancellation: false, autoGainControl: false, noiseSuppression: false,
      sampleRate: 44100, channelCount: 2,
      deviceId: 'DEVICE-ID-SHOULD-NOT-LEAK', groupId: 'GROUP-ID-SHOULD-NOT-LEAK'
    }, opts.settings || {}),
    bandsEnabled: opts.bandsEnabled === undefined ? true : opts.bandsEnabled
  });
}

function recordsOf(msgs, meta) {
  return msgs.map(m => buildIntervalRecord(m, ANCHOR, -90, { meta, seqBase: 0 }));
}

// script.js の記録と書き出し（pushRecord → hashChain.extend、exportCSV）と同じ進め方
function recorder(meta, engineMode) {
  const chain = createHashChain(async (text) => sha(text));
  const logs = [];
  return {
    logs,
    push(rec) {
      if (!logs.length) {
        chain.begin(chainHeaderMeta({ sessionMeta: meta, firstRec: rec, engineMode, hashAlgo: HASH_ALGO_LABEL }));
      }
      logs.push(rec);
      chain.extend(rec);
    },
    async exportCsv() {
      await chain.settled();
      const extra = { intervalSec: intervalRunsLabel(logs) };
      const hashes = chain.hashes(logs);
      const trailerHash = hashes ? await chain.sealTrailer(csvTrailerLines(logs, extra)) : null;
      return buildCsv(logs, { meta: chain.meta, hashes, intervalSec: extra.intervalSec, trailerHash });
    }
  };
}

async function recordAll(recs, meta, engineMode) {
  const r = recorder(meta, engineMode || ENGINE_WORKLET);
  for (const rec of recs) r.push(rec);
  return r.exportCsv();
}

// ---- README の検証器と同じ手順（実装を写さず、ここで独立に組む）----
//
// 列のヘッダー行（timestamp, で始まり hash を含む行）から hash の位置を読む。
// v2（7列）でも v3（10列）でも、材料は「hash 列より左のフィールド」である。
// ⚠ 列のヘッダー行は材料に入らないので、起点の `# format=` の版の列と同じかを先に見る（知らない版では見ない）
function partsOf(text) {
  const lines = text.split('\n').filter(l => l.length);
  const at = lines.findIndex(l => l.startsWith('timestamp,') && l.split(',').includes('hash'));
  assert.notEqual(at, -1, '列のヘッダー行が無い');
  const cols = lines[at].split(',');
  const rest = lines.slice(at + 1);
  return {
    cols,
    hx: cols.indexOf('hash'),
    head: lines.slice(0, at),
    data: rest.filter(l => l[0] !== '#'),
    trailer: rest.filter(l => l[0] === '#')
  };
}

const KNOWN = {
  '# format=mic-gain-logger/3': CSV_COLUMNS.join(','),
  '# format=mic-gain-logger/2': partsOf(V2_SAMPLE).cols.join(',')
};

function verifyLikeReadme(text) {
  const p = partsOf(text);
  const fmt = p.head.find(l => Object.prototype.hasOwnProperty.call(KNOWN, l));
  if (fmt && p.cols.join(',') !== KNOWN[fmt]) return '列のヘッダー行が # format= の版の列と合いません';
  const hashCell = l => { const c = l.split(','); return c.length > p.hx ? c[p.hx] : ''; };
  if (!p.data.some(l => hashCell(l))) {
    return 'hash列が全行で空です。鎖のないCSVなので、この検証器では確かめられません';
  }
  let prev = short(p.head.join('\n'));
  for (let i = 0; i < p.data.length; i++) {
    const want = short(prev + '|' + p.data[i].split(',').slice(0, p.hx).join(','));
    if (hashCell(p.data[i]) !== want) return `${i + 1}行目から合いません（期待 ${want}／実際 ${hashCell(p.data[i])}）`;
    prev = want;
  }
  const MARK = '# trailerHash=';
  const found = p.trailer.filter(l => l.startsWith(MARK));
  if (!found.length) return 'トレーラーのハッシュがありません（末尾が落とされています）';
  const want = short(prev + '|' + p.trailer.filter(l => !l.startsWith(MARK)).join('\n'));
  if (found[0] !== MARK + want) return `トレーラーが合いません（期待 ${want}／実際 ${found[0].slice(MARK.length)}）`;
  if (!p.trailer.includes(`# rows=${p.data.length}`)) return `行数がトレーラーと合いません（データ行は ${p.data.length} 行）`;
  return `${p.data.length}行すべて通りました（トレーラーも一致）`;
}

// 帯域の1セルを、ワークレットのメッセージ（電力の和・フレーム数）から素朴に書く
function naiveBandCell(power, frames) {
  if (!(frames > 0) || !Number.isFinite(power)) return '';
  const ms = power / frames;
  return ms > 0 ? (10 * Math.log10(ms)).toFixed(2) : '-Infinity';
}
function naiveRatioCell(frames, expected) {
  return (Number.isFinite(frames) && expected > 0) ? (frames / expected).toFixed(3) : '';
}

const META_KEY = l => l.slice(2, l.indexOf('='));


// ---- 列 ----

test('列は10列で、v2 の hash の左に帯域の3列を挿した並びになる（A列 timestamp・B列 dbfs は動かない）', () => {
  // v2 の列は、第2弾a まで README に載せていた見本（fixtures/sample_v2.csv）から読む
  const v2 = partsOf(V2_SAMPLE).cols;
  assert.equal(v2.length, 7);
  const bandCols = BAND_DEFS.map(d => `band_${d.key}_dbfs`).concat(['band_valid_ratio']);
  assert.deepEqual(CSV_COLUMNS, v2.slice(0, -1).concat(bandCols, ['hash']));
  assert.equal(CSV_COLUMNS.length, 10);
  assert.equal(CSV_COLUMNS[0], 'timestamp');
  assert.equal(CSV_COLUMNS[1], 'dbfs');
  assert.equal(CSV_COLUMNS[CSV_COLUMNS.length - 1], 'hash');
});

test('データ行はどれも10列で、hash の左は9フィールド（csvDataFields の長さ）', async () => {
  const { msgs } = scenario(true);
  const meta = sessionMetaOf();
  const recs = recordsOf(msgs, meta);
  for (const r of recs) assert.equal(csvDataFields(r).length, CSV_COLUMNS.length - 1);
  const p = partsOf(await recordAll(recs, meta));
  assert.equal(p.hx, 9);
  assert.equal(p.data.length, recs.length);
  for (const l of p.data) assert.equal(l.split(',').length, 10, l);
});

test('⭐帯域の列の値は、ワークレットの電力の和 ÷ 数えたフレーム数を dbfs と同じ書式にしたもの', async () => {
  const { msgs } = scenario(true);
  const meta = sessionMetaOf();
  const p = partsOf(await recordAll(recordsOf(msgs, meta), meta));
  const ultra = BAND_DEFS.findIndex(d => d.key === 'ultra');
  const audible = BAND_DEFS.findIndex(d => d.key === 'audible');
  msgs.forEach((m, i) => {
    const c = p.data[i].split(',');
    assert.equal(c[6], naiveBandCell(m.bandPower[ultra], m.bandFrames), `区間 ${i} の band_ultra_dbfs`);
    assert.equal(c[7], naiveBandCell(m.bandPower[audible], m.bandFrames), `区間 ${i} の band_audible_dbfs`);
    assert.equal(c[8], naiveRatioCell(m.bandFrames, m.bandExpected), `区間 ${i} の band_valid_ratio`);
  });
  // 音の区間の超音波帯は約 -30dBFS、可聴帯は約 -20dBFS（19kHz と 1kHz の RMS）。筋書きどおりの音が入っていることの確かめ
  const c0 = p.data[1].split(',');
  assert.ok(Math.abs(Number(c0[6]) + 30) < 0.1, c0.join(','));
  assert.ok(Math.abs(Number(c0[7]) + 20) < 0.1, c0.join(','));
});


// ---- ハッシュの材料 ----

test('⭐ハッシュの材料は hash の左の9フィールドで、帯域の値も鎖で守られる', async () => {
  const { msgs } = scenario(true);
  const meta = sessionMetaOf();
  const text = await recordAll(recordsOf(msgs, meta), meta);
  const p = partsOf(text);
  // SHA-256 の鎖をこのファイルで組み直す
  let prev = short(p.head.join('\n'));
  for (const l of p.data) {
    const c = l.split(',');
    const want = short(prev + '|' + c.slice(0, 9).join(','));
    assert.equal(c[9], want, l);
    prev = want;
  }
  assert.equal(verifyLikeReadme(text), `${p.data.length}行すべて通りました（トレーラーも一致）`);
  // 帯域の値を1つ書き換えると、その行から合わなくなる
  const lines = text.split('\n');
  const i = lines.indexOf(p.data[1]);
  const c = p.data[1].split(',');
  c[6] = '-10.00';
  lines[i] = c.join(',');
  assert.match(verifyLikeReadme(lines.join('\n')), /^2行目から合いません/);
});

test('⭐v2（7列）と v3（10列）の CSV を、同じ手順（hash の位置を列のヘッダー行から読む）で確かめられる', async () => {
  // v2：第2弾a まで README に載せていた見本。そのままなら通り、改変すると合わなくなる
  assert.equal(partsOf(V2_SAMPLE).hx, 6);
  assert.equal(verifyLikeReadme(V2_SAMPLE), '4行すべて通りました（トレーラーも一致）');
  assert.match(verifyLikeReadme(V2_SAMPLE.replace('-41.87', '-30.00')), /^2行目から合いません/);
  // v3：実装で書き出したもの
  const { msgs } = scenario(true);
  const meta = sessionMetaOf();
  const v3 = await recordAll(recordsOf(msgs, meta), meta);
  assert.equal(partsOf(v3).hx, 9);
  assert.equal(verifyLikeReadme(v3), `${msgs.length}行すべて通りました（トレーラーも一致）`);
  // v2 の位置（7列目）を決め打ちすると、v3 は1行目から合わない（決め打ちの検証器を残してはいけない理由）
  const p = partsOf(v3);
  const fixed = short(short(p.head.join('\n')) + '|' + p.data[0].split(',').slice(0, 6).join(','));
  assert.notEqual(fixed, p.data[0].split(',')[6]);
});

test('⭐列のヘッダー行はハッシュの材料に入らない。検証器は起点の # format= の版の列と比べるので、列名の入れ替えで落ちる', async () => {
  const { msgs } = scenario(true);
  const meta = sessionMetaOf();
  const v3 = await recordAll(recordsOf(msgs, meta), meta);
  // 列のヘッダー行の2つの列名を入れ替える（データ行・ハッシュには触らない）
  const swap = (text, a, b) => {
    const src = partsOf(text).cols;
    const i = src.indexOf(a);
    const j = src.indexOf(b);
    assert.ok(i !== -1 && j !== -1, `列名が無い: ${a} / ${b}`);
    const out = [...src];
    [out[i], out[j]] = [out[j], out[i]];
    return text.replace(src.join(','), out.join(','));
  };
  // v3：帯域の2列の名前を入れ替える。行のハッシュは列名に左右されないので、鎖だけなら通ってしまう
  const swapped = swap(v3, 'band_ultra_dbfs', 'band_audible_dbfs');
  assert.notEqual(swapped, v3);
  const p = partsOf(swapped);
  let prev = short(p.head.join('\n'));
  for (const l of p.data) {
    const c = l.split(',');
    prev = short(prev + '|' + c.slice(0, p.hx).join(','));
    assert.equal(c[p.hx], prev, '列名を入れ替えただけで行のハッシュが合わなくなった（列のヘッダー行が材料に入っている）');
  }
  assert.equal(verifyLikeReadme(swapped), '列のヘッダー行が # format= の版の列と合いません');
  // v2：帯域の列が無いので dbfs と peak_dbfs を入れ替える
  assert.equal(verifyLikeReadme(swap(V2_SAMPLE, 'dbfs', 'peak_dbfs')), '列のヘッダー行が # format= の版の列と合いません');
  // 知らない版（KNOWN に無い）では確かめない。# format= は起点に入っているので、書き換えれば1行目から合わない
  assert.match(verifyLikeReadme(swapped.replace('# format=mic-gain-logger/3', '# format=mic-gain-logger/9')), /^1行目から合いません/);
});

test('README の検証器の KNOWN（版ごとの列）が、実装の列と v2 の見本の列と同じ', () => {
  const blocks = [];
  const re = /```[a-z]*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(README)) !== null) blocks.push(m[1]);
  const py = blocks.find(b => b.includes('verify_mic_gain_log.py'));
  assert.ok(py, 'README に検証器が無い');
  const known = {};
  for (const k of py.matchAll(/^\s*"(# format=[^"]+)": "([^"]+)",?$/gm)) known[k[1]] = k[2];
  assert.deepEqual(known, KNOWN, 'README の検証器の KNOWN が、実装の列・v2 の見本の列と食い違っている');
  // 版の列と比べるのは、行ごとの計算より先（合わないまま行を計算しても意味が無い）
  const check = py.indexOf('列のヘッダー行が # format= の版の列と合いません');
  assert.notEqual(check, -1, '検証器が列のヘッダー行を版の列と比べていない');
  assert.ok(check < py.indexOf('for i, line in enumerate(data, 1)'), '版の列との比較が、行ごとの計算より後ろにある');
});

test('README の検証器は hash の位置を列のヘッダー行から読み、v2 の列を決め打ちしていない', () => {
  const blocks = [];
  const re = /```[a-z]*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(README)) !== null) blocks.push(m[1]);
  const py = blocks.find(b => b.includes('verify_mic_gain_log.py'));
  assert.ok(py, 'README に検証器が無い');
  assert.ok(py.includes('.index("hash")'), 'hash の位置を列のヘッダー行から読んでいない');
  assert.ok(!py.includes('COLUMNS = "timestamp,dbfs,seq,peak_dbfs,clip,valid_ratio,hash"'), 'v2 の列を決め打ちしている');
  assert.ok(!/cells\[6\]|\[:6\]/.test(py), 'v2 の hash の位置（7列目）を決め打ちしている');
});


// ---- ヘッダー（記録開始時に決まる事実だけ）----

test('⭐ヘッダーは記録開始時に決まる事実だけ。同じ記録を2回書き出しても、同じ行のハッシュは同じ', async () => {
  const { msgs } = scenario(true);
  const meta = sessionMetaOf();
  const recs = recordsOf(msgs, meta);
  const r = recorder(meta, ENGINE_WORKLET);
  // 音の2区間だけ記録して書き出す → 続けて無音・欠測・音を記録して、もう一度書き出す
  r.push(recs[0]);
  r.push(recs[1]);
  const first = partsOf(await r.exportCsv());
  for (const rec of recs.slice(2)) r.push(rec);
  const second = partsOf(await r.exportCsv());

  assert.deepEqual(second.head, first.head, 'ヘッダーが2回目の書き出しで変わった');
  assert.deepEqual(
    second.data.slice(0, first.data.length).map(l => l.split(',')[9]),
    first.data.map(l => l.split(',')[9]),
    '1回目に書き出した行のハッシュが変わった'
  );
  // 2回目には無音と欠測が入ったので、トレーラーは変わる（事後の事実はトレーラーにだけ出る）
  assert.ok(second.trailer.includes('# silence=-Infinity'), second.trailer.join(' / '));
  assert.ok(!first.trailer.includes('# silence=-Infinity'), first.trailer.join(' / '));

  // ヘッダーの項目は、記録を始めた時点で決まるものだけ
  const allowed = ['format', 'engine', 'started', 'sampleRate', 'nyquistHz', 'device', 'processing',
    'settingsRaw', 'weighting', 'bands', 'fftSize', 'hash'];
  assert.deepEqual(first.head.map(META_KEY), allowed);
  for (const key of ['rows', 'intervalSec', 'sessions', 'sessionStartAt', 'silence', 'clockBreaks', 'engines']) {
    assert.ok(!first.head.some(l => META_KEY(l) === key), `ヘッダーに事後の値 ${key} がある`);
  }
});

test('ヘッダーの帯域の項目：定義は BAND_DEFS の順、上限はサンプルレートの半分、FFT の長さはワークレットが使った値', async () => {
  const { h, msgs } = scenario(true);
  const meta = sessionMetaOf();
  const head = partsOf(await recordAll(recordsOf(msgs, meta), meta)).head;
  assert.ok(head.includes('# format=mic-gain-logger/3'), head.join(' / '));
  assert.ok(head.includes(`# bands=${BAND_DEFS.map(d => d.lo + '-' + d.hi).join(',')}`), head.join(' / '));
  assert.ok(head.includes(`# nyquistHz=${RATE / 2}`), head.join(' / '));
  // FFT の長さは、ワークレットが ready で報告した値と同じ（logic.js の計画から取っている）
  assert.equal(h.ready.bands, true);
  assert.ok(head.includes(`# fftSize=${h.ready.fftSize}`), head.join(' / '));
  // 解釈（processing）と生の値（settingsRaw）を両方持つ
  assert.ok(head.includes('# processing=off'), head.join(' / '));
  assert.ok(head.some(l => l.startsWith('# settingsRaw=')), head.join(' / '));
  // 44.1kHz の端末では、超音波帯の上端（22kHz）がナイキストのすぐ下になる
  const m441 = buildSessionMeta({ contextSampleRate: 44100, bandsEnabled: true, settings: {} });
  const h441 = csvHeaderLines(chainHeaderMeta({ sessionMeta: m441, engineMode: ENGINE_WORKLET }));
  assert.ok(h441.includes(`# nyquistHz=${44100 / 2}`), h441.join(' / '));
});

test('帯域を計算しないとき（簡易モード）は fftSize を出さず、帯域の3列は空欄', async () => {
  const meta = sessionMetaOf();
  const recs = [0, 1].map(i => buildFallbackRecord({
    seq: i, db: -25, floorDb: -90, startTime: i, endTime: i + 1,
    startWallMs: ANCHOR.wallMs + i * 1000, endWallMs: ANCHOR.wallMs + (i + 1) * 1000,
    expectedSamples: RATE, intervalSec: 1, meta
  }));
  const p = partsOf(await recordAll(recs, meta, ENGINE_FALLBACK));
  assert.ok(p.head.includes('# engine=fallback'), p.head.join(' / '));
  // 列の意味（定義）は残す。FFT は動いていないので長さは出さない
  assert.ok(p.head.some(l => l.startsWith('# bands=')), p.head.join(' / '));
  assert.ok(!p.head.some(l => l.startsWith('# fftSize=')), p.head.join(' / '));
  for (const l of p.data) assert.deepEqual(l.split(',').slice(6, 9), ['', '', ''], l);
});

test('帯域を計算するか分からない測定条件では、# bands= も # fftSize= も出さない', () => {
  const m = buildSessionMeta({ contextSampleRate: RATE, settings: {} });
  assert.equal(m.bandsEnabled, null);
  const head = csvHeaderLines(chainHeaderMeta({ sessionMeta: m, engineMode: ENGINE_WORKLET }));
  assert.ok(!head.some(l => l.startsWith('# bands=') || l.startsWith('# fftSize=')), head.join(' / '));
});


// ---- ?bands=off ----

test('⭐?bands=off：帯域の3列は空欄、ヘッダーは # bands=off で # fftSize= は出ない。第1弾からの6列は帯域ありと同じ', async () => {
  const on = scenario(true);
  const off = scenario(false);
  assert.equal(off.h.ready.bands, false);
  const metaOn = sessionMetaOf();
  const metaOff = sessionMetaOf({ bandsEnabled: false });
  const pOn = partsOf(await recordAll(recordsOf(on.msgs, metaOn), metaOn));
  const pOff = partsOf(await recordAll(recordsOf(off.msgs, metaOff), metaOff));
  assert.ok(pOff.head.includes('# bands=off'), pOff.head.join(' / '));
  assert.ok(!pOff.head.some(l => l.startsWith('# fftSize=')), pOff.head.join(' / '));
  assert.equal(pOff.data.length, pOn.data.length);
  pOff.data.forEach((l, i) => {
    const c = l.split(',');
    assert.deepEqual(c.slice(6, 9), ['', '', ''], l);
    // 帯域を止めても、第1弾からの値（時刻・dbfs・seq・ピーク・クリップ・有効サンプル率）は変わらない
    assert.deepEqual(c.slice(0, 6), pOn.data[i].split(',').slice(0, 6), `区間 ${i}`);
  });
  assert.match(verifyLikeReadme(pOff.head.concat([CSV_COLUMNS.join(',')], pOff.data, pOff.trailer).join('\n')), /通りました/);
});


// ---- 欠測（count=0）の空欄化 ----

test('⭐音が1つも届かなかった区間は dbfs・peak_dbfs・clip が空欄、valid_ratio は 0.000。デジタル無音は -Infinity のまま', async () => {
  const { msgs } = scenario(true);
  const missing = msgs.filter(m => m.count === 0);
  const silent = msgs.filter(m => m.count > 0 && m.sumSq === 0);
  assert.equal(missing.length, 1, '筋書きに欠測の区間が1つ無い');
  assert.ok(silent.length >= 1, '筋書きにデジタル無音の区間が無い');
  const meta = sessionMetaOf();
  const p = partsOf(await recordAll(recordsOf(msgs, meta), meta));
  msgs.forEach((m, i) => {
    const c = p.data[i].split(',');
    if (m.count === 0) {
      assert.deepEqual([c[1], c[3], c[4]], ['', '', ''], `欠測の区間 ${i}: ${p.data[i]}`);
      assert.equal(c[5], '0.000');
    } else if (m.sumSq === 0) {
      assert.equal(c[1], '-Infinity', `無音の区間 ${i}`);
      assert.equal(c[3], '-Infinity');
      assert.equal(c[5], (m.count / m.expected).toFixed(3));
    } else {
      assert.equal(c[1], (10 * Math.log10(m.sumSq / m.count)).toFixed(2), `音の区間 ${i}`);
    }
  });
});

test('⭐欠測の区間は統計（Leq・最大・最小）に入れない。無音として数えると Leq が下がる', () => {
  const { msgs } = scenario(true);
  const recs = recordsOf(msgs, sessionMetaOf());
  const stats = createStats();
  for (const r of recs) addStatsRecord(stats, r);
  // 素朴な計算：届いた区間（count>0）だけの、区間長で重み付けしたエネルギー平均。
  // wAll は欠測の区間も含めた時間（改修前のように欠測を無音＝電力0として数えたときの分母）
  let e = 0;
  let w = 0;
  let wAll = 0;
  for (const m of msgs) {
    const len = (m.endFrame - m.startFrame) / RATE;
    wAll += len;
    if (!(m.count > 0)) continue;
    e += (m.sumSq / m.count) * len;
    w += len;
  }
  const want = 10 * Math.log10(e / w);
  assert.ok(Math.abs(statsLeq(stats) - want) < 1e-9, `${statsLeq(stats)} / ${want}`);
  // 改修前のように無音（電力0）として数えた場合との差（分母に欠測の時間が入る）
  const asSilence = 10 * Math.log10(e / wAll);
  assert.ok(statsLeq(stats) - asSilence > 0.5, '欠測を無音として数えたときと差が出ていない');
  assert.equal(stats.n, msgs.filter(m => m.count > 0).length);
  assert.equal(stats.missingN, 1);
  // 記録の穴としては数える（有効サンプル率 0）
  const v = statsIntegrity(stats);
  assert.equal(v.level, 'warn');
  assert.match(v.text, /最小0\.000/);
  assert.ok(statsWarnings(stats).some(s => /1区間は音が1つも届かず/.test(s)), statsWarnings(stats).join(' / '));
});

test('README の Excel の手順（欠測の行は重みを0にする）で、CSV から画面と同じ Leq が出る', async () => {
  const { msgs } = scenario(true);
  const meta = sessionMetaOf();
  const recs = recordsOf(msgs, meta);
  const stats = createStats();
  for (const r of recs) addStatsRecord(stats, r);
  const p = partsOf(await recordAll(recs, meta));
  // 第三者の手順：K列＝timestamp の差（境界の行は # intervalSec= の値）、B列が空欄の行は K列を0。
  // 空のセルは0として扱われるので POWER(10,0)=1 になるが、重み0を掛けるので入らない
  const run = Number(p.trailer.find(l => l.startsWith('# intervalSec=')).split('=')[1].split('@')[0]);
  const starts = new Set(p.trailer.find(l => l.startsWith('# sessionStartAt=')).split('=')[1].split(',').map(Number));
  let e = 0;
  let w = 0;
  p.data.forEach((l, i) => {
    const c = l.split(',');
    let k = starts.has(Number(c[2])) ? run : (Date.parse(c[0]) - Date.parse(p.data[i - 1].split(',')[0])) / 1000;
    if (c[1] === '') k = 0;
    const b = c[1] === '' ? 0 : (c[1] === '-Infinity' ? -999 : Number(c[1]));
    e += k * Math.pow(10, b / 10);
    w += k;
  });
  const fromCsv = 10 * Math.log10(e / w);
  // CSV の dbfs は小数2桁に丸めてあるので、画面の表示（小数1桁）の範囲で一致する
  assert.equal(fromCsv.toFixed(1), statsLeq(stats).toFixed(1));
  // 重みを0にしないと、空欄が 0 dBFS として入って大きく外れる
  let e2 = 0;
  let w2 = 0;
  p.data.forEach((l, i) => {
    const c = l.split(',');
    const k = starts.has(Number(c[2])) ? run : (Date.parse(c[0]) - Date.parse(p.data[i - 1].split(',')[0])) / 1000;
    const b = c[1] === '' ? 0 : (c[1] === '-Infinity' ? -999 : Number(c[1]));
    e2 += k * Math.pow(10, b / 10);
    w2 += k;
  });
  assert.ok(10 * Math.log10(e2 / w2) - statsLeq(stats) > 3, '空欄を0として入れても外れないなら、この手順の注意は要らない');
});

test('欠測の区間だけなら、トレーラーに # silence= は出ない（欠測は無音ではない）', () => {
  const rec = buildIntervalRecord({
    type: 'interval', seq: 0, sampleRate: RATE, startFrame: 0, endFrame: RATE,
    expected: RATE, count: 0, sumSq: 0, peak: 0, clip: 0, clipRun: 0, emittedAt: 1
  }, ANCHOR, -90, { meta: sessionMetaOf() });
  assert.ok(!csvTrailerLines([rec], {}).some(l => l.startsWith('# silence=')));
});


// ---- getSettings() の生の値 ----

test('⭐settingsRaw には、音の加工とサンプルレートの5項目だけを出し、deviceId・groupId は入れない', () => {
  const head = csvHeaderLines(chainHeaderMeta({ sessionMeta: sessionMetaOf(), engineMode: ENGINE_WORKLET }));
  const text = head.join('\n');
  assert.ok(!text.includes('DEVICE-ID-SHOULD-NOT-LEAK'), text);
  assert.ok(!text.includes('GROUP-ID-SHOULD-NOT-LEAK'), text);
  assert.ok(!/deviceId|groupId/.test(text), text);
  const raw = head.find(l => l.startsWith('# settingsRaw=')).slice('# settingsRaw='.length);
  assert.equal(raw, 'echoCancellation:false;autoGainControl:false;noiseSuppression:false;sampleRate:44100;channelCount:2');
});

test('settingsRaw：報告しない項目は unreported。区切りの文字を持ち込む値は崩れない形に寄せる', () => {
  // Safari（WebKit）は echoCancellation しか返さない作り
  const safari = sessionMetaOf({ settings: {
    autoGainControl: undefined, noiseSuppression: undefined, sampleRate: undefined, channelCount: undefined
  } });
  const raw = l => l.find(x => x.startsWith('# settingsRaw=')).slice('# settingsRaw='.length);
  const keys = ['echoCancellation', 'autoGainControl', 'noiseSuppression', 'sampleRate', 'channelCount'];
  const h1 = csvHeaderLines(chainHeaderMeta({ sessionMeta: safari, engineMode: ENGINE_WORKLET }));
  assert.equal(raw(h1), keys.map((k, i) => `${k}:${i === 0 ? 'false' : 'unreported'}`).join(';'));
  // 解釈のほうは unknown（生の値と解釈を両方持つ）
  assert.ok(h1.includes('# processing=unknown:autoGainControl+noiseSuppression'), h1.join(' / '));
  // 文字列の値（echoCancellation の "remote-only" など）はそのまま、区切りの文字は _ へ
  const odd = sessionMetaOf({ settings: { echoCancellation: 'remote-only', autoGainControl: 'a;b:c=d\ne' } });
  const r2 = raw(csvHeaderLines(chainHeaderMeta({ sessionMeta: odd, engineMode: ENGINE_WORKLET })));
  assert.ok(r2.startsWith('echoCancellation:remote-only;autoGainControl:a_b_c_d_e;'), r2);
  assert.equal(r2.split(';').length, keys.length, r2);
  // 測定条件が無ければ行を出さない
  assert.ok(!csvHeaderLines(chainHeaderMeta({})).some(l => l.startsWith('# settingsRaw=')));
});
