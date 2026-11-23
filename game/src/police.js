// The police: the wanted level, the response it buys, and the AI that runs it. Patrol cars spawn on
// the ring of intersections around the player and converge; at three stars they ram, at four they
// set roadblocks, and on foot cops get out and shoot. Heat decays when nobody can see you.
//
// Everything here is driven by `updatePolice`, one call per simulation step from the world.

import { GRID, LANE, POLICE, WANTED } from './config.js';
import { makeCop, updateCop } from './pedestrians.js';
import { driveAlongPath, driveToward, driveTraffic, makePoliceCar, pathTo } from './vehicles.js';
import { angleDiff, clamp, dist2 } from './util.js';

/** Pages of heat, in "crimes": one gunshot is 0.28, a car theft 0.55, a killing 1.1. */
export function crimeWeight(kind) {
  switch (kind) {
    case 'gunfire':
      return 0.3;
    case 'shotCop':
      return 1.4;
    case 'kill':
      return 1.15;
    case 'killCop':
      return 2.0;
    case 'steal':
      return 0.5;
    case 'ram':
      return 0.15;
    case 'trespass':
      return 0.2;
    default:
      return 0.2;
  }
}

export function createPolice() {
  return {
    stars: 0,
    heat: 0,
    seenTimer: 0,
    quietTimer: 0,
    spawnTimer: 0,
    roadblockTimer: 0,
    units: [],
    footCops: [],
    lastCrime: null,
    bustedTimer: 0,
    message: null,
    messageTimer: 0,
    busted: false,
  };
}

/** Add heat and compute the new star count. */
export function addHeat(police, amount) {
  police.heat = Math.min(WANTED.max * 1.4, police.heat + amount);
  const before = police.stars;
  const stars = police.heat >= 1.0 ? Math.min(WANTED.max, 1 + Math.floor((police.heat - 0.85) / 0.85)) : 0;
  police.stars = stars;
  if (stars > before) {
    police.spawnTimer = Math.min(police.spawnTimer, 0.45);
    police.quietTimer = 0;
  }
  return stars;
}

/** The player was seen committing a crime: refresh the chase clock. */
export function witnessed(police) {
  police.seenTimer = WANTED.decayDelay;
  police.quietTimer = 0;
}

/** How many units the level buys. */
export function unitCap(stars) {
  return [0, 2, 3, 4, 5, 6][clamp(stars, 0, 5)];
}

/** Spawn one cruiser at an intersection out of the player's sight, pointed inbound. */
export function spawnUnit(world) {
  const city = world.city;
  const p = world.player;
  const rnd = world.rnd;
  const pKeyI = Math.round(p.x / GRID);
  const pKeyJ = Math.round(p.y / GRID);
  const candidates = [];
  for (let i = 0; i < city.cols; i += 1) {
    for (let j = 0; j < city.rows; j += 1) {
      const node = city.nodes.get(`${i},${j}`);
      const d = Math.hypot(node.x - p.x, node.y - p.y);
      if (d < 620 || d > 1500) continue;
      // Not in view: prefer intersections behind the camera's facing.
      const toPlayer = Math.atan2(p.y - node.y, p.x - node.x);
      const offscreen = Math.abs(angleDiff(world.camera.angle, toPlayer)) > 0.9;
      candidates.push({ node, score: d + (offscreen ? 300 : 0) });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.score - b.score);
  const pick = candidates[Math.min(candidates.length - 1, rnd.int(0, 3))];
  const node = pick.node;
  // Approach along an axis toward the player.
  const dir = Math.abs(node.x - p.x) > Math.abs(node.y - p.y) ? (p.x > node.x ? 'E' : 'W') : p.y > node.y ? 'S' : 'N';
  const off = dir === 'E' ? { x: 0, y: LANE } : dir === 'W' ? { x: 0, y: -LANE } : dir === 'S' ? { x: -LANE, y: 0 } : { x: LANE, y: 0 };
  const car = makePoliceCar(node.x + off.x - (dir === 'E' ? 40 : dir === 'W' ? -40 : 0), node.y + off.y - (dir === 'S' ? 40 : dir === 'N' ? -40 : 0), { E: 0, W: Math.PI, S: Math.PI / 2, N: -Math.PI / 2 }[dir]);
  car.pathDir = dir;
  car.pathKey = `${node.i},${node.j}`;
  car.cruise = 300;
  world.cars.push(car);
  const unit = { car, state: 'pursue', stars: world.police.stars, retarget: 0, copsOut: false, lost: 0, officer: null };
  world.police.units.push(unit);
  car.unit = unit;
  // A second officer rides along at three stars and up.
  car.passengers = world.police.stars >= 3 ? 1 : 0;
  return unit;
}

/** Drop a unit from the chase, but leave its car in traffic (sirens off). */
export function releaseUnit(world, unit) {
  unit.car.unit = null;
  unit.car.police = false;
  unit.car.kind = 'sedan';
  unit.car.siren = 0;
  unit.car.cruise = 170;
  unit.car.pathKey = `${clamp(Math.round(unit.car.x / GRID), 0, world.city.cols - 1)},${clamp(Math.round(unit.car.y / GRID), 0, world.city.rows - 1)}`;
  unit.car.path = null;
  unit.car.pathDir = 'E';
  unit.car.pathKey = null;
  unit.state = 'released';
}

/**
 * The main police update: decay, spawn, and each unit's brain. `dt` is a fixed step.
 * The player's car (if any) is followed by the cruisers, with ramming at three stars and up.
 */
export function updatePolice(world, dt) {
  const pol = world.police;
  const p = world.player;
  const stars = pol.stars;

  // Heat decays when the player has been out of sight for a while.
  const anyNear = pol.units.some((u) => dist2(u.car.x, u.car.y, p.x, p.y) < 520 * 520);
  pol.quietTimer += dt;
  if (stars > 0) {
    pol.seenTimer = Math.max(0, pol.seenTimer - dt);
    if (pol.seenTimer <= 0 && !anyNear) {
      pol.heat = Math.max(0, pol.heat - WANTED.decayRate * dt);
      if (pol.heat < 0.95) {
        pol.stars = 0;
        pol.message = 'You lost the heat';
        pol.messageTimer = 3;
        for (const u of pol.units) releaseUnit(world, u);
        pol.units.length = 0;
        for (const c of pol.footCops) c.chase = false;
        world.onWantedCleared?.();
      } else {
        const next = Math.min(WANTED.max, 1 + Math.floor((pol.heat - 0.85) / 0.85));
        if (next < pol.stars) pol.stars = next;
      }
    }
  }
  pol.messageTimer = Math.max(0, pol.messageTimer - dt);

  // Spawn units up to the cap.
  if (pol.stars > 0) {
    pol.spawnTimer -= dt;
    const active = pol.units.filter((u) => u.state !== 'released').length;
    if (pol.spawnTimer <= 0 && active < unitCap(pol.stars)) {
      spawnUnit(world);
      pol.spawnTimer = WANTED.spawnDelay * (0.7 + world.rnd.next() * 0.6);
    }
  }

  // Each cruiser.
  for (let i = pol.units.length - 1; i >= 0; i -= 1) {
    const unit = pol.units[i];
    const car = unit.car;
    if (unit.state === 'released') {
      // It rejoins traffic and is forgotten.
      if (car.health <= 0) {
        pol.units.splice(i, 1);
        continue;
      }
      driveTraffic(car, dt, world);
      if (dist2(car.x, car.y, p.x, p.y) > 900 * 900) pol.units.splice(i, 1);
      continue;
    }
    car.siren = 1;
    car.lightPhase = (car.lightPhase ?? 0) + dt;
    if (car.health <= 0 || car.wrecked) {
      if (car.burning > 0) {
        // Bail out before the fire reaches the tank.
        bailOut(world, unit);
        pol.units.splice(i, 1);
      }
      continue;
    }
    unit.retarget -= dt;
    const d = Math.hypot(car.x - p.x, car.y - p.y);
    const ram = pol.stars >= 3;

    // Close range: bail out and shoot on foot (on foot, or when the player is on foot).
    const playerOnFoot = !p.inCar;
    if ((playerOnFoot && d < 120) || (d < 70 && pol.stars >= 2)) {
      if (!unit.copsOut) {
        unit.copsOut = true;
        bailOut(world, unit);
      }
    }

    if (d > 900) {
      // Too far to matter; give the unit a new route.
      unit.retarget = 0;
    }
    if (unit.retarget <= 0 || !car.path || (car.path && car.pathRemaining !== undefined && car.pathRemaining < 120)) {
      const lead = p.inCar ? { x: p.x + p.vx * 1.4, y: p.y + p.vy * 1.4 } : { x: p.x, y: p.y };
      pathTo(world, car, lead.x, lead.y, 320 + pol.stars * 22);
      car.cruise = 300 + pol.stars * 20;
      unit.retarget = 1.6 + world.rnd.next() * 0.8;
    }
    // Far and on a clear line: drive straight at the player (cutting corners like a real pursuit).
    const useStraight = d < 260 && pol.stars >= 2;
    if (useStraight) {
      driveToward(car, p.x, p.y, dt, world, { speed: Math.min(300, 140 + d * 1.1) });
      unit.ramming = d < 90 && ram;
    } else if (car.path) {
      driveAlongPath(car, dt, world, { speed: car.cruise });
    } else {
      driveToward(car, p.x, p.y, dt, world, { speed: 220 });
    }
    // Ramming: a head-on nudge that hurts and shoves.
    if (ram && d < 52 && p.inCar && car.speed > 110) {
      const hit = p.inCar;
      const nx = (hit.x - car.x) / Math.max(1, d);
      const ny = (hit.y - car.y) / Math.max(1, d);
      hit.vx += nx * 90;
      hit.vy += ny * 90;
      damageCar(world, hit, 9, 'police');
      world.camera.shake(5);
      world.burstSparks((car.x + hit.x) / 2, (car.y + hit.y) / 2, 10, Math.atan2(ny, nx));
      world.audio.play('crash', { x: car.x, y: car.y, volume: 0.5 });
    }
    // Sirens audible when near.
    if (world.audio) world.audio.siren(car, dt, d);
  }

  // Foot cops.
  for (const cop of pol.footCops) updateCop(world, cop, dt);
  pol.footCops = pol.footCops.filter((c) => !c.dead || c.downTime < 30);
}

/** Officers step out of the cruiser and fight on foot. */
export function bailOut(world, unit) {
  const car = unit.car;
  const rnd = world.rnd;
  const count = 1 + (car.passengers ?? 0);
  for (let i = 0; i < count; i += 1) {
    const side = i === 0 ? 1 : -1;
    const x = car.x - Math.sin(car.angle) * 18 * side + Math.cos(car.angle) * -14;
    const y = car.y + Math.cos(car.angle) * 18 * side + Math.sin(car.angle) * -14;
    const cop = makeCop(rnd, x, y, {});
    cop.chase = true;
    cop.panic = 999;
    cop.state = 'panic';
    cop.fleeAngle = car.angle;
    world.peds.push(cop);
    world.police.footCops.push(cop);
  }
  car.passengers = 0;
  car.parked = true;
  car.cruise = 0;
}

/** A cop died: it drops off the foot list and may raise the heat a notch. */
export function copDowned(world, ped) {
  void ped;
  world.police.footCops = world.police.footCops.filter((c) => !c.dead);
}

/** Ramming the police, shooting them, and the rest all arrive through here. */
export function damageCar(world, car, amount, source = 'player') {
  if (!car || car.wrecked) return;
  car.health -= amount;
  car.hitFlash = 0.2;
  if (car.health <= 0) {
    car.health = 0;
    car.wrecked = true;
    car.burning = 2.4;
    world.camera.shake(9);
    world.audio.play('crash', { x: car.x, y: car.y, volume: 0.7 });
    if (car.unit) {
      const unit = car.unit;
      unit.state = 'released';
    }
    if (source === 'player') {
      world.raiseWanted(crimeWeight(car.police ? 'killCop' : 'kill'), 'wreck');
      world.recordDestruction(car);
    }
    world.burstSparks(car.x, car.y, 16, car.angle);
  }
}

/** The player shot at a cop car: officers get out and the heat rises. */
export function aggroUnit(world, car) {
  if (car.unit) {
    car.unit.retarget = 0;
    return;
  }
  car.police = true;
  car.kind = 'police';
  car.siren = 1;
  car.cruise = 300;
  car.path = null;
  const unit = { car, state: 'pursue', stars: world.police.stars, retarget: 0, copsOut: false, lost: 0, officer: null };
  world.police.units.push(unit);
  car.unit = unit;
}

/** Whether the police are currently after the player at all. */
export function isChased(police) {
  return police.stars > 0;
}
