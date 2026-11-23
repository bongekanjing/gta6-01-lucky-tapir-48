// Boot and the frame loop. This file owns the app object (screen state, menus, the world in play),
// builds the controls from the keyboard and mouse, and runs a fixed-step simulation with a render
// in between. It is also the entry the screenshot rig talks to through ?shot=name&seed=n.
//
// Fixed stepping: the world advances in STEP slices accumulated from real time, so a slow frame
// never changes the outcome. Rendering happens once per animation frame, whatever the step count.

import { MAX_FRAME, STEP, VIEW } from './config.js';
import { createWorld, fillWorld, stepWorld } from './game.js';
import { createRenderer } from './render.js';
import { createHud } from './hud.js';
import { createInput } from './input.js';
import { createScreens } from './ui.js';
import { runShot } from './shots.js';
import { createAudio } from './audio.js';
import { hasSave, save, load, applySave, saveSummary } from './save.js';
import { SIDE_JOBS, nextStory } from './missions.js';
import { selectWeapon } from './player.js';

const canvas = document.getElementById('screen');
const renderer = createRenderer(canvas);
const hud = createHud(canvas, renderer);
const input = createInput(canvas, VIEW);
const screens = createScreens();

/** The params a shot URL carries. */
const params = new URLSearchParams(location.search);
const shotName = params.get('shot');
const shotSeed = params.get('seed');

const app = {
  screen: 'title',
  world: null,
  time: 0,
  acc: 0,
  last: 0,
  hasSave: hasSave(),
  saveLabel: '',
  muted: false,
  controlsOpen: false,
  briefing: null,
  boardJobs: [],
  boardHover: -1,
  shotSeed,
  shotName,
  showFps: false,
  fade: 0,
  paused: false,
  hintTimer: 0,
  /** A slow drift on the title screen so the backdrop lives. */
  titleTime: 0,
};

app.audio = { play() {}, ensure() {}, carLoop() {}, siren() {}, silenceEngine() {}, musicTick() {}, setListener() {}, toggleMute() { return false; }, get muted() { return false; } };

// ---------------------------------------------------------------- the world in play

function freshWorld(seed = 1, opts = {}) {
  const world = createWorld(seed);
  fillWorld(world);
  world.audio = app.audio;
  if (opts.silent) world.scripted = true;
  return world;
}

/** Install a world built by the shot staging (or a new game) as the live one. */
app.applyShotWorld = (world, opts = {}) => {
  app.world = world;
  world.audio = app.audio;
  if (opts.screen) app.screen = opts.screen;
  app.showHud = opts.hud !== false;
  hud.prepare(world.city);
};

/** Start a brand new run from the garage. */
app.newGame = (seed = 1) => {
  app.audio.ensure();
  const world = freshWorld(seed);
  app.world = world;
  app.screen = 'playing';
  app.showHud = true;
  app.controlsOpen = false;
  app.paused = false;
  hud.prepare(world.city);
  world.camera.snap(world.player.x, world.player.y);
  world.showToast('Welcome to Solara Bay', 'A new day', 'Walk to the marker at the garage to start the story.', 'info');
  world.audio.play('mission');
  input.releaseAll();
};

app.continueGame = () => {
  app.audio.ensure();
  const data = load();
  if (!data) {
    app.newGame(data?.seed ?? 1);
    return;
  }
  const world = freshWorld(data.seed ?? 1);
  applySave(world, data);
  app.world = world;
  app.screen = 'playing';
  app.showHud = true;
  hud.prepare(world.city);
  world.showToast('Welcome back', 'Saved run', 'The city kept your seat warm.', 'info');
  world.audio.play('pickup');
  input.releaseAll();
};

app.saveGame = () => {
  if (!app.world) return;
  const ok = save(app.world);
  app.world.showToast(ok ? 'Game saved' : 'Could not save', ok ? 'Progress' : 'Storage blocked', ok ? 'This browser remembers the run.' : 'Private window? The run lives on anyway.', ok ? 'good' : 'bad');
  app.hasSave = hasSave();
  app.saveLabel = summaryLine();
  if (app.screen === 'paused') app.toastLine = ok ? 'Saved' : 'Save failed';
};

app.toggleMute = () => {
  app.muted = app.audio.toggleMute();
};

app.resume = () => {
  app.screen = 'playing';
  app.paused = false;
  input.releaseAll();
};

app.restart = () => {
  app.newGame(app.world?.seed ?? 1);
};

app.toTitle = () => {
  const world = app.world;
  app.screen = 'title';
  app.controlsOpen = false;
  app.hasSave = hasSave();
  app.saveLabel = summaryLine();
  // Keep the city alive behind the title rather than freezing on the last frame.
  if (world) {
    world.paused = false;
  }
};

app.showControls = () => {
  app.controlsOpen = true;
  screens.onCloseControls = () => {
    app.controlsOpen = false;
  };
};

app.acceptBriefing = () => {
  const b = app.briefing;
  app.briefing = null;
  app.screen = 'playing';
  if (!b) return;
  if (b.sideId) {
    app.world.startSideJob(b.sideId);
  } else {
    app.world.startStory();
  }
};

app.declineBriefing = () => {
  app.briefing = null;
  app.screen = 'playing';
  app.world.missions.cooldown = 4;
  app.world.showToast('Job declined', 'Rico', 'Come back when you change your mind.', 'info');
};

app.startSide = (id) => {
  app.screen = 'playing';
  const job = SIDE_JOBS[id];
  if (job && app.world) {
    app.briefing = { title: job.title, giver: 'Side job', body: job.brief, payout: job.payout, objectives: ['Reach the marker', 'Finish the job'], sideId: id, acceptLabel: 'Do it now' };
    app.screen = 'briefing';
  }
};

app.openBoard = () => {
  app.screen = 'board';
  app.boardHover = -1;
  app.boardJobs = [
    { id: 'delivery', title: 'Courier Run', color: '#8ed16a', payout: SIDE_JOBS.delivery.payout, body: SIDE_JOBS.delivery.brief, meta: `Delivered ${app.world.stats.deliveries} times` },
    { id: 'race', title: 'Street Race', color: '#e0b44a', payout: SIDE_JOBS.race.payout, body: SIDE_JOBS.race.brief, meta: `Raced ${app.world.stats.races} times` },
    { id: 'hit', title: 'Clean Hit', color: '#e4544a', payout: SIDE_JOBS.hit.payout, body: SIDE_JOBS.hit.brief, meta: `Contracts done ${app.world.stats.hits}` },
  ];
};

app.closeBoard = () => {
  app.screen = 'playing';
};

app.respawn = () => {
  if (!app.world) return;
  app.world.respawnPlayer();
  app.screen = 'playing';
  input.releaseAll();
};

// ---------------------------------------------------------------- the controls

/** Build the control object the player's update reads, from the live input. */
function buildControls(world) {
  const axis = input.axis();
  const mouseWorldX = (input.mouse.x - VIEW.w / 2) / world.camera.zoom + world.camera.x + world.camera.offsetX;
  const mouseWorldY = (input.mouse.y - VIEW.h / 2) / world.camera.zoom + world.camera.y + world.camera.offsetY;
  const p = world.player;
  const controls = {
    move: { x: axis.x, y: axis.y },
    sprint: input.down('ShiftLeft') || input.down('ShiftRight'),
    aim: null,
    fire: false,
    enter: false,
    exitCar: false,
    weaponSwitch: 0,
    throttle: 0,
    brake: 0,
    steer: 0,
    handbrake: false,
  };
  if (p.inCar) {
    controls.throttle = (input.down('KeyW') || input.down('ArrowUp') ? 1 : 0);
    controls.brake = (input.down('KeyS') || input.down('ArrowDown') ? 1 : 0);
    controls.steer = (input.down('KeyD') || input.down('ArrowRight') ? 1 : 0) - (input.down('KeyA') || input.down('ArrowLeft') ? 1 : 0);
    controls.handbrake = input.down('Space');
    controls.exitCar = input.hit('KeyF') || input.hit('KeyE');
    controls.fire = input.mouse.down;
  } else {
    // Aim at the cursor whenever the mouse is down or the pistol is out.
    controls.aim = { x: mouseWorldX, y: mouseWorldY };
    controls.fire = input.mouse.down || input.hit('KeyJ');
    controls.enter = input.hit('KeyF') || input.hit('KeyE');
    controls.exitCar = false;
  }
  if (input.hit('Digit1')) selectWeapon(p, 'fists');
  if (input.hit('Digit2') && p.hasWeapon.pistol) selectWeapon(p, 'pistol');
  if (input.hit('Digit3') && p.hasWeapon.smg) selectWeapon(p, 'smg');
  if (input.mouse.wheel !== 0) controls.weaponSwitch = input.mouse.wheel > 0 ? 1 : -1;
  if (input.hit('KeyQ')) controls.weaponSwitch = -1;
  return controls;
}

const IDLE = { move: { x: 0, y: 0 }, sprint: false, aim: null, fire: false, enter: false, exitCar: false, weaponSwitch: 0, throttle: 0, brake: 0, steer: 0, handbrake: false };

// ---------------------------------------------------------------- the loop

function frame(now) {
  requestAnimationFrame(frame);
  const dtReal = Math.min(MAX_FRAME, (now - app.last) / 1000 || 0);
  app.last = now;
  app.time += dtReal;
  const world = app.world;

  // Menus.
  updateGlobalKeys();

  if (world) {
    // A staged shot is a still: the scene was played forward for real, then held so the rig always
    // photographs the same frame.
    const simulating = !app.shotFrozen && screens.simulates(app.screen) && !app.paused;
    if (simulating) {
      app.acc += dtReal;
      let steps = 0;
      while (app.acc >= STEP && steps < 6) {
        const controls = app.screen === 'playing' ? buildControls(world) : IDLE;
        if (app.screen === 'playing' && world.player.dead) {
          // The death card owns the input.
        }
        stepWorld(world, controls, STEP);
        app.acc -= STEP;
        steps += 1;
      }
      if (app.acc > STEP * 6) app.acc = 0;
    } else {
      app.acc = 0;
    }
    // The title backdrop drifts its camera; gameplay frames the player.
    if (app.screen === 'title') {
      app.titleTime += dtReal;
      world.camera.zoom = 1.04 + Math.sin(app.titleTime * 0.12) * 0.03;
    }
    renderer.draw(world, { fade: app.fade });
    if (app.showHud !== false && (app.screen === 'playing' || app.screen === 'board' || app.screen === 'briefing' || app.screen === 'paused')) {
      hud.draw(world);
    }
    // The death card appears on its own.
    if (world.player.dead && app.screen === 'playing') {
      app.screen = 'dead';
    }
    // Offer the briefing when the player walks to the garage with no job running.
    maybeOffer(world);
    // Menus and screens sit on top of everything.
    const octx = renderer.beginOverlay();
    screens.draw(octx, app, world, input);
    renderer.endOverlay();
  } else {
    // No world yet (the first frame): a warm placeholder so the canvas is never blank.
    const ctx = renderer.beginOverlay();
    ctx.fillStyle = '#161018';
    ctx.fillRect(0, 0, VIEW.w, VIEW.h);
    renderer.endOverlay();
  }

  input.endFrame();
}

/** Esc, M and Tab are global; the mouse clicks press the menus. */
function updateGlobalKeys() {
  if (input.take('Escape')) {
    if (app.screen === 'playing') {
      app.screen = 'paused';
      app.paused = true;
      input.releaseAll();
    } else if (app.screen === 'paused') {
      app.resume();
    } else if (app.controlsOpen) {
      app.controlsOpen = false;
    }
  }
  if (input.take('KeyM')) {
    app.toggleMute();
    if (app.world) app.world.showToast(app.muted ? 'Sound off' : 'Sound on', 'Audio', '', 'info');
  }
  if (input.take('Tab')) {
    app.showHud = true;
    if (app.world) app.world.showControls = !app.world.showControls;
  }
  if (input.take('Enter') && app.screen === 'title') {
    if (app.hasSave) app.continueGame();
    else app.newGame();
  }
  // Mouse clicks press the screen's buttons.
  if (input.mouse.clicked) {
    const inside = app.showHud !== false;
    void inside;
    const consumed = screens.click(input.mouse.x, input.mouse.y, app);
    if (!consumed && app.screen === 'title' && !app.controlsOpen) app.audio.ensure();
  }
  // The board's hover, tracked per frame from the button list.
  if (app.screen === 'board') {
    app.boardHover = screenHoverIndex();
  }
}

function screenHoverIndex() {
  // The job cards sit in a fixed row; approximate their rects for the hover highlight.
  const w = 800;
  const x = VIEW.w / 2 - w / 2;
  const cardW = (w - 68 - 32) / 3;
  const y = 108 + 104;
  for (let i = 0; i < 3; i += 1) {
    const cx = x + 34 + i * (cardW + 16);
    if (input.mouse.x >= cx && input.mouse.x <= cx + cardW && input.mouse.y >= y && input.mouse.y <= y + 300) return i;
  }
  return -1;
}

/** When the player is at the garage with nothing running, offer the next job. */
let offerGuard = 0;
function maybeOffer(world) {
  if (app.screen !== 'playing' || world.missions.active) return;
  offerGuard += 1;
  if (offerGuard < 30) return;
  offerGuard = 0;
  const poi = world.city.poi.safehouse;
  const d = Math.hypot(world.player.x - poi.x, world.player.y - poi.y);
  if (d > 74) return;
  if (world.missions.cooldown > 0) return;
  const story = nextStory(world);
  if (story) {
    app.briefing = {
      title: story.title,
      giver: story.giver,
      body: story.brief,
      payout: story.payout,
      objectives: objectivesOf(world, story),
      sideId: null,
      acceptLabel: 'Take the job',
    };
    app.screen = 'briefing';
    app.paused = true;
    input.releaseAll();
    world.audio.play('mission');
    return;
  }
  // Story done: the board of side jobs.
  app.openBoard();
  app.paused = true;
  input.releaseAll();
}

/** The first three stage texts of a mission, for the briefing card. */
function objectivesOf(world, mission) {
  try {
    const stages = mission.build(world);
    return stages.slice(0, 3).map((s) => s.text);
  } catch {
    return ['Reach the marker', 'Complete the job'];
  }
}

// ---------------------------------------------------------------- boot

function summaryLine() {
  const data = load();
  return data ? saveSummary(data) : '';
}

async function boot() {
  app.saveLabel = summaryLine();
  app.audio = createAudioLazy();
  // A world behind the title from the very first frame.
  const world = freshWorld(shotSeed ? Number(shotSeed) : 1);
  app.world = world;
  hud.prepare(world.city);

  if (shotName) {
    const res = await runShot(app, shotName);
    app.world = res.world;
    app.showHud = res.name !== 'start';
    hud.prepare(app.world.city);
    renderer.draw(app.world, {});
    if (app.showHud) hud.draw(app.world);
    // Play-forward is done: hold this exact frame until the rig has taken it.
    app.shotFrozen = true;
    if (app.showHud) hud.draw(app.world);
    // Signal the rig that the canvas holds a settled frame.
    window.__shotReady = true;
    window.__shotInfo = { name: shotName, seed: app.world.seed, cars: app.world.cars.length, peds: app.world.peds.length, stars: app.world.police.stars };
  } else {
    app.screen = 'title';
    app.showHud = false;
    app.saveLabel = summaryLine();
    app.hasSave = hasSave();
    window.__shotReady = true;
  }
  app.last = performance.now();
  requestAnimationFrame(frame);
}

/** The real audio module, created lazily so the file never runs before a gesture. */
function createAudioLazy() {
  let inner = null;
  const ensure = () => {
    if (!inner) {
      try {
        inner = createAudio();
      } catch {
        inner = null;
        return null;
      }
    }
    inner.ensure();
    return inner;
  };
  return {
    ensure,
    play: (n, o) => inner?.play(n, o),
    carLoop: (c, dt) => inner?.carLoop(c, dt),
    siren: (c, dt, d) => inner?.siren(c, dt, d),
    silenceEngine: () => inner?.silenceEngine(),
    musicTick: (dt) => inner?.musicTick(dt),
    setListener: (x, y) => inner?.setListener(x, y),
    toggleMute: () => {
      if (!inner) return false;
      return inner.toggleMute();
    },
    get muted() {
      return inner?.muted ?? false;
    },
  };
}

// The gesture gate for Chrome's autoplay policy.
input.onGesture = () => {
  app.audio.ensure();
};

boot();

export { app, canvas, renderer, hud };
