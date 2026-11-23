// Saving and loading: one localStorage key holds a compact snapshot of the run. Only what a player
// would miss is stored (money, weapons, health, story progress, the safehouse, statistics and the
// clock); the city is rebuilt from its seed, so a save is a few hundred bytes and always matches
// the world it belongs to.

import { SAVE_KEY, WEAPONS } from './config.js';

const VERSION = 1;

function storage() {
  try {
    const s = window.localStorage;
    const probe = '__solara_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

export function hasSave() {
  const s = storage();
  if (!s) return false;
  try {
    const raw = s.getItem(SAVE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    return data && data.version === VERSION && typeof data.money === 'number';
  } catch {
    return false;
  }
}

/** The snapshot the world offers the save system. */
export function snapshot(world) {
  const p = world.player;
  return {
    version: VERSION,
    savedAt: Date.now(),
    seed: world.seed,
    money: Math.round(p.money),
    health: Math.round(p.health),
    armour: Math.round(p.armour),
    weapon: p.weapon,
    ammo: { pistol: p.ammo.pistol ?? 0, smg: p.ammo.smg ?? 0 },
    hasWeapon: { pistol: !!p.hasWeapon.pistol, smg: !!p.hasWeapon.smg },
    pos: { x: Math.round(p.x), y: Math.round(p.y), angle: +p.angle.toFixed(2) },
    storyIndex: world.missions.storyIndex,
    storyStage: world.missions.storyStage,
    completed: world.missions.completed.slice(),
    stats: {
      missions: world.stats.missions,
      deliveries: world.stats.deliveries,
      races: world.stats.races,
      hits: world.stats.hits,
      kills: world.stats.kills,
      distance: Math.round(world.stats.distance),
      earned: Math.round(world.stats.earned),
    },
    time: world.time,
    wanted: world.police.stars,
  };
}

export function save(world) {
  const s = storage();
  if (!s) return false;
  try {
    s.setItem(SAVE_KEY, JSON.stringify(snapshot(world)));
    return true;
  } catch {
    return false;
  }
}

export function load() {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || data.version !== VERSION) return null;
    return data;
  } catch {
    return null;
  }
}

export function clearSave() {
  const s = storage();
  if (!s) return;
  try {
    s.removeItem(SAVE_KEY);
  } catch {
    // Private windows refuse writes; nothing to clear.
  }
}

/** Apply a loaded snapshot to a fresh world. The city was built from the same seed. */
export function applySave(world, data) {
  if (!data) return false;
  const p = world.player;
  p.money = data.money ?? p.money;
  p.health = Math.min(100, Math.max(20, data.health ?? 100));
  p.armour = Math.min(100, Math.max(0, data.armour ?? 0));
  p.weapon = WEAPONS[data.weapon] ? data.weapon : 'fists';
  p.ammo.pistol = data.ammo?.pistol ?? 0;
  p.ammo.smg = data.ammo?.smg ?? 0;
  p.hasWeapon.pistol = data.hasWeapon?.pistol ?? p.ammo.pistol > 0;
  p.hasWeapon.smg = data.hasWeapon?.smg ?? p.ammo.smg > 0;
  if (!p.hasWeapon[p.weapon]) p.weapon = p.hasWeapon.pistol ? 'pistol' : 'fists';
  if (data.pos) {
    p.x = data.pos.x;
    p.y = data.pos.y;
    p.angle = data.pos.angle ?? 0;
    world.camera.snap(p.x, p.y);
  }
  world.missions.storyIndex = data.storyIndex ?? 0;
  world.missions.storyStage = data.storyStage ?? 0;
  world.missions.completed = Array.isArray(data.completed) ? data.completed.slice() : [];
  world.stats = { ...world.stats, ...(data.stats ?? {}) };
  world.time = typeof data.time === 'number' ? data.time : world.time;
  return true;
}

/** A human line for the title screen's Continue button. */
export function saveSummary(data) {
  if (!data) return '';
  const t = new Date(data.savedAt ?? Date.now());
  const hh = String(t.getHours()).padStart(2, '0');
  const mm = String(t.getMinutes()).padStart(2, '0');
  return `$${Math.round(data.money).toLocaleString('en-US')} · ${data.completed?.length ?? 0} jobs done · ${hh}:${mm}`;
}
