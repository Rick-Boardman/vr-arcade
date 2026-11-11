import { buildRoadSurfaceGeometry, createHorizontalCurveNormal } from "@rb/halo/curve-surface";
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
    leftNormal: { x: 0, y: 1, z: 0 },
    rightNormal: { x: 0, y: 1, z: 0 },
  };
}

function ribbonGeometry(course, segmentCount) {
  const built = buildRoadSurfaceGeometry({
    curve: {
      getPointAt(progress) {
        return sampleCourse(course, progress * course.length).position;
      },
    },
    segmentCount,
    createRoadCrossSection({ point, nextPoint }) {
      return crossSection(point, {
        x: nextPoint.x - point.x,
        z: nextPoint.z - point.z,
      }, course.halfWidth);
    },
  });
  return built.geometry;
}

function writeVertex(positions, vertex, point) {
  positions[vertex * 3] = point.x;
  positions[vertex * 3 + 1] = point.y;
  positions[vertex * 3 + 2] = point.z;
}

function repairOpenEnd(course, geometry, segmentCount) {
  const end = sampleCourse(course, course.length).position;
  const before = sampleCourse(course, course.length * ((segmentCount - 1) / segmentCount)).position;
  const section = crossSection(end, { x: end.x - before.x, z: end.z - before.z }, course.halfWidth);
  const positions = geometry.attributes.position.array;
  writeVertex(positions, segmentCount * 2, section.leftPoint);
  writeVertex(positions, segmentCount * 2 + 1, section.rightPoint);
  geometry.attributes.position.needsUpdate = true;
}

function faceUp(geometry) {
  const positions = geometry.attributes.position.array;
  const index = geometry.index.array;
  const ax = positions[index[0] * 3];
  const az = positions[index[0] * 3 + 2];
  const bx = positions[index[1] * 3];
  const bz = positions[index[1] * 3 + 2];
  const cx = positions[index[2] * 3];
  const cz = positions[index[2] * 3 + 2];
  const normalY = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
  if (normalY < 0) {
    for (let offset = 0; offset < index.length; offset += 3) {
      const swap = index[offset + 1];
      index[offset + 1] = index[offset + 2];
      index[offset + 2] = swap;
    }
    geometry.index.needsUpdate = true;
  }
  geometry.computeVertexNormals();
}

/** Allocate the paved ribbon on Halo's shared Three.js geometry. Closed and open paths both start from buildRoadSurfaceGeometry. */
export function buildCourseSurface(course, { segmentCount = 64 } = {}) {
  if (!course || course.disposed) throw new Error("arcade/course: disposed");
  const count = segmentCount | 0;
  if (count < 2 || count > 2048) throw new RangeError("arcade/course: segmentCount must be from 2 to 2048");
  if (course.surface && course.surface.geometry && typeof course.surface.geometry.dispose === "function") {
    course.surface.geometry.dispose();
  }
  const geometry = ribbonGeometry(course, count);
  if (!course.closed) repairOpenEnd(course, geometry, count);
  faceUp(geometry);
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

