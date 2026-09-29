# 🔬 How measurement works and technical background

[Back to README](../../README.en.md) · [日本語](../measurement.md)

This document covers how measurement works (per-interval aggregation in an AudioWorklet) and the measured values, dBFS basics, the difference between the number on screen and the CSV value, the security background, and the tech stack.

## 🔬 How measurement works and measured values

### Engine

Intervals are aggregated in an AudioWorklet (on the audio thread). It is always called every 128 samples, so recording continues even when the tab goes to the background and `requestAnimationFrame` stops. Interval boundaries are set by audio-clock frame numbers, so errors in interval length do not accumulate. Drawing is done only for display.

In environments where the AudioWorklet cannot be loaded (older browsers, opening the file directly with `file://`, and so on), the tool switches to fallback mode. Fallback mode records in the drawing loop, so recording stops when drawing stops. Which one is running is shown at the top of the screen and in the CSV header `# engine=` (if the mode changes during recording, the trailer gets `# engines=worklet+fallback`).

### Measured values

| What was measured | Result |
|---|---|
| Stopping `requestAnimationFrame` for 20 seconds | No recording gaps (not a single interval missing) |
| Throttling the CPU 20x | Intervals exactly as configured |
| AudioContext suspension | Noticed and kept in the CSV trailer lines, and the anchor is reset |
| dBFS calculation accuracy against a reference tone | ±0.0002 dB |
| Operation at phone widths (320–414 px) | Start → 1-second log interval → record → stop → CSV all work |

The ±0.0002 dB for dBFS shows that "the calculation of dBFS from digital samples is correct." It does not show that the loudness of sound is measured correctly. For details, see "What dBFS can and cannot compare" below.

⚠**All of these values were taken in desktop Chromium (Playwright).** The "phone widths" in the last row means the screen width was set to 320–414 px, not a real device. The scope of verification is gathered in one place, "Browser support" in the [README](../../README.en.md). Values taken on a real iPhone are in the [real-device test document](real-device-test.md).

### Why there is no smoothing setting

There is no "smoothing" setting that evens out fluctuations in the sound. The means of smoothing in the Web Audio API, `AnalyserNode.smoothingTimeConstant`, acts only on frequency-domain values, and this tool measures time-domain RMS, so it would affect neither the display nor the record. Evening out fluctuations could be added as time weighting (Fast = 125 ms / Slow = 1 s) (see "Further ideas" in the [roadmap document](roadmap.md)). ⚠**Even then, it would be display only.** The Leq of an interval is a complete summary of the interval, so applying time weighting does not change the interval's average. What could additionally go into the record is at most LFmax/LSmax within the interval.

## 📚 Technical background

### What is dBFS?
dBFS (decibels relative to Full Scale) is a unit of level used in digital audio systems.

- Reference point: the maximum level in the digital system is 0 dBFS
- Range: usually expressed as negative values from -∞ dBFS to 0 dBFS
- Practical range: the guide values below are rough impressions from measuring the author's own environment with the built-in microphone of a typical laptop. A different microphone can shift them by 10 dB or more, so they cannot be used as an absolute reference
  - -60 dBFS or below: nearly silent (ambient noise level)
  - -40 dBFS: a quiet environment (a library, a house late at night)
  - -20 dBFS: normal conversation, background music
  - -10 dBFS: fairly loud sound (lively discussion, music)
  - 0 dBFS: the digital maximum (just before clipping)

### What dBFS can and cannot compare

dBFS is a relative value in which the maximum amplitude that the digital system can represent is 0 dBFS. What sound pressure in Pa corresponds to 0 dBFS depends on the microphone sensitivity, the preamplifier gain, the OS mixer settings and whether automatic gain control (AGC) is on. This tool cannot get these absolute values from the browser, so it cannot convert dBFS to dB SPL.

Therefore, **measuring the same sound on a different device gives a different dBFS value.** This is of course true between microphones from different makers, and even on the same device, swapping an external microphone changes the value.

What can be said is limited to the following.

- Relative comparison within the same device and the same session: if you do not change the microphone and do not touch the OS input volume during recording, you can read "the sound now is 12 dB louder than 3 minutes ago" from the record
- Comparison across sessions: limited to cases where the measurement conditions match. This tool writes to the CSV meta lines the device name, the sample rate and the actual values returned by `getSettings()` (whether AGC, noise suppression and echo cancellation were applied). If these three match, different sessions on the same device can be compared. If even one differs, they cannot. ⚠In a record where `# processing=` has `unknown:` items (Safari on iPhone and others), the actual state of those settings is unknown, so even if the meta line strings are the same, you cannot say that the conditions matched
- Absolute loudness: cannot be given. You cannot say "it was -35 dBFS, so it was a quiet office." If the microphone sensitivity differs by 10 dB, the same office can read -25 dBFS or -45 dBFS

Note that the accuracy of the dBFS calculation itself is ±0.0002 dB against a reference tone. This number shows that "the calculation of dBFS from digital samples is correct," not that "the loudness of sound is measured correctly." These are two different things.

### How it differs from other level units

| Unit | Reference | What it represents |
|---|---|---|
| dB SPL | 20 μPa (a fixed value derived from the human threshold of hearing) | Physical sound pressure. Noise regulations and occupational standard values use this |
| dBFS | The maximum amplitude of that digital system | The relative signal level within the digital system. The reference differs by device |

### Difference between the big number on screen and the CSV `dbfs`

In high-precision mode (AudioWorklet), the big number on screen and the CSV `dbfs` are the same sound seen through different windows.

| | Big number on screen | CSV `dbfs` (high-precision mode) |
|---|---|---|
| Window | The latest 2048 samples (about 43 ms at 48 kHz) | One whole interval (the log interval, such as 1 second) |
| Calculation | RMS within the window | Energy average over the whole interval |
| When it changes | Every time the screen is redrawn | Once at the end of each interval |

If the loudness is constant, the two give nearly the same value. For sounds that get loud now and then, the energy average is pulled up by the loud moments, so the number on screen looks lower for longer stretches.

For example, suppose that in a 1-second interval a sound at -50 dBFS plays for only 0.1 seconds and the remaining 0.9 seconds are at -80 dBFS. The CSV `dbfs` is 10×log10(0.1×10^(-50/10) + 0.9×10^(-80/10)) = -59.96 dBFS. The number on screen shows around -80 for 0.9 seconds and around -50 only for the 0.1 seconds when the sound plays, so for most of the time you are watching, you read a value about 20 dB lower than the CSV. Both values are correct; only the windows differ.

In fallback mode, there is no such difference. The CSV `dbfs` in fallback mode is the value read from this window (the latest 2048 samples) at the moment of recording.

## 🔒 Security background

This tool belongs to physical security within the security field.
In particular, it falls into the category of acoustic surveillance / technical surveillance, which monitors and records sound.
However, as a measuring instrument it is simple, and it cannot replace a sound level meter that has passed verification.

It is an aid for knowing "whether conversation or activity is happening" by visualizing and recording the sound environment on site in real time.
It is intended for keeping timestamped records of when sound rises and quiets down, in security investigations and site surveys.
This tool's output is a record of whether there was activity; it is neither a sound pressure measurement nor proof usable in formal procedures.

## 🌐 Tech stack
- HTML / CSS / JavaScript: front-end foundation (vanilla JS, no build step)
- Web Audio API / AudioWorklet: audio input and per-interval aggregation on the audio thread
- Canvas API: live graph drawing
- Web Crypto API (`crypto.subtle`): SHA-256 for the hash chain
- Blob API: CSV output and file download
- CSS Grid & Flexbox: responsive layout
- LocalStorage: saving the theme and the display language (where it is unavailable, the tool still works; it just does not save)
- Content Security Policy: `connect-src 'none'` blocks sending data outside
- node:test: dependency-free tests (`npm test`)

### 📖 Reading the implementation details

The reasons behind the implementation (why it was written that way) are in the code comments and the tests, which are written in Japanese. The section names below give the meaning of the section headings in those comments.

| What you want to know | Where to read |
|---|---|
| How intervals are cut (one row = one interval) | `worklet/meter-processor.js`, the interval section of `logic.js`, `test/interval.test.js` |
| How dBFS and statistics (Leq) are computed | The statistics section of `logic.js`, `test/dbfs-fixture.test.js` and `test/stats-csv.test.js` |
| The weight of statistics (Leq) = interval length | The statistics section of `logic.js`, `test/stats-weight.test.js` |
| Weights across stop → restart (`# sessionStartAt=`) | The session boundaries section of `logic.js`, `test/session-weight.test.js` |
| The log interval attached to rows (`# intervalSec=1@0+3@12`) | The log interval runs section of `logic.js`, `test/interval-label.test.js` |
| Peak, clipping, valid sample ratio and the recording gaps display | `statsWarnings` and `statsIntegrity` in `logic.js`, `test/stats-notice.test.js` |
| The clock anchor and resetting it | The clock anchor section of `logic.js`, `test/clock.test.js` |
| Digital silence and device loss | The sections on handling digital silence and on microphone device loss in `logic.js`, `test/silence.test.js` and `test/device.test.js` |
| Measurement-condition metadata | The measurement conditions section of `logic.js`, `test/meta.test.js` |
| CSV v3 and the hash chain | The CSV section of `logic.js`, `test/hashchain.test.js` |
| Band aggregation (FFT, bin assignment, how frames overlap, handling interruptions) | The FFT foundation and band aggregation sections of `worklet/meter-processor.js`, the bands section of `logic.js` (`BAND_DEFS` and `bandPlan`), `test/fft.test.js` and `test/band.test.js` |
| The three band columns in the CSV, the four header items (`# nyquistHz=`, `# settingsRaw=`, `# bands=`, `# fftSize=`), empty cells for missing data, verifying v2 and v3 | `csvDataFields` and `chainHeaderMeta` in `logic.js` and its section on the raw values of getSettings(), `test/csv-v3.test.js` |
| The container that advances the chain during recording | `createHashChain` in `logic.js`, `test/chain-runner.test.js` |
| Graph coordinates, ticks and canvas | The graph and canvas size sections of `logic.js`, `test/graph.test.js` and `test/canvas.test.js` |
| Reset stats (discarding the log, statistics, graph and notes at once) | `resetAllStats` in `script.js`, `test/reset.test.js` |
| The notice items and how the processing state is written (`off` / `active:` / `unknown:`) | `recordNoticeItems`, `chainHeaderMeta` and `processingLabel` in `logic.js`, `test/processing-label.test.js` and `test/notice-details.test.js` |
| Single-hit and sustained clipping | `clipRun` in `worklet/meter-processor.js`, `statsWarningItems` in `logic.js`, `test/clip-notice.test.js` and `test/meter-processor.test.js` |
| Bands on screen (the dashed ultrasonic band line, breaking lines at missing data, Ultrasonic max, band notes, the recordable limit, the `?bands=off` display) | `graphLinePoints`, `formatUltraMax`, `ultraBandState`, `bandNoticeItems`, `statsWarningItems`, `recordableUpperHz` and `upperLimitText` in `logic.js` and its section on bands on screen, `drawSeries` and `renderBandInfo` in `script.js`, `test/band-ui.test.js` |
| The order of width-dependent CSS rules | The end of `style.css`, `test/css-order.test.js` |
| Meter ticks and the display floor (default -110 dBFS with bands, -90 dBFS with `?bands=off`) | `meterScaleLabels` and `floorDbDefaultFor` in `logic.js`, `test/meter-floor.test.js` and `test/review-ui.test.js` |
| The button layout (Start recording and Stop in one place, "More") | `startStopView` and `moreMenuNext` in `logic.js`, `updateButtonStates` and `applyMoreMenu` in `script.js`, `test/mobile-view.test.js` |
| The current value of the ultrasonic band, and the window of the big number (2048 samples) | `ultraNowText` and `METER_WINDOW_SAMPLES` in `logic.js`, `renderUltraNow` in `script.js`, `test/ultra-now.test.js` |
| Japanese/English UI (dictionaries, how the language is chosen, `?lang=`, switching `<html lang>`) | `DICTIONARIES`, `t` and `initialLang` in `messages.js`, `applyStaticText`, `applyLanguage` and `switchLanguage` in `script.js`, `test/i18n.test.js` |
| The real-device test tables, the output of the CSV recipes, the heading order and examples of use, and the rules for splitting the README and docs/ | `test/readme-realdevice.test.js`, `test/readme-recipes.test.js`, `test/readme-structure.test.js` and `test/readme-docs.test.js` |
| Development rules (what goes in which file) | [CLAUDE.md](../../CLAUDE.md) |

How to run the tests and which tables they check are in "🧪 Tests" in the [README](../../README.en.md).

### References

- [MDN Web Audio API](https://developer.mozilla.org/ja/docs/Web/API/Web_Audio_API)
- [MDN AudioWorklet](https://developer.mozilla.org/ja/docs/Web/API/AudioWorklet)
- [W3C Web Audio API Specification](https://www.w3.org/TR/webaudio/)
- [MDN Canvas API](https://developer.mozilla.org/ja/docs/Web/API/Canvas_API)
- [MDN SubtleCrypto](https://developer.mozilla.org/ja/docs/Web/API/SubtleCrypto)
- [dBFS - Wikipedia](https://en.wikipedia.org/wiki/DBFS)
