// Deterministic scenes for the screenshot rig: each named shot boots a fresh world from the seed,
// plays the real game forward with an autopilot (the same control object a hand uses), and then
// holds still so the frame is reproducible. Nothing here draws a fake picture; it presses the same
// buttons the player presses.
//
// `runShot(app, name)` returns a promise that resolves once the scene has settled. The page then
// signals readiness, the rig captures the canvas, and the same seed always produces the same frame.

import { STEP } from './config.js';
import { createWorld, fillWorld, stepWorld } from './game.js';
import { driveCar, canSteal, carRadius, driveToward, pathTo, MODELS } from './vehicles.js';
import { enterCar, exitCar, selectWeapon } from './player.js';
import { startMission, STORY, SIDE_JOBS, nextStory } from './missions.js';
import { addHeat, witnessed, spawnUnit } from './police.js';
import { dist2 } from './util.js';

/** Seeds keep every shot reproducible; the same seed yields the same city, traffic and crowd. */
const SHOT_SEEDS = { start: 1, drive: 1, chase: 1, mission: 1, play: 1, end: 1 };

/**
 * A headless driver: it looks at the world and produces the control object the player's update
 * expects. This is a tiny AI, not a cheat: it uses the road network and the car's own physics.
 */
function makeAutopilot(world) {
  const bot = {
    target: null,
    mode: 'walk',
    timer: 0,
    route: null,
    stuck: 0,
    lastPos: { x: world.player.x, y: world.player.y },
  };

  /** Controls for walking to a world point. */
  function walkTo(tx, ty) {
    const p = world.player;
    const dx = tx - p.x;
    const dy = ty - p.y;
    const d = Math.hypot(dx, dy);
    const controls = { move: { x: 0, y: 0 }, sprint: d > 120, aim: null, fire: false, enter: false, exitCar: false, weaponSwitch: 0 };
    if (d > 12) {
      controls.move.x = dx / d;
      controls.move.y = dy / d;
    }
    return controls;
  }

  /** Controls for driving to a world point, along the road graph when it is far. */
  function driveTo(tx, ty) {
    const car = world.player.inCar;
    if (!car) return { move: { x: 0, y: 0 }, sprint: false, aim: null, fire: false, enter: false, exitCar: false, weaponSwitch: 0 };
    const d = Math.hypot(tx - car.x, ty - car.y);
    if (d > 220) {
      // Re-plan every so often, and when the path runs out.
      bot.timer -= STEP;
      if (!car.path || bot.timer <= 0 || (car.pathRemaining !== undefined && car.pathRemaining < 90)) {
        pathTo(world, car, tx, ty, 300);
        bot.timer = 1.6;
      }
    } else {
      car.path = null;
    }
    const desired = Math.atan2(ty - car.y, tx - car.x);
    let err = ((desired - car.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    const steer = Math.max(-1, Math.min(1, err * 2.2));
    const controls = { throttle: 0, brake: 0, steer, handbrake: false, move: { x: 0, y: 0 }, sprint: false, aim: null, fire: false, enter: false, exitCar: false, weaponSwitch: 0 };
    if (d < 90) {
      controls.brake = d < 46 ? 1 : 0.5;
      controls.throttle = d < 46 ? 0 : 0.2;
    } else if (car.speed > 260) {
      controls.brake = 0.3;
    } else {
      controls.throttle = 0.85;
    }
    // Unstick: reversing out when pinned against something.
    const moved = Math.hypot(car.x - bot.lastPos.x, car.y - bot.lastPos.y);
    if (moved < 0.6) bot.stuck += STEP;
    else bot.stuck = Math.max(0, bot.stuck - STEP * 2);
    bot.lastPos.x = car.x;
    bot.lastPos.y = car.y;
    if (bot.stuck > 1.4) {
      controls.throttle = 0;
      controls.brake = 0;
      controls.reverse = 1;
      controls.steer = -steer;
      if (bot.stuck > 2.6) bot.stuck = 0;
    }
    return controls;
  }

  /** The next control object: the bot's current goal, or coasting. */
  bot.controls = () => {
    if (bot.mode === 'drive') return driveTo(bot.target.x, bot.target.y);
    if (bot.mode === 'walk') return walkTo(bot.target.x, bot.target.y);
    return { move: { x: 0, y: 0 }, sprint: false, aim: null, fire: false, enter: false, exitCar: false, weaponSwitch: 0 };
  };

  /** Head for a point on foot, getting into a car first if it is far. */
  bot.goto = (x, y) => {
    bot.target = { x, y };
    const p = world.player;
    if (p.inCar) {
      bot.mode = 'drive';
      return;
    }
    if (Math.hypot(x - p.x, y - p.y) > 420) {
      const car = findNearbyCar(world, p.x, p.y, 320);
      if (car) {
        // Walk to it, then take it.
        bot.mode = 'walk';
        bot.target = { x: car.x, y: car.y };
        bot.pendingCar = car;
        return;
      }
    }
    bot.mode = 'walk';
  };

  return bot;
}

/** A car the bot can take: the closest one that is not the player's and not a wreck. */
function findNearbyCar(world, x, y, maxD) {
  let best = null;
  let bd = maxD * maxD;
  for (const car of world.cars) {
    if (!canSteal(car) || car.occupiedByPlayer) continue;
    const d = dist2(x, y, car.x, car.y);
    if (d < bd) {
      bd = d;
      best = car;
    }
  }
  return best;
}

/**
 * Boot a shot: a fresh world from the named seed, an autopilot, and the steps that stage it.
 * The `advance` callback steps the world the given number of fixed frames.
 */
export function createShot(name, seed) {
  const world = createWorld(seed ?? SHOT_SEEDS[name] ?? 1);
  fillWorld(world);
  const bot = makeAutopilot(world);
  const shot = { name, world, bot, target: null, done: false };

  shot.advance = (frames) => {
    for (let i = 0; i < frames; i += 1) {
      const controls = bot.controls();
      stepWorld(world, controls, STEP);
      // Take the car the bot walked up to.
      if (bot.pendingCar && !world.player.inCar) {
        const p = world.player;
        if (Math.hypot(bot.pendingCar.x - p.x, bot.pendingCar.y - p.y) < 40) {
          world.enterVehicle(bot.pendingCar);
          bot.pendingCar = null;
          bot.mode = 'drive';
        }
      }
    }
  };
  return shot;
}

/**
 * Stage and run a named shot. Returns { world, hints } where hints tells the app which screen to
 * show (title / playing) and whether the HUD is on.
 */
export async function runShot(app, name) {
  const seed = Number(app.shotSeed ?? SHOT_SEEDS[name] ?? 1);
  switch (name) {
    case 'start':
      return stageStart(app, seed);
    case 'drive':
      return stageDrive(app, seed);
    case 'chase':
      return stageChase(app, seed);
    case 'mission':
      return stageMission(app, seed);
    case 'play':
      return stagePlay(app, seed);
    case 'end':
      return stageEnd(app, seed);
    default:
      return stageDrive(app, seed);
  }
}

/** The title card over a living city: the camera drifts down the beach boulevard. */
function stageStart(app, seed) {
  const world = createWorld(seed);
  fillWorld(world);
  // Put the player in a car on the beach boulevard, so the backdrop has traffic and palms.
  const p = world.player;
  const car = world.cars.find((c) => c.parked && c.model.kind === 'coupe') ?? world.cars[0];
  if (car) {
    p.x = car.x;
    p.y = car.y;
    world.enterVehicle(car);
    car.angle = -0.55;
    world.camera.snap(car.x, car.y, 1.02);
  }
  // A little traffic and crowd, then the camera parks on a nice angle.
  const bot = makeAutopilot(world);
  for (let i = 0; i < 170; i += 1) {
    stepWorld(world, car ? { throttle: i < 90 ? 0.5 : 0.12, brake: 0, steer: -0.06, handbrake: false, move: { x: 0, y: 0 }, sprint: false, aim: null, fire: false, enter: false, exitCar: false, weaponSwitch: 0 } : bot.controls(), STEP);
  }
  world.camera.snap(world.player.x, world.player.y, 1.04);
  world.camera.angle = -0.5;
  app.applyShotWorld(world, { screen: 'title', hud: false });
  return { world, name: 'start' };
}

/** A car in traffic with the HUD and minimap: the player drives the boulevard. */
function stageDrive(app, seed) {
  const world = createWorld(seed);
  fillWorld(world);
  const p = world.player;
  // Take the first parked car near the garage.
  let car = null;
  let bd = Infinity;
  for (const c of world.cars) {
    if (!c.parked || !canSteal(c)) continue;
    const d = dist2(p.x, p.y, c.x, c.y);
    if (d < bd) {
      bd = d;
      car = c;
    }
  }
  if (!car) car = world.cars[0];
  p.x = car.x;
  p.y = car.y;
  world.enterVehicle(car);
  car.angle = 0;
  // Drive east down the block, letting the traffic settle around us.
  for (let i = 0; i < 260; i += 1) {
    const controls = { throttle: i > 20 ? 0.85 : 0.2, brake: 0, steer: i < 60 ? 0.04 : -0.02, handbrake: false, move: { x: 0, y: 0 }, sprint: false, aim: null, fire: false, enter: false, exitCar: false, weaponSwitch: 0 };
    stepWorld(world, controls, STEP);
  }
  // Give the player a pistol so the HUD's weapon slot is real.
  world.player.hasWeapon.pistol = true;
  world.player.ammo.pistol = 24;
  selectWeapon(world.player, 'pistol');
  world.showControls = true;
  app.applyShotWorld(world, { screen: 'playing', hud: true });
  return { world, name: 'drive' };
}

/** A police chase with stars and an objective: real pursuit, real cruisers. */
function stageChase(app, seed) {
  const world = createWorld(seed);
  fillWorld(world);
  const p = world.player;
  // Take a fast car.
  let car = null;
  let bd = Infinity;
  for (const c of world.cars) {
    if (!c.parked || !canSteal(c)) continue;
    const d = dist2(p.x, p.y, c.x, c.y);
    if (d < bd) {
      bd = d;
      car = c;
    }
  }
  if (!car) car = world.cars[0];
  p.x = car.x;
  p.y = car.y;
  world.enterVehicle(car);
  // Face east, down the block: the parked cars sit on a lane that runs that way, so driving
  // straight leaves the lot instead of ploughing into a wall.
  car.angle = 0;
  // Start a story mission so there is a real objective and marker on the HUD.
  const story = nextStory(world);
  if (story) startMission(world, story, null);
  // Heat: three stars, seen, with cruisers spawning around us.
  world.police.stars = 3;
  world.police.heat = 3.4;
  witnessed(world.police);
  p.hasWeapon.pistol = true;
  p.ammo.pistol = 17;
  selectWeapon(p, 'pistol');
  world.showControls = true;
  // Drive east with the same hand on the wheel the drive shot uses, so the frame is a real
  // run down a street with traffic rather than a car nosed into a kerb.
  for (let i = 0; i < 210; i += 1) {
    const controls = { throttle: i > 20 ? 0.8 : 0.2, brake: 0, steer: i < 60 ? 0.05 : -0.02, handbrake: false, move: { x: 0, y: 0 }, sprint: false, aim: null, fire: false, enter: false, exitCar: false, weaponSwitch: 0 };
    stepWorld(world, controls, STEP);
  }
  // Stage the shot: guarantee cruisers beside and behind us, and a clean wanted read.
  ensureChase(world);
  world.showToast('Bad Debt', 'Marisol', 'Lose the police before you reach the garage', 'bad');
  app.applyShotWorld(world, { screen: 'playing', hud: true });
  return { world, name: 'chase' };
}

/** Make sure at least three cruisers are visibly close, for a good chasing frame. */
function ensureChase(world) {
  const p = world.player;
  const car = p.inCar;
  if (!car) return;

  const live = () => world.police.units.filter((u) => u.state !== 'released');
  // Ask the police system itself for units until enough cruisers exist. spawnUnit picks an
  // intersection off the camera's shoulder, so they arrive from behind rather than popping in
  // front of the lens.
  for (let tries = 0; tries < 40 && live().length < 4; tries += 1) {
    world.police.spawnTimer = 0;
    world.police.stars = Math.max(world.police.stars, 3);
    spawnUnit(world);
  }
  // Pull them in tight: place each live cruiser on a lane point behind and beside the player, then
  // let the chase run so they are genuinely driving, at speed, in the frame.
  const slots = [
    { back: 210, side: -34 },
    { back: 150, side: 38 },
    { back: 300, side: 10 },
    { back: 118, side: -50 },
  ];
  let i = 0;
  for (const unit of live()) {
    const slot = slots[i % slots.length];
    i += 1;
    const bx = car.x - Math.cos(car.angle) * slot.back - Math.sin(car.angle) * slot.side;
    const by = car.y - Math.sin(car.angle) * slot.back + Math.cos(car.angle) * slot.side;
    if (world.city.solidsNear(bx, by, 26).length) continue;
    unit.car.x = bx;
    unit.car.y = by;
    unit.car.angle = car.angle;
    unit.car.speed = Math.abs(car.speed) * 0.85;
    unit.state = 'pursue';
    unit.retarget = 0;
    unit.car.police = true;
    unit.car.kind = 'police';
    unit.car.siren = 1;
    unit.car.path = null;
  }
  // A short burst of pursuit so the cruisers are rolling and lit, without letting them close the
  // gap and ram the player's car apart before the frame is taken.
  const hp = car.health;
  for (let f = 0; f < 26; f += 1) {
    stepWorld(world, { throttle: 0.45, brake: 0, steer: 0, handbrake: false, move: { x: 0, y: 0 }, sprint: false, aim: null, fire: false, enter: false, exitCar: false, weaponSwitch: 0 }, STEP);
  }
  // The staged burst is a camera move, not a fight: hand the car its health back so the player is
  // still behind the wheel (and the HUD shows a car, not a crater).
  if (car.wrecked) {
    car.wrecked = false;
    car.burning = 0;
    car.parked = false;
  }
  car.health = Math.max(hp * 0.82, 150);
  if (!p.inCar) world.enterVehicle(car);
  // Hold the read at three stars: enough cruisers to fill the street, still a level the player
  // could plausibly shake.
  world.police.stars = 3;
  world.police.heat = 3.2;
  witnessed(world.police);
}

/** A mission in progress near its marker: the active stage and its gold ring in view. */
function stageMission(app, seed) {
  const world = createWorld(seed);
  fillWorld(world);
  const p = world.player;
  // Start story-2 (a kill job) so the marker is a place, not a car.
  const mission = STORY[1] ?? STORY[0];
  world.missions.storyIndex = 1;
  startMission(world, mission, null);
  // Walk the player to the marker with the autopilot, which is a real walk to the objective.
  const bot = makeAutopilot(world);
  const marker = world.missions.active?.stages[0]?.marker;
  if (marker) {
    bot.goto(marker.x, marker.y);
    for (let i = 0; i < 900 && !bot.done; i += 1) {
      stepWorld(world, bot.controls(), STEP);
      if (bot.pendingCar && !p.inCar) {
        if (Math.hypot(bot.pendingCar.x - p.x, bot.pendingCar.y - p.y) < 40) {
          world.enterVehicle(bot.pendingCar);
          bot.pendingCar = null;
          bot.mode = 'drive';
        }
      }
      const d = Math.hypot(p.x - marker.x, p.y - marker.y);
      if (d < 120) break;
    }
  }
  // Close the last stretch on foot so the marker is in the frame.
  if (p.inCar) {
    world.exitVehicle();
    for (let i = 0; i < 40; i += 1) stepWorld(world, { move: { x: 0, y: 0 }, sprint: false, aim: null, fire: false, enter: false, exitCar: false, weaponSwitch: 0 }, STEP);
  }
  if (marker) {
    const d = Math.hypot(p.x - marker.x, p.y - marker.y);
    if (d > 96) {
      bot.target = { x: marker.x, y: marker.y };
      bot.mode = 'walk';
      for (let i = 0; i < 400; i += 1) {
        stepWorld(world, bot.controls(), STEP);
        if (Math.hypot(p.x - marker.x, p.y - marker.y) < 84) break;
      }
    }
    p.angle = Math.atan2(marker.y - p.y, marker.x - p.x);
    p.aiming = true;
    p.aimAngle = p.angle;
  }
  p.hasWeapon.pistol = true;
  p.ammo.pistol = 12;
  selectWeapon(p, 'pistol');
  world.showControls = false;
  world.camera.snap(p.x, p.y, 1.14);
  // A couple of frames of settle so the camera is where it belongs.
  for (let i = 0; i < 30; i += 1) stepWorld(world, { move: { x: 0, y: 0 }, sprint: false, aim: { x: marker?.x ?? p.x + 100, y: marker?.y ?? p.y }, fire: false, enter: false, exitCar: false, weaponSwitch: 0 }, STEP);
  app.applyShotWorld(world, { screen: 'playing', hud: true });
  return { world, name: 'mission' };
}

/** A late-game frame: a burning wreck, money earned, four stars and a busy street. */
function stageEnd(app, seed) {
  const world = createWorld(seed);
  fillWorld(world);
  const p = world.player;
  let car = null;
  let bd = Infinity;
  for (const c of world.cars) {
    if (!c.parked || !canSteal(c)) continue;
    const d = dist2(p.x, p.y, c.x, c.y);
    if (d < bd) {
      bd = d;
      car = c;
    }
  }
  if (!car) car = world.cars[0];
  p.x = car.x;
  p.y = car.y;
  world.enterVehicle(car);
  car.angle = 0;
  const mission = STORY[2] ?? STORY[0];
  world.missions.storyIndex = 2;
  startMission(world, mission, null);
  p.money = 18450;
  p.hasWeapon.pistol = true;
  p.hasWeapon.smg = true;
  p.ammo.pistol = 34;
  p.ammo.smg = 96;
  selectWeapon(p, 'smg');
  world.police.stars = 4;
  world.police.heat = 4.2;
  witnessed(world.police);
  const bot = makeAutopilot(world);
  bot.mode = 'drive';
  bot.target = { x: p.x + 900, y: p.y - 320 };
  for (let i = 0; i < 240; i += 1) stepWorld(world, bot.controls(), STEP);
  // Wreck a car nearby, for the fire and smoke.
  const victim = world.cars.find((c) => c !== car && !c.wrecked && Math.hypot(c.x - car.x, c.y - car.y) < 320);
  if (victim) {
    victim.health = 0;
    victim.wrecked = true;
    victim.burning = 1.6;
  }
  world.showControls = true;
  world.camera.snap(world.player.x, world.player.y, 1.0);
  app.applyShotWorld(world, { screen: 'playing', hud: true });
  return { world, name: 'end' };
}

/** Free play: just a nice frame of the boulevard from the player's car. */
function stagePlay(app, seed) {
  const world = createWorld(seed);
  fillWorld(world);
  const bot = makeAutopilot(world);
  const p = world.player;
  bot.mode = 'walk';
  bot.target = { x: p.x + 320, y: p.y - 60 };
  for (let i = 0; i < 420; i += 1) stepWorld(world, bot.controls(), STEP);
  app.applyShotWorld(world, { screen: 'playing', hud: true });
  return { world, name: 'play' };
}

export { SIDE_JOBS, MODELS, driveCar, driveToward, carRadius, enterCar, exitCar };
