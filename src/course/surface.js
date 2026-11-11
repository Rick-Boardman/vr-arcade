import { buildRibbonSurfaceGeometry, createHorizontalCurveNormal } from "@rb/halo/curve-surface";
import { sampleCourse } from "./layout.js";

function crossSection(point, tangent, halfWidth) {
  const normal = createHorizontalCurveNormal(tangent);
  return {
    leftPoint: {
      x: point.x - normal.x * halfWidth,
      y: point.y,
      z: point.z - normal.z * halfWidth,
    },
    rightPoint: {
      x: point.x + normal.x * halfWidth,
      y: point.y,
      z: point.z + normal.z * halfWidth,
    },
  };
}

function ribbonGeometry(course, segmentCount) {
  const edgePairs = [];
  for (let index = 0; index <= segmentCount; index += 1) {
    const { position, forward } = sampleCourse(course, index / segmentCount * course.length);
    edgePairs.push(crossSection(position, forward, course.halfWidth));
  }
  return buildRibbonSurfaceGeometry(edgePairs, { closed: course.closed });
}

/** Allocate the paved ribbon on Halo's shared Three.js geometry with the course topology. */
export function buildCourseSurface(course, { segmentCount = 64 } = {}) {
  if (!course || course.disposed) throw new Error("arcade/course: disposed");
  const count = segmentCount | 0;
  if (count < 2 || count > 2048) throw new RangeError("arcade/course: segmentCount must be from 2 to 2048");
  if (course.surface && course.surface.geometry && typeof course.surface.geometry.dispose === "function") {
    course.surface.geometry.dispose();
  }
  const geometry = ribbonGeometry(course, course.closed ? Math.max(3, count) : count);
  course.surface = { geometry };
  return course.surface;
}

/** Dispose the ribbon geometry. A second call does nothing. Sampling after disposal throws. */
export function disposeCourse(course) {
  if (!course || course.disposed) return;
  const geometry = course.surface && course.surface.geometry;
  if (geometry && typeof geometry.dispose === "function") geometry.dispose();
  course.surface = null;
  course.disposed = true;
}

