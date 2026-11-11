import { frameFromTravel, garbageCanRaceYaw, gravacrestYaw } from "./frame.js";
import { validateCourse } from "./validate.js";

// Same Mulberry32 step as @rb/halo/src/prng.js createMulberry32Rng.
function createMulberry32(seed) {
  let state = (Number(seed) >>> 0) || 1;
  return function next() {
    state += 0x6d2b79f5;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function stationsOf(samples, closed) {
  const stations = [0];
  const count = closed ? samples.length : samples.length - 1;
  for (let index = 0; index < count; index += 1) {
    const current = samples[index];
    const next = samples[(index + 1) % samples.length];
    stations.push(stations[index] + Math.hypot(next.x - current.x, next.y - current.y, next.z - current.z));
  }
  return stations;
}

function circuitSamples(rng, count) {
  const base = 80 + rng() * 20;
  const primary = 4 + rng() * 3;
  const secondary = 1 + rng() * 2;
  const phase = rng() * Math.PI * 2;
  const lift = rng() * Math.PI * 2;
  const samples = [];
  for (let index = 0; index < count; index += 1) {
    const theta = (index / count) * Math.PI * 2;
    const radius = base + primary * Math.sin(2 * theta + phase) + secondary * Math.sin(3 * theta + lift);
    samples.push({
      x: Math.cos(theta) * radius,
      y: Math.sin(theta + lift) * 1.5,
      z: Math.sin(theta) * radius,
    });
  }
  return samples;
}

function openSamples(rng, count) {
  const length = 360;
  const step = length / (count - 1);
  const phase = rng() * Math.PI * 2;
  const frequency = 0.008 + rng() * 0.006;
  const amplitude = 0.003 + rng() * 0.002;
  const grade = 0.06 + rng() * 0.03;
  let x = 0;
  let y = 30;
  let z = 0;
  let heading = 0;
  const samples = [];
  for (let index = 0; index < count; index += 1) {
    samples.push({ x, y, z });
    const cosine = Math.cos(grade);
    x += Math.sin(heading) * cosine * step;
    y -= Math.sin(grade) * step;
    z -= Math.cos(heading) * cosine * step;
    const distance = index * step;
    heading += Math.sin(distance * frequency + phase) * amplitude * step;
  }
  return samples;
}

function figureSamples(rng, count) {
  const width = 64 + rng() * 8;
  const depth = 100 + rng() * 12;
  const overpass = 8;
  const samples = [];
  for (let index = 0; index < count; index += 1) {
    const t = (index / count) * Math.PI * 2;
    samples.push({
      x: Math.cos(t) * width,
      y: (overpass / 2) * (1 - Math.sin(t)),
      z: Math.sin(t) * Math.cos(t) * depth,
    });
  }
  return samples;
}

function sceneryBeside(samples, halfWidth) {
  const current = samples[0];
  const next = samples[1];
  const frame = frameFromTravel({
    x: next.x - current.x,
    y: next.y - current.y,
    z: next.z - current.z,
  });
  const lateral = halfWidth + 4;
  return {
    x: current.x + frame.right.x * lateral,
    y: current.y,
    z: current.z + frame.right.z * lateral,
  };
}

function figureCrossings(samples, stations) {
  const ranked = samples
    .map((sample, index) => ({ index, distance: Math.hypot(sample.x, sample.z), s: stations[index] }))
    .sort((left, right) => left.distance - right.distance);
  const first = ranked[0];
  const second = ranked.find((item) => Math.abs(item.index - first.index) > samples.length / 4);
  if (!second) return [];
  return [{ sA: first.s, sB: second.s }];
}

/**
 * Build a deterministic course. `seed` is an unsigned 32-bit integer.
 * `kind` is `circuit`, `open`, or `figure-eight`. Distances are meters.
 * Positive lane and lateral offsets are to the right of travel.
 */
export function buildCourse({
  seed = 1,
  kind = "circuit",
  halfWidth = 7,
  sampleCount = 128,
} = {}) {
  if (kind !== "circuit" && kind !== "open" && kind !== "figure-eight") {
    throw new Error(`arcade/course: unknown kind ${kind}`);
  }
  if (!Number.isFinite(halfWidth) || halfWidth <= 0) {
    throw new RangeError("arcade/course: halfWidth must be positive");
  }
  const count = sampleCount | 0;
  if (count < 16 || count > 720) {
    throw new RangeError("arcade/course: sampleCount must be from 16 to 720");
  }
  const numeric = (Number(seed) >>> 0) || 1;
  const rng = createMulberry32(numeric);
  const samples = kind === "open"
    ? openSamples(rng, count)
    : kind === "figure-eight"
      ? figureSamples(rng, count)
      : circuitSamples(rng, count);
  const closed = kind !== "open";
  const stations = stationsOf(samples, closed);
  const course = {
    seed: numeric,
    kind,
    closed,
    units: "meters",
    halfWidth,
    length: stations[stations.length - 1],
    stations,
    samples,
    scenery: [sceneryBeside(samples, halfWidth)],
    crossings: kind === "figure-eight" ? figureCrossings(samples, stations) : [],
    disposed: false,
    surface: null,
  };
  const result = validateCourse(course);
  if (!result.ok) {
    const kinds = [...new Set(result.findings.map((finding) => finding.kind))].join(", ");
    throw new Error(`arcade/course: generated course failed validation: ${kinds}`);
  }
  return course;
}

/** Lane 0 is the leftmost strip. The returned offset is meters to the right of the centerline. */
export function laneOffset(course, lane, laneCount = 2) {
  if (!course || course.disposed) throw new Error("arcade/course: disposed");
  if (!Number.isInteger(laneCount) || laneCount < 1) {
    throw new RangeError("arcade/course: laneCount must be a positive integer");
  }
  if (!Number.isInteger(lane) || lane < 0 || lane >= laneCount) {
    throw new RangeError("arcade/course: lane is outside 0..laneCount-1");
  }
  const laneWidth = (course.halfWidth * 2) / laneCount;
  return -course.halfWidth + (lane + 0.5) * laneWidth;
}

export function sampleCourse(course, distance) {
  if (!course || course.disposed) throw new Error("arcade/course: disposed");
  if (!Number.isFinite(distance)) throw new TypeError("arcade/course: distance must be finite");
  let s = distance;
  if (course.closed) s = ((s % course.length) + course.length) % course.length;
  else s = Math.min(course.length, Math.max(0, s));
  const last = course.closed ? course.samples.length - 1 : course.samples.length - 2;
  let index = 0;
  while (index < last && course.stations[index + 1] <= s) index += 1;
  const span = course.stations[index + 1] - course.stations[index];
  const t = span > 0 ? (s - course.stations[index]) / span : 0;
  const start = course.samples[index];
  const end = course.samples[(index + 1) % course.samples.length];
  const frame = frameFromTravel({
    x: end.x - start.x,
    y: end.y - start.y,
    z: end.z - start.z,
  });
  return {
    s,
    position: {
      x: start.x + (end.x - start.x) * t,
      y: start.y + (end.y - start.y) * t,
      z: start.z + (end.z - start.z) * t,
    },
    forward: frame.forward,
    right: frame.right,
    up: frame.up,
    yawGarbageCanRace: garbageCanRaceYaw(frame.forward),
    yawGravacrest: gravacrestYaw(frame.forward),
  };
}

export function pointOnCourse(course, distance, lateral = 0) {
  if (!Number.isFinite(lateral)) throw new TypeError("arcade/course: lateral must be finite");
  const sample = sampleCourse(course, distance);
  return {
    ...sample,
    position: {
      x: sample.position.x + sample.right.x * lateral,
      y: sample.position.y + sample.right.y * lateral,
      z: sample.position.z + sample.right.z * lateral,
    },
  };
}
