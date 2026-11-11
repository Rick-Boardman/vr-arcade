// Enter a game from Magna's released handoff. The application injects that handoff.
// This module does not open sockets, name endpoints, or choose a start instant.

const TABLE_EVENTS = new Set(['countdown', 'countdown-cancelled', 'instance', 'joined', 'left', 'closed', 'dropped']);

function fail(message) {
  return new Error(`arcade/entry: ${message}`);
}

function copy(value) {
  if (Array.isArray(value)) return value.map(copy);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]));
}

function callHook(hooks, name, payload) {
  const hook = hooks[name];
  if (typeof hook !== 'function') return;
  try {
    hook(payload);
  } catch (error) {
    if (name === 'failure') throw error;
    reportFailure(hooks, error);
    throw error;
  }
}

const reportedFailures = new WeakSet();

function reportFailure(hooks, error) {
  if (typeof hooks.failure !== 'function' || !error || reportedFailures.has(error)) return;
  reportedFailures.add(error);
  hooks.failure(error);
}

function requireText(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw fail(`${name} must be a nonempty string`);
  return value;
}

function parseStarts(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function validate(adapter) {
  if (!adapter || typeof adapter !== 'object') throw fail('adapter is required');
  const identity = adapter.identity;
  if (!identity || typeof identity !== 'object') throw fail('identity is required');
  requireText(identity.actor, 'identity.actor');
  const table = adapter.table;
  if (!table || typeof table !== 'object') throw fail('table is required');
  requireText(table.code, 'table.code');
  if (!Number.isSafeInteger(table.seed)) throw fail('table.seed must be a safe integer');
  if (!Array.isArray(table.slots)) throw fail('table.slots must be an array');
  const seat = adapter.seat;
  if (!seat || typeof seat !== 'object') throw fail('seat is required');
  if (!Number.isSafeInteger(seat.index)) throw fail('seat.index must be a safe integer');
  if (seat.actor !== identity.actor) throw fail('seat.actor must be this player');
  if (!table.slots.some(slot => slot && slot.actor === identity.actor && slot.index === seat.index)) {
    throw fail('table.slots must include this seat');
  }
  if (parseStarts(table.startsAt) === undefined) throw fail('table.startsAt must be an ISO time or empty');
  const chat = adapter.chat;
  if (!chat || typeof chat !== 'object') throw fail('chat is required');
  requireText(chat.roomId, 'chat.roomId');
  requireText(chat.code, 'chat.code');
  if (typeof chat.messages !== 'function' || typeof chat.say !== 'function' || typeof chat.watch !== 'function') {
    throw fail('chat.messages, chat.say and chat.watch are required');
  }
  if (typeof adapter.arrive !== 'function' || typeof adapter.read !== 'function') {
    throw fail('arrive and read are required');
  }
  return { identity: copy(identity), table: copy(table), seat: copy(seat), chat };
}

function viewOf(identity, table, seat, chat) {
  return {
    identity: copy(identity),
    table: copy(table),
    seat: copy(seat),
    chat: { roomId: chat.roomId, code: chat.code },
  };
}

/** Lifecycle over one injected Magna handoff. Hooks run at most once per fact. */
export function createGameEntry(adapter, {
  now = () => Date.now(),
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = id => clearTimeout(id),
  hooks = {},
} = {}) {
  const source = validate(adapter);
  const identity = source.identity;
  const chat = adapter.chat;
  let table = source.table;
  let seat = source.seat;
  let phase = 'prepared';
  let announced = undefined;
  let startsAtMs = null;
  let timer = null;
  let stopWatch = null;
  let started = false;
  let left = false;
  let disposed = false;
  let held = false;
  let pendingStart = false;
  let pendingLeave = null;
  let missingStart = false;
  let seedMismatch = false;
  let tableRevision = 0;
  let tableRequest = 0;
  const messages = [];
  const listeners = new Set();
  let status = 'connecting';

  function inactive() {
    return left || disposed || phase === 'failed';
  }

  function stopResources() {
    clearTimer();
    const stop = stopWatch;
    stopWatch = null;
    if (typeof stop === 'function') {
      try { stop(); } catch (error) { reportFailure(hooks, error); }
    }
  }

  function failEntry(error) {
    phase = 'failed';
    held = false;
    pendingStart = false;
    pendingLeave = null;
    stopResources();
    reportFailure(hooks, error);
  }

  function live() {
    if (disposed) throw fail('disposed');
  }

  function seatFromTable() {
    const next = table.slots.find(slot => slot && slot.actor === identity.actor);
    if (next) seat = copy(next);
    return next;
  }

  // Halo's chat panel reads `watching` as a head count ("2 here"): the seated players at this table.
  function seated() {
    return table.slots.filter(slot => slot && typeof slot.actor === 'string' && slot.actor.length > 0).length;
  }

  function chatView() {
    return {
      messages: messages.map(line => ({ ...line })),
      status,
      watching: seated(),
      hasMore: false,
    };
  }

  function publishChat() {
    const payload = chatView();
    for (const listener of [...listeners]) listener(payload);
  }

  function rememberLine(line) {
    if (!line || typeof line !== 'object' || typeof line.id !== 'string' || line.id.length === 0) return false;
    if (messages.some(item => item.id === line.id)) return false;
    messages.push({
      id: line.id,
      authorUserId: typeof line.authorUserId === 'string' ? line.authorUserId : '',
      body: typeof line.body === 'string' ? line.body : '',
      createdAt: typeof line.createdAt === 'string' ? line.createdAt : '',
    });
    messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return true;
  }

  function mergeLines(lines) {
    if (!Array.isArray(lines)) {
      reportFailure(hooks, fail('messages must be an array'));
      return;
    }
    for (const line of lines) rememberLine(line);
    publishChat();
  }

  function clearTimer() {
    if (timer == null) return;
    cancel(timer);
    timer = null;
  }

  function arm(ms) {
    if (inactive() || phase !== 'entered') return;
    clearTimer();
    const delay = ms - now();
    if (delay <= 0) {
      begin();
      return;
    }
    timer = schedule(() => {
      timer = null;
      if (now() < ms) arm(ms);
      else begin();
    }, delay);
  }

  function begin() {
    if (started || inactive() || phase !== 'entered' || announced == null || startsAtMs == null) return;
    if (now() < startsAtMs) {
      arm(startsAtMs);
      return;
    }
    started = true;
    phase = 'started';
    clearTimer();
    callHook(hooks, 'start', { startsAt: announced, startsAtMs });
  }

  function emitCountdown() {
    if (announced == null) {
      clearTimer();
      startsAtMs = null;
      callHook(hooks, 'countdown', { startsAt: null, startsAtMs: null, late: false, cancelled: true });
      return;
    }
    const late = now() >= startsAtMs;
    callHook(hooks, 'countdown', { startsAt: announced, startsAtMs, late, cancelled: false });
    if (!inactive() && phase === 'entered') arm(startsAtMs);
  }

  function considerStarts(startsAt) {
    if (started || inactive()) return;
    const key = startsAt || null;
    if (announced === key) return;
    if (key == null) {
      if (announced === undefined) {
        announced = null;
        return;
      }
      announced = null;
      if (held) {
        pendingStart = true;
        return;
      }
      emitCountdown();
      return;
    }
    const ms = parseStarts(key);
    if (ms == null) {
      clearTimer();
      announced = key;
      startsAtMs = null;
      reportFailure(hooks, fail('startsAt is not a time'));
      return;
    }
    announced = key;
    startsAtMs = ms;
    if (held) {
      pendingStart = true;
      return;
    }
    emitCountdown();
  }

  function noteMissingStart() {
    if (missingStart || started || left) return;
    if ((table.phase === 'racing' || table.phase === 'counting') && !table.startsAt) {
      missingStart = true;
      reportFailure(hooks, fail('racing without a common startsAt'));
    }
  }

  function requestLeave(reason) {
    if (inactive()) return;
    if (held) {
      pendingLeave = pendingLeave || reason;
      return;
    }
    finish(reason);
  }

  function finish(reason) {
    if (left) return;
    left = true;
    phase = 'left';
    stopResources();
    callHook(hooks, 'leave', { reason });
  }

  function adoptTable(next) {
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      reportFailure(hooks, fail('table update is not an object'));
      return;
    }
    if (next.code != null && next.code !== table.code) return;
    if (next.closed === true) {
      table = { ...table, ...copy(next), code: table.code };
      requestLeave('closed');
      return;
    }
    const previousStarts = table.startsAt;
    const previousSeated = seated();
    table = { ...table, ...copy(next), code: table.code };
    // A stale loading read must not wipe a countdown the socket already delivered.
    if (!next.startsAt && previousStarts && next.phase !== 'waiting') table.startsAt = previousStarts;
    if (next.phase === 'waiting') table.startsAt = null;
    if (!Array.isArray(table.slots)) table.slots = [];
    if (!seatFromTable()) {
      requestLeave('unseated');
      return;
    }
    if (seated() !== previousSeated) publishChat();
    noteMissingStart();
    considerStarts(table.startsAt);
  }

  function onEvent(event) {
    if (inactive() || !event || typeof event !== 'object') return;
    if (event.kind === 'message') {
      if (rememberLine(event.message)) publishChat();
      return;
    }
    if (!TABLE_EVENTS.has(event.kind)) return;
    if (event.code != null && event.code !== table.code) return;
    tableRevision += 1;
    if (event.kind === 'countdown') {
      table = { ...table, phase: 'counting', startsAt: event.startsAt ?? null };
      if (event.seed != null && Number(event.seed) !== table.seed) {
        if (!seedMismatch) {
          seedMismatch = true;
          reportFailure(hooks, fail('countdown seed does not match the table'));
        }
      }
      considerStarts(table.startsAt);
      return;
    }
    if (event.kind === 'countdown-cancelled') {
      table = { ...table, phase: 'waiting', startsAt: null };
      considerStarts(null);
      return;
    }
    if (event.kind === 'instance') {
      adoptTable(event.room);
      return;
    }
    if (event.kind === 'joined' && Array.isArray(event.slots)) {
      adoptTable({ ...table, slots: event.slots });
      return;
    }
    if (event.kind === 'left' && event.actor === identity.actor) {
      requestLeave('left');
      return;
    }
    if (event.kind === 'dropped' && event.slot === seat.index) {
      requestLeave('dropped');
      return;
    }
    if (event.kind === 'closed') requestLeave('closed');
  }

  function onSnapshot() {
    if (inactive()) return;
    const revision = tableRevision;
    const request = ++tableRequest;
    Promise.resolve().then(() => inactive() ? null : adapter.read()).then(next => {
      if (inactive()) return;
      if (revision === tableRevision && request === tableRequest) adoptTable(next);
      if (inactive()) return;
      status = 'live';
      return adapter.chat.messages();
    }).then(lines => {
      if (inactive() || lines == null) return;
      mergeLines(lines);
    }).catch(error => {
      if (!inactive()) reportFailure(hooks, error);
    });
  }

  function onStatus(next) {
    if (inactive()) return;
    if (typeof next === 'string' && next.length) {
      status = next;
      publishChat();
    }
  }

  function onRefused() {
    if (inactive()) return;
    status = 'offline';
    publishChat();
    reportFailure(hooks, fail('socket refused'));
    requestLeave('refused');
  }

  const transport = {
    subscribe(listener) {
      live();
      if (typeof listener !== 'function') throw fail('listener must be a function');
      listeners.add(listener);
      listener(chatView());
      return () => listeners.delete(listener);
    },
    send(text) {
      live();
      return Promise.resolve().then(() => chat.say(text));
    },
    nameFor(authorUserId) {
      const match = table.slots.find(slot => slot && slot.actor === authorUserId);
      return match && typeof match.displayName === 'string' ? match.displayName : '';
    },
  };

  const api = {
    transport,
    enter() {
      if (disposed) return Promise.reject(fail('disposed'));
      if (phase !== 'prepared') return Promise.reject(fail('enter already called'));
      phase = 'entering';
      held = true;
      const revision = tableRevision;
      const request = ++tableRequest;
      try {
        stopWatch = chat.watch({ event: onEvent, snapshot: onSnapshot, status: onStatus, refused: onRefused });
      } catch (error) {
        failEntry(error);
        return Promise.reject(error);
      }
      if (typeof stopWatch !== 'function') {
        const error = fail('watch must return an unsubscribe function');
        failEntry(error);
        return Promise.reject(error);
      }
      let arrival;
      try {
        arrival = adapter.arrive();
      } catch (error) {
        failEntry(error);
        return Promise.reject(error);
      }
      return Promise.resolve(arrival).then(returned => {
        held = false;
        if (left || disposed) return viewOf(identity, table, seat, chat);
        if (pendingLeave) {
          const reason = pendingLeave;
          pendingLeave = null;
          finish(reason);
          throw fail(`left during entry (${reason})`);
        }
        if (!returned || typeof returned !== 'object' || Array.isArray(returned)) {
          const error = fail('arrive returned no table');
          throw error;
        }
        held = true;
        if (revision === tableRevision && request === tableRequest) adoptTable(returned);
        const leaveNow = pendingLeave;
        pendingLeave = null;
        held = false;
        if (leaveNow) {
          finish(leaveNow);
          throw fail(`left during entry (${leaveNow})`);
        }
        phase = 'entered';
        callHook(hooks, 'entered', viewOf(identity, table, seat, chat));
        if (pendingStart) {
          pendingStart = false;
          emitCountdown();
        }
        return viewOf(identity, table, seat, chat);
      }).catch(error => {
        held = false;
        if (!inactive()) failEntry(error);
        else reportFailure(hooks, error);
        throw error;
      });
    },
    leave() {
      live();
      finish('leave');
    },
    dispose() {
      if (disposed) return;
      finish('disposed');
      disposed = true;
      listeners.clear();
    },
    get state() {
      return {
        phase, started, left, disposed,
        startsAt: announced === undefined ? null : announced,
      };
    },
  };

  callHook(hooks, 'prepare', viewOf(identity, table, seat, chat));
  return api;
}
