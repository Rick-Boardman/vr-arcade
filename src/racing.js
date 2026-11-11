// Race meters increase toward the finish, independently of course travel direction.
// No position projection, physics, clocks, network authority or scoring lives here.
function finite(value, name) {
  if (!Number.isFinite(value)) throw new TypeError(`arcade/racing: ${name} must be finite`);
  return value;
}

function geometry(course) {
  if (!course || course.disposed) throw new Error("arcade/racing: course missing or disposed");
  if (!(finite(course.length, "course.length") > 0) || typeof course.closed !== "boolean") {
    throw new RangeError("arcade/racing: course needs positive length and boolean closed");
  }
  return { length: course.length, closed: course.closed };
}

function modulo(value, length) {
  const remainder = value % length;
  return remainder < 0 ? remainder + length : remainder === 0 ? 0 : remainder;
}

function rules(course, { laps = 1, direction = 1, start } = {}) {
  const { length, closed } = geometry(course);
  if (direction !== 1 && direction !== -1) throw new RangeError("arcade/racing: direction must be 1 or -1");
  if (!Number.isSafeInteger(laps) || laps < 1 || (!closed && laps !== 1)) {
    throw new RangeError("arcade/racing: laps must be a positive safe integer; open courses use 1");
  }
  start ??= closed || direction === 1 ? 0 : length;
  finite(start, "start");
  if (start < 0 || start > length) throw new RangeError("arcade/racing: start outside course");
  const total = closed ? length * laps : direction === 1 ? length - start : start;
  if (!(finite(total, "total distance") > 0)) throw new RangeError("arcade/racing: finish must be beyond start");
  return { length, closed, laps, direction, start, total };
}

function progress(config, distance) {
  finite(distance, "distance");
  const { length, closed, direction, start, total } = config;
  const station = finite(start + direction * distance, "station");
  const completedLaps = finite(closed ? Math.floor(distance / length) : distance >= total ? 1 : 0, "completed laps");
  return {
    distance,
    s: closed ? modulo(station, length) : Math.max(0, Math.min(length, station)),
    completedLaps,
    lapDistance: closed ? modulo(distance, length) : Math.max(0, Math.min(total, distance)),
    fraction: Math.max(0, Math.min(1, distance / total)),
    finished: distance >= total,
    total,
  };
}

/** Pure progress from signed, unwrapped race meters. Negative meters undo laps. */
export function raceProgress(course, distance, options) {
  return progress(rules(course, options), distance);
}

/** Physical along-course separation, ignoring laps; useful independently of race rank. */
export function courseGap(course, firstS, secondS) {
  const { length, closed } = geometry(course);
  finite(firstS, "firstS");
  finite(secondS, "secondS");
  const normalize = closed ? value => modulo(value, length) : value => Math.max(0, Math.min(length, value));
  const gap = Math.abs(normalize(firstS) - normalize(secondS));
  return closed ? Math.min(gap, length - gap) : gap;
}

function identifier(id) {
  if (typeof id !== "string" || !id.length) throw new TypeError("arcade/racing: id must be a nonempty string");
}

function timestamp(time) {
  if (finite(time, "time") < 0) throw new RangeError("arcade/racing: time must be nonnegative");
}

/** Game-driven race ledger. All times share the game's monotonic clock and units. */
export function createRace({ course, tieBreak = () => 0, ...options } = {}) {
  // Snapshot geometry: the race does not own or retain a course's render resources.
  const config = rules(course, options);
  if (typeof tieBreak !== "function") throw new TypeError("arcade/racing: tieBreak must be a function");
  const racers = new Map();

  function lookup(id) {
    identifier(id);
    const racer = racers.get(id);
    if (!racer) throw new Error(`arcade/racing: unknown racer ${id}`);
    return racer;
  }

  function snapshot(racer) {
    return { id: racer.id, ...progress(config, racer.distance), time: racer.time, finishTime: racer.finishTime };
  }

  function compare(a, b) {
    if (a.finished !== b.finished) return a.finished ? -1 : 1;
    const primary = a.finished ? a.finishTime - b.finishTime : b.distance - a.distance;
    if (primary !== 0) return primary;
    const tie = finite(tieBreak({ ...a }, { ...b }), "tieBreak result");
    return tie || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }

  function update(id, { distance, time }) {
    const racer = lookup(id);
    finite(distance, "distance");
    timestamp(time);
    if (time < racer.time) throw new RangeError("arcade/racing: time moved backwards");
    // Validate the whole sample before changing any ledger state.
    progress(config, distance);
    if (racer.finishTime !== null) return snapshot(racer);
    if (distance >= config.total) {
      const remaining = finite(config.total - racer.distance, "remaining distance");
      const movement = finite(distance - racer.distance, "sample movement");
      const ratio = remaining / movement;
      racer.finishTime = racer.time + (time - racer.time) * ratio;
      racer.distance = config.total;
      racer.time = racer.finishTime;
    } else {
      racer.distance = distance;
      racer.time = time;
    }
    return snapshot(racer);
  }

  return {
    add(id, { distance = 0, time = 0 } = {}) {
      identifier(id);
      if (racers.has(id)) throw new Error(`arcade/racing: duplicate racer ${id}`);
      timestamp(time);
      progress(config, distance);
      if (distance >= config.total) throw new RangeError("arcade/racing: add racers before the finish");
      const racer = { id, distance, time, finishTime: null };
      racers.set(id, racer);
      return snapshot(racer);
    },
    update,
    advance(id, { delta, time }) {
      const racer = lookup(id);
      return update(id, { distance: racer.distance + finite(delta, "delta"), time });
    },
    get(id) { return snapshot(lookup(id)); },
    // Positive means first is ahead. Unlike courseGap, this includes whole laps.
    gap(firstId, secondId) { return lookup(firstId).distance - lookup(secondId).distance; },
    standings() {
      const ordered = [...racers.values()].map(snapshot).sort(compare);
      const leader = ordered[0]?.distance ?? 0;
      return ordered.map((racer, index) => ({ ...racer, rank: index + 1, gapToLeader: leader - racer.distance }));
    },
    reset() { racers.clear(); },
  };
}
