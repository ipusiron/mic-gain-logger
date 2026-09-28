'use strict';

// 既知振幅の正弦波を int16 へ量子化した列から dBFS を出し、
// 参照実装（impl/ref/day041/reference_dbfs.py）が機械生成した期待値と突き合わせる。
// 期待値は test/fixtures/expected_dbfs.json（手で書かない）。
// 同じ列を WAV にしたものが impl/ref/day041/wav/ にあり、ブラウザーの
// --use-file-for-fake-audio-capture で同じ値が出ることを実測で確かめている。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { rmsOf, rmsToDbfs } = require('../logic.js');

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'expected_dbfs.json'), 'utf8')
);

const INT16_SCALE = fixture.int16Scale;

// 参照実装と同じ手順でサンプル列を作り直す。
// 丸めは Math.floor(x + 0.5)（JavaScript の Math.round と同じ。Python 側もこれに合わせてある）
function quantizedSine(targetDbfs, freqHz, sampleRate, numSamples) {
  const amp = Math.pow(10, targetDbfs / 20) * Math.SQRT2;
  const out = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const x = amp * Math.sin(2 * Math.PI * freqHz * (i / sampleRate));
    let v = Math.floor(x * INT16_SCALE + 0.5);
    if (v > 32767) v = 32767;
    if (v < -32768) v = -32768;
    out[i] = v / INT16_SCALE;
  }
  return out;
}

function peakOf(samples) {
  let p = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > p) p = a;
  }
  return p;
}

for (const c of fixture.cases) {
  test(`dBFS 期待値との一致: ${c.name}`, () => {
    const samples = c.targetDbfs === null
      ? new Float32Array(c.numSamples)
      : quantizedSine(c.targetDbfs, c.freqHz, c.sampleRate, c.numSamples);

    const db = rmsToDbfs(rmsOf(samples));
    if (c.expectedDbfs === '-Infinity') {
      assert.equal(db, -Infinity);
    } else {
      // Float32 への丸めがあるので 0.0005 dB を許容する
      assert.ok(Math.abs(db - c.expectedDbfs) < 5e-4,
        `${c.name}: got ${db}, expected ${c.expectedDbfs}`);
    }

    const pk = peakOf(samples);
    assert.ok(Math.abs(pk - c.expectedPeak) < 1e-6,
      `${c.name} peak: got ${pk}, expected ${c.expectedPeak}`);
  });
}

test('無音はデジタル無音として -Infinity になる（行を残すかは段階2で扱う）', () => {
  assert.equal(rmsToDbfs(rmsOf(new Float32Array(4096))), -Infinity);
});

test('-40/-20 を半分ずつ混ぜた区間は、エネルギー平均と算術平均で 7dB 以上違う', () => {
  const s = fixture.step;
  const half = s.halfSamples;
  const a = quantizedSine(-40, fixture.freqHz, s.sampleRate, half);
  const b = quantizedSine(-20, fixture.freqHz, s.sampleRate, half);
  const merged = new Float32Array(half * 2);
  merged.set(a, 0);
  merged.set(b, half);

  const energyAvg = rmsToDbfs(rmsOf(merged));
  assert.ok(Math.abs(energyAvg - s.energyAverageDbfs) < 5e-4,
    `energy average: got ${energyAvg}, expected ${s.energyAverageDbfs}`);
  assert.ok(Math.abs(energyAvg - s.arithmeticMeanDbfs) > 7,
    'エネルギー平均と算術平均が区別できていない');
});
