import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  frameFromTravel,
  garbageCanRaceYaw,
  gravacrestYaw,
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
