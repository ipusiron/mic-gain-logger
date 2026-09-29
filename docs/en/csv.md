# 📊 CSV data format and how to use it

[Back to README](../../README.en.md) · [日本語](../csv.md)

This document covers the format of exported CSVs, what the hash chain can and cannot tell you, how to verify a CSV you received, and how to aggregate the data in a spreadsheet and in Python.

## CSV format (v3)

A file has four parts, in this order: header lines (lines starting with `#`) → the column header line → data rows → trailer lines (lines starting with `#`).

- Header lines: the measurement conditions fixed at the moment recording starts. They are also the starting point of the hash chain
- Trailer lines: facts known only after recording ends (the row count, which seq was measured at which log interval, session boundaries, whether there was silence, whether there were clock jumps)

The sample below was not written by hand; it is a CSV exactly as exported. We fed Chromium's fake microphone (`--use-file-for-fake-audio-capture`) a repeating pattern of 2 seconds of a synthesized 1 kHz (-20 dBFS) and 19 kHz (-30 dBFS) tone followed by 2 seconds of digital silence, and recorded 4 intervals at a log interval of 1 second. The 3rd row is the digital-silence interval.

```
# format=mic-gain-logger/3
# engine=worklet
# started=2026-09-29T03:06:21.680Z
# sampleRate=48000
# nyquistHz=24000
# device=Fake Default Audio Input
# processing=off
# settingsRaw=echoCancellation:false;autoGainControl:false;noiseSuppression:false;sampleRate:44100;channelCount:2
# weighting=Z
# bands=18000-22000,20-18000
# fftSize=1024
# hash=sha-256-chain-16
timestamp,dbfs,seq,peak_dbfs,clip,valid_ratio,band_ultra_dbfs,band_audible_dbfs,band_valid_ratio,hash
2026-09-29T03:06:21.680Z,-19.70,0,-14.83,0,1.000,-30.44,-20.03,1.000,030554522ee00119
2026-09-29T03:06:22.680Z,-19.72,1,-14.83,0,1.000,-30.45,-20.05,1.000,b274e8d3ca7e6a0e
2026-09-29T03:06:23.680Z,-Infinity,2,-Infinity,0,1.000,-Infinity,-Infinity,1.000,9381a0b301d41f3c
2026-09-29T03:06:24.680Z,-37.54,3,-14.83,0,1.000,-53.05,-42.59,1.000,bfe90bfc6ddf9b43
# rows=4
# intervalSec=1@0
# sessionStartAt=0
# silence=-Infinity
# trailerHash=8fc5d56a3447408a
```

The `sampleRate:44100;channelCount:2` in `# settingsRaw=` is what the fake microphone's audio track reported. It is separate from the AudioContext sample rate (`# sampleRate=48000`), and the two can differ like this. When the audio track's rate is lower, the ultrasonic band values drop (see "Band columns" below).

⚠**Do not put facts that become known later into the header lines.** This is not a design convenience; it is a condition for the hash chain to hold. If a value that grows after recording ends were placed in the header lines, the starting point would move, and exporting the same session twice would change the hash of the same row. To the receiver, the file would look altered. "Why the starting point is split between header and trailer lines" below explains this in detail.

The columns mean the following.

| Column | Meaning |
|---|---|
| `timestamp` | Time at the end of the interval (ISO 8601, UTC) |
| `dbfs` | Energy average of the interval (raw value). Exported rounded to 2 decimal places. Digital silence is `-Infinity`. An interval where no sample arrived at all (a missing interval) is empty (see "Missing intervals" below) |
| `seq` | Sequence number of the interval. Numbered from 0 throughout one CSV (even if you repeat Start recording → Stop → Start recording, numbering continues from where it left off). A gap in the numbers means a row is missing |
| `peak_dbfs` | Peak within the interval. Empty for rows taken in fallback mode and for missing intervals |
| `clip` | Number of samples that hit 0 dBFS. Empty for rows taken in fallback mode and for missing intervals |
| `valid_ratio` | Share of samples in that interval that could actually be aggregated. Below 1.000 means part of that interval's sound did not arrive (a render quantum was dropped, the input was interrupted, and so on). `0.000` for missing intervals. Right after recording starts, an interval begins only after confirming that the audio clock advances one block at a time without breaks (the first few milliseconds are not recorded). It also does not begin until sound arrives on the input; if no sound comes within 1 second, the interval begins from there and the part that did not arrive is kept as missing. Empty for rows taken in fallback mode |
| `band_ultra_dbfs` | Energy average of the ultrasonic band (18,000–22,000 Hz) over the interval. Same format as `dbfs` (2 decimal places; `-Infinity` for zero power). Empty when there is no value (see "Band columns" below) |
| `band_audible_dbfs` | Energy average of the audible band (20–18,000 Hz) over the interval. Placed alongside as a reference for reading whether the ultrasonic band value is high or low. Same format as `band_ultra_dbfs` |
| `band_valid_ratio` | Share of frames that could be used for the band computation (frames counted ÷ frames expected). Same format as `valid_ratio` (3 decimal places) |
| `hash` | Hash chain value (first 16 characters of SHA-256). Empty when the page is opened outside a secure context (see "Where hashes cannot be computed" below) |

⚠In fallback mode, `peak_dbfs`, `clip`, `valid_ratio` and the three band columns are empty. Fallback mode only receives one value per interval from the drawing loop, so it cannot count the peak within the interval, the number of clipped samples or dropped samples, and it cannot split the sound into bands. The header line `# engine=` tells you which mode a CSV was taken in.

The three columns `peak_dbfs`, `clip` and `valid_ratio` also appear on the screen. The maximum of `peak_dbfs` is "Sample peak" in the statistics, and anomalies in `clip` and `valid_ratio` are the warnings in the status display. Fallback mode cannot measure them, so "Sample peak" stays `--.-` and no warning appears (so that "not measurable" is not shown as "no problem"). The band columns appear on the screen too: `band_ultra_dbfs` as the dashed line on the graph and as "Ultrasonic max" in the statistics, and intervals where `band_valid_ratio` fell below 1.000 in the recording notes. `band_audible_dbfs` appears only in the CSV.

⚠`peak_dbfs` can exceed 0 dBFS. The samples that Web Audio passes on are floating point, so overshoot from resampling can push the amplitude above 1.0. In a measurement with a full-scale square wave, `peak_dbfs` was `1.70` (+1.7 dBFS), and `clip` in the same interval was 23,263 samples. If it exceeds 0 dBFS, that interval has samples whose amplitude went above 1.0. If the signal was capped upstream, that interval's `dbfs` differs from the real sound.

Column A is the time and column B is the level. New columns are added to the right of column B, so these two columns do not move. The three band columns sit to the left of the `hash` column, which is column J. The hash input is "the fields left of the `hash` column", so this puts the band values into the chain as well.

However, **the column header line is not the first line of the file.** The header lines starting with `#` come above it. There are usually 12 header lines (an item without a value has no line at all). Below the data rows, 3 to 10 trailer lines follow. When you import the file into a spreadsheet, skip the lines starting with `#` as described in "Analysis steps in Excel/Google Sheets" below.

### Missing intervals (rows with an empty `dbfs`)

For an interval where no sample arrived at all (the audio thread dropped render quanta for the whole interval, no input arrived within 1 second after recording started, and so on), `dbfs`, `peak_dbfs` and `clip` are empty and `valid_ratio` is `0.000`.

If a missing interval were kept as `-Infinity` (digital silence), the CSV could not distinguish "there was no sound" from "nothing was recorded", so it is left empty. These intervals are not included in the on-screen statistics (average, max, min) either. Counting them as silence would lower the average (Leq) by the time that was not measured. They are counted as recording gaps and remain in the on-screen notes and in `valid_ratio`.

Digital silence (samples arrived, but every amplitude was 0) is kept as one row with `-Infinity`.

### Band columns (`band_ultra_dbfs`, `band_audible_dbfs`, `band_valid_ratio`)

⚠**A band value is a record of whether there was sound energy in that band.** It cannot tell what the sound is, and it is not a tool for finding ultrasonic beacons either. Like `dbfs`, the values are relative and depend on the device (microphone, converter, sample rate), so they cannot be compared with regulatory limits or standards ("Cannot be compared with regulatory limits or standard values" in the [use cases document](use-cases.md)).

- Band definitions: the ultrasonic band is 18,000 Hz or higher and below 22,000 Hz; the audible band is 20 Hz or higher and below 18,000 Hz. The header line `# bands=18000-22000,20-18000` lists the same definitions in column order
- How it works: on the audio thread, about 21 ms of samples (1,024 at 48 kHz; the length is in the header line `# fftSize=`) form one frame. A periodic Hann window is applied, an FFT splits the frame into the strength at each frequency, and the results are summed per band. The frames overlap, each shifted by a quarter (about 5 ms), so in an interval without breaks, the sound at every moment is counted with the same weight
- The actual lower edge of the audible band: about 50 Hz. The mean of each frame is subtracted before the computation, so sounds below about 100 Hz change in value. Below about 50 Hz they read low, and between 50 and 100 Hz they move up or down by about ±0.5 dB (at 48 kHz: 20 Hz about -8 dB, 30 Hz about -4 dB, 50 Hz about -0.4 dB, 70 Hz about +0.5 dB). The `20` in `# bands=` is the defined value, not the actual sensitivity
- A sound at exactly 22 kHz: it sits on the band edge, so it reads low (about -2 dB at 48 kHz, about -6 dB at 44.1 kHz). The part that leaks beyond the upper edge of the ultrasonic band goes into neither band. At 44.1 kHz, 22 kHz is just below the Nyquist frequency (22.05 kHz)
- The header line `# nyquistHz=`: half the AudioContext sample rate. It is the upper limit for computing bands, but not necessarily the upper limit of the sound that actually arrives. If the sample rate of the microphone's audio track (`sampleRate` in `# settingsRaw=`) is lower, the actual upper limit is half of that, and values can drop before that point. Playing a -20 dBFS tone into the fake microphone (audio track 44.1 kHz, AudioContext 48 kHz), 1 kHz gave `-20.00` for both `dbfs` and `band_audible_dbfs`, but at 21 kHz `band_ultra_dbfs` dropped to `-53.78`, and at 23 kHz `dbfs` was `-101.99`, so nothing remained (`# nyquistHz=24000` in every case). Read ultrasonic band values against the smaller of `# nyquistHz=` and half the `sampleRate` in `# settingsRaw=`
- Notes on the screen: this mismatch appears in the recording notes. When the sample rates of the microphone's audio track and the AudioContext differ, a note says "Sample rate conversion records high sounds near the limit lower" and shows both values (in the fake-microphone example above, a -20 dBFS tone at 21 kHz was recorded at about -54 dBFS). The "Recordable limit on this device" under the legend is the "smaller" one above (half of the smaller of the AudioContext and track sample rates). When the track does not report its sample rate, no note appears, and the limit is shown as half of the AudioContext rate with "track rate unknown" added
- The 18 kHz boundary: sound within a range of about 94 Hz is split between the neighboring bands (due to window leakage; the total of both bands does not change)
- Sound just before an interval boundary: about 21 ms of sound can go into the value of the following interval. This is because each frame is counted in "the interval that contains the frame's end" (so that the computation is finished when the interval ends and that row can be given its hash). As a result, a row whose `dbfs` is `-Infinity` (digital silence) can still have band values. When we exported the interval right after the fake microphone switched from sound to silence, `dbfs` was `-Infinity` and the bands were `-51.02` and `-40.58`
- How "Ultrasonic max" counts: the on-screen statistic "Ultrasonic max" also counts band values attached to digital-silence rows, because such a value is the real sound of about 21 ms just before the boundary, not a fictitious value (values attached to rows of intervals where no sample arrived at all are counted for the same reason). The statistics "Max" and "Min", on the other hand, leave out silent rows
- Sound near the starting point of the recording: sound within about 21 ms of the starting point of the recording gets less weight. A 1 ms sound 6.3 ms after the starting point counts only about 33%. This is the trade-off for not making the first row a spurious missing interval; it does not show in `band_valid_ratio` (it happens every time recording starts)
- `band_valid_ratio`: frames counted ÷ frames expected. It falls below 1.000 when a render quantum was dropped or the input arrived empty; frames containing those samples are not counted (filling them with 0 would mean "there was no sound"). If no frame was counted, the two band columns are empty; if no frame was expected, `band_valid_ratio` is empty too
- `?bands=off`: when added to the URL, bands are not computed (this is for comparing `valid_ratio` with and without bands on the same version). The three band columns are then all empty, and the header line is `# bands=off` (no `# fftSize=` line). On the screen, the legend and the notes say that it is stopped, the dashed line is not drawn on the graph, and "Ultrasonic max" in the statistics stays `--.-`
- Sample rates that cannot measure the ultrasonic band: when the AudioContext sample rate is so low that no bin falls in the ultrasonic band (when the Nyquist frequency does not reach 18 kHz), `band_ultra_dbfs` is empty, a note on the screen says "Ultrasonic band not measurable", and the legend says "not measurable at this sample rate"
- Fallback mode: in rows taken in fallback mode, the three band columns are empty too (so that "not measurable" is not shown as "no problem"). On the screen, the legend says "not measured in fallback mode" and a note says "Bands not computed (fallback mode)"

### Header lines (fixed when recording starts; the starting point of the hash chain)

| Key | Meaning |
|---|---|
| `format` | CSV version (`mic-gain-logger/3`). The verifier in "Verifying a CSV you received" below can also check the 7-column `mic-gain-logger/2` (v2) |
| `engine` | Measurement mode when recording started. `worklet` (AudioWorklet) / `fallback` (fallback mode) |
| `started` | Time of the first interval |
| `sampleRate` | AudioContext sample rate |
| `nyquistHz` | Half the AudioContext sample rate (`sampleRate` above). This is the upper frequency limit for computing bands. At 44.1 kHz it is `22050`, and the upper edge of the ultrasonic band (22,000 Hz) is just below it. ⚠If the sample rate of the microphone's audio track (`sampleRate` in `settingsRaw` below) is lower, the actual upper limit is half of that (see "Band columns" above) |
| `device` | Name of the microphone device |
| `processing` | The state of microphone-side audio processing (AGC, noise suppression, echo cancellation) as reported by the browser's `getSettings()`. `off` = all three items were reported as disabled. `active:<items>` = items reported as enabled. `unknown:<items>` = items the browser did not report (the WebKit source shows that Safari is built not to report `autoGainControl` and `noiseSuppression`; in the CSVs from a real iPhone 18 Pro Max, these two items were not reported either). When both occur, they are joined with `;`, as in `active:echoCancellation;unknown:autoGainControl` |
| `settingsRaw` | The raw values reported by `getSettings()` for the 5 items related to audio processing and the sample rate (`echoCancellation`, `autoGainControl`, `noiseSuppression`, `sampleRate`, `channelCount`). Items that are not reported are `unreported`. `processing` is the interpretation and this is the raw value; both are kept. The `sampleRate` here is the value of the microphone's audio track and can differ from `sampleRate` above (AudioContext). ⚠`deviceId` and `groupId`, which can identify the device, are not included |
| `weighting` | Frequency weighting. This tool applies no weighting, so it is always `Z` |
| `bands` | Band definitions (Hz, lower bound inclusive, upper bound exclusive). The ultrasonic band and the audible band in column order (`18000-22000,20-18000`). `off` when the page is opened with `?bands=off` |
| `fftSize` | Length of the FFT used for the band computation (`1024` at 44.1 kHz and 48 kHz, `2048` at 88.2 kHz and 96 kHz; about 21–23 ms in every case). When bands are not computed (`?bands=off`, fallback mode), the line itself does not appear |
| `hash` | The hash chain method. In records where the chain could not be built, the line itself does not appear |

### Trailer lines (known only after recording ends)

| Key | Meaning |
|---|---|
| `rows` | Number of data rows. If the count does not match, rows at the end have been dropped |
| `intervalSec` | The log interval (seconds) with which each interval was actually measured, listed as `interval@start seq` (e.g. `1@0+3@12` = 1 second from seq 0, 3 seconds from seq 12). Only changes are listed, so if there is no `+`, every interval has the same length. The log interval can be changed during recording, and the log accumulates across sessions, so one CSV can mix several intervals. ⚠**It is not the on-screen setting** (see "Changing the log interval and the row labels" below) |
| `engines` | Appears only in records where the measurement mode changed midway (e.g. `worklet+fallback`). The header line `engine` is the value when recording started, so this line shows the difference |
| `sessions` | Number of measurement sessions in this CSV. It grows when you repeat "Start recording → Stop → Start recording". Records taken in a single session do not have it. ⚠If this line is present, the header lines describe only the conditions of the first session (even if you switched to a different microphone in a later session, the header lines cannot tell you) |
| `sessionStartAt` | The `seq` of the first row of each measurement session (comma-separated). The first row is always included, because it has no row before it. ⭐**For the rows with these `seq` values, do not take the interval length from the `timestamp` difference** (at a boundary where recording was stopped and resumed, the difference includes the whole pause). Used in "Analysis steps in Excel/Google Sheets" below |
| `silence` | How silence is written. Appears only in records that contain silence (`-Infinity`) |
| `clockBreaks` | Number of AudioContext suspensions found. Records where none was found do not have it |
| `clockBreakAt` | The `seq` of the intervals that spanned a suspension (comma-separated). The anchor was reset just before that row |
| `clockDriftMs` | Total of the jumps found (milliseconds) |
| `trailerHash` | Hash of the trailer itself. It is the last link of the chain (see "What the hash chain can tell you" below) |

When the AudioContext stops because of a screen lock or a paused tab, only the audio clock falls behind, and left alone, the timestamps would drift without any sign. This tool notices this, resets the anchor, and keeps the intervals that spanned the pause in `# clockBreakAt=`. A jump in time across the row with this `seq` is normal.

```
# clockBreaks=2
# clockBreakAt=11,25
# clockDriftMs=880
```

### Changing the log interval and the row labels

The log interval can be changed during recording. However, **a change takes effect from the next interval boundary.** Intervals are aggregated on the audio thread, so the interval being measured cannot be cut at the moment the on-screen setting changes.

As a result, some intervals were measured at a length different from the on-screen setting. In a measurement through the worklet itself, after 2 intervals were taken at 1 second and the setting was switched to 3 seconds, the next interval (seq 2) was still measured at 1 second.

| `seq` | Interval length actually measured | On-screen setting |
|---|---|---|
| 0 | 1.000000 s | 1 |
| 1 | 1.000000 s | 1 |
| 2 | 1.000000 s | 3 (the setting is already 3) |
| 3 | 3.000000 s | 3 |
| 4 | 3.000000 s | 3 |

The row labels (the trailer line `# intervalSec=`) are not the on-screen setting; they come from the difference between `startFrame` and `endFrame` held by each interval record, that is, the measured interval length. The trailer lists only the changes as `interval@start seq`, so the record above becomes `# intervalSec=1@0+3@3`, and you can read that seq 2 was measured at 1 second. There is no per-interval column for the interval length; one trailer line shows it.

### Session boundaries (`# sessionStartAt=`)

`timestamp` is the time at the end of an interval, so the difference from the previous row is the interval length. **This does not hold at a boundary where recording was stopped and resumed.** Each session creates a new `AudioContext` and resets the wall-clock anchor, so the difference includes the whole pause.

A measurement (17 rows, 1-second intervals, 2 sessions; the `timestamp` difference at the boundary was 60.032 seconds = a 59.032-second pause + the 1 second of that interval).

| How the interval length is taken | Leq | Sum of the weights |
|---|---|---|
| On-screen value (`endTime - startTime` of the interval record) | -22.8601 dBFS | 17 s |
| Using the `timestamp` difference as is as the weight | -29.3472 dBFS (6.49 dB lower) | 76.032 s |
| Using the `# intervalSec=` value only for the boundary rows | -22.8601 dBFS (matches the screen) | 17 s |

⚠The direction of the error depends on the contents of the record. If the boundary row is quiet, the result comes out lower; if it is loud, higher. In a record with the same pause and the order reversed, it was +2.00 dB. The longer the pause, the larger the error: with a 600-second pause it was -15.42 dB.

So the `seq` of the first row of each session is written to `# sessionStartAt=`. **For this row, and for the rows in `# clockBreakAt=`, do not take the interval length from the difference.** This is built into "Analysis steps in Excel/Google Sheets" below.

## ⚠ Check the contents before handing a CSV to someone

The header line `# device=` contains the microphone's device name as is. **A device name can include the user's name** (such as "Your Name's AirPods"). Open this line and check it before you hand the file over, and remove it if needed.

However, the starting point of the hash chain is the header lines themselves. If you rewrite them, recomputing the hashes fails from the first row.

## What the hash chain can tell you

Each row's hash is computed from "the previous row's hash + that row's data". The chain has three parts.

1. Starting point = the header lines: fixed when recording starts, so it does not move during recording or after export
2. Data rows: each one mixes the previous row's hash into its input, so they link in order from the top
3. Trailer = the last link: computed with the last data row's hash mixed into its input. Because of it, you can also tell when rows at the end were dropped together

### What it can tell you

⭐**What it can do is find accidental corruption, partial loss and reordering when a CSV arrives as it was.** Within this range, it helps as follows.

- You can notice that a file was damaged or partly lost during transfer or storage
- You will not mistake a file that was edited and resaved in Excel for the original (once the `#` lines are removed the check no longer passes, so you can tell it is a processed file)
- If you receive a file with rows deleted, you can tell, **as long as the other party did not notice the deletion**

Gaps in `seq` are another, separate clue.

### What it cannot tell you

⚠⚠**It does not withstand intentional changes, whoever makes them.** The dividing line is not "the author or a third party" but whether the hashes are recomputed.

How the chain is built is fully described in "Verifying a CSV you received" below. If you rewrite values and then recompute the hashes with the same steps, the check passes as is. The table below shows the results of altering the sample CSV above, re-linking the chain with a separate script, and running the verifier from "Verifying a CSV you received" below (the v2 sample gave the same results).

| Change | Only changed | After re-linking the chain |
|---|---|---|
| Delete row 2 | `Mismatch starting at row 2 (expected d354201d21980d81 / actual 9381a0b301d41f3c)` | `All rows passed (rows: 3; the trailer matches too)` |
| Swap rows 2 and 3 | `Mismatch starting at row 2 (expected d354201d21980d81 / actual 9381a0b301d41f3c)` | `All rows passed (rows: 4; the trailer matches too)` |
| Rewrite `dbfs` in row 1 from `-19.70` to `-12.00` | `Mismatch starting at row 1 (expected f21aa286c3591dcf / actual 030554522ee00119)` | `All rows passed (rows: 4; the trailer matches too)` |
| Cut off the last 2 rows | `Trailer mismatch (expected 6a32793731b33ff7 / actual 8fc5d56a3447408a)` | `All rows passed (rows: 2; the trailer matches too)` |
| Delete the silent row | `Mismatch starting at row 3 (expected d8d90f1f3e5e1d7d / actual bfe90bfc6ddf9b43)` | `All rows passed (rows: 3; the trailer matches too)` |
| Replace the header line `# device=` | `Mismatch starting at row 1 (expected 4a2fce97866b4af3 / actual 030554522ee00119)` | `All rows passed (rows: 4; the trailer matches too)` |
| Shift the data-row times by 1 hour | `Mismatch starting at row 1 (expected 4ea6de9f0dd72a3e / actual 030554522ee00119)` | `All rows passed (rows: 4; the trailer matches too)` |

There are only two ways to change this: sign with a private key, or deposit the hashes with an external timestamping authority.

⚠This tool uses neither. Depositing hashes externally requires outside communication, which would break the tool's design of "completing on the device and sending nothing out" (the CSP declares `connect-src 'none'`). Signing, for its part, would bring in a whole separate problem: how to protect the key on the device.

Therefore, this CSV **does not prove that a record is correct**. For uses that need proof, use a different system that has signing or a timestamping authority.

### Where hashes cannot be computed

Hashes use `crypto.subtle`. It is available only in a secure context, so when the page is opened from a non-HTTPS URL with a host name or IP address (such as `http://192.168.1.10:8000/`), the `hash` column is empty and the `# hash=` and `# trailerHash=` lines do not appear. When we opened `http://notlocalhost:8765/` (with only its name resolution pointed at `127.0.0.1`) in Chromium, `window.isSecureContext` was `false`, `crypto.subtle` was `undefined`, and `navigator.mediaDevices` was `undefined` too. **The microphone is not available there either.**

⚠**`file://` is not one of these.** In the same Chromium, opening `file:///D:/…/index.html` gave `window.isSecureContext` as `true`, and `crypto.subtle.digest('SHA-256', 'abc')` worked (the first 16 characters were `ba7816bf8f01cfea`). When we actually recorded for about 5 seconds on `file://` and exported the CSV, the `hash` column was filled, the `# hash=` and `# trailerHash=` lines appeared, and the verifier from "Verifying a CSV you received" below answered `All rows passed (rows: 4; the trailer matches too)`.

What fails on `file://` is loading the AudioWorklet module (`AbortError: Unable to load a worklet's module.`). In that case the tool switches to fallback mode, so the CSV has `# engine=fallback`, and `peak_dbfs`, `clip`, `valid_ratio` and the three band columns are empty. This is unrelated to hashes.

### Why the starting point is split between header and trailer lines

The starting point is limited to the header lines, which are fixed at the moment recording starts, and facts known later go to the trailer lines. If facts known only after recording ends, such as `# silence=` (whether there were silent rows), `# clockBreaks=` (how many clock jumps there were) and `# intervalSec=` (the log intervals used), were put into the starting point, simply continuing to record would change the starting point, and even the hashes of rows already exported would change. To the receiver that would look like an alteration, so the tool would not work as a way of keeping records.

You can confirm with the following steps that exporting the same session twice does not change the row hashes.

1. Record 6 seconds at a 1-second log interval, stop, and export the CSV
2. Resume recording, keep it running until it enters a silent interval, and change the log interval to 3 seconds along the way
3. Stop and export the CSV again

In the second CSV, the silent rows and the log interval change appear in the trailer lines (`# silence=`, `# intervalSec=`), but the hashes of the 6 rows exported the first time all stay the same. **However many times you export the same session, the same row gets the same hash.** The hash is computed only once per interval during recording and is not recomputed on export.

## Verifying a CSV you received

The receiver can recompute the `hash` column with the following steps. This tool is not needed. CSVs of both v3 (10 columns) and v2 (7 columns) can be checked the same way.

1. Find the column header line (`timestamp,dbfs,...`). The `#` lines above it are the starting point. Join them in file order with newlines (`\n`) into one string
2. ⚠**The column header line is not part of the hash input.** So first check that it matches the columns for the version in the starting point's `# format=`. For `mic-gain-logger/3` it is `timestamp,dbfs,seq,peak_dbfs,clip,valid_ratio,band_ultra_dbfs,band_audible_dbfs,band_valid_ratio,hash` (10 columns); for `mic-gain-logger/2` it is `timestamp,dbfs,seq,peak_dbfs,clip,valid_ratio,hash` (7 columns). Without this check, the chain still passes even if column names are swapped (`# format=` is in the starting point, so rewriting it does break the chain)
3. Compute the SHA-256 of the starting-point string in lowercase hexadecimal, and take the first 16 characters as "the previous hash"
4. Go through the data rows from the top. Each row's hash is the first 16 characters of `SHA-256(previous hash + "|" + the fields left of the row's `hash` column, joined with commas)`. Read the position of the `hash` column from the column header line. The fields left of the `hash` column are 9 in v3 and 6 in v2. Use the strings as written in the CSV (do not convert them to numbers; keep empty cells as empty strings)
5. Compare the result with the row's `hash` column. If they match, use that value as "the previous hash" for the next row
6. After the data rows, check the trailer. Join the trailer lines other than `# trailerHash=` in file order with newlines, compute the first 16 characters of `SHA-256(last row's hash + "|" + that string)`, and compare the result with the value of `# trailerHash=`. Also check that `# rows=` matches the number of data rows

The first row that no longer matches is where a deletion, reordering or rewrite happened.

```python
# verify_mic_gain_log.py — runs on the standard library only (Python 3.6 or later)
# Usage: python verify_mic_gain_log.py mic-gain-logs-2026-09-29T03-06-26-000Z.csv
# Checks both v3 (10 columns) and v2 (7 columns) CSVs. The position of the hash column is read from the column header line
import hashlib
import sys

# Columns of each version. The column header line is not part of the hash input, so this checks that it matches the version in the starting point's # format=
KNOWN = {
    "# format=mic-gain-logger/3": "timestamp,dbfs,seq,peak_dbfs,clip,valid_ratio,band_ultra_dbfs,band_audible_dbfs,band_valid_ratio,hash",
    "# format=mic-gain-logger/2": "timestamp,dbfs,seq,peak_dbfs,clip,valid_ratio,hash",
}

lines = [l for l in open(sys.argv[1], encoding="utf-8").read().splitlines() if l]
cols = [l for l in lines if l.startswith("timestamp,") and "hash" in l.split(",")]
if not cols:
    sys.exit("No column header line (this is not a CSV from this tool)")
at = lines.index(cols[0])
hx = cols[0].split(",").index("hash")      # position of the hash column (10th in v3, 7th in v2)
head = lines[:at]                          # starting point: the meta lines fixed when recording starts
rest = lines[at + 1:]
data = [l for l in rest if l[0] != "#"]    # data rows
trailer = [l for l in rest if l[0] == "#"] # trailer lines

# ⚠ Swapping column names does not break the chain, so check this first. Unknown versions (not in KNOWN) are not checked
fmt = [l for l in head if l in KNOWN]
if fmt and cols[0] != KNOWN[fmt[0]]:
    sys.exit("The column header line does not match the columns of the # format= version")


def h(s):
    return hashlib.sha256(s.encode("utf-8")).hexdigest()[:16]


def hash_cell(line):
    cells = line.split(",")
    return cells[hx] if len(cells) > hx else ""


# ⚠ Separate CSVs without a chain first, so that they are not mistaken for altered ones.
# If the hash column is empty in every row, crypto.subtle was not available where the log was recorded
if not any(hash_cell(l) for l in data):
    sys.exit("The hash column is empty in every row. This CSV has no chain, so this verifier cannot check it")

prev = h("\n".join(head))
for i, line in enumerate(data, 1):
    want = h(prev + "|" + ",".join(line.split(",")[:hx]))   # the fields left of the hash column
    if hash_cell(line) != want:
        sys.exit("Mismatch starting at row %d (expected %s / actual %s)" % (i, want, hash_cell(line)))
    prev = want

# The trailer is the last link of the chain. The last row's hash is mixed into its input
mark = "# trailerHash="
found = [l for l in trailer if l.startswith(mark)]
if not found:
    sys.exit("No trailer hash (the end has been cut off)")
want = h(prev + "|" + "\n".join(l for l in trailer if not l.startswith(mark)))
if found[0] != mark + want:
    sys.exit("Trailer mismatch (expected %s / actual %s)" % (want, found[0][len(mark):]))
if ("# rows=%d" % len(data)) not in trailer:
    sys.exit("The row count does not match the trailer (data rows: %d)" % len(data))
print("All rows passed (rows: %d; the trailer matches too)" % len(data))
```

These are the results of saving the sample CSV above (4 rows; row 3 is digital silence) as is and running this verifier on it.

⚠The values in this table were taken by actually running the verifier. Do not write them by hand. `test/chain-claim.test.js` compares the rows of this table in the Japanese version of this document with the output of the same steps built in JavaScript every time. The English messages below were taken by running the English verifier above on the same inputs.

| Input | Output |
|---|---|
| As is | `All rows passed (rows: 4; the trailer matches too)` |
| Delete row 2 | `Mismatch starting at row 2 (expected d354201d21980d81 / actual 9381a0b301d41f3c)` |
| Swap rows 2 and 3 | `Mismatch starting at row 2 (expected d354201d21980d81 / actual 9381a0b301d41f3c)` |
| Rewrite `dbfs` in row 2 | `Mismatch starting at row 2 (expected 0dde252ad3be6845 / actual b274e8d3ca7e6a0e)` |
| Delete the silent row | `Mismatch starting at row 3 (expected d8d90f1f3e5e1d7d / actual bfe90bfc6ddf9b43)` |
| Fake the header line `# sampleRate=` | `Mismatch starting at row 1 (expected 64744e0e7e010fae / actual 030554522ee00119)` |
| Remove the header line `# device=` | `Mismatch starting at row 1 (expected 25670b7ba0d959c6 / actual 030554522ee00119)` |
| Swap `band_ultra_dbfs` and `band_audible_dbfs` in the column header line | `The column header line does not match the columns of the # format= version` |
| Delete the last row | `Trailer mismatch (expected 0235fa9ba945658d / actual 8fc5d56a3447408a)` |
| Fake the trailer line `# intervalSec=` | `Trailer mismatch (expected b36fc8e461a815a7 / actual 8fc5d56a3447408a)` |
| Remove the trailer line `# silence=` | `Trailer mismatch (expected ce5492be34e77592 / actual 8fc5d56a3447408a)` |
| Drop the whole trailer | `No trailer hash (the end has been cut off)` |
| `hash` column empty in every row (a CSV without a chain) | `The hash column is empty in every row. This CSV has no chain, so this verifier cannot check it` |

v2 CSVs can be checked with the same verifier. The v2 sample (4 rows; `test/fixtures/sample_v2.csv`) gave `All rows passed (rows: 4; the trailer matches too)`, and a CSV exported on a real iPhone 18 Pro Max on 2026-09-29 (v2, 86 rows) gave `All rows passed (rows: 86; the trailer matches too)`. Applying the same changes as in the table above to the v2 sample also gave the same outputs as the table, except for the hash values (v2 has no band columns, so the column-name swap was checked with `dbfs` and `peak_dbfs`).

⚠**A CSV without a chain is different from an altered one.** If a CSV with an empty `hash` column were run through the chain check as is, it would say "Mismatch starting at row 1" and could not be told apart from an altered file. The verifier first looks at whether there is a chain, and returns a different message.

⚠Both the header lines and the trailer lines are checked. If you remove `# device=` before handing the file over, the receiver's recomputation does not pass. If you need to remove it before handing the file over, prepare both the edited file and the original. A CSV with an empty `hash` column cannot be verified. Most such files were exported where a chain cannot be built (a non-HTTPS URL with a host name or IP address), but clearing only the `hash` values in a chained CSV, while leaving the column in place, gives the same result. Tell them apart by whether the header lines have a `# hash=` line (if they do, there was a chain when the file was exported).

⚠Only the column header line is not part of the hash input. Swapping column names does not break the chain, so the verifier first checks that the column header line matches the columns for the version in the starting point's `# format=` (the "Swap … in the column header line" row of the table above). The verifier knows the column layouts of v2 and v3 only; for other versions, it skips this column-layout check. The order of the two band columns is also the same as the order in `# bands=`, which is in the starting point.

## Analysis steps in Excel/Google Sheets

⚠If you open the file as is, the first line is not the column header line. About 12 header lines starting with `#` come above it, and 3 to 10 trailer lines follow the data rows. Remove these before aggregating.

1. Remove the `#` lines: in Excel, import with "Data" → "From Text/CSV", exclude the lines starting with `#` in the Power Query editor, and then press "Use First Row as Headers". The header lines and the trailer lines both start with `#`, so this single exclusion removes both. In Google Sheets, import with "File" → "Import", then select the header lines at the top and the trailer lines at the bottom and delete those rows. ⚠A file with the `#` lines removed does not pass the check in "Verifying a CSV you received" above. Keep the original CSV separately for verification
2. Data import: when opening the CSV file, choose "comma-delimited" and "UTF-8 encoding"
3. Timestamp conversion: to have the ISO-format date and time recognized, change that column to a date-and-time format
4. Basic statistics

   ⚠Put working columns in column K or later. The 10 imported columns are column A `timestamp`, column B `dbfs`, column C `seq`, column D `peak_dbfs`, column E `clip`, column F `valid_ratio`, column G `band_ultra_dbfs`, column H `band_audible_dbfs`, column I `band_valid_ratio` and column J `hash`. If you overwrite column C (`seq`) or column H (`band_audible_dbfs`) for your work, you lose the band values or the clue for finding the boundary rows described below.

   ⚠First replace `-Infinity` in column B with `-999`. `-Infinity` is not a number, so without the replacement the energy-average formula returns `#VALUE!`. By definition, silence counts as zero power, and `-999` converted to power is practically 0, so it barely changes the average (in our own check, `-300`, `-1000` and `-1000000` all gave the same value to 12 decimal places). ⚠Do not delete silent rows "as whole rows". The time in the denominator shrinks and the average goes up. The increase is `10*LOG10(sum of the weights of all rows ÷ sum of the weights of the remaining rows)` regardless of the row values, so when the interval lengths are equal, it is set by the ratio of row counts (1.2494 dB higher for a record with 1 silent row out of 4, and 10.0000 dB higher for a record with 9 silent rows out of 10).

   ⚠A row with an empty column B is a missing interval (an interval where no sample arrived at all; `valid_ratio` is `0.000`). It is different from silence (`-Infinity`): nothing was measured, so it does not go into the Leq (the on-screen statistics leave it out too). ⚠Do not put it into the Leq formula while it is empty. An empty cell is treated as 0, so `POWER(10,0)` = 1 (equivalent to 0 dBFS) gets added. If you use the formula for equal intervals (below), remove the missing rows first (when the interval lengths are equal, the weights do not use `timestamp` differences, so removing whole rows is fine). If you use the weighted formula (below), do not delete the missing rows; set their interval length in column K to `0` instead (deleting a whole row would put the missing interval into the next row's `timestamp` difference). `=MAX()` and `=MIN()` ignore empty cells, so they can stay as they are.

   - Max, min and range: `=MAX($B$2:$B$100)` / `=MIN($B$2:$B$100)` / their difference. The on-screen "Max", "Min" and "Range" leave out silent intervals, so they do not match `=MIN()` after the replacement with `-999`. To make them match, leave the silent rows out of the range
   - ⚠**`=AVERAGE($B$2:$B$100)` is not the on-screen "Average (Leq)".** It is the arithmetic mean of dB values. dB is logarithmic, so adding the values and dividing by the row count gives something that corresponds to no physical quantity. Moreover, since the steps above replace `-Infinity` with `-999`, any silent rows put the replacement value itself into the average, and the answer is completely detached from any physical quantity. Results of running the same CSVs through both formulas in our own check (all at 1-second intervals, after the replacement with `-999`).

     | Record | Arithmetic mean | Leq | Difference |
     |---|---|---|---|
     | 60 rows at -60 dBFS with only 1 row at -3 dBFS (no silence) | -59.0500 | -20.7810 | Arithmetic mean 38.2690 dB lower |
     | 1 of 4 rows silent, the other 3 rows at -30 dBFS | -272.2500 | -31.2494 | Arithmetic mean 241.0006 dB lower |
     | 9 of 10 rows silent, the remaining 1 row at -20 dBFS | -901.1000 | -30.0000 | Arithmetic mean 871.1000 dB lower |

     Both the direction and the size of the error depend on the contents of the record, so it cannot be corrected afterward. ⚠Skipping the replacement does not fix it. `=AVERAGE()` ignores text cells without any warning, so silent rows left as `-Infinity` drop out of the calculation. For the 2nd record in the table above it gives -30.0000 (1.2494 dB higher than the Leq), and for the 3rd, -20.0000 (10.0000 dB higher than the Leq). The value looks like a normal number, so you cannot notice
   - When the interval lengths are equal: if the trailer line `# intervalSec=` has no `+` (you did not change the log interval during recording), the following single formula matches the screen. It works even if you stopped and resumed recording (with constant weights, the weighted and the equal-weight averages give the same value)
     ```excel
     =10*LOG10(SUMPRODUCT(POWER(10,$B$2:$B$100/10))/COUNT($B$2:$B$100))
     ```
     In our own check, it matched the on-screen "Average (Leq)" for all 6 records with equal log intervals. ⚠The CSV `dbfs` is exported rounded to 2 decimal places, so values rebuilt from it keep the rounding difference. The screen shows 1 decimal place, so they match within that. `=10*LOG10(AVERAGE(POWER(10,$B$2:$B$100/10)))` gives the same value, but older versions of Excel need it to be confirmed as an array formula (Ctrl+Shift+Enter). SUMPRODUCT does not need that
   - Specifying the range: ⚠Do not specify a whole column, as in `B:B`. Empty cells are treated as 0, so `POWER(10,0)` = 1 (equivalent to 0 dBFS) gets added once for each empty row. Fit the range exactly to the rows that have data
   - When log intervals are mixed: if `# intervalSec=` is joined with `+`, as in `1@0+3@12`, the formula above cannot be used. Weight by the interval length
     - Column K: enter the interval length (seconds). `timestamp` is the end of the interval, so enter `=(A3-A2)*86400` in K3 and copy it down to the bottom
     - ⭐**Do not use this difference for the boundary rows.** For the rows whose `seq` (column C) is listed in the trailer lines `# sessionStartAt=` and `# clockBreakAt=`, overwrite column K by hand. Read the value from the `# intervalSec=` runs (for `1@0+3@12`, `1` for seq 0–11 and `3` for seq 12 and later). The number of boundaries is the number of sessions plus the number of suspensions, so it stays small enough to fix by hand
       - First row: there is no previous row, so no difference can be taken (`# started=` is the end time of the first row's interval, so a difference with it would be 0). `# sessionStartAt=` always contains the first row's `seq`, so it is filled in the same way
       - Boundaries where recording was stopped and resumed: the `timestamp` difference includes the whole pause. In a measurement (17 rows, a 60.032-second difference at the boundary), the result came out 6.49 dB lower. A record with the order reversed came out 2.00 dB higher, and a record with a 600-second pause came out 15.42 dB lower
       - Rows where the time anchor was reset: the jump (`# clockDriftMs=`) is included
       - Missing rows (empty column B): set column K to `0` (see above)
       - Leaving K2 empty drops the weight of the first row. In our own check, the results scattered from 0.79 dB higher to 969.00 dB lower, and in a record where only the first row was not silent, the answer was the replacement value `-999` itself
     - Leq: `=10*LOG10(SUMPRODUCT($K$2:$K$100,POWER(10,$B$2:$B$100/10))/SUM($K$2:$K$100))`
     - In our own check, this formula matched the on-screen "Average (Leq)" in all 6 cases (1 session / 2 sessions / 3 sessions with mixed intervals / a log interval change within 1 session / an anchor reset / 2 sessions including silence). ⚠Unrounded values match to 10 decimal places, but the CSV `dbfs` is rounded to 2 decimal places, so rebuilding from an actual CSV leaves that difference
     - Leaving out the weighting (applying the equal-weight formula) gave the following errors. ⚠The direction depends on the contents of the record, so it cannot be corrected afterward

       | Record | Weighted (same as the screen) | Equal weight | Error |
       |---|---|---|---|
       | 1 s × 3 rows (-40), then 3 s × 1 row (-10) | -13.0060 | -16.0076 | 3.0016 dB lower |
       | 1 s × 3 rows (-40), then 10 s × 3 rows (-10) | -10.4135 | -13.0060 | 2.5925 dB lower |
       | 3 s × 4 rows (-25), then 1 s × 12 rows (-45) | -27.9671 | -30.8922 | 2.9251 dB lower |
       | 1 s × 1 row (-20), then 9 s × 1 row of silence | -30.0000 | -23.0103 | 6.9897 dB higher |
       | 1 s × 1 row (-6), then 10 s × 1 row (-60) | -16.4138 | -9.0103 | 7.4035 dB higher |
       | 1 s × 1 row (-6), then 10 s × 5 rows (-60) | -23.0748 | -13.7814 | 9.2934 dB higher |
5. Time-series graph: create a scatter chart with column A (time) on the X axis and column B (dBFS values) on the Y axis
6. Analysis by time of day: apply the Leq formula above to each time period to see patterns of activity. ⚠An average per time period, too, has no meaning as an arithmetic mean of dB

## Recommended analysis methods
- Moving average: smooths out short-term fluctuations to show the trend. ⚠**Do not average dB values as they are.** Convert them to power with `POWER(10,B/10)`, average, and convert back to dB with `10*LOG10()`
- Threshold analysis: find the periods above a set level (for example, -30 dBFS). The ordering of values is the same in dB and in power, so threshold comparisons can be done in dB as is
- Peak finding: pick out the timing of sudden level changes. The sample peak within each interval (the largest sample value; not the same as the ITU-R BS.1770 true peak) is in the `peak_dbfs` column (empty for rows taken in fallback mode)
- Frequency distribution: show how often each dBFS value occurs as a histogram. ⚠**This is not L10/L50/L90.** Those are indicators defined as distributions of A-weighted sound pressure level, and giving the same names to dBFS percentiles invites the misreading that they can be compared with regulatory limits

## Check before processing

- ⚠**Before processing an exported CSV, copy it as is to another place.** A file with the `#` lines removed, or a file resaved in a spreadsheet, does not pass the verifier in "Verifying a CSV you received" above. Use this original file when you need verification
- Before aggregating, list the rows whose `dbfs` is empty (missing), whose `clip` is not 0, and whose `valid_ratio` or `band_valid_ratio` is below 1.000, and decide which intervals you can read ("Deciding which intervals to read (`check.py`)" below). In an interval where clipping continued for 3 samples or more, the value differs from the real sound ("Showing whether there are recording gaps, both ways" in the [features document](features.md))
- In records whose header line `# engine=` is `fallback` (fallback mode) and in records whose trailer has `# engines=worklet+fallback`, `clip` and `valid_ratio` are empty in the fallback-mode rows, so this check does not work
- When comparing records, first check that the header lines `# device=`, `# sampleRate=`, `# processing=` and `# settingsRaw=` are the same ("What dBFS can and cannot compare" in the [measurement document](measurement.md))

## Converting times to Japan time

`timestamp` is in UTC (the trailing `Z`) and is the time at the end of the interval. Japan time is this time plus 9 hours. The start of the interval is the end minus the interval length ("Session boundaries" above).

- Excel and Google Sheets: when column A holds a string such as `2026-09-29T03:06:21.680Z` as is, enter the following formula in a working column and set the cell's number format to `yyyy-mm-dd hh:mm:ss.000`

  ```excel
  =DATEVALUE(LEFT(A2,10))+TIMEVALUE(MID(A2,12,8))+MID(A2,21,3)/86400000+9/24
  ```

  The first row of the sample becomes `2026-09-29 12:06:21.680`. This value was checked by doing the same calculation as the formula in Python; it has not been checked in actual Excel or Google Sheets. If the spreadsheet converted column A to dates on import, first check whether the value is still in UTC
- Python: convert with `parse_time()` and `jst()` in `mgl.py` below (see the output of `to_jst.py`)

## Reducing it to a table on the command line

Removing the lines starting with `#` (the header and trailer lines) leaves a table of only the column header line and the data rows. Use this when you pass the data to other tools.

```sh
grep -v '^#' mic-gain-logs.csv > table.csv
```

This is the output of actually running it on the sample CSV saved as `sample.csv`.

```text
$ grep -v '^#' sample.csv
timestamp,dbfs,seq,peak_dbfs,clip,valid_ratio,band_ultra_dbfs,band_audible_dbfs,band_valid_ratio,hash
2026-09-29T03:06:21.680Z,-19.70,0,-14.83,0,1.000,-30.44,-20.03,1.000,030554522ee00119
2026-09-29T03:06:22.680Z,-19.72,1,-14.83,0,1.000,-30.45,-20.05,1.000,b274e8d3ca7e6a0e
2026-09-29T03:06:23.680Z,-Infinity,2,-Infinity,0,1.000,-Infinity,-Infinity,1.000,9381a0b301d41f3c
2026-09-29T03:06:24.680Z,-37.54,3,-14.83,0,1.000,-53.05,-42.59,1.000,bfe90bfc6ddf9b43
```

In Windows PowerShell 5.1, it is as follows. By default, `>` saves in UTF-16, so specify the encoding with `Set-Content`.

```powershell
Get-Content mic-gain-logs.csv -Encoding UTF8 | Where-Object { $_ -notmatch '^#' } | Set-Content table.csv -Encoding UTF8
```

On the sample CSV, the contents were the same 5 lines as above. However, `-Encoding UTF8` in Windows PowerShell 5.1 adds a BOM (3 bytes) at the start of the file, and the line endings become CRLF. Excel reads it as is, but in tools that do not skip the BOM, the name of the first column is not read as `timestamp` (when you read it with Python's `csv`, use `encoding="utf-8-sig"`). To save without a BOM, do the following (the line endings stay CRLF; on the sample CSV, we confirmed that with the CRs removed it is byte-for-byte identical to the `grep` output).

```powershell
$rows = Get-Content mic-gain-logs.csv -Encoding UTF8 | Where-Object { $_ -notmatch '^#' }
[IO.File]::WriteAllLines("$PWD\table.csv", [string[]]$rows)
```

⚠`table.csv` does not pass the hash chain check (it has no header lines, which are the starting point). Keep the original CSV as well.

## Python recipes (standard library only)

The following recipes run on Python's standard library only (`csv`, `datetime`, `math`, `sys`) (Python 3.7 or later; we ran them on 3.10.6). They use no external libraries such as pandas. Put the shared module `mgl.py` in the same folder, and each recipe imports it. In this English version, only the comments and the printed messages of the code are in English; the processing is the same as in the Japanese version.

⚠The outputs are copied exactly as produced by actually running the code. They were not written by hand. We saved the sample CSV above as `sample.csv` and ran the recipes on it. The sample has only 4 rows, so for periods when only the ultrasonic band rose, for comparison with a baseline, and for how to compare two devices, we show the output on CSVs exported in the real-device test (the [real-device test document](real-device-test.md); the CSVs are not in the repository).

### Shared module (`mgl.py`)

```python
# mgl.py - module that reads Mic Gain Logger CSVs (standard library only; Python 3.7 or later)
# Put the recipes in the same folder as this file and import it
import csv
import datetime
import math

JST = datetime.timezone(datetime.timedelta(hours=9))
NAME = {"db": "dbfs", "ultra": "band_ultra_dbfs", "audible": "band_audible_dbfs"}


def parse_time(s):
    # The trailing Z means UTC. fromisoformat up to Python 3.10 cannot read Z, so replace it with +00:00
    return datetime.datetime.fromisoformat(s.replace("Z", "+00:00"))


def jst(t, fmt="%Y-%m-%d %H:%M:%S"):
    return t.astimezone(JST).strftime(fmt)


def num(cell):
    # An empty cell is None (a missing interval, or one that could not be measured). -Infinity is digital silence; float() turns it into -inf
    return float(cell) if cell else None


def read_log(path):
    """Read one CSV and return a dict of the meta lines and a list of rows. Each row gets the start, end and length (seconds) of its interval"""
    lines = open(path, encoding="utf-8").read().splitlines()
    meta = dict(l[2:].split("=", 1) for l in lines if l.startswith("# ") and "=" in l)
    rows = list(csv.DictReader(l for l in lines if l and not l.startswith("#")))
    runs = [p.split("@") for p in meta["intervalSec"].split("+")]   # e.g. 1@0+3@12
    edges = {int(s) for k in ("sessionStartAt", "clockBreakAt")
             for s in meta.get(k, "").split(",") if s}
    prev = None
    for r in rows:
        seq = int(r["seq"])
        r["end"] = parse_time(r["timestamp"])          # timestamp is the end of the interval
        if prev is None or seq in edges:
            # boundary rows do not use the timestamp difference; they read the # intervalSec= runs
            r["sec"] = [float(s) for s, at in runs if int(at) <= seq][-1]
        else:
            r["sec"] = (r["end"] - prev["end"]).total_seconds()
        r["start"] = r["end"] - datetime.timedelta(seconds=r["sec"])
        r["db"] = num(r["dbfs"])                        # numeric values are kept under separate names
        r["ultra"] = num(r.get("band_ultra_dbfs", ""))  # v2 has no band columns
        r["audible"] = num(r.get("band_audible_dbfs", ""))
        prev = r
    return meta, rows


def leq(rows, key="db"):
    """Energy average (Leq) weighted by interval length. Empty rows are left out; silence (-inf) counts as zero power"""
    pairs = [(r["sec"], r[key]) for r in rows if r[key] is not None]
    total = sum(sec for sec, _ in pairs)
    if total == 0:
        return None
    power = sum(sec * 10 ** (db / 10) for sec, db in pairs) / total
    return 10 * math.log10(power) if power > 0 else -math.inf


def median(rows, key="db"):
    vals = sorted(r[key] for r in rows if r[key] is not None)
    if not vals:
        return None
    mid = len(vals) // 2
    return vals[mid] if len(vals) % 2 else (vals[mid - 1] + vals[mid]) / 2


def spans(rows, hit):
    """Group the rows where hit(r) is true into runs that continue without a break"""
    out = []
    for r in rows:
        if not hit(r):
            continue
        if out and out[-1][-1]["end"] == r["start"]:
            out[-1].append(r)
        else:
            out.append([r])
    return out
```

- `read_log()` reads one CSV and adds to each row the start (`start`), end (`end`) and length (`sec`, in seconds) of its interval, plus the numeric values `db`, `ultra` and `audible`. The original strings, such as `dbfs`, are kept as they are
- The interval length is taken from the `timestamp` difference from the previous row. However, for the first row and for the rows listed in the trailer lines `# sessionStartAt=` and `# clockBreakAt=`, it is taken from the `# intervalSec=` runs ("Session boundaries" above). This gives the same weights as the on-screen "Average (Leq)"
- `leq()` is the energy average weighted by interval length. Missing (empty) rows are left out, and digital silence (`-Infinity`) counts as zero power. It does not take an arithmetic mean of dB
- It can read v2 (7-column) CSVs too. The band values are `None`

### Deciding which intervals to read (`check.py`)

```python
# check.py - before aggregating, list the rows to watch (missing, clipping, valid ratio below 1.000)
# Usage: python check.py log.csv
import sys
from mgl import read_log, jst

meta, rows = read_log(sys.argv[1])
print("Engine=%s  Audio processing=%s" % (meta.get("engines", meta["engine"]), meta.get("processing")))
n = 0
for r in rows:
    why = []
    if r["db"] is None:
        why.append("missing")
    if r["clip"] not in ("", "0"):
        why.append("clip=" + r["clip"])
    for k in ("valid_ratio", "band_valid_ratio"):
        if r.get(k) and float(r[k]) < 1:
            why.append(k + "=" + r[k])
    if why:
        n += 1
        print("seq %s  %s  %s" % (r["seq"], jst(r["end"]), " ".join(why)))
print("Rows to watch: %d / %d" % (n, len(rows)))
```

```text
$ python check.py sample.csv
Engine=worklet  Audio processing=off
Rows to watch: 0 / 4
```

The sample has no rows that are missing, clipped, or with a ratio below 1.000. If there are rows to watch, one line appears for each of them, with the `seq`, the time and the reason.

### List in Japan time (`to_jst.py`)

```python
# to_jst.py - print each row's interval in Japan time (timestamp is the end of the interval, in UTC)
# Usage: python to_jst.py log.csv
import sys
from mgl import read_log, jst

meta, rows = read_log(sys.argv[1])
for r in rows:
    print("seq %s  %s - %s  %.3f s  dbfs %s" % (
        r["seq"], jst(r["start"], "%Y-%m-%d %H:%M:%S.%f")[:-3],
        jst(r["end"], "%H:%M:%S.%f")[:-3], r["sec"], r["dbfs"]))
```

```text
$ python to_jst.py sample.csv
seq 0  2026-09-29 12:06:20.680 - 12:06:21.680  1.000 s  dbfs -19.70
seq 1  2026-09-29 12:06:21.680 - 12:06:22.680  1.000 s  dbfs -19.72
seq 2  2026-09-29 12:06:22.680 - 12:06:23.680  1.000 s  dbfs -Infinity
seq 3  2026-09-29 12:06:23.680 - 12:06:24.680  1.000 s  dbfs -37.54
```

The first row has no row before it, so its interval length is taken from `# intervalSec=` (1 second).

### Leq per hour (`hourly.py`)

```python
# hourly.py - Leq for each hour (one hour of Japan time). Rows are assigned by the start time of their interval
# Usage: python hourly.py log.csv
import sys
from mgl import read_log, leq, jst

meta, rows = read_log(sys.argv[1])
groups = {}
for r in rows:
    groups.setdefault(jst(r["start"], "%Y-%m-%d %H:00"), []).append(r)
for key in sorted(groups):
    g = groups[key]
    v, u = leq(g), leq(g, "ultra")
    print("%s  rows %d  Leq %s  ultrasonic band %s" % (
        key, len(g), "none" if v is None else "%.2f dBFS" % v,
        "none" if u is None else "%.2f dBFS" % u))
```

```text
$ python hourly.py sample.csv
2026-09-29 12:00  rows 4  Leq -22.68 dBFS  ultrasonic band -33.44 dBFS
```

Rows are assigned to one-hour periods of Japan time by the start time of their interval. With a long log interval, an interval that spans the boundary between two hours goes into the hour where it starts. The sample covers about 4 seconds, so there is only one line. Silent (`-Infinity`) rows count as zero power, so the Leq is lower than it would be without the silent rows.

### Periods above a threshold (`over.py`)

```python
# over.py - list the periods above a threshold as "from hh:mm:ss for N seconds"
# Usage: python over.py log.csv -30            (dbfs is -30 dBFS or higher)
#        python over.py log.csv +10 [ultra]    (10 dB or more above the record's median; ultra is the ultrasonic band)
import sys
from mgl import read_log, median, spans, jst, NAME

meta, rows = read_log(sys.argv[1])
key = sys.argv[3] if len(sys.argv) > 3 else "db"
if sys.argv[2].startswith("+"):
    base = median(rows, key)
    if base is None:            # the column has no values (such as the band columns in fallback mode)
        sys.exit("This record has no %s values" % NAME[key])
    limit = base + float(sys.argv[2])
    print("%s median %.2f + %s dB = %.2f dBFS or higher" % (NAME[key], base, sys.argv[2][1:], limit))
else:
    limit = float(sys.argv[2])
    print("%s at %.2f dBFS or higher" % (NAME[key], limit))
found = spans(rows, lambda r: r[key] is not None and r[key] >= limit)
for g in found:
    print("%s - %s  %d s  seq %s-%s  max %.2f dBFS" % (
        jst(g[0]["start"], "%m-%d %H:%M:%S"), jst(g[-1]["end"], "%H:%M:%S"),
        (g[-1]["end"] - g[0]["start"]).total_seconds(), g[0]["seq"], g[-1]["seq"],
        max(r[key] for r in g)))
print("Periods: %d  total %d s" % (len(found), sum((g[-1]["end"] - g[0]["start"]).total_seconds() for g in found)))
```

```text
$ python over.py sample.csv -30
dbfs at -30.00 dBFS or higher
09-29 12:06:20 - 12:06:22  2 s  seq 0-1  max -19.70 dBFS
Periods: 1  total 2 s
```

Rows that continue from the previous interval without a break are grouped into the form "from hh:mm:ss for N seconds". A group is broken by a missing row and by a boundary where recording was stopped and resumed. If you pass the threshold with a `+`, as in `+10`, the threshold is set by the difference from the record's median ("Lining up records from two devices" below). The ordering of values is the same in dB and in power, so threshold comparisons can be done in dB as is.

### Hour × weekday table (`week.py`)

```python
# week.py - table of Leq by hour (Japan time) and weekday (M T W T F S S = Monday to Sunday). It is tab-separated, so paste it into a spreadsheet and color it
# Usage: python week.py day1.csv day2.csv ...
import sys
from mgl import read_log, leq, JST

cells = {}
for path in sys.argv[1:]:
    meta, rows = read_log(path)     # read one file at a time (do not take timestamp differences across files)
    for r in rows:
        t = r["start"].astimezone(JST)
        cells.setdefault((t.hour, t.weekday()), []).append(r)
print("Hour\t" + "\t".join("MTWTFSS"))
for h in sorted({h for h, _ in cells}):
    vals = [leq(cells[(h, d)]) if (h, d) in cells else None for d in range(7)]
    print("%d\t" % h + "\t".join("-" if v is None else "%.1f" % v for v in vals))
```

```text
$ python week.py sample.csv
Hour	M	T	W	T	F	S	S
12	-	-22.7	-	-	-	-	-
```

The output is tab-separated. Paste it into a spreadsheet and color it with a color scale to get an hour × weekday heat map. The weekday columns run from Monday to Sunday (M T W T F S S). If you pass CSVs from several days, each one is read on its own and then put into the same cells. The sample covers about 4 seconds (within the 12:00 hour), so there is only one cell: Tuesday at 12.

### Periods when only the ultrasonic band rose (`ultra_only.py`)

```python
# ultra_only.py - extract the periods when only the ultrasonic band rose (the audible band did not rise with it)
# Usage: python ultra_only.py log.csv
import sys
from mgl import read_log, median, spans, jst

meta, rows = read_log(sys.argv[1])
bu, ba = median(rows, "ultra"), median(rows, "audible")
if bu is None or ba is None:    # empty in fallback mode, with ?bands=off, in v2, and at sample rates that cannot measure the ultrasonic band
    sys.exit("This record has no band values")
print("Median  ultrasonic band %.2f  audible band %.2f dBFS" % (bu, ba))


def rise(r):
    u, a = r["ultra"], r["audible"]
    # the ultrasonic band is 10 dB or more above its median, and its rise is 10 dB or more larger than the audible band's rise
    return u is not None and a is not None and u - bu >= 10 and (u - bu) - (a - ba) >= 10


for g in spans(rows, rise):
    top = max(g, key=lambda r: r["ultra"])
    print("%s - %s  seq %s-%s  ultrasonic band max %+.1f dB  audible band at that point %+.1f dB" % (
        jst(g[0]["start"], "%H:%M:%S"), jst(g[-1]["end"], "%H:%M:%S"), g[0]["seq"], g[-1]["seq"],
        top["ultra"] - bu, top["audible"] - ba))
```

The condition is "the ultrasonic band is 10 dB or more above the record's median, and its rise is 10 dB or more larger than the rise of the audible band". Intervals where the audible band rose with it (speech, knocking and other sounds that spread over a wide range of frequencies) are left out. In the sample CSV, in the rows where the ultrasonic band rose, the audible band rose with it, so nothing appears except the median line.

```text
$ python ultra_only.py sample.csv
Median  ultrasonic band -41.75  audible band -31.32 dBFS
```

The following output is from the CSV of the real-device test's step sequence.

```text
$ python ultra_only.py iphone18pm_sweep_bands_20260929.csv
Median  ultrasonic band -93.50  audible band -74.72 dBFS
14:50:52 - 14:50:58  seq 46-51  ultrasonic band max +29.3 dB  audible band at that point +5.2 dB
14:50:59 - 14:51:05  seq 53-58  ultrasonic band max +33.4 dB  audible band at that point +0.0 dB
14:51:06 - 14:51:12  seq 60-65  ultrasonic band max +41.9 dB  audible band at that point -0.2 dB
14:51:13 - 14:51:19  seq 67-72  ultrasonic band max +33.6 dB  audible band at that point -0.8 dB
```

- The four groups are the 18, 19, 20 and 21 kHz steps (they contain seq 47-50, 54-57, 61-64 and 68-71 in the table under "Step sequence: recording 18–22 kHz tones" in the [real-device test document](real-device-test.md)). Each is one row wider on both sides because the first and last rows of each step also contain part of the tone
- The audible band also rose by +5.2 dB at the 18 kHz step because 1/6 of a sound at exactly 18 kHz falls into the audible band ("Step sequence: recording 18–22 kHz tones" in the [real-device test document](real-device-test.md))
- The 22 kHz step (about +1.9 dB above silence) does not appear under this condition (10 dB or more). Loosening the condition would catch it, but it would also catch more of the ordinary fluctuation
- ⚠What can be extracted is only "periods when there was energy in the ultrasonic band"; it cannot tell what the sound is

### Comparing with a baseline (`compare.py`)

Take baseline records with the same device, in the same place and at the same log interval as the record you want to examine, and compare them side by side. dBFS is relative to each device, so the values themselves cannot be compared with other devices or places, but they can be compared with a baseline taken under the same conditions. Compare the medians and the Leq, as well as the Leq per hour (`hourly.py`), the number and length of the periods above a threshold (`over.py`), and the time when the values started to rise. For the ultrasonic band, add 10 dB or so to the baseline median in this output and pass it to `over.py` as the threshold to get a list of the periods when it rose above the baseline (e.g. `python over.py log.csv -96 ultra`). The `ultra_only.py` above does not use a baseline record; it lists the periods when only the ultrasonic band rose within a single record.

```python
# compare.py - compare with baseline records (taken with the same device, in the same place, at the same log interval)
# Usage: python compare.py target.csv baseline1.csv [baseline2.csv ...]
import sys
from mgl import read_log, leq, median, NAME

SAME = ("device", "sampleRate", "processing", "settingsRaw", "bands")


def load(paths):
    metas, rows = [], []
    for p in paths:
        m, r = read_log(p)      # read one file at a time, then join them (do not take timestamp differences across files)
        metas.append(m)
        rows += r
    return metas, rows


tm, target = load(sys.argv[1:2])
bm, base = load(sys.argv[2:])
diff = sorted({k for m in bm for k in SAME if m.get(k) != tm[0].get(k)})
print("Baseline: files %d, rows %d / target: rows %d" % (len(bm), len(base), len(target)))
print("Header differences=%s" % ("none" if not diff else " ".join(diff) + " (the values cannot be compared)"))
# anything other than off cannot confirm that automatic gain control and the like were off (unknown: = not reported, active: = on)
proc = sorted({m.get("processing", "absent") for m in tm + bm} - {"off"})
if proc:
    print("Note: some records cannot confirm that audio processing was off (processing=%s)" % " ".join(proc))
for key in ("db", "audible", "ultra"):
    b, t = median(base, key), median(target, key)
    if b is not None and t is not None:
        print("%s median  baseline %.2f  target %.2f  diff %+.2f dB" % (NAME[key], b, t, t - b))
b, t = leq(base), leq(target)
if b is not None and t is not None:
    print("dbfs Leq  baseline %.2f  target %.2f  diff %+.2f dB" % (b, t, t - b))
```

The following output is from the real-device test's fan and speaker CSVs. The 3 files with the fan off (the speaker left powered on) were joined as the baseline and compared with the 1 file with the fan running (the speaker powered off). All 4 were taken in the same place.

```text
$ python compare.py iphone18pm_noise_fan-on_spk-off_20260929.csv iphone18pm_noise_fan-off_spk-on_20260929.csv iphone18pm_noise_fan-off_spk-on_tab-closed_20260929.csv iphone18pm_noise_fan-off_spk-on_stream-active_20260929.csv
Baseline: files 3, rows 94 / target: rows 31
Header differences=none
Note: some records cannot confirm that audio processing was off (processing=unknown:autoGainControl+noiseSuppression)
dbfs median  baseline -79.70  target -75.92  diff +3.78 dB
band_audible_dbfs median  baseline -79.95  target -76.47  diff +3.48 dB
band_ultra_dbfs median  baseline -106.05  target -104.02  diff +2.03 dB
dbfs Leq  baseline -79.63  target -75.89  diff +3.73 dB
```

- The full band and the audible band are about 3.5–3.8 dB above the baseline. This can be read as the effect of running the fan (the difference in the speaker's power was taken to contribute little to the full band)
- The ultrasonic band was about +2 dB; running the fan did not raise it much
- ⚠`compare.py` compares the strings of the header lines `# device=`, `# sampleRate=`, `# processing=`, `# settingsRaw=` and `# bands=`, and lists any items that differ. The placement and the log interval setting cannot be read from the CSV header lines, so whoever takes the records should note them
- ⚠"Header differences=none" does not guarantee that the measurement conditions were the same. If a record's `# processing=` is not `off`, a "Note:" line appears. The 4 files above were taken in Safari on an iPhone, so they are `unknown:autoGainControl+noiseSuppression`, and the CSV cannot confirm whether automatic gain control (AGC) was off or the gain stayed constant. If AGC is working, the difference from the baseline can shrink or change
- Joining several baseline files also puts the baseline's own fluctuation into the reference (the output above is 3 files, 94 rows). How to join them is in "Joining multiple CSVs" below

### Overlaying external records by time (`memo.py`)

Line up records kept outside this tool, such as activity notes, the log of a sound source, or records from other equipment, with the rows by time. Write the notes in Japan time, one `Japan time,text` per line. In the [real-device test](real-device-test.md), the PC-side log of the sound source (the start time of each step) was matched with the CSV rows in the same way. There is clock offset between devices and delay before the sound arrives (about 0.84 seconds combined in the real-device test), so read with a margin of 1–2 seconds.

```python
# memo.py - overlay external records (notes) by time. Put the rows and the notes on one timeline
# Usage: python memo.py log.csv memo.txt
# memo.txt has one "Japan time,text" per line (e.g. 2026-09-29 12:06:23,text)
import sys
import datetime
from mgl import read_log, jst, JST

meta, rows = read_log(sys.argv[1])
events = [(r["start"], "%s - %s  seq %s  dbfs %s" % (
    jst(r["start"], "%H:%M:%S.%f")[:-3], jst(r["end"], "%H:%M:%S.%f")[:-3], r["seq"], r["dbfs"]))
    for r in rows]
for line in open(sys.argv[2], encoding="utf-8"):
    t, _, text = line.strip().partition(",")
    if t:
        when = datetime.datetime.strptime(t, "%Y-%m-%d %H:%M:%S").replace(tzinfo=JST)
        events.append((when, "%s  [memo] %s" % (jst(when, "%H:%M:%S"), text)))
for when, text in sorted(events, key=lambda e: e[0]):
    print(text)
```

The following output overlays two lines of notes made up for this explanation (`memo.txt`) on the sample CSV.

```text
$ cat memo.txt
2026-09-29 12:06:21,External record A
2026-09-29 12:06:24,External record B
```

```text
$ python memo.py sample.csv memo.txt
12:06:20.680 - 12:06:21.680  seq 0  dbfs -19.70
12:06:21  [memo] External record A
12:06:21.680 - 12:06:22.680  seq 1  dbfs -19.72
12:06:22.680 - 12:06:23.680  seq 2  dbfs -Infinity
12:06:23.680 - 12:06:24.680  seq 3  dbfs -37.54
12:06:24  [memo] External record B
```

## Joining multiple CSVs

- ⚠**Read each file on its own, then join the rows.** The first row of each file is the start of a session (it always appears in the trailer line `# sessionStartAt=`), so do not take `timestamp` differences across files. If you do, the whole time between the files goes into the interval length and the Leq shifts ("Session boundaries" above). `week.py` and `compare.py` read the files this way
- Before joining, check that the header lines `# device=`, `# sampleRate=`, `# processing=`, `# settingsRaw=` and `# bands=` are the same. If even one of them differs, the values cannot be compared with each other
- When joining in a spreadsheet, stack the tables with the `#` lines removed on top of each other, and fill the interval length of each file's first row (column K in "Analysis steps in Excel/Google Sheets" above) with the value of `# intervalSec=`
- `seq` restarts from 0 in each file, so add a column that shows which file each row came from
- Keep the original CSVs as they were before joining (the joined file does not pass the verifier)

## Lining up records from two devices

When you record at the same time with two devices, compare not the values but the times when the values rose and fell. dBFS is relative to each device, so the same sound gives different values on different devices ("What dBFS can and cannot compare" in the [measurement document](measurement.md)).

If you pass the `over.py` threshold with a `+`, as in `+10`, the threshold is set from each device's median, so for either device you get "the periods that rose for that device". Line up the output for each device and compare only the time columns. The devices' clocks are offset from each other (about 0.84 seconds between the iPhone and the PC in the real-device test, including the delay before the sound arrives), so treat a difference of 1–2 seconds as the same event.

We have no records taken by two devices at the same time, so only the output for one device is shown (the CSV of the real-device test's step sequence).

```text
$ python over.py iphone18pm_sweep_bands_20260929.csv +10
dbfs median -72.77 + 10 dB = -62.77 dBFS or higher
09-29 14:50:24 - 14:50:30  6 s  seq 18-23  max -37.48 dBFS
09-29 14:50:31 - 14:50:36  5 s  seq 25-29  max -58.41 dBFS
09-29 14:50:45 - 14:50:50  5 s  seq 39-43  max -58.40 dBFS
09-29 14:50:59 - 14:51:04  5 s  seq 53-57  max -59.94 dBFS
09-29 14:51:06 - 14:51:12  6 s  seq 60-65  max -51.59 dBFS
09-29 14:51:13 - 14:51:18  5 s  seq 67-71  max -59.79 dBFS
Periods: 6  total 32 s
```

- The 1 kHz, 15 kHz, 17 kHz and 19–21 kHz steps appear. The 18 kHz step (full band -63.24) and the 16 kHz step (-66.46) did not reach the threshold. When comparing by the full-band value, which steps count as "rose" depends on the device and the background noise
