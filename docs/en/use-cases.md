# 🎯 Use cases

[Back to README](../../README.en.md) · [日本語](../use-cases.md)

What this tool keeps is a time series of dBFS, a value relative to each device. That record is useful in situations like the following.

## 👥 Target users

### 🔍 Primary target (main users)
- **People who want to keep a record of the sound where they are**  
  In their own room, workshop or home, they keep the times when sound activity rose and when it quieted down. What comes out is a value relative to each device, not a value that represents loudness.
- **Technicians and engineers**  
  Checking that a microphone works, testing audio equipment, checking input levels relatively.
- **Developers who want to read an implementation of the Web Audio API**  
  They can follow, through the code and the tests, how to aggregate intervals in an AudioWorklet without dropping any, an Leq weighted by interval length, and how to build a CSV with a hash chain.

### 🏢 Secondary target (applied users)
- **Facility managers**  
  Knowing the times when sound activity concentrates in offices, shops, factories and similar places.
- **Researchers and academics**  
  Preliminary surveys before studying acoustics, environments or behavior. It does not replace a main measurement with instruments that have passed verification.
- **Security learners**  
  With something that actually runs, they check what a hash chain with no key and no external anchor can and cannot tell. It reveals corruption, loss and reordering, but it does not withstand intentional changes. Re-stitching the chain yourself shows where that line lies.

## 🎯 Intended uses (what this tool's output can and cannot do)

What this tool outputs is a time series of dBFS, a relative value. It is not sound pressure (dB SPL), so it cannot be set side by side with regulatory limits or standard values. What it can do is keep a timestamped record that "sound activity went up / went down within the same device and the same session." Read the uses below on this premise.

- **Site surveys**: a timestamped record of whether there was sound activity at the target location
- **Long-term monitoring**: noticing and logging changes in sound in unattended environments
- **Recording activity times**: keep a timestamped record of "when there was sound activity." Corruption in transfer, partial loss and reordering can be noticed later with the CSV hash chain (it cannot serve as proof against intentional changes)
- **Understanding changes in the environment**: see how sound activity changes with the time of day at the same place with the same device. It cannot be used for comparison with regulatory limits or standard values (the reason is in the next section)
- **Equipment checks**: checking that a microphone works and that an audio system is connected
- **Meeting rooms and offices**: understanding usage, managing vacant rooms more efficiently
- **Shops and commercial facilities**: analyzing trends in customer traffic, identifying busy hours
- **Factories and workplaces**: understanding how work noise changes by time of day (it does not replace working environment measurement under the Industrial Safety and Health Act)
- **Houses and apartments**: recording the times when noise occurred (not a sound pressure measurement)
- **Schools and educational institutions**: knowing when classrooms are quiet or noisy (not a measurement of noise levels)
- **Medical institutions**: checking that quiet environments are maintained, protecting patient privacy
- **Research facilities**: recording the acoustic conditions of experimental environments, data quality control

## 🚫 Cannot be compared with regulatory limits or standard values

What this tool outputs is dBFS, a relative value. Both the regulatory standards of the Noise Regulation Act and the occupational noise standard values (85 dB, 90 dB) are defined as A-weighted sound pressure levels (dB SPL) referenced to 20 μPa. dBFS cannot be converted to dB SPL without knowing the microphone sensitivity and the preamplifier gain. This tool cannot get them from the browser, so it does not convert.

The regulations also limit which measuring instruments may be used.

- A sound level meter is a "specified measuring instrument" under the Measurement Act (Order for Enforcement of the Measurement Act, Article 2, item 15). One without the mark of having passed verification cannot be used for measurement in transactions or certification (Measurement Act, Article 16, paragraph 1)
- For measurement under the regulatory standards of the Noise Regulation Act, the notice provides that "measurement shall be made with a sound level meter that has passed the conditions of Article 71 of the Measurement Act. In this case, the A characteristic shall be used for the frequency weighting network, and the fast time weighting (FAST) shall be used for the dynamic characteristic" (Standards for the Regulation of Noise Generated at Specified Factories, etc., Remark 3)
- For occupational noise, Article 4 of the Working Environment Measurement Standards (Ministry of Labour Notice No. 46 of 1976) provides that "the instrument used for measurement (hereinafter "sound level meter") shall be capable of measuring the equivalent continuous sound level" and that measurement "shall be made with the A characteristic of the frequency weighting network of the sound level meter." Personal exposure measurement requires an instrument that meets the accuracy specified in JIS C1509-1 or IEC 61252 (Guidelines for the Prevention of Noise-Induced Hearing Loss, Attachment 3)

This tool has no A-weighting and has not passed verification. **If you want to compare with regulatory limits or standard values, use a sound level meter that has passed verification, or ask a certified measurement business.**

(Checked on 2026-09-28. Sources: e-Gov Law Search https://laws.e-gov.go.jp/ , Ministry of the Environment https://www.env.go.jp/hourei/07/000052.html , Ministry of Health, Labour and Welfare https://www.mhlw.go.jp/content/001089239.pdf . Law names and quotations are unofficial English translations of the Japanese originals.)

## 🧭 Examples of use (daily life, education, work, hobbies, research)

The uses listed here read "when the sound energy rose" within records made with the same device in the same place. Every item assumes that dBFS is a value relative to each device and cannot be compared with regulatory limits or standard values, that the band values cannot tell what the sound is, and that the records cannot be used as proof. The author does not encourage misuse. Whether you may record depends on the laws and circumstances of your country or region (see "⚖️ Usage notes (not legal advice)" in the [README](../../README.en.md)).

There is also an upper limit on how high a sound can be recorded. Recording is possible up to half of the smaller of the AudioContext and microphone audio track sample rates (24 kHz at 48 kHz, 22.05 kHz at 44.1 kHz). This limit comes from the sample rate; the microphone may not pick up sounds that high. The ultrasonic band in the band columns is 18–22 kHz, so sounds above 22 kHz (up to 24 kHz at 48 kHz) barely enter the band columns and go only into the full-band `dbfs`. On a 48 kHz device, sounds above 24 kHz cannot be recorded at their own frequency. Usually they are removed by the converter's filter, and the part that the filter does not fully remove can fold back to a different frequency below 24 kHz and enter the record (not tested on a real device).

### Comparing with a baseline

- **Baseline comparison (finding times that differ from usual)**: A person who wants to check changes in the sound at home or in a workshop takes a "baseline recording" with the same device, the same placement and the same log interval, and sets it side by side, time slot by time slot, with the recording of the day in question to find the times when the sound was higher than usual. In the real-device test, taking the recording with the fan off as the baseline, the full band of the recording with the fan running was about 3.8 dB higher (the output of "Comparing with a baseline (`compare.py`)" in the [CSV document](csv.md)). ⚠dBFS cannot be compared with other devices or places; it can be compared only with a baseline under the same conditions. ⚠You can find times that are higher than the baseline, but not what the sound is. In the real-device test too, the cause of an ultrasonic band about 10 dB above the baseline was not found. ⚠Safari on iPhone does not report whether automatic gain control (AGC) was off, so the CSV cannot confirm that the gain was constant (if AGC is working, the difference from the baseline can shrink or change)
- **Ultrasonic band baseline comparison**: A person who wants to investigate devices that emit near-ultrasound does the same with the ultrasonic band column and looks for the times when it rose above the ultrasonic band of the baseline. With the `compare.py` recipe in the [CSV document](csv.md), they get the median ultrasonic band of the baseline recording, add a margin such as 10 dB, and pass the result to `over.py` as the threshold (for example, `python over.py log.csv -96 ultra`; adding 10 dB to the real-device test's baseline median of -106.05 gives about -96). ⚠The baseline recording can also contain sounds of unknown origin

### Daily life and home

- **When home appliances were running**: A person who wants to know how their home appliances behave leaves the device near a refrigerator or an air conditioner overnight and, from the times when the compressor noise raised or lowered the value, gets an idea of when and for how long the appliance ran (next to a washing machine, the time the cycle ended shows up). ⚠The record does not say which appliance made the sound, so the person who recorded it judges from the placement and the times
- **Pets home alone**: An owner who records in the room where the pet stays while they are out gets an idea of the times when it was barking or meowing (when the sound rose). ⚠A dog's bark, the TV and the intercom are all recorded as the same "sound activity," so you cannot tell what the sound is
- **Your own snoring and instrument practice time**: A person who wants to keep track of their sleep or practice can, without recording audio, keep the times when they snore a lot by recording in the bedroom, or the total practice time of the day by recording in the practice room. ⚠If family members sleep in the same room, tell them that you are recording before using it
- **High-pitched sounds from devices around you**: A person bothered by high-pitched sounds looks at sounds at the upper edge of the audible range, such as coil whine from chargers and switching power supplies or the sound from the dimmer circuits of LED lighting, side by side with the times when the device was switched on and off. If the ultrasonic band rises only while the device is on, that is a clue that sound is coming from near that device. ⚠Only sounds up to the limit described above can be recorded, and some rodent repellers and dog whistles sound above 24 kHz. Such a sound is not kept in the record at its own frequency, so check the frequency in the product specifications

### Education and learning

- **The difference between dBFS and dB SPL**: A teacher or learner records the same sound on two devices at the same time and confirms that they give different dBFS values. This becomes material for explaining, in class or in self-study, the difference between "a value relative to each device" and "sound pressure (an absolute value)"
- **Sampling frequency and Nyquist frequency**: A learner compares `# sampleRate=`, `# nyquistHz=` and the `sampleRate` in `# settingsRaw=` in the CSV with the "Recordable limit on this device" line under the legend. On their own device, they can confirm that the limit changes between 44.1 kHz and 48 kHz, and that high sounds are recorded lower when the microphone audio track has the lower rate
- **FFT windows and bins**: A person studying signal processing confirms in the record that a tone at exactly 18 kHz splits between the ultrasonic band and the audible band (a 7.3 dB difference in the real-device test, 7.0 dB by calculation), and reads it alongside the code of `bandPlan` in `logic.js` (bin assignment) and `worklet/meter-processor.js` (window and overlap)
- **Microphone limit of each device**: A person who wants to know the limit of their own device plays 18–22 kHz tones in order and sees where the ultrasonic band value becomes impossible to tell apart from silence (see "How to run the real-device test" in the [real-device test document](real-device-test.md)). ⚠Whether the sound was lost on the source side or the receiving side cannot be known without changing the equipment
- **Noticing differences in hearing**: Family members or friends who are curious about how sounds are heard play tones at 18 kHz or above together, and even if some can hear them and others cannot, the ultrasonic band value rises the same way, which shows that the upper limit of hearing differs by person and age. ⚠This is not a hearing test. ⚠Always turn the volume down, and do not do this where children or animals are nearby

### Work and creative projects

- **Preparing for recording sessions**: A person who makes podcasts or videos leaves the device in the recording room for a day or two and compares the Leq by time slot, which shows the times when outside cars, air conditioning, construction and the like tend to raise the sound and the times that are quiet, and helps decide when to record. ⚠It does not evaluate sound quality
- **Estimating how long equipment ran**: A facility maintenance person records near air-conditioning units, ventilation fans or pumps in a machine room or warehouse and gets an idea of when they were running from the operating noise. ⚠Neither the name of the equipment nor whether it is faulty is kept in the record

### Hobbies, electronics and nature watching

- **Checking oscillator circuits and buzzers**: A person who does electronics plays a homemade buzzer or oscillator circuit and sees whether the energy appears in the audible band or the ultrasonic band, and whether it is also sounding outside the audible range (18–22 kHz). It can be combined with the oscillator experiments in the author's op-amp starter kit study log ([hub page](https://akademeia.info/?page_id=53202), in Japanese). ⚠It does not give the frequency itself (only which of the two bands the energy appeared in)
- **When birds start singing**: A person who likes wild birds records by a window from before dawn and lines up, day by day, the times when birdsong starts raising the value. ⚠It cannot identify species (the tool does not record audio and has only two bands; identification is the job of dedicated apps that use recordings and machine learning). Birdsong is mostly in the audible range, so look at the audible band and full-band values. Many bats call above 24 kHz, so it is better not to assume that their calls can be recorded
- **Insect sounds at night**: A person who does nature watching records on a summer night in a place close to the outdoors and looks at the times when insects are loud through the Leq by time slot. ⚠It does not tell the species. Whether calls that reach the upper edge of the audible range appear in the ultrasonic band depends on the insect species and the device's microphone

### Research and security audits

- **Auditing and testing air gaps**: An auditor or researcher with permission records, near equipment disconnected from the network, the times when energy appeared in near-ultrasound (18–22 kHz), compares the record with a baseline recording to find the times when the ultrasonic band was higher than usual (see "Baseline comparison" above), and uses that as a clue to covert channels that use sound (studied as a way to cross air gaps). While the tool runs in high-precision mode (AudioWorklet), one row is kept per interval, intervals with missing samples show up in `valid_ratio` (below 1.000) and places where the AudioContext stopped show up in `# clockBreakAt=`, so without dropping intervals you can separate "time when nothing was recorded" from "time when there was no sound." ⚠It can neither identify what the signal is nor decode its content. It cannot tell such sounds apart from those of legitimate equipment (coil whine, monitors, chargers and so on) either. ⚠Sounds above 22 kHz (up to 24 kHz) barely enter the band columns and are buried in the full-band `dbfs`. Sounds above 24 kHz cannot be recorded at their own frequency, and paths other than sound (electromagnetic waves, light, heat, magnetic fields, power lines) are not visible. ⚠Fallback mode (`# engine=fallback`) does not keep band values. Screen lock and background on a real device have not been tested (see "Browser support" in the [README](../../README.en.md)). ⚠Many environments prohibit bringing in devices with microphones, so check the rules of the place before bringing one in
- **Finding the direction of a sound and narrowing down its source**: A person looking for a device that emits 18–22 kHz sound walks around with the device and looks for the place where the ultrasonic band value is highest. On the spot, they slowly rotate the device to find the direction (bearing) in which the value peaks, and narrow down the source at the intersection of the bearings taken at two points. ⚠One microphone cannot tell direction. Direction comes from moving and rotating the device (at 20 kHz, ultrasound has a short wavelength of about 1.7 cm and is strongly blocked by the body and hands, so direction shows up more clearly than for audible sound). ⚠Take the intersection from bearings measured with the same device at two points (dBFS from two devices cannot be compared). ⚠Locating by time difference of arrival (TDOA) cannot be used in a browser, because the clocks of the devices cannot be synchronized closely enough (sound travels about 34 cm in 1 millisecond). ⚠Indoors, wall reflections shift the direction of the maximum, so read bearings with a margin of several tens of degrees. Read the value from the ultrasonic band number below the big number with a 1-second log interval (it changes with every 1-second interval, so hold each direction for 2–3 seconds), and practice with a sound source whose location you know (18–22 kHz tones)
- **Checking the limits of the hash chain**: A security learner rewrites values in an exported CSV and, following the steps in "Verifying a CSV you received" in the [CSV document](csv.md), re-stitches the chain to confirm that the check then passes. A chain with no key and no external anchor reveals only corruption, loss and reordering

### Combining with other tools and articles

- **Combining with 『エアギャップ・ブリッジ』 (Air Gap Bridge)**: A reader learning techniques for crossing air gaps reads the sections on acoustic channels (audible sound and ultrasound) in the author's 『エアギャップ・ブリッジ　隔離環境のデータ入力技法』 (*Air Gap Bridge: Data Input Techniques for Isolated Environments*) (Japanese-language book) and 『エアギャップ・ブリッジ　隔離環境のデータ出力技法』 (*Air Gap Bridge: Data Output Techniques for Isolated Environments*) (Japanese-language book), by IPUSIRON from Mirai Hacking Lab (ミライ・ハッキング・ラボ), to be distributed at Tech Book Fest 21 (技術書典21, November 2026), records with this tool the times when sound energy appeared in the ultrasonic band, and confirms both the sending side and the recording side at hand. A demo for experiencing the sending side is planned as a candidate for "200 Security Tools with Generative AI" (an ultrasonic data transmission demo). ⚠This tool does not read the transmitted content (it records only the times of band energy)
- **Tone source page (Tone Sweep)**: A person who wants to check the microphone limit of their own device pairs this tool with a page that plays known frequencies in order, gets an idea of the frequency from which sounds become hard to keep in the record, and can also use the pair to practice direction finding and to notice differences in hearing. The page used as the sound source in the real-device test will later be published as a standalone tool (once it is published, a link will be added to "How to run the real-device test" in the [real-device test document](real-device-test.md))
- **Spreadsheets and Python**: A person with a week of recordings uses "Python recipes (standard library only)" in the [CSV document](csv.md) to make the Leq by time slot, the times that exceeded a threshold and a time × weekday table, and colors them with a spreadsheet color scale to see the weekdays and times when sound tends to rise

## 📋 Example scenarios

### Scenario 1: Recording activity times in an infidelity investigation

- **Situation**: A private investigator is investigating the behavior of a client's spouse. At a café the subject often visits, they want to keep the times when conversations took place as changes in the level
- **Author's intent**: This example shows what the tool can do. The author does not encourage misuse. Whether you may record depends on the laws and circumstances of your country or region (see "⚖️ Usage notes (not legal advice)" in the [README](../../README.en.md)). The tool does not record the content of conversations, but the times when conversations took place remain in the record
- **Steps**
  1. Start the tool on a smartphone at a seat in the café
  2. Set the log interval to 1 second (for a detailed activity record)
  3. Press "Start recording" and begin monitoring before the subject arrives
  4. When the subject arrives and a conversation starts, the level rises (how the value moves differs by device; for example, from around -40 dBFS to around -20 dBFS, but these numbers are an illustration, not measured values)
  5. After the conversation ends, the level returns to where it was
  6. After 3 hours of monitoring, press "Stop", then get the timestamped data with "Export CSV" (⚠**the export button cannot be pressed during recording.** Export after stopping)
  7. Keep "there was / was not acoustic activity at the times in question" as a timestamped record. This tool's output is not a measurement with a sound level meter that has passed verification, so it cannot be used as-is as proof in formal procedures. If needed, ask a professional how to handle it
- **Benefits**: without recording audio, which respects privacy, it keeps a timestamped record of whether there was activity
- **Scope of verification**: That this procedure (start → 1-second log interval → record → stop → CSV) works was confirmed in desktop Chromium (Playwright) with screen widths of 320–414 px, 4x/20x CPU throttling and a state equivalent to a screen lock. On a real iPhone 18 Pro Max (iOS Safari), start → record → stop → CSV export also worked, and the exported CSVs passed the verifier in "Verifying a CSV you received" in the [CSV document](csv.md) (2026-09-29, one device only; confirmed with public versions c7b6bad and 090648f). ⚠**Behavior during screen lock and in the background on a real device has not been tested.** The screen lock was created by browser emulation and differs from the behavior of a real device (especially how iOS Safari handles the `AudioContext` and stops things in the background). The scope of verification is gathered in one place, "Browser support" in the [README](../../README.en.md), so please see that

### Scenario 2: Finding the times when sound activity concentrates in an office

- **Situation**: A company's HR department received a complaint from employees that "the neighboring department is noisy" and wants to know when sound activity concentrates
- **Steps**
  1. Set up a laptop in the area the complaint is about and start the tool. Use the same device and the same microphone for the whole recording period (changing them midway makes the values impossible to compare)
  2. Set the log interval to 10 seconds (to keep the file size down during long-term monitoring)
  3. Each day, run "Start recording" in the morning → "Stop" at the end of the workday → "Export CSV" → "Reset stats" as one day's cycle. ⚠**If you do not press "Reset stats", the log stays piled on top of the previous day's.** This tool accumulates the log each time recording starts, so if you forget, the next day's CSV will contain the previous day's rows. ⚠The log exists only in the browser's memory. If the tab is closed or reloaded, the browser crashes, or the OS discards the tab, everything recorded so far is lost. Do not close the tab until that day's data has been exported
  4. From each day's CSV data, read the following
     - Average (Leq), max, min and range. ⚠**These are dBFS values and have meaning only on this device.** They cannot be used for comparisons such as "a typical office is so many dBFS"
     - The distribution of rows by time of day. The difference between quiet and noisy times
  5. Visualize the patterns by time of day (`hourly.py` and `week.py` in "Python recipes (standard library only)" in the [CSV document](csv.md))
  6. Identify when sound activity concentrates, and use it to review seating or meeting times. Note that this tool's values are dBFS and cannot be compared with occupational safety and health standard values (such as an A-weighted sound pressure level of 85 dB). If a comparison with standard values is needed, ask a working environment measurement professional
- **Outcome**: identifies, from records rather than impressions, the times when sound activity concentrates
