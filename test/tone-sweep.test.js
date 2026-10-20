'use strict';

// Tone Sweep publication: exercise the real controller with deterministic audio
// and permission promises. Acoustic reception is checked on physical devices.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'tone-sweep.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'tone_sweep.html'), 'utf8');

function harness({ rate = 48000, resume, permission, engine = 'oscillator' } = {}) {
  const elements = new Map(), contexts = [], oscillators = [], sources = [], gains = [], timers = new Map();
  const docEvents = {}, winEvents = {};
  let timerId = 0;
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: ({ vol: '-24', toneSec: '5', gapSec: '2', manualHz: '19000', toneEngine: engine, log: '' })[id] || '',
      textContent: '', disabled: false, events: {}, width: 1200, height: 260,
      getContext: () => ({ clearRect() {} }),
      addEventListener(name, fn) { this.events[name] = fn; },
      replaceChildren() {}, append() {}, select() {}
    });
    return elements.get(id);
  }
  const parameter = () => ({ value: 0, events: [],
    setValueAtTime(v,t) { this.events.push(['set',v,t]); this.value=v; },
    exponentialRampToValueAtTime(v,t) { this.events.push(['ramp',v,t]); },
    cancelScheduledValues(t) { this.events.push(['cancel',t]); }
  });
  class AudioContext {
    constructor() { this.sampleRate=rate; this.currentTime=10; this.state=resume ? 'suspended' : 'running'; this.destination={}; contexts.push(this); }
    resume() { return resume || Promise.resolve(); }
    close() { this.closed=true; return Promise.resolve(); }
    createOscillator() {
      const o = { frequency: { value: 0 }, stops: [],
        connect(n) { return n; }, disconnect() { this.disconnected=true; },
        start() { this.started=true; }, stop(t) { this.stops.push(t); }
      };
      oscillators.push(o); return o;
    }
    createBuffer(channels, length, sampleRate) {
      const data = new Float32Array(length);
      return { numberOfChannels: channels, length, sampleRate, getChannelData: () => data };
    }
    createBufferSource() {
      const s = { buffer: null, loop: false, stops: [],
        connect(n) { return n; }, disconnect() { this.disconnected=true; },
        start() { this.started=true; }, stop(t) { this.stops.push(t); }
      };
      sources.push(s); return s;
    }
    createGain() {
      const g = { gain: parameter(), connect(n) { return n; }, disconnect() { this.disconnected=true; } };
      gains.push(g); return g;
    }
    createMediaStreamSource() { return { connect() {} }; }
    createAnalyser() { throw new Error('Unexpected analyser construction'); }
  }
  const document = { hidden: false, getElementById: element,
    addEventListener(name,fn) { docEvents[name]=fn; }, createElement: element };
  const window = { AudioContext, addEventListener(name,fn) { winEvents[name]=fn; } };
  vm.runInNewContext(source, { window, document, navigator: { mediaDevices: { getUserMedia: () => permission } },
    setTimeout(fn,ms) { timers.set(++timerId,{fn,ms}); return timerId; },
    clearTimeout(id) { timers.delete(id); }, requestAnimationFrame() { return 1; }, cancelAnimationFrame() {},
    Date, Float32Array, Number, Math });
  return { element, contexts, oscillators, sources, gains, timers, document,
    click: id => element(id).events.click(),
    hide() { document.hidden=true; docEvents.visibilitychange(); },
    pagehide() { winEvents.pagehide(); },
    nextTimer() { const [id,{fn,ms}] = timers.entries().next().value; timers.delete(id); fn(); return ms; }
  };
}

test('manual tone reserves an audio-clock stop and fades at both ends', async () => {
  const h=harness();
  await h.click('manualBtn');
  assert.equal(h.oscillators[0].frequency.value, 19000);
  assert.deepEqual(h.oscillators[0].stops,[15]);
  assert.deepEqual(h.gains[1].gain.events,[['set',0.0001,10],['ramp',1,10.05],['set',1,14.95],['ramp',0.0001,15]]);
  assert.equal(h.nextTimer(),5000);
  assert.equal(h.element('stopBtn').disabled,true);
});

test('frequencies at or above Nyquist and invalid input never start an oscillator', async () => {
  for (const [rate,hz] of [[48000,24000],[44100,22050],[32000,18000],[48000,19],[48000,Infinity],[48000,NaN]]) {
    const h=harness({rate}); h.element('manualHz').value=String(hz);
    await h.click('manualBtn');
    assert.equal(h.oscillators.length,0,`${rate}/${hz}`);
    assert.match(h.element('stepInfo').textContent,/再生できない/);
    assert.equal(h.element('toneSec').disabled,false);
    assert.equal(h.element('gapSec').disabled,false);
  }
});

test('gain is clamped and volume changes leave the fade-out intact', async () => {
  const h=harness(); h.element('vol').value='0';
  await h.click('manualBtn');
  assert.equal(h.gains[0].gain.value,10**(-12/20));
  const fade=JSON.stringify(h.gains[1].gain.events);
  h.element('vol').value='-60'; h.element('vol').events.input();
  assert.equal(h.gains[0].gain.value,0.001);
  assert.equal(JSON.stringify(h.gains[1].gain.events),fade);
});

test('starting a sequence stops a manual tone and visits the original nine frequencies', async () => {
  const h=harness(); await h.click('manualBtn');
  const manual=h.oscillators[0];
  await h.click('seqBtn');
  assert.equal(manual.stops.at(-1),10.08);
  assert.equal(h.timers.size,1);
  for (let i=0;i<19;i++) h.nextTimer();
  assert.deepEqual(h.oscillators.slice(1).map(o=>o.frequency.value),[1000,15000,16000,17000,18000,19000,20000,21000,22000]);
  assert.equal(h.timers.size,0);
  assert.equal(h.element('stopBtn').disabled,true);
});

test('stop cancels a pending AudioContext resume', async () => {
  let resolve; const resume=new Promise(r=>{resolve=r;});
  const h=harness({resume}); const pending=h.click('manualBtn');
  h.click('stopBtn'); resolve(); await pending;
  assert.equal(h.oscillators.length,0);
  assert.equal(h.timers.size,0);
});

test('late microphone permission is released after cancellation or hiding', async () => {
  for (const action of ['cancel','hide']) {
    let resolve, stopped=0;
    const permission=new Promise(r=>{resolve=r;});
    const h=harness({permission}); const pending=h.click('micBtn');
    if (action==='cancel') h.click('micStopBtn'); else h.hide();
    resolve({getTracks:()=>[{stop(){stopped++;}}]}); await pending;
    assert.equal(stopped,1);
    assert.equal(h.element('micBtn').disabled,false);
    assert.equal(h.contexts.length,0);
  }
});

test('hidden page and pagehide close audio contexts and clear pending tones', async () => {
  for (const event of ['hide','pagehide']) {
    const h=harness(); await h.click('manualBtn'); h[event]();
    assert.ok(h.contexts[0].closed);
    assert.equal(h.timers.size,0);
    assert.equal(h.element('stopBtn').disabled,true);
  }
});

test('public page uses local external scripts, strict CSP and no recording or data transmission', () => {
  assert.match(html,/connect-src 'none'/);
  assert.match(html,/script-src 'self'/);
  assert.match(html,/style-src 'self'/);
  assert.doesNotMatch(html,/unsafe-inline|unsafe-eval|\sstyle=|\son\w+=/i);
  for (const match of html.matchAll(/<script\b([^>]*)>/g)) assert.match(match[1],/src="tone-sweep(?:-theme)?\.js"/);
  assert.doesNotMatch(source,/MediaRecorder|fetch\(|XMLHttpRequest|WebSocket|sendBeacon|innerHTML|outerHTML/);
});

// ---- 試験音の作り方（OscillatorNode が既定、AudioBuffer を選べる） ----

test('the tone engine selector defaults to OscillatorNode and offers AudioBuffer', () => {
  const select = html.match(/<select id="toneEngine" autocomplete="off">([\s\S]*?)<\/select>/);
  assert.ok(select, 'toneEngine select exists with autocomplete="off" (Firefox would otherwise restore the choice on reload)');
  const options = [...select[1].matchAll(/<option value="(\w+)"( selected)?>([^<]+)<\/option>/g)];
  assert.deepEqual(options.map(o => o[1]), ['oscillator', 'buffer']);
  assert.deepEqual(options.filter(o => o[2]).map(o => o[1]), ['oscillator']);
  assert.match(options[0][3], /OscillatorNode（既定）/);
  assert.match(options[1][3], /AudioBuffer/);
  assert.doesNotMatch(source, /localStorage[^;]*toneEngine|toneEngine[^;]*localStorage/, 'the choice is not saved');
});

test('the default engine plays an OscillatorNode and logs it', async () => {
  const h = harness();
  await h.click('manualBtn');
  assert.equal(h.oscillators.length, 1);
  assert.equal(h.sources.length, 0);
  assert.match(h.element('log').value, /手動 19000 Hz（5 秒、OscillatorNode）/);
});

test('AudioBuffer engine loops one second of a sine with whole cycles and keeps the fades', async () => {
  for (const rate of [48000, 44100]) {
    const h = harness({ rate, engine: 'buffer' });
    await h.click('manualBtn');
    assert.equal(h.oscillators.length, 0);
    assert.equal(h.sources.length, 1);
    const s = h.sources[0], data = s.buffer.getChannelData(0);
    assert.equal(s.loop, true);
    assert.equal(s.buffer.length, rate);
    assert.equal(s.buffer.sampleRate, rate);
    assert.equal(data[0], 0);
    const peak = Math.max(...data.map(Math.abs));
    assert.ok(peak > 0.99 && peak <= 1, `peak ${peak}`);
    // ループのつなぎ目（最後の標本→最初の標本）が、1標本分の変化と同じ形でつながる
    const step = 2 * Math.PI * 19000 / rate;
    assert.ok(Math.abs(data[rate - 1] - Math.sin(-step)) < 1e-4, `seam ${rate}`);
    assert.deepEqual(s.stops, [15]);
    assert.deepEqual(h.gains[1].gain.events, [['set',0.0001,10],['ramp',1,10.05],['set',1,14.95],['ramp',0.0001,15]]);
    assert.match(h.element('log').value, /手動 19000 Hz（5 秒、AudioBuffer）/);
  }
});

test('AudioBuffer engine rounds to whole hertz and still refuses frequencies at or above Nyquist', async () => {
  const h = harness({ engine: 'buffer' }); h.element('manualHz').value = '19000.4';
  await h.click('manualBtn');
  assert.equal(h.element('freqNow').textContent, (19000).toLocaleString());
  for (const [rate, hz] of [[48000, 24000], [44100, 22050], [48000, 19], [48000, NaN]]) {
    const r = harness({ rate, engine: 'buffer' }); r.element('manualHz').value = String(hz);
    await r.click('manualBtn');
    assert.equal(r.sources.length, 0, `${rate}/${hz}`);
  }
});

test('the engine cannot change while playing and the sequence logs which engine it used', async () => {
  const h = harness({ engine: 'buffer' });
  await h.click('seqBtn');
  assert.equal(h.element('toneEngine').disabled, true);
  assert.match(h.element('log').value, /シーケンス開始[^\n]*試験音は AudioBuffer/);
  for (let i = 0; i < 19; i++) h.nextTimer();
  assert.equal(h.sources.length, 9);
  assert.equal(h.oscillators.length, 0);
  assert.match(h.element('log').value, /▶ 22000 Hz 開始（5 秒、音量 -24 dBFS、AudioBuffer）/);
  assert.equal(h.element('toneEngine').disabled, false);
});
