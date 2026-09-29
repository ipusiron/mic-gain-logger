# 💡 Ideas for future additions

[Back to README](../../README.en.md) · [日本語](../roadmap.md)

This document covers what Phase 2 added, ideas for Phase 3, further ideas, and what will not be added.

## What Phase 2 added

> Keep the upper edge of the audible range (18–22 kHz) as a continuous record.  
> Keep that band's value on the same row, for the same interval as the main dBFS, one row per interval, regardless of any threshold.

Phase 2 combines recording without dropping intervals with recording the band at the upper edge of the audible range (18–22 kHz). Many adults find this band hard to hear, but young people can sometimes hear it, so we do not call it "the inaudible band." What Phase 2 added are the three band columns in the CSV (see "Band columns" in the [CSV document](csv.md)), and on screen the dashed ultrasonic band line, "Ultrasonic max" in the statistics, the current value of the ultrasonic band and the display of the recordable limit.

The differences from similar existing tools are as follows. This is based on what we found on 2026-09-29 by examining existing browser-based tools down to their code; it is not proof that nothing else exists.

| Aspect | Existing tools | This tool (Phase 2) |
|---|---|---|
| Handling of frequencies above 18 kHz | Some tools, such as the Ultrasonic Spectrum Analyzer on frequencydetector.com and the Spectrum Analyzer on noisemeter.co, display up to the Nyquist frequency (half the sample rate) | Handles the same band |
| Time-series records and CSV | The Ultrasonic Leak Detector on frequencydetector.com outputs 17–22 kHz band energy with timestamps to a CSV (the closest to Phase 2). However, it records only when a threshold is exceeded, keeps at most 60 rows with the oldest ones removed, has no date in its timestamps, and stops when the tab is hidden | Keeps one row per interval, regardless of any threshold, for long periods |
| Missing intervals | The Overnight Noise Monitor on noisemeter.co does not create a row for a second without a value, so such seconds cannot be told apart from loss | Keeps missing intervals as rows too, so continuity can be checked with sample counts (`valid_ratio`) |
| Sending data outside | We found no tool that blocks sending with `connect-src 'none'` | `connect-src 'none'` blocks fetch, XHR, WebSocket and sendBeacon |
| State of audio processing | The sound level meter on jasperbernaers.com shows the items the browser does not report as unknown on screen. We found none that keeps it in a CSV | Keeps the state reported by the browser, including the unreported items (unknown), in the CSV header |

⚠**We do not describe this tool as a way to find ultrasonic beacons.** What it keeps is only a record of "whether there was sound energy in this band." Identifying the signal is not among the Phase 3 ideas either. Research has also pointed out that it is hard to tell signals apart by band energy alone (SoniControl, arXiv:1807.07617).

⚠**This record cannot be used as proof.** It cannot meet the need to keep harassment by ultrasound or similar means as "evidence." The reasons are in "Cannot be compared with regulatory limits or standard values" in the [use cases document](use-cases.md) and "What the hash chain can tell you" in the [CSV document](csv.md).

A spectrogram (a display for seeing what is being picked up) is not a record, so it was left for Phase 3.

The values of this band depend strongly on the device. At a sample rate of 44.1 kHz, frequencies above 22.05 kHz cannot be represented in principle, and bandwidth limits of the microphone and codec can cut off even lower. On a real iPhone 18 Pro Max, 18–21 kHz tones were recorded in the ultrasonic band +29 to +41 dB higher than when quiet, while 22 kHz rose only +1.9 dB (see the [real-device test document](real-device-test.md)). ⚠When the browser turns audio processing on, sound above 19 kHz can disappear (confirmed with Chromium's fake microphone). This tool requests that processing be turned off and keeps the actual state in the CSV meta lines. It also keeps the sample rate, so these can be checked afterwards.

## Ideas for Phase 3

- **Spectrogram (finder)**  
  A display for seeing what is being picked up. It is not a record, so it would be built as a display in which gaps are acceptable.
- **Marking against a baseline recording**  
  Use a baseline recording made with the same device in the same place as the reference, and mark the intervals where the band value rose above it. This would do on screen what is now done by hand with the recipes in the [CSV document](csv.md) (get the baseline median with `compare.py` and pass it to `over.py` as the threshold). It would not judge what the signal is.
- **A screen for direction finding (peak hold, intersection of bearings)**  
  For walking around with the device and rotating it, show the ultrasonic band value in large type and hold the peak. Entering the bearings taken at two points would also show a helper for their intersection (see "Finding the direction of a sound and narrowing down its source" in the [use cases document](use-cases.md)). The record (CSV) stays as it is; only the screen would be adapted for direction finding.
- **Creating the AudioContext at the sample rate of the microphone track**  
  When the microphone audio track and the AudioContext have different sample rates, the conversion reduces the recorded levels of high-frequency sounds near the limit (see "Band columns" in the [CSV document](csv.md)). Recreating the AudioContext at the track's sample rate would remove this conversion. ⚠On iOS, a recreated AudioContext may not be resumable outside a user action. On the real iPhone 18 Pro Max, the track and the AudioContext were both at 48000 Hz, so for now we think a note on screen is enough.

## Further ideas

- **Level threshold trigger**  
  Add a marker or a warning to the graph when a set dB value is exceeded.
- **Support for long-running sessions**  
  A design that moves the log to IndexedDB or similar so that it is not lost even if the tab crashes (currently everything is in memory).
- **Time weighting (Fast / Slow)**  
  A display that evens out fluctuations in the sound (see "Why there is no smoothing setting" in the [measurement document](measurement.md)). Add Fast = 125 ms / Slow = 1 s time weighting, and show values passed through this weighting. ⚠**What could additionally go into the record is at most LFmax/LSmax within the interval.** The Leq of an interval is a complete summary of the interval, so applying time weighting does not change the interval's average.

## What will not be added

The following will not be added in later phases either. Leaving them among the future ideas would leave promises that will not be kept.

- **A-weighting and C-weighting**: adding weighting does not turn dBFS into dB SPL. Comparing with regulatory limits or standard values requires a sound level meter that has passed verification (see "Cannot be compared with regulatory limits or standard values" in the [use cases document](use-cases.md))
- **Calibration (dB SPL estimation)**: what pressure in Pa corresponds to 0 dBFS cannot be determined without the microphone sensitivity and the preamplifier gain. Neither can be obtained from the browser
- **L10/L50/L90 percentiles, dosimeters (OSHA and NIOSH TWA)**: all of these are indicators that assume the distribution or accumulation of A-weighted sound pressure levels. Giving the same names to quantiles of dBFS would lead readers to take them as comparable with regulatory limits
- **Stealth mode**: an idea to dim the UI so that the screen is less noticeable. It is unrelated to what this tool stands for, recording without gaps, so it will not be added
