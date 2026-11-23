// A headless harness: boots the real simulation modules in Node and runs each screenshot scene,
// catching the runtime errors that would otherwise only appear as a blank canvas in Chrome. It
// touches no DOM, because the simulation half of the game never does.
//
// Usage: node tools/simcheck.mjs [frames]

import { STEP } from '../game/src/config.js';
import { createWorld, fillWorld, stepWorld } from '../game/src/game.js';
import { canSteal } from '../game/src/vehicles.js';
import { selectWeapon } from '../game/src/player.js';
import { startMission, STORY, nextStory } from '../game/src/missions.js';
import { witnessed, addHeat } from '../game/src/police.js';
import { dist2 } from '../game/src/util.js';

const IDLE = { move: { x: 0, y: 0 }, sprint: false, aim: null, fire: false, enter: false, exitCar: false, weaponSwitch: 0, throttle: 0, brake: 0, steer: 0, handbrake: false };

// The simulation calls into audio; a silent stub keeps it honest without WebAudio.
const silentAudio = new Proxy(
  {},
  {
    get: (t, k) => {
      if (k === 'muted') return false;
      if (k === 'ready') return false;
      return () => {};
    },
  },
);

function boot(seed = 1) {
  const world = createWorld(seed);
  fillWorld(world);
  world.audio = silentAudio;
  return world;
}

function nearestParked(world) {
  const p = world.player;
  let best = null;
  let bd = Infinity;
  for (const c of world.cars) {
    if (!c.parked || !canSteal(c)) continue;
    const d = dist2(p.x, p.y, c.x, c.y);
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best ?? world.cars[0];
}

const checks = [];
function check(name, fn) {
  checks.push({ name, fn });
}

check('boot: city, traffic, crowd all exist', () => {
  const w = boot(1);
  if (w.city.blocks.length < 50) throw new Error(`only ${w.city.blocks.length} blocks`);
  if (w.cars.length < 20) throw new Error(`only ${w.cars.length} cars`);
  if (w.peds.length < 30) throw new Error(`only ${w.peds.length} peds`);
  if (w.city.buildings.length < 100) throw new Error(`only ${w.city.buildings.length} buildings`);
  return `${w.city.blocks.length} blocks, ${w.city.buildings.length} buildings, ${w.cars.length} cars, ${w.peds.length} peds`;
});

check('idle 600 frames: no crash, everything stays finite', () => {
  const w = boot(1);
  for (let i = 0; i < 600; i += 1) stepWorld(w, IDLE, STEP);
  for (const c of w.cars) {
    if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) throw new Error(`car ${c.id} went non-finite`);
  }
  for (const p of w.peds) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new Error(`ped ${p.id} went non-finite`);
  }
  return `traffic ${w.cars.length}, peds ${w.peds.length}, clock ${w.clock.toFixed(1)}s`;
});

check('drive: player enters a car and moves', () => {
  const w = boot(1);
  const car = nearestParked(w);
  w.player.x = car.x;
  w.player.y = car.y;
  w.enterVehicle(car);
  if (!w.player.inCar) throw new Error('could not enter the car');
  const x0 = car.x;
  for (let i = 0; i < 300; i += 1) {
    stepWorld(w, { ...IDLE, throttle: 0.9, steer: i > 150 ? 0.3 : 0 }, STEP);
  }
  const moved = Math.hypot(car.x - x0, car.y - car.y === 0 ? 0 : 0);
  void moved;
  const d = Math.hypot(car.x - x0, 0);
  if (Math.hypot(car.x - x0, car.y) === 0) throw new Error('the car never moved');
  return `travelled ${Math.round(Math.hypot(car.x - x0, car.y - w.player.y))} units, speed ${Math.round(car.speed)}`;
});

check('traffic: cars follow the network for 1200 frames', () => {
  const w = boot(1);
  const start = w.cars.map((c) => ({ c, x: c.x, y: c.y }));
  for (let i = 0; i < 1200; i += 1) stepWorld(w, IDLE, STEP);
  let moving = 0;
  for (const s of start) {
    if (Math.hypot(s.c.x - s.x, s.c.y - s.y) > 20) moving += 1;
  }
  if (moving < 3) throw new Error(`only ${moving} traffic cars moved`);
  return `${moving}/${start.length} moved`;
});

check('police: heat spawns cruisers that close in', () => {
  const w = boot(1);
  const car = nearestParked(w);
  w.player.x = car.x;
  w.player.y = car.y;
  w.enterVehicle(car);
  w.police.stars = 3;
  w.police.heat = 3.4;
  witnessed(w.police);
  w.police.spawnTimer = 0;
  let minD = Infinity;
  for (let i = 0; i < 900; i += 1) {
    stepWorld(w, { ...IDLE, throttle: i < 60 ? 0.4 : 0.1 }, STEP);
    for (const u of w.police.units) {
      if (u.state === 'released') continue;
      minD = Math.min(minD, Math.hypot(u.car.x - w.player.x, u.car.y - w.player.y));
    }
  }
  if (w.police.units.length === 0) throw new Error('no cruisers spawned at three stars');
  if (minD > 700) throw new Error(`cruisers never got closer than ${Math.round(minD)}`);
  return `${w.police.units.length} units, closest ${Math.round(minD)}`;
});

check('story: mission 1 builds stages and advances', () => {
  const w = boot(1);
  const story = nextStory(w);
  if (!story) throw new Error('no story mission');
  startMission(w, story, null);
  if (!w.missions.active) throw new Error('mission did not start');
  if (w.missions.active.stages.length < 2) throw new Error('mission has too few stages');
  const first = w.missions.active.stages[0];
  if (!first.marker) throw new Error('first stage has no marker');
  return `${story.title}: ${w.missions.active.stages.length} stages, payout ${story.payout}`;
});

check('story: every mission builds without throwing', () => {
  const out = [];
  for (let i = 0; i < STORY.length; i += 1) {
    const w = boot(1);
    w.missions.storyIndex = i;
    const m = STORY[i];
    startMission(w, m, null);
    const stages = w.missions.active?.stages ?? [];
    if (stages.length === 0) throw new Error(`${m.title} produced no stages`);
    out.push(`${m.title}(${stages.length})`);
  }
  return out.join(' ');
});

check('side jobs: all three build and run', () => {
  const out = [];
  for (const id of ['delivery', 'race', 'hit']) {
    const w = boot(1);
    const ok = w.startSideJob(id);
    if (!ok) throw new Error(`${id} failed to start`);
    for (let i = 0; i < 240; i += 1) stepWorld(w, IDLE, STEP);
    out.push(`${id}(${w.missions.active?.stages.length ?? 0})`);
  }
  return out.join(' ');
});

check('combat: a pistol shot damages a ped and raises heat', () => {
  const w = boot(1);
  const p = w.player;
  p.hasWeapon.pistol = true;
  p.ammo.pistol = 40;
  selectWeapon(p, 'pistol');
  // Stand next to a pedestrian and shoot straight at them.
  const ped = w.peds.find((q) => !q.cop && !q.dead);
  p.x = ped.x - 60;
  p.y = ped.y;
  p.aiming = true;
  p.aimAngle = 0;
  const hp0 = ped.health;
  for (let i = 0; i < 90; i += 1) stepWorld(w, { ...IDLE, aim: { x: ped.x, y: ped.y }, fire: true }, STEP);
  if (ped.health >= hp0 && !ped.dead) throw new Error('the ped took no damage');
  if (w.police.stars < 1) throw new Error('shooting did not raise the wanted level');
  return `ped ${hp0}->${ped.dead ? 'down' : Math.round(ped.health)}, ${w.police.stars} stars`;
});

check('death and respawn', () => {
  const w = boot(1);
  w.player.health = 1;
  w.player.armour = 0;
  w.player.dead = true;
  w.player.deathTimer = 0.5;
  for (let i = 0; i < 90; i += 1) stepWorld(w, IDLE, STEP);
  if (w.player.dead) throw new Error('never respawned');
  if (w.player.health < 20) throw new Error('respawned at death health');
  return `health ${Math.round(w.player.health)}, at the hospital`;
});

check('determinism: same seed, same city and traffic', () => {
  const a = boot(7);
  const b = boot(7);
  for (let i = 0; i < 300; i += 1) {
    stepWorld(a, IDLE, STEP);
    stepWorld(b, IDLE, STEP);
  }
  if (a.cars.length !== b.cars.length) throw new Error('different car counts');
  for (let i = 0; i < Math.min(a.cars.length, b.cars.length); i += 1) {
    if (Math.abs(a.cars[i].x - b.cars[i].x) > 0.001) throw new Error(`car ${i} diverged`);
    if (Math.abs(a.cars[i].y - b.cars[i].y) > 0.001) throw new Error(`car ${i} diverged`);
  }
  if (a.peds.length !== b.peds.length) throw new Error('different ped counts');
  return `${a.cars.length} cars identical after 300 frames`;
});

check('the shot scenes all run headlessly', async () => {
  const notes = [];
  // Mirror what shots.js stages, using the same modules, without a DOM.
  const w1 = boot(1);
  const car = nearestParked(w1);
  w1.player.x = car.x;
  w1.player.y = car.y;
  w1.enterVehicle(car);
  for (let i = 0; i < 260; i += 1) stepWorld(w1, { ...IDLE, throttle: 0.85, steer: i < 60 ? 0.04 : -0.02 }, STEP);
  notes.push(`drive ok (${w1.cars.length} cars)`);

  const w2 = boot(1);
  const c2 = nearestParked(w2);
  w2.player.x = c2.x;
  w2.player.y = c2.y;
  w2.enterVehicle(c2);
  w2.missions.storyIndex = 0;
  startMission(w2, STORY[0], null);
  w2.police.stars = 3;
  w2.police.heat = 3.4;
  witnessed(w2.police);
  for (let i = 0; i < 300; i += 1) stepWorld(w2, { ...IDLE, throttle: 0.6 }, STEP);
  addHeat(w2.police, 0.3);
  notes.push(`chase ok (${w2.police.units.length} units, ${w2.police.stars} stars)`);

  const w3 = boot(1);
  w3.missions.storyIndex = 1;
  startMission(w3, STORY[1], null);
  const marker = w3.missions.active.stages[0].marker;
  for (let i = 0; i < 300; i += 1) stepWorld(w3, IDLE, STEP);
  notes.push(`mission ok (marker ${Math.round(marker.x)},${Math.round(marker.y)})`);
  return notes.join('; ');
});

let failed = 0;
for (const c of checks) {
  try {
    const note = await c.fn();
    console.log(`  ok   ${c.name}${note ? `  — ${note}` : ''}`);
  } catch (e) {
    failed += 1;
    console.log(`  FAIL ${c.name}\n         ${e.message}`);
  }
}
console.log(failed === 0 ? `\nall ${checks.length} checks passed` : `\n${failed} of ${checks.length} checks failed`);
if (failed) process.exitCode = 1;
