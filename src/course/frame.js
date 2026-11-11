// Y-up, right-handed, meters. One travel frame for every course sample.
// Right of travel is (-forward.z, 0, forward.x) on the ground plane.
// Check: forward (0, 0, -1) gives right (1, 0, 0).

const AXIS_EPSILON = 1e-8;

function finiteVector(forward, name) {
  if (!forward || !Number.isFinite(forward.x) || !Number.isFinite(forward.y) || !Number.isFinite(forward.z)) {
    throw new TypeError(`arcade/course: ${name} needs a finite x, y, z`);
  }
  const length = Math.hypot(forward.x, forward.y, forward.z);
  if (length < AXIS_EPSILON) {
    throw new RangeError(`arcade/course: ${name} has no direction`);
  }
  return {
    x: forward.x / length,
    y: forward.y / length,
    z: forward.z / length,
  };
}

/**
 * Travel frame. Positive lateral is right of travel. Up tilts with the road and stays above it.
 * @param {{ x: number, y: number, z: number }} forward Unit travel direction in world meters.
 */
export function frameFromTravel(forward) {
  const unit = finiteVector(forward, "forward");
  const horizontal = Math.hypot(unit.x, unit.z);
  if (horizontal < AXIS_EPSILON) {
    throw new RangeError("arcade/course: forward is vertical");
  }
  const right = { x: -unit.z / horizontal, y: 0, z: unit.x / horizontal };
  const up = {
    x: -right.z * unit.y,
    y: right.z * unit.x - right.x * unit.z,
    z: right.x * unit.y,
  };
  const upLength = Math.hypot(up.x, up.y, up.z) || 1;
  return {
    forward: unit,
    right,
    up: { x: up.x / upLength, y: up.y / upLength, z: up.z / upLength },
  };
}

function horizontalHeading(forward) {
  const unit = finiteVector(forward, "forward");
  if (Math.hypot(unit.x, unit.z) < AXIS_EPSILON) {
    throw new RangeError("arcade/course: forward is vertical");
  }
  return unit;
}

/**
 * Yaw that aims a local -Z nose along the horizontal part of travel.
 * Check: travel (0, 0, -1) is yaw 0. Travel (1, 0, 0) is yaw -π/2.
 * @param {{ x: number, y: number, z: number }} forward
 */
export function garbageCanRaceYaw(forward) {
  const unit = horizontalHeading(forward);
  return Math.atan2(-unit.x, -unit.z);
}

/**
 * Yaw that aims a local +Z nose along the horizontal part of travel.
 * Gravacrest's car in runtime/arcade-track.js uses this Euler Y.
 * Check: travel (0, 0, 1) is yaw 0. Travel (1, 0, 0) is yaw +π/2.
 * @param {{ x: number, y: number, z: number }} forward
 */
export function gravacrestYaw(forward) {
  const unit = horizontalHeading(forward);
  return Math.atan2(unit.x, unit.z);
}
