// The world: one object holding the city, the player, the traffic, the crowd, the police and the
// missions, and the fixed-step update that moves them all. This is the only place systems know
// about each other, so main.js stays a loop and shots.js stays a script.
//
// Collision is circle-vs-rect against the building hash, circle-vs-circle between bodies, and a
// swept ray for bullets. The world also owns the small event bus the HUD and audio listen to
// (toasts, wanted changes, mission ends) so no module has to poll.

import { CAR, GRID, PLAYER, POLICE, STEP, VIEW, WANTED, WEAPONS } from './config.js';
import { createRandom } from './random.js';
import { createCity } from './city.js';
import { burstSparks, bloodSpray, createParticles, explosion, footDust, muzzle, splash, tyreSmoke } from './particles.js';
import { createCamera, updateCamera } from './camera.js';
import { createAudio } from './audio.js';
import { createPolice, addHeat, crimeWeight, damageCar, isChased, updatePolice, witnessed, copDowned } from './police.js';
import { createPlayer, enterCar, exitCar, hurtPlayer, nearestCar, payPlayer, playerPose, updatePlayer } from './player.js';
import { populateParked, populateTraffic, topUpTraffic, driveTraffic, makeCar, makeVan, carRadius } from './vehicles.js';
import { ejectDriver, hurtCop, hurtPed, panicAround, populatePeds, topUpPeds, updatePeds } from './pedestrians.js';
import { createMissionState, SIDE_JOBS, STORY, advanceStage, failMission, nextStory, onPedKilled, startMission, updateMissions, missionObjective } from './missions.js';
import { angleDiff, circleRectPush, clamp, dist2, hash01, lerp, rayRect } from './util.js';

const PICKUP_KINDS = {
  health: { color: '#e4544a', label: 'Health', radius: 12 },
  armour: { color: '#4a8fd4', label: 'Armour', radius: 12 },
  ammo: { color: '#e0b44a', label: 'Ammo', radius: 11 },
  cash: { color: '#8ed16a', label: 'Cash', radius: 10 },
};

export function createWorld(seed) {
  const rnd = createRandom(seed);
  const city = createCity(seed);
  const world = {
    seed,
    rnd,
    city,
    camera: createCamera(city),
    particles: createParticles(),
    audio: createAudio(),
    player: createPlayer(city.spawn.x, city.spawn.y, city.spawn.angle),
    cars: [],
    peds: [],
    bullets: [],
    pickups: [],
    decals: [],
    police: createPolice(),
    missions: createMissionState(),
    stats: { missions: 0, deliveries: 0, races: 0, hits: 0, kills: 0, distance: 0, earned: 0, wrecks: 0, maxWanted: 0 },
    time: 17 * 3600 + 20 * 60,
    clock: 0,
    scripted: false,
    input: null,
    recentGunfire: 0,
    toast: null,
    messages: [],
    missionCars: [],
    parkedDone: false,
    trafficTarget: 46,
    pedTarget: 150,
    onMissionEnd: null,
    onWantedCleared: null,
    onStoryComplete: null,
    onCopDown: null,
    onCopHit: null,
    onPedHurt: null,
    onPedDown: null,
    paused: false,
    distanceTraveled: 0,
    lastPlayerPos: { x: city.spawn.x, y: city.spawn.y },
    bigMessage: null,
    bigMessageTimer: 0,
  };

  // A handful of systems reach into each other by name; wire the event hooks now.
  world.onPedDown = (ped, cause) => {
    onPedKilled(world, ped, cause);
    world.police.stars = Math.max(world.police.stars, world.police.stars);
    if (cause === 'melee' || cause === 'bullet' || cause === 'car') {
      world.raiseWanted(crimeWeight('kill'), 'kill');
    }
    // Drop something for the player now and then.
    if (world.rnd.chance(cause === 'car' ? 0.5 : 0.4)) spawnPickup(world, ped.x, ped.y, world.rnd.chance(0.5) ? 'cash' : 'health');
    bloodSpray(world.particles, ped.x, ped.y, world.rnd.angle(), 8, world.rnd);
  };
  world.onPedHurt = (ped) => {
    panicAround(world, ped.x, ped.y, 240, 5);
    if (ped.cop) return;
    world.raiseWanted(0.22, 'assault');
  };
  world.onCopDown = (cop) => {
    copDowned(world, cop);
    world.raiseWanted(crimeWeight('killCop'), 'killCop');
    panicAround(world, cop.x, cop.y, 300, 6);
    if (world.rnd.chance(0.8)) spawnPickup(world, cop.x, cop.y, 'ammo');
  };
  world.onCopHit = () => {
    world.raiseWanted(crimeWeight('shotCop'), 'shotCop');
  };
  world.onWantedCleared = () => {
    world.bigMessage = 'HEAT LOST';
    world.bigMessageTimer = 2.4;
  };
  world.onStoryComplete = () => {
    world.bigMessage = 'STORY COMPLETE';
    world.bigMessageTimer = 4;
    payPlayer(world.player, 5000);
    world.showToast('The city is yours', 'Story complete', 'Final take: $5,000 bonus', 'good');
  };
  world.onMissionEnd = (success) => {
    if (!success) world.missions.failFlash = 1;
  };

  // ---------------------------------------------------------------- the small API systems use
  world.showToast = (title, kicker, body, tone = 'info') => {
    world.toast = { title, kicker, body, tone, life: 4.6, max: 4.6 };
  };
  world.raiseWanted = (amount, kind) => {
    if (world.scripted) return;
    const before = world.police.stars;
    addHeat(world.police, amount);
    witnessed(world.police);
    world.police.lastCrime = kind ?? world.police.lastCrime;
    world.stats.maxWanted = Math.max(world.stats.maxWanted, world.police.stars);
    if (world.police.stars > before) {
      world.audio.play('wanted', { volume: 0.5 });
      world.bigMessage = `${'★'.repeat(world.police.stars)}  ${WANTED.titles[world.police.stars].toUpperCase()}`;
      world.bigMessageTimer = 2.2;
    }
  };
  world.recentGunfire = 0;
  world.spawnBullet = (b) => {
    world.bullets.push({ ...b, x0: b.x, y0: b.y, life: b.range / b.speed, hit: false, tracer: 1 });
    world.recentGunfire = 2.2;
    panicAround(world, b.x, b.y, 340, 5);
    if (b.owner === 'player' && !world.scripted) {
      // A gunshot in public: heat, but not from a clean suppressed shot.
      world.raiseWanted(0.12, 'gunfire');
    }
  };
  world.muzzleFlash = (x, y, angle, weapon) => muzzle(world.particles, x, y, angle, weapon, world.rnd);
  world.burstSparks = (x, y, n, angle) => burstSparks(world.particles, x, y, angle ?? world.rnd.angle(), n, world.rnd);
  world.burstHit = (x, y) => bloodSpray(world.particles, x, y, world.rnd.angle(), 6, world.rnd);
  world.burstMiss = (x, y) => world.particles.spawn('dust', x, y, { life: 0.25, size: 3, grow: 8, color: '#d9cba8', alpha: 0.3 });
  world.burstPickup = (x, y) => {
    for (let i = 0; i < 8; i += 1) {
      const a = world.rnd.angle();
      world.particles.spawn('spark', x, y, { vx: Math.cos(a) * 90, vy: Math.sin(a) * 90 - 30, life: 0.4, size: 2, color: '#ffe08a', drag: 2 });
    }
  };
  world.hurtPed = (ped, amount, cause) => hurtPed(world, ped, amount, cause);
  world.hurtCop = (cop, amount) => hurtCop(world, cop, amount);
  world.recordDestruction = (car) => {
    world.stats.wrecks += 1;
    if (car.occupiedByPlayer) world.police.stars = Math.max(world.police.stars, 1);
  };

  // ---------------------------------------------------------------- vehicles
  world.enterVehicle = (car) => {
    const p = world.player;
    if (!car || p.inCar) return;
    const wasOccupied = !car.parked && !!car.driver;
    const ejected = enterCar(world, car);
    world.audio.play('click', { volume: 0.5 });
    // A car with a driver is a jacking: the heat notices, the driver runs.
    if (wasOccupied) {
      const ped = ejectDriver(world, car);
      panicAround(world, car.x, car.y, 260, 5);
      world.raiseWanted(crimeWeight('steal') + 0.2, 'steal');
      world.showToast('Carjacked', `${car.model.name}`, 'Someone is calling the police', 'bad');
      void ped;
    } else {
      world.raiseWanted(crimeWeight('steal') * 0.5, 'steal');
    }
    car.driver = null;
    car.parked = false;
    car.occupiedByPlayer = true;
    world.audio.play('door', { volume: 0.4 });
    world.camera.shake(2);
  };
  world.exitVehicle = () => {
    const car = exitCar(world);
    if (car) car.occupiedByPlayer = false;
    world.audio.silenceEngine();
    world.audio.play('door', { volume: 0.4 });
  };

  // ---------------------------------------------------------------- mission helpers
  world.spawnMissionCar = (tag) => {
    const city = world.city;
    // Pelican Row: a quiet street in the old town, a few blocks from the garage.
    const i = 2;
    const j = 5;
    const node = city.nodes.get(`${i},${j}`);
    const x = node.x + 150;
    const y = node.y + city.grid * 0.5 + 33;
    const model = { name: 'Marabella', body: '#3f6f9c', len: 1.06, wid: 1.04, roof: '#2b546c', kind: 'sedan' };
    const car = makeCar(model, x, y, Math.PI / 2, { parked: true, tag });
    car.missionCar = tag;
    car.health = 520;
    car.maxHealth = 520;
    world.cars.push(car);
    world.missionCars.push(car);
    return car;
  };
  world.missionSpot = (i, j) => {
    const block = world.city.blocks.find((b) => b.i === i && b.j === j);
    if (!block) return { x: 0, y: 0 };
    return { x: block.x + block.w * 0.62, y: block.y + block.h * 0.55 };
  };
  world.spawnVanIfMissing = (at) => {
    const exists = world.cars.find((c) => c.kind === 'van' && Math.hypot(c.x - at.x, c.y - at.y) < 200);
    if (exists) return exists;
    const van = makeVan(at.x, at.y, Math.PI / 2);
    van.parked = true;
    van.cruise = 0;
    world.cars.push(van);
    return van;
  };
  world.raceRoute = () => {
    // Three checkpoints down the old district's grid: a real drive, on the streets.
    return [
      { x: world.city.nodes.get('2,4').x + 150, y: world.city.nodes.get('2,4').y + 400 },
      { x: world.city.nodes.get('4,6').x, y: world.city.nodes.get('4,6').y - 120 },
      { x: world.city.nodes.get('3,3').x + 60, y: world.city.nodes.get('3,3').y + 60 },
    ];
  };
  world.markForHit = (at) => {
    // A beachgoer becomes the contract: a normal pedestrian with a red marker.
    const rnd = world.rnd;
    let target = null;
    for (const ped of world.peds) {
      if (ped.dead || ped.cop) continue;
      if (Math.hypot(ped.x - at.x, ped.y - at.y) > 700) continue;
      target = ped;
      break;
    }
    if (!target) {
      const pt = { x: at.x + rnd.range(-40, 40), y: at.y + rnd.range(-40, 40) };
      target = { id: 90000 + Math.floor(rnd.next() * 9000), x: pt.x, y: pt.y, dead: false, cop: false, health: 40, state: 'walk', loiter: { home: pt, radius: 30, angle: rnd.angle() }, mark: 'hit', skin: '#c98f66', shirt: '#e4544a', pants: '#3a465a', hair: '#2a1d14', top: 'tank', bottom: 'shorts', phase: 0, speed: 40, angle: 0, vx: 0, vy: 0, walkPhase: 0, speedNow: 0, radius: 9, shotTimer: 0, aimTimer: 0, downTime: 0, hurtTimer: 0, alert: 0, muzzle: 0, shootCooldown: 0 };
      world.peds.push(target);
    }
    target.mark = 'hit';
    target.health = 45;
    return target;
  };
  world.populateTargets = (stage) => {
    // Spawn or mark a few hostile pedestrians at the stage's marker.
    const st = stage;
    const rnd = world.rnd;
    const n = st.remaining ?? 3;
    st.targets = st.targets ?? [];
    const already = st.targets.filter((id) => world.peds.some((p) => p.id === id && !p.dead)).length;
    for (let k = already; k < n; k += 1) {
      const a = rnd.angle();
      const r = rnd.range(30, 90);
      const x = (st.marker?.x ?? world.player.x) + Math.cos(a) * r;
      const y = (st.marker?.y ?? world.player.y) + Math.sin(a) * r;
      const ped = world.spawnHostile(x, y, k === 0);
      st.targets.push(ped.id);
    }
    st.remaining = world.missionTargetsAlive(st);
  };
  world.missionTargetsAlive = (stage) => {
    if (!stage.targets) return stage.remaining ?? 0;
    return stage.targets.filter((id) => world.peds.some((p) => p.id === id && !p.dead)).length;
  };
  world.cleanupMissionArtifacts = (a) => {
    if (!a) return;
    for (const st of a.stages ?? []) {
      if (st.car) st.car.missionCar = null;
    }
    for (const ped of world.peds) {
      if (ped.mark === 'hit') ped.mark = null;
    }
  };
  world.beginEscape = (stage) => {
    const p = world.player;
    stage.origin = { x: p.x, y: p.y };
    // An escape always leaves heat behind, so there is something to run from.
    if (world.police.stars < 2) world.raiseWanted(1.3, 'escape');
  };
  world.refreshOffers = () => {
    const ids = ['delivery', 'race', 'hit'];
    const m = world.missions;
    m.available = ids.map((id) => ({
      id,
      title: SIDE_JOBS[id].title,
      payout: SIDE_JOBS[id].payout,
      marker: world.city.poi.safehouse,
    }));
  };
  world.startSideJob = (id) => {
    const job = SIDE_JOBS[id];
    if (!job || world.missions.active) return false;
    startMission(world, job, id);
    return true;
  };
  world.startStory = () => {
    const story = nextStory(world);
    if (!story || world.missions.active) return false;
    startMission(world, story, null);
    return true;
  };

  /** A hostile pedestrian: a street thug who shoots at the player. Reuses the cop AI. */
  world.spawnHostile = (x, y, leader) => {
    const rnd = world.rnd;
    const ped = {
      id: 80000 + Math.floor(rnd.next() * 19000),
      x,
      y,
      angle: rnd.angle(),
      vx: 0,
      vy: 0,
      radius: 9,
      speed: 100,
      state: 'panic',
      panic: 999,
      dead: false,
      deadTimer: 0,
      health: leader ? 110 : 60,
      cop: false,
      hostile: true,
      skin: rnd.pick(['#c98f66', '#8d5b3c', '#e8c3a0', '#6d442c']),
      shirt: leader ? '#2b2b33' : rnd.pick(['#3a465a', '#5a4a3a', '#2e2e36']),
      pants: '#2e2e36',
      hair: '#151517',
      top: 'casual',
      bottom: 'pants',
      hat: null,
      bag: false,
      phase: 0,
      walkPhase: 0,
      speedNow: 0,
      aimTimer: 0,
      shootCooldown: rnd.range(0.5, 1.6),
      muzzle: 0,
      alert: 5,
      hurtTimer: 0,
      downTime: 0,
      mark: null,
      leader: !!leader,
    };
    world.peds.push(ped);
    return ped;
  };

  /** A bribe: clear the stars for cash, if the player can afford it. */
  world.bribe = () => {
    const cost = 500 * world.police.stars;
    if (world.police.stars === 0 || world.player.money < cost) return false;
    world.player.money -= cost;
    world.police.stars = 0;
    world.police.heat = 0;
    for (const u of world.police.units) {
      u.state = 'released';
      u.car.siren = 0;
    }
    world.police.units.length = 0;
    for (const c of world.police.footCops) c.chase = false;
    world.showToast('Bribe paid', `-$${cost.toLocaleString('en-US')}`, 'The heat looks the other way', 'info');
    world.audio.play('cash');
    return true;
  };

  // ---------------------------------------------------------------- collision
  world.resolvePlayerWorld = () => {
    const p = world.player;
    if (p.inCar) return;
    // Buildings.
    const solids = world.city.solidsNear(p.x, p.y, 60);
    for (const s of solids) {
      const push = circleRectPush(p.x, p.y, p.radius, s);
      if (push) {
        p.x = push.x;
        p.y = push.y;
        const dot = p.vx * push.nx + p.vy * push.ny;
        if (dot < 0) {
          p.vx -= push.nx * dot;
          p.vy -= push.ny * dot;
        }
      }
    }
    // Cars (they are not solid enough to walk through).
    for (const car of world.cars) {
      const r = carRadius(car) * 0.78;
      const d = Math.hypot(p.x - car.x, p.y - car.y);
      if (d < r + p.radius && d > 0.0001) {
        const push = r + p.radius - d;
        p.x += ((p.x - car.x) / d) * push;
        p.y += ((p.y - car.y) / d) * push;
      }
    }
    // Peds bump.
    for (const ped of world.peds) {
      if (ped.dead) continue;
      const d = Math.hypot(p.x - ped.x, p.y - ped.y);
      const min = p.radius + ped.radius;
      if (d < min && d > 0.0001) {
        const push = (min - d) * 0.6;
        p.x += ((p.x - ped.x) / d) * push;
        p.y += ((p.y - ped.y) / d) * push;
      }
    }
    // The seawall and the map edge.
    const b = world.city.bounds;
    p.x = clamp(p.x, b.x0 + 14, b.x1 - 14);
    p.y = clamp(p.y, b.y0 + 14, b.y1 - 14);
    if (p.x < world.city.shoreX + 8) p.x = world.city.shoreX + 8;
  };

  world.resolvePedWorld = (ped) => {
    const solids = world.city.solidsNear(ped.x, ped.y, 40);
    for (const s of solids) {
      const push = circleRectPush(ped.x, ped.y, ped.radius, s);
      if (push) {
        ped.x = push.x;
        ped.y = push.y;
      }
    }
    const b = world.city.bounds;
    ped.x = clamp(ped.x, b.x0 + 14, b.x1 - 14);
    ped.y = clamp(ped.y, b.y0 + 14, b.y1 - 14);
    if (ped.x < world.city.shoreX + 6) ped.x = world.city.shoreX + 6;
  };

  world.resolveCarWorld = (car) => {
    // Circle push out of buildings plus corner probes for a firmer feel.
    const solids = world.city.solidsNear(car.x, car.y, 70);
    for (const s of solids) {
      const r = CAR.radius * 0.92 * (car.model.len ?? 1);
      const push = circleRectPush(car.x, car.y, r, s);
      if (push) {
        const speedBefore = Math.hypot(car.vx, car.vy);
        car.x = push.x;
        car.y = push.y;
        const dot = car.vx * push.nx + car.vy * push.ny;
        if (dot < 0) {
          car.vx -= push.nx * dot * 1.5;
          car.vy -= push.ny * dot * 1.5;
          if (speedBefore > 90 && (car.impact ?? 0) <= 0) {
            car.impact = speedBefore;
            world.audio.play('crash', { x: car.x, y: car.y, volume: Math.min(0.7, speedBefore / 500) });
            damageCar(world, car, speedBefore * 0.06, 'wall');
          }
        }
      }
    }
    // Other cars: hard, bouncy, and only resolved once per pair (the lower id does the work).
    for (const other of world.cars) {
      if (other === car) continue;
      const rA = carRadius(car) * 0.8;
      const rB = carRadius(other) * 0.8;
      const dx = other.x - car.x;
      const dy = other.y - car.y;
      const d2 = dx * dx + dy * dy;
      const min = rA + rB;
      if (d2 > min * min || d2 < 0.0001) continue;
      const d = Math.sqrt(d2);
      const overlap = (min - d) * 0.5;
      const nx = dx / d;
      const ny = dy / d;
      car.x -= nx * overlap;
      car.y -= ny * overlap;
      other.x += nx * overlap;
      other.y += ny * overlap;
      const rel = (car.vx - other.vx) * nx + (car.vy - other.vy) * ny;
      if (rel > 60) {
        const j = rel * 0.55;
        car.vx -= nx * j;
        car.vy -= ny * j;
        other.vx += nx * j * 0.7;
        other.vy += ny * j * 0.7;
        const hitX = (car.x + other.x) / 2;
        const hitY = (car.y + other.y) / 2;
        world.burstSparks(hitX, hitY, 8, Math.atan2(ny, nx));
        world.audio.play('crash', { x: hitX, y: hitY, volume: Math.min(0.55, rel / 400) });
        damageCar(world, car, rel * 0.04, 'car');
        damageCar(world, other, rel * 0.03, 'car');
        if (car.occupiedByPlayer) world.camera.shake(Math.min(8, rel * 0.02));
        if (other.police && car.occupiedByPlayer) world.raiseWanted(0.1, 'ram');
      }
    }
    // Pedestrians: push them out; at speed they get hurt (handled in updatePeds).
    const b = world.city.bounds;
    car.x = clamp(car.x, b.x0 + 20, b.x1 - 20);
    car.y = clamp(car.y, b.y0 + 20, b.y1 - 20);
    if (car.x < world.city.shoreX + 10) {
      car.x = world.city.shoreX + 10;
      car.vx = Math.abs(car.vx) * 0.3;
    }
  };

  /** Put the player back on their feet at the hospital after a death. */
  world.respawnPlayer = () => {
    const p = world.player;
    const h = world.city.poi.hospital;
    p.dead = false;
    p.health = 70;
    p.armour = 0;
    p.inCar = null;
    p.x = h.x - 90;
    p.y = h.y + 70;
    p.vx = 0;
    p.vy = 0;
    p.hitFlash = 0;
    p.money = Math.max(0, p.money - 150);
    world.camera.snap(p.x, p.y, 1);
    world.police.stars = 0;
    world.police.heat = 0;
    world.police.units.length = 0;
    world.missions.cooldown = 3;
    if (world.missions.active) failMission(world, 'died');
    world.showToast('Patched up', 'Bayview General', 'Hospital bill: $150', 'bad');
  };

  // ---------------------------------------------------------------- population
  resetPopulation();
  return world;
}

/** Fill the streets: parked cars, moving traffic and a crowd. Called at boot and on New Game. */
function resetPopulation() {
  // This is deliberately a stub-like seam: createWorld fills the lists, but a fresh game re-runs
  // fillWorld so the same code path handles both.
}

export function fillWorld(world) {
  world.cars.length = 0;
  world.peds.length = 0;
  world.bullets.length = 0;
  world.pickups.length = 0;
  world.missionCars.length = 0;
  populateParked(world);
  populateTraffic(world, world.trafficTarget);
  populatePeds(world, world.pedTarget);
  world.refreshOffers();
}

/** Spawn a pickup (health, armour, ammo, cash) in the world. */
export function spawnPickup(world, x, y, kind, value) {
  const def = PICKUP_KINDS[kind];
  if (!def) return null;
  const p = {
    x,
    y,
    kind,
    value: value ?? (kind === 'cash' ? 40 + Math.floor(world.rnd.next() * 60) : 0),
    life: kind === 'cash' ? 26 : 30,
    bob: world.rnd.range(0, 6.28),
    radius: def.radius,
    color: def.color,
  };
  world.pickups.push(p);
  return p;
}

/** Collect a pickup the player is standing on. */
function updatePickups(world, dt) {
  const p = world.player;
  for (let i = world.pickups.length - 1; i >= 0; i -= 1) {
    const pk = world.pickups[i];
    pk.life -= dt;
    pk.bob += dt * 2.4;
    if (pk.life <= 0) {
      world.pickups.splice(i, 1);
      continue;
    }
    if (Math.hypot(p.x - pk.x, p.y - pk.y) < 22 && !p.dead) {
      applyPickup(world, pk);
      world.pickups.splice(i, 1);
    }
  }
}

function applyPickup(world, pk) {
  const p = world.player;
  switch (pk.kind) {
    case 'health':
      p.health = Math.min(PLAYER.maxHealth, p.health + 34);
      world.showToast('Health', '', '+34', 'good');
      break;
    case 'armour':
      p.armour = Math.min(PLAYER.maxArmour, p.armour + 40);
      world.showToast('Armour', '', '+40', 'good');
      break;
    case 'ammo': {
      const hasPistol = p.hasWeapon.pistol;
      if (!hasPistol) {
        p.hasWeapon.pistol = true;
        p.ammo.pistol = Math.min(WEAPONS.pistol.maxAmmo, 18);
      } else {
        p.ammo.pistol = Math.min(WEAPONS.pistol.maxAmmo, p.ammo.pistol + 12);
        if (p.hasWeapon.smg) p.ammo.smg = Math.min(WEAPONS.smg.maxAmmo, p.ammo.smg + 20);
      }
      world.showToast('Ammo', '', '+12 rounds', 'good');
      break;
    }
    case 'cash':
      payPlayer(p, pk.value);
      world.stats.earned += pk.value;
      world.showToast('Cash', '', `+$${pk.value}`);
      break;
    default:
      break;
  }
  world.audio.play(pk.kind === 'cash' ? 'cash' : 'pickup');
  world.burstPickup(pk.x, pk.y);
}

/** Bullets: swept against solids, bodies and the player, then despawn. */
function updateBullets(world, dt) {
  const p = world.player;
  for (let i = world.bullets.length - 1; i >= 0; i -= 1) {
    const b = world.bullets[i];
    b.life -= dt;
    b.tracer = Math.min(1, b.tracer + dt * 8);
    if (b.life <= 0) {
      world.bullets.splice(i, 1);
      continue;
    }
    const step = b.speed * dt;
    const dx = Math.cos(b.angle) * step;
    const dy = Math.sin(b.angle) * step;
    const nx = b.x + dx;
    const ny = b.y + dy;
    let hit = null;

    // Solids (buildings, seawall posts are not solid).
    for (const s of world.city.solidsNear((b.x + nx) / 2, (b.y + ny) / 2, 80)) {
      const t = rayRect(b.x, b.y, dx, dy, s);
      if (t < 1) {
        hit = { kind: 'wall', x: b.x + dx * t, y: b.y + dy * t, t };
        break;
      }
    }
    // Cars.
    if (!hit) {
      for (const car of world.cars) {
        if (car.wrecked) continue;
        const r = carRadius(car) * 0.62;
        const toCar = Math.hypot(car.x - b.x, car.y - b.y);
        if (toCar > step + r) continue;
        const t = rayCircle(b.x, b.y, dx, dy, car.x, car.y, r);
        if (t !== null && t < 1) {
          hit = { kind: 'car', car, x: b.x + dx * t, y: b.y + dy * t, t };
          break;
        }
      }
    }
    // Peds and cops.
    if (!hit) {
      for (const ped of world.peds) {
        if (ped.dead) continue;
        const r = ped.radius + 3;
        if (Math.hypot(ped.x - b.x, ped.y - b.y) > step + r) continue;
        const t = rayCircle(b.x, b.y, dx, dy, ped.x, ped.y, r);
        if (t !== null && t < 1) {
          hit = { kind: ped.cop ? 'cop' : 'ped', ped, x: b.x + dx * t, y: b.y + dy * t, t };
          break;
        }
      }
    }
    // The player (only from enemies).
    if (!hit && b.owner !== 'player' && !p.dead) {
      const targetP = p.inCar ? p.inCar : p;
      const r = p.inCar ? carRadius(p.inCar) * 0.7 : p.radius + 3;
      const t = rayCircle(b.x, b.y, dx, dy, targetP.x, targetP.y, r);
      if (t !== null && t < 1) {
        hit = { kind: 'player', x: b.x + dx * t, y: b.y + dy * t, t };
      }
    }

    if (hit) {
      b.x = hit.x;
      b.y = hit.y;
      if (hit.kind === 'wall') {
        world.burstSparks(hit.x, hit.y, 4, b.angle + Math.PI);
        world.particles.spawn('dust', hit.x, hit.y, { life: 0.4, size: 3, grow: 10, color: '#cfc2a6', alpha: 0.5 });
      } else if (hit.kind === 'car') {
        world.burstSparks(hit.x, hit.y, 5, b.angle + Math.PI);
        damageCar(world, hit.car, b.damage, b.owner === 'player' ? 'player' : 'other');
        if (b.owner === 'player' && hit.car.police) world.raiseWanted(0.2, 'gunfire');
      } else if (hit.kind === 'ped' || hit.kind === 'cop') {
        world.hurtPed(hit.ped, b.damage, 'bullet');
        bloodSpray(world.particles, hit.x, hit.y, b.angle, 7, world.rnd);
        if (b.owner === 'player') world.showToast('', '', '');
      } else if (hit.kind === 'player') {
        hurtPlayer(p, b.damage, 'gun');
        world.audio.play('thud', { x: p.x, y: p.y, volume: 0.4 });
        world.camera.shake(4);
      }
      world.bullets.splice(i, 1);
      continue;
    }
    b.x = nx;
    b.y = ny;
  }
}

function rayCircle(ox, oy, dx, dy, cx, cy, r) {
  const fx = ox - cx;
  const fy = oy - cy;
  const a = dx * dx + dy * dy;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t1 = (-b - sq) / (2 * a);
  if (t1 >= 0 && t1 <= 1) return t1;
  const t2 = (-b + sq) / (2 * a);
  if (t2 >= 0 && t2 <= 1) return t2;
  return null;
}

/** Burn a wrecked car to an explosion, then leave a burnt shell. */
function updateWrecks(world, dt) {
  for (let i = world.cars.length - 1; i >= 0; i -= 1) {
    const car = world.cars[i];
    if (!car.wrecked) continue;
    car.siren = 0;
    if (car.burning > 0) {
      car.burning -= dt;
      if (world.rnd.chance(dt * 22)) {
        world.particles.spawn('smoke', car.x + world.rnd.range(-8, 8), car.y + world.rnd.range(-8, 8), {
          vx: world.rnd.range(-10, 10),
          vy: -30 - world.rnd.next() * 20,
          life: 1.2,
          size: 7,
          grow: 22,
          color: '#4a453f',
          alpha: 0.4,
          drag: 1,
        });
      }
      if (world.rnd.chance(dt * 14)) {
        world.particles.spawn('spark', car.x + world.rnd.range(-8, 8), car.y + world.rnd.range(-8, 8), { vx: 0, vy: -20, life: 0.3, size: 2.4, color: '#ffb347' });
      }
      if (car.burning <= 0) {
        explosion(world.particles, car.x, car.y, world.rnd);
        world.audio.play('explosion', { x: car.x, y: car.y, volume: 0.9 });
        world.camera.shake(14);
        const d = Math.hypot(world.player.x - car.x, world.player.y - car.y);
        if (d < 130 && !world.player.dead) {
          hurtPlayer(world.player, 45 * (1 - d / 130), 'explosion');
        }
        panicAround(world, car.x, car.y, 420, 7);
        if (car.occupiedByPlayer) {
          world.player.inCar = null;
          car.occupiedByPlayer = false;
          world.player.x = car.x + 26;
          world.player.y = car.y + 26;
        }
        car.exploded = true;
      }
    }
  }
}

/** The fixed simulation step. `controls` is the player control object (input or autopilot). */
export function stepWorld(world, controls, dt) {
  world.clock += dt;
  world.time = (world.time + dt * 24) % 86400; // a game day is 24 real minutes
  world.recentGunfire = Math.max(0, world.recentGunfire - dt);
  if (world.bigMessageTimer > 0) world.bigMessageTimer -= dt;
  if (world.toast) {
    world.toast.life -= dt;
    if (world.toast.life <= 0) world.toast = null;
  }

  // The player, then everything else.
  updatePlayer(world, controls, dt);

  // Traffic: AI for every car without a player at the wheel.
  const px = world.player.x;
  const py = world.player.y;
  for (const car of world.cars) {
    if (car.occupiedByPlayer) continue;
    if (car.parked) continue;
    if (car.dead) continue;
    if (car.path || car.speed > 0 || dist2(car.x, car.y, px, py) < 900 * 900) {
      if (car.unit && car.unit.state !== 'released') continue; // police drive themselves
      driveTraffic(car, dt, world);
    }
  }

  // Pedestrians, the crowd around the player first.
  updatePeds(world, dt);
  topUpPeds(world, world.pedTarget, dt);
  topUpTraffic(world, world.trafficTarget, dt);

  // Police and bullets.
  if (!world.scripted) updatePolice(world, dt);
  updateBullets(world, dt);
  updatePickups(world, dt);
  updateWrecks(world, dt);

  // Particles.
  world.particles.update(dt);
  // Ring decals fade from the list.
  for (let i = world.decals.length - 1; i >= 0; i -= 1) {
    world.decals[i].life -= dt;
    if (world.decals[i].life <= 0) world.decals.splice(i, 1);
  }

  // Tyre smoke from every sliding car near the camera.
  for (const car of world.cars) {
    if (car.wrecked) continue;
    const sliding = (car.slip ?? 0) > 0.35 || (car.brakeLight && car.speed > 190);
    if (!sliding) continue;
    if (dist2(car.x, car.y, px, py) > 800 * 800) continue;
    if (world.rnd.chance(dt * 40)) tyreSmoke(world.particles, car.x, car.y, car.angle, Math.min(1, car.speed / 300), world.rnd);
  }

  // Footstep dust.
  if (world.player.sprinting && world.player.moving && world.rnd.chance(dt * 12)) {
    footDust(world.particles, world.player.x, world.player.y - 2, world.rnd);
  }

  // Missions.
  updateMissions(world, dt);

  // Distance travelled, for the statistics.
  const moved = Math.hypot(world.player.x - world.lastPlayerPos.x, world.player.y - world.lastPlayerPos.y);
  if (moved < 240) world.stats.distance += moved;
  world.lastPlayerPos.x = world.player.x;
  world.lastPlayerPos.y = world.player.y;

  // The camera follows whatever the player is doing.
  const pose = playerPose(world.player);
  const speedNow = world.player.inCar ? Math.abs(world.player.inCar.speed) : Math.hypot(world.player.vx, world.player.vy);
  updateCamera(world.camera, { x: pose.x, y: pose.y, angle: world.player.inCar ? pose.angle : world.player.aiming ? world.player.aimAngle : world.player.angle, speed: speedNow }, dt, {
    foot: !world.player.inCar,
    speed: speedNow,
    aiming: world.player.aiming,
  });
  world.audio.setListener(world.player.x, world.player.y);
  if (!world.player.inCar) world.audio.silenceEngine();
  world.audio.musicTick(dt);

  // Walk into the garage marker to start the next story job.
  if (!world.missions.active && world.missions.cooldown <= 0) {
    const poi = world.city.poi.safehouse;
    if (Math.hypot(world.player.x - poi.x, world.player.y - poi.y) < 46) {
      world.startStory();
    }
  }

  // Dying in a car leaves it where it stopped.
  if (world.player.dead && world.player.inCar) {
    const car = world.player.inCar;
    car.occupiedByPlayer = false;
    world.player.inCar = null;
  }
}

/** Sideline: a pedestrian spills their coffee when you run past. Small quality of life. */
export function nudgePed(world, ped, x, y) {
  ped.state = 'panic';
  ped.panic = 2.4;
  ped.fleeAngle = Math.atan2(ped.y - y, ped.x - x);
  world.audio.play('horn', { x: ped.x, y: ped.y, volume: 0.05 });
}

export { STORY, SIDE_JOBS, missionObjective, nextStory, startMission, advanceStage, isChased, CAR, GRID, VIEW, POLICE, WEAPONS, hash01, lerp, angleDiff, splash };
