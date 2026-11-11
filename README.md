# @rb/arcade

`@rb/arcade` is the shared game library for the VR games. It uses Halo (`@rb/halo`). The owner accepted this package name, the folder `nexus/vr/arcade`, and a public GitHub repository `Rick-Boardman/vr-arcade` on 2026-11-11.

## Ownership

Arcade owns reusable game rules and lifecycle, starting with `./audio`. Halo owns the scene rig, frame loop, navigation, input, HUD, selection, WebXR, and curve/surface primitives. Games own their worlds, assets, licences, cue selection, and motion-to-pitch mapping. Magna owns lobby, matching, and the party client. Audio has no scene or backend dependency and creates no cloud resources or recurring cost.

The owner-approved foundation is recorded in ticket `2026-11-09-arcade-library-foundation`. Seeded courses, map validation and their coordinate contracts arrive separately with `2026-11-09-arcade-course-map`. The backlog lives in the private `Rick-Boardman/nexus` repository at `backlog/tickets/<state>/<ticket>.md`.

## Use

After this PR is merged, the reviewer creates a release tag before any consumer adopts it. Pin the released tag in `package.json` as `"@rb/arcade": "github:Rick-Boardman/vr-arcade#vX.Y.Z"` (replace `vX.Y.Z` with that tag). Browser ESM is shipped directly; no consumer bundler is required. Map the subpath to installed source:

```html
<script type="importmap">
{"imports":{"@rb/arcade/audio":"./node_modules/@rb/arcade/src/audio.js"}}
</script>
```

A sibling checkout path is not a dependency. Keep a single Three.js instance through Halo's peer dependency; this audio module neither pins nor imports Three.js.

## Audio API

```js
import { createAudio, createWebAudioAdapter } from '@rb/arcade/audio';

// The game creates/loads these and keeps its cue and pitch policy.
const context = new AudioContext();
const buffers = new Map(); // Populate with the game's decoded AudioBuffers before play().
const audio = createAudio(createWebAudioAdapter({
  context,
  getBuffer: name => buffers.get(name),
  closeContext: true, // Only when this context belongs exclusively to this audio owner.
}), { gain: 0.7 });

// In a pointer/key/XR input gesture handler, call directly before awaiting other work:
async function onGesture() {
  await audio.unlock(); // Rejection must reach the game's visible error/status handling.
}

// After successful unlock and asset loading:
async function startEngine() {
  return audio.play('engine', { loop: true, gain: 0.4, rate: 1 });
}
```

`createAudio(adapter, {gain = 1, muted = false})` returns:

| Method | Contract |
| --- | --- |
| `unlock(): Promise<true>` | Calls the adapter immediately in the current gesture. Rejects on refusal (`false`/missing result), synchronous failure, or rejected promise. No automatic retry or cached unlocked flag; call again from a later gesture after suspension. |
| `play(sound, {loop = false, gain = 1, rate = 1}): Promise<voice>` | Creates and starts a voice immediately, then resolves when start succeeds. `sound` is an opaque game-owned identifier. Every call creates a separate cue/loop; the game decides when to replace one. Playback failures reject, including HTML autoplay refusal after an earlier unlock. |
| `voice.setGain(gain)` | Changes the voice's local gain. |
| `voice.stop()` | Stops and releases this voice once. Safe after stopAll/disposal. |
| `setGain(gain)` / `setMuted(boolean)` | Applies master gain/mute to all pending and active voices. Effective gain is `master * local` or zero when muted. New voices inherit the mix; unmuting restores levels. Mute does not stop playback. |
| `stopAll()` | Stops/releases pending and active loops and cues, without disposing the owner. Later playback is allowed. |
| `dispose(): Promise<void>` | Immediately stops all voices, then disposes the adapter. Idempotent; repeated calls share a promise. Attempts all cleanup even if one step fails, and rejects with an AggregateError. Later unlock/play/mix changes fail. |
| `state` | Snapshot of `gain`, `muted`, `disposed`, `activeVoices` (including pending starts). It does not claim browser permission or hardware state. |

Gains must be finite numbers in `[0, 1]`; rate must be positive and finite. Invalid values throw/reject before allocating a voice. Rate is fixed at creation in the built-in adapters; continuous pitch updates, fades/crossfades, scheduling and cue planning belong in game adapters. A stopped pending start rejects with `AbortError` if it later succeeds. Natural ends release resources automatically, including cues that end before `play()` resolves.

The module installs no window, keyboard or XR listeners. The game wires gesture handlers, handles rejected promises, removes its own listeners, and awaits `dispose()` when leaving the world. Do not leave promises unhandled. Source objects and local gain nodes are disconnected on end/stop; buffers remain game-owned. A borrowed Web Audio context stays open by default; `closeContext: true` explicitly transfers responsibility to close it. The game disposes any other context nodes it owns.

### HTML media adapter

`createHtmlAudioAdapter({createElement, unlock})` uses game-supplied functions. `createElement(sound)` must synchronously return a distinct, exclusively owned HTMLAudioElement for each voice, already assigned the game's URL. The adapter sets loop, volume and playback rate, observes `ended`, and calls `play()`. Stop/disposal pauses the element, removes its listener and `src`, and calls `load()` to release the resource. Do not supply shared elements or `srcObject` streams. A late play resolution after disposal is paused again.

`unlock()` must perform the game's actual gesture strategy and return `true` only after it succeeds; rejected promises pass through unchanged. For a primed element pool, keep priming and acquisition in the game and pass its acquisition function as `createElement`. HTML permission may be per element/browser: successfully playing one probe is **not** proof that all future elements can play. Each voice's play promise still reports refusal. The adapter does not invent a silent asset or claim a universal browser unlock trick.

### Custom adapters

For existing game engines (including garbage-can-race's crossfading LoopBed), implement:

```js
const adapter = {
  unlock() { /* Perform gesture work synchronously; return boolean or Promise<boolean>. */ },
  createVoice(sound, { loop, gain, rate, onEnded }) {
    // Allocate synchronously. If allocation throws, clean up partial resources here.
    // Invoke onEnded only for natural completion after start() has been called.
    return {
      start() { /* Start immediately; return void or Promise<void>. */ },
      setGain(value) { /* Apply effective master/local gain synchronously. */ },
      stop() { /* Stop sources and cancel ALL timers/scheduling synchronously. */ },
      dispose() { /* Remove callbacks, disconnect and release resources synchronously. */ },
    };
  },
  dispose() { /* Release adapter-owned resources; may return a promise. */ },
};
```

These are interface sketches, not implementations. Natural-end disposal must not throw from an event callback; adapters must make that path reliable. Start, mix and explicit cleanup failures surface to the caller. Custom adapters must also prevent delayed start completion from resurrecting stopped playback. No game-specific sound, licence, loading URL, motion mapping or cue planner moves into Arcade. Neither existing consumer is migrated by this change.

## Validation and device coverage

Use Node 24: `npm ci`, then `npm run build`. The build syntax-checks source/tests and runs Node's test runner; `npm pack --dry-run` verifies the installable source artifact. CI runs both. There is no transpilation output.

Automated tests exercise lifecycle and injected browser API doubles, including refused gesture unlock, suspended contexts, media play rejection, pending starts, loop shutdown, end cleanup and owned/borrowed context disposal. No real phone (iOS/Safari or Android/Chrome) or Quest headset has been checked for audio output, gesture permission, XR input, background/resume interruption, hardware mute, or codec support. Those checks remain for release/adoption testing and must not be inferred from mocks or a desktop browser.

## Layout

`src/audio.js` is the browser ESM module, `test/audio.test.js` contains lifecycle/adapter tests, and `.github/workflows/build.yml` checks pull requests and branch pushes.

## Constraints

Do not pin Three.js in this repository. Halo's peer dependency is the shared copy, so a game keeps one Three.js instance. The release order is in `AGENTS.md`: library pull request with the build green, merge, tag, then consumers move their pin.
