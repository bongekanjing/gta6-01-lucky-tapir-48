// The HUD: a rotating-free minimap in the corner (roads, water, markers and police), the bars and
// counters along the bottom, wanted stars top right, the objective and timer top left, and the
// toast card for job briefs. Everything is drawn in logical pixels over the world frame.
//
// The minimap is drawn from the city's own data on a small offscreen canvas once, then blitted with
// the markers on top each frame: cheap, crisp, and it matches the map the player is driving on.

import { PALETTE, VIEW, WANTED, WEAPONS } from './config.js';
import { alpha, clamp, fillRoundRect, money, roundRectPath, shade, starPath, strokeRoundRect } from './util.js';
import { missionObjective } from './missions.js';

const MINI = { x: 24, y: VIEW.h - 200, w: 186, h: 176 };
const BAR = { x: 228, y: VIEW.h - 96, w: 200, h: 12 };
// One map pixel per MAP_STEP world units. The baked map and the live blit both read these, so they
// live at module scope: drawMiniMap runs outside createHud and needs the same scale and plate.
const MAP_STEP = 4;
const MAP_PAD = 4;
let mapCanvas = null;
// The city's bounds start at a negative coordinate, so every map coordinate is shifted by this
// much before it is scaled: without it the western blocks and the sea fall off the plate.
let mapOX = 0;
let mapOY = 0;

/** World point to baked-map pixel. */
function mapPX(x) {
  return (x + mapOX) / MAP_STEP + MAP_PAD;
}
function mapPY(y) {
  return (y + mapOY) / MAP_STEP + MAP_PAD;
}

export function createHud(canvas, renderer) {

  /** Bake the whole city's map to an offscreen canvas at one pixel per `MAP_STEP` units. */
  function bakeMap(city) {
    mapOX = -Math.min(0, city.bounds.x0);
    mapOY = -Math.min(0, city.bounds.y0);
    const w = Math.ceil((city.bounds.x1 + mapOX) / MAP_STEP);
    const h = Math.ceil((city.bounds.y1 + mapOY) / MAP_STEP);
    const c = document.createElement('canvas');
    c.width = w + MAP_PAD * 2;
    c.height = h + MAP_PAD * 2;
    const g = c.getContext('2d');
    // Land first, then the sea to the west of the shore, then the beach strip between them.
    g.fillStyle = '#2b363b';
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#1d5a74';
    g.fillRect(0, 0, Math.max(0, mapPX(city.shoreX)), c.height);
    g.fillStyle = '#6f6244';
    g.fillRect(Math.max(0, mapPX(city.shoreX)), 0, Math.max(0, MAP_PAD - mapPX(city.shoreX)), c.height);
    // Block plates sit darker than the road surface, so the streets read as light lines.
    for (const b of city.blocks) {
      if (b.kind === 'park') g.fillStyle = '#3d6b45';
      else if (b.kind === 'lot') g.fillStyle = '#333f44';
      else g.fillStyle = '#232c31';
      g.fillRect(mapPX(b.x), mapPY(b.y), b.w / MAP_STEP, b.h / MAP_STEP);
    }
    // Roads: bright lines, drawn over the plates so every junction is legible at thumbnail size.
    g.strokeStyle = '#9fb0ae';
    g.lineCap = 'butt';
    g.lineWidth = Math.max(2, 78 / MAP_STEP);
    for (let i = 0; i < city.cols; i += 1) {
      const x = mapPX(i * city.grid);
      g.beginPath();
      g.moveTo(x, MAP_PAD);
      g.lineTo(x, c.height - MAP_PAD);
      g.stroke();
    }
    for (let j = 0; j < city.rows; j += 1) {
      const y = mapPY(j * city.grid);
      g.beginPath();
      g.moveTo(MAP_PAD, y);
      g.lineTo(c.width - MAP_PAD, y);
      g.stroke();
    }
    // Buildings on top of the plate, so the map speaks the same fill language as the streets.
    for (const b of city.buildings) {
      g.fillStyle = '#39474d';
      g.fillRect(mapPX(b.x), mapPY(b.y), Math.max(1.5, b.w / MAP_STEP), Math.max(1.5, b.h / MAP_STEP));
    }
    // The pier.
    for (const p of city.piers) {
      g.fillStyle = '#8a7350';
      g.fillRect(mapPX(p.x), mapPY(p.y), p.w / MAP_STEP, p.h / MAP_STEP);
    }
    mapCanvas = c;
    return c;
  }

  const api = {
    /** Bake the map once the city exists. */
    prepare(city) {
      bakeMap(city);
    },
    /** Draw the HUD for a world onto the shared overlay, then blit it. */
    draw(world) {
      const ctx = renderer.beginOverlay();
      drawWanted(ctx, world);
      drawObjective(ctx, world);
      drawMiniMap(ctx, world);
      drawStats(ctx, world);
      drawWeapon(ctx, world);
      drawHints(ctx, world);
      drawToast(ctx, world);
      drawBigMessage(ctx, world);
      drawCashFlash(ctx, world);
      renderer.endOverlay();
    },
    /** A HUD-space hit test, for the pause button. */
    get minimapRect() {
      return MINI;
    },
  };
  return api;
}

// ---------------------------------------------------------------- wanted stars

function drawWanted(ctx, world) {
  const stars = world.police.stars;
  const x0 = VIEW.w - 24;
  const y = 26;
  for (let i = 0; i < WANTED.max; i += 1) {
    const x = x0 - (WANTED.max - i) * 31 - 8;
    const on = i < stars;
    const hot = on && stars >= 4;
    ctx.save();
    ctx.translate(x + 15, y + 15);
    if (on) {
      ctx.shadowColor = hot ? 'rgba(228,84,74,0.8)' : 'rgba(240,183,63,0.7)';
      ctx.shadowBlur = 12;
    }
    starPath(ctx, 0, 0, 13, 5.6, 5);
    ctx.fillStyle = on ? (hot ? '#e4544a' : PALETTE.gold) : 'rgba(20,22,26,0.45)';
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = on ? 'rgba(255,246,222,0.7)' : 'rgba(246,240,226,0.28)';
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.restore();
  }
  // The heat's label, and a timer ring while it is decaying.
  if (stars > 0) {
    const label = WANTED.titles[stars].toUpperCase();
    ctx.font = '700 12px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(228,84,74,0.95)';
    ctx.fillText(label, x0, y + 52);
    if (world.police.seenTimer <= 0) {
      ctx.fillStyle = 'rgba(246,240,226,0.7)';
      ctx.font = '600 10px system-ui, sans-serif';
      ctx.fillText('LOSING HEAT', x0, y + 66);
    }
  }
}

// ---------------------------------------------------------------- objective

function drawObjective(ctx, world) {
  const obj = missionObjective(world);
  if (!obj) return;
  const x = 24;
  const y = 24;
  const w = 336;
  const lines = wrapText(ctx, obj.text ?? '', w - 44, '600 15px system-ui, sans-serif');
  const h = 54 + lines.length * 19 + (obj.timer ? 26 : 0);
  // The card: dark glass with a gold edge.
  ctx.save();
  fillRoundRect(ctx, x, y, w, h, 10, 'rgba(16,18,22,0.62)');
  strokeRoundRect(ctx, x, y, w, h, 10, 'rgba(240,183,63,0.24)', 1.2);
  ctx.fillStyle = PALETTE.gold;
  ctx.fillRect(x + 14, y + 16, 3, 16);
  ctx.font = '700 11px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = obj.title ? 'rgba(246,240,226,0.62)' : PALETTE.gold;
  ctx.fillText((obj.title ?? 'OBJECTIVE').toUpperCase(), x + 26, y + 28);
  ctx.font = '600 15px system-ui, sans-serif';
  ctx.fillStyle = '#f6f0e2';
  lines.forEach((line, i) => ctx.fillText(line, x + 26, y + 50 + i * 19));
  if (obj.hint) {
    ctx.font = '500 11px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(246,240,226,0.5)';
    ctx.fillText(obj.hint, x + 26, y + 50 + lines.length * 19 + 4);
  }
  // A countdown bar.
  if (obj.timer && obj.timer > 0) {
    const tx = x + 26;
    const ty = y + h - 16;
    const tw = w - 52;
    ctx.fillStyle = 'rgba(246,240,226,0.16)';
    fillRoundRect(ctx, tx, ty, tw, 4, 2, 'rgba(246,240,226,0.16)');
    const frac = clamp(obj.timer / 150, 0, 1);
    const frac2 = clamp(obj.timer / 34, 0, 1);
    const f = obj.timer > 40 ? frac : frac2;
    fillRoundRect(ctx, tx, ty, tw * clamp(f, 0.02, 1), 4, 2, obj.timer < 12 ? '#e4544a' : PALETTE.gold);
    ctx.font = '700 11px system-ui, sans-serif';
    ctx.fillStyle = obj.timer < 12 ? '#ff8a7a' : 'rgba(246,240,226,0.8)';
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.ceil(obj.timer)}s`, x + w - 16, ty - 4);
  }
  // Remaining targets.
  if (obj.remaining !== undefined && obj.remaining > 0) {
    ctx.textAlign = 'right';
    ctx.font = '700 12px system-ui, sans-serif';
    ctx.fillStyle = '#e4544a';
    ctx.fillText(`${obj.remaining} LEFT`, x + w - 16, y + 28);
  }
  ctx.restore();
}

function wrapText(ctx, text, maxW, font) {
  ctx.font = font;
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxW && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

// ---------------------------------------------------------------- minimap

function drawMiniMap(ctx, world) {
  const { x, y, w, h } = MINI;
  // The window onto the map: one world unit per MAP_STEP map pixels.
  const spanW = 620;
  const spanH = (spanW * h) / w;
  const px = clamp(world.player.x, spanW / 2, world.city.width - spanW / 2);
  const py = clamp(world.player.y, spanH / 2, world.city.height - spanH / 2);
  const sx = mapPX(px - spanW / 2);
  const sy = mapPY(py - spanH / 2);
  const sw = spanW / MAP_STEP;
  const sh = spanH / MAP_STEP;

  ctx.save();
  // A drop shadow under the plate.
  ctx.fillStyle = 'rgba(8,10,12,0.55)';
  ctx.beginPath();
  ctx.ellipse(x + w / 2 + 3, y + h / 2 + 4, w / 2, h / 2, 0, 0, Math.PI * 2);
  ctx.fill();
  // A circular plate, framed with a warm rim so it reads as a gadget rather than a panel.
  ctx.beginPath();
  ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  ctx.clip();
  if (mapCanvas) {
    ctx.drawImage(mapCanvas, sx, sy, sw, sh, x, y, w, h);
  }
  const worldToMini = (wx, wy) => ({ x: x + ((wx - px + spanW / 2) / spanW) * w, y: y + ((wy - py + spanH / 2) / spanH) * h });

  // Police units: blue/red dots.
  for (const unit of world.police.units) {
    if (unit.state === 'released') continue;
    const pt = worldToMini(unit.car.x, unit.car.y);
    if (pt.x < x || pt.x > x + w || pt.y < y || pt.y > y + h) continue;
    const phase = Math.sin(world.clock * 9) > 0;
    ctx.fillStyle = phase ? '#5a8cff' : '#e4544a';
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 3.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(10,14,18,0.8)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  // The mission marker: a gold ring with a pointer.
  const obj = missionObjective(world);
  if (obj?.marker) {
    const pt = worldToMini(obj.marker.x, obj.marker.y);
    const pulse = 5 + Math.sin(world.clock * 4) * 1.6;
    ctx.strokeStyle = 'rgba(240,183,63,0.95)';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, pulse + 3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = PALETTE.gold;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 2.8, 0, Math.PI * 2);
    ctx.fill();
    // An off-map arrow at the edge, pointing at it.
    const dx = pt.x - (x + w / 2);
    const dy = pt.y - (y + h / 2);
    const outside = pt.x < x + 10 || pt.x > x + w - 10 || pt.y < y + 10 || pt.y > y + h - 10;
    if (outside) {
      const a = Math.atan2(dy, dx);
      const ex = x + w / 2 + Math.cos(a) * (w / 2 - 12);
      const ey = y + h / 2 + Math.sin(a) * (h / 2 - 12);
      ctx.save();
      ctx.translate(ex, ey);
      ctx.rotate(a);
      ctx.fillStyle = PALETTE.gold;
      ctx.beginPath();
      ctx.moveTo(6, 0);
      ctx.lineTo(-4, 4);
      ctx.lineTo(-4, -4);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }
  // Side-job markers, dimmer.
  for (const job of world.missions.available) {
    if (world.missions.active) break;
    if (!job.marker) continue;
    const pt = worldToMini(job.marker.x, job.marker.y);
    if (pt.x < x || pt.x > x + w || pt.y < y || pt.y > y + h) continue;
    ctx.strokeStyle = 'rgba(142,209,106,0.8)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 4, 0, Math.PI * 2);
    ctx.stroke();
  }
  // The player's arrow, pointing where they face.
  const pp = worldToMini(world.player.x, world.player.y);
  ctx.save();
  ctx.translate(pp.x, pp.y);
  ctx.rotate((world.player.inCar ? world.player.inCar.angle : world.player.aiming ? world.player.aimAngle : world.player.angle) + Math.PI / 2);
  ctx.fillStyle = '#f6f0e2';
  ctx.strokeStyle = 'rgba(14,18,22,0.9)';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(0, -6.5);
  ctx.lineTo(4.6, 5.4);
  ctx.lineTo(0, 3);
  ctx.lineTo(-4.6, 5.4);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
  // The camera's view cone, faintly.
  ctx.strokeStyle = 'rgba(246,240,226,0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pp.x, pp.y);
  ctx.lineTo(pp.x + Math.cos(world.camera.angle - 0.4) * 16, pp.y + Math.sin(world.camera.angle - 0.4) * 16);
  ctx.moveTo(pp.x, pp.y);
  ctx.lineTo(pp.x + Math.cos(world.camera.angle + 0.4) * 16, pp.y + Math.sin(world.camera.angle + 0.4) * 16);
  ctx.stroke();
  ctx.restore();

  // Frame: a warm ring, a soft inner shadow, and a compass tick at the top.
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(246,240,226,0.30)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(x + w / 2, y + h / 2, w / 2 - 1.5, h / 2 - 1.5, 0, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(217,119,47,0.45)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
  fillRoundRect(ctx, x + 8, y + 8, 26, 15, 5, 'rgba(12,14,18,0.55)');
  ctx.font = '700 9px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(246,240,226,0.75)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('N', x + 21, y + 16);
  // The district's name under the map.
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '700 12px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(246,240,226,0.9)';
  ctx.fillText(world.city.districtAt(world.player.x, world.player.y).toUpperCase(), x + 4, y + h + 18);
  ctx.font = '600 11px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(246,240,226,0.45)';
  ctx.fillText(clockString(world.time), x + 4, y + h + 33);
  ctx.restore();
}

function clockString(time) {
  const h = Math.floor(time / 3600) % 24;
  const m = Math.floor((time % 3600) / 60);
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

// ---------------------------------------------------------------- bars and money

function drawStats(ctx, world) {
  const p = world.player;
  const x = BAR.x;
  const y = BAR.y;
  // Health.
  ctx.save();
  ctx.font = '700 10px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(246,240,226,0.6)';
  ctx.fillText('HEALTH', x, y - 9);
  fillRoundRect(ctx, x, y, BAR.w, BAR.h, 5, 'rgba(12,14,18,0.55)');
  const hp = clamp(p.health / 100, 0, 1);
  const hpGrad = ctx.createLinearGradient(x, 0, x + BAR.w, 0);
  hpGrad.addColorStop(0, hp < 0.3 ? '#c8342e' : '#7bbf5a');
  hpGrad.addColorStop(1, hp < 0.3 ? '#e4544a' : '#a5d97e');
  fillRoundRect(ctx, x, y, Math.max(4, BAR.w * hp), BAR.h, 5, hpGrad);
  // Armour.
  const ay = y + BAR.h + 7;
  fillRoundRect(ctx, x, ay, BAR.w, BAR.h * 0.72, 4, 'rgba(12,14,18,0.5)');
  const ar = clamp(p.armour / 100, 0, 1);
  if (ar > 0) fillRoundRect(ctx, x, ay, Math.max(3, BAR.w * ar), BAR.h * 0.72, 4, '#4a8fd4');
  // Numeric health, small, at the end of the bar.
  ctx.textAlign = 'right';
  ctx.font = '700 10px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(246,240,226,0.8)';
  ctx.fillText(String(Math.ceil(p.health)), x + BAR.w - 6, y + BAR.h / 2 + 0.5);

  // Money.
  const my = y - 34;
  ctx.textAlign = 'left';
  ctx.font = '800 26px system-ui, sans-serif';
  ctx.fillStyle = p.walletFlash > 0 ? '#b6f09a' : '#e9f5d8';
  ctx.fillText(money(p.money), x, my);
  if (p.cashFlash > 0) {
    ctx.globalAlpha = p.cashFlash;
    ctx.font = '700 13px system-ui, sans-serif';
    ctx.fillStyle = '#b6f09a';
    ctx.fillText('+', x + 92 + (1 - p.cashFlash) * 10, my - 14 - (1 - p.cashFlash) * 8);
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

function drawWeapon(ctx, world) {
  const p = world.player;
  const w = 150;
  const h = 58;
  const x = VIEW.w - w - 24;
  const y = VIEW.h - h - 24;
  fillRoundRect(ctx, x, y, w, h, 10, 'rgba(16,18,22,0.62)');
  strokeRoundRect(ctx, x, y, w, h, 10, 'rgba(246,240,226,0.16)', 1.2);
  const def = WEAPONS[p.weapon];
  drawWeaponIcon(ctx, p.weapon, x + 30, y + h / 2);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '700 11px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(246,240,226,0.6)';
  ctx.fillText(def.name.toUpperCase(), x + 54, y + 22);
  ctx.font = '800 20px system-ui, sans-serif';
  ctx.fillStyle = '#f6f0e2';
  const ammo = p.ammo[p.weapon];
  ctx.fillText(ammo === Infinity || p.weapon === 'fists' ? '—' : String(ammo), x + 54, y + 44);
  if (p.weapon !== 'fists') {
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(246,240,226,0.45)';
    ctx.fillText(`/ ${def.maxAmmo}`, x + 54 + (ammo > 99 ? 46 : ammo > 9 ? 32 : 20), y + 44);
  }
  // The selectable slots, fists / pistol / smg.
  const order = ['fists', 'pistol', 'smg'];
  order.forEach((name, i) => {
    const sx = x + w - 46 + (i % 2) * 0;
    void sx;
    const dot = x + 12 + i * 0;
    void dot;
  });
  // A little row of slots under the name.
  order.forEach((name, i) => {
    const owned = p.hasWeapon[name];
    const active = p.weapon === name;
    const bx = x + 56 + i * 20;
    const by = y + h - 14;
    ctx.fillStyle = active ? PALETTE.gold : owned ? 'rgba(246,240,226,0.28)' : 'rgba(246,240,226,0.1)';
    ctx.fillRect(bx, by, 14, 3);
  });
}

function drawWeaponIcon(ctx, weapon, x, y) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = '#2a2c32';
  if (weapon === 'pistol') {
    fillRoundRect(ctx, -13, -4, 24, 7, 1.6, '#2a2c32');
    fillRoundRect(ctx, -8, 2, 7, 9, 1.6, '#33363e');
    ctx.fillStyle = '#4a4d56';
    ctx.fillRect(-13, -4, 6, 2.4);
  } else if (weapon === 'smg') {
    fillRoundRect(ctx, -14, -5, 26, 7, 1.8, '#2a2c32');
    fillRoundRect(ctx, -4, 2, 5, 10, 1.4, '#33363e');
    fillRoundRect(ctx, 6, 2, 4, 7, 1.2, '#33363e');
    ctx.fillStyle = '#4a4d56';
    ctx.fillRect(10, -4, 4, 2);
  } else {
    ctx.fillStyle = '#d9a97f';
    ctx.beginPath();
    ctx.arc(-3, 0, 5.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#c9976d';
    ctx.beginPath();
    ctx.arc(5, -2, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ---------------------------------------------------------------- hints, toast, messages

function drawHints(ctx, world) {
  // The context prompt: press E to take the car you are standing beside.
  const p = world.player;
  if (!p.inCar && !p.dead) {
    let best = null;
    let bd = 90 * 90;
    for (const car of world.cars) {
      const d = (car.x - p.x) ** 2 + (car.y - p.y) ** 2;
      if (d < bd) {
        bd = d;
        best = car;
      }
    }
    if (best) {
      const label = best.parked || !best.driver ? `Take the ${best.model.name}` : `Jack the ${best.model.name}`;
      const w = 210;
      const x = VIEW.w / 2 - w / 2;
      const y = VIEW.h - 150;
      fillRoundRect(ctx, x, y, w, 30, 8, 'rgba(16,18,22,0.72)');
      strokeRoundRect(ctx, x, y, w, 30, 8, 'rgba(240,183,63,0.4)', 1);
      ctx.save();
      fillRoundRect(ctx, x + 8, y + 7, 20, 16, 4, PALETTE.gold);
      ctx.font = '800 11px system-ui, sans-serif';
      ctx.fillStyle = '#1b1b22';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('E', x + 18, y + 15.5);
      ctx.restore();
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.fillStyle = '#f6f0e2';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, x + 36, y + 15.5);
    }
  }
  // A small controls strip, bottom left of the weapon panel: dark plate so it stays legible on
  // bright pavement.
  if (world.showControls) {
    const text = 'WASD move · SHIFT sprint · F enter car · LMB fire · 1/2/3 weapon · ESC pause';
    const x = 24;
    const y = VIEW.h - 220;
    ctx.save();
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const w = ctx.measureText(text).width + 20;
    fillRoundRect(ctx, x, y - 13, w, 26, 7, 'rgba(12,14,18,0.62)');
    ctx.fillStyle = '#F2EEE4';
    ctx.fillText(text, x + 10, y);
    ctx.restore();
  }
}

function drawToast(ctx, world) {
  const t = world.toast;
  if (!t) return;
  const k = clamp(t.life / 0.5, 0, 1) * clamp((t.max - t.life) / 0.25, 0, 1);
  const w = 430;
  const x = VIEW.w / 2 - w / 2;
  const y = 108;
  ctx.save();
  ctx.globalAlpha = k;
  const slide = (1 - clamp((t.max - t.life) / 0.3, 0, 1)) * 14;
  ctx.translate(0, -slide);
  fillRoundRect(ctx, x, y, w, 84, 12, 'rgba(16,18,22,0.82)');
  strokeRoundRect(ctx, x, y, w, 84, 12, t.tone === 'good' ? 'rgba(142,209,106,0.5)' : t.tone === 'bad' ? 'rgba(228,84,74,0.5)' : 'rgba(240,183,63,0.4)', 1.4);
  ctx.fillStyle = t.tone === 'good' ? '#8ed16a' : t.tone === 'bad' ? '#e4544a' : PALETTE.gold;
  ctx.fillRect(x + 16, y + 16, 3, 52);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '700 10px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(246,240,226,0.55)';
  ctx.fillText((t.kicker ?? '').toUpperCase(), x + 30, y + 24);
  ctx.font = '800 20px system-ui, sans-serif';
  ctx.fillStyle = '#f6f0e2';
  ctx.fillText(t.title, x + 30, y + 47);
  ctx.font = '500 12px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(246,240,226,0.72)';
  const bodyLines = wrapText(ctx, t.body ?? '', w - 60, '500 12px system-ui, sans-serif');
  bodyLines.slice(0, 2).forEach((line, i) => ctx.fillText(line, x + 30, y + 66 + i * 15));
  ctx.restore();
}

function drawBigMessage(ctx, world) {
  if (world.bigMessageTimer <= 0 || !world.bigMessage) return;
  const k = clamp(world.bigMessageTimer / 0.4, 0, 1);
  // The lockdown banner is a passing note, not a headline: keep it quiet so the city stays the
  // subject.
  const quiet = /LOCKDOWN/i.test(world.bigMessage);
  ctx.save();
  ctx.globalAlpha = k * (quiet ? 0.55 : 1);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = quiet ? '900 30px system-ui, sans-serif' : '900 46px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(10,8,8,0.55)';
  ctx.fillText(world.bigMessage, VIEW.w / 2 + 2, 214 + 2);
  const g = ctx.createLinearGradient(0, 180, 0, 240);
  g.addColorStop(0, '#ffe3a3');
  g.addColorStop(1, '#f0b73f');
  ctx.fillStyle = g;
  ctx.fillText(world.bigMessage, VIEW.w / 2, 214);
  ctx.restore();
}

function drawCashFlash(ctx, world) {
  if (world.player.walletFlash <= 0) return;
  ctx.save();
  ctx.globalAlpha = world.player.walletFlash * 0.2;
  ctx.fillStyle = '#8ed16a';
  ctx.fillRect(0, 0, VIEW.w, VIEW.h);
  ctx.restore();
}

export { MINI };
