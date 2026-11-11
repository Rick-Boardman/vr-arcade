// Map validator. Distances are meters. A closed course joins the last sample
// to the first. An XZ crossing whose road heights differ by overpassClearance,
// or that is listed in course.crossings, is an intentional crossing.

const DEFAULT_LIMITS = Object.freeze({
  cuspTurnRadians: Math.PI * 0.7,
  curvatureMargin: 1,
  overpassClearance: 4,
  sceneryGap: 0.5,
  sceneryVertical: 3,
  seamGapFactor: 2.5,
  seamTurnRadians: Math.PI / 3,
  minHalfWidth: 0.5,
  maxHalfWidth: 40,
  crossingTolerance: 2,
  maxFindingsPerKind: 8,
});

function fail(message) {
  throw new TypeError(`arcade/course: ${message}`);
}

function isPoint(value) {
  return value && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

function distance(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
}

function measure(samples, closed) {
  const count = samples.length;
  const segmentCount = closed ? count : count - 1;
  const lengths = [];
  let total = 0;
  for (let index = 0; index < segmentCount; index += 1) {
    const length = distance(samples[index], samples[(index + 1) % count]);
    lengths.push(length);
    total += length;
  }
  const at = [0];
  for (let index = 0; index < segmentCount; index += 1) at.push(at[index] + lengths[index]);
  return { segmentCount, lengths, total, at };
}

function turnRadians(previous, current, next) {
  const ax = current.x - previous.x;
  const ay = current.y - previous.y;
  const az = current.z - previous.z;
  const bx = next.x - current.x;
  const by = next.y - current.y;
  const bz = next.z - current.z;
  const left = Math.hypot(ax, ay, az);
  const right = Math.hypot(bx, by, bz);
  if (left < 1e-8 || right < 1e-8) return Math.PI;
  const dot = (ax * bx + ay * by + az * bz) / (left * right);
  return Math.acos(Math.max(-1, Math.min(1, dot)));
}

function circumradiusXZ(a, b, c) {
  const ab = Math.hypot(b.x - a.x, b.z - a.z);
  const bc = Math.hypot(c.x - b.x, c.z - b.z);
  const ca = Math.hypot(a.x - c.x, a.z - c.z);
  const area2 = Math.abs((b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z));
  if (area2 < 1e-8) return Infinity;
  return (ab * bc * ca) / (2 * area2);
}

// XZ contact between segments AB and CD, endpoints included: a proper
// crossing, or an endpoint of one within touchGap of the other segment
// (which covers a vertex on another segment's interior and collinear overlap).
// t and u are the contact's parameters along AB and CD.
function contact(a, b, c, d, touchGap) {
  const rx = b.x - a.x;
  const rz = b.z - a.z;
  const sx = d.x - c.x;
  const sz = d.z - c.z;
  const denom = rx * sz - rz * sx;
  let hit = null;
  if (Math.abs(denom) >= 1e-9) {
    const qpx = c.x - a.x;
    const qpz = c.z - a.z;
    const t = (qpx * sz - qpz * sx) / denom;
    const u = (qpx * rz - qpz * rx) / denom;
    const edge = 1e-9;
    if (t >= -edge && t <= 1 + edge && u >= -edge && u <= 1 + edge) {
      hit = { t: Math.max(0, Math.min(1, t)), u: Math.max(0, Math.min(1, u)) };
    }
  }
  if (!hit) {
    const ends = [
      [a, c, d, (u) => ({ t: 0, u })],
      [b, c, d, (u) => ({ t: 1, u })],
      [c, a, b, (t) => ({ t, u: 0 })],
      [d, a, b, (t) => ({ t, u: 1 })],
    ];
    for (const [point, from, to, place] of ends) {
      const approach = nearestApproach(point, from, to);
      if (approach.horizontal <= touchGap) {
        hit = place(approach.t);
        break;
      }
    }
  }
  if (!hit) return null;
  return {
    t: hit.t,
    u: hit.u,
    yA: a.y + hit.t * (b.y - a.y),
    yB: c.y + hit.u * (d.y - c.y),
  };
}

function nearestApproach(point, a, b) {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const ab2 = abx * abx + abz * abz;
  let t = 0;
  if (ab2 > 0) {
    t = ((point.x - a.x) * abx + (point.z - a.z) * abz) / ab2;
    t = Math.max(0, Math.min(1, t));
  }
  const x = a.x + abx * t;
  const z = a.z + abz * t;
  const y = a.y + (b.y - a.y) * t;
  return {
    t,
    horizontal: Math.hypot(point.x - x, point.z - z),
    vertical: Math.abs(point.y - y),
  };
}

function declaredCrossing(course, sA, sB, tolerance) {
  const pairs = Array.isArray(course.crossings) ? course.crossings : [];
  return pairs.some((pair) => {
    if (!pair || !Number.isFinite(pair.sA) || !Number.isFinite(pair.sB)) return false;
    const forward = Math.abs(pair.sA - sA) <= tolerance && Math.abs(pair.sB - sB) <= tolerance;
    const reverse = Math.abs(pair.sA - sB) <= tolerance && Math.abs(pair.sB - sA) <= tolerance;
    return forward || reverse;
  });
}

function pushFinding(findings, counts, limits, finding) {
  const count = counts[finding.kind] || 0;
  counts[finding.kind] = count + 1;
  if (count < limits.maxFindingsPerKind) findings.push(finding);
}

/**
 * Validate a course polyline.
 * @param {{
 *   samples: Array<{ x: number, y: number, z: number }>,
 *   closed?: boolean,
 *   halfWidth: number,
 *   scenery?: Array<{ x: number, y: number, z: number }>,
 *   crossings?: Array<{ sA: number, sB: number }>,
 * }} course
 * @param {object} [limits]
 * @returns {{ ok: boolean, length: number, findings: Array<{ kind: string, s: number, detail: string, accepted?: boolean }> }}
 */
export function validateCourse(course, limits = {}) {
  if (!course || !Array.isArray(course.samples)) fail("course.samples must be an array");
  const samples = course.samples;
  if (samples.length < 2) fail("course.samples needs at least two points");
  for (let index = 0; index < samples.length; index += 1) {
    if (!isPoint(samples[index])) fail(`sample ${index} needs finite x, y, z`);
  }
  if (!Number.isFinite(course.halfWidth)) fail("course.halfWidth must be finite");
  const closed = Boolean(course.closed);
  const resolved = { ...DEFAULT_LIMITS, ...limits };
  const fitHalfWidth = Number.isFinite(resolved.fitHalfWidth) ? resolved.fitHalfWidth : course.halfWidth;
  const measured = measure(samples, closed);
  const findings = [];
  const counts = {};

  if (course.halfWidth < resolved.minHalfWidth || course.halfWidth > resolved.maxHalfWidth) {
    pushFinding(findings, counts, resolved, {
      kind: "width-limit",
      s: 0,
      detail: `paved half-width ${course.halfWidth} is outside ${resolved.minHalfWidth}..${resolved.maxHalfWidth}`,
    });
  }

  const firstVertex = closed ? 0 : 1;
  const lastVertex = closed ? samples.length : samples.length - 1;
  for (let index = firstVertex; index < lastVertex; index += 1) {
    const previous = samples[(index - 1 + samples.length) % samples.length];
    const current = samples[index];
    const next = samples[(index + 1) % samples.length];
    const s = measured.at[index] ?? 0;
    const turn = turnRadians(previous, current, next);
    if (turn > resolved.cuspTurnRadians) {
      pushFinding(findings, counts, resolved, {
        kind: "cusp",
        s,
        detail: `turn ${(turn * 180 / Math.PI).toFixed(1)} deg`,
      });
    }
    const radius = circumradiusXZ(previous, current, next);
    if (radius < fitHalfWidth) {
      pushFinding(findings, counts, resolved, {
        kind: "width-limit",
        s,
        detail: `bend radius ${radius.toFixed(2)} is inside fit half-width ${fitHalfWidth}`,
      });
    } else if (radius < fitHalfWidth + resolved.curvatureMargin) {
      pushFinding(findings, counts, resolved, {
        kind: "curvature-limit",
        s,
        detail: `bend radius ${radius.toFixed(2)} is inside ${fitHalfWidth} + ${resolved.curvatureMargin}`,
      });
    }
  }

  // Segments that share a sample are adjacent: consecutive segments, plus the
  // closing segment and the first one on a closed course. An open course's
  // first and last segments are not adjacent, so their contact is checked.
  // Several segment pairs can report one contact (a vertex on another segment,
  // or two coincident vertices); contacts at the same pair of stations count once.
  const touchGap = 0.05;
  const sameContact = touchGap * 2;
  const contacts = [];
  for (let left = 0; left < measured.segmentCount; left += 1) {
    for (let right = left + 1; right < measured.segmentCount; right += 1) {
      const linear = right - left;
      const separated = closed ? Math.min(linear, measured.segmentCount - linear) : linear;
      if (separated < 2) continue;
      const a = samples[left];
      const b = samples[(left + 1) % samples.length];
      const c = samples[right];
      const d = samples[(right + 1) % samples.length];
      const hit = contact(a, b, c, d, touchGap);
      if (!hit) continue;
      const sA = measured.at[left] + measured.lengths[left] * hit.t;
      const sB = measured.at[right] + measured.lengths[right] * hit.u;
      if (contacts.some((seen) => Math.abs(seen.sA - sA) <= sameContact && Math.abs(seen.sB - sB) <= sameContact)) continue;
      contacts.push({ sA, sB });
      const vertical = Math.abs(hit.yA - hit.yB);
      const intentional = vertical >= resolved.overpassClearance
        || declaredCrossing(course, sA, sB, resolved.crossingTolerance);
      if (intentional && !resolved.includeAccepted) continue;
      pushFinding(findings, counts, resolved, {
        kind: intentional ? "intentional-crossing" : "accidental-self-intersection",
        s: sA,
        accepted: intentional,
        detail: intentional
          ? `crossing at ${sA.toFixed(2)} and ${sB.toFixed(2)}`
          : `crossing at ${sA.toFixed(2)} and ${sB.toFixed(2)} with vertical gap ${vertical.toFixed(2)}`,
      });
    }
  }

  const scenery = Array.isArray(course.scenery) ? course.scenery : [];
  for (let index = 0; index < scenery.length; index += 1) {
    const item = scenery[index];
    if (!isPoint(item)) fail(`scenery ${index} needs finite x, y, z`);
    let closest = Infinity;
    let at = 0;
    for (let segment = 0; segment < measured.segmentCount; segment += 1) {
      const approach = nearestApproach(item, samples[segment], samples[(segment + 1) % samples.length]);
      if (approach.vertical > resolved.sceneryVertical) continue;
      if (approach.horizontal < closest) {
        closest = approach.horizontal;
        at = measured.at[segment];
      }
    }
    if (closest < course.halfWidth + resolved.sceneryGap) {
      pushFinding(findings, counts, resolved, {
        kind: "scenery-clearance",
        s: at,
        detail: `scenery ${index} is ${closest.toFixed(2)} m from the centerline`,
      });
    }
  }

  if (closed) {
    const closing = measured.lengths[measured.lengths.length - 1];
    const body = measured.lengths.slice(0, -1).sort((left, right) => left - right);
    const median = body[Math.floor(body.length / 2)] || closing;
    const turns = [];
    for (let index = 0; index < samples.length; index += 1) {
      const previous = samples[(index - 1 + samples.length) % samples.length];
      turns.push(turnRadians(previous, samples[index], samples[(index + 1) % samples.length]));
    }
    const orderedTurns = turns.slice().sort((left, right) => left - right);
    const medianTurn = orderedTurns[Math.floor(orderedTurns.length / 2)] || 0;
    const seamTurn = turns[samples.length - 1];
    const gap = closing > median * resolved.seamGapFactor;
    const kink = seamTurn > resolved.seamTurnRadians && seamTurn > medianTurn + 0.4;
    if (gap || kink) {
      pushFinding(findings, counts, resolved, {
        kind: "loop-seam",
        s: measured.at[samples.length - 1] ?? 0,
        detail: `closing ${closing.toFixed(2)} m versus median ${median.toFixed(2)} m, seam turn ${(seamTurn * 180 / Math.PI).toFixed(1)} deg versus median ${(medianTurn * 180 / Math.PI).toFixed(1)} deg`,
      });
    }
  }

  const rejecting = findings.filter((finding) => !finding.accepted);
  return { ok: rejecting.length === 0, length: measured.total, findings };
}

export { DEFAULT_LIMITS };
