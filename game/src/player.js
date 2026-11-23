// The player: on foot (walk, sprint, aim, shoot, punch, enter cars) and behind the wheel. Holds
// health, armour, money, the weapon wheel's ammo and the current weapon; every wound, payout and
// ammo pickup funnels through here so the HUD has one source of truth.
//
// The player never reads the keyboard directly; `updatePlayer` takes a control object the boot loop
// builds from input or the screenshot autopilot, so both drive the identical character.

import { CAR, PLAYER, WEAPONS } from './config.js';
import { canSteal, carRadius, driveCar, driveToward, seatOf } from './vehicles.js';
import { angleDiff, clamp, dist2, lerp, turnToward, wrapAngle } from './util.js';

export function createPlayer(x, y, angle = 0) {
  return {
    x,
    y,
    angle,
    vx: 0,
    vy: 0,
    radius: PLAYER.radius,
    health: PLAYER.maxHealth,
    armour: 0,
    money: 350,
    inCar: null,
    seat: -1,
    weapon: 'fists',
    ammo: { fists: Infinity, pistol: 0, smg: 0 },
    hasWeapon: { fists: true, pistol: false, smg: false },
    fireCooldown: 0,
    meleeTimer: 0,
    hitFlash: 0,
    invuln: 0,
    dead: false,
    deathTimer: 0,
    aiming: false,
    aimAngle: 0,
    recoil: 0,
    footstep: 0,
    moving: false,
    sprinting: false,
    lastDamage: 0,
    wanted: 0,
    walletFlash: 0,
    cashFlash: 0,
    aliveTime: 0,
  };
}

/** Damage the player; armour soaks it first. Returns true when the hit landed (for the flash). */
export function hurtPlayer(player, amount, source) {
  if (player.dead) return false;
  const soak = Math.min(player.armour, amount * 0.85);
  player.armour -= soak;
  player.health -= amount - soak;
  player.hitFlash = 1;
  player.invuln = Math.max(player.invuln, PLAYER.invulnAfterHit);
  player.lastDamage = player.lastDamage + amount;
  player.lastHitBy = source ?? 'unknown';
  if (player.health <= 0) {
    player.health = 0;
    player.dead = true;
    player.deathTimer = PLAYER.respawnTime;
  }
  return true;
}

/** Give money with a HUD flash. */
export function payPlayer(player, amount) {
  player.money += amount;
  player.walletFlash = 1;
  if (amount > 0) player.cashFlash = 1;
}

/** The player's world position and facing, whether on foot or driving. */
export function playerPose(player) {
  if (player.inCar) {
    const s = seatOf(player.inCar, 'left');
    return { x: s.x, y: s.y, angle: player.inCar.angle };
  }
  return { x: player.x, y: player.y, angle: player.angle };
}

/** The nearest car the player could get into. */
export function nearestCar(world) {
  const p = world.player;
  if (p.inCar) return null;
  let best = null;
  let bestD = PLAYER.enterRange * PLAYER.enterRange;
  for (const car of world.cars) {
    if (!canSteal(car)) continue;
    const d2 = dist2(p.x, p.y, car.x, car.y);
    const reach = (PLAYER.enterRange + carRadius(car) * 0.2) ** 2;
    if (d2 < reach && d2 < bestD) {
      bestD = d2;
      best = car;
    }
  }
  return best;
}

/** Put the player in a car; a driver is yanked out and panics (the caller raises the heat). */
export function enterCar(world, car) {
  const p = world.player;
  if (!car || p.inCar) return null;
  let ejected = null;
  if (!car.parked && car.driver) {
    ejected = car.driver;
    car.driver = null;
  }
  // Parked cars need no key here: hotwire is instant, the wheels just spin.
  car.parked = false;
  car.path = null;
  p.inCar = car;
  car.playerDriven = true;
  p.x = car.x;
  p.y = car.y;
  return ejected;
}

/** Step out of the car, on the driver's side, clear of the body. */
export function exitCar(world) {
  const p = world.player;
  const car = p.inCar;
  if (!car) return null;
  const side = car.angle + Math.PI / 2;
  const ox = car.x - Math.sin(car.angle) * (CAR.width * 0.5 + 12);
  const oy = car.y + Math.cos(car.angle) * (CAR.width * 0.5 + 12);
  p.x = ox;
  p.y = oy;
  p.angle = side + Math.PI;
  p.inCar = null;
  car.playerDriven = false;
  car.speed = 0;
  p.vx = 0;
  p.vy = 0;
  world.resolvePlayerWorld();
  return car;
}

/** Switch weapons, if owned. */
export function selectWeapon(player, name) {
  if (!player.hasWeapon[name]) return false;
  player.weapon = name;
  player.fireCooldown = Math.max(player.fireCooldown, 0.12);
  return true;
}

/** Cycle to the next owned weapon (mouse wheel). */
export function cycleWeapon(player, dir) {
  const order = ['fists', 'pistol', 'smg'].filter((w) => player.hasWeapon[w]);
  if (order.length < 2) return;
  const i = order.indexOf(player.weapon);
  selectWeapon(player, order[(i + dir + order.length) % order.length]);
}

/** Give ammo (and the weapon itself) for a pickup. */
export function giveAmmo(player, name, amount) {
  const def = WEAPONS[name];
  if (!def) return;
  player.hasWeapon[name] = true;
  player.ammo[name] = Math.min(def.maxAmmo, (player.ammo[name] ?? 0) + amount);
}

/** How much money a wrecked car is worth in parts, for the HUD message. */
export const SCRAP_VALUE = 120;

/**
 * Integrate the player for dt with a control object:
 *   { move: {x,y}, sprint, aim: {x,y}|null, fire, enter, exitCar, weaponSwitch }
 */
export function updatePlayer(world, controls, dt) {
  const p = world.player;
  p.aliveTime += dt;
  p.hitFlash = Math.max(0, p.hitFlash - dt * 2.6);
  p.invuln = Math.max(0, p.invuln - dt);
  p.fireCooldown = Math.max(0, p.fireCooldown - dt);
  p.meleeTimer = Math.max(0, p.meleeTimer - dt);
  p.recoil = Math.max(0, p.recoil - dt * 5);
  p.walletFlash = Math.max(0, p.walletFlash - dt * 1.4);
  p.cashFlash = Math.max(0, p.cashFlash - dt * 1.4);

  if (p.dead) {
    p.deathTimer -= dt;
    if (p.inCar) {
      // Slumped at the wheel: the car rolls to a stop.
      const car = p.inCar;
      driveCar(car, { throttle: 0, brake: 1, steer: 0 }, dt, world);
    }
    if (p.deathTimer <= 0) world.respawnPlayer();
    return;
  }

  if (p.inCar) {
    updateDriving(world, controls, dt);
    return;
  }

  // ---------------------------------------------------------------- on foot
  const speed = controls.sprint ? PLAYER.sprintSpeed : PLAYER.walkSpeed;
  let mx = controls.move.x;
  let my = controls.move.y;
  const mag = Math.hypot(mx, my);
  if (mag > 1) {
    mx /= mag;
    my /= mag;
  }
  // Aiming slows the walk and locks the facing to the cursor.
  const aiming = !!controls.aim;
  p.aiming = aiming;
  if (aiming) {
    p.aimAngle = Math.atan2(controls.aim.y - p.y, controls.aim.x - p.x);
    p.angle = p.aimAngle;
  }
  const targetSpeed = speed * (aiming ? 0.55 : 1);
  const desiredVx = mx * targetSpeed;
  const desiredVy = my * targetSpeed;
  const rate = mag > 0.01 ? PLAYER.accel : PLAYER.accel * 1.4;
  p.vx = lerp(p.vx, desiredVx, 1 - Math.exp((-rate / 120) * dt));
  p.vy = lerp(p.vy, desiredVy, 1 - Math.exp((-rate / 120) * dt));
  if (mag < 0.01) {
    const f = Math.exp(-PLAYER.friction * dt);
    p.vx *= f;
    p.vy *= f;
  }
  p.x += p.vx * dt;
  p.y += p.vy * dt;
  p.moving = Math.hypot(p.vx, p.vy) > 12;
  p.sprinting = controls.sprint && p.moving;
  if (!aiming && p.moving) p.angle = turnToward(p.angle, Math.atan2(p.vy, p.vx), 12 * dt);

  // Footsteps for the audio system.
  if (p.moving) {
    p.footstep += dt * (p.sprinting ? 2.6 : 1.6);
    if (p.footstep >= 1) {
      p.footstep = 0;
      world.audio.play('step', { x: p.x, y: p.y, volume: p.sprinting ? 0.22 : 0.12 });
    }
  } else p.footstep = 0;

  world.resolvePlayerWorld();

  // Enter / exit.
  if (controls.enter) {
    const car = nearestCar(world);
    if (car) {
      world.enterVehicle(car);
      return;
    }
  }

  // Weapons.
  if (controls.weaponSwitch) cycleWeapon(p, controls.weaponSwitch);
  if (controls.fire) tryFire(world);
}

/** Drive the car the player is in. */
function updateDriving(world, controls, dt) {
  const p = world.player;
  const car = p.inCar;
  const drive = car.wrecked ? { throttle: 0, brake: 1, steer: 0 } : {
    throttle: controls.throttle ?? 0,
    brake: controls.brake ?? 0,
    steer: controls.steer ?? 0,
    handbrake: !!controls.handbrake,
  };
  driveCar(car, drive, dt, world);
  p.x = car.x;
  p.y = car.y;
  p.angle = car.angle;
  // The car's engine and tyres.
  world.audio.carLoop(car, dt);
  // A hard impact shakes the camera and sparks.
  if (car.impact && car.impact > 60) {
    world.camera.shake(Math.min(12, car.impact * 0.09));
    world.burstSparks(car.x, car.y, Math.min(14, Math.floor(car.impact / 24)), car.angle);
    car.impact = 0;
  }
  if (controls.fire && p.hasWeapon.pistol) {
    // Drive-by: fire the pistol out of the window.
    tryFire(world, true);
  }
  if (controls.exitCar) world.exitVehicle();
}

/** Fire the current weapon, at the cursor (on foot) or the car's heading (drive-by). */
export function tryFire(world, fromCar = false) {
  const p = world.player;
  const weapon = WEAPONS[p.weapon];
  if (!weapon || p.fireCooldown > 0 || p.dead) return;
  if (weapon.melee) {
    p.fireCooldown = weapon.rate;
    p.meleeTimer = 0.18;
    world.audio.play('whoosh', { x: p.x, y: p.y, volume: 0.3 });
    // Melee hits the nearest pedestrian or cop in a short arc.
    const facing = p.angle;
    let hitSomething = false;
    for (const ped of world.peds) {
      if (ped.dead) continue;
      const d = Math.hypot(ped.x - p.x, ped.y - p.y);
      if (d < PLAYER.punchRange && Math.abs(angleDiff(facing, Math.atan2(ped.y - p.y, ped.x - p.x))) < 1.1) {
        world.hurtPed(ped, weapon.damage, 'melee');
        world.audio.play('punch', { x: p.x, y: p.y, volume: 0.5 });
        world.burstHit(ped.x, ped.y);
        hitSomething = true;
      }
    }
    for (const cop of world.police.footCops) {
      if (cop.dead) continue;
      const d = Math.hypot(cop.x - p.x, cop.y - p.y);
      if (d < PLAYER.punchRange && Math.abs(angleDiff(facing, Math.atan2(cop.y - p.y, cop.x - p.x))) < 1.1) {
        world.hurtCop(cop, weapon.damage + 6);
        world.audio.play('punch', { x: p.x, y: p.y, volume: 0.5 });
        hitSomething = true;
      }
    }
    if (!hitSomething) world.burstMiss(p.x + Math.cos(facing) * 30, p.y + Math.sin(facing) * 30);
    return;
  }
  if (!p.hasWeapon[p.weapon] || p.ammo[p.weapon] <= 0) {
    p.fireCooldown = 0.3;
    world.audio.play('dryfire', { volume: 0.3 });
    return;
  }
  p.ammo[p.weapon] -= 1;
  p.fireCooldown = weapon.rate;
  p.recoil = 1;
  world.camera.shake(p.weapon === 'smg' ? 2.5 : 3.5);
  let angle;
  let muzzle;
  if (fromCar || !p.aiming) {
    angle = fromCar ? p.inCar.angle : p.angle;
    if (!fromCar && !p.aiming) angle = p.aimAngle || p.angle;
  } else {
    // Already resolved against the cursor in world space by updatePlayer.
    angle = p.aimAngle;
  }
  angle += (world.rnd.next() - 0.5) * weapon.spread * 2;
  if (fromCar) {
    const car = p.inCar;
    muzzle = { x: car.x + Math.cos(car.angle) * 26 - Math.sin(car.angle) * -12, y: car.y + Math.sin(car.angle) * 26 + Math.cos(car.angle) * -12 };
  } else {
    muzzle = { x: p.x + Math.cos(angle) * 16, y: p.y + Math.sin(angle) * 16 };
  }
  world.spawnBullet({
    x: muzzle.x,
    y: muzzle.y,
    angle,
    speed: weapon.speed,
    damage: weapon.damage,
    range: weapon.range,
    owner: 'player',
  });
  world.audio.play(weapon.sound, { x: muzzle.x, y: muzzle.y, volume: 0.55 });
  world.muzzleFlash(muzzle.x, muzzle.y, angle, p.weapon);
  // Firing in public raises heat.
  if (!world.scripted) world.raiseWanted(0.28, 'gunfire');
}

/** The player's pistol muzzle position, for the renderer. */
export function gunMuzzle(player) {
  return { x: player.x + Math.cos(player.aimAngle) * 15, y: player.y + Math.sin(player.aimAngle) * 15 };
}

export { wrapAngle, driveToward };
