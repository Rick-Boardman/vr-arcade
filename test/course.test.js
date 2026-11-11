import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCourse,
  buildCourseSurface,
  disposeCourse,
  frameFromTravel,
  garbageCanRaceYaw,
  gravacrestYaw,
  laneOffset,
  sampleCourse,
  validateCourse,
} from "../src/course.js";

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "gravacrest-sweep.json");

function rotateY(x, y, z, yaw) {
  const cosine = Math.cos(yaw);
  const sine = Math.sin(yaw);
  return { x: x * cosine + z * sine, y, z: -x * sine + z * cosine };
}

function kindsOf(result) {
  return new Set(result.findings.filter((finding) => !finding.accepted).map((finding) => finding.kind));
}

function lemniscate(overpass, count = 96) {
  const samples = [];
  for (let index = 0; index < count; index += 1) {
    const t = (index / count) * Math.PI * 2;
    samples.push({
      x: Math.cos(t) * 40,
      y: (overpass / 2) * (1 - Math.sin(t)),
      z: Math.sin(t) * Math.cos(t) * 70,
    });
  }
  return samples;
}

test("travel frame puts right on +X when moving along -Z", () => {
  const frame = frameFromTravel({ x: 0, y: 0, z: -1 });
  assert.ok(frame.right.x > 0.999);
  assert.ok(Math.abs(frame.right.y) < 1e-8);
  assert.ok(Math.abs(frame.right.z) < 1e-8);
  assert.ok(frame.up.y > 0.999);
});

test("yaw adapters aim the consumer nose along travel", () => {
  const tangents = [
    { x: 0, y: 0, z: -1 },
    { x: 1, y: 0, z: 0 },
    { x: 0, y: 0, z: 1 },
    { x: -0.4, y: 0.2, z: -0.8 },
  ];
  for (const tangent of tangents) {
    const horizontal = Math.hypot(tangent.x, tangent.z);
    const flat = { x: tangent.x / horizontal, z: tangent.z / horizontal };
    const garbageCan = rotateY(0, 0, -1, garbageCanRaceYaw(tangent));
    const gravacrest = rotateY(0, 0, 1, gravacrestYaw(tangent));
    assert.ok(Math.abs(garbageCan.x - flat.x) < 1e-9 && Math.abs(garbageCan.z - flat.z) < 1e-9);
    assert.ok(Math.abs(gravacrest.x - flat.x) < 1e-9 && Math.abs(gravacrest.z - flat.z) < 1e-9);
  }
  assert.ok(Math.abs(garbageCanRaceYaw({ x: 1, y: 0, z: 0 }) + Math.PI / 2) < 1e-12);
  assert.ok(Math.abs(gravacrestYaw({ x: 0, y: 0, z: 1 })) < 1e-12);
});

test("Gravacrest sweep fixtures fail the unchanged layouts", () => {
  const manifest = JSON.parse(readFileSync(fixturePath, "utf8"));
  assert.equal(manifest.source.commit, "6df876c9abfb8683b09a599bb24034d92fa90d01");
  assert.equal(manifest.counts.cusp, 0);
  assert.equal(manifest.counts["accidental-self-intersection"], 0);
  assert.equal(manifest.counts["scenery-clearance"], 0);
  assert.equal(manifest.counts["loop-seam"], 0);
  assert.ok(manifest.counts["width-limit"] > 0);
  assert.ok(manifest.counts["curvature-limit"] > 0);
  assert.ok(manifest.fixtures.length >= 2);
  for (const fixture of manifest.fixtures) {
    assert.equal(fixture.closed, true, `${fixture.trackType} must include its closing segment`);
    const result = validateCourse(fixture, fixture.limits);
    assert.equal(result.ok, false);
    const kinds = kindsOf(result);
    for (const kind of fixture.expectedKinds) assert.ok(kinds.has(kind), `${fixture.trackType} missing ${kind}`);
  }
});

test("a square circuit passes and a reversed join fails the seam", () => {
  const side = 80;
  const square = validateCourse({
    closed: true,
    halfWidth: 2,
    samples: [
      { x: 0, y: 0, z: 0 },
      { x: side, y: 0, z: 0 },
      { x: side, y: 0, z: side },
      { x: 0, y: 0, z: side },
    ],
  });
  assert.equal(square.ok, true, JSON.stringify(square.findings));

  const seam = validateCourse({
    closed: true,
    halfWidth: 2,
    samples: [
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
      { x: 20, y: 0, z: 0 },
      { x: 30, y: 0, z: 0 },
      { x: 40, y: 0, z: 0.2 },
    ],
  });
  assert.ok(kindsOf(seam).has("loop-seam"));
});

test("cusps, folds, and scenery on the pavement are rejected", () => {
  const cusp = validateCourse({
    closed: false,
    halfWidth: 1,
    samples: [
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 1, y: 0, z: 10 },
    ],
  });
  assert.ok(kindsOf(cusp).has("cusp"));

  const folded = [];
  for (let index = 0; index < 64; index += 1) {
    const angle = (index / 64) * Math.PI * 2;
    folded.push({ x: Math.cos(angle) * 5, y: 0, z: Math.sin(angle) * 5 });
  }
  const width = validateCourse({ closed: true, halfWidth: 6, samples: folded }, { fitHalfWidth: 6, curvatureMargin: 0.25 });
  assert.ok(kindsOf(width).has("width-limit"));
  assert.equal(kindsOf(width).has("curvature-limit"), false);

  const wide = [];
  for (let index = 0; index < 64; index += 1) {
    const angle = (index / 64) * Math.PI * 2;
    wide.push({ x: Math.cos(angle) * 10, y: 0, z: Math.sin(angle) * 10 });
  }
  const curvature = validateCourse({ closed: true, halfWidth: 6, samples: wide }, { fitHalfWidth: 6, curvatureMargin: 5 });
  assert.ok(kindsOf(curvature).has("curvature-limit"));
  assert.equal(kindsOf(curvature).has("width-limit"), false);

  const scenery = validateCourse({
    closed: false,
    halfWidth: 2,
    samples: Array.from({ length: 8 }, (_, index) => ({ x: index * 3, y: 0, z: 0 })),
    scenery: [{ x: 6, y: 0, z: 0.2 }],
  });
  assert.ok(kindsOf(scenery).has("scenery-clearance"));
});

test("an overpass crossing is accepted and a flat crossing is not", () => {
  const raised = validateCourse({ closed: true, halfWidth: 3, samples: lemniscate(8) });
  assert.equal(raised.ok, true, JSON.stringify(raised.findings));
  const accepted = validateCourse(
    { closed: true, halfWidth: 3, samples: lemniscate(8) },
    { includeAccepted: true },
  );
  assert.ok(accepted.findings.some((finding) => finding.kind === "intentional-crossing" && finding.accepted));

  const flat = validateCourse({ closed: true, halfWidth: 3, samples: lemniscate(0) });
  assert.ok(kindsOf(flat).has("accidental-self-intersection"));

  const flatSamples = lemniscate(0);
  let length = 0;
  const stations = [0];
  for (let index = 0; index < flatSamples.length; index += 1) {
    const next = flatSamples[(index + 1) % flatSamples.length];
    const current = flatSamples[index];
    length += Math.hypot(next.x - current.x, next.y - current.y, next.z - current.z);
    stations.push(length);
  }
  const nearest = flatSamples
    .map((sample, index) => ({ index, distance: Math.hypot(sample.x, sample.z), s: stations[index] }))
    .sort((left, right) => left.distance - right.distance);
  const first = nearest[0];
  const second = nearest.find((item) => Math.abs(item.index - first.index) > flatSamples.length / 4);
  const declared = validateCourse({
    closed: true,
    halfWidth: 3,
    samples: flatSamples,
    crossings: [{ sA: first.s, sB: second.s }],
  });
  assert.equal(kindsOf(declared).has("accidental-self-intersection"), false, JSON.stringify(declared.findings));
});

function flatPath(points, y = 0) {
  return points.map(([x, z]) => ({ x, y, z }));
}

test("an open path checks its first and last segments against each other", () => {
  const loop = [[-10, -10], [10, 10], [10, 30], [-10, 30], [-10, 10], [10, -10]];
  const open = validateCourse({ closed: false, halfWidth: 1, samples: flatPath(loop) });
  assert.ok(kindsOf(open).has("accidental-self-intersection"), JSON.stringify(open.findings));
  const longer = validateCourse({ closed: false, halfWidth: 1, samples: flatPath([...loop, [20, -20]]) });
  assert.ok(kindsOf(longer).has("accidental-self-intersection"), JSON.stringify(longer.findings));

  const raised = flatPath(loop).map((sample, index) => (index === 0 ? { ...sample, y: 8 } : sample));
  raised[1] = { ...raised[1], y: 8 };
  const overpass = validateCourse({ closed: false, halfWidth: 1, samples: raised });
  assert.equal(kindsOf(overpass).has("accidental-self-intersection"), false, JSON.stringify(overpass.findings));

  const square = validateCourse({ closed: true, halfWidth: 1, samples: flatPath([[0, 0], [20, 0], [20, 20], [0, 20]]) });
  assert.equal(kindsOf(square).has("accidental-self-intersection"), false, JSON.stringify(square.findings));
});

test("a sample on another segment is a crossing whatever the sampling", () => {
  const plain = [[-10, -10], [10, 10], [10, 30], [-10, 30], [-10, 10], [10, -10], [20, -20]];
  const resampled = [[-10, -10], [10, 10], [10, 30], [-10, 30], [-10, 10], [0, 0], [10, -10], [20, -20]];
  for (const points of [plain, resampled]) {
    const result = validateCourse({ closed: false, halfWidth: 1, samples: flatPath(points) });
    const hits = result.findings.filter((finding) => finding.kind === "accidental-self-intersection");
    assert.equal(hits.length, 1, JSON.stringify(result.findings));
  }

  // The contact is (0, 0): partway along the first segment, and sample 5 of the resampled path.
  const samples = flatPath(resampled);
  let station = 0;
  for (let index = 0; index < 5; index += 1) {
    station += Math.hypot(samples[index + 1].x - samples[index].x, samples[index + 1].z - samples[index].z);
  }
  const crossings = [{ sA: Math.hypot(10, 10), sB: station }];
  const declared = validateCourse({ closed: false, halfWidth: 1, samples, crossings });
  assert.equal(declared.ok, true, JSON.stringify(declared.findings));
  const declaredAccepted = validateCourse({ closed: false, halfWidth: 1, samples, crossings }, { includeAccepted: true });
  assert.ok(declaredAccepted.findings.some((finding) => finding.kind === "intentional-crossing" && finding.accepted));

  const lifted = flatPath(resampled).map((sample, index) => (index <= 1 ? { ...sample, y: 8 } : sample));
  const overpass = validateCourse({ closed: false, halfWidth: 1, samples: lifted });
  assert.equal(overpass.ok, true, JSON.stringify(overpass.findings));
});

test("one seed always builds the same course", () => {
  const first = buildCourse({ seed: 42, kind: "circuit" });
  const second = buildCourse({ seed: 42, kind: "circuit" });
  assert.deepEqual(first.samples, second.samples);
  assert.notDeepEqual(first.samples, buildCourse({ seed: 43, kind: "circuit" }).samples);
  for (const kind of ["circuit", "open", "figure-eight"]) {
    const course = buildCourse({ seed: 7, kind });
    assert.equal(validateCourse(course).ok, true, kind);
    assert.equal(course.units, "meters");
    assert.equal(course.closed, kind !== "open");
  }
});

test("open travel starts along -Z and lanes are left then right", () => {
  const course = buildCourse({ seed: 3, kind: "open", sampleCount: 32 });
  const start = sampleCourse(course, 0);
  const later = sampleCourse(course, 20);
  assert.ok(later.position.z < start.position.z);
  assert.ok(Math.abs(start.forward.x) < 0.05);
  assert.ok(start.forward.z < -0.9);
  assert.ok(Math.abs(start.yawGarbageCanRace) < 1e-6);
  assert.ok(laneOffset(course, 0, 2) < 0);
  assert.ok(laneOffset(course, 1, 2) > 0);
  const closed = buildCourse({ seed: 3, kind: "circuit" });
  const seam = sampleCourse(closed, closed.length);
  const origin = sampleCourse(closed, 0);
  assert.ok(Math.abs(seam.position.x - origin.position.x) < 1e-6);
  assert.ok(Math.abs(seam.position.z - origin.position.z) < 1e-6);

  const surface = buildCourseSurface(course, { segmentCount: 16 });
  const positions = surface.geometry.attributes.position.array;
  const vertex = 16 * 2;
  const endX = (positions[vertex * 3] + positions[(vertex + 1) * 3]) / 2;
  const endZ = (positions[vertex * 3 + 2] + positions[(vertex + 1) * 3 + 2]) / 2;
  const end = sampleCourse(course, course.length).position;
  assert.ok(Math.hypot(endX - end.x, endZ - end.z) < 1e-4);
  assert.ok(Math.hypot(endX - start.position.x, endZ - start.position.z) > 10);
  disposeCourse(course);
});

test("every ribbon cross-section keeps its width and closed seams meet", () => {
  for (const kind of ["circuit", "figure-eight", "open"]) {
    const course = buildCourse({ seed: 9, kind });
    const segmentCount = 64;
    const surface = buildCourseSurface(course, { segmentCount });
    const positions = surface.geometry.attributes.position.array;
    for (let section = 0; section <= segmentCount; section += 1) {
      const offset = section * 6;
      const width = Math.hypot(
        positions[offset + 3] - positions[offset],
        positions[offset + 4] - positions[offset + 1],
        positions[offset + 5] - positions[offset + 2],
      );
      assert.ok(Math.abs(width - course.halfWidth * 2) < 1e-4, `${kind} section ${section}: ${width}`);
    }
    if (course.closed) {
      for (let coordinate = 0; coordinate < 6; coordinate += 1) {
        assert.ok(Math.abs(positions[coordinate] - positions[segmentCount * 6 + coordinate]) < 1e-4,
          `${kind} seam coordinate ${coordinate}`);
      }
    }
    disposeCourse(course);
  }
});

test("the road ribbon faces up and disposal releases it once", () => {
  const course = buildCourse({ seed: 9, kind: "circuit", sampleCount: 48 });
  const surface = buildCourseSurface(course, { segmentCount: 24 });
  const positions = surface.geometry.attributes.position.array;
  const index = surface.geometry.index.array;
  const ax = positions[index[0] * 3];
  const az = positions[index[0] * 3 + 2];
  const bx = positions[index[1] * 3];
  const bz = positions[index[1] * 3 + 2];
  const cx = positions[index[2] * 3];
  const cz = positions[index[2] * 3 + 2];
  const normalY = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
  assert.ok(normalY > 0);
  const sample = sampleCourse(course, 0);
  const rightX = positions[3] - sample.position.x;
  const rightZ = positions[5] - sample.position.z;
  const along = rightX * sample.right.x + rightZ * sample.right.z;
  assert.ok(along > course.halfWidth * 0.95);
  let disposed = 0;
  const original = surface.geometry.dispose.bind(surface.geometry);
  surface.geometry.dispose = () => {
    disposed += 1;
    original();
  };
  disposeCourse(course);
  assert.equal(disposed, 1);
  disposeCourse(course);
  assert.equal(disposed, 1);
  assert.throws(() => sampleCourse(course, 0), /disposed/);
});
