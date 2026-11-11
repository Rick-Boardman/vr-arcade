// Sweep Gravacrest's unchanged generateTrackLayout. The file has no seed argument:
// Math.random is replaced for the call only, by mulberry32(seed). Pass the path
// to js/course-builders.js. This script is not part of the package build.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const courseFile = process.argv[2];
if (!courseFile) {
  process.stderr.write("arcade/sweep: pass the path to Gravacrest js/course-builders.js\n");
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { validateCourse } = await import(pathToFileURL(path.join(root, "src/course.js")).href);
const builders = await import(pathToFileURL(path.resolve(courseFile)).href);
const gravacrestRoot = path.resolve(path.dirname(courseFile), "..");
const { createHorizontalCurveNormal } = await import(pathToFileURL(path.join(
  gravacrestRoot,
  "node_modules/@rb/halo/src/curve-surface.js",
)).href);

const SOURCE_COMMIT = "6df876c9abfb8683b09a599bb24034d92fa90d01";
const THEME = {
  gp: { roadWidth: 14, shoulderWidth: 4.6, runoffWidth: 11 },
  oval: { roadWidth: 15, shoulderWidth: 3.2, runoffWidth: 9 },
  street: { roadWidth: 12.4, shoulderWidth: 0.55, runoffWidth: 1.1 },
  road: { roadWidth: 10.5, shoulderWidth: 1.4, runoffWidth: 1.8 },
  figure8: { roadWidth: 13, shoulderWidth: 3.2, runoffWidth: 6.5 },
  endurance: { roadWidth: 13, shoulderWidth: 4, runoffWidth: 8 },
};
const TYPES = ["gp", "oval", "street", "road", "figure8", "endurance", "random"];
const SAMPLE_COUNT = 360;
const SEED_COUNT = 24;
const KEEP_PER_KIND = 2;
const KINDS = [
  "cusp",
  "accidental-self-intersection",
  "width-limit",
  "curvature-limit",
  "scenery-clearance",
  "loop-seam",
];

function mulberry32(seed) {
  let state = (seed >>> 0) || 1;
  return function random() {
    state += 0x6d2b79f5;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function deterministicUnit(index, seed = 1) {
  const value = Math.sin(index * 12.9898 + seed * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

function withSeed(seed, fn) {
  const original = Math.random;
  Math.random = mulberry32(seed);
  try {
    return fn();
  } finally {
    Math.random = original;
  }
}

function place(curve, progress, lateral, yOffset) {
  const point = curve.getPointAt(progress);
  const tangent = curve.getTangentAt(progress);
  const normal = createHorizontalCurveNormal(tangent);
  return {
    x: point.x + normal.x * lateral,
    y: point.y + normal.y * lateral + yOffset,
    z: point.z + normal.z * lateral,
  };
}

function outwardSign(curve, progress) {
  const center = { x: 0, y: 0, z: 0 };
  const count = 64;
  for (let index = 0; index < count; index += 1) {
    const point = curve.getPointAt(index / count);
    center.x += point.x;
    center.y += point.y;
    center.z += point.z;
  }
  center.x /= count;
  center.y /= count;
  center.z /= count;
  const point = curve.getPointAt(progress);
  const normal = createHorizontalCurveNormal(curve.getTangentAt(progress));
  const toward = (point.x - center.x) * normal.x + (point.z - center.z) * normal.z;
  return toward >= 0 ? 1 : -1;
}

function sceneryFor(curve, trackType) {
  const theme = THEME[trackType] ?? THEME.gp;
  const outerOffset = theme.roadWidth / 2 + theme.shoulderWidth + 4.8;
  const items = [];
  if (trackType === "road") {
    for (let index = 0; index < 18; index += 1) {
      const progress = index / 18;
      const side = deterministicUnit(index, 2) > 0.5 ? 1 : -1;
      const startup = progress >= 0.02 && progress <= 0.18;
      if (!startup) {
        items.push(place(curve, progress, side * (outerOffset + deterministicUnit(index, 5) * 6), -0.4));
      }
      if (index % 3 === 0) {
        items.push(place(curve, (progress + 0.035) % 1, -side * (theme.roadWidth / 2 + 2.6), 0.08));
      }
      if (index % 6 === 0) {
        items.push(place(curve, (progress + 0.018) % 1, side * (outerOffset + 2.4), 0));
      }
    }
    return items;
  }
  if (trackType === "street") {
    const barrier = theme.roadWidth * 0.5 + theme.shoulderWidth + theme.runoffWidth + 0.38;
    for (let index = 0; index < 16; index += 1) {
      const progress = index / 16;
      const startup = progress >= 0.9 || progress <= 0.18;
      if (startup) continue;
      const side = index % 2 === 0 ? 1 : -1;
      if (index % 2 === 0) {
        items.push(place(curve, (progress + 0.03) % 1, -side * (outerOffset + 1.6), 0));
      }
      if (builders.calculateCurvature(curve, progress) > 0.075) {
        items.push(place(curve, (progress + 0.02) % 1, side * barrier, 0.12));
      }
    }
    return items;
  }
  for (let index = 0; index < 10; index += 1) {
    const progress = index / 10;
    items.push(place(curve, progress, outwardSign(curve, progress) * (outerOffset + 2.5), 0.08));
    const pole = (progress + 0.045) % 1;
    items.push(place(curve, pole, outwardSign(curve, pole) * (outerOffset + 5.8), 0));
  }
  return items;
}

function roundPoint(point) {
  return {
    x: Number(point.x.toFixed(4)),
    y: Number(point.y.toFixed(4)),
    z: Number(point.z.toFixed(4)),
  };
}

const counts = Object.fromEntries(KINDS.map((kind) => [kind, 0]));
const kept = Object.fromEntries(KINDS.map((kind) => [kind, 0]));
const fixtures = [];
let layouts = 0;

function consider(seed, selectedType, randomize) {
  const layout = withSeed(seed, () => builders.generateTrackLayout({
    selectedType,
    randomize,
    elevationMultiplier: 1,
  }));
  const trackType = layout.currentTrackType;
  const theme = THEME[trackType] ?? THEME.gp;
  const curve = builders.createTrackCurve(layout.trackPoints);
  const samples = [];
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    samples.push(roundPoint(curve.getPointAt(index / SAMPLE_COUNT)));
  }
  const scenery = sceneryFor(curve, trackType).map(roundPoint);
  const paved = theme.roadWidth / 2;
  const graded = paved + theme.shoulderWidth + theme.runoffWidth;
  const limits = {
    fitHalfWidth: Number(graded.toFixed(4)),
    curvatureMargin: 10,
  };
  const course = {
    closed: true,
    halfWidth: paved,
    samples,
    scenery,
    crossings: [],
  };
  const result = validateCourse(course, limits);
  layouts += 1;
  if (result.ok) return;
  const kinds = [...new Set(result.findings.filter((finding) => !finding.accepted).map((finding) => finding.kind))];
  for (const kind of kinds) counts[kind] += 1;
  const novel = kinds.filter((kind) => kept[kind] < KEEP_PER_KIND);
  if (novel.length === 0) return;
  for (const kind of novel) kept[kind] += 1;
  fixtures.push({
    seed,
    selectedType,
    randomize,
    trackType,
    closed: course.closed,
    halfWidth: paved,
    limits,
    samples,
    scenery,
    expectedKinds: kinds,
  });
}

for (const selectedType of TYPES) {
  if (selectedType === "figure8") {
    consider(1, selectedType, false);
    continue;
  }
  consider(1, selectedType, false);
  for (let seed = 1; seed <= SEED_COUNT; seed += 1) consider(seed, selectedType, true);
}

const manifest = {
  source: {
    repo: "nexus/vr/gravacrest",
    commit: SOURCE_COMMIT,
    file: "js/course-builders.js",
    generator: "generateTrackLayout + createTrackCurve",
    seeding: "Math.random replaced for the call by mulberry32(seed); the generator has no seed argument",
  },
  sampleCount: SAMPLE_COUNT,
  layouts,
  counts,
  fixtures,
};

const destination = path.join(root, "test", "fixtures", "gravacrest-sweep.json");
mkdirSync(path.dirname(destination), { recursive: true });
writeFileSync(destination, `${JSON.stringify(manifest)}\n`);
process.stdout.write(`arcade/sweep: ${layouts} layouts, fixtures ${fixtures.length}\n`);
for (const kind of KINDS) process.stdout.write(`arcade/sweep: ${kind} ${counts[kind]}\n`);
