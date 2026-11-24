// The renderer: everything the player sees of the world, painted with Canvas 2D in a warm late
// afternoon. Draw order is depth: sky and sea, sand and roads, then a shadow pass, then the
// ground clutter, the bodies, and finally the light grading and vignette.
//
// Buildings are drawn as extruded blocks: a footprint on the ground, a wall rising toward the
// sun's opposite side, and a roof plate on top whose height depends on the camera's distance, so
// downtown reads as a real skyline. Shadows are long parallelograms cast away from the sun.

import { CAR, LIGHT, PALETTE, VIEW, WEAPONS } from './config.js';
import { cameraOffset, screenToWorld, viewRect } from './camera.js';
import { carCorners } from './vehicles.js';
import { missionMarker } from './missions.js';
import { alpha, clamp, dist, fillRoundRect, hash01, lerp, money, shade, starPath, strokeRoundRect } from './util.js';

/** The sun direction on screen, for shadow offsets and the sky's glow. */
const SUN = { x: LIGHT.sunX, y: LIGHT.sunY };
const SHADOW = { x: LIGHT.shadowX, y: LIGHT.shadowY };

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d', { alpha: false });
  const state = {
    canvas,
    ctx,
    dpr: 1,
    scale: 1,
    time: 0,
  };

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.floor(window.innerWidth);
    const h = Math.floor(window.innerHeight);
    canvas.width = Math.max(320, Math.floor(w * dpr));
    canvas.height = Math.max(180, Math.floor(h * dpr));
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    state.dpr = dpr;
    state.scale = Math.min(canvas.width / VIEW.w, canvas.height / VIEW.h);
    // Letterbox: the logical view is 16:9 and centred.
    state.offsetX = (canvas.width - VIEW.w * state.scale) / 2;
    state.offsetY = (canvas.height - VIEW.h * state.scale) / 2;
  }
  resize();
  window.addEventListener('resize', resize);

  const api = {
    resize,
    /** Draw one frame of the world. `fx` holds transient screen effects (flash, fade). */
    draw(world, fx = {}) {
      state.time = world.clock;
      const { ctx } = state;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#1a1410';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.translate(state.offsetX, state.offsetY);
      ctx.scale(state.scale, state.scale);

      // Clip to the logical frame so the letterbox stays clean.
      ctx.beginPath();
      ctx.rect(0, 0, VIEW.w, VIEW.h);
      ctx.clip();

      drawWorld(ctx, world, state);
      drawScreenEffects(ctx, world, fx);
      ctx.restore();
      return state;
    },
    /** A click position in world space. */
    toWorld(world, sx, sy) {
      return screenToWorld(world.camera, (sx * state.scale + state.offsetX) / state.scale, (sy * state.scale + state.offsetY) / state.scale, VIEW);
    },
    /** Begin a pass in logical 1280x720 space over the finished world frame (HUD, menus). */
    beginOverlay() {
      const { ctx } = state;
      ctx.save();
      ctx.translate(state.offsetX, state.offsetY);
      ctx.scale(state.scale, state.scale);
      ctx.beginPath();
      ctx.rect(0, 0, VIEW.w, VIEW.h);
      ctx.clip();
      return ctx;
    },
    endOverlay() {
      state.ctx.restore();
    },
    /** The context, already in logical space, for callers that draw their own overlay pass. */
    get overlayCtx() {
      return this.beginOverlay();
    },
    get layout() {
      return { scale: state.scale, offsetX: state.offsetX, offsetY: state.offsetY, dpr: state.dpr };
    },
    ctx,
  };
  return api;
}

/** The whole world pass. */
function drawWorld(ctx, world, state) {
  const cam = world.camera;
  const zoom = cam.zoom;
  const off = cameraOffset(cam);
  const view = viewRect(cam, 260);
  ctx.save();
  ctx.translate(VIEW.w / 2, VIEW.h / 2);
  ctx.scale(zoom, zoom);
  ctx.translate(-off.x, -off.y);

  drawSea(ctx, world, view, state.time);
  drawBeach(ctx, world, view);
  drawGround(ctx, world, view);
  drawRoads(ctx, world, view);
  drawRoadMarkings(ctx, world, view);
  drawShadows(ctx, world, view);
  drawSidewalkProps(ctx, world, view, state.time);
  drawParkProps(ctx, world, view, state.time);
  drawGroundDecals(ctx, world, view);
  drawPickups(ctx, world, view, state.time);
  drawPeds(ctx, world, view, state.time);
  drawCars(ctx, world, view, state.time);
  drawPlayer(ctx, world, view, state.time);
  drawObjectiveMarker(ctx, world, view, state.time);
  drawBullets(ctx, world, view);
  drawParticles(ctx, world, view);
  drawBuildingTops(ctx, world, view);

  ctx.restore();
  drawLighting(ctx, world);
}

// ---------------------------------------------------------------- sea and sand

function drawSea(ctx, world, view, t) {
  const x0 = Math.max(world.city.bounds.x0 - 400, view.x0);
  if (x0 > 40) return;
  const w = -20 - x0;
  const h = view.y1 - view.y0;
  const g = ctx.createLinearGradient(x0, 0, 0, 0);
  g.addColorStop(0, '#0f4c66');
  g.addColorStop(0.55, '#1b7085');
  g.addColorStop(0.86, '#2f9fa8');
  g.addColorStop(1, '#57c4bc');
  ctx.fillStyle = g;
  ctx.fillRect(x0, view.y0, w, h);

  // Long slow swell lines, brighter toward the shore.
  ctx.lineWidth = 2.2;
  for (let i = 0; i < 26; i += 1) {
    const bx = x0 + ((i * 61 + (t * 12) % 61) % Math.max(1, w));
    if (bx > -30) continue;
    const by = view.y0 + ((i * 173) % h);
    const depth = clamp((bx - x0) / Math.max(1, w), 0, 1);
    ctx.strokeStyle = `rgba(226,246,240,${0.05 + depth * 0.14})`;
    ctx.beginPath();
    const len = 60 + (i % 4) * 30;
    ctx.moveTo(bx, by);
    ctx.quadraticCurveTo(bx + len * 0.5, by - 5 + Math.sin(t + i) * 2, bx + len, by + 1);
    ctx.stroke();
  }
  // Surf: a bright band and foam scallops along the shore.
  const surf = ctx.createLinearGradient(-64, 0, -24, 0);
  surf.addColorStop(0, 'rgba(233,248,240,0)');
  surf.addColorStop(0.7, 'rgba(233,248,240,0.55)');
  surf.addColorStop(1, 'rgba(233,248,240,0)');
  ctx.fillStyle = surf;
  ctx.fillRect(-64, view.y0, 42, h);
  ctx.strokeStyle = 'rgba(255,255,255,0.62)';
  ctx.lineWidth = 3;
  for (let y = Math.floor(view.y0 / 46) * 46; y < view.y1; y += 46) {
    const wob = Math.sin(t * 1.4 + y * 0.05) * 4;
    ctx.beginPath();
    ctx.moveTo(-58 + wob, y);
    ctx.quadraticCurveTo(-44 + wob, y + 6, -30 + wob, y + 1);
    ctx.stroke();
  }
  // The pier and its shadow on the water.
  for (const p of world.city.piers) {
    if (p.x > view.x1 || p.x + p.w < view.x0 || p.y > view.y1 || p.y + p.h < view.y0) continue;
    ctx.save();
    ctx.translate(18, 26);
    ctx.fillStyle = 'rgba(6,40,52,0.35)';
    ctx.fillRect(p.x, p.y, p.w, p.h);
    ctx.restore();
    const planks = ctx.createLinearGradient(0, p.y, 0, p.y + p.h);
    planks.addColorStop(0, '#a98f6c');
    planks.addColorStop(0.5, '#c2a67c');
    planks.addColorStop(1, '#9b8161');
    ctx.fillStyle = planks;
    ctx.fillRect(p.x, p.y, p.w, p.h);
    ctx.strokeStyle = 'rgba(80,60,42,0.35)';
    ctx.lineWidth = 1;
    for (let x = p.x; x < p.x + p.w; x += 9) {
      ctx.beginPath();
      ctx.moveTo(x, p.y);
      ctx.lineTo(x, p.y + p.h);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255,240,210,0.28)';
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + p.w, p.y);
    ctx.stroke();
  }
  // A boat or two, bobbing.
  for (const p of world.city.props) {
    if (p.kind !== 'boat') continue;
    drawBoat(ctx, p, t);
  }
}

function drawBoat(ctx, p, t) {
  ctx.save();
  ctx.translate(p.x, p.y + Math.sin(t * 0.8 + p.x) * 2);
  ctx.rotate(p.angle);
  ctx.scale(p.size, p.size);
  ctx.fillStyle = 'rgba(8,44,56,0.3)';
  ctx.beginPath();
  ctx.ellipse(8, 12, 34, 12, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = p.color;
  ctx.beginPath();
  ctx.moveTo(-34, -9);
  ctx.quadraticCurveTo(0, -14, 34, -7);
  ctx.quadraticCurveTo(38, 0, 32, 7);
  ctx.quadraticCurveTo(0, 12, -34, 7);
  ctx.quadraticCurveTo(-38, 0, -34, -9);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.fillRect(-26, -8, 50, 2);
  ctx.fillStyle = '#f2ecdc';
  ctx.fillRect(-10, -2, 20, 7);
  ctx.strokeStyle = '#b7ac93';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(6, -1);
  ctx.lineTo(6, -22);
  ctx.stroke();
  ctx.restore();
}

function drawBeach(ctx, world, view) {
  const x0 = Math.max(world.city.bounds.x0, view.x0);
  if (x0 > 0) return;
  const x1 = Math.min(0, view.x1);
  if (x1 <= x0) return;
  const g = ctx.createLinearGradient(-70, 0, 0, 0);
  g.addColorStop(0, '#d9bd8b');
  g.addColorStop(0.35, PALETTE.sandWet);
  g.addColorStop(0.42, '#e8d3a4');
  g.addColorStop(1, PALETTE.sand);
  ctx.fillStyle = g;
  ctx.fillRect(x0, view.y0, x1 - x0, view.y1 - view.y0);
  // Fine sand texture: sparse warm dashes, deterministic per cell.
  ctx.fillStyle = 'rgba(170,140,95,0.22)';
  const step = 40;
  const gx0 = Math.floor(x0 / step) * step;
  for (let x = gx0; x < x1; x += step) {
    for (let y = Math.floor(view.y0 / step) * step; y < view.y1; y += step) {
      const h = hash01(x, y, 7);
      if (h < 0.45) continue;
      ctx.fillRect(x + h * 22, y + hash01(y, x, 3) * 30, 5 + h * 8, 1.6);
    }
  }
  // The promenade edge: a pale band where the sand meets the seawall.
  ctx.fillStyle = '#cfc0a4';
  ctx.fillRect(-26, view.y0, 8, view.y1 - view.y0);
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.fillRect(-27, view.y0, 2, view.y1 - view.y0);
}

/** The seawall bulkhead and railing along the shore. */
function drawSeawall(ctx, view) {
  if (view.x0 > 30) return;
  ctx.fillStyle = '#b9a887';
  ctx.fillRect(-22, view.y0, 16, view.y1 - view.y0);
  ctx.fillStyle = 'rgba(60,48,36,0.25)';
  ctx.fillRect(-6, view.y0, 4, view.y1 - view.y0);
}

function drawGround(ctx, world, view) {
  // The city's paved apron: sidewalk colour fills the whole grid area, then blocks paint over it.
  const b = world.city.bounds;
  const x0 = Math.max(b.x0, view.x0);
  const x1 = Math.min(b.x1, view.x1);
  const y0 = Math.max(b.y0, view.y0);
  const y1 = Math.min(b.y1, view.y1);
  if (x0 > x1 || y0 > y1) return;
  ctx.fillStyle = PALETTE.walkEdge;
  ctx.fillRect(x0 + 18, y0, x1 - x0 - 36, y1 - y0);
}

function drawRoads(ctx, world, view) {
  const city = world.city;
  const g = city.grid;
  // The asphalt: one wide band per road line, clipped to the view.
  ctx.fillStyle = PALETTE.asphalt;
  const first = Math.max(0, Math.floor(view.y0 / g) - 1);
  for (let j = first; j * g < view.y1 && j <= city.rows; j += 1) {
    ctx.fillRect(view.x0, j * g - 44, view.x1 - view.x0, 88);
  }
  for (let i = Math.max(0, Math.floor(view.x0 / g) - 1); i * g < view.x1 && i <= city.cols; i += 1) {
    ctx.fillRect(i * g - 44, view.y0, 88, view.y1 - view.y0);
  }
  // Intersections: a soft patch so the crossing reads as one surface.
  for (let i = Math.max(0, Math.floor(view.x0 / g) - 1); i * g < view.x1 + g && i <= city.cols; i += 1) {
    for (let j = Math.max(0, Math.floor(view.y0 / g) - 1); j * g < view.y1 + g && j <= city.rows; j += 1) {
      ctx.fillStyle = 'rgba(60,60,70,0.5)';
      ctx.fillRect(i * g - 44, j * g - 44, 88, 88);
    }
  }
  // Kerb lines.
  ctx.strokeStyle = PALETTE.curb;
  ctx.lineWidth = 2;
  for (let j = first; j * g < view.y1 && j <= city.rows; j += 1) {
    ctx.beginPath();
    ctx.moveTo(view.x0, j * g - 44);
    ctx.lineTo(view.x1, j * g - 44);
    ctx.moveTo(view.x0, j * g + 44);
    ctx.lineTo(view.x1, j * g + 44);
    ctx.stroke();
  }
  for (let i = Math.max(0, Math.floor(view.x0 / g) - 1); i * g < view.x1 && i <= city.cols; i += 1) {
    ctx.beginPath();
    ctx.moveTo(i * g - 44, view.y0);
    ctx.lineTo(i * g - 44, view.y1);
    ctx.moveTo(i * g + 44, view.y0);
    ctx.lineTo(i * g + 44, view.y1);
    ctx.stroke();
  }
  // Sidewalks: the paved apron inside each block's ring.
  for (const block of world.city.blocks) {
    if (block.x > view.x1 || block.x + block.w < view.x0 || block.y > view.y1 || block.y + block.h < view.y0) continue;
    ctx.fillStyle = PALETTE.walk;
    ctx.fillRect(block.x - 16, block.y - 16, block.w + 32, block.h + 32);
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.fillRect(block.x - 16, block.y - 16, block.w + 32, 3);
    // Expansion-joint ticks along the walk.
    ctx.strokeStyle = 'rgba(120,104,80,0.22)';
    ctx.lineWidth = 1;
    for (let x = block.x - 8; x < block.x + block.w + 16; x += 34) {
      ctx.beginPath();
      ctx.moveTo(x, block.y - 16);
      ctx.lineTo(x, block.y);
      ctx.moveTo(x, block.y + block.h);
      ctx.lineTo(x, block.y + block.h + 16);
      ctx.stroke();
    }
    for (let y = block.y; y < block.y + block.h; y += 34) {
      ctx.beginPath();
      ctx.moveTo(block.x - 16, y);
      ctx.lineTo(block.x, y);
      ctx.moveTo(block.x + block.w, y);
      ctx.lineTo(block.x + block.w + 16, y);
      ctx.stroke();
    }
    // The inner surface: lawns, lots, or the building footprint's forecourt.
    if (block.kind === 'park' && block.park) {
      drawParkGround(ctx, block, view, world);
    } else if (block.kind === 'lot' && block.lot) {
      drawLot(ctx, block, world, view);
    } else {
      ctx.fillStyle = '#c3b394';
      ctx.fillRect(block.x, block.y, block.w, block.h);
      // Forecourt paving with a subtle checker.
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      for (let x = block.x; x < block.x + block.w; x += 28) {
        for (let y = block.y + ((x / 28) % 2) * 14; y < block.y + block.h; y += 28) {
          ctx.fillRect(x, y, 14, 14);
        }
      }
    }
  }
  drawSeawall(ctx, view);
}

function drawParkGround(ctx, block, view, world) {
  const p = block.park;
  ctx.fillStyle = PALETTE.grass;
  ctx.fillRect(block.x, block.y, block.w, block.h);
  // A lighter mown patch and a dirt path cross.
  ctx.fillStyle = 'rgba(150,176,96,0.45)';
  ctx.fillRect(block.x + 18, block.y + 18, block.w - 36, block.h - 36);
  if (p.path) {
    ctx.fillStyle = '#cbb894';
    ctx.fillRect(block.x + block.w / 2 - 9, block.y, 18, block.h);
    ctx.fillRect(block.x, block.y + block.h / 2 - 9, block.w, 18);
    ctx.fillStyle = 'rgba(140,120,90,0.35)';
    ctx.fillRect(block.x + block.w / 2 - 9, block.y, 2, block.h);
    ctx.fillRect(block.x, block.y + block.h / 2 - 9, block.w, 2);
  }
  // Fountain or bandstand at the centre.
  const cx = block.x + block.w / 2;
  const cy = block.y + block.h / 2;
  if (p.fountain) {
    ctx.fillStyle = '#b7a98f';
    ctx.beginPath();
    ctx.arc(cx, cy, p.fountain.r + 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#6fc6c9';
    ctx.beginPath();
    ctx.arc(cx, cy, p.fountain.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, p.fountain.r * 0.6, 0.4, 2.2);
    ctx.stroke();
    // The jet.
    const wob = Math.sin(world.clock * 3) * 1.5;
    ctx.fillStyle = 'rgba(233,250,246,0.85)';
    ctx.beginPath();
    ctx.ellipse(cx + wob, cy - 2, 3.4, 6, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  if (p.bandstand) {
    ctx.fillStyle = '#d9cdb4';
    ctx.beginPath();
    ctx.arc(p.bandstand.x, p.bandstand.y, p.bandstand.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#b9a687';
    ctx.beginPath();
    ctx.arc(p.bandstand.x, p.bandstand.y, p.bandstand.r * 0.72, 0, Math.PI * 2);
    ctx.fill();
  }
  // Trees.
  for (const tree of p.trees) drawTree(ctx, tree.x, tree.y, tree.size, tree.tone, world.clock);
}

function drawTree(ctx, x, y, size, tone, t) {
  const s = size;
  ctx.fillStyle = 'rgba(30,40,24,0.28)';
  ctx.beginPath();
  ctx.ellipse(x + 8 * s, y + 7 * s, 13 * s, 9 * s, 0, 0, Math.PI * 2);
  ctx.fill();
  const greens = [['#4e7434', '#6b9247'], ['#54763a', '#729a52'], ['#476a30', '#638c42']][tone % 3];
  ctx.fillStyle = '#5f4a33';
  ctx.fillRect(x - 2 * s, y - 4 * s, 4 * s, 10 * s);
  const sway = Math.sin(t * 0.8 + x * 0.01) * 1.4;
  ctx.fillStyle = greens[0];
  ctx.beginPath();
  ctx.arc(x + sway, y - 9 * s, 12 * s, 0, Math.PI * 2);
  ctx.arc(x - 7 * s + sway, y - 4 * s, 8 * s, 0, Math.PI * 2);
  ctx.arc(x + 7 * s + sway, y - 5 * s, 8.5 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = greens[1];
  ctx.beginPath();
  ctx.arc(x - 2 * s + sway, y - 12 * s, 7 * s, 0, Math.PI * 2);
  ctx.arc(x + 5 * s + sway, y - 8 * s, 5.5 * s, 0, Math.PI * 2);
  ctx.fill();
}

function drawLot(ctx, block, world, view) {
  ctx.fillStyle = '#4a4a52';
  ctx.fillRect(block.x, block.y, block.w, block.h);
  ctx.fillStyle = '#55555e';
  ctx.fillRect(block.x + 4, block.y + 4, block.w - 8, block.h - 8);
  if (!block.lot) return;
  ctx.strokeStyle = 'rgba(240,232,210,0.5)';
  ctx.lineWidth = 1.4;
  for (const bay of block.lot.bays) {
    ctx.strokeRect(bay.x + 2, bay.y + 2, bay.w - 4, bay.h - 4);
  }
  // Kerb islands.
  ctx.fillStyle = '#b9ab8d';
  ctx.fillRect(block.x + 6, block.y + block.h - 10, block.w - 12, 4);
}

// ---------------------------------------------------------------- road paint

function drawRoadMarkings(ctx, world, view) {
  const g = world.city.grid;
  ctx.save();
  // Dashed centre lines down every road, skipped at the crossings.
  ctx.strokeStyle = 'rgba(231,221,198,0.55)';
  ctx.lineWidth = 2.4;
  ctx.setLineDash([16, 18]);
  for (let j = Math.max(0, Math.floor(view.y0 / g) - 1); j * g < view.y1 && j <= world.city.rows; j += 1) {
    const y = j * g;
    for (let i = Math.max(0, Math.floor(view.x0 / g) - 1); i * g < view.x1 && i <= world.city.cols; i += 1) {
      const x = i * g;
      if (x > view.x0 - 20) {
        ctx.beginPath();
        ctx.moveTo(x + 50, y);
        ctx.lineTo(x + g - 50, y);
        ctx.stroke();
      }
    }
  }
  for (let i = Math.max(0, Math.floor(view.x0 / g) - 1); i * g < view.x1 && i <= world.city.cols; i += 1) {
    const x = i * g;
    for (let j = Math.max(0, Math.floor(view.y0 / g) - 1); j * g < view.y1 && j <= world.city.rows; j += 1) {
      const y = j * g;
      if (y > view.y0 - 20) {
        ctx.beginPath();
        ctx.moveTo(x, y + 50);
        ctx.lineTo(x, y + g - 50);
        ctx.stroke();
      }
    }
  }
  ctx.setLineDash([]);
  // Zebra crossings beyond each corner of an intersection.
  ctx.fillStyle = 'rgba(236,228,208,0.62)';
  for (let i = Math.max(0, Math.floor(view.x0 / g) - 1); i * g < view.x1 && i <= world.city.cols; i += 1) {
    for (let j = Math.max(0, Math.floor(view.y0 / g) - 1); j * g < view.y1 && j <= world.city.rows; j += 1) {
      const x = i * g;
      const y = j * g;
      for (const side of [-1, 1]) {
        // Across the north and south approaches.
        for (let k = 0; k < 6; k += 1) {
          ctx.fillRect(x - 34 + k * 12, y + side * 50 - 3, 7, 6);
          ctx.fillRect(x + side * 50 - 3, y - 34 + k * 12, 6, 7);
        }
      }
    }
  }
  ctx.restore();
}

// ---------------------------------------------------------------- shadows

function drawShadows(ctx, world, view) {
  const city = world.city;
  ctx.save();
  ctx.fillStyle = 'rgba(26,32,40,0.30)';
  // Buildings: a long parallelogram away from the sun.
  for (const b of city.buildings) {
    if (b.x > view.x1 + 260 || b.x + b.w < view.x0 - 40 || b.y > view.y1 + 260 || b.y + b.h < view.y0 - 40) continue;
    const len = b.height * 0.9;
    const dx = SHADOW.x * len;
    const dy = SHADOW.y * len * 0.72;
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x + b.w, b.y);
    ctx.lineTo(b.x + b.w + dx, b.y + b.h + dy);
    ctx.lineTo(b.x + dx, b.y + b.h + dy);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

// ---------------------------------------------------------------- street clutter

function drawSidewalkProps(ctx, world, view, t) {
  const city = world.city;
  for (const p of city.props) {
    if (p.x < view.x0 || p.x > view.x1 || p.y < view.y0 || p.y > view.y1) continue;
    switch (p.kind) {
      case 'lamp':
        drawLamp(ctx, p, t);
        break;
      case 'bench':
        drawBench(ctx, p);
        break;
      case 'bin':
        drawBin(ctx, p);
        break;
      case 'awning':
        drawAwning(ctx, p);
        break;
      case 'umbrella':
        drawUmbrella(ctx, p, t);
        break;
      case 'towel':
        drawTowel(ctx, p);
        break;
      case 'lifeguard':
        drawLifeguard(ctx, p);
        break;
      case 'pierpost':
        ctx.fillStyle = '#6f5a41';
        ctx.fillRect(p.x - 2, p.y - 3, 5, 6);
        break;
      case 'pierlamp':
        ctx.fillStyle = '#4d4034';
        ctx.fillRect(p.x - 1.6, p.y - 24, 3.2, 26);
        ctx.fillStyle = '#ffe6a8';
        ctx.beginPath();
        ctx.arc(p.x, p.y - 25, 3.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,226,160,0.18)';
        ctx.beginPath();
        ctx.arc(p.x, p.y - 25, 12, 0, Math.PI * 2);
        ctx.fill();
        break;
      default:
        break;
    }
  }
  // Palms (drawn after the clutter so their crowns overlap the street).
  for (const palm of city.palms) {
    if (palm.x < view.x0 - 40 || palm.x > view.x1 + 40 || palm.y < view.y0 - 60 || palm.y > view.y1 + 40) continue;
    drawPalm(ctx, palm, t);
  }
}

function drawLamp(ctx, p, t) {
  void t;
  ctx.fillStyle = 'rgba(24,28,34,0.26)';
  ctx.beginPath();
  ctx.ellipse(p.x + 8, p.y + 4, 9, 4, 0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#3f4750';
  ctx.lineWidth = 2.6;
  ctx.beginPath();
  ctx.moveTo(p.x, p.y);
  ctx.lineTo(p.x, p.y - 34);
  ctx.stroke();
  ctx.strokeStyle = '#4d5560';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(p.x, p.y - 34);
  ctx.quadraticCurveTo(p.x + 8, p.y - 38, p.x + 14, p.y - 33);
  ctx.stroke();
  ctx.fillStyle = '#ffe4a2';
  ctx.beginPath();
  ctx.arc(p.x + 15, p.y - 31, 3, 0, Math.PI * 2);
  ctx.fill();
}

function drawBench(ctx, p) {
  const horizontal = p.side === 'n' || p.side === 's';
  ctx.save();
  ctx.translate(p.x, p.y);
  if (!horizontal) ctx.rotate(Math.PI / 2);
  ctx.fillStyle = 'rgba(20,26,32,0.22)';
  ctx.fillRect(-11, 2, 24, 5);
  ctx.fillStyle = '#8a6a4a';
  ctx.fillRect(-12, -3, 24, 3.4);
  ctx.fillRect(-12, 1.4, 24, 3);
  ctx.fillStyle = '#6d533a';
  ctx.fillRect(-11, -3, 2.4, 9);
  ctx.fillRect(9, -3, 2.4, 9);
  ctx.restore();
}

function drawBin(ctx, p) {
  ctx.fillStyle = 'rgba(20,26,32,0.2)';
  ctx.beginPath();
  ctx.ellipse(p.x + 4, p.y + 3, 6, 3, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#4d5a52';
  ctx.beginPath();
  ctx.arc(p.x, p.y, 4.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#6a7a70';
  ctx.beginPath();
  ctx.arc(p.x, p.y - 0.8, 3.4, 0, Math.PI * 2);
  ctx.fill();
}

function drawAwning(ctx, p) {
  if (p.w) {
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x, p.y, p.w, 7);
    ctx.fillStyle = 'rgba(255,255,255,0.32)';
    for (let x = p.x + 2; x < p.x + p.w - 4; x += 12) ctx.fillRect(x, p.y, 6, 7);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(p.x, p.y + 7, p.w, 3);
  } else if (p.h) {
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x, p.y, 7, p.h);
    ctx.fillStyle = 'rgba(255,255,255,0.32)';
    for (let y = p.y + 2; y < p.y + p.h - 4; y += 12) ctx.fillRect(p.x, y, 7, 6);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(p.x + 7, p.y, 3, p.h);
  }
}

function drawUmbrella(ctx, p, t) {
  const sway = Math.sin(t * 0.6 + p.phase) * 1.2;
  ctx.fillStyle = 'rgba(60,40,20,0.26)';
  ctx.beginPath();
  ctx.ellipse(p.x + 7, p.y + 5, 15, 7, 0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#8a7350';
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.moveTo(p.x, p.y);
  ctx.lineTo(p.x + sway, p.y - 20);
  ctx.stroke();
  ctx.fillStyle = p.color;
  ctx.beginPath();
  ctx.ellipse(p.x + sway, p.y - 20, 16, 9, 0, Math.PI, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.beginPath();
  ctx.ellipse(p.x + sway, p.y - 22, 15, 7.4, 0, Math.PI, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(p.x + sway - 14, p.y - 20);
  ctx.lineTo(p.x + sway + 14, p.y - 20);
  ctx.stroke();
}

function drawTowel(ctx, p) {
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.rot);
  ctx.fillStyle = p.color;
  ctx.fillRect(-11, -6, 22, 12);
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.fillRect(-11, -6, 22, 3);
  ctx.restore();
}

function drawLifeguard(ctx, p) {
  ctx.fillStyle = 'rgba(50,40,24,0.24)';
  ctx.fillRect(p.x + 5, p.y + 4, p.w, p.h);
  ctx.fillStyle = '#f2e6cc';
  ctx.fillRect(p.x, p.y, p.w, p.h);
  ctx.fillStyle = '#3f8f8f';
  ctx.fillRect(p.x, p.y + p.h - 9, p.w, 5);
  ctx.fillStyle = '#d9583f';
  ctx.fillRect(p.x + 6, p.y - 4, 14, 4);
  ctx.strokeStyle = '#8a7350';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(p.x + 3, p.y + p.h);
  ctx.lineTo(p.x + 3, p.y + p.h + 12);
  ctx.moveTo(p.x + p.w - 3, p.y + p.h);
  ctx.lineTo(p.x + p.w - 3, p.y + p.h + 12);
  ctx.stroke();
}

function drawPalm(ctx, palm, t) {
  const s = palm.size;
  const sway = Math.sin(t * 0.7 + palm.phase) * 2.4 + palm.lean * 12;
  ctx.save();
  ctx.translate(palm.x, palm.y);
  // Shadow.
  ctx.fillStyle = 'rgba(24,34,30,0.24)';
  ctx.beginPath();
  ctx.ellipse(12 * s, 6 * s, 15 * s, 8 * s, 0.5, 0, Math.PI * 2);
  ctx.fill();
  // Trunk, slightly curved, with ring bands.
  ctx.strokeStyle = '#8a6a48';
  ctx.lineWidth = 4.4 * s;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(0, 2);
  ctx.quadraticCurveTo(sway * 0.4, -22 * s, sway, -40 * s);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(58,42,28,0.35)';
  ctx.lineWidth = 1.1 * s;
  for (let i = 1; i < 7; i += 1) {
    const tt = i / 7;
    const px = lerp(0, sway, tt * tt);
    const py = 2 - 42 * s * tt;
    ctx.beginPath();
    ctx.moveTo(px - 2.6 * s, py);
    ctx.lineTo(px + 2.6 * s, py);
    ctx.stroke();
  }
  // Crown: fronds.
  const cx = sway;
  const cy = -40 * s;
  const greens = ['#4e7c42', '#5f8f4c', '#3f6a38'];
  for (let i = 0; i < 9; i += 1) {
    const a = (i / 9) * Math.PI * 2 + palm.phase * 0.2;
    const droop = Math.cos(a) * 0.5;
    const len = (16 + (i % 3) * 5) * s;
    ctx.fillStyle = greens[i % 3];
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    const mx = cx + Math.cos(a) * len * 0.7;
    const my = cy + Math.sin(a) * len * 0.45 - 4 * s;
    const ex = cx + Math.cos(a) * len;
    const ey = cy + Math.sin(a) * len * 0.45 + 9 * s * droop + 6 * s;
    ctx.quadraticCurveTo(mx, my, ex, ey);
    ctx.quadraticCurveTo(mx + 2 * s, my + 5 * s, cx, cy + 1);
    ctx.fill();
  }
  ctx.fillStyle = '#3c6134';
  ctx.beginPath();
  ctx.arc(cx, cy, 3.4 * s, 0, Math.PI * 2);
  ctx.fill();
  // Coconuts.
  ctx.fillStyle = '#6d5130';
  ctx.beginPath();
  ctx.arc(cx - 3 * s, cy + 3 * s, 2 * s, 0, Math.PI * 2);
  ctx.arc(cx + 2.6 * s, cy + 4 * s, 2 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawParkProps(ctx, world, view, t) {
  // Nothing extra yet: parks are drawn with the ground pass and their pavilions with buildings.
  void world;
  void view;
  void t;
}

function drawGroundDecals(ctx, world, view) {
  const marks = world.decals;
  for (const d of marks) {
    if (d.x < view.x0 || d.x > view.x1 || d.y < view.y0 || d.y > view.y1) continue;
    ctx.globalAlpha = clamp(d.life / d.max, 0, 1) * 0.6;
    ctx.fillStyle = d.color ?? '#8f2b26';
    ctx.beginPath();
    ctx.ellipse(d.x, d.y, d.rx, d.ry, d.rot ?? 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------- pickups

function drawPickups(ctx, world, view, t) {
  for (const p of world.pickups) {
    if (p.x < view.x0 || p.x > view.x1 || p.y < view.y0 || p.y > view.y1) continue;
    const bob = Math.sin(t * 3 + p.bob) * 3;
    ctx.save();
    ctx.translate(p.x, p.y + bob);
    // Glow.
    const g = ctx.createRadialGradient(0, 0, 1, 0, 0, 22);
    g.addColorStop(0, alpha(p.color, 0.4));
    g.addColorStop(1, alpha(p.color, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, 22, 0, Math.PI * 2);
    ctx.fill();
    // A small diamond crate.
    ctx.fillStyle = 'rgba(20,24,28,0.25)';
    ctx.beginPath();
    ctx.ellipse(2, 8, 8, 4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(8, 0);
    ctx.lineTo(0, 9);
    ctx.lineTo(-8, 0);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(8, 0);
    ctx.lineTo(0, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

// ---------------------------------------------------------------- people

function drawPeds(ctx, world, view, t) {
  for (const ped of world.peds) {
    if (ped.x < view.x0 - 30 || ped.x > view.x1 + 30 || ped.y < view.y0 - 40 || ped.y > view.y1 + 30) continue;
    if (ped.dead) {
      drawBodyDown(ctx, ped);
      continue;
    }
    if (ped.state === 'down') {
      drawBodyDown(ctx, ped);
      continue;
    }
    drawPerson(ctx, ped, t);
    // The hit contract's mark.
    if (ped.mark === 'hit') {
      const bob = Math.sin(t * 4) * 2;
      ctx.fillStyle = '#e4544a';
      ctx.beginPath();
      ctx.moveTo(ped.x, ped.y - 40 + bob);
      ctx.lineTo(ped.x + 6, ped.y - 50 + bob);
      ctx.lineTo(ped.x - 6, ped.y - 50 + bob);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(228,84,74,0.6)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(ped.x, ped.y, 16 + Math.sin(t * 3) * 2, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

/** A person seen from above at an angle: shadow, torso, head, swinging arms and legs. */
function drawPerson(ctx, ped, t) {
  const bob = Math.sin(ped.walkPhase * 2) * 1.2 * (ped.speedNow > 10 ? 1 : 0.2);
  const moving = ped.speedNow > 8;
  ctx.save();
  ctx.translate(ped.x, ped.y);
  // Shadow.
  ctx.fillStyle = 'rgba(22,26,34,0.28)';
  ctx.beginPath();
  ctx.ellipse(4, 4, 8, 4, 0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.rotate(ped.angle + Math.PI / 2);
  // Legs.
  const swing = moving ? Math.sin(ped.walkPhase * 2) * 4 : 0;
  ctx.fillStyle = shade(ped.pants, -0.18);
  ctx.fillRect(-5.2, -2 + swing * 0.4, 3.6, 8);
  ctx.fillRect(1.6, -2 - swing * 0.4, 3.6, 8);
  // Torso.
  ctx.fillStyle = ped.shirt;
  ctx.beginPath();
  ctx.ellipse(0, -2, 6.2, 7.4 + bob * 0.3, 0, 0, Math.PI * 2);
  ctx.fill();
  // Shoulders and arms.
  ctx.fillStyle = shade(ped.shirt, -0.12);
  ctx.fillRect(-7.4, -3, 2.6, 7 + swing * 0.3);
  ctx.fillRect(4.8, -3, 2.6, 7 - swing * 0.3);
  if (ped.cop) {
    // The vest's reflective band.
    ctx.fillStyle = 'rgba(240,238,226,0.75)';
    ctx.fillRect(-5, -4, 10, 1.6);
    ctx.fillStyle = '#1b2436';
    ctx.fillRect(-5.6, -7, 11.2, 3);
  }
  // Head.
  ctx.fillStyle = ped.skin;
  ctx.beginPath();
  ctx.arc(0, -6.6, 4.4, 0, Math.PI * 2);
  ctx.fill();
  // Hair.
  ctx.fillStyle = ped.hair;
  ctx.beginPath();
  ctx.arc(0, -7.6, 4.2, Math.PI * 0.95, Math.PI * 2.05);
  ctx.fill();
  if (ped.hat === 'cap') {
    ctx.fillStyle = '#1b2436';
    ctx.beginPath();
    ctx.arc(0, -7, 4.6, Math.PI, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(-4.6, -7.4, 9.2, 2);
  } else if (ped.hat === 'brim') {
    ctx.fillStyle = '#e7d6ad';
    ctx.beginPath();
    ctx.ellipse(0, -7, 6.5, 5, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // A bag on the shoulder.
  if (ped.bag) {
    ctx.fillStyle = '#7a5a3c';
    ctx.fillRect(4.4, -1, 3.6, 4.6);
  }
  // Gun, when a cop or a thug has drawn it.
  if ((ped.cop || ped.hostile) && ped.alert > 0) {
    ctx.fillStyle = '#26262c';
    ctx.fillRect(-1.4, -13, 2.6, 5);
  }
  ctx.restore();
}

function drawBodyDown(ctx, ped) {
  ctx.save();
  ctx.translate(ped.x, ped.y);
  ctx.fillStyle = 'rgba(24,20,18,0.3)';
  ctx.beginPath();
  ctx.ellipse(3, 3, 12, 6, 0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.rotate(ped.angle);
  ctx.fillStyle = shade(ped.shirt, -0.05);
  ctx.beginPath();
  ctx.ellipse(0, 0, 11, 5.4, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = shade(ped.pants, -0.2);
  ctx.fillRect(-14, -2.6, 6, 5.2);
  ctx.fillStyle = ped.skin;
  ctx.beginPath();
  ctx.arc(10, 0, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// ---------------------------------------------------------------- vehicles

function drawCars(ctx, world, view, t) {
  // Sorted by y so cars lower on screen overlap those behind them.
  const list = world.cars.filter((c) => c.x > view.x0 - 80 && c.x < view.x1 + 80 && c.y > view.y0 - 80 && c.y < view.y1 + 80);
  list.sort((a, b) => a.y - b.y);
  for (const car of list) drawCar(ctx, car, t);
}

function drawCar(ctx, car, t) {
  const L = CAR.length * (car.model.len ?? 1);
  const W = CAR.width * (car.model.wid ?? 1);
  ctx.save();
  ctx.translate(car.x, car.y);
  // Long shadow away from the sun.
  ctx.save();
  ctx.translate(SHADOW.x * 12, SHADOW.y * 9);
  ctx.rotate(car.angle);
  ctx.fillStyle = 'rgba(20,24,32,0.32)';
  fillRoundRect(ctx, -L / 2 + 1, -W / 2 + 2, L, W, 6, 'rgba(20,24,32,0.32)');
  ctx.restore();
  ctx.rotate(car.angle);

  const body = car.wrecked ? '#3a3632' : car.color;
  // Tyres.
  ctx.fillStyle = '#1c1c20';
  for (const [sx, sy] of [[-L * 0.3, -W * 0.5], [L * 0.3, -W * 0.5], [-L * 0.3, W * 0.5 - 4], [L * 0.3, W * 0.5 - 4]]) {
    fillRoundRect(ctx, sx - 5, sy, 10, 4.6, 1.6, '#1c1c20');
  }
  // Body: a rounded box with a slightly narrower nose.
  const g = ctx.createLinearGradient(0, -W / 2, 0, W / 2);
  g.addColorStop(0, shade(body, 0.22));
  g.addColorStop(0.45, body);
  g.addColorStop(1, shade(body, -0.22));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(-L / 2 + 4, -W / 2 + 3);
  ctx.lineTo(L / 2 - 6, -W / 2 + 4);
  ctx.quadraticCurveTo(L / 2 + 1, -W / 2 + 5, L / 2 + 1, 0);
  ctx.quadraticCurveTo(L / 2 + 1, W / 2 - 5, L / 2 - 6, W / 2 - 4);
  ctx.lineTo(-L / 2 + 4, W / 2 - 3);
  ctx.quadraticCurveTo(-L / 2 - 1, W / 2 - 4, -L / 2 - 1, 0);
  ctx.quadraticCurveTo(-L / 2 - 1, -W / 2 + 4, -L / 2 + 4, -W / 2 + 3);
  ctx.closePath();
  ctx.fill();
  // A highlight along the sunward side.
  ctx.strokeStyle = 'rgba(255,246,224,0.35)';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(-L / 2 + 6, -W / 2 + 4.4);
  ctx.lineTo(L / 2 - 8, -W / 2 + 5.4);
  ctx.stroke();

  // Cabin: windscreen, roof, rear glass.
  const cab = car.model.kind === 'truck' ? { x: -L * 0.1, w: L * 0.34 } : car.model.kind === 'van' ? { x: L * 0.06, w: L * 0.5 } : { x: 0, w: L * 0.44 };
  const glass = car.kind === 'police' ? '#3a4a5c' : '#3f5a66';
  ctx.fillStyle = glass;
  fillRoundRect(ctx, cab.x - cab.w / 2, -W / 2 + 4, cab.w, W - 8, 3.2, glass);
  ctx.fillStyle = 'rgba(150,200,214,0.55)';
  fillRoundRect(ctx, cab.x - cab.w / 2 + 1.6, -W / 2 + 5.4, cab.w - 3.2, (W - 10) * 0.42, 2, 'rgba(150,200,214,0.5)');
  ctx.fillStyle = car.wrecked ? '#2a2a2a' : car.model.roof;
  fillRoundRect(ctx, cab.x - cab.w * 0.34, -W / 2 + 6.6, cab.w * 0.68, W - 13.2, 2.6, car.wrecked ? '#2a2a2a' : car.model.roof);
  // Bonnet crease and boot line.
  ctx.strokeStyle = 'rgba(0,0,0,0.16)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(L / 2 - 6, -W / 2 + 4);
  ctx.lineTo(L / 2 - 6, W / 2 - 4);
  ctx.moveTo(-L / 2 + 5, -W / 2 + 3);
  ctx.lineTo(-L / 2 + 5, W / 2 - 3);
  ctx.stroke();

  // Lights.
  const headOn = true;
  ctx.fillStyle = car.wrecked ? '#4a4438' : headOn ? '#fff2c4' : '#e8dfc4';
  ctx.fillRect(L / 2 - 2.6, -W / 2 + 5, 2.6, 4.4);
  ctx.fillRect(L / 2 - 2.6, W / 2 - 9.4, 2.6, 4.4);
  ctx.fillStyle = car.brakeLight ? '#ff5a44' : '#c0453a';
  ctx.fillRect(-L / 2 - 0.6, -W / 2 + 5, 2.4, 4.2);
  ctx.fillRect(-L / 2 - 0.6, W / 2 - 9.2, 2.4, 4.2);

  // Police livery.
  if (car.kind === 'police' || car.police) {
    ctx.fillStyle = '#26355f';
    ctx.fillRect(-L * 0.34, -W / 2 + 3, L * 0.68, 3.2);
    ctx.fillRect(-L * 0.34, W / 2 - 6.2, L * 0.68, 3.2);
    ctx.fillStyle = '#c8342e';
    ctx.fillRect(-L * 0.16, -W / 2 + 3, 4, 3.2);
    ctx.fillRect(-L * 0.16, W / 2 - 6.2, 4, 3.2);
    // The light bar, flashing.
    const phase = (car.lightPhase ?? t) % 0.9;
    const red = phase < 0.45;
    ctx.fillStyle = red ? '#ff4a3a' : '#5a1a16';
    fillRoundRect(ctx, cab.x - 8, -W / 2 + 6.4, 7, 4, 1.6, red ? '#ff4a3a' : '#5a1a16');
    ctx.fillStyle = !red ? '#4a8aff' : '#16275a';
    fillRoundRect(ctx, cab.x + 1, -W / 2 + 6.4, 7, 4, 1.6, !red ? '#4a8aff' : '#16275a');
    if (!car.wrecked) {
      const glow = ctx.createRadialGradient(cab.x, -W / 2 + 8, 2, cab.x, -W / 2 + 8, 34);
      glow.addColorStop(0, red ? 'rgba(255,80,60,0.45)' : 'rgba(90,140,255,0.45)');
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(cab.x, -W / 2 + 8, 34, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // The delivery van's parcel livery.
  if (car.kind === 'van') {
    ctx.fillStyle = '#c9a33a';
    ctx.fillRect(-L * 0.36, -W / 2 + 3, L * 0.22, W - 6);
    ctx.fillStyle = '#3a4650';
    ctx.fillRect(-L * 0.3, -2, 9, 4);
  }
  // A driver silhouette.
  if (car.driver && !car.parked) {
    ctx.fillStyle = 'rgba(30,28,30,0.75)';
    ctx.beginPath();
    ctx.arc(cab.x - 2, -W * 0.16, 3.2, 0, Math.PI * 2);
    ctx.fill();
  }
  // Damage: soot and dents as the health falls.
  const hurt = 1 - car.health / car.maxHealth;
  if (hurt > 0.35) {
    ctx.fillStyle = `rgba(28,24,22,${(hurt - 0.35) * 0.9})`;
    ctx.beginPath();
    ctx.ellipse(-L * 0.2, W * 0.1, L * 0.3, W * 0.3, 0.3, 0, Math.PI * 2);
    ctx.fill();
  }
  // Fire on a burning wreck.
  if (car.wrecked && car.burning > 0) {
    for (let i = 0; i < 3; i += 1) {
      const fx = Math.sin(t * 9 + i * 2) * 5 + (i - 1) * 7;
      const fh = 10 + Math.abs(Math.sin(t * 11 + i)) * 12;
      ctx.fillStyle = i === 1 ? 'rgba(255,196,80,0.9)' : 'rgba(255,120,50,0.75)';
      ctx.beginPath();
      ctx.moveTo(fx - 4, 2);
      ctx.quadraticCurveTo(fx - 1, -fh * 0.6, fx, -fh);
      ctx.quadraticCurveTo(fx + 2, -fh * 0.5, fx + 4, 2);
      ctx.fill();
    }
  }
  // Indicators, for a turning car.
  if (car.indicator > 0) {
    const on = Math.sin(t * 16) > 0;
    if (on) {
      ctx.fillStyle = '#ffb347';
      ctx.beginPath();
      ctx.arc(L / 2 - 2, -W / 2 + 6, 2.4, 0, Math.PI * 2);
      ctx.arc(L / 2 - 2, W / 2 - 6, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

// ---------------------------------------------------------------- the player

function drawPlayer(ctx, world, view, t) {
  const p = world.player;
  if (p.inCar) return;
  if (p.x < view.x0 || p.x > view.x1 || p.y < view.y0 || p.y > view.y1) return;
  if (p.dead) {
    // A body on the ground.
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.fillStyle = 'rgba(24,20,18,0.4)';
    ctx.beginPath();
    ctx.ellipse(3, 3, 14, 7, 0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.rotate(p.angle);
    ctx.fillStyle = '#2f4a63';
    ctx.beginPath();
    ctx.ellipse(0, 0, 12, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#d9a97f';
    ctx.beginPath();
    ctx.arc(11, 0, 4.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }
  // The invulnerability flicker: the body blinks, its ground cue does not.
  const blink = p.invuln > 0 && Math.sin(p.invuln * 60) > 0.2;
  ctx.save();
  ctx.translate(p.x, p.y);
  // The ground cue is laid down first and outside the blink, so the player can always be found in
  // a crowd — including in the half-second after a respawn. A soft warm glow under a crisp ring:
  // the glow catches the eye at a glance, the ring pins the exact spot.
  const cuePulse = 1 + Math.sin(t * 3.4) * 0.06;
  const cueGlow = ctx.createRadialGradient(0, 2, 4, 0, 2, 22 * cuePulse);
  cueGlow.addColorStop(0, 'rgba(255,194,74,0.30)');
  cueGlow.addColorStop(0.55, 'rgba(255,194,74,0.14)');
  cueGlow.addColorStop(1, 'rgba(255,194,74,0)');
  ctx.fillStyle = cueGlow;
  ctx.beginPath();
  ctx.ellipse(0, 2, 22 * cuePulse, 14 * cuePulse, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#FFC24A';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.ellipse(0, 2, 15, 8.5, 0, 0, Math.PI * 2);
  ctx.stroke();
  if (blink) ctx.globalAlpha = 0.55;
  // Shadow.
  ctx.fillStyle = 'rgba(18,22,30,0.34)';
  ctx.beginPath();
  ctx.ellipse(5, 5, 11, 5.4, 0.4, 0, Math.PI * 2);
  ctx.fill();
  const ang = p.aiming ? p.aimAngle : p.angle;
  ctx.rotate(ang + Math.PI / 2);
  const stride = p.moving ? Math.sin(p.footstep * Math.PI * 2) * 5 : 0;
  // Legs: jeans and boots.
  ctx.fillStyle = '#2c3a4c';
  ctx.fillRect(-6, -2 + stride * 0.5, 4.6, 10);
  ctx.fillRect(1.4, -2 - stride * 0.5, 4.6, 10);
  ctx.fillStyle = '#20232a';
  ctx.fillRect(-6, 6 + stride * 0.5, 4.6, 3);
  ctx.fillRect(1.4, 6 - stride * 0.5, 4.6, 3);
  // The jacket: a warm cream with a dark collar.
  const g = ctx.createLinearGradient(-7, 0, 7, 0);
  g.addColorStop(0, '#e8ddc4');
  g.addColorStop(1, '#c9b795');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(0, -3, 7, 8.6, 0, 0, Math.PI * 2);
  ctx.fill();
  // A near-white rim on the jacket so the silhouette separates from the crowd at small size.
  ctx.strokeStyle = '#FFF6E2';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = '#8d4a3a';
  ctx.beginPath();
  ctx.moveTo(-5, -8);
  ctx.lineTo(0, -4);
  ctx.lineTo(5, -8);
  ctx.lineTo(0, -10.5);
  ctx.closePath();
  ctx.fill();
  // Arms, out front when shooting.
  if (p.aiming || p.meleeTimer > 0) {
    ctx.fillStyle = '#d9a97f';
    ctx.fillRect(-3.4, -16, 2.8, 9);
    ctx.fillRect(0.8, -16, 2.8, 9);
  } else {
    ctx.fillStyle = '#c9b795';
    ctx.fillRect(-8.6, -4 + stride * 0.4, 2.8, 8);
    ctx.fillRect(5.8, -4 - stride * 0.4, 2.8, 8);
  }
  // Head and hair.
  ctx.fillStyle = '#d9a97f';
  ctx.beginPath();
  ctx.arc(0, -8.4, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#2a1d14';
  ctx.beginPath();
  ctx.arc(0, -9.6, 4.8, Math.PI * 0.9, Math.PI * 2.1);
  ctx.fill();
  // The pistol, drawn only when it is out.
  if (p.weapon !== 'fists' && (p.aiming || p.fireCooldown > 0)) {
    ctx.fillStyle = '#22242a';
    ctx.fillRect(-1.6, -23, 3.2, 8);
    ctx.fillStyle = '#3a3d44';
    ctx.fillRect(-1.6, -23, 3.2, 2.4);
    if (p.recoil > 0.4) {
      ctx.fillStyle = `rgba(255,225,150,${p.recoil})`;
      ctx.beginPath();
      ctx.arc(0, -25, 5 + p.recoil * 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // The melee arc.
  if (p.meleeTimer > 0) {
    ctx.strokeStyle = `rgba(255,246,214,${p.meleeTimer * 3})`;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.arc(0, -14, 14, Math.PI * 1.15, Math.PI * 1.85);
    ctx.stroke();
  }
  ctx.restore();

  // Health ring under a hurt player.
  if (p.health < 40) {
    ctx.strokeStyle = `rgba(228,84,74,${0.3 + Math.sin(t * 6) * 0.15})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y + 2, 18, 0, Math.PI * 2);
    ctx.stroke();
  }
}

// ---------------------------------------------------------------- bullets and particles

// ---------------------------------------------------------------- objective marker

/**
 * The active mission's objective, painted in the world. A gold diamond with a soft halo and a slow
 * shaft of light when the target is in frame; a gold arrow pinned to the edge of the view, aimed at
 * it, when it is not. Sizes are divided by the camera zoom so the marker keeps the same apparent
 * size however far the view has pulled back.
 *
 * Every access is defensive: no mission, no marker, or a malformed marker simply draws nothing.
 */
function drawObjectiveMarker(ctx, world, view, t) {
  const target = safeObjective(world);
  if (!target) return;
  const zoom = Number.isFinite(world?.camera?.zoom) && world.camera.zoom > 0 ? world.camera.zoom : 1;
  const px = 1 / zoom; // one screen pixel, in world units
  const cx = Number.isFinite(view?.ox) ? view.ox : world?.camera?.x ?? target.x;
  const cy = Number.isFinite(view?.oy) ? view.oy : world?.camera?.y ?? target.y;
  const halfW = VIEW.w / (2 * zoom);
  const halfH = VIEW.h / (2 * zoom);
  const dx = target.x - cx;
  const dy = target.y - cy;
  const gold = PALETTE.gold ?? '#f0b73f';

  // Just inside the letterbox, so an edge arrow never gets clipped.
  const padX = Math.max(0, halfW - 42 * px);
  const padY = Math.max(0, halfH - 42 * px);
  const onScreen = Math.abs(dx) <= padX && Math.abs(dy) <= padY;

  ctx.save();
  if (onScreen) {
    drawMarkerBeacon(ctx, target.x, target.y, t, px, gold);
  } else {
    drawEdgeArrow(ctx, cx, cy, dx, dy, padX, padY, t, px, gold);
  }
  ctx.restore();
}

/** The current objective position, or null when there is nothing sane to point at. */
function safeObjective(world) {
  if (!world) return null;
  let marker = null;
  try {
    marker = missionMarker(world);
  } catch {
    return null;
  }
  if (!marker || typeof marker !== 'object') return null;
  const x = Number(marker.x);
  const y = Number(marker.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

/** The in-frame beacon: halo, pulsing diamond, and a shaft that stretches with `t`. */
function drawMarkerBeacon(ctx, x, y, t, px, gold) {
  const pulse = 1 + Math.sin(t * 3.1) * 0.14;
  const half = 13 * px * pulse;

  // The shaft first, so the diamond sits on top of it.
  const shaft = (30 + Math.sin(t * 2.4) * 11) * px;
  if (shaft > 2) {
    const beam = ctx.createLinearGradient(x, y - shaft, x, y);
    beam.addColorStop(0, 'rgba(255,226,150,0)');
    beam.addColorStop(0.65, 'rgba(240,183,63,0.42)');
    beam.addColorStop(1, 'rgba(255,240,196,0.92)');
    ctx.strokeStyle = beam;
    ctx.lineWidth = Math.max(1.6, 2.6 * px);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x, y - shaft);
    ctx.lineTo(x, y - 3 * px);
    ctx.stroke();
    // A bright spark riding the top of the shaft.
    ctx.fillStyle = 'rgba(255,244,208,0.9)';
    ctx.beginPath();
    ctx.arc(x, y - shaft, Math.max(1.4, 2.4 * px), 0, Math.PI * 2);
    ctx.fill();
  }

  // The halo: a wide, soft pool of warm light.
  const halo = ctx.createRadialGradient(x, y, 1, x, y, half * 3.4);
  halo.addColorStop(0, 'rgba(255,214,120,0.5)');
  halo.addColorStop(0.45, 'rgba(240,183,63,0.24)');
  halo.addColorStop(1, 'rgba(240,183,63,0)');
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(x, y, half * 3.4, 0, Math.PI * 2);
  ctx.fill();

  // The diamond: a square turned 45 degrees, dark-edged so it reads against pavement.
  ctx.beginPath();
  ctx.moveTo(x, y - half);
  ctx.lineTo(x + half, y);
  ctx.lineTo(x, y + half);
  ctx.lineTo(x - half, y);
  ctx.closePath();
  ctx.fillStyle = gold;
  ctx.fill();
  ctx.strokeStyle = 'rgba(46,32,10,0.65)';
  ctx.lineWidth = Math.max(1, 1.6 * px);
  ctx.stroke();

  // A highlight facet on the upper half, so the shape reads at small size.
  ctx.beginPath();
  ctx.moveTo(x, y - half);
  ctx.lineTo(x + half, y);
  ctx.lineTo(x, y);
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,246,214,0.6)';
  ctx.fill();
}

/** The out-of-frame cue: a gold arrow on the view's edge, aimed at the target. */
function drawEdgeArrow(ctx, cx, cy, dx, dy, padX, padY, t, px, gold) {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < 1e-6 && ay < 1e-6) return;
  // Slide along the line to the target until it meets the edge of the inset view rect.
  const kx = ax > 1e-6 ? padX / ax : Infinity;
  const ky = ay > 1e-6 ? padY / ay : Infinity;
  const k = Math.min(1, kx, ky);
  const ex = cx + dx * k;
  const ey = cy + dy * k;
  const angle = Math.atan2(dy, dx);
  const size = 15 * px * (1 + Math.sin(t * 4.2) * 0.07);

  ctx.save();
  ctx.translate(ex, ey);
  ctx.rotate(angle);

  // A soft glow behind the head keeps it visible over bright pavement and dark water alike.
  const glow = ctx.createRadialGradient(0, 0, 1, 0, 0, size * 2.2);
  glow.addColorStop(0, 'rgba(255,214,120,0.5)');
  glow.addColorStop(1, 'rgba(240,183,63,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(0, 0, size * 2.2, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(size, 0);
  ctx.lineTo(-size * 0.7, size * 0.85);
  ctx.lineTo(-size * 0.25, 0);
  ctx.lineTo(-size * 0.7, -size * 0.85);
  ctx.closePath();
  ctx.fillStyle = gold;
  ctx.fill();
  ctx.strokeStyle = 'rgba(46,32,10,0.7)';
  ctx.lineWidth = Math.max(1, 1.5 * px);
  ctx.stroke();
  ctx.restore();
}

function drawBullets(ctx, world, view) {
  for (const b of world.bullets) {
    if (b.x < view.x0 || b.x > view.x1 || b.y < view.y0 || b.y > view.y1) continue;
    const len = 18;
    const tx = b.x - Math.cos(b.angle) * len;
    const ty = b.y - Math.sin(b.angle) * len;
    const g = ctx.createLinearGradient(tx, ty, b.x, b.y);
    g.addColorStop(0, 'rgba(255,230,160,0)');
    g.addColorStop(1, 'rgba(255,240,200,0.9)');
    ctx.strokeStyle = g;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
}

function drawParticles(ctx, world, view) {
  const items = world.particles.items;
  for (const p of items) {
    if (p.life <= 0) continue;
    if (p.x < view.x0 - 40 || p.x > view.x1 + 40 || p.y < view.y0 - 40 || p.y > view.y1 + 40) continue;
    const k = p.life / p.max;
    switch (p.kind) {
      case 'spark': {
        ctx.globalAlpha = k;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'blood': {
        ctx.globalAlpha = k * 0.9;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, p.size, p.size * 0.7, p.rot, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'smoke':
      case 'dust': {
        ctx.globalAlpha = k * (p.alpha ?? 0.3);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'flash': {
        ctx.globalAlpha = k;
        const g = ctx.createRadialGradient(p.x, p.y, 1, p.x, p.y, p.size);
        g.addColorStop(0, 'rgba(255,255,235,0.95)');
        g.addColorStop(0.4, p.color);
        g.addColorStop(1, 'rgba(255,200,90,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'debris': {
        ctx.globalAlpha = k;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.7);
        ctx.restore();
        break;
      }
      case 'ring': {
        ctx.globalAlpha = k * 0.7;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 3 * k + 0.6;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      case 'splash': {
        ctx.globalAlpha = k;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      default: {
        ctx.globalAlpha = k;
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x, p.y, p.size, p.size);
        break;
      }
    }
  }
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------- buildings

/**
 * Buildings are drawn last, from their bases up, so a tower's roof plate can overlap the street
 * behind it. Ordering by the base's y keeps nearer blocks in front.
 */
function drawBuildingTops(ctx, world, view) {
  const list = world.city.buildings.filter((b) => b.x < view.x1 + 200 && b.x + b.w > view.x0 - 200 && b.y < view.y1 + 200 && b.y + b.h > view.y0 - 200);
  list.sort((a, b) => a.y + a.h - (b.y + b.h));
  for (const b of list) drawBuilding(ctx, b, world, view);
}

function drawBuilding(ctx, b, world, view) {
  // The extruded height on screen: a perspective-ish lift toward the upper left.
  const lift = Math.min(b.height, 220) * 0.46;
  const lean = lift * 0.16;
  const x = b.x;
  const y = b.y;
  const w = b.w;
  const h = b.h;

  // Side walls: the north face (sunlit) and the west face (shade).
  const faceTop = y - lift;
  ctx.fillStyle = shade(b.facade, 0.12);
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, faceTop);
  ctx.lineTo(x, faceTop);
  ctx.closePath();
  ctx.fill();
  // A vertical gradient so the base sits in the street's shadow.
  const wallG = ctx.createLinearGradient(0, faceTop, 0, y);
  wallG.addColorStop(0, 'rgba(255,240,210,0.12)');
  wallG.addColorStop(0.55, 'rgba(255,240,210,0)');
  wallG.addColorStop(1, 'rgba(30,26,24,0.28)');
  ctx.fillStyle = wallG;
  ctx.fillRect(x, faceTop, w, lift);
  // The west face, a darker sliver when seen from the side.
  ctx.fillStyle = shade(b.facade, -0.26);
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x, faceTop);
  ctx.lineTo(x + lean, faceTop - lean * 0.4);
  ctx.lineTo(x + lean, y - lift * 0.2);
  ctx.closePath();
  ctx.fill();

  // Windows on the north face.
  if (lift > 14) {
    const cols = Math.max(1, Math.floor(w / 15));
    const rows = Math.max(1, Math.floor(lift / 13));
    const lit = world.time > 18 * 3600 || world.time < 6 * 3600;
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const wx = x + 5 + c * (w - 10) / cols;
        const wy = faceTop + 6 + r * (lift - 8) / rows;
        const ww = Math.min(6, (w - 10) / cols - 3);
        const hh = Math.min(5, (lift - 8) / rows - 3);
        if (ww < 1.4 || hh < 1.2) continue;
        const seed = hash01(Math.round(wx), Math.round(wy), b.index);
        if (lit) {
          ctx.fillStyle = seed > 0.55 ? 'rgba(255,214,140,0.85)' : 'rgba(60,70,84,0.8)';
        } else {
          ctx.fillStyle = seed > 0.86 ? 'rgba(255,228,170,0.6)' : seed > 0.4 ? 'rgba(58,80,94,0.75)' : 'rgba(44,62,74,0.8)';
        }
        ctx.fillRect(wx, wy, ww, hh);
        if (seed > 0.7) {
          ctx.fillStyle = 'rgba(255,255,255,0.18)';
          ctx.fillRect(wx, wy, ww, 1);
        }
      }
    }
  }

  // The roof plate: a lit top face, with a parapet and clutter.
  const roofCol = b.roof === 'tile' ? shade('#b2603f', 0.12) : b.roof === 'warehouse' ? '#8f9a90' : shade(b.facade, 0.3);
  ctx.fillStyle = roofCol;
  ctx.beginPath();
  ctx.moveTo(x + lean, faceTop - lean * 0.4);
  ctx.lineTo(x + w + lean, faceTop - lean * 0.4);
  ctx.lineTo(x + w, faceTop);
  ctx.lineTo(x, faceTop);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(40,34,28,0.28)';
  ctx.lineWidth = 1.2;
  ctx.stroke();

  if (b.setback) {
    // A stepped crown: the tower's upper floor is inset.
    const s = b.setback;
    const sub = Math.min(b.height * 0.3, 60);
    const sx = b.x + (b.w - s.w) / 2;
    const sy = b.y + (b.h - s.h) / 2;
    ctx.fillStyle = shade(b.facade, 0.05);
    ctx.fillRect(sx, sy - sub - lift * 0.3, s.w, s.h + sub);
    ctx.fillStyle = shade(b.facade, 0.22);
    ctx.beginPath();
    ctx.moveTo(sx + lean * 0.6, sy - sub - lift * 0.3);
    ctx.lineTo(sx + s.w + lean * 0.6, sy - sub - lift * 0.3);
    ctx.lineTo(sx + s.w, sy - sub - lift * 0.3 + 6);
    ctx.lineTo(sx, sy - sub - lift * 0.3 + 6);
    ctx.closePath();
    ctx.fill();
  }
  // Parapet.
  ctx.strokeStyle = shade(roofCol, -0.22);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x + lean, faceTop - lean * 0.4);
  ctx.lineTo(x + w + lean, faceTop - lean * 0.4);
  ctx.stroke();
  // Roof clutter: water tanks and AC units, drawn on the roof plate.
  for (const bit of b.roofBits) {
    ctx.fillStyle = bit.kind === 'tank' ? '#8d6a4a' : '#8f979c';
    const bx = bit.x + lean * 0.4;
    const by = faceTop - lean * 0.4 + (bit.y - b.y) * 0.36;
    ctx.fillRect(bx, by - bit.h * 0.5, bit.w * 0.7, bit.h * 0.5);
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.fillRect(bx, by - bit.h * 0.5, bit.w * 0.7, 1.6);
  }
  // The crown's beacon at dusk.
  if (b.crown) {
    ctx.fillStyle = 'rgba(255,90,70,0.85)';
    ctx.beginPath();
    ctx.arc(x + w / 2 + lean, faceTop - lean * 0.4 - 3, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }
  // A painted shop sign on the street face.
  if (b.sign && lift > 20) {
    ctx.fillStyle = alpha(b.sign.color, 0.9);
    const sx = b.sign.side === 's' ? x + 8 : x + 3;
    ctx.fillRect(sx, faceTop + lift * 0.34, b.sign.side === 's' ? Math.min(w - 16, 58) : 7, 12);
    ctx.fillStyle = 'rgba(255,248,230,0.92)';
    ctx.font = '700 7px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    if (b.sign.side === 's') ctx.fillText(b.sign.text, sx + 4, faceTop + lift * 0.34 + 6.4);
    ctx.textBaseline = 'alphabetic';
  }
}

// ---------------------------------------------------------------- light and screen

/** A warm colour grade and a vignette over the finished frame. */
function drawLighting(ctx, world) {
  ctx.save();
  // Sun glow from the upper right.
  const g = ctx.createRadialGradient(VIEW.w * 0.86, VIEW.h * 0.1, 40, VIEW.w * 0.86, VIEW.h * 0.1, VIEW.w * 0.85);
  g.addColorStop(0, 'rgba(255,214,150,0.20)');
  g.addColorStop(0.45, 'rgba(255,190,130,0.07)');
  g.addColorStop(1, 'rgba(255,170,110,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VIEW.w, VIEW.h);
  // A soft warm wash.
  ctx.fillStyle = 'rgba(255,176,96,0.05)';
  ctx.fillRect(0, 0, VIEW.w, VIEW.h);
  // Vignette.
  const v = ctx.createRadialGradient(VIEW.w / 2, VIEW.h / 2, VIEW.h * 0.36, VIEW.w / 2, VIEW.h / 2, VIEW.h * 0.92);
  v.addColorStop(0, 'rgba(16,12,10,0)');
  v.addColorStop(0.7, 'rgba(16,12,10,0.16)');
  v.addColorStop(1, 'rgba(12,9,8,0.46)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, VIEW.w, VIEW.h);
  ctx.restore();
  void world;
}

/** Damage flash, death fade, mission tint: everything that sits on the lens. */
function drawScreenEffects(ctx, world, fx) {
  const p = world.player;
  // Blood at the screen's edge when hurt.
  if (p.hitFlash > 0.02) {
    const g = ctx.createRadialGradient(VIEW.w / 2, VIEW.h / 2, VIEW.h * 0.25, VIEW.w / 2, VIEW.h / 2, VIEW.h * 0.85);
    g.addColorStop(0, 'rgba(160,24,20,0)');
    g.addColorStop(1, `rgba(168,26,22,${0.62 * p.hitFlash})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VIEW.w, VIEW.h);
  }
  // Low health: a pulsing red edge.
  if (p.health < 32 && !p.dead) {
    const pulse = 0.16 + Math.sin(world.clock * 5) * 0.07;
    const g = ctx.createRadialGradient(VIEW.w / 2, VIEW.h / 2, VIEW.h * 0.3, VIEW.w / 2, VIEW.h / 2, VIEW.h * 0.9);
    g.addColorStop(0, 'rgba(150,20,18,0)');
    g.addColorStop(1, `rgba(150,20,18,${pulse})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VIEW.w, VIEW.h);
  }
  // Death: the world drains to a warm grey.
  if (p.dead || (fx.fade ?? 0) > 0) {
    const amt = Math.max(p.dead ? 1 - Math.max(0, p.deathTimer - 1.6) / 1.2 : 0, fx.fade ?? 0);
    ctx.fillStyle = `rgba(30,18,14,${clamp(amt, 0, 1) * 0.78})`;
    ctx.fillRect(0, 0, VIEW.w, VIEW.h);
  }
  // Speed streaks at the top speed of a car.
  if (p.inCar && p.inCar.speed > 340) {
    const k = clamp((p.inCar.speed - 340) / 110, 0, 1);
    ctx.strokeStyle = `rgba(255,246,224,${k * 0.18})`;
    ctx.lineWidth = 1.6;
    for (let i = 0; i < 14; i += 1) {
      const y = (hash01(i, 3) * VIEW.h + world.clock * 200) % VIEW.h;
      const x = hash01(i, 7) * VIEW.w;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 40 + k * 60, y - 8);
      ctx.stroke();
    }
  }
}

export { WEAPONS, money, starPath, strokeRoundRect, dist };
