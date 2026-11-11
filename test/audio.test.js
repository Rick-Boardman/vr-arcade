import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudio, createWebAudioAdapter, createHtmlAudioAdapter } from '../src/audio.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fakeAdapter(overrides = {}) {
  const voices = [];
  const adapter = {
    voices, disposed: 0,
    unlock: () => true,
    createVoice(sound, options) {
      const voice = {
        sound, ...options, stopped: 0, disposed: 0,
        start() {},
        setGain(value) { this.gain = value; },
        stop() { this.stopped++; },
        dispose() { this.disposed++; },
      };
      voices.push(voice);
      return voice;
    },
    dispose() { this.disposed++; },
    ...overrides,
  };
  return adapter;
}

test('master and voice gains multiply; mute preserves levels for existing and new voices', async () => {
  const adapter = fakeAdapter();
  const audio = createAudio(adapter, { gain: 0.5 });
  const loop = await audio.play('engine', { loop: true, gain: 0.4, rate: 1.2 });
  assert.equal(adapter.voices[0].gain, 0.2);
  assert.equal(adapter.voices[0].loop, true);
  assert.equal(adapter.voices[0].rate, 1.2);
  audio.setMuted(true);
  audio.setGain(0.8);
  loop.setGain(0.5);
  await audio.play('whistle', { gain: 0.25 });
  assert.deepEqual(adapter.voices.map(v => v.gain), [0, 0]);
  audio.setMuted(false);
  assert.deepEqual(adapter.voices.map(v => v.gain), [0.4, 0.2]);
  await audio.dispose();
});

test('unlock invokes adapter synchronously in the gesture and reports refusal or failure unchanged', async () => {
  let called = false;
  const audio = createAudio(fakeAdapter({ unlock() { called = true; return true; } }));
  const result = audio.unlock();
  assert.equal(called, true);
  assert.equal(await result, true);
  await assert.rejects(createAudio(fakeAdapter({ unlock: () => false })).unlock(), /unlock refused/);
  const denied = new DOMException('gesture required', 'NotAllowedError');
  await assert.rejects(createAudio(fakeAdapter({ unlock: () => Promise.reject(denied) })).unlock(), e => e === denied);
  await assert.rejects(createAudio(fakeAdapter({ unlock() { throw denied; } })).unlock(), e => e === denied);
});

test('stopAll stops loops and cues, disposes once, and allows later playback', async () => {
  const adapter = fakeAdapter();
  const audio = createAudio(adapter);
  const handle = await audio.play('loop', { loop: true });
  await audio.play('cue');
  audio.stopAll();
  handle.stop();
  assert.deepEqual(adapter.voices.map(v => [v.stopped, v.disposed]), [[1, 1], [1, 1]]);
  assert.equal(audio.state.activeVoices, 0);
  await audio.play('next');
  const disposal = audio.dispose();
  assert.equal(audio.dispose(), disposal);
  assert.equal(audio.state.activeVoices, 0);
  await disposal;
  assert.equal(adapter.disposed, 1);
  assert.throws(() => audio.setGain(1), /disposed/);
  await assert.rejects(audio.play('late'), /disposed/);
  await assert.rejects(audio.unlock(), /disposed/);
});

test('natural end releases a cue without retaining it or stopping an ended source', async () => {
  const adapter = fakeAdapter();
  const audio = createAudio(adapter);
  const handle = await audio.play('cue');
  adapter.voices[0].onEnded();
  handle.stop();
  assert.equal(audio.state.activeVoices, 0);
  assert.equal(adapter.voices[0].stopped, 0);
  assert.equal(adapter.voices[0].disposed, 1);
});

test('very short cue ending before start settles still counts as successful playback', async () => {
  const adapter = fakeAdapter();
  const create = adapter.createVoice;
  adapter.createVoice = (sound, options) => {
    const voice = create(sound, options);
    voice.start = () => options.onEnded();
    return voice;
  };
  const audio = createAudio(adapter);
  const handle = await audio.play('short');
  handle.stop();
  assert.equal(audio.state.activeVoices, 0);
});

test('invalid gain/rate fails before allocating sound resources', async () => {
  const adapter = fakeAdapter();
  const audio = createAudio(adapter);
  for (const gain of [NaN, Infinity, -1, 1.1, '0.5']) {
    assert.throws(() => createAudio(adapter, { gain }), RangeError);
    assert.throws(() => audio.setGain(gain), RangeError);
    await assert.rejects(audio.play('x', { gain }), RangeError);
  }
  for (const rate of [0, -1, NaN, Infinity]) await assert.rejects(audio.play('x', { rate }), RangeError);
  assert.equal(adapter.voices.length, 0);
});

test('failed start is surfaced and cleans allocated voice', async () => {
  const adapter = fakeAdapter();
  const create = adapter.createVoice;
  const error = new Error('decode/play failed');
  adapter.createVoice = (sound, options) => {
    const voice = create(sound, options);
    voice.start = () => { throw error; };
    return voice;
  };
  const audio = createAudio(adapter);
  await assert.rejects(audio.play('bad'), e => e === error);
  assert.equal(audio.state.activeVoices, 0);
  assert.equal(adapter.voices[0].disposed, 1);
});

test('cleanup continues across failures and disposal reports them to caller', async () => {
  const adapter = fakeAdapter();
  const audio = createAudio(adapter);
  await audio.play('first');
  await audio.play('second');
  adapter.voices[0].stop = () => { throw new Error('stop failed'); };
  await assert.rejects(audio.dispose(), AggregateError);
  assert.deepEqual(adapter.voices.map(v => v.disposed), [1, 1]);
  assert.equal(adapter.voices[1].stopped, 1);
  assert.equal(adapter.disposed, 1);
});

function media(play = () => Promise.resolve()) {
  const element = new EventTarget();
  Object.assign(element, {
    play, pauses: 0, loads: 0, src: 'game.ogg',
    pause() { this.pauses++; },
    removeAttribute(name) { delete this[name]; },
    load() { this.loads++; },
  });
  return element;
}

test('HTML adapter applies mix/rate, surfaces play refusal and unloads resources', async () => {
  const elements = [];
  const denied = new DOMException('not allowed', 'NotAllowedError');
  const audio = createAudio(createHtmlAudioAdapter({
    unlock: () => true,
    createElement(sound) {
      const element = media(sound === 'bad' ? () => Promise.reject(denied) : undefined);
      elements.push(element);
      return element;
    },
  }), { gain: 0.5 });
  const loop = await audio.play('engine', { loop: true, gain: 0.4, rate: 1.1 });
  assert.equal(elements[0].volume, 0.2);
  assert.equal(elements[0].loop, true);
  assert.equal(elements[0].playbackRate, 1.1);
  await assert.rejects(audio.play('bad'), e => e === denied);
  assert.equal(elements[1].src, undefined);
  loop.stop();
  assert.ok(elements[0].pauses > 0);
  assert.equal(elements[0].loads, 1);
  elements[0].dispatchEvent(new Event('ended'));
  assert.equal(elements[0].loads, 1);
});

for (const action of ['stopAll', 'dispose']) {
  test(`${action} cancels pending HTML play and prevents late playback resurrection`, async () => {
    const pending = deferred();
    const element = media(() => pending.promise);
    const audio = createAudio(createHtmlAudioAdapter({ unlock: () => true, createElement: () => element }));
    const playing = audio.play('loop', { loop: true });
    const failure = assert.rejects(playing, { name: 'AbortError' });
    await audio[action]();
    const pauses = element.pauses;
    pending.resolve();
    await failure;
    assert.ok(element.pauses > pauses);
    assert.equal(audio.state.activeVoices, 0);
  });
}

test('disposal during pending unlock cannot report success', async () => {
  const pending = deferred();
  const audio = createAudio(fakeAdapter({ unlock: () => pending.promise }));
  const unlocking = audio.unlock();
  await audio.dispose();
  pending.resolve(true);
  await assert.rejects(unlocking, /disposed/);
});

test('HTML adapter releases an element if browser rejects rate during allocation', async () => {
  const element = media();
  const error = new DOMException('unsupported rate', 'NotSupportedError');
  Object.defineProperty(element, 'playbackRate', { set() { throw error; } });
  const audio = createAudio(createHtmlAudioAdapter({ unlock: () => true, createElement: () => element }));
  await assert.rejects(audio.play('cue', { rate: 1000 }), e => e === error);
  assert.equal(element.src, undefined);
  assert.equal(element.loads, 1);
  assert.equal(audio.state.activeVoices, 0);
});

function context() {
  const nodes = [];
  const ctx = {
    state: 'suspended', destination: {}, closes: 0,
    async resume() { this.state = 'running'; },
    async close() { this.closes++; this.state = 'closed'; },
    createGain() { return node(); },
    createBufferSource() { return node(); },
  };
  function node() {
    const n = {
      gain: { value: 1 }, playbackRate: { value: 1 }, disconnects: 0, stops: 0,
      connect(target) { this.target = target; },
      disconnect() { this.disconnects++; },
      start() { this.started = true; },
      stop() { this.stops++; },
    };
    nodes.push(n);
    return n;
  }
  return { ctx, nodes };
}

test('Web Audio adapter resumes context, routes voices and disconnects without closing borrowed context', async () => {
  const { ctx, nodes } = context();
  const buffer = {};
  const audio = createAudio(createWebAudioAdapter({ context: ctx, getBuffer: () => buffer }));
  await assert.rejects(audio.play('locked'), /not running/);
  assert.equal(await audio.unlock(), true);
  await audio.play('roll', { loop: true, gain: 0.3, rate: 1.4 });
  const source = nodes[3];
  const volume = nodes[4];
  assert.equal(source.buffer, buffer);
  assert.equal(source.loop, true);
  assert.equal(source.playbackRate.value, 1.4);
  assert.equal(volume.gain.value, 0.3);
  assert.equal(source.target, volume);
  assert.equal(volume.target, nodes[0]);
  assert.equal(nodes[0].target, ctx.destination);
  await audio.dispose();
  assert.equal(source.stops, 1);
  assert.equal(source.onended, null);
  assert.ok(nodes.every(n => n.disconnects === 1));
  assert.equal(ctx.closes, 0);
});

test('Web Audio reports a still-suspended context and missing buffers, closes only when owned', async () => {
  const { ctx } = context();
  ctx.resume = async () => {};
  const audio = createAudio(createWebAudioAdapter({ context: ctx, getBuffer: () => null, closeContext: true }));
  await assert.rejects(audio.unlock(), /unlock refused/);
  await assert.rejects(audio.play('absent'), /missing buffer/);
  await audio.dispose();
  assert.equal(ctx.closes, 1);
});

test('Web Audio adapter disconnects partially allocated nodes on setup failure', async () => {
  const { ctx, nodes } = context();
  const adapter = createWebAudioAdapter({ context: ctx, getBuffer: () => ({}) });
  const error = new Error('cannot allocate gain');
  ctx.createGain = () => { throw error; };
  const audio = createAudio(adapter);
  await assert.rejects(audio.play('cue'), e => e === error);
  assert.equal(nodes[1].disconnects, 1);
  assert.equal(audio.state.activeVoices, 0);
  await audio.dispose();
});
