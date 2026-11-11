import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanDisplayName, nameTagScale, createNameTag, createAppearance, appearanceKey, createRemotePresentation,
} from '../src/presentation.js';

// Minimal Three.js doubles: enough structure to observe parenting, disposal
// and placement without a WebGL context.
class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.set(x, y, z); }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { return this.set(v.x, v.y, v.z); }
}
class Object3D {
  constructor() {
    this.children = []; this.parent = null; this.visible = true; this.name = '';
    this.position = new Vector3(); this.scale = new Vector3(1, 1, 1); this.userData = {};
  }
  add(child) { child.removeFromParent(); child.parent = this; this.children.push(child); return this; }
  removeFromParent() { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; } return this; }
  traverse(fn) { fn(this); for (const child of this.children) child.traverse(fn); }
  updateWorldMatrix() {}
  // World is a pure translation by the ancestors' positions in these doubles.
  worldToLocal(v) { for (let node = this; node; node = node.parent) v.set(v.x - node.position.x, v.y - node.position.y, v.z - node.position.z); return v; }
}
class Disposable { constructor() { this.disposed = 0; } dispose() { this.disposed++; } }
class SpriteMaterial extends Disposable { constructor(params) { super(); Object.assign(this, params); } }
class CanvasTexture extends Disposable { constructor(canvas) { super(); this.image = canvas; } }
class Sprite extends Object3D {
  constructor(material) { super(); this.material = material; this.center = { set: (x, y) => { this.center.x = x; this.center.y = y; } }; }
}
class Box3 {
  constructor() { this.min = new Vector3(); this.max = new Vector3(); this.empty = true; }
  setFromObject(object) {
    const b = object.userData.bounds;
    this.empty = !b;
    if (b) { this.min.copy(b.min); this.max.copy(b.max); }
    return this;
  }
  isEmpty() { return this.empty; }
}
const THREE = { Object3D, Vector3, Sprite, SpriteMaterial, CanvasTexture, Box3, SRGBColorSpace: 'srgb', LinearFilter: 1006 };

class Material extends Disposable {
  constructor(hex = 0) { super(); this.color = { hex, setHex(value) { this.hex = value; } }; }
  clone() { const copy = new Material(this.color.hex); copy.source = this; return copy; }
}
class Mesh extends Object3D { constructor(material, name = '') { super(); this.material = material; this.name = name; } }

function fakeCanvas() {
  const calls = [];
  const ctx = {
    font: '', measureText: text => ({ width: text.length * 40 }),
    clearRect() {}, strokeText: (...a) => calls.push(['stroke', ...a]), fillText: (...a) => calls.push(['fill', ...a]),
  };
  return { width: 0, height: 0, calls, getContext: () => ctx };
}

test('cleanDisplayName collapses whitespace and caps length; nameTagScale keeps height', () => {
  assert.equal(cleanDisplayName('  Ada \n  Lovelace  '), 'Ada Lovelace');
  assert.equal(cleanDisplayName('x'.repeat(40)).length, 24);
  assert.equal(cleanDisplayName(null), '');
  assert.deepEqual(nameTagScale(200, 100, 0.5), { x: 1, y: 0.5 });
});

test('name tag rebinds its texture only when the ink size changes, disposing the previous one', () => {
  const canvas = fakeCanvas();
  const tag = createNameTag(THREE, { createCanvas: () => canvas });
  assert.equal(tag.object.visible, false);
  assert.equal(tag.setText('  Bo  '), 'Bo');
  const first = tag.object.material.map;
  assert.ok(first instanceof CanvasTexture);
  assert.equal(first.colorSpace, 'srgb');
  assert.equal(tag.setText('Cy'), 'Cy'); // same width: same texture, re-uploaded
  assert.equal(tag.object.material.map, first);
  assert.equal(first.needsUpdate, true);
  tag.setText('Longer name');
  const second = tag.object.material.map;
  assert.notEqual(second, first);
  assert.equal(first.disposed, 1);
  assert.equal(second.disposed, 0);
  assert.ok(tag.object.scale.x > tag.object.scale.y);
  assert.ok(canvas.calls.some(([kind, text]) => kind === 'fill' && text === 'Longer name'));
});

test('placeAbove sits the tag over the target bounds in the parent frame and hides empty names', () => {
  const tag = createNameTag(THREE, { createCanvas: fakeCanvas });
  const root = new Object3D();
  root.position.set(10, 0, 0);
  const head = new Object3D();
  head.userData.bounds = { min: new Vector3(9, 1, -1), max: new Vector3(11, 2, 1) };
  root.add(head);
  root.add(tag.object);
  assert.equal(tag.placeAbove(head), false); // no text yet
  assert.equal(tag.object.visible, false);
  tag.setText('Di');
  assert.equal(tag.placeAbove(head, { lift: 0.5 }), true);
  assert.equal(tag.object.visible, true);
  assert.deepEqual({ ...tag.object.position }, { x: 0, y: 2.5, z: 0 });
  assert.equal(tag.placeAbove(head, { visible: false }), false);
  assert.equal(tag.object.visible, false);
  head.userData.bounds = null;
  assert.equal(tag.placeAbove(head), false);
});

test('name tag dispose releases its own sprite, material and texture once, and refuses later use', () => {
  const tag = createNameTag(THREE, { createCanvas: fakeCanvas });
  const root = new Object3D();
  root.add(tag.object);
  tag.setText('Ed');
  const { material } = tag.object;
  const texture = material.map;
  tag.dispose();
  tag.dispose();
  assert.equal(tag.object.parent, null);
  assert.equal(material.disposed, 1);
  assert.equal(texture.disposed, 1);
  assert.equal(material.map, null);
  assert.equal(root.children.length, 0);
  assert.throws(() => tag.setText('x'), /after dispose/);
});

test('name tag fails loudly without a canvas source or the needed THREE classes', () => {
  assert.throws(() => createNameTag(THREE), /createCanvas/);
  assert.throws(() => createNameTag({}, { createCanvas: fakeCanvas }), /Sprite/);
});

test('appearance colours clones, never the shared game material, and restores on reset', () => {
  const shared = new Material(0x111111);
  const shirtA = new Mesh(shared, 'shirt-a');
  const shirtB = new Mesh(shared, 'shirt-b');
  const body = new Object3D();
  body.add(shirtA);
  body.add(shirtB);
  const hat = new Mesh(new Material(0x222222), 'hat');
  const parts = { shirt: body, hat };
  const look = createAppearance({ resolve: part => parts[part] });

  assert.deepEqual(look.apply({ shirt: { color: 0xff0000 }, hat: { visible: false } }), ['shirt', 'hat']);
  assert.equal(shared.color.hex, 0x111111);
  assert.notEqual(shirtA.material, shared);
  assert.notEqual(shirtA.material, shirtB.material);
  assert.equal(shirtA.material.color.hex, 0xff0000);
  assert.equal(hat.visible, false);
  assert.equal(look.ownedMaterials, 2);

  const clone = shirtA.material;
  look.apply({ shirt: { color: 0x00ff00 } }); // reuses the clone
  assert.equal(shirtA.material, clone);
  assert.equal(clone.color.hex, 0x00ff00);

  look.reset();
  assert.equal(shirtA.material, shared);
  assert.equal(shirtB.material, shared);
  assert.equal(clone.disposed, 1);
  assert.equal(shared.disposed, 0);
  assert.equal(hat.visible, true);
  assert.equal(hat.material.disposed, 0);
  assert.equal(look.ownedMaterials, 0);
});

test('appearance handles material arrays, validates input, and dispose is final', () => {
  const pair = [new Material(1), new Material(2)];
  const can = new Mesh(pair);
  const look = createAppearance({ resolve: part => (part === 'can' ? [can] : null) });
  look.apply({ can: { color: 0xabcdef } });
  assert.ok(Array.isArray(can.material));
  assert.deepEqual(can.material.map(m => m.color.hex), [0xabcdef, 0xabcdef]);
  assert.deepEqual(pair.map(m => m.color.hex), [1, 2]);
  assert.throws(() => look.apply({ missing: { color: 1 } }), /returned no object/);
  assert.throws(() => look.apply({ can: { color: 'red' } }), /finite number/);
  const clones = can.material;
  look.dispose();
  look.dispose();
  assert.equal(can.material, pair);
  assert.deepEqual(clones.map(m => m.disposed), [1, 1]);
  assert.deepEqual(pair.map(m => m.disposed), [0, 0]);
  assert.throws(() => look.apply({}), /after dispose/);
  assert.throws(() => createAppearance(), /resolve/);
});

test('appearanceKey ignores key order', () => {
  assert.equal(appearanceKey({ a: 1, b: { d: 2, c: 3 } }), appearanceKey({ b: { c: 3, d: 2 }, a: 1 }));
  assert.notEqual(appearanceKey({ a: 1 }), appearanceKey({ a: 2 }));
});

function remoteWorld(overrides = {}) {
  const parent = new Object3D();
  const created = [];
  const released = [];
  const placed = [];
  const remotes = createRemotePresentation({
    parent,
    create(id, look) {
      const root = new Object3D();
      const head = new Object3D();
      head.userData.bounds = { min: new Vector3(-0.2, 1.5, -0.2), max: new Vector3(0.2, 1.8, 0.2) };
      root.add(head);
      const character = { id, look, root, head, disposed: 0, dispose() { this.disposed++; } };
      created.push(character);
      return character;
    },
    place(character, pose, context, id) { placed.push({ id, x: pose.x, context }); character.root.position.x = pose.x; },
    release(character, id) { released.push(id); character.dispose(); },
    lerp: (from, to, t) => ({ ...to, x: from.x + (to.x - from.x) * t }),
    blendMs: 100,
    ...overrides,
  });
  return { parent, created, released, placed, remotes };
}

test('remote presentation builds once per look, blends poses, and rebuilds on a look change', () => {
  const { parent, created, released, placed, remotes } = remoteWorld();
  remotes.show('p1', { x: 0, look: { shirt: 'red' } }, 0);
  remotes.show('p1', { x: 10, look: { shirt: 'red' } }, 0);
  assert.equal(created.length, 1);
  remotes.place(50, 'ctx');
  assert.deepEqual(placed.at(-1), { id: 'p1', x: 5, context: 'ctx' });
  assert.equal(created[0].root.visible, true);
  assert.deepEqual(remotes.poses(100).map(p => [p.id, p.x]), [['p1', 10]]);

  // A new update mid-blend starts from what was on screen.
  remotes.show('p1', { x: 20, look: { shirt: 'red' } }, 50);
  remotes.place(50);
  assert.equal(placed.at(-1).x, 5);

  remotes.show('p1', { x: 20, look: { shirt: 'blue' } }, 60);
  assert.equal(created.length, 2);
  assert.deepEqual(released, ['p1']);
  assert.equal(created[0].disposed, 1);
  assert.equal(created[0].root.parent, null);
  assert.equal(created[1].root.parent, parent);
  assert.equal(created[1].root.visible, true); // keeps the visibility it replaced
  remotes.show('p1', { x: 30, look: { shirt: 'blue' } }, 60, { snap: true });
  assert.deepEqual(remotes.poses(60).map(p => p.x), [30]);
});

test('a failing create leaves the current remote in place', () => {
  let fail = false;
  const roots = [];
  const { parent, released, remotes } = remoteWorld({
    create() {
      if (fail) throw new Error('no such look');
      const root = new Object3D();
      roots.push(root);
      return { root };
    },
  });
  remotes.show('p1', { x: 0, look: 1 }, 0);
  fail = true;
  assert.throws(() => remotes.show('p1', { x: 0, look: 2 }, 1), /no such look/);
  assert.equal(remotes.get('p1').root, roots[0]);
  assert.equal(roots[0].parent, parent);
  assert.equal(released.length, 0);
});

test('retain hides absent remotes but keeps them; remove and clear release them to the game', () => {
  const { parent, created, released, remotes } = remoteWorld();
  remotes.show('a', { x: 1, look: 1 }, 0);
  remotes.show('b', { x: 2, look: 1 }, 0);
  remotes.place(0);
  remotes.retain(['a']);
  assert.equal(created[1].root.visible, false);
  assert.deepEqual(remotes.poses(0).map(p => p.id), ['a']);
  remotes.place(0);
  assert.equal(created[1].root.visible, false);
  assert.deepEqual(remotes.ids(), ['a', 'b']);
  remotes.show('b', { x: 3, look: 1 }, 1);
  assert.equal(created.length, 2); // came back without a rebuild

  assert.equal(remotes.remove('b'), true);
  assert.equal(remotes.remove('b'), false);
  assert.deepEqual(released, ['b']);
  remotes.clear();
  assert.deepEqual(released, ['b', 'a']);
  assert.equal(parent.children.length, 0);
  assert.equal(remotes.size, 0);
});

test('remote name tags follow each remote, survive a rebuild, and are disposed with it', () => {
  const { created, remotes } = remoteWorld({
    nameTag: { THREE, createCanvas: fakeCanvas, anchor: character => character.head, lift: 0.1 },
  });
  remotes.show('p', { x: 0, look: 1, displayName: '  Fay  ' }, 0);
  remotes.place(0);
  const tag = created[0].root.children.find(child => child.name === 'name-tag');
  assert.ok(tag);
  assert.equal(tag.visible, true);
  assert.ok(Math.abs(tag.position.y - 1.9) < 1e-9);
  const texture = tag.material.map;

  remotes.show('p', { x: 0, look: 2, displayName: 'Fay' }, 1);
  assert.equal(tag.parent, created[1].root); // same tag, new character
  assert.equal(texture.disposed, 0);

  remotes.retain([]);
  assert.equal(tag.visible, false);
  remotes.dispose();
  assert.equal(tag.parent, null);
  assert.equal(tag.material.disposed, 1);
  assert.equal(texture.disposed, 1);
  // The game's characters were released through its hook, not torn apart here.
  assert.deepEqual(created.map(c => c.disposed), [1, 1]);
  assert.equal(created[1].head.parent, created[1].root);
  assert.throws(() => remotes.show('p', { x: 0 }, 2), /after dispose/);
  remotes.dispose();
});

test('clear attempts every release and reports failures together', () => {
  const { remotes } = remoteWorld({ release(character, id) { if (id === 'a') throw new Error('boom'); } });
  remotes.show('a', { x: 0, look: 1 }, 0);
  remotes.show('b', { x: 0, look: 1 }, 0);
  assert.throws(() => remotes.clear(), error => error instanceof AggregateError && error.errors.length === 1);
  assert.equal(remotes.size, 0);
});

test('remote presentation validates its adapters and clock', () => {
  const base = { parent: new Object3D(), create: () => ({ root: new Object3D() }), place() {} };
  assert.throws(() => createRemotePresentation({ ...base, parent: null }), /parent/);
  assert.throws(() => createRemotePresentation({ ...base, create: null }), /create/);
  assert.throws(() => createRemotePresentation({ ...base, place: null }), /place/);
  assert.throws(() => createRemotePresentation({ ...base, blendMs: 0 }), /blendMs/);
  assert.throws(() => createRemotePresentation({ ...base, nameTag: {} }), /nameTag/);
  const remotes = createRemotePresentation({ ...base, create: () => ({}) });
  assert.throws(() => remotes.show('x', {}, 0), /must return \{ root \}/);
  assert.throws(() => remotes.show('x', {}, Number.NaN), /now/);
});
