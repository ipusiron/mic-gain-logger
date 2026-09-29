// Day041 - Mic Gain Logger / 純粋ロジック（DOM非依存）
// script.js から移した純関数だけを置く。ブラウザーでは通常のスクリプトとして、
// テストでは CommonJS の require で読む。

'use strict';

const MicGainLogic = (() => {
  // 値のクランプ
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

  // dBFS 表示→% 変換（表示下限=0%, 0dBFS=100%）
  function dbToPercent(db, floorDb = FLOOR_DB_DEFAULT) {
    const p = (db - floorDb) / (0 - floorDb);
    return clamp(p * 100, 0, 100);
  }

  // 時分秒
  function formatHMS(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    return [h, m, s].map(x => String(x).padStart(2, '0')).join(':');
  }

  // RMS→dBFS（振幅→dBFS にも同じ式を使う）
  function rmsToDbfs(rms) {
    if (rms <= 1e-8) return -Infinity;
    return 20 * Math.log10(rms);
  }

  // 画面の大きな数字（現在の音量）の窓。AnalyserNodeから毎フレーム読む直近のサンプル数である。
  // ⚠ 高精度モードのCSVのdbfs（区間全体のエネルギー平均）とは窓が違う（第2弾c0でヘルプ・title・READMEに書いた）。
  //    ときどき大きくなる音では、エネルギー平均が大きな瞬間に引っぱられるので、
  //    この窓の値のほうがCSVの値より低く見える時間が長くなる。
  //    簡易モードのCSVのdbfsは、記録した瞬間にこの窓から読んだ値なので、窓の違いは無い
  //    （script.jsのanimate()がcomputeDb()の値をそのままrecordFallbackIntervalへ渡している）
  const METER_WINDOW_SAMPLES = 2048;

  // 大きな数字の窓の長さ（ミリ秒）。サンプルレートで変わる（48kHzで約43ミリ秒）
  function meterWindowMs(sampleRate) {
    if (!(sampleRate > 0) || !Number.isFinite(sampleRate)) return null;
    return METER_WINDOW_SAMPLES / sampleRate * 1000;
  }

  // サンプル列の RMS
  function rmsOf(samples) {
    let sumSq = 0;
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];
      sumSq += x * x;
    }
    return Math.sqrt(sumSq / samples.length);
  }

  // 表示下限の許される範囲。
  // 0 以上を入れるとメーター幅が NaN%（＝CSSOM に拒否されて無言で凍結）になり、
  // 大型表示も「10.0 dBFS」という物理的にありえない正の dBFS を出していた。
  const FLOOR_DB_MIN = -120;
  const FLOOR_DB_MAX = -1;
  // 表示下限の既定値。
  // ⚠ 改修前（c7b6bad）は -60 だった。iPhone の実機テスト（2026-09-29）で、21kHz の
  //    トーン（-65dBFS）が静寂（-76dBFS）と同じく -60 に張り付いて表示され、
  //    「反応がない」と読まれた（CSVには正しく残っていた）。-90 にする（本人の判断）
  // ⚠ 第2弾c0から、-90は帯域を計算しないとき（?bands=off）の既定である。
  //    帯域を計算するときの既定はFLOOR_DB_DEFAULT_BANDS（-110）。決め方はfloorDbDefaultFor
  const FLOOR_DB_DEFAULT = -90;
  // 帯域を計算するとき（?bands=offでないとき）の既定値（第2弾c0）。
  // ⚠ b4（2026-09-29 本人のiPhone）で、静かな部屋の超音波帯は-93〜-107dBFS（行の中央値）だった。
  //    既定の-90より下なので、グラフの超音波帯の破線がいつも下端に張り付き、
  //    22kHzのトーン（静寂より+1.9dB）は画面で見えなかった（CSVには残っていた）。
  //    -110にする（本人の判断）。数dBの変化は数字（ultraNowText）で読む
  const FLOOR_DB_DEFAULT_BANDS = -110;

  // 表示下限の既定を、帯域を計算するかどうかで決める（第2弾c0）。
  // bandsEnabledはbandsEnabledFromQueryの値。false（?bands=off）なら従来の-90、それ以外は-110
  function floorDbDefaultFor(bandsEnabled) {
    return bandsEnabled === false ? FLOOR_DB_DEFAULT : FLOOR_DB_DEFAULT_BANDS;
  }

  // 表示下限の入力値を数値へ（空欄・非数は既定値。範囲外は丸める）。
  // fallbackは空欄・非数のときの値（floorDbDefaultForの値を渡す）。省略するとFLOOR_DB_DEFAULT
  function parseFloorDb(raw, fallback) {
    const def = Number.isFinite(fallback) ? clamp(fallback, FLOOR_DB_MIN, FLOOR_DB_MAX) : FLOOR_DB_DEFAULT;
    const v = parseFloat(raw);
    if (Number.isNaN(v)) return def;
    return clamp(v, FLOOR_DB_MIN, FLOOR_DB_MAX);
  }

  // メーターの目盛り（4本）。表示下限から作る。
  // ⚠ 改修前は -60 / -40 / -20 / 0 を HTML に固定で書いていた。表示下限を変えると
  //    目盛りだけが嘘になる。メーターの幅と同じく「下限〜0」を等分する
  function meterScaleLabels(floorDb) {
    const f = Number.isFinite(floorDb) ? floorDb : FLOOR_DB_DEFAULT;
    // 下限が浅い（-6より浅い）ときは整数に丸めると同じ数字が並ぶので、小数1桁で出す
    // （公開前の点検で、下限-1〜-2で目盛りが重複することが分かった）
    const fine = Math.abs(f) < 6;
    const fmt = (v) => {
      const r = fine ? Math.round(v * 10) / 10 : Math.round(v);
      return String(r || 0);   // -0 を 0 にする
    };
    return [f, f * 2 / 3, f / 3, 0].map(fmt);
  }

  // ログ間隔の入力値を秒へ（下限 0.2 秒）
  function parseIntervalSec(raw) {
    return Math.max(0.2, parseFloat(raw) || 1);
  }

  // ---- 統計 ----
  //
  // 母集団は「記録された行（区間）」である。
  // 改修前は requestAnimationFrame ごと（約60Hz）に集計していたので、
  // ログ間隔（既定1秒）で書かれる CSV とは母集団が違っていた。実測では
  // ログ間隔5秒・14秒の記録で、CSV は -20.0 が2行なのに画面の最小は
  // -39.1 dBFS、変動幅は 19.1 dB と出ていた。画面の値を CSV から組み直せない
  // なら、どちらが記録なのか受け取った側には決められない。
  //
  // ⚠ 平均は dB の算術平均ではなくエネルギー平均（Leq と同じ定義）にする。
  //    dB は対数なので算術平均には物理的な意味がなく、実測で最大26dBずれる。
  //      Leq = 10 * log10( (Σ T_i * 10^(db_i/10)) / Σ T_i )
  //    区間の代表値は段階1ですでにエネルギー平均なので、区間を連結すれば
  //    正しい Leq が出る。
  //
  // ⚠⚠ 重みは行数ではなく区間長（秒）である。
  //    ログ間隔は記録中に変えられる（CSV のトレーラーは `# intervalSec=1+3` の
  //    ように混在を明記している）。1秒の区間と3秒の区間を同じ重みで平均すると、
  //    短い区間が実時間に不相応な発言力を持って Leq が誤る。定義どおり
  //    「エネルギーの時間積分 ÷ 全時間」にすれば、間隔を途中で変えても
  //    実時間に比例した平均になる。
  //    区間長は startTime / endTime（オーディオクロック）の差で取る。取れない
  //    ときだけ重み1へ退化する（全区間が同じ長さなら行数平均と一致する）。
  //
  // 無音（-Infinity）の扱いを分けてある。
  //   平均（Leq）＝ 全行。無音は電力 0 として数える（これが定義どおり）
  //   最大・最小・変動幅 ＝ 有限値の行だけ。無音を入れると最小が -∞ になり、
  //                        変動幅が意味を失うため
  //
  // ⚠ 音が1つも届かなかった区間（count=0。CSV の dbfs は空欄）は、平均・最大・最小に入れない（第2弾b2）。
  //    改修前はこの区間の dbfs を -Infinity（デジタル無音）として書き、Leq にも電力0として入れていた。
  //    測っていない時間を無音として数えると Leq が下がり、「音が無かった」と「記録していなかった」も
  //    区別できない。区間の数（missingN）と有効サンプル率（0）には数えるので、記録の穴としては画面に出る。
  //
  // サンプルピーク・クリップ数・有効サンプル率は、段階1から区間レコードに入って
  // いたのに CSV にしか出ていなかった。どれも記録の信用に直結するので画面へ出す。
  // ピークは統計の項目、クリップと欠測は注意書き（statsWarnings）へ回す。
  //
  // 超音波帯の最大（第2弾b3）＝band_ultra_dbfsの最大。値の無い行（簡易モード・?bands=off・
  // 数えたフレームが0・その帯域にビンが無い）は除く。平均（Leq）は出さない（画面で見せるのは
  // 「その帯域にエネルギーがあった区間の最大」までで、何の音かは分からない）。
  // ⚠ デジタル無音の行（dbfsが-Infinity）に付いた帯域の値も数える。帯域のフレームは「終わりを含む区間」に
  //    数えるので、区間の境目の前の約21ミリ秒の実際の音が、後ろの区間の値に入ることがある
  //    （READMEの「帯域の列」）。架空の値ではないので外さない。欠測の行（dbfsが空欄）に付いた値も、同じ理由で数える。
  // 帯域の有効率（band_valid_ratio）は、有効サンプル率と同じ数え方で、1.0を下回った区間を注意書きへ回す。

  function dbToPower(db) {
    if (db === -Infinity) return 0;
    return Math.pow(10, db / 10);
  }

  function powerToDb(power) {
    if (!(power > 0)) return -Infinity;
    return 10 * Math.log10(power);
  }

  function createStats() {
    return {
      powerSum: 0,          // Σ T_i * 10^(db_i/10)（エネルギーの時間積分）
      weightSec: 0,         // Σ T_i（重みの総和＝記録された実時間）
      n: 0,
      finiteN: 0,
      silentN: 0,
      missingN: 0,          // 音が1つも届かなかった区間の数（n に入れない。第2弾b2）
      minDb: Infinity,
      maxDb: -Infinity,
      peakMaxDb: -Infinity, // 区間のサンプルピークの最大（RMS とは別物）
      peakKnownN: 0,        // ピークが分かっている行数（簡易モードでは 0 のまま）
      clipRows: 0,          // クリップを含む区間の数
      clipSamples: 0,       // クリップしたサンプルの延べ数
      clipRunMax: 0,        // クリップが続いた最長のサンプル数（単発と連続の区別）
      clipRunKnownN: 0,     // 連続の長さが分かっている行数（簡易モードでは 0 のまま）
      sampleTotal: 0,       // 記録した全サンプル数（クリップの割合の分母）
      validKnownN: 0,       // 有効サンプル率が分かっている行数
      lowValidRows: 0,      // 有効サンプル率が 1.0 を下回った区間の数
      minValidRatio: Infinity,
      ultraKnownN: 0,       // 超音波帯の値がある行数（-Infinityを含む。第2弾b3）
      ultraMaxDb: -Infinity, // 超音波帯の値の最大（band_ultra_dbfsの最大）
      bandValidKnownN: 0,   // 帯域の有効率が分かっている行数
      lowBandValidRows: 0,  // 帯域の有効率が1.0を下回った区間の数
      minBandValidRatio: Infinity
    };
  }

  // 区間レコードの長さ（秒）。オーディオクロックの差で取る。取れなければ null
  function recordDurationSec(rec) {
    if (!rec) return null;
    const d = rec.endTime - rec.startTime;
    return (Number.isFinite(d) && d > 0) ? d : null;
  }

  // 区間長が取れないときだけ重み1へ退化する
  function statsWeightOf(durationSec) {
    return (Number.isFinite(durationSec) && durationSec > 0) ? durationSec : 1;
  }

  // 1区間ぶんを取り込む。取り込んだら true（数値にならないものだけ false）。
  // durationSec は区間長（秒）。省略すると重み1（等重み）になる
  function addStatsSample(stats, db, durationSec) {
    // ⚠ null（欠測の区間の dbfs）を数値として通さない。10^(null/10) は 1＝0 dBFS として入ってしまう
    if (typeof db !== 'number' || Number.isNaN(db)) return false;
    if (db === Infinity) return false;
    const w = statsWeightOf(durationSec);
    stats.powerSum += dbToPower(db) * w;
    stats.weightSec += w;
    stats.n += 1;
    if (Number.isFinite(db)) {
      stats.finiteN += 1;
      stats.minDb = Math.min(stats.minDb, db);
      stats.maxDb = Math.max(stats.maxDb, db);
    } else {
      stats.silentN += 1;
    }
    return true;
  }

  // 区間レコードを1件取り込む。画面の統計はこの経路だけを通す。
  // 重み（区間長）と、CSV にしか出ていなかった3値をまとめてここで拾う
  function addStatsRecord(stats, rec) {
    if (!rec) return false;
    if (rec.missing === true) {
      // 音が1つも届かなかった区間（第2弾b2）。平均・最大・最小には入れず、区間の数と有効サンプル率だけ数える。
      // ピーク・クリップは null なので、下の判定を通っても数えられない
      stats.missingN += 1;
    } else if (!addStatsSample(stats, rec.rawDb, recordDurationSec(rec))) {
      return false;
    }
    // 無音の区間もピークは分かっている（振幅0＝-∞ dBFS）。
    // 簡易モードは瞬時値しか無いので null が来る＝「不明」
    if (typeof rec.peakDb === 'number' && !Number.isNaN(rec.peakDb)) {
      stats.peakKnownN += 1;
      stats.peakMaxDb = Math.max(stats.peakMaxDb, rec.peakDb);
    }
    if (Number.isFinite(rec.clipCount) && rec.clipCount > 0) {
      stats.clipRows += 1;
      stats.clipSamples += rec.clipCount;
    }
    if (Number.isFinite(rec.clipRunMax)) {
      stats.clipRunKnownN += 1;
      stats.clipRunMax = Math.max(stats.clipRunMax, rec.clipRunMax);
    }
    if (Number.isFinite(rec.sampleCount)) stats.sampleTotal += rec.sampleCount;
    if (Number.isFinite(rec.validRatio)) {
      stats.validKnownN += 1;
      stats.minValidRatio = Math.min(stats.minValidRatio, rec.validRatio);
      // count と expected はどちらも整数なので、欠測が無ければちょうど 1 になる
      if (rec.validRatio < 1) stats.lowValidRows += 1;
    }
    // 超音波帯の値（第2弾b3）。デジタル無音・欠測の行に付いた値も数える（上の「超音波帯の最大」）
    const ultra = ultraDbOf(rec);
    if (ultra !== null) {
      stats.ultraKnownN += 1;
      stats.ultraMaxDb = Math.max(stats.ultraMaxDb, ultra);
    }
    if (Number.isFinite(rec.bandValidRatio)) {
      stats.bandValidKnownN += 1;
      stats.minBandValidRatio = Math.min(stats.minBandValidRatio, rec.bandValidRatio);
      // 数えたフレーム数と数えるはずだったフレーム数はどちらも整数なので、落としたフレームが無ければちょうど1になる
      if (rec.bandValidRatio < 1) stats.lowBandValidRows += 1;
    }
    return true;
  }

  // 区間レコードの超音波帯の値（dBFS）。値が無ければnull（-Infinityは測った値なので返す）
  function ultraDbOf(rec) {
    const v = (rec && rec.bandDb) ? rec.bandDb[BAND_ULTRA_KEY] : null;
    return (typeof v === 'number' && !Number.isNaN(v) && v !== Infinity) ? v : null;
  }

  // 統計の「超音波帯の最大」の表示（第2弾b3）。
  // 値のある行が無ければ「--.- dBFS」（簡易モード・?bands=off・まだ記録が無い）。測れないものを「異常なし」として出さない。
  // -Infinityだけなら、サンプルピークと同じく「-∞ dBFS」と出す（デジタル無音を測った結果である）
  function formatUltraMax(stats) {
    if (!stats || !(stats.ultraKnownN > 0)) return '--.- dBFS';
    return formatDbCell(stats.ultraMaxDb);
  }

  // 記録された行から Leq を出す。記録が無ければ null
  function statsLeq(stats) {
    if (!stats.n) return null;
    const w = stats.weightSec > 0 ? stats.weightSec : stats.n;
    return powerToDb(stats.powerSum / w);
  }

  function formatDbCell(db) {
    if (db === -Infinity) return '-∞ dBFS';
    if (!Number.isFinite(db)) return '--.- dBFS';
    return `${db.toFixed(1)} dBFS`;
  }

  function formatStats(stats, logCount) {
    const leq = statsLeq(stats);
    const hasFinite = stats.finiteN > 0;
    const rng = hasFinite ? (stats.maxDb - stats.minDb) : null;
    return {
      avg: leq === null ? '--.- dBFS' : formatDbCell(leq),
      max: hasFinite ? formatDbCell(stats.maxDb) : '--.- dBFS',
      min: hasFinite ? formatDbCell(stats.minDb) : '--.- dBFS',
      range: rng === null ? '--.- dB' : `${rng.toFixed(1)} dB`,
      peak: stats.peakKnownN > 0 ? formatDbCell(stats.peakMaxDb) : '--.- dBFS',
      count: String(logCount)
    };
  }

  // クリップがこのサンプル数以上続いたら「連続」と呼ぶ（このツールの区切り）
  const CLIP_RUN_SUSTAINED = 3;

  // クリップの割合を画面向けに（ごく少ないときは「未満」で言う）
  function formatShare(share) {
    const pct = share * 100;
    if (pct >= 1) return `${pct.toFixed(1)}%`;
    if (pct >= 0.01) return `${pct.toFixed(2)}%`;
    return '0.01%未満';
  }

  // 記録の信用を落とす出来事だけを文にする。無ければ空配列。
  //
  // ⚠ クリップは、単発と連続を言い分ける（第2弾a5）。
  //    波形が ±1.0 で続けて頭打ちになった区間は、RMS も帯域ごとの値も本来の音と
  //    違う（頭が削れ、そこで生まれた高調波が広い帯域へ散る）。一方、1〜2サンプルだけ
  //    1.0 に届いた単発は、区間の値への影響が小さい。改修前は1サンプルでも
  //    「その区間の値は読めません。入力レベルを下げて採り直してください」と出し、
  //    延べの数を分母なしで出していた。iPhone のブラウザーには入力音量を下げる
  //    手段が無いので、助言も実行できなかった。
  // 有効サンプル率は欠測の目安である。1.0 を下回った区間は、その区間の音の
  // 一部が届いていない（オーディオスレッドがレンダークォンタムを落とした）。
  // 注意の項目を、要点（short）と全文（full）の組で返す。
  // 要点は画面の要約の1行に並べ、全文は開いて読む（第2弾a6）
  function statsWarningItems(stats) {
    const out = [];
    if (!stats) return out;
    if (stats.clipRows > 0) {
      const share = stats.sampleTotal > 0
        ? `＝記録した全サンプルの${formatShare(stats.clipSamples / stats.sampleTotal)}`
        : '';
      let text = `クリップを${stats.clipRows}区間で検出しました（延べ${stats.clipSamples}サンプル${share}）。`;
      if (stats.clipRunKnownN > 0) {
        text += stats.clipRunMax >= CLIP_RUN_SUSTAINED
          ? `連続して頭打ちになった箇所があります（最長${stats.clipRunMax}サンプル）。`
            + 'その区間は波形がつぶれていて、値は本来の音と違います。'
          : `いずれも単発（連続${CLIP_RUN_SUSTAINED}サンプル未満）で、区間の値への影響は小さいと見られます。`;
      }
      // ⚠ 原因は決めつけない。単発でも、接触・操作音のような突発音のほかに、
      //    大きな音の波の山が 1.0 に触れているだけのこともある（疑似マイクのトーンで
      //    全サンプルの 0.97% が単発で 1.0 に触れた）
      text += 'マイクへの接触・端末の操作音・風や息のほか、音が大きすぎて波の山が1.0に届いている場合があります。'
        + '後者なら端末を音源から離してください';
      const kind = stats.clipRunKnownN > 0
        ? (stats.clipRunMax >= CLIP_RUN_SUSTAINED ? '（連続あり）' : '（単発のみ）')
        : '';
      out.push({ short: `クリップ${stats.clipRows}区間${kind}`, full: text });
    }
    if (stats.lowValidRows > 0) {
      const pct = (stats.minValidRatio * 100).toFixed(1);
      // 音が1つも届かなかった区間は、無音と取り違えないように別に言う（第2弾b2）
      const missing = stats.missingN > 0
        ? `。うち${stats.missingN}区間は音が1つも届かず、CSVの dbfs を空欄にしています（無音とは別で、平均には入れません）`
        : '';
      out.push({
        short: `有効サンプル率 最小${pct}%`,
        full: `有効サンプル率が1.0を下回った区間が${stats.lowValidRows}件あります（最小 ${pct}%）。`
          + 'その区間は音の一部が届いていません（CSVの valid_ratio 列に残ります）' + missing
      });
    }
    // 帯域の有効率（第2弾b3）。書き方は有効サンプル率の項目にそろえる。
    // 1.0を下回るのは、クォンタムが落ちた・入力が空で届いたときに、そのサンプルを含むフレームを数えなかったとき
    if (stats.lowBandValidRows > 0) {
      const pct = (stats.minBandValidRatio * 100).toFixed(1);
      out.push({
        kind: 'bandValid',
        short: `帯域の有効率 最小${pct}%`,
        full: `帯域の有効率が1.0を下回った区間が${stats.lowBandValidRows}件あります（最小 ${pct}%）。`
          + 'その区間の帯域の値には、計算に入らなかった時間があります（CSVのband_valid_ratio列に残ります）'
      });
    }
    return out;
  }

  // 全文だけの一覧（既存の呼び方）
  function statsWarnings(stats) {
    return statsWarningItems(stats).map(it => it.full);
  }

  // 要約の1行。件数と要点を並べる（項目が無ければ空）
  function noticeSummary(items) {
    if (!items || !items.length) return '';
    return `記録の注意 ${items.length}件：${items.map(it => it.short).join('／')}`;
  }

  // 記録に穴が無いことも、画面に出す。
  //
  // ⚠ 改修前は statsWarnings だけだったので、クリップや欠測があるときしか
  //    何も出なかった（片側表示）。「欠測のない記録」を名乗る道具なのに、
  //    穴が無いことを画面が言わないのでは、利用者は確かめようがない。
  //    穴の有無を必ず1行で言い切る。
  //
  // level = 'none'（記録がまだ無い）/ 'ok'（穴なし）/ 'warn'（穴あり）
  //       / 'unknown'（簡易モードの行だけで、測れていない）
  function statsIntegrity(stats) {
    // 区間の数には、音が1つも届かなかった区間（平均に入れない。第2弾b2）も入れる
    const total = stats ? stats.n + (stats.missingN || 0) : 0;
    if (!total) return { level: 'none', text: '' };
    const known = stats.validKnownN;
    const unknown = total - known;
    // 簡易モードの行は、クリップ数も有効サンプル率も測れない（瞬時値しか無い）
    if (known === 0) {
      return {
        level: 'unknown',
        text: `記録の穴は確かめられません（簡易モードの${total}区間だけなので、`
          + 'クリップ数も有効サンプル率も測れません）'
      };
    }
    // ⚠ 2つの観点は別々に言う。片方に穴があっても、もう片方は
    //    「無かった」と言い切れる（実測でクリップ5区間・欠測0区間の記録が出た）。
    //    改修前はここで「有効サンプル率が1.000未満の区間0件・最小1.000」という、
    //    穴が無いのに穴があるように読める文を出していた
    const clipPart = stats.clipRows > 0
      ? `クリップ${stats.clipRows}区間`
      : 'クリップ0区間';
    const pct = Number.isFinite(stats.minValidRatio)
      ? stats.minValidRatio.toFixed(3)
      : '--';
    const validPart = stats.lowValidRows > 0
      ? `有効サンプル率が1.000未満の区間${stats.lowValidRows}件・最小${pct}`
      : `有効サンプル率は${known}区間すべて1.000`;
    const tail = unknown > 0 ? `／簡易モードの${unknown}区間は測れません` : '';
    const clean = stats.clipRows === 0 && stats.lowValidRows === 0;
    return {
      level: clean ? 'ok' : 'warn',
      text: `${clean ? '記録の穴なし' : '記録に穴あり'}`
        + `（${clipPart}／${validPart}）${tail}`
    };
  }

  function emptyStatsText() {
    return {
      avg: '--.- dBFS',
      max: '--.- dBFS',
      min: '--.- dBFS',
      range: '--.- dB',
      peak: '--.- dBFS',
      count: '0'
    };
  }

  // ---- 操作ボタン（第2弾c0）----
  //
  // 設計書§3のQ3（本人の決定 2026-09-29）＝開始と停止を1つの場所にまとめ、書き出しとリセットは「その他」へ寄せる。
  // 改修前は幅430pxで、ヘッダーとボタンが画面の上から242.6px（26%）を使っていた
  // （ヘッダー → ヘルプとテーマの行 → 記録開始・停止の行 → 書き出し・リセットの行）。
  //
  // ・記録開始（#startBtn）と停止（#stopBtn）は同じ場所に置き、そのとき押せるほうだけを見せる。
  //   見せないほうはhidden属性で隠し、支援技術からも隠す。IDは変えない（テストと測定のスクリプトが使っている）
  // ・CSV書き出し（#exportBtn）と統計リセット（#resetBtn）は、幅480px以下では「その他」（#moreBtn）で開く場所
  //   （#moreMenu）へまとめる。481px以上ではこれまでどおり並べる。押せる条件は変えない
  //   （script.jsのupdateButtonStates。記録中・接続中は押せない）
  // ・ヘルプとテーマの切り替えは、幅480px以下でも同じ行に置く。改修前はhandleMobileButtonLayoutが
  //   480pxを境に親要素を付け替えていたが、resizeが届かない経路で不整合が固定される壊れやすい仕組みだったので、
  //   第2弾c0で廃止し、並びはCSSだけで決める

  // 幅480px以下（「その他」で畳む幅）。style.cssの@media (max-width: 480px)と同じ値
  const COMPACT_MEDIA_QUERY = '(max-width: 480px)';

  // 記録開始と停止のどちらを見せるか。
  // 接続中（許可ダイアログを待っているあいだ）は「停止」で取り消せるので、停止を見せる
  function startStopView(flags) {
    const f = flags || {};
    const busy = !!(f.running || f.connecting);
    return { start: !busy, stop: busy };
  }

  // 「その他」の開閉。state = { open, compact, modalOpen, itemsEnabled, focusInside, focusOnToggle }
  // （focusInside＝フォーカスが中身（#moreMenu）にある、focusOnToggle＝フォーカスが「その他」にある）、
  // event = 'toggle'（「その他」を押した）/ 'escape'（Esc）/ 'outside'（「その他」と中身の外を押した）
  //       / 'items'（中のボタンの押せる状態が変わった）/ 'layout'（幅が変わった）。
  // 戻り値 = { open, focusToggle }。focusToggleがtrueなら「その他」へフォーカスを戻す。
  // ⚠ Escで閉じたら、フォーカスを「その他」に戻す（閉じた中身にフォーカスを残さない）。
  //    戻すのは、フォーカスが中身か「その他」にあったときだけ。Tabで外（ヘルプ・設定の入力欄など）へ移ったあとの
  //    Escでは、閉じるだけでフォーカスを動かさない（ほかの場所にある利用者のフォーカスを奪わない。
  //    第2弾c0の点検で直した。外からでも「その他」へ移していたので、設定の入力欄にいた利用者の画面が先頭まで戻った）。
  //    幅481px以上では「その他」を出さず中身を並べているので、Escでは何もしない。
  //    ヘルプを開いているあいだのEscはヘルプを閉じるためのものなので、ここでは受けない。
  // ⚠ 中のボタンがどちらも押せなくなったら（統計リセットのあと・記録を始めたとき）閉じる。
  //    押せないボタンにフォーカスが残るので、中にフォーカスがあったときだけ「その他」へ戻す
  function moreMenuNext(state, event) {
    const s = state || {};
    const open = !!s.open;
    const stay = { open, focusToggle: false };
    if (event === 'toggle') return { open: !open, focusToggle: false };
    if (event === 'escape') {
      if (!open || !s.compact || s.modalOpen) return stay;
      return { open: false, focusToggle: !!(s.focusInside || s.focusOnToggle) };
    }
    if (event === 'outside') return { open: false, focusToggle: false };
    if (event === 'items') {
      if (!open || s.itemsEnabled) return stay;
      return { open: false, focusToggle: !!(s.compact && s.focusInside) };
    }
    if (event === 'layout') {
      if (!open || s.compact) return stay;
      return { open: false, focusToggle: false };
    }
    return stay;
  }

  // ---- キャンバスの大きさ ----
  //
  // getBoundingClientRect() は非整数を返す（ブラウザーのズーム 90/110/133%、
  // スマートフォンの幅）。改修前はその値をそのまま `new Array(WIDTH)` へ渡していて
  // RangeError: Invalid array length になった。しかも例外が resizeCanvas() の
  // 途中で飛ぶため、呼び出し元の drawSeries() と handleMobileButtonLayout() まで
  // 巻き添えで実行されない連鎖故障になっていた。整数へ丸めてから使う。
  //
  // cssW/cssH は描画で使う論理サイズ、pixelW/pixelH は canvas の内部解像度
  // （dpr 倍）である。表示上の大きさは CSS が決めるので、ここでは返さない。
  function canvasPixelSize(rectW, rectH, dpr) {
    const ratio = (Number.isFinite(dpr) && dpr > 0) ? dpr : 1;
    const cssW = Math.max(1, Math.round(Number.isFinite(rectW) ? rectW : 1));
    const cssH = Math.max(1, Math.round(Number.isFinite(rectH) ? rectH : 1));
    return {
      cssW,
      cssH,
      pixelW: Math.max(1, Math.round(cssW * ratio)),
      pixelH: Math.max(1, Math.round(cssH * ratio))
    };
  }

  // ---- グラフ（時間軸）----
  //
  // 改修前は「1フレーム＝1px」で左へ流す実装だった。1px の意味する時間が
  // リフレッシュレート（60Hz / 120Hz）とタブの非アクティブ化で変わるので、
  // 横軸が時間になっていない。目盛りもラベルも無かった。
  // 段階1で時刻がオーディオクロックに乗ったので、ここで横軸を実時間にする。
  //
  // ⚠ 点は dB 値のまま持つ。改修前は 0..1 へ正規化してから積んでいたため、
  //    記録中に表示下限を変えると、過去の点だけ古い正規化のまま残っていた。

  const GRAPH_WINDOW_SEC = 60;   // 横軸に映す長さ（秒）
  const GRAPH_TOP_DB = 0;        // 縦軸の上端（dBFS の最大は 0）

  // 目盛りとラベルのぶんだけ内側へ寄せた描画領域。
  // 狭い画面では余白を詰める（スマートフォンでは高さ 120px しかない）。
  function graphArea(width, height) {
    const left = width < 360 ? 28 : 40;
    const right = 8;
    const top = 8;
    const bottom = height < 160 ? 14 : 18;
    return {
      x: left,
      y: top,
      w: Math.max(1, width - left - right),
      h: Math.max(1, height - top - bottom)
    };
  }

  // 時刻 → x 座標（右端が「いま」、左端が windowMs 前）
  function timeToX(tMs, nowMs, windowMs, area) {
    const span = windowMs > 0 ? windowMs : 1;
    const ago = clamp((nowMs - tMs) / span, 0, 1);
    return area.x + area.w * (1 - ago);
  }

  // dBFS → y 座標。無音（-Infinity）は下端へ置く
  function dbToY(db, floorDb, topDb, area) {
    if (!Number.isFinite(db)) return area.y + area.h;
    const span = (topDb - floorDb) || 1;
    const t = clamp((db - floorDb) / span, 0, 1);
    return area.y + area.h * (1 - t);
  }

  // 目盛りの間隔。本数がおおむね6本以下に収まる刻みを選ぶ
  function timeTickStepSec(windowSec) {
    const candidates = [1, 2, 5, 10, 15, 30, 60, 120, 300];
    for (let i = 0; i < candidates.length; i++) {
      if (windowSec / candidates[i] <= 6) return candidates[i];
    }
    return Math.ceil(windowSec / 6);
  }

  // 右端を 0 秒前として、左へ step 秒ずつ
  function timeTicks(windowSec, stepSec) {
    const step = stepSec > 0 ? stepSec : timeTickStepSec(windowSec);
    const out = [];
    for (let ago = 0; ago <= windowSec + 1e-9; ago += step) {
      const a = Math.round(ago * 1000) / 1000;
      out.push({ agoSec: a, label: a === 0 ? '0s' : `-${a}s` });
    }
    return out;
  }

  function dbTickStep(spanDb) {
    const candidates = [1, 2, 5, 10, 20, 30, 50];
    for (let i = 0; i < candidates.length; i++) {
      if (spanDb / candidates[i] <= 6) return candidates[i];
    }
    return Math.ceil(spanDb / 6);
  }

  // 上端（0 dBFS）から下へ。表示下限そのものは必ず1本入れる
  function dbTicks(floorDb, topDb, stepDb) {
    const span = topDb - floorDb;
    const step = stepDb > 0 ? stepDb : dbTickStep(span > 0 ? span : 1);
    const out = [];
    for (let v = topDb; v >= floorDb - 1e-9; v -= step) {
      out.push(Math.round(v * 100) / 100);
    }
    if (!out.length || Math.abs(out[out.length - 1] - floorDb) > 1e-9) {
      // 下限のすぐ手前（刻みの半分以内）の目盛りは間引く。残すとラベルが重なる
      // （下限 -90・刻み 20 で -80 と -90 が 10dB しか離れず、スマートフォン幅で重なった）
      if (out.length > 1 && out[out.length - 1] - floorDb <= step / 2) out.pop();
      out.push(floorDb);
    }
    return out.map(db => ({ db, label: String(Math.round(db)) }));
  }

  // 窓の外へ出た点を落とす。線が左端まで届くように、窓の外の直近1点は残す
  // グラフの点を、記録された区間から作る。
  //
  // ⚠ 点は記録（CSVの行）と同じ源から積む。
  // 改修前は requestAnimationFrame の中で積んでいたため、タブが裏に回る・画面が
  // ロックされる・CPUが詰まると点が積まれず、再開したときに前後の点が1本の直線で
  // 結ばれていた。記録は AudioWorklet のクロックで穴なく続いているのに、
  // グラフだけが「測っていない時間」を直線で描いていたことになる。
  //
  // gap は「前の点から続いていない」という印である。描画側で線を切るために使う。
  // 記録を止めて再開したとき、区間が飛んだとき、時刻の跳びがあったときに立つ。
  //
  // ⚠ 記録の停止・再開は、時間差ではなくセッションの切り替わり（metaId）で見る。
  //    時間差だけで推し量っていたころは、停止してすぐ再開すると差が区間長の
  //    1.5倍に収まり、停止中の空白をまたいで線がつながった（再開後の最初の行は
  //    再開から1区間後に出るので、許容幅は実質「区間長×0.5」。10秒間隔なら5秒）
  //
  // 点は本体の音量（db＝rawDb）と超音波帯の値（ultraDb＝band_ultra_dbfs。第2弾b3）の2つを持つ。
  // どちらも値が無ければnullのまま持ち、線を切るかどうかはgraphLinePointsが決める
  function seriesPointOf(rec, prev, intervalMs) {
    const tMs = rec.ts.getTime();
    const span = (Number.isFinite(intervalMs) && intervalMs > 0) ? intervalMs : 1000;
    const sid = rec.metaId || null;
    const gap = !prev
      || (tMs - prev.tMs) > span * 1.5
      || !!rec.clockBreakKind
      || (prev.sid || null) !== sid;
    return { tMs, db: rec.rawDb, ultraDb: ultraDbOf(rec), gap, sid };
  }

  // 折れ線の線の形（第2弾b3）。本体の音量は実線、超音波帯は破線にして、色だけに頼らず見分けられるようにする。
  // 凡例（index.htmlのSVGのstroke-dasharray）も同じ値にする（test/band-ui.test.jsが見ている）
  const GRAPH_LINE_STYLES = Object.freeze({
    level: Object.freeze({ width: 2, dash: Object.freeze([]) }),
    ultra: Object.freeze({ width: 2, dash: Object.freeze([6, 4]) })
  });

  // 折れ線に描く点を組み立てる（第2弾b3）。
  // seriesの各点からkeyの値（'db'＝本体の音量、'ultraDb'＝超音波帯）を取り、描ける点だけを
  // { x, y, gap, alone }で返す。viewは{ nowMs, windowMs, floorDb, topDb, area }。
  //   gap    前の点とつながない（描画側はmoveTo）。点そのもののgap（セッションの切り替わり・区間の飛び・
  //          時刻の跳び）に加え、直前の点に値が無かったときに立てる
  //   alone  前後どちらともつながらない点。線にならないので、描画側が小さな丸で描く
  //          （値のある区間が値の無い区間に挟まれると、線だけでは見えなくなるため）
  // ⚠ 値が無い点（null・undefined・NaN）は描かず、そこで線を切る。第2弾b2までは、欠測の行（rawDbがnull）を
  //    dbToYが下端に置いていたので、欠測がデジタル無音と同じ下端の線に見えていた。
  //    超音波帯も同じで、値の無い区間（簡易モード・?bands=off・数えたフレームが0）は線を切る。
  //    デジタル無音（-Infinity）は測った値なので、これまでどおり下端に描く
  function graphLinePoints(series, key, view) {
    const v = view || {};
    const out = [];
    let prevDrawn = false;
    for (const p of series || []) {
      const val = p ? p[key] : undefined;
      const drawable = typeof val === 'number' && !Number.isNaN(val) && val !== Infinity;
      if (!drawable) {
        prevDrawn = false;
        continue;
      }
      out.push({
        x: timeToX(p.tMs, v.nowMs, v.windowMs, v.area),
        y: dbToY(val, v.floorDb, v.topDb, v.area),
        gap: !prevDrawn || !!p.gap,
        alone: false
      });
      prevDrawn = true;
    }
    for (let i = 0; i < out.length; i++) {
      out[i].alone = out[i].gap && (i + 1 >= out.length || out[i + 1].gap);
    }
    return out;
  }

  function pruneSeries(series, nowMs, windowMs) {
    if (!series.length) return series;
    const cutoff = nowMs - windowMs;
    let keepFrom = series.length - 1;   // 全部古ければ最後の1点だけ残す
    for (let i = 0; i < series.length; i++) {
      if (series[i].tMs >= cutoff) { keepFrom = i > 0 ? i - 1 : 0; break; }
    }
    return keepFrom > 0 ? series.slice(keepFrom) : series;
  }

  // ---- 区間（1行＝1区間）----
  //
  // 計測の単位は「瞬間」ではなく「区間」である。1区間は次を持つ。
  //   開始・終了時刻（オーディオクロックと、それに対応する壁時計の両方）
  //   代表値 db（区間内のエネルギー平均＝Leq と同じ定義）
  //   サンプルピーク peak / peakDb（区間内の標本点の最大絶対値。RMS とは別物。
  //     ITU-R BS.1770 のトゥルーピーク〈標本の間のピーク〉とも別物で、トゥルーピークはこれ以上になる）
  //   クリップ数 clipCount（|sample| >= 1.0 のサンプル数）
  //   有効サンプル率 validRatio（実際に届いたサンプル数 ÷ 期待サンプル数）
  // CSV の列は段階1では増やさないが、内部の構造だけ先に確定させておく。

  const ENGINE_WORKLET = 'worklet';
  const ENGINE_FALLBACK = 'fallback';

  // ログ間隔（秒）→ フレーム数
  function framesForInterval(intervalSec, sampleRate) {
    const frames = Math.round(intervalSec * sampleRate);
    return Math.max(128, Number.isFinite(frames) ? frames : Math.round(sampleRate));
  }

  // フレーム数 → ログ間隔（秒）のラベル。
  //
  // ⚠⚠ 行に貼るログ間隔は「その区間を実際に測ったときの間隔」でなければならない。
  //    改修前は画面の設定値（script.js の lastIntervalSec）を貼っていた。設定は
  //    即座に変わるのに、ワークレットは次の境界まで前の区間長で測り続けるので、
  //    「1秒で測った区間に 3 というラベルが付く」行ができていた。トレーラーの
  //    `# intervalSec=1+3` は混在を示すが、どの行がどちらかは分からなかった。
  //    区間レコードは startFrame / endFrame を持っているので、実測の区間長から
  //    決められる。framesForInterval の逆算なので、丸めの誤差（0.5/sampleRate
  //    未満＝48kHz で 10 マイクロ秒未満）だけ戻す。
  function intervalSecOfFrames(frames, sampleRate) {
    if (!(frames > 0) || !(sampleRate > 0)) return null;
    return Math.round((frames / sampleRate) * 1e6) / 1e6;
  }

  // 有効サンプル率＝実際に届いたサンプル数 ÷ 期待サンプル数。
  //
  // ⚠ 記録開始直後の1行目だけが 1 を下回っていたのは欠測ではなかった。
  //    ワークレットが AudioWorkletNode の構築時に起点を取っていたため、
  //    レンダーグラフへ繋ぐまでの時間を区間に数えていた（観測された
  //    valid_ratio=0.979 から逆算すると 48kHz で 21.3 ミリ秒ぶん）。
  //    起点を最初の process() へ移して塞いだ（worklet/meter-processor.js）。
  //    いまここが 1 を下回るのは、記録中にレンダークォンタムを落としたときだけである。
  function validRatioOf(count, expected) {
    if (!(expected > 0)) return 0;
    return count / expected;
  }

  // オーディオクロックの秒 → 壁時計のミリ秒
  // anchor = { epoch, audioTime, wallMs }
  function audioTimeToWallMs(audioTime, anchor) {
    return anchor.wallMs + (audioTime - anchor.audioTime) * 1000;
  }

  // ---- 時刻のアンカーと、その取り直し ----
  //
  // AudioContext が suspend されているあいだ currentTime は進まないが、壁時計は進む。
  // 記録開始時のアンカーを使い続けると、再開後のタイムスタンプが中断していた時間ぶん
  // 過去へずれる。スマートフォンの画面ロックで必ず通る経路なので、ずれを検出して
  // アンカーを取り直し、取り直したことを記録に残す。
  //
  // ずれの見方は「前回の点検からの差分」である。開始時からの累積で見ると、
  // オーディオ機器のクロックと OS のクロックのわずかな周波数差
  // （数十 ppm ＝ 1時間で数百ミリ秒）が積み上がって中断と区別できなくなる。
  // 差分で見れば周波数差は1秒あたり 0.1 ミリ秒未満に収まり、
  // 中断（秒単位の跳び）とはっきり分かれる。

  const CLOCK_JUMP_THRESHOLD_MS = 250;
  const CLOCK_BREAK_SUSPEND = 'suspend';   // statechange で中断を観測した
  const CLOCK_BREAK_STALL = 'stall';       // 状態変化なしにオーディオクロックが遅れた
  const CLOCK_OK = 'ok';
  const CLOCK_RESYNC = 'resync';           // この区間はアンカーの取り直しを跨いでいる

  function createClockAnchor(audioTime, wallMs) {
    return { epoch: 0, audioTime, wallMs };
  }

  // 2点間で、壁時計の経過とオーディオクロックの経過の差（ミリ秒）。
  // 正＝オーディオクロックが遅れている＝その間オーディオが止まっていた。
  function clockDriftMs(from, audioTime, wallMs) {
    return (wallMs - from.wallMs) - (audioTime - from.audioTime) * 1000;
  }

  // 前回の点検（probe）からのずれが閾値以上なら跳びとして報告する。閾値未満なら null。
  // probe は「点検した時刻の組」で、アンカーとは別に持つ。
  function detectClockJump(probe, audioTime, wallMs, thresholdMs) {
    const limit = Number.isFinite(thresholdMs) ? thresholdMs : CLOCK_JUMP_THRESHOLD_MS;
    const drift = clockDriftMs(probe, audioTime, wallMs);
    if (!(Math.abs(drift) >= limit)) return null;
    return { jumpMs: drift };
  }

  // アンカーを取り直す（epoch を1つ進める）
  function reanchorClock(anchor, audioTime, wallMs) {
    return { epoch: anchor.epoch + 1, audioTime, wallMs };
  }

  // ---- デジタル無音の扱い ----
  //
  // 振幅が完全に0の区間の dBFS は、定義上 -Infinity である。
  // 改修前はこれを「値が取れなかった」とみなして行ごと捨てていたため、
  // CSV には無標識の穴だけが残り、「対象時刻に音響活動がなかった」ことを
  // 示せなかった。「音がなかった」と「記録していなかった」が区別できないなら、
  // 記録として読めない。
  //
  // 表示下限（floorDb）は表示のための設定なので、-Infinity をそこへ丸めない。
  // 丸めると「測っていない値」を作ってしまう。CSV には -Infinity と書く。

  function clipForDisplay(db, floorDb) {
    // 有限値だけを表示下限で切る（-Infinity はそのまま通す）
    return Number.isFinite(db) ? Math.max(db, floorDb) : db;
  }

  // ---- 帯域（第2弾b1）----
  //
  // 区間ごとに、帯域ごとの平均二乗（FFT で求めた推定）を記録に足す。FFT はワークレットで計算する。
  // ここでは帯域の定義・FFT の長さ・ビンの割り当てを決め（script.js が processorOptions で渡す）、
  // ワークレットから届いた電力の和を dBFS へ換算する。
  // ⚠ 帯域の値は「その帯域に音のエネルギーがあったか」の記録である。何が鳴っていたかは分からず、
  //    超音波ビーコンの検出でもない。値は dBFS と同じく、端末（マイクと変換器）に依存する相対値である。
  // CSV には hash の左の3列（band_ultra_dbfs・band_audible_dbfs・band_valid_ratio）として出し、
  // ハッシュの材料にも入る（第2弾b2）。帯域の定義はヘッダーの `# bands=` に出す（bandsLabel）。
  // 画面（第2弾b3）では、超音波帯の値をグラフの破線（graphLinePoints）と統計の「超音波帯の最大」（formatUltraMax）に、
  // 帯域の有効率を注意書き（statsWarningItems）に出す。可聴帯の値はCSVにだけ出す。
  // ⚠ 画面の文言も「その帯域にエネルギーがあったか」までにする。「検出」「何の音か分かる」と読める書き方をしない

  // 帯域の定義。範囲は lo 以上 hi 未満（Hz）。可聴帯は、超音波帯の値の高い低いを読むための対比として並べる。
  // ワークレットには bandPlan を通して渡し、同じ値を二重に書かない
  const BAND_DEFS = Object.freeze([
    Object.freeze({ key: 'ultra', lo: 18000, hi: 22000 }),
    Object.freeze({ key: 'audible', lo: 20, hi: 18000 })
  ]);
  // 画面に出す帯域（グラフの破線・統計）のキー
  const BAND_ULTRA_KEY = 'ultra';

  // FFT の長さ N。約21.3ミリ秒（48kHz で 1024 サンプル）になる2の累乗で、
  // N = 2^round(log2(sampleRate × 1024 / 48000))。44.1kHz・48kHz なら 1024、88.2kHz・96kHz なら 2048。
  // サンプルレートが正の数でなければ null
  function fftSizeForRate(sampleRate) {
    if (!(sampleRate > 0) || !Number.isFinite(sampleRate)) return null;
    const n = Math.pow(2, Math.round(Math.log2(sampleRate * 1024 / 48000)));
    // ずらし幅 N/4 が 1 以上になる長さに限る（Web Audio のサンプルレートの下限 3000Hz でも 64 になる）
    return n >= 4 ? n : null;
  }

  // 帯域 def に入るビン。ビン k の中心周波数 k・sampleRate / N が lo 以上 hi 未満のものである。
  // k は 1 以上 N/2 以下に限る（直流のビン0は入れない）。1つも無ければ binLo・binHi とも null
  // （例：サンプルレートが低くて 18kHz 以上を表せない端末の超音波帯）。
  // ⚠ 18kHz の境目では、境目から約1〜2ビン（48kHz なら約94Hz まで）の音が、Hann 窓の漏れで隣の帯域へ分かれて入る
  //    （両帯域の和は変わらない）。超音波帯の上端（22kHz）には隣の帯域が無いので、漏れたぶんはどの帯域にも入らない
  //    （48kHz で 22,000Hz の正弦波は -2.0dB・22,050Hz は -14.6dB、44.1kHz で 22,000Hz は -5.9dB）。
  //    可聴帯の下端の側も同じで、ビン0はどの帯域にも入れない（約100Hz より下の値は、ワークレットで
  //    フレームの平均を引くことでも変わる。worklet/meter-processor.js の「帯域の集計」）
  function bandBins(def, sampleRate, n) {
    let binLo = null;
    let binHi = null;
    for (let k = 1; k <= n / 2; k++) {
      const f = k * sampleRate / n;
      if (f >= def.lo && f < def.hi) {
        if (binLo === null) binLo = k;
        binHi = k;
      }
    }
    return { binLo, binHi };
  }

  // ヘッダーの `# bands=` に出す帯域の定義。BAND_DEFS の順（＝CSV の列の順）に `lo-hi` をコンマでつなぐ
  // （例 `18000-22000,20-18000`）。範囲は lo 以上 hi 未満（Hz）で、実際の感度ではない（可聴帯の実際の下端は約50Hz。
  // README の「帯域の列」を参照）
  function bandsLabel(defs) {
    return (defs || BAND_DEFS).map(d => `${d.lo}-${d.hi}`).join(',');
  }

  // ワークレットへ渡す帯域の計画（processorOptions.bandPlan）。
  // ワークレットは logic.js を読めないので、N とビンの番号はここで決めて渡す（CLAUDE.md の約束）。
  // サンプルレートが正の数でなければ null（ワークレットは帯域を計算しない）
  function bandPlan(sampleRate, defs) {
    const list = defs || BAND_DEFS;
    const fftSize = fftSizeForRate(sampleRate);
    if (fftSize === null) return null;
    return {
      sampleRate,
      fftSize,
      bands: list.map(d => {
        const bins = bandBins(d, sampleRate, fftSize);
        return { key: d.key, lo: d.lo, hi: d.hi, binLo: bins.binLo, binHi: bins.binHi };
      })
    };
  }

  // URL の検索部（location.search）から、帯域を計算するかを決める。?bands=off なら false、それ以外は true。
  // 同じ版で帯域あり・なしの valid_ratio を実機で比べるためのもの（第2弾bの実機の関門）
  function bandsEnabledFromQuery(search) {
    let v = null;
    try {
      v = new URLSearchParams(typeof search === 'string' ? search : '').get('bands');
    } catch (e) {
      v = null;
    }
    return !(v !== null && v.trim().toLowerCase() === 'off');
  }

  // ---- 画面の帯域（第2弾b3）----
  //
  // 凡例・上限の表示・注意書きの文言をここで組み立てる（script.jsはDOMに入れるだけ）。

  // 周波数（Hz）をkHzの文字列へ。小数2桁までで、末尾の0は付けない（48000→'48'、44100→'44.1'、22050→'22.05'）
  function formatKhz(hz) {
    if (!Number.isFinite(hz)) return '';
    return String(Math.round(hz / 10) / 100);
  }

  // 帯域の範囲の表示（例：'18〜22kHz'）
  function bandRangeLabel(def) {
    if (!def) return '';
    return `${formatKhz(def.lo)}〜${formatKhz(def.hi)}kHz`;
  }

  function ultraDef() {
    return BAND_DEFS.find(d => d.key === BAND_ULTRA_KEY) || null;
  }

  // この端末で記録できる上限（Hz）。
  // min(AudioContextのサンプルレート ÷ 2, マイクの音声トラックのサンプルレート ÷ 2)である。
  // ⚠ `# nyquistHz=`（AudioContextの半分）だけでは上限を読み違える。Chromiumの疑似マイク（音声トラック44.1kHz・
  //    AudioContext 48kHz）で、-20dBFSの21kHzのトーンが約-54dBFS（band_ultra_dbfs -53.78）で記録された（第2弾b2）。
  // トラックがsampleRateを報告しないときはAudioContextの半分にし、trackKnownをfalseにする（画面で「不明」と添える）。
  // AudioContextのサンプルレートが分からなければnull。
  // ⚠ サンプルレートで決まる上限であり、マイクや変換器がその高さの音を拾えることは示さない
  function recordableUpperHz(contextSampleRate, trackSampleRate) {
    const half = (v) => ((Number.isFinite(v) && v > 0) ? v / 2 : null);
    const ctxHz = half(contextSampleRate);
    const trackHz = half(trackSampleRate);
    if (ctxHz === null) return null;
    const limitedByTrack = trackHz !== null && trackHz < ctxHz;
    return {
      hz: limitedByTrack ? trackHz : ctxHz,
      contextHz: ctxHz,
      trackHz,
      trackKnown: trackHz !== null,
      limitedBy: limitedByTrack ? 'track' : 'context'
    };
  }

  // 上限の表示（凡例の下の1行）。metaはセッションのメタ（contextSampleRate・trackSampleRate）。
  // 記録を始める前（metaが無い）は空文字（画面は:emptyで隠す）
  function upperLimitText(meta) {
    const m = meta || {};
    const u = recordableUpperHz(m.contextSampleRate, m.trackSampleRate);
    if (!u) return '';
    const head = `この端末で記録できる上限：約${formatKhz(u.hz)}kHz`;
    const ctxK = formatKhz(m.contextSampleRate);
    if (!u.trackKnown) return `${head}（AudioContext ${ctxK}kHzの半分。トラックの値は不明）`;
    if (m.trackSampleRate === m.contextSampleRate) return `${head}（サンプルレート${ctxK}kHzの半分）`;
    return `${head}（マイク${formatKhz(m.trackSampleRate)}kHz・AudioContext ${ctxK}kHzの小さいほうの半分）`;
  }

  // 超音波帯の線を描けるか（第2弾b3の点検で追加）。凡例・見本の線・キャンバスの説明・注意書きが、この1つの判定を使う。
  // 最初は?bands=offだけを見ていたので、簡易モードや超音波帯にビンが無いサンプルレートでも、凡例とキャンバスの説明が
  // 「破線は超音波帯の値」と言い続けた。実際には破線は1本も描かれないので、「超音波帯に音が無かった」と読めた。
  //   on        線を描く。記録を始める前（metaがnull）も、ページのURLで止めていなければon
  //   off       ?bands=off（ページのURL、またはセッションのメタのbandsEnabledがfalse）
  //   fallback  簡易モード（帯域を計算しない）
  //   noBins    AudioContextのサンプルレートが低く、超音波帯にビンが1つも無い（bandPlanのbinLoがnull）
  // metaはセッションのメタ、bandsOnPageはページのURLの判定（bandsEnabledFromQuery）。
  // ⚠ 停止→再開で計測エンジンが変わると、グラフには前のセッションの破線が残ったまま、凡例は最後のセッションに合わせて変わる
  const ULTRA_STATE = Object.freeze({ ON: 'on', OFF: 'off', FALLBACK: 'fallback', NO_BINS: 'noBins' });

  function ultraBandState(meta, bandsOnPage) {
    if (bandsOnPage === false || (meta && meta.bandsEnabled === false)) return ULTRA_STATE.OFF;
    if (!meta) return ULTRA_STATE.ON;
    if (meta.engine === ENGINE_FALLBACK) return ULTRA_STATE.FALLBACK;
    const sr = meta.contextSampleRate;
    if (Number.isFinite(sr) && sr > 0) {
      const plan = bandPlan(sr);
      const ultra = plan ? plan.bands.find(b => b.key === BAND_ULTRA_KEY) : null;
      if (ultra && ultra.binLo === null) return ULTRA_STATE.NO_BINS;
    }
    return ULTRA_STATE.ON;
  }

  // 凡例の見本の線を出すか。線を描くとき（on）だけ出す。
  // 描かない線の見本を出すと、「この線がある」と言っているのに線が無いことになる
  function ultraSwatchShown(state) {
    return state === ULTRA_STATE.ON;
  }

  // 描かないときの理由（凡例とキャンバスの説明で同じ言い方にする）
  function ultraStoppedReason(state) {
    if (state === ULTRA_STATE.OFF) return '止めています（?bands=off）';
    if (state === ULTRA_STATE.FALLBACK) return '簡易モードでは測れません';
    if (state === ULTRA_STATE.NO_BINS) return 'このサンプルレートでは測れません';
    return '';
  }

  // 凡例の超音波帯の項目。線を描かないときは、描かない理由を出す（「破線」とは書かない）
  function ultraLegendText(state) {
    const range = bandRangeLabel(ultraDef());
    if (ultraSwatchShown(state)) return `破線：超音波帯（${range}）`;
    return `超音波帯（${range}）：${ultraStoppedReason(state)}`;
  }

  // キャンバスの読み上げ用の説明（aria-label）。線の見分け方を言葉でも伝える。
  // 線を描かないときは、無い線があると伝えないように、描かない理由を言う
  function graphAriaLabel(state) {
    const range = bandRangeLabel(ultraDef());
    const lines = ultraSwatchShown(state)
      ? `実線は音量（全帯域）、破線は超音波帯（${range}）の値`
      : `実線は音量（全帯域）。超音波帯（${range}）の線は描きません（${ultraStoppedReason(state)}）`;
    return `音量推移グラフ。${lines}。横軸は直近${GRAPH_WINDOW_SEC}秒、縦軸はdBFS`;
  }

  // 秒を画面の文言へ（小数3桁まで、末尾の0は付けない。1→'1'、0.2→'0.2'、60→'60'）
  function formatSecLabel(sec) {
    if (!Number.isFinite(sec) || !(sec > 0)) return '';
    return String(Math.round(sec * 1000) / 1000);
  }

  // 超音波帯の現在値（第2弾c0）。大きな音量の数字の近くに1行で出す。
  // 値は、最後に記録した区間（ワークレットが最後に送ってきた区間）のband_ultra_dbfsで、CSVに書く値と同じである。
  // ⚠ 大きな数字（直近METER_WINDOW_SAMPLESサンプル＝48kHzで約43ミリ秒の全帯域のRMS）とは窓も帯域も違う。
  //    窓が違うことが文言から分かるように、区間の長さ（その区間を実際に測ったログ間隔）を添える
  //    （例：「超音波帯（直近1秒の区間）：-91.7 dBFS」）。区間がまだ無ければ長さは書かない。
  // b4（2026-09-29）で本人の決定。静かな部屋の超音波帯は+2dBほどしか動かないことがあり、
  // -110〜0dBFSの縦軸では高さの約2%にしかならないので、数字で読めるようにする。
  //   state  ultraBandStateの値（凡例と同じ判定）。線を描かないとき（off・fallback・noBins）は、
  //          値の代わりに描かない理由を出す（「止めています（?bands=off）」など）
  //   rec    最後に記録した区間レコード。無ければ（記録前・記録開始直後・統計リセット後）「--.- dBFS」。
  //          レコードに超音波帯の値が無ければ（数えたフレームが0の区間など）「--.- dBFS（この区間は値なし）」。
  //          デジタル無音（-Infinity）は測った値なので「-∞ dBFS」
  // ⚠ 読み上げ領域（aria-live）にはしない。区間ごとに変わる値を毎回読み上げると、ほかの読み上げを妨げる
  function ultraNowText(state, rec) {
    const sec = rec ? formatSecLabel(rec.intervalSec) : '';
    const head = sec ? `超音波帯（直近${sec}秒の区間）：` : '超音波帯（直近の区間）：';
    if (!ultraSwatchShown(state)) return `超音波帯（直近の区間）：${ultraStoppedReason(state)}`;
    if (!rec) return `${head}--.- dBFS`;
    const v = ultraDbOf(rec);
    if (v === null) return `${head}--.- dBFS（この区間は値なし）`;
    return `${head}${formatDbCell(v)}`;
  }

  // 帯域とサンプルレートに関わる注意の項目（セッションのメタだけから決まるもの）。
  // 帯域の有効率の項目は統計から出る（statsWarningItems）。
  //   sampleRateMismatch  マイクの音声トラックとAudioContextのサンプルレートが違う（トラックが報告しないときは出さない）
  //   bandsOff            ?bands=offで帯域を計算していない
  //   bandsFallback       簡易モードで帯域を計算していない（第2弾b3の点検で追加）
  //   ultraUnavailable    AudioContextのサンプルレートが低く、超音波帯にビンが1つも無い（CSVのband_ultra_dbfsは空欄）
  // 後ろの3つは、凡例と同じ判定（ultraBandState）から出す
  function bandNoticeItems(meta) {
    const out = [];
    if (!meta) return out;
    const def = ultraDef();
    const range = bandRangeLabel(def);
    const state = ultraBandState(meta);
    const ctxSr = meta.contextSampleRate;
    const trackSr = meta.trackSampleRate;
    if (Number.isFinite(ctxSr) && ctxSr > 0 && Number.isFinite(trackSr) && trackSr > 0 && ctxSr !== trackSr) {
      const u = recordableUpperHz(ctxSr, trackSr);
      const tK = formatKhz(trackSr);
      const cK = formatKhz(ctxSr);
      // 上限が超音波帯の下端より下なら、その帯域の値が超音波帯の音を表さないことも言う。
      // ⚠ 超音波帯の値があるとき（on）だけ。値が無いとき（簡易モード・?bands=off・ビンが無い）に言うと、
      //    同時に出る「空欄になる」の項目と食い違う。onならAudioContextの半分は超音波帯の下端より上なので、
      //    このとき上限を下げているのはトラックのほうである
      const below = (state === ULTRA_STATE.ON && def && u.hz < def.lo)
        ? `。超音波帯（${range}）はこの上限より上にあり、その帯域の値は超音波帯の音を表しません`
        : '';
      out.push({
        kind: 'sampleRateMismatch',
        short: `サンプルレートの変換あり（マイク${tK}kHz／AudioContext ${cK}kHz）`,
        full: `マイクの音声トラック（${tK}kHz）とAudioContext（${cK}kHz）のサンプルレートが違います。`
          + `サンプルレートの変換で、上限に近い高い音は低く記録されます（この端末で記録できる上限は約${formatKhz(u.hz)}kHz）`
          + below
      });
    }
    if (state === ULTRA_STATE.OFF) {
      out.push({
        kind: 'bandsOff',
        short: '帯域の計算を停止中（?bands=off）',
        full: '帯域の計算を止めています（?bands=off）。CSVの帯域の3列は空欄になり、'
          + 'グラフの超音波帯の線は描かれず、統計の「超音波帯の最大」は「--.-」のままです'
      });
    } else if (state === ULTRA_STATE.FALLBACK) {
      out.push({
        kind: 'bandsFallback',
        short: '帯域を計算していない（簡易モード）',
        full: '簡易モードでは帯域を計算しません。CSVの帯域の3列は空欄になり、'
          + 'グラフの超音波帯の線は描かれず、統計の「超音波帯の最大」は「--.-」のままです'
      });
    } else if (state === ULTRA_STATE.NO_BINS) {
      out.push({
        kind: 'ultraUnavailable',
        short: `超音波帯を測れない（サンプルレート${formatKhz(ctxSr)}kHz）`,
        full: `AudioContextのサンプルレート（${formatKhz(ctxSr)}kHz）では、超音波帯（${range}）の周波数を表せません`
          + `（表せる上限は約${formatKhz(ctxSr / 2)}kHz）。CSVのband_ultra_dbfsは空欄になり、グラフの超音波帯の線も出ません`
      });
    }
    return out;
  }

  // ワークレットからの帯域の値を、区間レコードの項目にする。
  //   bandDb         帯域ごとの dBFS（キーは BAND_DEFS の key）。電力の和 ÷ 数えたフレーム数を
  //                  powerToDb と同じ定義で換算する（平均二乗が 0 なら -Infinity）。
  //                  数えたフレームが 0・その帯域にビンが無い・値が届いていない（帯域を計算していない）ときは null
  //   bandValidRatio 数えたフレーム数 ÷ 数えるはずだったフレーム数（valid_ratio と同じ考え方）。
  //                  数えるはずのフレームが 0、または値が届いていないときは null
  function bandFieldsOf(msg) {
    const src = msg || {};
    const frames = numberOrNull(src.bandFrames);
    const expected = numberOrNull(src.bandExpected);
    const power = Array.isArray(src.bandPower) ? src.bandPower : null;
    const bandDb = {};
    BAND_DEFS.forEach((def, i) => {
      const p = power ? power[i] : null;
      bandDb[def.key] = (frames > 0 && Number.isFinite(p) && p >= 0) ? powerToDb(p / frames) : null;
    });
    return {
      bandDb,
      bandFrames: frames,
      bandExpected: expected,
      bandValidRatio: (frames !== null && expected > 0) ? frames / expected : null
    };
  }

  // ワークレットからの1メッセージを1行分の区間レコードへ
  // extra = { clockBreak: { kind, jumpMs } | null }
  function buildIntervalRecord(msg, anchor, floorDb, extra) {
    const sr = msg.sampleRate;
    const startTime = msg.startFrame / sr;
    const endTime = msg.endFrame / sr;
    // ⚠ 音が1つも届かなかった区間（count=0）は欠測である。dbfs・peak_dbfs・clip を null（CSV では空欄）にする
    //    （第2弾b2）。改修前は rms=0 として -Infinity（デジタル無音）と同じ値を書いていたので、
    //    「音が無かった」と「記録していなかった」を CSV の上で区別できなかった。
    //    デジタル無音（count>0 で sumSq=0）は、これまでどおり -Infinity で残す
    const missing = !(msg.count > 0);
    const rawDb = missing ? null : rmsToDbfs(Math.sqrt(msg.sumSq / msg.count));
    const startWall = new Date(audioTimeToWallMs(startTime, anchor));
    const endWall = new Date(audioTimeToWallMs(endTime, anchor));
    const brk = (extra && extra.clockBreak) || null;
    const band = bandFieldsOf(msg);
    // seq は「1つのCSVの中での通し番号」である。
    // ⚠ ワークレット側のカウンターは記録開始のたびに0から振り直される
    //   （記録開始のたびに新しい AudioWorkletNode を作るため）。ログは累積するので、
    //   そのまま載せると1つのCSVの中で seq が 0 に戻る。呼ぶ側が起点をずらす。
    //   区間を捨てたときの欠番は、ずらしても残る（欠番＝行が抜けた印であるため）。
    const seqBase = (extra && Number.isFinite(extra.seqBase)) ? extra.seqBase : 0;
    return {
      seq: Number.isFinite(msg.seq) ? seqBase + msg.seq : msg.seq,
      engine: ENGINE_WORKLET,
      startTime,
      endTime,
      startWall,
      endWall,
      ts: endWall,                       // CSV の timestamp 列（区間の終わり）
      rawDb,                             // 区間のエネルギー平均（生値）。欠測なら null
      db: missing ? null : clipForDisplay(rawDb, floorDb),
      silent: rawDb === -Infinity,       // デジタル無音（振幅が完全に0の区間）
      missing,                           // 音が1つも届かなかった区間（統計の平均に入れない。第2弾b2）
      peak: msg.peak,
      peakDb: missing ? null : rmsToDbfs(msg.peak),
      clipCount: missing ? null : msg.clip,
      // クリップが続いた最長のサンプル数（単発と連続の区別）。CSV の列にはしない
      clipRunMax: (!missing && Number.isFinite(msg.clipRun)) ? msg.clipRun : null,
      sampleCount: msg.count,
      expectedSamples: msg.expected,
      validRatio: validRatioOf(msg.count, msg.expected),
      // その区間を実際に測ったときのログ間隔（画面の設定値ではない）。
      // CSV の列は増やさない。トレーラーで「どの seq からどの間隔か」を示す
      intervalSec: intervalSecOfFrames(msg.endFrame - msg.startFrame, sr),
      // 帯域（第2弾b1）。CSVの列とハッシュの材料には第2弾b2で、画面と統計には第2弾b3で入れた。
      // ⚠ 欠測の区間でも空欄にしない。前の区間の終わりで数えたフレームが入ることがある（README の「帯域の列」）
      bandDb: band.bandDb,
      bandFrames: band.bandFrames,
      bandExpected: band.bandExpected,
      bandValidRatio: band.bandValidRatio,
      clockEpoch: anchor.epoch || 0,
      clockStatus: brk ? CLOCK_RESYNC : CLOCK_OK,
      clockBreakKind: brk ? brk.kind : null,
      clockJumpMs: brk ? brk.jumpMs : null,
      // 測定条件は1セッションに1つ。参照だけを持ち、行ごとに複製しない
      metaId: (extra && extra.meta) ? extra.meta.id : null,
      meta: (extra && extra.meta) || null
    };
  }

  // AudioWorklet が使えない環境（簡易モード）での1行。
  // 瞬時値しか手元にないので、ピーク・クリップ数・有効サンプル率は「不明」を入れる。
  function buildFallbackRecord(opts) {
    const rawDb = opts.db;
    const endWall = new Date(opts.endWallMs);
    const brk = opts.clockBreak || null;
    // 帯域は測れない（手元にあるのは AnalyserNode の瞬時値だけ）。すべて null にする。
    // 測れないものを「異常なし」として出さない（第2弾b1）
    const band = bandFieldsOf(null);
    return {
      seq: opts.seq,
      engine: ENGINE_FALLBACK,
      startTime: opts.startTime,
      endTime: opts.endTime,
      startWall: new Date(opts.startWallMs),
      endWall,
      ts: endWall,
      rawDb,
      db: clipForDisplay(rawDb, opts.floorDb),
      silent: rawDb === -Infinity,
      // 簡易モードはサンプル数を数えられないので、欠測かどうかも分からない（validRatio と同じく「不明」）
      missing: false,
      peak: null,
      peakDb: null,
      clipCount: null,
      clipRunMax: null,
      sampleCount: null,
      expectedSamples: opts.expectedSamples,
      validRatio: null,
      // 簡易モードは rAF の間隔でしか区切れないので、区間長は設定値どおりにならない。
      // ただし行を出す条件（nowSec - lastLogTime >= lastIntervalSec）で使った値
      // そのものなので、その区間を測ったときの間隔として貼ってよい
      intervalSec: numberOrNull(opts.intervalSec),
      bandDb: band.bandDb,
      bandFrames: band.bandFrames,
      bandExpected: band.bandExpected,
      bandValidRatio: band.bandValidRatio,
      clockEpoch: opts.clockEpoch || 0,
      clockStatus: brk ? CLOCK_RESYNC : CLOCK_OK,
      clockBreakKind: brk ? brk.kind : null,
      clockJumpMs: brk ? brk.jumpMs : null,
      metaId: opts.meta ? opts.meta.id : null,
      meta: opts.meta || null
    };
  }

  // ---- 測定条件（セッションのメタデータ）----
  //
  // AGC・ノイズ抑制・エコーキャンセルを「無効で」と要求しても、
  // 実際に無効になったかは track.getSettings() の実値でしか分からない。
  // AGC が効いていると入力の利得が勝手に動くので、dBFS の値そのものが
  // 測定値として信用できなくなる。
  // CSV の列にはしない（セッションの条件はヘッダーのメタ行に出す）。内部のレコードから
  // 参照できる形で1セッション分を1つだけ持ち、行ごとに複製しない。

  // 主要3項目。報告が無ければ「不明」として扱う。
  // ⚠ 「どの実装も報告する」わけではない。WebKit（Safari）の MediaTrackSettings には
  //    autoGainControl と noiseSuppression が無く、getSettings() は echoCancellation しか
  //    返さない作りになっている（WebKit のソース main で確認、2026-09-29。iPhone の実機の
  //    CSV ではまだ確かめていない）。Safari ではこの2項目が毎回「不明」になる前提で扱う
  const PROCESSING_KEYS = ['autoGainControl', 'noiseSuppression', 'echoCancellation'];
  // 実装によっては存在しない加工。報告されて有効なときだけ数え、
  // 無ければ「不明」にはしない（大半のブラウザーで不明だらけになるため）
  const PROCESSING_OPTIONAL_KEYS = ['voiceIsolation'];
  const PROCESSING_OFF = 'off';           // 3つとも無効と報告された
  const PROCESSING_ACTIVE = 'active';     // 1つ以上が有効になっている
  const PROCESSING_UNKNOWN = 'unknown';   // 報告しない項目がある

  function numberOrNull(v) {
    return Number.isFinite(v) ? v : null;
  }

  // true / false / null（その環境が報告しない）の3値にそろえる
  function tristate(v) {
    if (v === true) return true;
    if (v === false) return false;
    return null;
  }

  function buildSessionMeta(input) {
    const src = input || {};
    const s = src.settings || {};
    const processing = {};
    const allKeys = PROCESSING_KEYS.concat(PROCESSING_OPTIONAL_KEYS);
    for (let i = 0; i < allKeys.length; i++) {
      processing[allKeys[i]] = tristate(s[allKeys[i]]);
    }
    const active = allKeys.filter(k => processing[k] === true);
    const unknown = PROCESSING_KEYS.filter(k => processing[k] === null);
    return Object.freeze({
      id: src.id || null,
      startedWallMs: numberOrNull(src.startedWallMs),
      engine: src.engine || null,
      contextSampleRate: numberOrNull(src.contextSampleRate),
      trackSampleRate: numberOrNull(s.sampleRate),
      channelCount: numberOrNull(s.channelCount),
      deviceLabel: src.deviceLabel || null,
      deviceId: s.deviceId || null,
      groupId: s.groupId || null,
      latency: numberOrNull(s.latency),
      processing: Object.freeze(processing),
      processingActive: Object.freeze(active),
      processingUnknown: Object.freeze(unknown),
      requested: Object.freeze(Object.assign({}, src.requested)),
      settings: Object.freeze(Object.assign({}, s)),
      userAgent: src.userAgent || null,
      timeZone: src.timeZone || null,
      // 帯域を計算するか（?bands=off なら false。第2弾b2でヘッダーの `# bands=` に出す）。
      // 渡されなければ null（分からない）で、ヘッダーに `# bands=` を出さない
      bandsEnabled: typeof src.bandsEnabled === 'boolean' ? src.bandsEnabled : null
    });
  }

  // ---- getSettings() の生の値（第2弾b2）----
  //
  // `# processing=` は off／active／unknown の解釈である。解釈だけでは、ブラウザーが実際に何を返したかを
  // あとから読めない（Safari は echoCancellation しか返さない作り）。ヘッダーに生の値を別の行で残し、
  // 解釈と生の値を分けて持つ。載せるのは音の加工とサンプルレートに関わる項目だけで、この順に並べる。
  // ⚠⚠ deviceId・groupId は決して入れない。端末を特定できる値である（一覧に無い項目は出さない作りにしてある）
  const SETTINGS_RAW_KEYS = Object.freeze([
    'echoCancellation', 'autoGainControl', 'noiseSuppression', 'sampleRate', 'channelCount'
  ]);
  const SETTING_UNREPORTED = 'unreported';

  // 1項目の値を文字列へ。報告しない項目（undefined・null）は unreported。
  // 真偽値と有限の数はそのまま、文字列（echoCancellation の "remote-only" など）は英数字と . _ - だけに寄せる。
  // `;` `:` `=` や改行を持ち込むと1行1項目の形が崩れるためである。読めない値（NaN・オブジェクトなど）も unreported にする
  function settingRawValue(v) {
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : SETTING_UNREPORTED;
    if (typeof v === 'string') {
      const s = v.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 32);
      return s || SETTING_UNREPORTED;
    }
    return SETTING_UNREPORTED;
  }

  // `# settingsRaw=` の値（例 `echoCancellation:false;autoGainControl:unreported;…;channelCount:1`）。
  // settings は getSettings() の戻り値（セッションのメタの settings）。無ければ null（行を出さない）
  function settingsRawLabel(settings) {
    if (!settings || typeof settings !== 'object') return null;
    return SETTINGS_RAW_KEYS.map(k => `${k}:${settingRawValue(settings[k])}`).join(';');
  }

  // 測定値をそのまま信用してよいか
  function processingVerdict(meta) {
    if (!meta) return PROCESSING_UNKNOWN;
    if (meta.processingActive.length) return PROCESSING_ACTIVE;
    if (meta.processingUnknown.length) return PROCESSING_UNKNOWN;
    return PROCESSING_OFF;
  }

  // CSV のメタ行 `# processing=` に書く値。
  //
  // ⚠⚠ off と書くのは、3項目すべてが「無効」と報告されたときだけである。
  //    改修前（c7b6bad）は script.js が「有効と報告された項目が無ければ off」と
  //    書いていた。報告しない項目があっても off になり、Safari のように
  //    autoGainControl を報告しない環境で「加工なし」と名乗っていた
  //    （WebKit Bugzilla 204444）。ここで3値のまま文字列にする。
  //
  //    off                                       3項目すべて無効と報告された
  //    active:echoCancellation                   有効と報告された項目
  //    unknown:autoGainControl                   報告されなかった項目
  //    active:echoCancellation;unknown:autoGainControl   両方あるとき
  function processingLabel(meta) {
    if (!meta) return PROCESSING_UNKNOWN;
    // どちらかの一覧が無い形は、判定の材料が欠けている。off と推し量らない
    // （公開前の点検で、unknown の一覧を落とした形を渡すと off に戻ることが分かった）
    if (!Array.isArray(meta.processingActive) || !Array.isArray(meta.processingUnknown)) {
      return PROCESSING_UNKNOWN;
    }
    const parts = [];
    const active = meta.processingActive || [];
    const unknown = meta.processingUnknown || [];
    if (active.length) parts.push(`${PROCESSING_ACTIVE}:${active.join('+')}`);
    if (unknown.length) parts.push(`${PROCESSING_UNKNOWN}:${unknown.join('+')}`);
    return parts.length ? parts.join(';') : PROCESSING_OFF;
  }

  // CSV のヘッダー（ハッシュチェーンの起点）に載せる測定条件。
  // ⚠ 記録を始めた瞬間に確定する事実だけを入れる。ログ間隔・無音の有無・中断の回数は
  //    記録中に変わるので、ここには入れない（トレーラーへ出す）。
  // 画面の側（script.js）から切り出した。テストから振る舞いを確かめられるようにするため
  //
  // 第2弾b2で足した4項目も、すべて記録を始めた時点で決まる値である。
  //   nyquistHz    AudioContext のサンプルレートの半分（帯域を計算できる上限）。44.1kHz では 22,050Hz で、
  //                超音波帯の上端（22kHz）がそのすぐ下になるので、読み手が確かめられるように出す。
  //                ⚠ 実際に届く音の上限とは限らない。マイクの音声トラックの sampleRate（settingsRaw）が
  //                これより低いと、実際に届く上限はその半分になる（Chromium の疑似マイクで、音声トラック
  //                44.1kHz・AudioContext 48kHz のとき 21kHz のトーンが約34dB下がり、23kHz は残らなかった）
  //   settingsRaw  getSettings() の生の値（settingsRawLabel）。processing（解釈）とは別に持つ
  //   bands        帯域の定義（bandsLabel）。?bands=off なら 'off'。分からなければ出さない
  //   fftSize      FFT の長さ。帯域を計算するとき（高精度モードで ?bands=off でない）だけ出す。
  //                ワークレットへ渡す計画と同じ bandPlan から取る（同じ値を二重に持たない）
  function chainHeaderMeta(input) {
    const src = input || {};
    const m = src.sessionMeta || {};
    const rec = src.firstRec || {};
    const engine = rec.engine || src.engineMode || null;
    const sampleRate = m.contextSampleRate || null;
    const bandsOn = m.bandsEnabled === true;
    const plan = (bandsOn && engine === ENGINE_WORKLET && sampleRate) ? bandPlan(sampleRate) : null;
    let bands = null;
    if (m.bandsEnabled === false) bands = 'off';
    else if (bandsOn) bands = bandsLabel(BAND_DEFS);
    return {
      engine,
      // アンカーは中断のたびに取り直すので、記録開始の時刻には使えない。
      // 1行目の区間の時刻をそのまま載せる
      started: rec.ts instanceof Date ? rec.ts.toISOString() : null,
      sampleRate,
      nyquistHz: sampleRate ? sampleRate / 2 : null,
      device: m.deviceLabel || null,
      // 報告しない項目があれば unknown と書く（改修前は「有効が無ければ off」と決め打ちしていた）
      processing: processingLabel(src.sessionMeta || null),
      settingsRaw: src.sessionMeta ? settingsRawLabel(m.settings || {}) : null,
      bands,
      fftSize: plan ? plan.fftSize : null,
      hashAlgo: src.hashAlgo || null
    };
  }

  function deviceLossLabel(reason) {
    if (reason === DEVICE_LOST_GONE) return '音声トラックが無くなりました';
    return 'マイクが切断されました';
  }

  // 記録に関わる注意の項目（要点 short と全文 full）。画面の注意書きは、この一覧だけから作る。
  // 画面の側（script.js）から切り出した。テストから振る舞いを確かめられるようにするため
  // （公開前の点検で、画面の条件を反転させてもテストが通ることが分かった）
  function recordNoticeItems(input) {
    const src = input || {};
    const items = [];
    const loss = src.deviceLoss;
    if (loss) {
      const label = deviceLossLabel(loss.reason);
      items.push({
        kind: 'deviceLoss',
        short: `${label}（${loss.rowsKept}行目まで記録）`,
        full: `${label}。${loss.rowsKept}行目までを記録し、`
          + 'そのあとは記録していません（ここまでのログは書き出せます）'
      });
    } else if (src.deviceMuted) {
      items.push({
        kind: 'deviceMuted',
        short: 'マイクが無音化されている',
        full: 'マイクが供給元で無音化されています（通話の割り込みなど）。'
          + 'この間の記録はデジタル無音になります'
      });
    }
    // 記録を始める前（測定条件が無い）には、加工の注意を出さない
    const meta = src.sessionMeta;
    if (meta) {
      const verdict = processingVerdict(meta);
      if (verdict === PROCESSING_ACTIVE) {
        const keys = meta.processingActive.join(', ');
        items.push({
          kind: 'processingActive',
          short: `音の加工が有効（${keys}）`,
          full: `マイク側の音の加工が有効です（${keys}）。`
            + '利得が自動で動くため、この記録の dBFS は絶対値として扱えません'
        });
      } else if (verdict === PROCESSING_UNKNOWN) {
        // 報告しない項目がある（Safari の autoGainControl・noiseSuppression など）。
        // 黙っていると「加工なし」と読まれるので、分からないことを出す
        const keys = (meta.processingUnknown || []).join(', ');
        items.push({
          kind: 'processingUnknown',
          short: `音の加工の状態が不明（${keys}）`,
          full: `マイク側の音の加工（${keys}）の状態を、`
            + 'このブラウザーは報告しません。利得が自動で動いていても、この画面とCSVからは分かりません'
        });
      }
      // サンプルレートの食い違い・?bands=off・超音波帯を測れないサンプルレート（第2弾b3）。
      // どれも測定条件から決まるので、入力を増やさずセッションのメタから組み立てる
      for (const it of bandNoticeItems(meta)) items.push(it);
    }
    const breaks = src.clockBreaks || [];
    if (breaks.length) {
      const totalSec = breaks.reduce((a, b) => a + b.jumpMs, 0) / 1000;
      items.push({
        kind: 'clockBreak',
        short: `時刻の跳び${breaks.length}回`,
        full: `時刻の跳びを${breaks.length}回検出（累計 ${totalSec.toFixed(2)} 秒）。`
          + '以降の時刻は取り直したアンカーで出し、'
          + '該当区間はCSVのメタ行（# clockBreaks / # clockBreakAt / # clockDriftMs）に残ります'
      });
    }
    // クリップと欠測、帯域の有効率（第2弾b3）。ボタンを増やさず、記録の信用に関わる事実をここへ集める
    for (const it of statsWarningItems(src.stats)) items.push(it);
    return items;
  }

  // ---- マイクの取得の試行 ----
  //
  // getUserMedia をタイムアウトなしで await していたため、許可プロンプトを
  // 放置すると「マイクに接続中…」の表示のまま記録開始・停止の両方が無効になり、
  // リロード以外に復帰手段がなかった。
  //
  // 試行に世代番号（トークン）を持たせ、取り消し・時間切れのあとに遅れて
  // 届いたストリームを捨てられるようにする。

  const CONNECT_HINT_MS = 8000;      // これを過ぎたら「応答してください」と出す
  const CONNECT_TIMEOUT_MS = 20000;  // これを過ぎたら試行を打ち切る

  function createAttemptGate() {
    let current = 0;
    return {
      begin() { current += 1; return current; },
      isCurrent(token) { return token > 0 && token === current; },
      cancel() { current += 1; },
      generation() { return current; }
    };
  }

  // 約束にタイムアウトを噛ませる。
  // 時間切れなら { timedOut: true }、成功なら { value }、失敗なら { error }。
  // 元の約束は捨てないので、呼び出し側が遅れて届いたストリームを止められる。
  // 既定のタイマー。ブラウザーの setTimeout は this が Window でないと
  // Illegal invocation になるので、オブジェクトへ直に入れずに包む。
  const DEFAULT_TIMERS = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id)
  };

  function raceWithTimeout(promise, ms, timers) {
    const t = timers || DEFAULT_TIMERS;
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = t.setTimeout(() => resolve({ timedOut: true }), ms);
    });
    const settled = Promise.resolve(promise).then(
      (value) => ({ value }),
      (error) => ({ error })
    );
    return Promise.race([settled, timeout]).then((result) => {
      if (timer !== null) t.clearTimeout(timer);
      return result;
    });
  }

  // ---- マイクのデバイス喪失 ----
  //
  // トラックを stop しても MediaStreamAudioSourceNode はデジタル無音を流し続ける。
  // そのため有効サンプル率は 1.0 のまま、サンプル数も期待どおりのままで、
  // dBFS だけが -Infinity になる。つまり計測値からは
  // 「部屋が静かだった」と「マイクが死んだ」を区別できない。
  // 区別できるのは MediaStreamTrack の状態だけである。

  const TRACK_LIVE = 'live';
  const TRACK_ENDED = 'ended';
  const DEVICE_LOST_ENDED = 'ended';   // ended イベント／readyState が live でない
  const DEVICE_LOST_GONE = 'gone';     // 音声トラックそのものが無くなった

  function readTrackState(track) {
    if (!track) return { readyState: null, muted: null, enabled: null, live: false };
    return {
      readyState: track.readyState || null,
      muted: track.muted === true,
      enabled: track.enabled !== false,
      live: track.readyState === TRACK_LIVE
    };
  }

  function isTrackLost(state) {
    return !state || state.live !== true;
  }

  // 最後の行に「この行のあとでマイクを失った」印を付ける。
  // 失ったあとの区間は測っていないので、行を作らない（作れば嘘になる）。
  function markDeviceLoss(logs, event) {
    const last = logs.length ? logs[logs.length - 1] : null;
    if (last) {
      last.deviceLostAfter = true;
      last.deviceLostReason = event.reason;
    }
    return {
      reason: event.reason,
      atWallMs: event.atWallMs,
      lastSeq: last ? last.seq : null,
      rowsKept: logs.length
    };
  }

  // ---- CSV ----
  // 列は10列（CSV_COLUMNS。CSV v3）。⚠ 列はむやみに増やさない。
  // 行ごとに残したい印は、回数と位置をヘッダーかトレーラーの行で示す。
  // 列を足すのは `# format=` の版を上げるときだけである（v3 で帯域の3列を hash の左に足した。第2弾b2）。
  // 足すときは README（列の表・見本・検証器とその実測表・Excel の手順）とテストをまとめて直す。

  // dBFS を1セルへ。無音は数値へ丸めず -Infinity と書く。
  // 数値に見える値を書かないので、集計側が無音を測定値として取り込むことがない。
  function formatCsvDb(db) {
    if (Number.isFinite(db)) return db.toFixed(2);
    return String(db);   // -Infinity（無音）。想定外の値も隠さずそのまま出す
  }

  // 鎖の起点。
  //
  // ⚠ 材料は「記録を始めた瞬間に確定する事実」だけである。
  // 以前は buildCsv の出力（＝メタ行そのもの）を起点にしていた。メタ行には
  // 記録が終わってから分かる事実（無音の有無・中断の回数・使ったログ間隔）が
  // 混ざるので、同じセッションを2回書き出すと同じ行のハッシュが変わった。
  // 実測では「途中で10行を書き出したあと、無音の行が1行増えるだけで
  // 1行目のハッシュまで変わった」。受け取った側には改変されたように見える。
  // あとから分かる事実は csvTrailerLines へ出し、鎖の最後の輪にする。
  function csvSeed(meta) {
    return csvHeaderLines(meta).join('\n');
  }

  // ⚠ 書き出すのは rawDb（生値）である。
  // 改修前は表示下限でクリップした値を記録していたため、記録中に表示の設定を
  // 変えるとログデータ自体が変質していた。表示下限は表示のための設定なので、
  // 記録には触らせない（db は表示用、rawDb は記録用と役割を分ける）。
  // CSV v3（第2弾b2）。
  //
  // A列 timestamp・B列 dbfs は動かさない。README が案内している Excel の手順
  // （=AVERAGE(B:B) など）が A列=時刻・B列=音量を前提にしているためで、
  // 新しい値は右へ足す。今後 列を足すときも同じ約束にする。
  //
  // seq は区間の通し番号である。欠番があれば行が抜けたと分かるので、
  // ハッシュチェーンとは別の手がかりになる。
  //
  // 帯域の3列（第2弾b2）は hash の左に挿す。ハッシュの材料は「hash 列より左のフィールド」のままなので、
  // 帯域の値も鎖で守られる。帯域の2列の並びは BAND_DEFS の順（`# bands=` の並びと同じ）である。
  // v2（7列）の CSV は hash が7列目、v3 は10列目になる。README の検証器は列のヘッダー行から hash の位置を読む
  const CSV_COLUMNS = [
    'timestamp', 'dbfs', 'seq', 'peak_dbfs', 'clip', 'valid_ratio',
    'band_ultra_dbfs', 'band_audible_dbfs', 'band_valid_ratio',
    'hash'
  ];

  // ハッシュチェーン。
  //
  // ⚠⚠ これは「改変を検出する」ものではない。分かれ目は「本人か第三者か」
  // ではなく「ハッシュを再計算するかどうか」である。鎖の作り方は README で
  // 公開しているので、値を書き換えたあとに計算し直せば検証は通る。第1弾の実測では
  // 39行のスクリプトで、行の削除・入れ替え・書き換え・末尾の切り落とし・
  // 無音行の一括削除・デバイス名の差し替えが、すべて通ってしまった。
  // したがって、意図的な改変には相手が誰であっても耐えない。
  //
  // 分かるのは「CSV がそのまま渡ってきたときに、うっかりの破損・部分的な
  // 欠落・順序の入れ替わりを見つけること」までである。
  //
  // これを変えるには秘密鍵で署名するか、外部のタイムスタンプ機関へ預けるしかない。
  // 外部へ預けるには外部通信が要り、このツールの「端末内で完結し、外へ何も
  // 送らない」という作り（CSP の connect-src 'none'）を壊すので採らない。
  //
  // 先頭16文字（64ビット）だけ載せる。1行あたりの長さを抑えるためで、
  // 偶然の衝突は実用上起きないが、衝突を意図的に作る攻撃には耐えない。
  // ただし上のとおり、そもそも再計算されれば衝突を作る必要すらない。
  const HASH_ALGO_LABEL = 'sha-256-chain-16';
  const HASH_HEX_LEN = 16;

  // i番目の行のハッシュの材料。前の行のハッシュを混ぜることで鎖にする。
  function hashInput(prevHex, fields) {
    return String(prevHex || '') + '|' + fields.join(',');
  }

  function formatRatio(v) {
    return Number.isFinite(v) ? v.toFixed(3) : '';
  }

  // 値そのものが無い（記録していない）ときは空欄にする。
  // formatCsvDb をそのまま通すと 'undefined' という文字列がCSVに出る。
  // -Infinity は「無音を測った」という測定結果なので、こちらは残す。
  function formatOptionalDb(db) {
    if (db === undefined || db === null || Number.isNaN(db)) return '';
    return formatCsvDb(db);
  }

  // 1行ぶんのフィールド（ハッシュ列は除く）。ハッシュはこの並びから計算する。
  //
  // ⚠ 音が1つも届かなかった区間（count=0）は、dbfs・peak_dbfs・clip が空欄になる（レコードの値が null。
  //    第2弾b2）。valid_ratio は 0.000 のまま出す。デジタル無音（-Infinity）とは別の書き方である。
  // 帯域の3列（第2弾b2）は dbfs・valid_ratio と同じ書式で、値が無ければ空欄にする
  // （簡易モードの行・?bands=off・数えたフレームが0・その帯域にビンが無い・数えるはずのフレームが0）
  function csvDataFields(r) {
    const band = r.bandDb || {};
    return [
      r.ts.toISOString(),
      formatOptionalDb(r.rawDb),
      Number.isFinite(r.seq) ? String(r.seq) : '',
      formatOptionalDb(r.peakDb),
      Number.isFinite(r.clipCount) ? String(r.clipCount) : '',
      formatRatio(r.validRatio)
    ].concat(
      BAND_DEFS.map(d => formatOptionalDb(band[d.key])),
      [formatRatio(r.bandValidRatio)]
    );
  }

  // 1行1項目。改行は値に入れない（入れると行が割れる）。
  // 値が無い項目は行そのものを出さない（空欄の行を並べても読めないだけである）。
  function metaLine(key, value) {
    if (value === null || value === undefined || value === '') return null;
    return `# ${key}=${String(value).replace(/[\r\n]+/g, ' ')}`;
  }

  // 起点になるヘッダーのメタ行。記録の条件をあとから読み直せるようにする。
  // これが無いと、そのCSVがどの端末のどの設定で採られたのか分からない。
  //
  // ⚠⚠ ここに入れてよいのは、記録を始めた瞬間に確定する事実だけである。
  // 記録が終わってから分かる事実を混ぜると、起点があとから動く。
  // とくに intervalSec は記録中に変えられるので、ここには絶対に入れない
  // （トレーラーへ出す）。
  // 第2弾b2で足した nyquistHz・settingsRaw・bands・fftSize も、記録を始めた時点で決まる値である
  // （組み立ては chainHeaderMeta）。帯域の欠測のように記録中に増える値は、入れるならトレーラーへ出す。
  function csvHeaderLines(meta) {
    const m = meta || {};
    const out = [];
    const put = (k, v) => { const line = metaLine(k, v); if (line) out.push(line); };
    put('format', 'mic-gain-logger/3');
    put('engine', m.engine);
    put('started', m.started);
    put('sampleRate', m.sampleRate);
    put('nyquistHz', m.nyquistHz);
    put('device', m.device);
    put('processing', m.processing);
    put('settingsRaw', m.settingsRaw);
    // 周波数の重み付けはしない。A特性・C特性は README の「将来案に入れないもの」にある
    // （重み付けをしても dBFS は dB SPL にならず、規制値・基準値と比べられるものだと誤読されるため）
    put('weighting', 'Z');
    put('bands', m.bands);
    put('fftSize', m.fftSize);
    put('hash', m.hashAlgo);
    return out;
  }

  // ---- ログ間隔のラン（どの seq からどの間隔か）----
  //
  // ⚠ 列は増やさない。行ごとのログ間隔は、変わったところだけを
  //    `# intervalSec=1@0+3@12`（seq 0 から1秒、seq 12 から3秒）の形で示す。
  //    読む側は seq を見れば、その行がどちらの間隔で測られたか分かる。
  //    改修前は `1+3` で、混在していることしか分からなかった。
  function intervalRuns(rows) {
    const out = [];
    for (const r of rows || []) {
      if (!r || !Number.isFinite(r.intervalSec)) continue;
      const last = out[out.length - 1];
      if (last && last.sec === r.intervalSec) continue;
      out.push({ sec: r.intervalSec, seq: Number.isFinite(r.seq) ? r.seq : null });
    }
    return out;
  }

  function formatIntervalRuns(runs) {
    if (!runs || !runs.length) return null;
    return runs
      .map(r => (r.seq === null ? String(r.sec) : `${r.sec}@${r.seq}`))
      .join('+');
  }

  // 行の列から、トレーラーへ出すログ間隔のラベルを作る
  function intervalRunsLabel(rows) {
    return formatIntervalRuns(intervalRuns(rows));
  }

  // ---- セッションの境界（重みを timestamp の差で取れない行）----
  //
  // ⚠⚠ timestamp は区間の終わりなので、隣の行との差がそのまま区間長になる。
  //    ただし記録を止めて再開すると、その差に休止時間がまるごと入る
  //    （audioCtx はセッションごとに作り直され、壁時計のアンカーも取り直す）。
  //    README の重み付け手順がこの差を重みにしていたため、実測17行・境界の差
  //    60.032 秒の記録で Leq が 6.49 dB 外れた（境界の行が静かなら低く、
  //    大きければ高く外れる。実測ではもう一方の並びで +2.00 dB）。
  //    セッションの先頭の seq をここに出し、その行だけは差を使わせない。
  //    列は増やさず、行数ぶんの情報も出さない（境界の位置だけで足りる）。
  function sessionStartSeqs(rows) {
    const out = [];
    let prevId;
    (rows || []).forEach((r, i) => {
      if (!r) return;
      const id = r.metaId || null;
      if (i === 0 || id !== prevId) {
        if (Number.isFinite(r.seq)) out.push(r.seq);
      }
      prevId = id;
    });
    return out;
  }

  // トレーラー行（ハッシュの行を除いた本体）。
  //
  // 記録が終わってから分かる事実はすべてここへ集める。起点に混ぜないためである。
  // extra = { intervalSec } — 行を採ったときのログ間隔（記録中に変えられる）
  function csvTrailerLines(logs, extra) {
    const rows = logs || [];
    const e = extra || {};
    const out = [];
    const put = (k, v) => { const line = metaLine(k, v); if (line) out.push(line); };
    // 行数。末尾の行をまとめて削られたことも、これとトレーラーのハッシュで分かる。
    // 0件でも出す（トレーラーが必ず在ることで、丸ごと落とされたら気づける）
    out.push(`# rows=${rows.length}`);
    put('intervalSec', e.intervalSec);
    // 計測モードが途中で変わった記録（記録開始→停止→開始のあいだにモードが変わる）。
    // ヘッダーの engine は記録を始めたときの値で凍結されるので、その差をここで示す
    const engines = [];
    for (const r of rows) {
      if (r && r.engine && engines.indexOf(r.engine) === -1) engines.push(r.engine);
    }
    if (engines.length > 1) put('engines', engines.join('+'));
    // このCSVに入っている計測セッションの数（記録開始→停止→記録開始で増える）。
    // ⚠ ヘッダーは1つめのセッションの条件で凍結される。2つめ以降で別のマイクへ
    //    差し替えられていても、ヘッダーからは分からない。数だけでも残しておけば、
    //    「ヘッダーが後半の行を説明していない」ことに気づける。
    const sessions = [];
    for (const r of rows) {
      if (r && r.metaId && sessions.indexOf(r.metaId) === -1) sessions.push(r.metaId);
    }
    if (sessions.length > 1) put('sessions', sessions.length);
    // 区間長を timestamp の差で取れない行（各セッションの先頭）。
    // 1行目も必ず入る（前の行が無いので差が取れない）ため、1件でも出す
    const starts = sessionStartSeqs(rows);
    if (starts.length) put('sessionStartAt', starts.join(','));
    if (rows.some(r => r && r.rawDb === -Infinity)) {
      // 無音は -Infinity で残す。行を落とすと「活動がなかった」ことを示せない
      put('silence', '-Infinity');
    }
    for (const line of clockTrailerLines(rows)) out.push(line);
    return out;
  }

  // AudioContext の中断（時刻の跳び）をトレーラー行へ出す。
  //
  // ⚠ 列にはしない。clockStatus / clockBreakKind / clockJumpMs はレコードには
  // 載っているが、CSV の列には入れていない（段階4で確定した列に、v3 で帯域の3列だけを足した）。
  // 列を足すと README・テスト・Excel の手順まで波が及ぶので、回数と位置だけを行で示す。
  //
  // これが無いあいだ、画面は「該当区間に印を付けた」と言うのに CSV には何も出ていなかった。
  // clockBreakAt は印が付いた区間の seq で、その行の直前でアンカーを取り直している。
  function clockTrailerLines(logs) {
    const marked = (logs || []).filter(r => r && r.clockStatus === CLOCK_RESYNC);
    if (!marked.length) return [];   // 中断が0回なら行そのものを出さない
    const drift = marked.reduce(
      (a, r) => a + (Number.isFinite(r.clockJumpMs) ? r.clockJumpMs : 0), 0
    );
    return [
      `# clockBreaks=${marked.length}`,
      `# clockBreakAt=${marked.map(r => (Number.isFinite(r.seq) ? r.seq : '')).join(',')}`,
      `# clockDriftMs=${Math.round(drift)}`
    ];
  }

  // トレーラーを鎖の最後の輪にする。
  //
  // 最後の行のハッシュを材料に混ぜるので、トレーラーを書き換えても、
  // 末尾の行をまとめて削っても（行数が合わなくなるので）検出できる。
  // 行の材料はコンマ区切りだが、トレーラーの材料はファイルに並んでいるとおり
  // 改行でつなぐ。1行1項目なので、そのまま読み直せる。
  function trailerHashInput(prevHex, lines) {
    return String(prevHex || '') + '|' + lines.join('\n');
  }

  // ---- 記録中に鎖を進める入れ物 ----
  //
  // ⚠⚠ ハッシュは1区間につき1回だけ計算する。
  // 改修前は書き出しのたびに全行を計算し直していた。起点にあとから分かる事実が
  // 混ざっていたため、同じセッションを2回書き出すと同じ行のハッシュが変わった。
  // 記録中に計算して行へ貼っておけば、書き出しは組み立てるだけになる。
  //
  // digest(text) は SHA-256 の16進文字列を返す関数（使えない環境では null）。
  // ブラウザーの crypto は呼ぶ側から渡す。logic.js を DOM もブラウザーAPIも
  // 触らない純ロジックに保ち、テストからも回せるようにするためである。
  const CHAIN_SKIP = {};   // 「この区間は計算しない」ことを表す内側の印

  function createHashChain(digest) {
    let meta = null;                    // 凍結した起点のヘッダー
    let prev = null;                    // 直前の行のハッシュ
    let tail = Promise.resolve();       // 計算を並べる待ち行列（順番を崩さない）
    let unavailable = false;            // 鎖を作れない（digest が null を返す環境）
    let gen = 0;                        // 鎖の世代
    const errors = [];

    // ⚠ 計算中にログを捨てられると、古い鎖の計算があとから解決して
    //    新しい鎖の prev を上書きしうる。世代が変わった計算はその場で捨てる。
    function reset() {
      gen += 1;
      meta = null;
      prev = null;
      tail = Promise.resolve();
      unavailable = false;
      errors.length = 0;
    }

    // 1行目が確定した時点で起点を凍結する。以降、何度書き出しても起点は動かない
    function begin(headerMeta) {
      meta = headerMeta;
      prev = null;
      unavailable = false;
      const mine = gen;
      const seed = csvSeed(meta);
      tail = tail.then(() => digest(seed)).then((full) => {
        if (mine !== gen) return;
        if (full === null) {
          unavailable = true;
          return;
        }
        prev = full.slice(0, HASH_HEX_LEN);
      }).catch((e) => {
        if (mine !== gen) return;
        unavailable = true;
        errors.push(e);
      });
    }

    // 1区間ぶん鎖を伸ばし、その行にハッシュを貼る
    function extend(rec) {
      rec.hash = '';
      const mine = gen;
      tail = tail.then(() => {
        if (mine !== gen || unavailable || prev === null) return CHAIN_SKIP;
        return digest(hashInput(prev, csvDataFields(rec)));
      }).then((full) => {
        if (full === CHAIN_SKIP || mine !== gen) return;
        if (full === null) {
          unavailable = true;
          return;
        }
        prev = full.slice(0, HASH_HEX_LEN);
        rec.hash = prev;
      }).catch((e) => {
        if (mine !== gen) return;
        unavailable = true;
        errors.push(e);
      });
    }

    // 記録中の計算が全部終わるまで待つ（書き出しの直前で呼ぶ）
    function settled() {
      return tail;
    }

    // 行に貼られたハッシュ。1つでも欠けていたら null（＝鎖を名乗らない）
    function hashes(logs) {
      if (unavailable) return null;
      const out = [];
      for (const r of (logs || [])) {
        if (typeof r.hash !== 'string' || !r.hash) return null;
        out.push(r.hash);
      }
      return out.length ? out : null;
    }

    // トレーラーを鎖の最後の輪として封じる
    function sealTrailer(lines) {
      if (unavailable || prev === null) return Promise.resolve(null);
      return Promise.resolve(digest(trailerHashInput(prev, lines)))
        .then((full) => (full === null ? null : full.slice(0, HASH_HEX_LEN)))
        .catch((e) => {
          errors.push(e);
          return null;
        });
    }

    return {
      reset,
      begin,
      extend,
      settled,
      hashes,
      sealTrailer,
      get meta() { return meta; },
      get prev() { return prev; },
      get unavailable() { return unavailable; },
      get errors() { return errors; },
      get generation() { return gen; }
    };
  }

  // ⚠ 書き出すのは rawDb（生値）である。
  // 改修前は表示下限でクリップした値を記録していたため、記録中に表示の設定を
  // 変えるとログデータ自体が変質していた。表示下限は表示のための設定なので、
  // 記録には触らせない（db は表示用、rawDb は記録用と役割を分ける）。
  //
  // ファイルの形は
  //   ヘッダーのメタ行（＝鎖の起点）→ 列のヘッダー → データ行 → トレーラー行
  // である。トレーラーも `#` で始めるので、README が案内している
  // 「`#` から始まる行を除外する」取り込み手順がそのまま使える。
  //
  // opts.hashes      csvDataFields と同じ並びの配列（省略可）。記録中に計算した値を渡す
  // opts.intervalSec 行を採ったときのログ間隔（トレーラーへ出す）
  // opts.trailerHash トレーラー行のハッシュ（鎖の最後の輪）
  function buildCsv(logs, opts) {
    const o = opts || {};
    const meta = Object.assign({}, o.meta);
    if (o.engine && !meta.engine) meta.engine = o.engine;
    if (o.hashes && !meta.hashAlgo) meta.hashAlgo = o.hashAlgo || HASH_ALGO_LABEL;

    const head = csvHeaderLines(meta);
    const trailer = csvTrailerLines(logs, { intervalSec: o.intervalSec });
    const trailerHashLine = metaLine('trailerHash', o.trailerHash);
    if (trailerHashLine) trailer.push(trailerHashLine);

    const rows = logs.map((r, i) => {
      const fields = csvDataFields(r);
      fields.push(o.hashes ? (o.hashes[i] || '') : '');
      return fields.join(',');
    });
    return head.concat([CSV_COLUMNS.join(',')], rows, trailer)
      .map(l => l + '\n').join('');
  }

  function csvFileName(date) {
    const ts = date.toISOString().replace(/[:.]/g, '-');
    return `mic-gain-logs-${ts}.csv`;
  }

  return {
    clamp,
    dbToPercent,
    formatHMS,
    rmsToDbfs,
    rmsOf,
    METER_WINDOW_SAMPLES,
    meterWindowMs,
    parseFloorDb,
    FLOOR_DB_DEFAULT,
    FLOOR_DB_DEFAULT_BANDS,
    floorDbDefaultFor,
    meterScaleLabels,
    FLOOR_DB_MIN,
    FLOOR_DB_MAX,
    parseIntervalSec,
    dbToPower,
    powerToDb,
    createStats,
    recordDurationSec,
    statsWeightOf,
    addStatsSample,
    addStatsRecord,
    ultraDbOf,
    formatUltraMax,
    statsLeq,
    formatDbCell,
    formatStats,
    statsWarnings,
    CLIP_RUN_SUSTAINED,
    statsWarningItems,
    noticeSummary,
    statsIntegrity,
    emptyStatsText,
    COMPACT_MEDIA_QUERY,
    startStopView,
    moreMenuNext,
    canvasPixelSize,
    GRAPH_WINDOW_SEC,
    GRAPH_TOP_DB,
    graphArea,
    timeToX,
    dbToY,
    timeTickStepSec,
    timeTicks,
    dbTickStep,
    dbTicks,
    pruneSeries,
    seriesPointOf,
    GRAPH_LINE_STYLES,
    graphLinePoints,
    ENGINE_WORKLET,
    ENGINE_FALLBACK,
    framesForInterval,
    intervalSecOfFrames,
    intervalRuns,
    formatIntervalRuns,
    intervalRunsLabel,
    sessionStartSeqs,
    validRatioOf,
    audioTimeToWallMs,
    CLOCK_JUMP_THRESHOLD_MS,
    CLOCK_BREAK_SUSPEND,
    CLOCK_BREAK_STALL,
    CLOCK_OK,
    CLOCK_RESYNC,
    createClockAnchor,
    clockDriftMs,
    detectClockJump,
    reanchorClock,
    clipForDisplay,
    PROCESSING_KEYS,
    PROCESSING_OPTIONAL_KEYS,
    PROCESSING_OFF,
    PROCESSING_ACTIVE,
    PROCESSING_UNKNOWN,
    buildSessionMeta,
    SETTINGS_RAW_KEYS,
    SETTING_UNREPORTED,
    settingsRawLabel,
    processingVerdict,
    processingLabel,
    chainHeaderMeta,
    recordNoticeItems,
    CONNECT_HINT_MS,
    CONNECT_TIMEOUT_MS,
    createAttemptGate,
    raceWithTimeout,
    TRACK_LIVE,
    TRACK_ENDED,
    DEVICE_LOST_ENDED,
    DEVICE_LOST_GONE,
    readTrackState,
    isTrackLost,
    markDeviceLoss,
    buildIntervalRecord,
    buildFallbackRecord,
    BAND_DEFS,
    fftSizeForRate,
    bandBins,
    bandPlan,
    bandsLabel,
    bandsEnabledFromQuery,
    BAND_ULTRA_KEY,
    formatKhz,
    bandRangeLabel,
    recordableUpperHz,
    upperLimitText,
    ULTRA_STATE,
    ultraBandState,
    ultraSwatchShown,
    ultraLegendText,
    graphAriaLabel,
    formatSecLabel,
    ultraNowText,
    bandNoticeItems,
    formatCsvDb,
    buildCsv,
    CSV_COLUMNS,
    formatOptionalDb,
    csvDataFields,
    metaLine,
    csvHeaderLines,
    csvTrailerLines,
    clockTrailerLines,
    csvSeed,
    hashInput,
    trailerHashInput,
    createHashChain,
    HASH_ALGO_LABEL,
    HASH_HEX_LEN,
    csvFileName
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = MicGainLogic;
}
