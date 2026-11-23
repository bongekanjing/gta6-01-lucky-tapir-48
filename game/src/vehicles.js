// Vehicles: the car model, its arcade physics, the traffic that drives the street network, parked
// cars and the rules for stealing an occupied one. The player drives through the same `driveCar`
// the AI uses, so handling is identical whoever is at the wheel.
//
// Physics is a bicycle model with a grip term: a heading, a velocity, and a lateral component that
// decays fast on grippy tyres and slowly while the handbrake is down, which is what makes a drift.

import { CAR, CAR_MODELS, GRID, LANE, ROAD_HALF, PARK_LANE, POLICE } from './config.js';
import { hopPath, makePath, nearestOnPath, pointAt, pursuit, routePath, straightPath } from './roads.js';
import { angleDiff, clamp, dampAngle, dist2, lerp, turnToward } from './util.js';

let nextId = 1;

/** A fresh car record. `model` is one of CAR_MODELS or a police/van descriptor. */
export function makeCar(model, x, y, angle, opts = {}) {
  return {
    id: nextId++,
    model,
    x,
    y,
    angle,
    vx: 0,
    vy: 0,
    speed: 0,
    steer: 0,
    wheelSpin: 0,
    health: opts.health ?? CAR.health,
    maxHealth: opts.health ?? CAR.health,
    color: model.body,
    kind: opts.kind ?? model.kind ?? 'sedan',
    police: !!opts.police,
    driver: opts.driver ?? null,
    passengers: opts.passengers ?? 0,
    parked: opts.parked ?? false,
    path: null,
    pathDir: 'E',
    pathSpeed: opts.speed ?? 240,
    cruise: opts.speed ?? 240,
    blocked: 0,
    honk: 0,
    indicator: 0,
    brakeLight: false,
    siren: 0,
    wrecked: false,
    burning: 0,
    moveTimer: 0,
    lastX: x,
    lastY: y,
    stuck: 0,
    honkCooldown: 0,
  };
}

/** The traffic/pedestrian car roster: which model to spawn and whether it is on the road. */
export const MODELS = CAR_MODELS;

/** A police cruiser. */
export function makePoliceCar(x, y, angle) {
  const model = { name: 'Warden', body: POLICE.carBody, len: 1.04, wid: 1.02, roof: '#d8d5cb', kind: 'police' };
  const car = makeCar(model, x, y, angle, { police: true, kind: 'police', health: POLICE.carHealth, speed: 0 });
  car.lightPhase = 0;
  return car;
}

/** A delivery van for the side job. */
export function makeVan(x, y, angle) {
  const model = { name: 'Hauler', body: '#e6e0cf', len: 1.16, wid: 1.06, roof: '#cfc8b5', kind: 'van' };
  return makeCar(model, x, y, angle, { kind: 'van', speed: 0 });
}

/** The car's four world-space corners, for collision and drawing. */
export function carCorners(car) {
  const L = CAR.length * 0.5 * (car.model.len ?? 1);
  const W = CAR.width * 0.5 * (car.model.wid ?? 1);
  const c = Math.cos(car.angle);
  const s = Math.sin(car.angle);
  const fx = c * L;
  const fy = s * L;
  const rx = -s * W;
  const ry = c * W;
  return [
    { x: car.x + fx + rx, y: car.y + fy + ry },
    { x: car.x + fx - rx, y: car.y + fy - ry },
    { x: car.x - fx - rx, y: car.y - fy - ry },
    { x: car.x - fx + rx, y: car.y - fy + ry },
  ];
}

export function carRadius(car) {
  return CAR.radius * (car.model.len ?? 1);
}

/**
 * Integrate one car for dt. `controls` is { throttle (0..1), brake (0..1), steer (-1..1), handbrake }.
 * Returns the speed change so callers can play the engine sound. Cars push out of buildings and each
 * other through `world.pushCarOut`, which the world owns.
 */
export function driveCar(car, controls, dt, world) {
  if (car.wrecked) {
    car.vx *= 1 - 2.2 * dt;
    car.vy *= 1 - 2.2 * dt;
    car.x += car.vx * dt;
    car.y += car.vy * dt;
    car.speed = Math.hypot(car.vx, car.vy);
    world.resolveCarWorld(car);
    return 0;
  }
  const before = car.speed;
  const sinA = Math.sin(car.angle);
  const cosA = Math.cos(car.angle);
  // Break velocity into along-heading and lateral parts.
  let forward = car.vx * cosA + car.vy * sinA;
  let lateral = -car.vx * sinA + car.vy * cosA;

  const maxSpeed = CAR.maxSpeed * (car.model.kind === 'van' ? 0.82 : car.model.kind === 'truck' ? 0.78 : 1);
  const throttle = clamp(controls.throttle ?? 0, 0, 1);
  const brake = clamp(controls.brake ?? 0, 0, 1);

  if (throttle > 0) forward += CAR.accel * throttle * (car.model.kind === 'van' ? 0.8 : 1) * dt;
  if (brake > 0) {
    if (forward > 6) forward -= CAR.brake * brake * dt;
    else forward -= CAR.reverseAccel * brake * dt;
  }
  // Drag and rolling resistance.
  forward -= forward * CAR.drag * dt;
  forward = clamp(forward, -CAR.maxReverse, maxSpeed);
  if (Math.abs(forward) < 2 && throttle === 0 && brake === 0) forward = 0;

  // Steering scales with speed: no turning while stopped, tightest around 40% of top speed.
  const speedFactor = clamp(Math.abs(forward) / 90, 0, 1) * (1 - clamp(Math.abs(forward) / maxSpeed, 0, 1) * 0.45);
  const steerInput = clamp(controls.steer ?? 0, -1, 1);
  car.steer = lerp(car.steer, steerInput, 1 - Math.exp(-10 * dt));
  const turnRate = CAR.turn * car.steer * speedFactor * Math.sign(forward || 1);
  car.angle += turnRate * dt;

  // Tyres: lateral velocity decays toward zero at `grip`; handbrake drops grip so the tail slides.
  const handbrake = !!controls.handbrake;
  const grip = handbrake ? CAR.driftGrip : car.model.kind === 'police' ? CAR.grip + 0.6 : CAR.grip;
  lateral *= Math.exp(-grip * dt);
  if (handbrake) {
    const drag = Math.exp(-CAR.handbrakeDrag * dt);
    forward *= drag;
    // The slide adds a little forward rotation, which reads as a drift.
    car.slip = Math.abs(lateral) / Math.max(30, Math.abs(forward));
  } else {
    car.slip = 0;
  }

  // Recompose world velocity.
  const c2 = Math.cos(car.angle);
  const s2 = Math.sin(car.angle);
  car.vx = c2 * forward - s2 * lateral;
  car.vy = s2 * forward + c2 * lateral;
  car.x += car.vx * dt;
  car.y += car.vy * dt;
  car.speed = Math.hypot(car.vx, car.vy);
  car.wheelSpin += forward * dt * 0.12;
  car.brakeLight = brake > 0 || handbrake;
  world.resolveCarWorld(car);
  return car.speed - before;
}

/** Point the car down the nearest street and give it a path. */
export function bootTrafficCar(car, world) {
  const city = world.city;
  const rnd = world.rnd;
  const key = `${clamp(Math.round(car.x / GRID), 0, city.cols - 1)},${clamp(Math.round(car.y / GRID), 0, city.rows - 1)}`;
  const node = city.nodes.get(key);
  // Which lane are we closest to?
  const dx = Math.abs(car.x - node.x);
  const dy = Math.abs(car.y - node.y);
  const dir = dx > dy ? (car.x > node.x ? 'W' : 'E') : car.y > node.y ? 'N' : 'S';
  car.angle = { E: 0, W: Math.PI, S: Math.PI / 2, N: -Math.PI / 2 }[dir];
  // Snap to lane centre.
  const lane = { E: { x: car.x, y: node.y + LANE }, W: { x: car.x, y: node.y - LANE }, S: { x: node.x - LANE, y: car.y }, N: { x: node.x + LANE, y: car.y } }[dir];
  if (dx > 30 || dy > 30) {
    car.x = lane.x;
    car.y = lane.y;
  }
  car.pathDir = dir;
  car.path = makePath([{ x: car.x, y: car.y }, { x: car.x + (dir === 'E' ? 60 : dir === 'W' ? -60 : 0), y: car.y + (dir === 'S' ? 60 : dir === 'N' ? -60 : 0) }], car.cruise);
  car.pathKey = key;
  void rnd;
}

/**
 * Traffic and civilian driving: follow the lane path, slow behind the car ahead, and choose a new
 * hop at every intersection. `world` holds the car list and the city; `avoid` is the player's car
 * or null. Returns the throttle used (for sound).
 */
export function driveTraffic(car, dt, world) {
  const city = world.city;
  const rnd = world.rnd;
  if (car.wrecked) return;
  if (!car.path) bootTrafficCar(car, world);

  // Where we are along the path, measured once and reused by the hop check and the steering.
  let near = car.path ? nearestOnPath(car.path, car.x, car.y) : { s: 0, dist: 0 };
  const remaining = car.path ? car.path.length - near.s : 0;

  // At the end of a hop, choose the next one — but only once we are actually at the junction, so a
  // car never cuts a corner from the middle of a block.
  if (car.path && remaining < 70) {
    const key = car.pathKey ?? `${clamp(Math.round(car.x / GRID), 0, city.cols - 1)},${clamp(Math.round(car.y / GRID), 0, city.rows - 1)}`;
    const node = city.nodes.get(key);
    const atJunction = node && dist2(car.x, car.y, node.x, node.y) < (GRID * 0.8) ** 2;
    if (atJunction || remaining < 12) {
      const hop = hopPath(city, key, car.pathDir, rnd);
      car.path = makePath(hop.points, car.cruise);
      car.pathKey = hop.toKey;
      car.indicator = hop.dir !== car.pathDir ? 0.7 : 0;
      car.turnDir = hop.dir;
      car.pathDir = hop.dir;
      near = nearestOnPath(car.path, car.x, car.y);
    } else if (remaining < 12) {
      // Lost the junction: re-seed the path from where we stand.
      bootTrafficCar(car, world);
      near = nearestOnPath(car.path, car.x, car.y);
    }
  }

  const look = 34 + car.speed * 0.28;
  const target = car.path ? pointAt(car.path, Math.min(car.path.length, near.s + look)) : { x: car.x, y: car.y };
  const desired = Math.atan2(target.y - car.y, target.x - car.x);
  const err = angleDiff(car.angle, desired);
  const steer = clamp(err * 2.2, -1, 1);

  // Obstacle check straight ahead: the car in front of us in our lane.
  let limitSpeed = car.cruise;
  let needBrake = 0;
  const lookAhead = 34 + car.speed * 0.8;
  const fx = Math.cos(car.angle);
  const fy = Math.sin(car.angle);
  for (const other of world.cars) {
    if (other === car) continue;
    const ox = other.x - car.x;
    const oy = other.y - car.y;
    const ahead = ox * fx + oy * fy;
    if (ahead <= 0 || ahead > lookAhead) continue;
    const side = Math.abs(-ox * fy + oy * fx);
    if (side > 22) continue;
    const close = ahead / lookAhead;
    limitSpeed = Math.min(limitSpeed, Math.max(0, car.cruise * close * 0.9));
    needBrake = Math.max(needBrake, 1 - close);
  }
  // The player on foot or driving counts as an obstacle too.
  const player = world.player;
  if (player && !player.inCar) {
    const ox = player.x - car.x;
    const oy = player.y - car.y;
    const ahead = ox * fx + oy * fy;
    if (ahead > 0 && ahead < 40 && Math.abs(-ox * fy + oy * fx) < 16) limitSpeed = Math.min(limitSpeed, 40);
  }

  // If we have been stopped for a while, a car behind may honk.
  if (car.speed < 12) car.blocked += dt;
  else car.blocked = Math.max(0, car.blocked - dt * 2);
  if (car.blocked > 3 && car.honkCooldown <= 0 && world.audio) {
    world.audio.play('horn', { x: car.x, y: car.y, volume: 0.35 });
    car.honkCooldown = 4 + world.rnd.range(0, 4);
  }
  car.honkCooldown -= dt;

  // Lane discipline: keep the car near the lane centre with a small steering nudge.
  const controls = { throttle: 0, brake: 0, steer, handbrake: false };
  if (car.speed > limitSpeed + 8) {
    controls.brake = clamp((car.speed - limitSpeed) / 80, 0, 1);
  } else if (car.speed < limitSpeed - 6) {
    controls.throttle = clamp((limitSpeed - car.speed) / 60, 0, 1);
  }
  // Unstick: if wedged against a wall for long, reverse a moment.
  if (car.blocked > 5) {
    controls.throttle = 0.7;
    controls.brake = 0;
    controls.steer = -steer;
    if (car.blocked > 7.5) car.blocked = 0;
  }
  driveCar(car, controls, dt, world);
  if (car.indicator > 0) car.indicator = Math.max(0, car.indicator - dt);
}

/** A path from a car to a target world point, using A*. */
export function pathTo(world, car, x, y, speedLimit = 340) {
  const p = routePath(world.city, car.x, car.y, x, y, speedLimit);
  if (p) car.path = p;
  return p;
}

/** Steer along a stored pursuit path at a requested throttle, used by police and the autopilot. */
export function driveAlongPath(car, dt, world, opts = {}) {
  if (!car.path) return;
  const look = 34 + car.speed * 0.32;
  const q = pursuit(car.path, car.x, car.y, car.angle, look);
  const steer = clamp(q.error * 2.4, -1, 1);
  const wanted = opts.speed ?? car.path.speedLimit ?? 320;
  const controls = { throttle: 0, brake: 0, steer, handbrake: !!opts.handbrake };
  if (car.speed > wanted + 10) controls.brake = clamp((car.speed - wanted) / 80, 0, 1);
  else if (car.speed < wanted - 8) controls.throttle = clamp((wanted - car.speed) / 70, 0, 1);
  // Close in on a target point: brake at the end.
  if (q.remaining < 60 && opts.stopAtEnd) controls.brake = 1;
  driveCar(car, controls, dt, world);
  car.pathProgress = q.near.s;
  car.pathRemaining = q.remaining;
}

/** Whether a car can be stolen right now (parked or occupied by a driver to yank out). */
export function canSteal(car) {
  return !car.wrecked && car.health > 0;
}

/** Where the player should be drawn while driving: the driver's seat. */
export function seatOf(car, side = 'left') {
  const off = side === 'left' ? 5 : -5;
  return { x: car.x + Math.cos(car.angle) * 2 - Math.sin(car.angle) * off, y: car.y + Math.sin(car.angle) * 2 + Math.cos(car.angle) * off };
}

/** Spawn the street's parked cars: bays in the parking lots and along some curbs. */
export function populateParked(world) {
  const city = world.city;
  const rnd = world.rnd;
  const cars = [];
  // Parking lots.
  for (const block of city.blocks) {
    if (block.kind !== 'lot' || !block.lot) continue;
    for (const bay of block.lot.bays) {
      if (rnd.chance(0.55)) {
        const model = rnd.pick(CAR_MODELS);
        const cx = bay.x + bay.w / 2;
        const cy = bay.y + bay.h / 2;
        const angle = bay.row % 2 === 0 ? Math.PI / 2 : -Math.PI / 2;
        const car = makeCar(model, cx, cy, angle, { parked: true });
        car.bay = bay;
        cars.push(car);
      }
    }
  }
  // Curb parking along east-west streets, just off the lane.
  for (const block of city.blocks) {
    const jitter = rnd.range(0.2, 0.8);
    if (rnd.chance(0.5)) {
      const y = block.y - PARK_LANE;
      const x = block.x + block.w * jitter;
      const car = makeCar(rnd.pick(CAR_MODELS), x, y, Math.PI, { parked: true });
      car.curb = true;
      cars.push(car);
    }
    if (rnd.chance(0.5)) {
      const y = block.y + block.h + PARK_LANE;
      const x = block.x + block.w * (1 - jitter);
      const car = makeCar(rnd.pick(CAR_MODELS), x, y, 0, { parked: true });
      car.curb = true;
      cars.push(car);
    }
  }
  for (const c of cars) world.cars.push(c);
  return cars;
}

/** Spawn a starting set of traffic cars on the streets, spread across the map. */
export function populateTraffic(world, count) {
  const city = world.city;
  const rnd = world.rnd;
  let placed = 0;
  let guard = 0;
  while (placed < count && guard < count * 40) {
    guard += 1;
    const i = rnd.int(1, city.cols - 2);
    const j = rnd.int(1, city.rows - 2);
    const node = city.nodes.get(`${i},${j}`);
    const dir = rnd.pick(['E', 'W', 'S', 'N']);
    const off = dir === 'E' ? { x: 0, y: LANE } : dir === 'W' ? { x: 0, y: -LANE } : dir === 'S' ? { x: -LANE, y: 0 } : { x: LANE, y: 0 };
    const t = rnd.range(0.15, 0.85);
    const nx = node.x + (dir === 'E' || dir === 'W' ? (dir === 'E' ? 1 : -1) * GRID * t : 0) + off.x;
    const ny = node.y + (dir === 'S' || dir === 'N' ? (dir === 'S' ? 1 : -1) * GRID * t : 0) + off.y;
    // Keep clear of the player's start and the camera's opening view.
    if (dist2(nx, ny, city.spawn.x, city.spawn.y) < 260 * 260) continue;
    let clash = false;
    for (const c of world.cars) {
      if (dist2(c.x, c.y, nx, ny) < 46 * 46) {
        clash = true;
        break;
      }
    }
    if (clash) continue;
    const model = rnd.pick(CAR_MODELS);
    const car = makeCar(model, nx, ny, { E: 0, W: Math.PI, S: Math.PI / 2, N: -Math.PI / 2 }[dir], { speed: rnd.range(150, 230) });
    car.cruise = car.pathSpeed;
    car.pathDir = dir;
    car.pathKey = `${i},${j}`;
    world.cars.push(car);
    placed += 1;
  }
}

/** Keep the streets alive: spawn a car off-screen when traffic thins out. */
export function topUpTraffic(world, target, dt) {
  world.trafficTimer = (world.trafficTimer ?? 0) + dt;
  if (world.trafficTimer < 1.4) return;
  world.trafficTimer = 0;
  const active = world.cars.filter((c) => !c.parked).length;
  if (active >= target) return;
  const city = world.city;
  const rnd = world.rnd;
  for (let tries = 0; tries < 12; tries += 1) {
    const i = rnd.int(1, city.cols - 2);
    const j = rnd.int(1, city.rows - 2);
    const node = city.nodes.get(`${i},${j}`);
    const dir = rnd.pick(['E', 'W', 'S', 'N']);
    const off = dir === 'E' ? { x: 0, y: LANE } : dir === 'W' ? { x: 0, y: -LANE } : dir === 'S' ? { x: -LANE, y: 0 } : { x: LANE, y: 0 };
    const nx = node.x + off.x + (dir === 'E' ? 60 : dir === 'W' ? -60 : 0);
    const ny = node.y + off.y + (dir === 'S' ? 60 : dir === 'N' ? -60 : 0);
    if (dist2(nx, ny, world.player.x, world.player.y) < 500 * 500) continue;
    let clash = false;
    for (const c of world.cars) if (dist2(c.x, c.y, nx, ny) < 50 * 50) clash = true;
    if (clash) continue;
    const car = makeCar(rnd.pick(CAR_MODELS), nx, ny, { E: 0, W: Math.PI, S: Math.PI / 2, N: -Math.PI / 2 }[dir], { speed: rnd.range(160, 220) });
    car.cruise = car.pathSpeed;
    car.pathDir = dir;
    car.pathKey = `${i},${j}`;
    world.cars.push(car);
    return;
  }
}

/** A straight-line driver: used by police in close pursuit and by taxis pulling over. */
export function driveToward(car, tx, ty, dt, world, opts = {}) {
  const desired = Math.atan2(ty - car.y, tx - car.x);
  const err = angleDiff(car.angle, desired);
  const distLeft = Math.hypot(tx - car.x, ty - car.y);
  const speedWant = opts.speed ?? clamp(distLeft * 1.6, 0, CAR.maxSpeed);
  const steer = clamp(err * 2.6, -1, 1);
  const controls = { throttle: 0, brake: 0, steer, handbrake: !!opts.handbrake };
  if (Math.abs(err) > 1.05 && car.speed > 150) controls.brake = 0.6;
  else if (car.speed < speedWant - 8) controls.throttle = clamp((speedWant - car.speed) / 70, 0, 1);
  else if (car.speed > speedWant + 10) controls.brake = clamp((car.speed - speedWant) / 70, 0, 1);
  driveCar(car, controls, dt, world);
  return err;
}

export { turnToward, dampAngle, straightPath };
