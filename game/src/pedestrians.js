// Pedestrians: people who walk a block's perimeter, cross at the corner, and scatter when a gun
// goes off. The same record type serves civilians and cops on foot, so one renderer draws both and
// one damage path handles both; what differs is the AI's chosen target and the uniform.
//
// A ped is a small state machine: walk -> panic (flee) -> down. Cops add: pursue -> shoot -> down.

import { PLAYER, POLICE } from './config.js';
import { damageCar } from './police.js';
import { angleDiff, clamp, dist2, lerp, turnToward } from './util.js';

let nextPedId = 1;

const SKIN = ['#e8c3a0', '#c98f66', '#8d5b3c', '#f0d3b4', '#6d442c', '#d9a97f'];
const SHIRT = ['#e4544a', '#3f8f8f', '#f0b73f', '#4a6f9c', '#f2e6cc', '#8a5a8f', '#5f8f5a', '#d97a3f', '#2e3a4a', '#c9553f'];
const PANTS = ['#3a465a', '#5a4a3a', '#2e2e36', '#7a6a52', '#404a5a', '#63533f'];
const HAIR = ['#2a1d14', '#4a3120', '#151517', '#7a5a3a', '#c9b18a', '#8d8d8d'];

const LOOKS = [
  ['casual', 'skirt'],
  ['shirt', 'shorts'],
  ['suit', 'pants'],
  ['tank', 'shorts'],
  ['casual', 'pants'],
  ['dress', 'legs'],
];

/** A civilian or cop on foot. `block` is the city block it patrols; `path` the perimeter loop. */
export function makePed(rnd, x, y, opts = {}) {
  const cop = !!opts.cop;
  const look = rnd.pick(LOOKS);
  return {
    id: nextPedId++,
    x,
    y,
    angle: opts.angle ?? rnd.angle(),
    vx: 0,
    vy: 0,
    radius: 9,
    speed: cop ? 118 : rnd.range(46, 74),
    state: 'walk',
    dead: false,
    deadTimer: 0,
    health: cop ? POLICE.officerHealth : 30,
    cop,
    skin: rnd.pick(SKIN),
    shirt: cop ? POLICE.carStripe : rnd.pick(SHIRT),
    pants: cop ? '#26355f' : rnd.pick(PANTS),
    hair: rnd.pick(HAIR),
    top: cop ? 'uniform' : look[0],
    bottom: cop ? 'pants' : look[1],
    hat: cop ? 'cap' : rnd.chance(0.15) ? 'brim' : null,
    bag: !cop && rnd.chance(0.12),
    phase: rnd.range(0, 6.28),
    block: opts.block ?? null,
    path: opts.path ?? null,
    pathIndex: rnd.int(0, 3),
    pathT: 0,
    dirSign: rnd.chance(0.5) ? 1 : -1,
    panic: 0,
    hurtTimer: 0,
    walkPhase: rnd.range(0, 6.28),
    speedNow: 0,
    // Cop-only fields.
    aimTimer: 0,
    shootCooldown: rnd.range(0.4, 1.2),
    muzzle: 0,
    target: null,
    alert: 0,
    // Whether this ped counts as a mission target (a hit contract).
    mark: opts.mark ?? null,
    downTime: 0,
  };
}

/** The four corners of a block's walking perimeter, as a closed loop with arc-length helpers. */
export function blockWalk(block) {
  const pts = block.perimeter;
  const segs = [];
  let total = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    segs.push({ a, b, len, start: total });
    total += len;
  }
  return { segs, total };
}

/** Point at arc length s on a block's perimeter, plus its tangent. */
function walkPoint(walk, s) {
  const d = ((s % walk.total) + walk.total) % walk.total;
  for (const seg of walk.segs) {
    if (d <= seg.start + seg.len) {
      const t = (d - seg.start) / seg.len;
      return {
        x: seg.a.x + (seg.b.x - seg.a.x) * t,
        y: seg.a.y + (seg.b.y - seg.a.y) * t,
        angle: Math.atan2(seg.b.y - seg.a.y, seg.b.x - seg.a.x),
      };
    }
  }
  const last = walk.segs[walk.segs.length - 1];
  return { x: last.b.x, y: last.b.y, angle: Math.atan2(last.b.y - last.a.y, last.b.x - last.a.x) };
}

/** Put `count` pedestrians on the blocks around a point, a few per block. */
export function populatePeds(world, count) {
  const city = world.city;
  const rnd = world.rnd;
  let placed = 0;
  let guard = 0;
  const walks = new Map();
  while (placed < count && guard < count * 40) {
    guard += 1;
    const block = rnd.pick(city.blocks);
    if (block.kind === 'park' && rnd.chance(0.5)) {
      // A walker in the park's open lawn.
      const x = block.x + rnd.range(30, block.w - 30);
      const y = block.y + rnd.range(30, block.h - 30);
      if (dist2(x, y, world.player.x, world.player.y) < 160 * 160) continue;
      world.peds.push(makePed(rnd, x, y, {}));
      world.peds[world.peds.length - 1].loiter = { home: { x, y }, radius: rnd.range(24, 60), angle: rnd.angle() };
      placed += 1;
      continue;
    }
    let walk = walks.get(block);
    if (!walk) {
      walk = blockWalk(block);
      walks.set(block, walk);
    }
    const s = rnd.range(0, walk.total);
    const pt = walkPoint(walk, s);
    // Crowd the blocks around the player's spawn: an evenly scattered city looks empty at the
    // camera's zoom, while a dense local pocket reads as a living street.
    const dp = dist2(pt.x, pt.y, world.player.x, world.player.y);
    if (dp < 90 * 90 || dp > 1300 * 1300) continue;
    const ped = makePed(rnd, pt.x, pt.y, { block, angle: pt.angle });
    ped.walk = walk;
    ped.pathS = s;
    world.peds.push(ped);
    placed += 1;
  }
}

/** Keep the streets peopled: top up near the player, out of sight, now and then. */
export function topUpPeds(world, target, dt) {
  world.pedTimer = (world.pedTimer ?? 0) + dt;
  if (world.pedTimer < 0.4) return;
  world.pedTimer = 0;
  const city = world.city;
  const rnd = world.rnd;
  const alive = world.peds.filter((p) => !p.dead);
  if (alive.length >= target) {
    // Over target: retire the peds furthest from the camera so the crowd stays local and cheap.
    if (alive.length <= target + 12) return;
    const px = world.player.x;
    const py = world.player.y;
    let worst = null;
    let wd = 0;
    for (const p of alive) {
      if (dist2(p.x, p.y, px, py) > 1400 * 1400) {
        const d = dist2(p.x, p.y, px, py);
        if (d > wd) {
          wd = d;
          worst = p;
        }
      }
    }
    if (worst) world.peds.splice(world.peds.indexOf(worst), 1);
    return;
  }
  // The crowd should be visible where the player is standing, not scattered across the map.
  for (let tries = 0; tries < 14; tries += 1) {
    const block = rnd.pick(city.blocks);
    const walk = blockWalk(block);
    const s = rnd.range(0, walk.total);
    const pt = walkPoint(walk, s);
    const dp = dist2(pt.x, pt.y, world.player.x, world.player.y);
    if (dp < 120 * 120 || dp > 900 * 900) continue;
    const ped = makePed(rnd, pt.x, pt.y, { block, angle: pt.angle });
    ped.walk = walk;
    ped.pathS = s;
    world.peds.push(ped);
    return;
  }
}

/** Someone nearby saw or heard something and runs. */
export function panicAround(world, x, y, radius, dur = 4) {
  for (const ped of world.peds) {
    if (ped.dead || ped.cop) continue;
    if (dist2(ped.x, ped.y, x, y) < radius * radius) {
      ped.state = 'panic';
      ped.panic = Math.max(ped.panic, dur + world.rnd.range(0, 1.5));
      ped.fleeAngle = Math.atan2(ped.y - y, ped.x - x) + world.rnd.range(-0.7, 0.7);
    }
  }
}

/** Advance every pedestrian. `noise` is the player's last loud act, if any. */
export function updatePeds(world, dt) {
  const p = world.player;
  const px = p.x;
  const py = p.y;
  const danger = p.wanted > 0 || world.recentGunfire > 0;
  for (const ped of world.peds) {
    if (ped.dead) {
      ped.downTime += dt;
      continue;
    }
    ped.hurtTimer = Math.max(0, ped.hurtTimer - dt);
    ped.walkPhase += dt * (ped.speedNow / 16);
    // On foot cops are driven by police.js; civilians here.
    if (ped.cop) continue;

    const dp2 = dist2(ped.x, ped.y, px, py);
    if (danger && dp2 < 200 * 200 && ped.state === 'walk') {
      ped.state = 'panic';
      ped.panic = 3.5;
      ped.fleeAngle = Math.atan2(ped.y - py, ped.x - px) + world.rnd.range(-0.5, 0.5);
    }
    if (ped.state === 'panic') {
      ped.panic -= dt;
      if (ped.panic <= 0) {
        ped.state = 'walk';
        ped.fleeAngle = undefined;
      }
      const spd = ped.cop ? 130 : 150;
      const a = ped.fleeAngle ?? ped.angle;
      ped.vx = Math.cos(a) * spd;
      ped.vy = Math.sin(a) * spd;
      ped.angle = turnToward(ped.angle, a, 6 * dt);
      ped.speedNow = spd;
    } else if (ped.loiter) {
      // Wander in a small circle in the park.
      ped.loiter.angle += world.rnd.range(-0.6, 0.6) * dt;
      const spd = 30;
      ped.vx = Math.cos(ped.loiter.angle) * spd;
      ped.vy = Math.sin(ped.loiter.angle) * spd;
      ped.angle = ped.loiter.angle;
      ped.speedNow = spd;
      const dx = ped.x - ped.loiter.home.x;
      const dy = ped.y - ped.loiter.home.y;
      if (Math.hypot(dx, dy) > ped.loiter.radius) ped.loiter.angle = Math.atan2(-dy, -dx);
    } else if (ped.walk) {
      ped.pathS += ped.speed * ped.dirSign * dt;
      const pt = walkPoint(ped.walk, ped.pathS);
      const desired = Math.atan2(pt.y - ped.y, pt.x - ped.x);
      ped.angle = turnToward(ped.angle, Math.atan2(pt.y - ped.y, pt.x - ped.x), 5 * dt);
      ped.vx = Math.cos(ped.angle) * ped.speed;
      ped.vy = Math.sin(ped.angle) * ped.speed;
      ped.speedNow = ped.speed;
      // Face along the perimeter rather than at the next point (no jitter on corners).
      if (Math.abs(angleDiff(ped.angle, pt.angle)) < 0.4) ped.angle = turnToward(ped.angle, pt.angle, 6 * dt);
      void desired;
    } else {
      ped.speedNow = 0;
      ped.vx = 0;
      ped.vy = 0;
    }
    ped.x += ped.vx * dt;
    ped.y += ped.vy * dt;
    // Cars push pedestrians out of the way (and knock them down at speed).
    for (const car of world.cars) {
      if (car.speed < 20) continue;
      if (dist2(car.x, car.y, ped.x, ped.y) > 70 * 70) continue;
      if (dist2(car.x, car.y, ped.x, ped.y) < 24 * 24 && !ped.dead) {
        const hit = car.speed > 190;
        if (hit) {
          world.hurtPed(ped, 40 + car.speed * 0.12, 'car');
          world.burstHit(ped.x, ped.y);
          world.camera.shake(7);
        } else {
          ped.state = 'panic';
          ped.panic = 3;
          ped.fleeAngle = Math.atan2(ped.y - car.y, ped.x - car.x);
        }
      }
    }
    // Keep civilians out of the water.
    if (ped.x < world.city.shoreX + 4 && !ped.cop) ped.x = world.city.shoreX + 4;
  }
  // Drop the dead after a while, and drop far-away peds to keep the list small.
  if (world.peds.length > 200) {
    world.peds = world.peds.filter((ped) => !ped.dead && dist2(ped.x, ped.y, px, py) < 1800 * 1800);
  }
}

/** Knock a pedestrian down (non-lethal) when they are hit by a car at low speed or a fist. */
export function knockDown(world, ped, duration = 2.2) {
  ped.dead = false;
  ped.state = 'down';
  ped.downTime = 0;
  ped.downFor = duration;
  world.audio.play('thud', { x: ped.x, y: ped.y, volume: 0.4 });
}

/** Cops on foot: 'idle' at their post, then chase and shoot once the heat is on. */
export function makeCop(rnd, x, y, opts = {}) {
  const ped = makePed(rnd, x, y, { cop: true, ...opts });
  ped.state = 'walk';
  ped.alert = 0;
  ped.speed = 120;
  return ped;
}

/** One cop's turn: approach the player and fire when in range and line of sight. */
export function updateCop(world, cop, dt) {
  const p = world.player;
  if (cop.dead) return;
  cop.shootCooldown -= dt;
  cop.muzzle = Math.max(0, cop.muzzle - dt * 8);
  const dx = p.x - cop.x;
  const dy = p.y - cop.y;
  const d = Math.hypot(dx, dy);
  const wanted = p.wanted;
  if (wanted <= 0) {
    cop.alert = Math.max(0, cop.alert - dt);
    // Fall back to a patrol walk.
    if (cop.walk && cop.state !== 'walk') cop.state = 'walk';
    return;
  }
  // Chase to a comfortable firing range.
  const desired = Math.atan2(dy, dx);
  cop.angle = turnToward(cop.angle, desired, 8 * dt);
  const range = 150 + Math.min(3, wanted) * 12;
  let move = 0;
  if (d > range) move = 1;
  else if (d < range * 0.55) move = -0.7;
  const spd = 128;
  cop.vx = Math.cos(cop.angle) * spd * move;
  cop.vy = Math.sin(cop.angle) * spd * move;
  cop.speedNow = Math.abs(spd * move);
  cop.x += cop.vx * dt;
  cop.y += cop.vy * dt;
  cop.walkPhase += dt * (Math.abs(move) * 8);
  // Stay on dry land and out of buildings.
  world.resolvePedWorld(cop);

  // Fire, with a little inaccuracy that tightens as the heat rises.
  if (d < POLICE.officerRange && cop.shootCooldown <= 0 && !p.dead) {
    const spread = 0.16 - Math.min(4, wanted) * 0.015;
    const a = desired + (world.rnd.next() - 0.5) * spread * 2;
    world.spawnBullet({ x: cop.x + Math.cos(a) * 14, y: cop.y + Math.sin(a) * 14, angle: a, speed: 1500, damage: POLICE.officerDamage, range: 500, owner: 'cop' });
    cop.muzzle = 1;
    cop.shootCooldown = POLICE.officerRate * (0.75 + world.rnd.next() * 0.5);
    world.audio.play('pistol', { x: cop.x, y: cop.y, volume: 0.4 });
    world.muzzleFlash(cop.x + Math.cos(a) * 14, cop.y + Math.sin(a) * 14, a, 'pistol');
  }
}

/** Deal damage to a cop; raises heat and notifies the police system. */
export function hurtCop(world, cop, amount) {
  if (cop.dead) return;
  cop.health -= amount;
  cop.hurtTimer = 0.3;
  cop.alert = 6;
  if (cop.health <= 0) {
    cop.dead = true;
    cop.state = 'down';
    cop.deadTimer = 0;
    world.onCopDown?.(cop);
  } else {
    world.onCopHit?.(cop);
  }
}

/** Deal damage to a pedestrian; a marked target calls the mission system back. */
export function hurtPed(world, ped, amount, cause) {
  if (ped.dead) return;
  if (ped.cop) {
    hurtCop(world, ped, amount);
    return;
  }
  ped.health -= amount;
  ped.hurtTimer = 0.3;
  ped.state = 'panic';
  ped.panic = 8;
  ped.fleeAngle = Math.atan2(ped.y - world.player.y, ped.x - world.player.x);
  world.onPedHurt?.(ped, cause);
  if (ped.health <= 0) {
    ped.dead = true;
    ped.state = 'down';
    ped.deadTimer = 0;
    world.onPedDown?.(ped, cause);
  }
}

/** A pedestrian's car-door yank: the driver runs away on foot. */
export function ejectDriver(world, car) {
  const rnd = world.rnd;
  const ped = makePed(rnd, car.x - Math.sin(car.angle) * 18, car.y + Math.cos(car.angle) * 18, {});
  ped.state = 'panic';
  ped.panic = 8;
  ped.fleeAngle = Math.atan2(ped.y - world.player.y, ped.x - world.player.x);
  world.peds.push(ped);
  return ped;
}

export { damageCar, PLAYER, clamp };
