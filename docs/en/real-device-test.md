# 📱 Real-device test (iPhone 18 Pro Max)

[Back to README](../../README.en.md) · [日本語](../real-device-test.md)

On 2026-09-29, the public version with band recording (`090648f`) was tested on a real iPhone 18 Pro Max. The values in this document come from the CSVs exported at that time. The CSVs themselves are records made in the author's room, so they are not in the repository. The list of which environments were tested and how far is in "Browser support" in the [README](../../README.en.md).

## Device and conditions

| Item | Details |
|---|---|
| Recording device | Safari on an iPhone 18 Pro Max (1 device) |
| Version recorded | The public version (GitHub Pages, main `090648f`). Opened both with bands and with `?bands=off` |
| Log interval | 1 second |
| Sound source | A speaker connected to the PC over USB (FOSTEX PC200USB-HR). The PC output was 48000 Hz / 24 bit, and no sample rate conversion happened inside the PC |
| Placement | For the step sequence, the bottom edge of the iPhone was placed within 10 cm in front of the speaker and not moved until the end. The fan and speaker on/off recordings were made in the same place (as reported by the author) |
| Room | A room with sounds from a fan, the PC's fans and a washing machine in another room. The values called "quiet" in this document include these sounds |
| Verifier | Every exported CSV (8 v3 files exported with `090648f` and 1 v2 file exported with `c7b6bad`) passed the verifier in "Verifying a CSV you received" in the [CSV document](csv.md) (v3: 60 rows with bands, 114 rows with `?bands=off`, 100 rows of the step sequence, and others; v2: 86 rows) |

## The real-device hurdle: valid sample ratio while computing the FFT

The band values are obtained by computing an FFT on the audio thread that aggregates the intervals. If the computation cannot keep up on the iPhone, render quanta (blocks of 128 samples) are dropped, and the `valid_ratio` of that interval falls below 1.000. The same version was opened with bands and with `?bands=off` (no FFT), recorded with the screen on, and compared.

| Item | With bands | `?bands=off` |
|---|---|---|
| Rows recorded | 60 rows (about 1 minute) | 114 rows (about 2 minutes) |
| Rows with `valid_ratio` below 1.000 | 0/60 | 0/114 |
| Rows with `band_valid_ratio` below 1.000 | 0/60 | (empty) |
| `valid_ratio` of the first row | 1.000 | 1.000 |
| Median `dbfs` of quiet rows | -75.67 | -75.44 |
| Median ultrasonic band of quiet rows | -101.74 | (empty) |
| Median audible band of quiet rows | -76.27 | (empty) |
| Rows with nonzero `clip` | 0 | 0 |
| `peak_dbfs` of tapped rows | -41.28, -49.60, -41.80 | -38.10, -38.90, -31.48 |

- ⭐**Computing the FFT did not drop render quanta on this device.** For both the 60 rows with bands and the 114 rows with `?bands=off`, `valid_ratio` was 1.000 on every row. The band computation also counted every frame it was expected to count (`band_valid_ratio` was also 1.000 on every row)
- ⚠Only 1 minute and 2 minutes with the screen on were tested. Long recordings, screen lock and background were not tested
- In the quiet room (away from the speaker), the ultrasonic band was about -102 dBFS, about 26 dB lower than the full band (about -76 dBFS)

## Clipping when tapping

During the recording, the area around the microphone was tapped lightly three times (the last row of the table above). `peak_dbfs` was -31 to -50 dBFS, more than 30 dB below the 0 dBFS limit, and no row clipped. The taps also showed up slightly in the ultrasonic band (-93.93 dBFS at seq 17 with bands, about 8 dB above the quiet rows).

In another recording made with version `c7b6bad`, there was clipping in 8 intervals, 385 samples in total. At that time, the area around the microphone was touched as if tapping it, so it was probably a stronger contact than a light tap. However, the CSV from that time was not kept, so the cause has not been confirmed.

## Measurement conditions reported by Safari

The header of the recording with bands had the following two lines (the same with `?bands=off`).

```
# processing=unknown:autoGainControl+noiseSuppression
# settingsRaw=echoCancellation:false;autoGainControl:unreported;noiseSuppression:unreported;sampleRate:48000;channelCount:unreported
```

- Safari's `getSettings()` reported only `echoCancellation` of the three audio processing items (`false` = off). `autoGainControl` and `noiseSuppression` are not reported, so `# processing=` becomes `unknown:autoGainControl+noiseSuppression`. This is the same result as what we expected from reading the WebKit source
- Therefore, this CSV cannot tell whether AGC and noise suppression were off. `channelCount` was not reported either
- The sample rate of the audio track was 48000 Hz, the same as the AudioContext (`# sampleRate=48000`). There is no sample rate conversion, so unlike the fake-microphone example (audio track at 44.1 kHz) in "Band columns" in the [CSV document](csv.md), the ultrasonic band values are not lowered by conversion

## Step sequence: recording 18–22 kHz tones

Tones at 1 kHz and 15–22 kHz were played in order from the PC (5 seconds each, with 2 seconds of silence in between, 9 steps in total, about 65 seconds) and recorded on the iPhone. CSV rows were matched to frequencies by the start time of each step in the PC-side log (the offset between the iPhone and PC clocks, including the time for the sound to arrive, was about 0.84 seconds). Each step's value is the average power of the 4 rows that fully contained the tone. The unit is dBFS, and the unit of the difference from silence is dB.

| Frequency | Rows (`seq`) | Full band | Ultrasonic band | Difference from silence (ultrasonic band) | Audible band |
|---|---|---|---|---|---|
| Silence (before) | 0-16 | -73.72 | -92.99 | 0 | -74.21 |
| 1 kHz | 19-22 | -37.50 | -93.61 | -0.62 | -37.50 |
| 15 kHz | 26-29 | -58.55 | -93.85 | -0.86 | -58.57 |
| 16 kHz | 33-36 | -66.46 | -93.87 | -0.88 | -66.54 |
| 17 kHz | 40-43 | -58.69 | -93.88 | -0.89 | -58.71 |
| 18 kHz | 47-50 | -63.24 | -64.37 | +28.61 | -69.75 |
| 19 kHz | 54-57 | -60.08 | -60.23 | +32.75 | -75.14 |
| 20 kHz | 61-64 | -51.73 | -51.75 | +41.24 | -75.24 |
| 21 kHz | 68-71 | -59.83 | -59.97 | +33.01 | -75.27 |
| 22 kHz | 75-78 | -74.66 | -91.74 | +1.25 (+1.9 against the silence right after) | -75.24 |
| Silence (after) | 80-99 | — | -93.66 (σ≈0.1 dB) | — | — |

- ⭐**18–21 kHz were clearly recorded in the ultrasonic band value.** They were +29 to +41 dB higher than when quiet. During 19–21 kHz, the audible band value was almost the same as in silence, so the energy went into the bands as they are divided
- ⭐22 kHz raised the ultrasonic band value slightly. It was about +1.9 dB higher than the silence right after (-93.66, with a row-to-row spread of σ≈0.1 dB), and all four rows were consistent at -91.7 to -91.8. In the full-band value (-74.66), it cannot be told apart from silence
- Converted to the strength of the 22 kHz tone alone, it is about -96 to -98 dBFS (depending on which silence, before or after, is used as the reference; this includes the roughly 2 dB that is read low at the band edge), about 36–38 dB below 21 kHz (-60.0)
- Of the 36–38 dB, about 2 dB is what this tool reads low. 22 kHz sits on the upper edge of the ultrasonic band, so part of the sound leaks outside the band (see "Band columns" in the [CSV document](csv.md); 21 kHz is inside the band, so this does not apply to it). The remaining roughly 34–36 dB is lost somewhere between the sound source and this tool
- ⚠**Whether the loss at 22 kHz happens on the source side or the receiving side cannot be separated.** No sample rate conversion happens on the PC side (48000 Hz on both), so the remaining roughly 34–36 dB is lost either in the speaker (DAC, amplifier, tweeter) or in the iPhone (microphone, AD conversion filter). This setup cannot decide which
- The 18 kHz tone went into both the ultrasonic band (-64.37) and the audible band (-69.75). Subtracting the silence from the audible band gives -71.7, a difference of about 7.3 dB from the ultrasonic band. This matched the calculation that a tone at exactly 18,000 Hz goes 5/6 into the ultrasonic band and 1/6 into the audible band through window leakage (a difference of 7.0 dB)
- The band columns exist to keep high sounds that are buried in the full-band value, like 22 kHz in this table, separately

## Why 22 kHz was not visible on screen, and the default display floor

During recording, at 22 kHz neither the number nor the graph on screen seemed to move, while at 21 kHz they responded (this is from the author's memory; the CSV values also lead to the same appearance). The CSV kept a +1.9 dB difference, so this was a problem of the display, not of the record.

- The big number and the meter show full-band values. The 22 kHz tone is more than 20 dB below the background noise (about -74 dBFS in the full band), so the full-band value barely moves
- The dashed ultrasonic band line rose from -93.7 to -91.7, but that was below the default display floor of the recorded version (`090648f`) (-90 dBFS), so it stuck to the bottom of the graph and could not be seen
- At 21 kHz, the ultrasonic band rose to -60, so it showed in both the number and the dashed line

When bands are computed, the default display floor is -110 dBFS (-90 dBFS with `?bands=off`), and the value of the ultrasonic band is shown as a number just below the big number (see "Recording and displaying the ultrasonic band (18–22 kHz)" in the [features document](features.md)). On a vertical axis of -110 to 0 dBFS, a 2 dB change is only about 2% of the height, so read changes of a few dB from the number. ⚠This display has not yet been tested on a real device.

## Fan and speaker on/off

After the step sequence, at the same place (10 cm in front of the speaker), the power of the fan and the speaker was switched, and about 30 seconds were recorded for each case. The values are row medians (so that a single row that stands out does not pull them).

| Condition | Full band | Audible band | Ultrasonic band |
|---|---|---|---|
| Fan on, speaker on (the silence right after the step sequence) | -74.68 | -75.24 | -93.67 |
| Fan on, speaker off | -75.92 | -76.47 | -104.02 |
| Fan off, speaker on | -79.67 | -79.84 | -105.05 |

- ⭐**The fan raises the full band by about 3.8 dB and the audible band by about 3.4 dB** (the difference between fan on/speaker off and fan off/speaker on: -75.92 and -79.67 for the full band, -76.47 and -79.84 for the audible band. The speaker's contribution was assumed to be small)
- ⚠**The ultrasonic band of -93.7 right after the step sequence cannot be explained by the fan alone or the speaker alone (both -104 to -105).** Recordings were also made at the same place with the fan off while the PC kept sending silent audio to the speaker, and with the sound source page closed, but their ultrasonic band medians were -107.0 and -106.0, which still does not explain it
- Candidates such as a slight shift in placement, the state of the device, room sounds that happened only during that time, and something that happens only when the fan and the speaker are on at the same time remain, and the cause is unknown
- In this example, the time when the band value was about 10 dB above the baseline could be found, but not what the sound was. Changing the conditions one at a time and comparing does not necessarily pin down the source. "Comparing with a baseline" in the [use cases document](use-cases.md) is to be used with this limit in mind

## What has not been tested on a real device

- Real Android devices (no model or browser has been tested)
- Screen-lock and background behavior on a real device (especially how iOS Safari handles the `AudioContext`)
- Long recordings (tested only up to 1-minute and 2-minute recordings and a step-sequence recording of about 100 seconds)
- Other iPhones (only one device was tested; different models or iOS versions have not been checked)
- Whether the loss at 22 kHz happens on the source side or the receiving side (recording the same sequence with another sound source or another microphone would separate them)
- The screen features added after the real-device test version (`090648f`) (the default display floor of -110 dBFS, the current value of the ultrasonic band, the button layout)
- Switching between Japanese and English (tested only in desktop Chromium)

## How to run the real-device test

Play 1 kHz and 15–22 kHz tones from a PC in order from low to high, record them on a smartphone, and match CSV rows to frequencies. 1 kHz and 15–17 kHz are for confirming that the speaker and the microphone are working; what you want to know is where in 18–22 kHz the sound stops being kept in the record.

1. On the recording device (smartphone), open the public version, set the log interval to 1 second and press "Start recording"
2. On the device that plays sound (PC), open a sound source that can play tones at set frequencies in order. First play 1 kHz, and turn the volume down until it does not hurt your ears
3. Place the recording device in front of the speaker (around 10 cm) and do not move it until the end. Moving it midway makes the values at different frequencies impossible to compare
4. Play from the lowest frequency upward, with silence in between (the recording above used 1 kHz and 15–22 kHz, 5 seconds each, with 2 seconds of silence in between). On the source side, note the time each step starts
5. When you are done, stop recording, export the CSV, and run it through the verifier in "Verifying a CSV you received" in the [CSV document](csv.md)
6. Use the source-side times and the CSV `timestamp` (the end of each interval, in UTC) to match which row was which frequency. Because of the clock offset between the devices and the time for the sound to arrive, compare using the rows that fully contain a tone (excluding the first and last rows of each step). If the ultrasonic band value is higher than in the silent rows, that frequency is kept in the record

- ⚠Many people can hear 15–17 kHz. At 18 kHz and above, a loud sound may be playing without being heard, so always turn the volume down before starting. Do not do this where children or animals are nearby
- Also note the output sample rate on the source side (44100 Hz or 48000 Hz). Some equipment that plays at 44.1 kHz has converter filters with a passband up to about 20 kHz; if anything above that is lost on the source side, it cannot be told apart from the limit on the receiving side

The page used as the sound source in the recording above (Tone Sweep) was made locally for the real-device test. It is planned to be published later as a standalone tool, and a link will be added here once it is published.
