import test from "node:test";
import assert from "node:assert/strict";
import { buildCourse, sampleCourse, disposeCourse } from "../src/course.js";
import { raceProgress, courseGap, createRace } from "@rb/arcade/racing";

const loop = { length: 100, closed: true };
const hill = { length: 100, closed: false };

test("loop progress handles exact seams, multiple laps and reverse travel", () => {
  for (const [distance, laps, remainder] of [[0, 0, 0], [100, 1, 0], [350, 3, 50], [-1, -1, 99], [-200, -2, 0]]) {
    const state = raceProgress(loop, distance, { laps: 4 });
    assert.equal(state.completedLaps, laps);
    assert.equal(state.lapDistance, remainder);
    assert.equal(state.s, remainder);
  }
  const race = createRace({ course: loop, laps: 4 });
  race.add("car", { distance: 99 });
  assert.equal(race.advance("car", { delta: 2, time: 1 }).completedLaps, 1);
  assert.equal(race.advance("car", { delta: -2, time: 2 }).completedLaps, 0);
  assert.equal(race.advance("car", { delta: -300, time: 3 }).completedLaps, -3);
  assert.equal(race.advance("car", { delta: 600, time: 4 }).completedLaps, 3);
});

test("race direction and displaced start map race meters to the released course API", () => {
  for (const kind of ["circuit", "open"]) {
    const course = buildCourse({ seed: 7, kind });
    const state = raceProgress(course, 12, { direction: -1 });
    assert.ok(Math.abs(state.s - (course.length - 12)) < 1e-9);
    assert.equal(sampleCourse(course, state.s).s, state.s);
    const ledger = createRace({ course });
    ledger.add("a");
    disposeCourse(course);
    assert.equal(ledger.advance("a", { delta: 3, time: 1 }).distance, 3);
    assert.throws(() => raceProgress(course, 1), /disposed/);
  }
  assert.equal(raceProgress(loop, 30, { start: 20, direction: -1 }).s, 90);
  assert.equal(raceProgress(loop, 100, { start: 20 }).s, 20);
  assert.equal(raceProgress(hill, 25, { start: 40, direction: -1 }).s, 15);
  assert.equal(raceProgress(hill, 40, { start: 40, direction: -1 }).finished, true);
});

test("open courses clamp display stations and finish at their endpoint in either direction", () => {
  assert.equal(raceProgress(hill, -20).s, 0);
  assert.equal(raceProgress(hill, 120).s, 100);
  assert.equal(raceProgress(hill, 120).completedLaps, 1);
  assert.equal(raceProgress(hill, 99).finished, false);
  assert.equal(raceProgress(hill, 100).finished, true);
  assert.equal(raceProgress(hill, 120, { direction: -1 }).s, 0);
  assert.equal(raceProgress(hill, -20, { direction: -1 }).s, 100);
});

test("physical seam gap differs from race gap and standings include whole laps", () => {
  assert.equal(courseGap(loop, 99, 1), 2);
  assert.equal(courseGap(loop, -201, 301), 2);
  assert.equal(courseGap(hill, 99, 1), 98);
  assert.equal(courseGap(hill, -20, 120), 100);
  const race = createRace({ course: loop, laps: 4 });
  race.add("behind", { distance: 99 });
  race.add("ahead", { distance: 201 });
  assert.equal(race.gap("ahead", "behind"), 102);
  assert.deepEqual(race.standings().map(r => [r.id, r.rank, r.gapToLeader]), [["ahead", 1, 0], ["behind", 2, 102]]);
});

test("finish ordering uses interpolated crossing times, independent of update arrival order", () => {
  for (const course of [hill, loop]) {
    const race = createRace({ course, laps: course.closed ? 2 : 1 });
    const target = course.closed ? 200 : 100;
    race.add("late", { distance: target - 20, time: 10 });
    race.add("early", { distance: target - 10, time: 10 });
    race.add("running", { distance: target - 1, time: 10 });
    assert.equal(race.update("late", { distance: target + 20, time: 20 }).finishTime, 15);
    assert.equal(race.update("early", { distance: target + 30, time: 20 }).finishTime, 12.5);
    assert.deepEqual(race.standings().map(r => r.id), ["early", "late", "running"]);
    const finished = race.get("early");
    assert.deepEqual(race.update("early", { distance: -10, time: 25 }), finished);
    assert.equal(finished.distance, target);
  }
});

test("exact and same-time finishes, configurable ties and ID fallback are deterministic", () => {
  for (const order of [["z", "a", "m"], ["m", "z", "a"]]) {
    const race = createRace({ course: hill });
    for (const id of order) race.add(id);
    assert.deepEqual(race.standings().map(r => r.id), ["a", "m", "z"]);
    for (const id of order) race.update(id, { distance: 100, time: 10 });
    assert.deepEqual(race.standings().map(r => [r.id, r.finishTime]), [["a", 10], ["m", 10], ["z", 10]]);
  }
  const race = createRace({ course: hill, tieBreak: (a, b) => b.id < a.id ? -1 : b.id > a.id ? 1 : 0 });
  race.add("a"); race.add("z");
  assert.deepEqual(race.standings().map(r => r.id), ["z", "a"]);
  race.update("a", { distance: 100, time: 0 });
  race.update("z", { distance: 100, time: 0 });
  assert.deepEqual(race.standings().map(r => r.id), ["z", "a"]);
});

test("snapshots are isolated, reset frees entries, and invalid updates are atomic", () => {
  const race = createRace({ course: loop });
  race.add("a", { time: 3 });
  const before = race.get("a");
  race.get("a").distance = 90;
  race.standings()[0].distance = 90;
  for (const sample of [{ distance: NaN, time: 4 }, { distance: 10, time: 2 }, { distance: 10, time: Infinity }]) {
    assert.throws(() => race.update("a", sample), /arcade\/racing:/);
    assert.deepEqual(race.get("a"), before);
  }
  assert.throws(() => race.advance("a", { delta: Infinity, time: 4 }), /finite/);
  assert.throws(() => race.add("a"), /duplicate/);
  assert.throws(() => race.add("b", { distance: 100 }), /before the finish/);
  assert.throws(() => race.get("unknown"), /unknown racer/);
  assert.throws(() => race.add(""), /nonempty/);
  race.reset();
  assert.deepEqual(race.standings(), []);
  race.add("a");
  assert.equal(race.get("a").distance, 0);
});

test("invalid geometry, race rules and tie rules fail loudly", () => {
  for (const course of [null, { length: 0, closed: true }, { length: Infinity, closed: true }, { length: 100 }, { ...loop, disposed: true }]) {
    assert.throws(() => raceProgress(course, 0), /arcade\/racing:/);
  }
  for (const options of [{ laps: 0 }, { laps: 1.5 }, { direction: 0 }, { start: -1 }, { start: 101 }]) {
    assert.throws(() => raceProgress(loop, 0, options), /arcade\/racing:/);
  }
  assert.throws(() => raceProgress(hill, 0, { laps: 2 }), /open courses/);
  assert.throws(() => raceProgress(hill, 0, { start: 100 }), /beyond start/);
  assert.throws(() => courseGap(loop, NaN, 0), /finite/);
  assert.throws(() => createRace({ course: loop, tieBreak: false }), /function/);
  const race = createRace({ course: loop, tieBreak: () => NaN });
  race.add("a"); race.add("b");
  assert.throws(() => race.standings(), /tieBreak result/);
});

test("custom tie rules cannot override progress or finish time and cannot mutate stored snapshots", () => {
  const race = createRace({ course: hill, tieBreak: (a, b) => {
    a.distance = -100;
    b.distance = -100;
    return a.id === "preferred" ? -1 : 1;
  } });
  race.add("preferred"); race.add("other");
  assert.equal(race.standings()[0].id, "preferred");
  assert.equal(race.get("preferred").distance, 0);
  race.update("other", { distance: 10, time: 1 });
  assert.equal(race.standings()[0].id, "other");
  race.update("other", { distance: 100, time: 10 });
  race.update("preferred", { distance: 100, time: 20 });
  assert.equal(race.standings()[0].id, "other");
});

test("overflowing arithmetic is rejected before a finish corrupts the ledger", () => {
  const race = createRace({ course: { length: 1e308, closed: false } });
  race.add("a", { distance: -1e308 });
  const before = race.get("a");
  assert.throws(() => race.update("a", { distance: 1e308, time: 1 }), /finite/);
  assert.deepEqual(race.get("a"), before);
  assert.throws(() => raceProgress({ length: Number.MIN_VALUE, closed: true }, 100), /finite/);
});
