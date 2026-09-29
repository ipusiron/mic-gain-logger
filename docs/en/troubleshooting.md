# 🔧 Troubleshooting

[Back to README](../../README.en.md) · [日本語](../troubleshooting.md)

Common problems and how to solve them.

## ❌ The microphone dialog does not appear

- Symptom: pressing "Start recording" does not show the microphone permission prompt
- Solution
  1. Click the microphone icon 🎤 near the browser's URL
  2. Choose to always allow this site
  3. Reload the page (F5 key) and try again

## ❌ The level stays at "--.- dBFS" and does not change

- Symptom: microphone access is allowed, but no level is measured
- Solution
  1. Look at the status display on screen first. If it says "The microphone is muted at the source", silence is being fed in before the sound reaches the browser (for example, by an incoming call)
  2. Check that the microphone is connected correctly
  3. Check that the microphone is not muted in the system sound settings
  4. Check that no other application is using the microphone exclusively
  5. Restart the browser and try again

## ❌ Recording stops by itself

- Symptom: recording stops on its own when left unattended
- Solution
  1. Look at the engine display at the top of the screen. If it says "fallback mode," recording stops when drawing stops. Reopening the page over HTTPS lets it use the AudioWorklet
  2. If it says "The microphone was disconnected", the device was lost during recording. The screen shows up to which row the log is valid (the log up to that point can be exported)
  3. Disable power-saving mode and sleep mode
  4. Disable the browser's automatic tab discarding. ⚠**If the tab is discarded, the whole log is lost.** For long recordings, export to CSV often

## ❌ "Engine: fallback mode (samples may be missing)" appears

- Symptom: the tool does not enter high-precision mode
- Cause: the AudioWorklet module (`worklet/meter-processor.js`) could not be loaded
- Solution
  1. Check that you did not open the file directly with `file://`. To try it locally, serve it over HTTP, for example with `python -m http.server 8000`
  2. Check that the browser supports AudioWorklet

## ❌ The `hash` column in the CSV is empty

- Symptom: no hash chain values appear
- Cause: `crypto.subtle` is available only in a secure context. It is not available when you open the page with a non-HTTPS URL with a host name or IP address, such as `http://192.168.1.10:8000/`
- Solution: reopen the page with https, `localhost` or `file://`
- ⚠**`file://` is not the cause of this symptom.** `file://` is a secure context, so hashes appear (measured in Chromium). What happens with `file://` is the "fallback mode" described above

## ❌ "Could not get the microphone within 20 seconds" appears

- Symptom: after pressing Start recording, you are kept waiting and then it fails
- Cause: the microphone permission prompt was left unanswered (it times out after 20 seconds so that the screen does not freeze)
- Solution: respond to the permission prompt, then press Start recording again

## ❌ The graph shows no line, or the line breaks

- Symptom: the graph looks empty even though recording is running, or the line breaks partway
- Things to check
  1. Time when nothing was recorded: the line is not joined. If you stop and restart, the time in between stays empty (joining it would make unmeasured time look measured)
  2. Silent intervals: they stick to the bottom. The line is there, but it overlaps the lowest tick and is hard to see
  3. Sounds quieter than the display floor: sounds quieter than the display floor (default -110 dBFS; -90 dBFS with `?bands=off`) also line up at the bottom. This is a setting for the display; the values recorded in the CSV do not change. Read small changes of the ultrasonic band (a few dB) from the "Ultrasonic band (last N s interval)" number below the big number
  4. If "Engine" at the top of the screen shows fallback mode and the tab is in the background, both drawing and recording stop
- The graph can be drawn with browser zoom (110%, 133% and so on) and at phone widths. The canvas size is set after converting the non-integer width returned by `getBoundingClientRect()` to an integer, so `RangeError: Invalid array length` does not occur (`test/canvas.test.js` checks six non-integer widths that occur with zoom and at phone widths). If the graph turns completely black, the cause is something other than zoom

## ❌ Settings cannot be changed on a phone

- Symptom: you want to change the log interval or the display floor, but the settings are not visible
- Solution: press "Show settings" at the top of the screen. On narrow screens, the settings start collapsed
- If you cannot find "Export CSV" and "Reset stats", press "More" to the right of Start recording (Stop). At 480 px wide or narrower, these two are grouped under "More"
- It has been confirmed that "start → 1-second log interval → record → stop → CSV" works at widths of 320–414 px. However, this reproduced the screen width in desktop Chromium; it is not a real device (see "Browser support" in the [README](../../README.en.md))
