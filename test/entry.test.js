import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGameEntry } from '../src/entry.js';

const START = '2026-11-11T15:00:15.000Z';
const START_MS = Date.parse(START);

function clock(start) {
  let time = start;
  const jobs = [];
  let nextId = 1;
  return {
    now: () => time,
    schedule(fn, ms) {
      const id = nextId++;
      jobs.push({ id, at: time + ms, fn });
      return id;
    },
    cancel(id) {
      const index = jobs.findIndex(job => job.id === id);
      if (index >= 0) jobs.splice(index, 1);
    },
    advance(ms) {
      const end = time + ms;
      for (;;) {
        const due = jobs.filter(job => job.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        jobs.splice(jobs.indexOf(due), 1);
        time = due.at;
        due.fn();
      }
      time = end;
    },
    get pending() { return jobs.length; },
  };
}

function table(overrides = {}) {
  return {
    id: 'room-1',
    code: 'ABCD',
    game: 'garbage-can-race',
    seed: 7,
    slots: [
      { index: 0, actor: 'ada', displayName: 'Ada', role: 'player', arrived: true },
      { index: 1, actor: 'bea', displayName: 'Bea', role: 'player', arrived: false },
    ],
    phase: 'loading',
    closed: false,
    startsAt: null,
    ...overrides,
  };
}

function handoff(actor, overrides = {}) {
  const seat = (overrides.table?.slots || table().slots).find(slot => slot.actor === actor);
  const calls = { arrive: 0, read: 0, messages: 0, say: 0, watch: 0, stop: 0 };
  let feed = null;
  const chat = {
    roomId: 'room-1',
    code: 'ABCD',
    messages: () => {
      calls.messages += 1;
      return Promise.resolve(overrides.lines || []);
    },
    say: body => {
      calls.say += 1;
      if (overrides.sayError) return Promise.reject(overrides.sayError);
      return Promise.resolve({ id: 'local', authorUserId: actor, body, createdAt: START });
    },
    watch(callbacks) {
      calls.watch += 1;
      feed = callbacks;
      return () => { calls.stop += 1; feed = null; };
    },
  };
  const adapter = {
    identity: { actor, kind: 'member' },
    table: overrides.table || table(),
    seat: { ...seat },
    chat,
    arrive: () => {
      calls.arrive += 1;
      if (overrides.arriveError) return Promise.reject(overrides.arriveError);
      return Promise.resolve(overrides.arrived || adapter.table);
    },
    read: () => {
      calls.read += 1;
      if (adapter.readError) return Promise.reject(adapter.readError);
      return Promise.resolve(adapter.readTable || adapter.table);
    },
    calls,
    readError: overrides.readError,
    readTable: overrides.readTable,
    emit: event => feed?.event(event),
    snapshot: () => feed?.snapshot(),
    refuse: () => feed?.refused(),
  };
  return adapter;
}

function hooksOf() {
  const seen = { prepare: [], entered: [], countdown: [], start: [], leave: [], failure: [] };
  const hooks = {};
  for (const name of Object.keys(seen)) hooks[name] = payload => seen[name].push(payload);
  return { hooks, seen };
}

function flush() {
  return new Promise(resolve => setImmediate(resolve));
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function entryFor(actor, at, overrides = {}) {
  const timing = clock(at);
  const { hooks, seen } = hooksOf();
  const adapter = handoff(actor, overrides);
  const entry = createGameEntry(adapter, { ...timing, hooks });
  return { entry, adapter, seen, timing };
}

test('the module source does not poll or carry a party client', () => {
  const source = readFileSync(new URL('../src/entry.js', import.meta.url), 'utf8');
  assert.equal(/\b(setInterval|fetch|WebSocket|XMLHttpRequest)\b|\/api\/|authorization|token/.test(source), false);
});

test('prepare is synchronous and enter reports arrival once before the countdown', async () => {
  const { entry, adapter, seen } = entryFor('ada', START_MS - 10_000);
  assert.equal(seen.prepare.length, 1);
  assert.equal(seen.prepare[0].chat.roomId, 'room-1');
  assert.equal(adapter.calls.arrive, 0);
  assert.equal(adapter.calls.watch, 0);
  const entered = entry.enter();
  assert.equal(adapter.calls.watch, 1);
  assert.equal(adapter.calls.arrive, 1);
  await entered;
  assert.equal(seen.entered.length, 1);
  assert.equal(seen.entered[0].seat.actor, 'ada');
  assert.equal(seen.countdown.length, 0);
  await assert.rejects(entry.enter(), /enter already called/);
  assert.equal(adapter.calls.arrive, 1);
});

test('every player starts from one common startsAt and duplicate notices do not restart', async () => {
  const ada = entryFor('ada', START_MS - 5_000);
  const bea = entryFor('bea', START_MS - 5_000);
  await ada.entry.enter();
  await bea.entry.enter();
  const event = { kind: 'countdown', code: 'ABCD', startsAt: START, seed: 7 };
  ada.adapter.emit(event);
  ada.adapter.emit(event);
  ada.adapter.emit({ ...event });
  bea.adapter.emit(event);
  assert.deepEqual(ada.seen.countdown.map(item => item.startsAt), [START]);
  assert.deepEqual(bea.seen.countdown.map(item => item.startsAt), [START]);
  assert.equal(ada.seen.countdown[0].late, false);
  assert.equal(ada.seen.start.length, 0);
  assert.equal(bea.seen.start.length, 0);
  ada.timing.advance(4_999);
  bea.timing.advance(4_999);
  assert.equal(ada.seen.start.length, 0);
  ada.timing.advance(1);
  bea.timing.advance(1);
  assert.deepEqual(ada.seen.start, [{ startsAt: START, startsAtMs: START_MS }]);
  assert.deepEqual(bea.seen.start, [{ startsAt: START, startsAtMs: START_MS }]);
  ada.adapter.emit({ kind: 'countdown', code: 'ABCD', startsAt: '2026-11-11T15:00:20.000Z', seed: 7 });
  ada.timing.advance(10_000);
  assert.equal(ada.seen.start.length, 1);
  assert.equal(ada.adapter.calls.read, 0);
});

test('a late countdown starts immediately and a snapshot reads the table once', async () => {
  const { entry, adapter, seen } = entryFor('ada', START_MS + 50);
  await entry.enter();
  adapter.emit({ kind: 'countdown', code: 'ABCD', startsAt: START, seed: 7 });
  assert.equal(seen.countdown[0].late, true);
  assert.deepEqual(seen.start, [{ startsAt: START, startsAtMs: START_MS }]);
  adapter.snapshot();
  adapter.snapshot();
  await flush();
  assert.equal(adapter.calls.read, 2);
  assert.equal(seen.start.length, 1);
});

test('a failed snapshot read is reported and not retried', async () => {
  const readError = new Error('read failed');
  const { entry, adapter, seen } = entryFor('ada', START_MS, { readError });
  await entry.enter();
  adapter.snapshot();
  await flush();
  adapter.emit({ kind: 'countdown', code: 'ABCD', startsAt: START, seed: 7 });
  assert.equal(adapter.calls.read, 1);
  assert.equal(seen.failure.length, 1);
  assert.equal(seen.failure[0], readError);
  assert.equal(seen.start.length, 1);
});

test('arrival failure is reported once and not retried', async () => {
  const arriveError = new Error('arrive failed');
  const { entry, adapter, seen } = entryFor('ada', START_MS, { arriveError });
  await assert.rejects(entry.enter(), error => error === arriveError);
  await assert.rejects(entry.enter(), /enter already called/);
  assert.equal(adapter.calls.arrive, 1);
  assert.deepEqual(seen.failure, [arriveError]);
  assert.equal(seen.entered.length, 0);
  assert.equal(seen.start.length, 0);
});

test('cancellation, leave and disposal do not start the race', async () => {
  const first = entryFor('ada', START_MS - 1_000);
  await first.entry.enter();
  first.adapter.emit({ kind: 'countdown', code: 'ABCD', startsAt: START, seed: 7 });
  first.adapter.emit({ kind: 'countdown-cancelled', code: 'ABCD' });
  first.adapter.emit({ kind: 'countdown-cancelled', code: 'ABCD' });
  assert.equal(first.seen.countdown.at(-1).cancelled, true);
  first.timing.advance(5_000);
  assert.equal(first.seen.start.length, 0);

  const second = entryFor('bea', START_MS - 1_000);
  await second.entry.enter();
  second.adapter.emit({ kind: 'countdown', code: 'ABCD', startsAt: START, seed: 7 });
  second.entry.leave();
  second.entry.leave();
  second.timing.advance(5_000);
  assert.deepEqual(second.seen.leave.map(item => item.reason), ['leave']);
  assert.equal(second.seen.start.length, 0);
  assert.equal(second.adapter.calls.stop, 1);

  const third = entryFor('ada', START_MS - 1_000);
  await third.entry.enter();
  third.adapter.emit({ kind: 'countdown', code: 'ABCD', startsAt: START, seed: 7 });
  third.entry.dispose();
  third.entry.dispose();
  third.timing.advance(5_000);
  assert.deepEqual(third.seen.leave.map(item => item.reason), ['disposed']);
  assert.equal(third.seen.start.length, 0);
  assert.equal(third.adapter.calls.stop, 1);
  await assert.rejects(third.entry.enter(), /disposed/);
  assert.throws(() => third.entry.transport.subscribe(() => {}), /disposed/);
});

test('closed, unseated and refused watches leave without another subscription', async () => {
  const closed = entryFor('ada', START_MS);
  await closed.entry.enter();
  closed.adapter.emit({ kind: 'closed', reason: 'host' });
  closed.adapter.emit({ kind: 'closed', reason: 'host' });
  assert.deepEqual(closed.seen.leave.map(item => item.reason), ['closed']);
  assert.equal(closed.adapter.calls.watch, 1);
  assert.equal(closed.adapter.calls.stop, 1);

  const gone = entryFor('bea', START_MS);
  await gone.entry.enter();
  gone.adapter.emit({ kind: 'left', actor: 'bea' });
  assert.equal(gone.seen.leave[0].reason, 'left');

  const refused = entryFor('ada', START_MS);
  await refused.entry.enter();
  refused.adapter.refuse();
  assert.equal(refused.seen.failure[0].message, 'arcade/entry: socket refused');
  assert.equal(refused.seen.leave[0].reason, 'refused');
  assert.equal(refused.adapter.calls.watch, 1);
});

test('racing without a shared startsAt is reported and does not invent one', async () => {
  const { entry, adapter, seen } = entryFor('ada', START_MS);
  await entry.enter();
  adapter.emit({ kind: 'instance', room: table({ phase: 'racing', startsAt: null, slots: table().slots.map(slot => ({ ...slot, arrived: true })) }) });
  assert.equal(seen.failure[0].message, 'arcade/entry: racing without a common startsAt');
  assert.equal(seen.start.length, 0);
  assert.equal(seen.countdown.length, 0);
});

test('chat transport follows the socket, ignores duplicate lines, and names seats', async () => {
  const line = { id: 'm1', authorUserId: 'bea', body: 'ready', createdAt: START };
  const { entry, adapter } = entryFor('ada', START_MS, { lines: [line] });
  const seen = [];
  await entry.enter();
  const stop = entry.transport.subscribe(payload => seen.push(payload));
  assert.equal(seen[0].status, 'connecting');
  assert.equal(entry.transport.nameFor('bea'), 'Bea');
  adapter.emit({ kind: 'message', message: line });
  adapter.emit({ kind: 'message', message: line });
  adapter.snapshot();
  await flush();
  const live = seen.at(-1);
  assert.equal(live.status, 'live');
  assert.deepEqual(live.messages, [line]);
  assert.equal(live.watching, 2);
  assert.equal(typeof seen[0].watching, 'number');
  assert.equal(live.hasMore, false);
  const before = seen.length;
  adapter.emit({ kind: 'instance', room: { code: 'ABCD', slots: [
    { index: 0, actor: 'ada', displayName: 'Ada', role: 'player', arrived: true },
    { index: 1, actor: null, displayName: '', role: 'player', arrived: false },
  ] } });
  assert.equal(seen.length, before + 1);
  assert.equal(seen.at(-1).watching, 1);
  stop();
  adapter.emit({ kind: 'message', message: { id: 'm2', authorUserId: 'ada', body: 'go', createdAt: START } });
  assert.equal(seen.at(-1).messages.length, 1);
});

test('a stale loading read does not erase the common startsAt', async () => {
  let release;
  const arrived = new Promise(resolve => { release = resolve; });
  const ada = entryFor('ada', START_MS - 1000, { arrived });
  const pending = ada.entry.enter();
  ada.adapter.emit({ kind: 'countdown', code: 'ABCD', startsAt: START, seed: 7 });
  release(table());
  await pending;
  assert.deepEqual(ada.seen.countdown.map(item => item.startsAt), [START]);
  ada.adapter.readTable = table({ phase: 'loading', startsAt: null });
  ada.adapter.snapshot();
  await flush();
  ada.timing.advance(1000);
  assert.deepEqual(ada.seen.start, [{ startsAt: START, startsAtMs: START_MS }]);
  assert.equal(ada.seen.countdown.filter(item => item.cancelled).length, 0);
});

test('a watch that throws is reported and arrive is not attempted', async () => {
  const { hooks, seen } = hooksOf();
  const adapter = handoff('ada');
  const watchError = new Error('watch failed');
  adapter.chat.watch = () => { throw watchError; };
  const entry = createGameEntry(adapter, { ...clock(START_MS), hooks });
  await assert.rejects(entry.enter(), error => error === watchError);
  assert.equal(adapter.calls.arrive, 0);
  assert.deepEqual(seen.failure, [watchError]);
  await assert.rejects(entry.enter(), /enter already called/);
});

test('unsuccessful arrivals stop once and ignore retained watch callbacks and pending reads', async () => {
  for (const mode of ['throw', 'reject', 'invalid']) {
    const { entry, adapter, seen, timing } = entryFor('ada', START_MS - 1000);
    const arrival = deferred();
    const read = deferred();
    const error = new Error(`arrival ${mode}`);
    let callbacks;
    const watch = adapter.chat.watch;
    adapter.chat.watch = feed => { callbacks = feed; return watch(feed); };
    adapter.read = () => read.promise;
    adapter.arrive = () => {
      if (mode === 'throw') throw error;
      return arrival.promise;
    };
    const pending = entry.enter();
    const rejected = assert.rejects(pending, mode === 'invalid' ? /arrive returned no table/ : error);
    callbacks.snapshot();
    callbacks.event({ kind: 'countdown', code: 'ABCD', startsAt: START });
    if (mode === 'reject') arrival.reject(error);
    if (mode === 'invalid') arrival.resolve(null);
    await rejected;
    read.resolve(table({ phase: 'counting', startsAt: START }));
    callbacks.event({ kind: 'countdown', code: 'ABCD', startsAt: START });
    callbacks.status('live');
    callbacks.refused();
    await flush();
    timing.advance(5000);
    assert.equal(entry.state.phase, 'failed');
    assert.equal(seen.failure.length, 1);
    assert.equal(seen.entered.length, 0);
    assert.equal(seen.start.length, 0);
    assert.equal(seen.countdown.length, 0);
    assert.equal(adapter.calls.stop, 1);
    assert.equal(timing.pending, 0);
    entry.dispose();
    entry.dispose();
    assert.equal(adapter.calls.stop, 1);
  }
});

test('older arrival and snapshot responses cannot undo socket cancellation or a newer countdown', async () => {
  const later = '2026-11-11T15:00:20.000Z';
  for (const source of ['arrival', 'snapshot']) {
    for (const change of ['cancel', 'reschedule']) {
      const response = deferred();
      const { entry, adapter, seen, timing } = entryFor('ada', START_MS - 1000);
      let pending;
      if (source === 'arrival') {
        adapter.arrive = () => response.promise;
        pending = entry.enter();
      } else {
        await entry.enter();
        adapter.read = () => response.promise;
        adapter.snapshot();
        await flush();
      }
      adapter.emit({ kind: 'countdown', startsAt: START });
      adapter.emit(change === 'cancel'
        ? { kind: 'countdown-cancelled' }
        : { kind: 'countdown', startsAt: later });
      response.resolve(table({ phase: 'counting', startsAt: START }));
      await pending;
      await flush();
      timing.advance(1000);
      assert.equal(seen.start.length, 0);
      assert.equal(entry.state.startsAt, change === 'cancel' ? null : later);
      timing.advance(5000);
      assert.equal(seen.start.length, change === 'cancel' ? 0 : 1);
      assert.equal(seen.entered.length, 1);
      entry.dispose();
    }
  }
});

test('overlapping table reads prefer the newest request regardless of completion order', async () => {
  for (const order of [[0, 1], [1, 0]]) {
    const { entry, adapter, seen, timing } = entryFor('ada', START_MS - 1000);
    await entry.enter();
    const reads = [deferred(), deferred()];
    let index = 0;
    adapter.read = () => reads[index++].promise;
    adapter.snapshot();
    adapter.snapshot();
    await flush();
    for (const i of order) {
      reads[i].resolve(i === 0 ? table({ phase: 'counting', startsAt: START }) : table({ phase: 'waiting' }));
      await flush();
    }
    timing.advance(5000);
    assert.equal(seen.start.length, 0);
    assert.equal(entry.state.startsAt, null);
    entry.dispose();
  }
});

test('delayed and overlapping transcripts retain live messages in chronological order', async () => {
  const { entry, adapter } = entryFor('ada', START_MS);
  await entry.enter();
  const responses = [deferred(), deferred(), deferred()];
  let index = 0;
  adapter.chat.messages = () => responses[index++].promise;
  let latest;
  entry.transport.subscribe(payload => { latest = payload; });
  adapter.snapshot();
  await flush();
  adapter.snapshot();
  await flush();
  const line = (id, createdAt) => ({ id, createdAt, authorUserId: 'ada', body: id });
  const recent = line('new', '2026-11-11T15:00:20.000Z');
  const old = line('old', START);
  adapter.emit({ kind: 'message', message: recent });
  responses[1].resolve([recent, old]);
  await flush();
  responses[0].resolve([]);
  await flush();
  assert.deepEqual(latest.messages, [old, recent]);
  adapter.snapshot();
  await flush();
  const newest = line('newest', '2026-11-11T15:00:25.000Z');
  adapter.emit({ kind: 'message', message: newest });
  responses[2].resolve([old, recent]);
  await flush();
  assert.deepEqual(latest.messages, [old, recent, newest]);
  entry.dispose();
});
