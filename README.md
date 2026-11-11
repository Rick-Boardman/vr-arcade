# @rb/arcade

`@rb/arcade` is the shared game library for the VR games. It uses Halo (`@rb/halo`). The owner accepted this package name, the folder `nexus/vr/arcade`, and a public GitHub repository `Rick-Boardman/vr-arcade` on 2026-11-11.

## Ownership

Arcade owns reusable game rules and lifecycle: seeded courses, lanes, and map validation (`./course`), progress, laps, gaps, standings and finish (`./racing`), audio lifecycle (`./audio`), `./presentation` (in-world name tags, appearance on game meshes, and the lifecycle of remote players' presentation), and `./entry` (prepare, entered, countdown, start and leave over Magna's released handoff). Halo owns the scene rig, frame loop, navigation, input, HUD, selection, WebXR, and the curve/surface primitives a road ribbon is built from. Games own their worlds, themes, buildings, trackside art, assets, licences, cue selection, and motion-to-pitch mapping. Magna owns lobby, matching, and the party client. No module has a backend dependency or creates cloud resources or recurring cost. Character geometry, wardrobe assets and identity policy (name uniqueness, storage, moderation) stay in the game; the lobby and its dresser are Magna's.

The owner-approved foundation is recorded in ticket `2026-11-09-arcade-library-foundation` (private backlog `Rick-Boardman/nexus`, file `backlog/tickets/<state>/2026-11-09-arcade-library-foundation.md`).

## Use

Pin a release tag in `package.json` as `"@rb/arcade": "github:Rick-Boardman/vr-arcade#vX.Y.Z"` and replace `vX.Y.Z` with that tag. Package version 0.5.0 adds game entry over the racing contract released in v0.4.0; the tag is cut from the merged pull request. Browser ESM is shipped directly; no consumer bundler is required. Map each subpath to installed source:

```html
<script type="importmap">
{
  "imports": {
    "@rb/arcade/audio": "./node_modules/@rb/arcade/src/audio.js",
    "@rb/arcade/presentation": "./node_modules/@rb/arcade/src/presentation.js",
    "@rb/arcade/course": "./node_modules/@rb/arcade/src/course.js",
    "@rb/arcade/racing": "./node_modules/@rb/arcade/src/racing.js",
    "@rb/arcade/entry": "./node_modules/@rb/arcade/src/entry.js"
  }
}
</script>
```

`./course` also needs `@rb/halo` at `>=0.2.5` on that import map (`@rb/halo/curve-surface` pointing at `node_modules`). Halo is an optional peer: audio and presentation install without it. A sibling checkout path is not a dependency. Keep a single Three.js instance, the one Halo peers. Arcade does not declare a Three.js dependency or peer, and no module imports it: presentation takes the game's `THREE` as an argument. The course surface calls Halo, and Halo imports that copy. Tests resolve Three.js through Halo's peer dependency.

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

## Presentation API

```js
import * as THREE from 'three'; // the game's copy, through Halo's peer dependency
import { createNameTag, createAppearance, createRemotePresentation } from '@rb/arcade/presentation';
```

Ownership is the contract: the module disposes only what it created (a tag's sprite material and canvas textures, the material clones an appearance makes). Meshes, geometries, materials and characters the game passes in are never disposed by it; remote characters go back to the game's `release` hook.

### Name tags

`createNameTag(THREE, options)` returns `{object, text, disposed, setText, placeAbove, dispose}`. `object` is a camera-facing `THREE.Sprite` whose origin is its bottom centre, so placing it at a crown point hangs the text above the head.

| Option | Default | Meaning |
| --- | --- | --- |
| `createCanvas()` | `document.createElement('canvas')` | Canvas source. Required outside a browser document (it throws otherwise). |
| `format(value)` | `cleanDisplayName` | Turns the game's name into display text: collapses whitespace, trims, caps at `maxLength` (24). |
| `height` | `0.34` | World height of the label; width follows the text. |
| `fontSize`, `fontFamily`, `fontWeight`, `fill`, `stroke`, `name` | `72`, `system-ui, sans-serif`, `700`, `#f6e7b8`, dark outline, `'name-tag'` | Paint style and sprite name. |

- `setText(value)` repaints only when the formatted text changes. A changed ink size binds a new `CanvasTexture` and disposes the previous one (WebGL2 keeps a canvas texture's first upload size). Empty text hides the tag.
- `placeAbove(target, {lift = 0.06, visible = true})` puts the tag at the top centre of `target`'s world bounding box plus `lift`, in world up, expressed in the tag's parent frame, so a tilted body does not tilt the label. The tag must already have a parent. It returns whether the tag is shown (false for empty text, `visible: false`, or empty bounds).
- `dispose()` removes the sprite from its parent and disposes its material and texture, once. Later `setText`/`placeAbove` throw.

`cleanDisplayName(value, {maxLength})`, `nameTagScale(w, h, height)` and `paintNameTag(canvas, text, style)` are exported for games that paint their own labels.

### Appearance on game meshes

`createAppearance({resolve})` applies appearance data `{[part]: {color?, visible?}}` to the objects `resolve(part)` returns (one `Object3D` or an array; nothing throws). Colours are hex numbers.

- `apply(appearance)` sets `visible` on each resolved object and writes `color` to every mesh material under it. The first colour write on a mesh replaces its material with a clone (each element of a material array is cloned), so a material the game shares between meshes or players is never changed. Later writes reuse the clone. Materials must have `clone()` and `color.setHex()`.
- `reset()` puts back the game's original materials and visibility and disposes the clones. `dispose()` is a final `reset()`; later `apply` throws. `ownedMaterials` counts live clones.
- Call `reset()` or `dispose()` before the game disposes or rebuilds those meshes.

Which parts exist, their names, and what a look means (wardrobe tables, dresser choices, defaults, saved looks) stay game data. A look that needs different geometry is a new character from the game's builder, which is what the remote lifecycle below does on a look change. `appearanceKey(look)` is a key-order-independent string for look data.

### Remote players

`createRemotePresentation(options)` keeps one presentation per remote id, rebuilds it when the look key changes, blends poses between network updates, hides players that leave the live set, and can keep a name tag above each one.

| Option | Default | Meaning |
| --- | --- | --- |
| `parent` | required | `Object3D` the characters' roots are added to. |
| `create(id, look)` | required | The game builds a character and returns at least `{root}`. Called again only when the look key changes. |
| `place(presentation, pose, context, id)` | required | The game positions the character for the blended pose (course sampling, animation). |
| `release(presentation, id)` | `presentation.dispose?.()` | The game releases a character the module dropped. The module only removes `root` from its parent first. |
| `lookOf(pose, id)` / `lookKey(look, id)` | `pose.look` / `appearanceKey` | Where the look lives in a pose, and its identity. |
| `lerp(from, to, t)` | snap to `to` | The game's pose blend, `t` in `[0, 1]`. |
| `blendMs` | `50` | Blend window per update. |
| `nameOf(pose, id)` | `pose.displayName` | Name text for the tag. |
| `nameTag` | none | `{THREE, anchor(presentation, id), lift, ...createNameTag options}`; the module owns one tag per remote. |

- `show(id, pose, now, {snap})` records an update at `now` (finite milliseconds). A mid-blend update starts from the pose on screen. On a look change the new character is built first (a throwing `create` leaves the current one in place), keeps the old visibility and name tag, and then the old one is released.
- `retain(liveIds)` hides every remote not listed and forgets its pose; its character stays built for a quick return.
- `place(now, context)` shows and places every remote with a pose, then sets and places its name tag.
- `poses(now)` returns the blended poses with `id`, the same ones `place` draws, for collision checks.
- `remove(id)` and `clear()` release characters to the game and dispose their tags. `clear()` tries every release and throws an `AggregateError` of the failures. `dispose()` clears once; afterwards `show`, `retain`, `place`, `poses` and `remove` throw. `get(id)`, `ids()` and `size` inspect it.

The module installs no listeners and runs no frame loop: the game calls `place` from Halo's frame loop. The party transport, slot assignment and pose schema stay in the game and Magna. No consumer is migrated by this change; garbage-can-race's `name-tag.js`, `looks.js` and `remotes.js` map onto `createNameTag`, its own wardrobe data with `createAppearance`, and `createRemotePresentation` with its rider builder as `create` and its course placement as `place`.

## Course API

```js
import { buildCourse, buildCourseSurface, disposeCourse, sampleCourse } from "@rb/arcade/course";

const course = buildCourse({ seed: 7, kind: "circuit", halfWidth: 7 });
const surface = buildCourseSurface(course);
// Add surface.geometry to a mesh in the game's scene, then:
disposeCourse(course);
```

`buildCourse({ seed, kind, halfWidth, sampleCount })` returns the same samples for the same seed. `kind` is `circuit` (closed), `open`, or `figure-eight` (closed, with an overpass). `halfWidth` is the paved half-width in meters. The call throws if the generated course fails validation.

### Coordinates

Distances are meters. The world is Y-up and right-handed: Y is up, the ground plane is XZ. `course.length` is arc length along the centerline. `sampleCourse(course, s)` reads that distance. On a closed course `s` wraps, and `s === length` is the start. On an open course `s` clamps to `[0, length]`.

Positive lateral is to the right of travel. That is Halo's horizontal normal, `(-forward.z, 0, forward.x)` on the ground. Check: travel `(0, 0, -1)` gives right `(1, 0, 0)`. `laneOffset(course, lane, laneCount)` uses the same sign. Lane 0 is the leftmost strip, so its offset is negative.

A closed course joins the last sample to the first. That closing segment is the seam. Validation rejects a closing gap much longer than the other segments, and a turn at the join that is sharper than the rest of the loop. An open course has no closing segment. Its first step at heading 0 travels along world -Z, which is garbage-can-race's travel direction.

`sampleCourse` returns `forward`, `right`, `up`, `yawGarbageCanRace`, and `yawGravacrest`.

- `yawGarbageCanRace` aims a local **-Z** nose along the horizontal part of travel. Travel `(0, 0, -1)` is yaw 0. Travel `(1, 0, 0)` is yaw `-π/2`. This matches garbage-can-race `headingYaw` in `src/course.js`.
- `yawGravacrest` aims a local **+Z** nose along that same horizontal direction. Travel `(0, 0, 1)` is yaw 0. This matches Gravacrest `runtime/arcade-track.js`, where yaw zero is +Z.

Up tilts with the road and stays above it. Right stays horizontal.

### Surface and disposal

`buildCourseSurface(course)` builds the paved ribbon with Halo's `buildRoadSurfaceGeometry` and `createHorizontalCurveNormal`. The index order is flipped when the first triangle faces down, so the road is visible from above. Every cross-section uses the course's sampled travel tangent. Closed endpoints share the same cross-section at the seam; open endpoints keep their final travel tangent.

Course samples are plain data and hold no GPU resource. The geometry uses the Three.js constructor Halo already imported. `disposeCourse(course)` disposes that geometry and is safe to call twice. Sampling, lanes, and a new surface after disposal throw `arcade/course: disposed`. The game drops its mesh. Games still dispose their own materials.

### Validation

`validateCourse(course, limits)` checks the centerline. A failure `kind` is `cusp`, `accidental-self-intersection`, `width-limit`, `curvature-limit`, `scenery-clearance`, or `loop-seam`. Any XZ contact between two segments that do not share a sample counts, including a sample lying on another segment or within 5 centimeters of it, so resampling a polyline does not change the verdict; on an open path the first and last segments are checked against each other, and only a closed path joins them. An XZ crossing is accepted when the two road heights differ by at least 4 meters, or when `course.crossings` lists that pair of distances. A flat figure-eight without a declared crossing is rejected. `buildCourse` of kind `figure-eight` declares its overpass crossing and keeps the strands 8 meters apart.

Default limits: a bend tighter than the fit half-width (the paved half-width, unless `fitHalfWidth` is set) is a width failure; a bend inside one extra meter is a curvature failure. Scenery closer than half a meter outside the paved edge, and within 3 meters of the road height, fails clearance.

`test/fixtures/gravacrest-sweep.json` records a sweep of Gravacrest `js/course-builders.js` at commit `6df876c9abfb8683b09a599bb24034d92fa90d01`. That generator has no seed argument, so the sweep replaced `Math.random` for each call with Mulberry32. Across 151 layouts it found width and curvature failures. It found no cusp, accidental self-intersection, scenery-clearance, or loop-seam failure, and the fixture file does not invent those. The committed failing layouts fail `validateCourse` again. `scripts/sweep-gravacrest.mjs` repeats the sweep when passed the path to that file. It is not part of the package consumers install.

## Racing API

```js
import { createRace, raceProgress, courseGap } from '@rb/arcade/racing';
import { sampleCourse } from '@rb/arcade/course';

// course is a buildCourse() result. This example uses a closed course.
const race = createRace({ course, laps: 3, direction: 1 });
race.add('car-a', { time: 0 });
race.add('car-b', { time: 0 });
// The game supplies signed displacement from its own simulation, in meters.
const state = race.advance('car-a', { delta: 12, time: 1 });
const pose = sampleCourse(course, state.s);
const rows = race.standings();
const leadMeters = race.gap('car-a', 'car-b');
const nearbyMeters = courseGap(course, state.s, race.get('car-b').s);
```

`raceProgress(course, distance, {laps = 1, direction = 1, start})` is pure. `course.length` is positive finite meters and `course.closed` is boolean, as released by `./course`. `distance` is signed, **unwrapped race meters from the start**, increasing toward the finish. It is not a wrapped station or a world position. Physics integration, projection onto the course, teleport/checkpoint validation and network authority stay with the game. A wrapped station alone cannot distinguish reverse travel from a forward lap or a multi-lap jump; supply the actual signed displacement to `advance` or accumulated race distance to `update`.

The result has `distance`, course station `s` (pass to `sampleCourse`), signed `completedLaps`, `lapDistance`, clamped race `fraction`, `finished` and `total` meters. Closed courses wrap at exact equality, including multiple loops per update; backward travel undoes laps, so -1 meter on a 100-meter loop is lap -1 at station 99. `lapDistance` is the remainder within that lap. `direction: -1` races toward decreasing course stations while race distance still increases toward the finish; backing up has a negative delta in either direction. Direction changes the station, not the course's sampled tangent; reverse-facing meshes remain the game's responsibility.

`start` is a course station in `[0, length]`, defaulting to 0 on loops and forward open runs, or `length` on reverse open runs. A loop's total is `length * laps` regardless of start. An open run finishes at its directional endpoint, uses exactly one lap, clamps display `s` to its endpoints, and must have positive distance from start to finish. Open `completedLaps` is 0 until finish and 1 thereafter; `lapDistance` is clamped race distance. The pure helper leaves `distance` unbounded and reports current finish status; it does not latch a finish.

`courseGap(course, firstS, secondS)` returns the absolute physical along-course gap in meters, taking the shortest arc on a loop and clamping stations on an open course. It ignores laps, lateral/vertical separation and race direction. `race.gap(firstId, secondId)` instead returns signed race-distance separation including whole laps: positive means the first racer is ahead.

`createRace({course, laps, direction, start, tieBreak})` snapshots these rules and returns:

| Method | Contract |
| --- | --- |
| `add(id, {distance = 0, time = 0})` | Registers a unique nonempty string ID before the finish. Negative starting distances are allowed. Returns a snapshot. |
| `update(id, {distance, time})` | Accepts absolute unwrapped race meters and a nonnegative sample time. Time cannot decrease for that racer. Returns a snapshot. |
| `advance(id, {delta, time})` | Adds signed race meters, then applies `update`. |
| `get(id)` | Returns a snapshot with progress fields, ID, sample `time` and nullable `finishTime`. |
| `gap(firstId, secondId)` | Signed race meters; finished racers are held at `total`. |
| `standings()` | Fresh snapshots with unique one-based `rank` and `gapToLeader` in meters. Finished racers come first by ascending finish time; running racers follow by descending race distance. |
| `reset()` | Clears all racers and finish history so the ledger can be reused. |

Use one monotonic time origin and unit for every racer (for example elapsed seconds). On the first sample reaching/passing `total`, the ledger linearly interpolates `finishTime` between the preceding sample and the crossing sample, then holds that racer at the finish permanently, even if later movement reverses. This assumes linear movement between samples; checkpoint qualification and other finish adjudication stay with the game, which decides which samples to submit. Equal sample times are allowed and yield that same finish time. Ledger snapshots of finishers use the crossing time for `time` too. Start a new race with `reset`.

Equal race distances or finish times use `tieBreak(a, b)`, an optional standard sort comparator returning a finite number (negative puts `a` first). It receives isolated snapshots. Supply a pure, consistent comparator, for example one using a game-owned grid-slot table; an equal result falls back to ascending ID by JavaScript code-unit order, independent of insertion/arrival order or locale. Ties are exact; quantization, shared-place awards and points policy remain in the game. All finished racers have zero meter gap to each other; finish time determines their order.

Invalid numbers, rules, IDs, unknown racers and decreasing timestamps throw with `arcade/racing:`. Invalid updates leave the ledger unchanged. The module imports no physics, renderer, transport or clock and holds no listeners, timers, or GPU resources: no disposal is needed. `reset` releases its racer entries; dropping the ledger releases all remaining state. Its course geometry snapshot survives the game's later `disposeCourse`; pure helpers reject a disposed course. Neither source game is migrated in this release.

## Game entry

```js
import { createGameEntry } from '@rb/arcade/entry';
import { createHudChatPanel } from '@rb/halo/ui/chat-panel.js';

// handoff is the object Magna's lobby passes to onStart. Do not copy PlayClient.
const entry = createGameEntry(handoff, {
  hooks: {
    prepare(view) {},
    entered(view) {},
    countdown({ startsAt, startsAtMs, late, cancelled }) {},
    start({ startsAt, startsAtMs }) {},
    leave({ reason }) {},
    failure(error) {},
  },
});
const panel = createHudChatPanel(hud, { transport: entry.transport });
await entry.enter(); // after the game has loaded and the player has entered VR
```

This integrates against Magna Play lobby release `61275e8c5542` (repository `websites-www.magnacms.com` commit `2bb5142`, the merge of pull request 24). Static games load that pin at `/mfes/mfe-play/61275e8c5542/play-lobby.js`. The contract is Magna `docs/15-third-party-feature-contract.md` section 9. `onStart` receives `{identity, table, seat, chat, arrive, read}`. `table` carries `code`, `slots`, `seed`, `phase` and the shared `startsAt`. `chat` carries `roomId`, `code`, `messages()`, `say(body)` and `watch({event, snapshot, status, refused})`. That `watch` is the WebSocket. It does not expose a topic or a credential.

`createGameEntry` takes that handoff as its adapter. It does not construct a client, choose an endpoint, read a credential, or decide arrival timeout or room retention. Those stay in Play. `prepare` runs synchronously from the constructor. `enter` subscribes `chat.watch` once and then calls `arrive` once. A thrown or rejected `arrive` or `watch` is passed to `failure` and rejected to the caller; it is not called again. `entered` runs after a table comes back.

Countdown and cancellation arrive as socket events (`countdown` carries `startsAt`; `countdown-cancelled` clears it). An `instance` event carries the room. A socket `snapshot` calls `read()` once for the current table and `messages()` once for the transcript. A rejected read is reported and is not repeated until Play delivers another snapshot. Nothing in this module polls. Every entered player arms `start` for that same `startsAt`. A duplicate event does not arm it again. A late event, one that arrives after `startsAt`, counts down with `late: true` and starts immediately. A different `startsAt` after `start` does not move the instant. A racing or counting table with no `startsAt` is a failure and does not invent a clock. A loading read that still has an empty `startsAt` does not erase a countdown the socket already delivered. `countdown-cancelled`, or a table whose phase is `waiting`, does.

`leave()` and `dispose()` unsubscribe once and call `leave` with `leave` or `disposed`. A `closed` event, this player `left` or `dropped`, a missing seat, or a refused socket also leave, with that reason. `dispose` is safe to call twice. Later `enter` rejects.

`entry.transport` is the transport Halo's HUD chat panel already accepts (`src/ui/chat-panel.js`: `subscribe`, `send`, optional `nameFor`). `subscribe` yields `{messages, status, watching, hasMore}`. Messages use the panel's `{id, authorUserId, body, createdAt}` shape, which Play's room lines already have. Duplicate ids are ignored. `nameFor` uses the seat's `displayName`. The panel draws the game's private room (`chat.roomId` / `chat.code`); the lobby's 2D room list stays in Play. Arcade does not import Halo, and the panel does not open its own socket: both share the one `watch`. `send` returns `say`'s promise, including its rejection.

The optional `now`, `schedule` and `cancel` arguments exist so a game can share its clock. The defaults are `Date.now` and one `setTimeout` aimed at `startsAt`, cleared if that instant changes or the player leaves. That timer is not a poll.

## Validation and device coverage

Use Node 24: `npm ci`, then `npm run build`. The build syntax-checks source/tests and runs Node's test runner; `npm pack --dry-run` verifies the installable source artifact. CI runs both. There is no transpilation output.

Presentation tests use Three.js and canvas doubles to cover texture rebinding, tag placement, clone-only colouring, rebuilds on a look change, hiding, release, and that only module-owned sprites, materials and textures are disposed; no browser has rendered a tag yet. Audio tests exercise lifecycle and injected browser API doubles, including refused gesture unlock, suspended contexts, media play rejection, pending starts, loop shutdown, end cleanup and owned/borrowed context disposal. No real phone (iOS/Safari or Android/Chrome) or Quest headset has been checked for audio output, gesture permission, XR input, background/resume interruption, hardware mute, or codec support. Those checks remain for release/adoption testing and must not be inferred from mocks or a desktop browser.

## Layout

`src/audio.js`, `src/presentation.js`, `src/course.js` (with `src/course/`), `src/racing.js` and `src/entry.js` are the browser ESM modules. Corresponding files in `test/` hold the Node tests, including racing seam/reverse travel, course sampling integration, finish order, configurable deterministic ties, and entry's shared `startsAt`, late and duplicate notices, leave, disposal and reported failures. `.github/workflows/build.yml` checks pull requests and branch pushes.

## Constraints

Do not pin Three.js in this repository. Halo's peer dependency is the shared copy, so a game keeps one Three.js instance. The release order is in `AGENTS.md`: library pull request with the build green, merge, tag, then consumers move their pin.
