// In-world player presentation: name tags, appearance on game-supplied meshes,
// and the lifecycle of remote players' presentation. Three.js is injected by
// the caller (Halo's peer copy); this module never imports or pins it.
// Ownership rule: the module disposes only what it created (tag sprites, their
// materials and canvas textures, appearance material clones). Meshes,
// geometries, materials and characters the game supplies are never disposed
// here; remote characters are handed back to the game's release hook.

const DEFAULT_TAG = Object.freeze({
  height: 0.34,
  fontSize: 72,
  fontFamily: 'system-ui, sans-serif',
  fontWeight: 700,
  fill: '#f6e7b8',
  stroke: 'rgba(16, 14, 10, 0.92)',
  maxLength: 24,
  name: 'name-tag',
});

function fail(message) {
  throw new TypeError(`[arcade/presentation] ${message}`);
}

function isFunction(value) {
  return typeof value === 'function';
}

function finite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} must be a finite number`);
  return value;
}

function positive(value, label) {
  if (finite(value, label) <= 0) fail(`${label} must be greater than zero`);
  return value;
}

// Collapse whitespace, trim, and cap the length. Display text only: name
// uniqueness, storage and moderation are the game's identity policy.
export function cleanDisplayName(value, { maxLength = DEFAULT_TAG.maxLength } = {}) {
  positive(maxLength, 'maxLength');
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

// World size of a label whose canvas is exactly the ink plus the stroke pad.
// The height stays fixed; width follows the text's aspect.
export function nameTagScale(pixelWidth, pixelHeight, height = DEFAULT_TAG.height) {
  const h = Math.max(1, Number(pixelHeight) || 1);
  const w = Math.max(1, Number(pixelWidth) || 1);
  return { x: height * (w / h), y: height };
}

// Paints outlined text sized to its ink. Returns the canvas pixel size.
export function paintNameTag(canvas, text, style = DEFAULT_TAG) {
  const ctx = canvas.getContext('2d');
  if (!ctx) fail('canvas.getContext("2d") returned nothing');
  const size = style.fontSize;
  const line = Math.max(8, size * 0.18);
  const font = `${style.fontWeight} ${size}px ${style.fontFamily}`;
  ctx.font = font;
  const measured = text ? ctx.measureText(text).width : 0;
  const width = Math.max(32, Math.ceil(measured + line * 2 + 8));
  const height = Math.ceil(size + line * 2 + 8);
  canvas.width = width;
  canvas.height = height;
  // Resizing a canvas resets its context state, so the font is set again.
  ctx.clearRect(0, 0, width, height);
  if (!text) return { width, height };
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.lineWidth = line;
  ctx.strokeStyle = style.stroke;
  ctx.strokeText(text, width / 2, height / 2);
  ctx.fillStyle = style.fill;
  ctx.fillText(text, width / 2, height / 2);
  return { width, height };
}

function defaultCanvas() {
  if (typeof document === 'undefined') fail('createNameTag needs options.createCanvas outside a browser document');
  return document.createElement('canvas');
}

// A camera-facing label. Its origin is its bottom centre, so placing it at a
// crown point hangs the glyphs above the head.
export function createNameTag(THREE, options = {}) {
  if (!THREE?.Sprite || !THREE?.SpriteMaterial || !THREE?.CanvasTexture) fail('createNameTag needs THREE with Sprite, SpriteMaterial and CanvasTexture');
  const style = { ...DEFAULT_TAG, ...options };
  positive(style.height, 'height');
  positive(style.fontSize, 'fontSize');
  const format = options.format ?? (value => cleanDisplayName(value, { maxLength: style.maxLength }));
  if (!isFunction(format)) fail('format must be a function');
  const canvas = (options.createCanvas ?? defaultCanvas)();
  if (!canvas?.getContext) fail('createCanvas must return a canvas');

  const material = new THREE.SpriteMaterial({ map: null, color: 0xffffff, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  sprite.name = style.name;
  sprite.center.set(0.5, 0);
  sprite.visible = false;
  sprite.scale.set(style.height * 2.35, style.height, 1);
  const box = THREE.Box3 ? new THREE.Box3() : null;
  const anchor = THREE.Vector3 ? new THREE.Vector3() : null;
  let texture = null;
  let uploaded = { width: 0, height: 0 };
  let text = null;
  let disposed = false;

  function live(action) {
    if (disposed) fail(`${action} after dispose`);
  }

  // WebGL2 allocates a canvas texture once; growing the canvas later still
  // uploads into the first size. A new size gets a new texture.
  function bind(size) {
    const next = new THREE.CanvasTexture(canvas);
    if (THREE.SRGBColorSpace !== undefined) next.colorSpace = THREE.SRGBColorSpace;
    next.generateMipmaps = false;
    if (THREE.LinearFilter !== undefined) next.minFilter = next.magFilter = THREE.LinearFilter;
    const previous = texture;
    texture = next;
    material.map = next;
    material.needsUpdate = true;
    uploaded = size;
    previous?.dispose();
  }

  function setText(value) {
    live('setText');
    const next = String(format(value) ?? '');
    if (next === text) return next;
    text = next;
    const ink = paintNameTag(canvas, next, style);
    if (!texture || ink.width !== uploaded.width || ink.height !== uploaded.height) bind(ink);
    else texture.needsUpdate = true;
    const scale = nameTagScale(ink.width, ink.height, style.height);
    sprite.scale.set(scale.x, scale.y, 1);
    if (!next) sprite.visible = false;
    return next;
  }

  // Sits the tag above target's world bounding box, in world up, whatever
  // the target's own rotation. The tag must already have a parent.
  function placeAbove(target, { lift = 0.06, visible = true } = {}) {
    live('placeAbove');
    finite(lift, 'lift');
    if (!box || !anchor) fail('placeAbove needs THREE with Box3 and Vector3');
    sprite.visible = !!(visible && text);
    if (!sprite.visible) return false;
    const parent = sprite.parent;
    if (!parent) fail('placeAbove needs the tag added to a parent first');
    if (!target) fail('placeAbove needs a target object');
    parent.updateWorldMatrix(true, true);
    box.setFromObject(target);
    if (box.isEmpty()) {
      sprite.visible = false;
      return false;
    }
    anchor.set((box.min.x + box.max.x) / 2, box.max.y + lift, (box.min.z + box.max.z) / 2);
    parent.worldToLocal(sprite.position.copy(anchor));
    return true;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    sprite.removeFromParent();
    texture?.dispose();
    texture = null;
    material.map = null;
    material.dispose();
  }

  return {
    object: sprite,
    get text() { return text ?? ''; },
    get disposed() { return disposed; },
    setText,
    placeAbove,
    dispose,
  };
}

function objectsOf(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value.filter(Boolean) : [value];
}

function meshesUnder(object) {
  const meshes = [];
  const visit = node => { if (node?.material) meshes.push(node); };
  if (isFunction(object.traverse)) object.traverse(visit);
  else visit(object);
  return meshes;
}

// Applies appearance data ({[part]: {color, visible}}) to meshes the game
// resolves by part name. A colour is written on a clone of the mesh's
// material, made on first write, so a material the game shares between
// meshes is never changed. reset() and dispose() restore the game's
// materials and visibility and dispose only the clones.
export function createAppearance({ resolve } = {}) {
  if (!isFunction(resolve)) fail('createAppearance needs options.resolve(part)');
  const objects = new Map(); // object -> original visibility
  const meshes = new Map(); // mesh -> { original, clones, color }
  let disposed = false;

  function cloneFor(mesh) {
    let record = meshes.get(mesh);
    if (record) return record;
    const original = mesh.material;
    const list = Array.isArray(original) ? original : [original];
    const clones = list.map(material => {
      if (!isFunction(material?.clone) || !isFunction(material?.color?.setHex)) fail(`mesh "${mesh.name || ''}" has a material without clone() and color.setHex()`);
      return material.clone();
    });
    record = { original, clones };
    meshes.set(mesh, record);
    mesh.material = Array.isArray(original) ? clones : clones[0];
    return record;
  }

  function apply(appearance = {}) {
    if (disposed) fail('apply after dispose');
    if (appearance === null || typeof appearance !== 'object') fail('appearance must be an object');
    const applied = [];
    for (const [part, value] of Object.entries(appearance)) {
      if (value === null || typeof value !== 'object') fail(`appearance.${part} must be an object`);
      const targets = objectsOf(resolve(part));
      if (!targets.length) fail(`resolve("${part}") returned no object`);
      if (value.color !== undefined) finite(value.color, `appearance.${part}.color`);
      for (const object of targets) {
        if (value.visible !== undefined) {
          if (!objects.has(object)) objects.set(object, object.visible);
          object.visible = !!value.visible;
        }
        if (value.color !== undefined) {
          for (const mesh of meshesUnder(object)) {
            for (const clone of cloneFor(mesh).clones) clone.color.setHex(value.color);
          }
        }
      }
      applied.push(part);
    }
    return applied;
  }

  function reset() {
    for (const [mesh, record] of meshes) {
      mesh.material = record.original;
      for (const clone of record.clones) clone.dispose?.();
    }
    meshes.clear();
    for (const [object, visible] of objects) object.visible = visible;
    objects.clear();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    reset();
  }

  return {
    apply,
    reset,
    dispose,
    get disposed() { return disposed; },
    get ownedMaterials() { let n = 0; for (const r of meshes.values()) n += r.clones.length; return n; },
  };
}

// A stable string for appearance-like data: same keys and values, same key.
export function appearanceKey(look) {
  const canon = value => {
    if (Array.isArray(value)) return value.map(canon);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, canon(value[key])]));
    }
    return value;
  };
  return JSON.stringify(canon(look ?? null));
}

const snap = (from, to) => ({ ...to });

// Lifecycle of the other players in the world. The game builds each remote's
// character (create), positions it (place) and releases it (release); the
// module keeps one presentation per id, rebuilds it when the look key
// changes, blends poses between network updates, hides absent players, and
// optionally keeps a name tag above each one.
export function createRemotePresentation(options = {}) {
  const {
    parent,
    create,
    place,
    release = presentation => presentation.dispose?.(),
    lookOf = pose => pose.look,
    lookKey = appearanceKey,
    nameOf = pose => pose.displayName,
    lerp = snap,
    blendMs = 50,
    nameTag = null,
  } = options;
  if (!parent || !isFunction(parent.add)) fail('createRemotePresentation needs options.parent with add()');
  if (!isFunction(create)) fail('createRemotePresentation needs options.create(id, look)');
  if (!isFunction(place)) fail('createRemotePresentation needs options.place(presentation, pose, context)');
  for (const [name, fn] of Object.entries({ release, lookOf, lookKey, nameOf, lerp })) {
    if (!isFunction(fn)) fail(`${name} must be a function`);
  }
  positive(blendMs, 'blendMs');
  if (nameTag && (!nameTag.THREE || !isFunction(nameTag.anchor))) fail('nameTag needs THREE and anchor(presentation)');

  const remotes = new Map(); // id -> { presentation, key, tag, shown }
  let disposed = false;

  function live(action) {
    if (disposed) fail(`${action} after dispose`);
  }

  function now(value) {
    return finite(value, 'now');
  }

  function build(id, look, key) {
    const presentation = create(id, look);
    if (!presentation?.root) fail(`create("${id}") must return { root }`);
    return { presentation, key };
  }

  function letGo(id, entry) {
    entry.presentation.root.removeFromParent?.();
    release(entry.presentation, id);
  }

  function ensure(id, pose) {
    const look = lookOf(pose, id);
    const key = String(lookKey(look, id));
    const existing = remotes.get(id);
    if (existing && existing.key === key) return existing;
    // Build first, so a failing create leaves the current one in place.
    const tag = existing?.tag ?? (nameTag ? createNameTag(nameTag.THREE, nameTag) : null);
    let next;
    try {
      next = build(id, look, key);
    } catch (error) {
      if (tag && !existing) tag.dispose();
      throw error;
    }
    const root = next.presentation.root;
    root.visible = existing ? !!existing.presentation.root.visible : false;
    next.shown = existing?.shown ?? null;
    next.tag = tag;
    if (existing) letGo(id, existing);
    parent.add(root);
    if (next.tag) root.add(next.tag.object);
    remotes.set(id, next);
    return next;
  }

  function current(entry, at) {
    const { from, to, at: since } = entry.shown;
    return lerp(from, to, Math.min(1, Math.max(0, (at - since) / blendMs)));
  }

  function show(id, pose, at, { snap: jump = false } = {}) {
    live('show');
    now(at);
    if (!pose || typeof pose !== 'object') fail('show needs a pose object');
    const entry = ensure(id, pose);
    if (jump || !entry.shown) entry.shown = { from: pose, to: pose, at };
    else entry.shown = { from: current(entry, at), to: pose, at };
    return entry.presentation;
  }

  // Hides every remote not in live. Hidden ones keep their character for a
  // quick return; remove() or clear() releases them.
  function retain(liveIds) {
    live('retain');
    const keep = new Set(liveIds);
    for (const [id, entry] of remotes) {
      if (keep.has(id)) continue;
      entry.presentation.root.visible = false;
      if (entry.tag) entry.tag.object.visible = false;
      entry.shown = null;
    }
  }

  function placeAll(at, context) {
    live('place');
    now(at);
    for (const [id, entry] of remotes) {
      const root = entry.presentation.root;
      if (!entry.shown) {
        root.visible = false;
        continue;
      }
      root.visible = true;
      const pose = current(entry, at);
      place(entry.presentation, pose, context, id);
      if (entry.tag) {
        entry.tag.setText(nameOf(pose, id));
        entry.tag.placeAbove(nameTag.anchor(entry.presentation, id), { lift: nameTag.lift ?? 0.06 });
      }
    }
  }

  // The blended pose of every shown remote at this instant: what place()
  // draws, for collision or interest checks.
  function poses(at) {
    live('poses');
    now(at);
    const list = [];
    for (const [id, entry] of remotes) {
      if (entry.shown) list.push({ ...current(entry, at), id });
    }
    return list;
  }

  function remove(id) {
    live('remove');
    const entry = remotes.get(id);
    if (!entry) return false;
    remotes.delete(id);
    entry.tag?.dispose();
    letGo(id, entry);
    return true;
  }

  // Releases every remote. Each release is attempted even if one throws.
  function clear() {
    const errors = [];
    for (const [id, entry] of [...remotes]) {
      remotes.delete(id);
      try { entry.tag?.dispose(); } catch (error) { errors.push(error); }
      try { letGo(id, entry); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, '[arcade/presentation] clear failed');
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    clear();
  }

  return {
    show,
    retain,
    place: placeAll,
    poses,
    remove,
    clear,
    dispose,
    get(id) { return remotes.get(id)?.presentation; },
    ids() { return [...remotes.keys()]; },
    get size() { return remotes.size; },
    get disposed() { return disposed; },
  };
}
