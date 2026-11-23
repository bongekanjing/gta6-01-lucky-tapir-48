// The story and the side jobs. A mission is a list of stages, each with a kind (go, kill, collect,
// deliver, survive, escape), a marker, a briefing line and the text the HUD shows. The mission
// runner owns the current objective, the target marker, the timer and the payout; every other
// system only reports events (`world.missions.onEvent`).
//
// Story shape: Rico owes the wrong people; four jobs walk him from a stolen car to the man who set
// him up. Side jobs (courier runs, a street race, hit contracts) repeat forever and pay per job.

import { MISSIONS } from './config.js';
import { payPlayer } from './player.js';
import { panicAround } from './pedestrians.js';

/** Marker radius the player must stand in. */
const REACH = 34;

function stage(kind, opts) {
  return { kind, done: false, timer: 0, ...opts };
}

/**
 * The four story missions. Each `build(world)` returns stages with resolved world positions, so a
 * mission can point at the safehouse or a moving car. `brief` is what the phone shows first.
 */
export const STORY = [
  {
    id: 'story-1',
    title: 'Bad Debt',
    giver: 'Marisol',
    payout: 900,
    brief:
      "Marisol Vela runs the marina and half the paperwork in this town. She says a courier named Dex is holding a car that isn't his, and she wants it back in one piece. \"It's the blue Marabella on Pelican Row. Bring it to my garage without a scratch on the paint. Or don't bother coming back.\"",
    build: (world) => {
      // The car exists as a real parked car, marked so the HUD and the mission can find it.
      const car = world.spawnMissionCar('story-car');
      return [
        stage('go', {
          marker: { x: car.x, y: car.y },
          radius: 26,
          text: 'Find the blue Marabella',
          hint: 'Drive or walk — follow the marker',
          near: 'That is the car. Get in.',
        }),
        stage('deliver', {
          car,
          marker: { x: world.city.poi.safehouse.x, y: world.city.poi.safehouse.y },
          radius: 62,
          text: 'Drive the Marabella to the garage',
          hint: 'Any damage costs you the bonus',
          near: 'Park it in the garage bay.',
          payoutIfClean: 300,
        }),
      ];
    },
  },
  {
    id: 'story-2',
    title: 'The Runner',
    giver: 'Rico',
    payout: 1200,
    brief:
      'Rico runs the garage and talks like every favour is a loan. "Dex wants his money face to face. He\'s in the market at the old district, and he brought friends. Go say hello. Try not to make a scene the whole city reads about."',
    build: (world) => {
      const spot = world.missionSpot(2, 5);
      return [
        stage('go', { marker: spot, radius: 44, text: 'Meet Dex at the market', hint: 'Go armed — he will not be alone' }),
        stage('kill', { marker: spot, radius: 260, text: 'Take out Dex and his crew', hint: '3 targets', remaining: 3, targets: [], brief: 'Deal with Dex' }),
        stage('escape', { marker: null, radius: 0, text: 'Lose the heat', hint: 'Break line of sight' }),
      ];
    },
  },
  {
    id: 'story-3',
    title: 'Pier Pressure',
    giver: 'Marisol',
    payout: 1800,
    brief:
      'The shipment came in short and Marisol is not smiling. "Pier Nine, container yard. Somebody has been skimming my crates. Go look at the manifest, and if the dock boss gives you trouble, you know what to do. Bring the ledger back here."',
    build: (world) => {
      const pier = { x: world.city.poi.docks.x - 60, y: world.city.poi.docks.y };
      return [
        stage('go', { marker: pier, radius: 54, text: 'Drive to Pier Nine', hint: 'The docks are south-west' }),
        stage('collect', { marker: { x: pier.x + 50, y: pier.y - 30 }, radius: 34, text: 'Grab the ledger from the yard office', hint: 'Then get clear' }),
        stage('deliver', { marker: { x: world.city.poi.safehouse.x, y: world.city.poi.safehouse.y }, radius: 62, text: 'Bring the ledger to the garage', hint: 'Dock security is watching' }),
      ];
    },
  },
  {
    id: 'story-4',
    title: 'Last Call',
    giver: 'Rico',
    payout: 3200,
    brief:
      'The ledger names the man who sold Rico\'s garage out from under him: a hotelier on the high floors of the Mirador, with a private elevator and a very expensive view. "I want him to know it was me. No — it was you. Go on. Make it the last call he takes."',
    build: (world) => {
      const hotel = world.missionSpot(4, 2);
      return [
        stage('go', { marker: hotel, radius: 46, text: 'Go to the Hotel Mirador', hint: 'Downtown, on the strip' }),
        stage('kill', { marker: hotel, radius: 320, text: 'Take out the hotelier and his guards', hint: '4 targets', remaining: 4, targets: [] }),
        stage('escape', { marker: null, radius: 0, text: 'Get out of the district', hint: 'They will come in force', distance: 520 }),
      ];
    },
  },
];

/** The side jobs, each a factory that returns stages and a title to show. */
export const SIDE_JOBS = {
  delivery: {
    id: 'delivery',
    title: 'Courier Run',
    payout: 520,
    brief: 'A parcel has to reach the marina before the client\'s patience runs out. Any car will do, as long as it moves.',
    build(world) {
      const from = world.missionSpot(1, 6);
      const target = world.city.poi.marina;
      world.spawnVanIfMissing(from);
      return [
        stage('go', { marker: from, radius: 40, text: 'Pick up the parcel', hint: 'The van is waiting' }),
        stage('deliver', { marker: { x: target.x, y: target.y }, radius: 70, text: 'Deliver the parcel to the marina', hint: 'The clock is running', timer: 150 }),
      ];
    },
  },
  race: {
    id: 'race',
    title: 'Street Race',
    payout: 1400,
    brief: 'Three checkpoints around the old town, on the clock. Somebody is going to lose a mirror. Do not let it be you.',
    build(world) {
      const route = world.raceRoute();
      const stages = route.map((p, i) =>
        stage('checkpoint', { marker: p, radius: 62, text: `Checkpoint ${i + 1} of ${route.length}`, hint: i === 0 ? 'Get to the start line first' : 'Keep moving', timer: i === 0 ? 16 : 34 }),
      );
      return stages;
    },
  },
  hit: {
    id: 'hit',
    title: 'Hit Contract',
    payout: 900,
    brief: 'A man who borrowed a car and never gave it back is drinking at the beach bar. Somebody wants the matter settled quietly.',
    build(world) {
      const target = world.markForHit(world.city.poi.beach);
      return [
        stage('kill', { marker: { x: target.x, y: target.y }, radius: 40, text: 'Find the mark on the beach', hint: 'He is marked in red', remaining: 1, targets: [target.id], brief: 'Settle the contract' }),
      ];
    },
  },
};

/** A mission runtime: the queue of stages, the active index, the timers and the marker. */
export function createMissionState() {
  return {
    active: null,
    storyIndex: 0,
    storyStage: 0,
    completed: [],
    cooldown: 0,
    messageTimer: 0,
    failFlash: 0,
    startedStages: 0,
    payoutPending: 0,
    cleanRun: true,
    startedAt: 0,
    toast: null,
    toastTimer: 0,
    available: [], // side jobs currently offered, rewritten by the world each frame
    offerTimer: 0,
  };
}

/** Start a story mission (the next one in order) or a side job by id. */
export function startMission(world, mission, sideId = null) {
  const m = world.missions;
  const stages = mission.build(world);
  m.active = {
    mission,
    sideId,
    stages,
    index: 0,
    timer: stages[0]?.timer ?? 0,
    elapsed: 0,
    payout: mission.payout,
    title: mission.title,
    started: true,
    car: null,
    cleanRun: true,
  };
  m.startedStages = stages.length;
  m.failFlash = 0;
  m.messageTimer = 3.6;
  world.audio.play('mission');
  world.showToast(mission.title, mission.giver ?? 'Job offer', mission.brief);
  world.missions.storyStage = 0;
  // A mission car might already be in place; keep the reference.
  if (sideId === null && mission.id === STORY[m.storyIndex]?.id) m.storyStage = 0;
  if (stages[0]?.kind === 'kill' && stages[0].targets?.length === 0) world.populateTargets(stages[0]);
  return m.active;
}

/** The next unplayed story mission, or null when the story is done. */
export function nextStory(world) {
  const m = world.missions;
  if (m.storyIndex >= STORY.length) return null;
  return STORY[m.storyIndex];
}

/** The active stage, or null. */
export function activeStage(world) {
  const a = world.missions.active;
  if (!a) return null;
  return a.stages[a.index] ?? null;
}

export function missionMarker(world) {
  const st = activeStage(world);
  return st?.marker ?? null;
}

/** What the HUD prints, and the marker the minimap draws. */
export function missionObjective(world) {
  const m = world.missions;
  if (!m.active) {
    const story = nextStory(world);
    if (story) return { text: 'Go to the garage to start the next job', hint: `Story: ${story.title}`, marker: world.city.poi.safehouse, kind: 'idle' };
    return { text: 'Take on a side job', hint: 'Call the garage', marker: world.city.poi.safehouse, kind: 'idle' };
  }
  const st = activeStage(world);
  if (!st) return null;
  return {
    title: m.active.title,
    text: st.text,
    hint: st.hint ?? '',
    timer: st.timer > 0 ? st.timer : 0,
    remaining: st.remaining,
    marker: st.marker,
    kind: st.kind,
  };
}

/** Advance to the next stage; finish the mission when there are none left. */
export function advanceStage(world, opts = {}) {
  const m = world.missions;
  const a = m.active;
  if (!a) return;
  const st = a.stages[a.index];
  if (st) st.done = true;
  // Payout for a clean delivery.
  if (st?.payoutIfClean && a.cleanRun) a.payout += st.payoutIfClean;
  a.index += 1;
  if (a.index >= a.stages.length) {
    finishMission(world, true);
    return;
  }
  const next = a.stages[a.index];
  next.timer = next.timer ?? 0;
  if (next.kind === 'kill' && (!next.targets || next.targets.length === 0)) world.populateTargets(next);
  m.messageTimer = 3;
  if (next.text) world.showToast(a.title, 'Objective', next.text);
  if (opts.silent) m.messageTimer = 0;
  if (next.kind === 'escape') world.beginEscape(next);
  // A side job's delivery leg keeps the parcel visual.
  if (next.kind === 'deliver' && next.car) a.car = next.car;
}

/** The mission is over: pay, record it and clear. */
export function finishMission(world, success) {
  const m = world.missions;
  const a = m.active;
  if (!a) return;
  if (success) {
    payPlayer(world.player, a.payout);
    world.stats.earned += a.payout;
    world.stats.missions += 1;
    world.audio.play('cash');
    world.showToast('Job complete', `${a.title}`, `Payout: $${a.payout.toLocaleString('en-US')}`, 'good');
    if (a.sideId === null) {
      m.completed.push(a.title);
      m.storyIndex += 1;
      const isFinal = m.storyIndex >= STORY.length;
      if (isFinal) world.onStoryComplete?.();
    } else if (a.sideId === 'delivery') world.stats.deliveries += 1;
    else if (a.sideId === 'race') world.stats.races += 1;
    else if (a.sideId === 'hit') world.stats.hits += 1;
  } else {
    world.audio.play('fail');
    world.showToast('Job failed', a.title, 'It happens. Try again.', 'bad');
  }
  m.active = null;
  m.cooldown = 2.5;
  m.failFlash = success ? 0 : 1;
  world.cleanupMissionArtifacts(a);
  world.onMissionEnd?.(success);
}

/** Fail the current mission (death, abandonment, a timer running out). */
export function failMission(world, reason) {
  const m = world.missions;
  if (!m.active) return;
  m.active.failReason = reason ?? 'failed';
  finishMission(world, false);
}

/**
 * One step of the mission runner: proximity to the marker, per-kind checks, timers, and the story
 * hand-offs. Called once per simulation step after the player has moved.
 */
export function updateMissions(world, dt) {
  const m = world.missions;
  m.messageTimer = Math.max(0, m.messageTimer - dt);
  m.failFlash = Math.max(0, m.failFlash - dt);
  m.cooldown = Math.max(0, m.cooldown - dt);
  m.toastTimer = Math.max(0, m.toastTimer - dt);
  if (m.toastTimer <= 0 && m.toast && m.toast.persistent) m.toast = null;

  // Offer side jobs at the garage, on a rhythm.
  m.offerTimer = Math.max(0, m.offerTimer - dt);
  if (!m.active && m.offerTimer <= 0 && m.cooldown <= 0) {
    m.offerTimer = 8;
    world.refreshOffers();
  }

  const a = m.active;
  if (!a) return;
  const st = a.stages[a.index];
  if (!st) return;
  const p = world.player;
  a.elapsed += dt;

  // A mission car's delivery is clean while its health stays up.
  if (st.kind === 'deliver' && st.car && st.car.health < st.car.maxHealth - 40) a.cleanRun = false;

  // Timers.
  if (st.timer && st.timer > 0) {
    st.timer -= dt;
    if (st.timer <= 0) {
      failMission(world, 'time');
      return;
    }
  }

  const inMarker = st.marker ? Math.hypot(p.x - st.marker.x, p.y - st.marker.y) < (st.radius ?? REACH) : false;

  switch (st.kind) {
    case 'go':
    case 'collect':
      if (st.kind === 'collect' && inMarker) {
        world.audio.play('pickup');
        world.burstPickup(st.marker.x, st.marker.y);
        advanceStage(world);
      } else if (st.kind === 'go' && inMarker) {
        if (st.near) world.showToast(a.title, 'Objective', st.near);
        // A go stage for a car advances when the player gets in; for a place, on arrival.
        if (st.car) {
          if (p.inCar === st.car) advanceStage(world);
        } else {
          advanceStage(world);
        }
      }
      break;
    case 'deliver':
      if (inMarker) {
        const rightCar = !st.car || p.inCar === st.car;
        if (rightCar) {
          world.audio.play('mission');
          advanceStage(world);
        }
      }
      break;
    case 'kill': {
      const alive = world.missionTargetsAlive(st);
      st.remaining = alive;
      if (alive === 0) {
        advanceStage(world);
      }
      break;
    }
    case 'checkpoint':
      if (inMarker) {
        world.audio.play('pickup');
        world.burstPickup(st.marker.x, st.marker.y);
        advanceStage(world);
      }
      break;
    case 'escape': {
      // Lose the heat and get clear of the scene.
      const clear = world.police.stars === 0;
      const far = !st.origin || Math.hypot(p.x - st.origin.x, p.y - st.origin.y) > (st.distance ?? 400);
      if (clear && far) advanceStage(world);
      break;
    }
    case 'survive':
      break;
    default:
      break;
  }
  // The player dying ends the job.
  if (p.dead) failMission(world, 'died');
}

/** Read a ped's death and hand it to the mission, for kill stages and hit contracts. */
export function onPedKilled(world, ped, cause) {
  world.stats.kills += 1;
  const a = world.missions.active;
  if (!a) return;
  const st = a.stages[a.index];
  if (!st || st.kind !== 'kill') return;
  if (st.targets && st.targets.includes(ped.id)) {
    st.remaining = world.missionTargetsAlive(st);
    world.showToast(a.title, 'Target down', st.remaining > 0 ? `${st.remaining} left` : 'Clear');
  }
  void cause;
}

/** The marker for the nearest offered job, for the map. */
export function offeredMarker(world) {
  const m = world.missions;
  if (m.active || m.available.length === 0) return null;
  return m.available[0];
}

export { MISSIONS, panicAround };
