function gainValue(value) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError('arcade/audio: gain must be finite and between 0 and 1');
  }
  return value;
}

function attemptAll(jobs) {
  const errors = [];
  for (const job of jobs) {
    try { job(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'arcade/audio: cleanup failed');
}

function cancelled() {
  return new DOMException('arcade/audio: playback was stopped', 'AbortError');
}

function allocationFailed(error, cleanup) {
  try { cleanup(); } catch (cleanupError) {
    throw new AggregateError([error, cleanupError], 'arcade/audio: allocation and cleanup failed');
  }
  throw error;
}

/** Manage game-owned sounds through an injected adapter. No event listeners are installed. */
export function createAudio(adapter, { gain = 1, muted = false } = {}) {
  let master = gainValue(gain);
  let mute = Boolean(muted);
  let disposed = false;
  let disposal;
  const voices = new Set();
  const assertLive = () => {
    if (disposed) throw new Error('arcade/audio: disposed');
  };
  const mix = level => mute ? 0 : level * master;

  function finish(entry, stop) {
    if (!voices.delete(entry)) return;
    entry.cancelled = stop;
    attemptAll([
      () => { if (stop) entry.voice.stop(); },
      () => entry.voice.dispose(),
    ]);
  }

  function updateMix() {
    attemptAll([...voices].map(entry => () => entry.voice.setGain(mix(entry.gain))));
  }

  const api = {
    // Invoke directly in the gesture handler: adapter.unlock runs before any await.
    async unlock() {
      assertLive();
      if (await adapter.unlock() !== true) {
        throw new Error('arcade/audio: unlock refused');
      }
      assertLive();
      return true;
    },
    setGain(value) {
      assertLive();
      master = gainValue(value);
      updateMix();
    },
    setMuted(value) {
      assertLive();
      mute = Boolean(value);
      updateMix();
    },
    async play(sound, { loop = false, gain: level = 1, rate = 1 } = {}) {
      assertLive();
      gainValue(level);
      if (!Number.isFinite(rate) || rate <= 0) {
        throw new RangeError('arcade/audio: rate must be positive and finite');
      }
      const entry = { gain: level, voice: null };
      entry.voice = adapter.createVoice(sound, {
        loop: Boolean(loop), gain: mix(level), rate,
        // Adapter invokes this only for a natural end, after start() has been called.
        onEnded: () => finish(entry, false),
      });
      voices.add(entry);
      try {
        await entry.voice.start();
      } catch (error) {
        try { finish(entry, true); } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'arcade/audio: playback and cleanup failed');
        }
        throw error;
      }
      if (disposed || entry.cancelled) throw cancelled();
      return {
        setGain(value) {
          assertLive();
          if (!voices.has(entry)) throw cancelled();
          entry.gain = gainValue(value);
          entry.voice.setGain(mix(entry.gain));
        },
        stop: () => finish(entry, true),
      };
    },
    stopAll() {
      attemptAll([...voices].map(entry => () => finish(entry, true)));
    },
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      const errors = [];
      try { api.stopAll(); } catch (error) { errors.push(error); }
      // Defer adapter disposal, but not voice shutdown. Repeated calls share this promise.
      disposal = Promise.resolve().then(() => adapter.dispose()).catch(error => {
        errors.push(error);
      }).then(() => {
        if (errors.length) throw new AggregateError(errors, 'arcade/audio: disposal failed');
      });
      return disposal;
    },
    get state() {
      return { gain: master, muted: mute, disposed, activeVoices: voices.size };
    },
  };
  return api;
}

/** Buffers are decoded and selected by the game; context is borrowed unless closeContext is true. */
export function createWebAudioAdapter({ context, getBuffer, closeContext = false }) {
  const output = context.createGain();
  try { output.connect(context.destination); } catch (error) {
    allocationFailed(error, () => output.disconnect());
  }
  return {
    async unlock() {
      await context.resume();
      return context.state === 'running';
    },
    createVoice(sound, { loop, gain, rate, onEnded }) {
      const buffer = getBuffer(sound);
      if (!buffer) throw new Error(`arcade/audio: missing buffer ${String(sound)}`);
      const source = context.createBufferSource();
      let volume;
      try {
        volume = context.createGain();
        source.buffer = buffer;
        source.loop = loop;
        source.playbackRate.value = rate;
        volume.gain.value = gain;
        source.connect(volume);
        volume.connect(output);
        source.onended = onEnded;
      } catch (error) {
        allocationFailed(error, () => attemptAll([
          () => source.disconnect(), () => volume?.disconnect(),
        ]));
      }
      let started = false;
      let stopped = false;
      return {
        start() {
          if (context.state !== 'running') throw new Error('arcade/audio: context is not running');
          source.start();
          started = true;
        },
        setGain(value) { volume.gain.value = value; },
        stop() {
          if (started && !stopped) {
            stopped = true;
            source.stop();
          }
        },
        dispose() {
          source.onended = null;
          attemptAll([() => source.disconnect(), () => volume.disconnect()]);
        },
      };
    },
    async dispose() {
      try { output.disconnect(); } finally {
        if (closeContext && context.state !== 'closed') await context.close();
      }
    },
  };
}

/** Each createElement call transfers a fresh media element to this adapter. */
export function createHtmlAudioAdapter({ createElement, unlock }) {
  return {
    // The game supplies its browser-specific gesture strategy; true means verified success.
    unlock,
    createVoice(sound, { loop, gain, rate, onEnded }) {
      const element = createElement(sound);
      try {
        element.loop = loop;
        element.volume = gain;
        element.playbackRate = rate;
        element.addEventListener('ended', onEnded);
      } catch (error) {
        allocationFailed(error, () => attemptAll([
          () => element.removeEventListener('ended', onEnded),
          () => element.pause(),
          () => { element.removeAttribute('src'); element.load(); },
        ]));
      }
      let stopped = false;
      return {
        async start() {
          try { await element.play(); } finally {
            // A permission prompt may settle after stopAll/dispose. Never revive playback.
            if (stopped) element.pause();
          }
        },
        setGain(value) { element.volume = value; },
        stop() { stopped = true; element.pause(); },
        dispose() {
          stopped = true;
          element.removeEventListener('ended', onEnded);
          attemptAll([
            () => element.pause(),
            () => { element.removeAttribute('src'); element.load(); },
          ]);
        },
      };
    },
    dispose() {},
  };
}
