// Menus and screens: the title card with its sunset rim, the pause menu, the mission briefing card,
// the job board at the garage, and the death card. They are drawn in logical pixels over the world
// (the title has the live city behind it), and they own their own hit rectangles so the mouse can
// press them.
//
// The screens never touch the simulation: they read `app.screen` and call the app's verbs.

import { GAME_SUBTITLE, GAME_TITLE, PALETTE, VIEW } from './config.js';
import { alpha, clamp, fillRoundRect, money, roundRectPath, shade, starPath, strokeRoundRect } from './util.js';

/** Screen ids: 'title' | 'playing' | 'paused' | 'briefing' | 'board' | 'dead'. */
const BTN_H = 44;

export function createScreens() {
  const api = {
    /** The rectangles the last draw produced, so a click can be matched. */
    buttons: [],
    hover: -1,
    toast: 0,

    /**
     * Draw the screen for `app.screen`. Returns nothing; buttons are registered for hit tests.
     */
    draw(ctx, app, world, input) {
      api.buttons = [];
      switch (app.screen) {
        case 'title':
          drawTitle(ctx, app, world, input, api);
          break;
        case 'paused':
          drawPause(ctx, app, world, input, api);
          break;
        case 'briefing':
          drawBriefing(ctx, app, world, input, api);
          break;
        case 'board':
          drawBoard(ctx, app, world, input, api);
          break;
        case 'dead':
          drawDead(ctx, app, world, input, api);
          break;
        default:
          break;
      }
      // The mouse cursor's hover state for the next frame.
      if (input) api.hover = hitTest(api.buttons, input.mouse.x, input.mouse.y);
    },

    /** Handle a click in logical coordinates; returns true if a button consumed it. */
    click(x, y, app) {
      const i = hitTest(api.buttons, x, y);
      if (i < 0) return false;
      const b = api.buttons[i];
      app.audio.play('click', { volume: 0.6 });
      b.onPress();
      return true;
    },

    /** The screen is showing: whether the world should keep simulating behind it. */
    simulates(screen) {
      return screen === 'title' || screen === 'playing' || screen === 'briefing' || screen === 'board';
    },
  };
  return api;
}

function hitTest(buttons, x, y) {
  for (let i = 0; i < buttons.length; i += 1) {
    const b = buttons[i];
    if (!b.disabled && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return i;
  }
  return -1;
}

// ---------------------------------------------------------------- shared pieces

/** A button: a dark glass pill with a gold edge when hovered, plus a hint line. */
function button(ctx, api, opt) {
  const { x, y, w, h = BTN_H, label, sub, onPress, primary, disabled, tone } = opt;
  const idx = api.buttons.length;
  const hovered = api.hover === idx && !disabled;
  const fill = primary
    ? hovered
      ? 'rgba(255,214,140,0.96)'
      : 'rgba(240,183,63,0.92)'
    : hovered
      ? 'rgba(38,42,48,0.94)'
      : 'rgba(22,25,30,0.8)';
  ctx.save();
  if (hovered) {
    ctx.shadowColor = primary ? 'rgba(255,200,110,0.55)' : 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = primary ? 20 : 12;
  }
  fillRoundRect(ctx, x, y, w, h, 8, fill);
  ctx.shadowBlur = 0;
  strokeRoundRect(ctx, x, y, w, h, 8, disabled ? 'rgba(246,240,226,0.1)' : primary ? 'rgba(255,246,222,0.65)' : hovered ? 'rgba(240,183,63,0.55)' : 'rgba(246,240,226,0.22)', 1.2);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '800 15px system-ui, sans-serif';
  ctx.fillStyle = disabled ? 'rgba(246,240,226,0.28)' : primary ? '#231a0c' : tone === 'danger' ? '#e4544a' : '#f6f0e2';
  ctx.fillText(label, x + w / 2, y + h / 2 + (sub ? -6 : 0));
  if (sub) {
    ctx.font = '500 10px system-ui, sans-serif';
    ctx.fillStyle = primary ? 'rgba(35,26,12,0.65)' : 'rgba(246,240,226,0.45)';
    ctx.fillText(sub, x + w / 2, y + h / 2 + 9);
  }
  ctx.restore();
  api.buttons.push({ x, y, w, h, onPress, disabled });
}

function keycap(ctx, x, y, label, w = 24) {
  fillRoundRect(ctx, x, y, w, 20, 5, 'rgba(246,240,226,0.14)');
  strokeRoundRect(ctx, x, y, w, 20, 5, 'rgba(246,240,226,0.22)', 1);
  ctx.font = '700 10px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(246,240,226,0.85)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x + w / 2, y + 10.5);
}

function controlRow(ctx, x, y, keys, text) {
  let kx = x;
  for (const k of keys) {
    keycap(ctx, kx, y, k, k.length > 1 ? 16 + k.length * 5.6 : 22);
    kx += (k.length > 1 ? 16 + k.length * 5.6 : 22) + 4;
  }
  ctx.font = '500 12px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(246,240,226,0.66)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, kx + 6, y + 10.5);
}

// ---------------------------------------------------------------- the title

function drawTitle(ctx, app, world, input, api) {
  void input;
  // A deep warm scrim so the city reads as a backdrop, not a distraction.
  const g = ctx.createLinearGradient(0, 0, VIEW.w, VIEW.h);
  g.addColorStop(0, 'rgba(12,10,12,0.86)');
  g.addColorStop(0.52, 'rgba(12,10,12,0.5)');
  g.addColorStop(1, 'rgba(40,18,10,0.62)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VIEW.w, VIEW.h);
  // A warm haze from the lower right, the sun's side.
  const sun = ctx.createRadialGradient(VIEW.w * 0.82, VIEW.h * 0.78, 40, VIEW.w * 0.82, VIEW.h * 0.78, 620);
  sun.addColorStop(0, 'rgba(255,150,70,0.30)');
  sun.addColorStop(0.5, 'rgba(214,90,50,0.10)');
  sun.addColorStop(1, 'rgba(160,60,40,0)');
  ctx.fillStyle = sun;
  ctx.fillRect(0, 0, VIEW.w, VIEW.h);

  const x = 92;

  // The game's name: a heavy display face, letterspaced, with a warm gradient and a chromatic edge.
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const ty = 216;
  ctx.font = '900 84px system-ui, "Helvetica Neue", Arial, sans-serif';
  // The offset shadow that reads as a printed poster.
  ctx.fillStyle = 'rgba(10,6,6,0.66)';
  ctx.fillText(GAME_TITLE, x + 5, ty + 6);
  const tg = ctx.createLinearGradient(x, ty - 76, x, ty + 8);
  tg.addColorStop(0, '#fff6e0');
  tg.addColorStop(0.45, '#ffd894');
  tg.addColorStop(0.75, '#f0a44a');
  tg.addColorStop(1, '#d9772f');
  ctx.fillStyle = tg;
  ctx.fillText(GAME_TITLE, x, ty);
  // A thin hot rim on the top edge of the letters.
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = 'rgba(255,120,80,0.20)';
  ctx.fillText(GAME_TITLE, x + 1.4, ty - 1.2);
  ctx.globalCompositeOperation = 'source-over';
  ctx.restore();

  // A rule and the subtitle.
  ctx.fillStyle = PALETTE.gold;
  ctx.fillRect(x + 2, ty + 26, 74, 3);
  ctx.font = '500 15px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(246,240,226,0.72)';
  ctx.textAlign = 'left';
  ctx.fillText(GAME_SUBTITLE, x + 2, ty + 56);

  // The station caption, like a poster's small print.
  ctx.font = '700 10px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(246,240,226,0.42)';
  ctx.fillText('SOLARA BAY · 4:40 PM · 29°C · OCEAN BREEZE', x + 2, ty + 78);

  // Buttons.
  const bw = 268;
  const bx = x + 2;
  let by = 386;
  const has = app.hasSave;
  button(ctx, api, {
    x: bx,
    y: by,
    w: bw,
    h: 50,
    label: 'New Game',
    sub: has ? 'Start the story over' : 'Begin at the garage',
    primary: true,
    onPress: () => app.newGame(),
  });
  by += 62;
  button(ctx, api, {
    x: bx,
    y: by,
    w: bw,
    h: 50,
    label: 'Continue',
    sub: has ? app.saveLabel : 'No save on this machine',
    disabled: !has,
    onPress: () => app.continueGame(),
  });
  by += 62;
  button(ctx, api, {
    x: bx,
    y: by,
    w: bw,
    h: 50,
    label: 'Controls',
    sub: 'Keyboard and mouse',
    onPress: () => app.showControls(),
  });

  // The controls card, right side.
  if (app.controlsOpen) {
    drawControlsCard(ctx, api);
  } else {
    // A faint hint strip along the bottom.
    ctx.font = '500 12px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(246,240,226,0.4)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('Desktop Chrome · keyboard and mouse · no install', x + 2, VIEW.h - 46);
    ctx.fillStyle = 'rgba(246,240,226,0.22)';
    ctx.fillText('An original open-world crime sandbox.', x + 2, VIEW.h - 26);
  }

  // The city's name, right-aligned in the corner like a widescreen caption.
  ctx.textAlign = 'right';
  ctx.font = '700 11px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(246,240,226,0.4)';
  ctx.fillText('SOLARA BAY', VIEW.w - 40, VIEW.h - 40);
  void world;
}

function drawControlsCard(ctx, api) {
  const w = 470;
  const h = 396;
  const x = VIEW.w - w - 92;
  const y = 168;
  ctx.save();
  fillRoundRect(ctx, x, y, w, h, 14, 'rgba(14,16,20,0.9)');
  strokeRoundRect(ctx, x, y, w, h, 14, 'rgba(240,183,63,0.3)', 1.4);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '800 13px system-ui, sans-serif';
  ctx.fillStyle = PALETTE.gold;
  ctx.fillText('CONTROLS', x + 26, y + 34);

  const rows = [
    [['W', 'A', 'S', 'D'], 'Walk · sprint with SHIFT'],
    [['Mouse'], 'Aim, and left click to shoot'],
    [['F'], 'Enter or exit a car (or E)'],
    [['1', '2', '3'], 'Fists, pistol, SMG'],
    [['Space'], 'Handbrake in a car'],
    [['ESC'], 'Pause · release the mouse'],
    [['M'], 'Mute the audio'],
    [['Tab'], 'Toggle the controls strip'],
  ];
  let ry = y + 66;
  for (const [keys, text] of rows) {
    controlRow(ctx, x + 26, ry, keys, text);
    ry += 30;
  }
  // A divider, then the driving note.
  ctx.fillStyle = 'rgba(246,240,226,0.12)';
  ctx.fillRect(x + 26, ry + 4, w - 52, 1);
  ctx.font = '500 11px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(246,240,226,0.5)';
  ctx.fillText('The heat fades when nobody can see you. Drive out of sight,', x + 26, ry + 26);
  ctx.fillText('then keep your nose clean for a few seconds.', x + 26, ry + 42);
  ctx.restore();

  button(ctx, api, {
    x: x + w - 130,
    y: y + h + 14,
    w: 130,
    h: 38,
    label: 'Close',
    onPress: () => api.onCloseControls?.(),
  });
}

// ---------------------------------------------------------------- pause

function drawPause(ctx, app, world, input, api) {
  void input;
  ctx.fillStyle = 'rgba(10,10,14,0.66)';
  ctx.fillRect(0, 0, VIEW.w, VIEW.h);
  const w = 430;
  const x = VIEW.w / 2 - w / 2;
  const y = 130;
  const h = 470;
  ctx.save();
  fillRoundRect(ctx, x, y, w, h, 16, 'rgba(16,18,22,0.95)');
  strokeRoundRect(ctx, x, y, w, h, 16, 'rgba(246,240,226,0.16)', 1.4);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '800 11px system-ui, sans-serif';
  ctx.fillStyle = PALETTE.gold;
  ctx.fillText('PAUSED', VIEW.w / 2, y + 34);
  ctx.font = '900 32px system-ui, sans-serif';
  ctx.fillStyle = '#f6f0e2';
  ctx.fillText('Solara Bay', VIEW.w / 2, y + 74);
  // The run's numbers.
  const st = world.stats;
  ctx.font = '500 12px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(246,240,226,0.55)';
  ctx.fillText(`${money(world.player.money)} · ${st.missions} jobs · ${Math.round(st.distance / 1000)} km driven`, VIEW.w / 2, y + 98);
  ctx.restore();

  let by = y + 126;
  const bw = w - 72;
  const bx = x + 36;
  button(ctx, api, { x: bx, y: by, w: bw, label: 'Resume', primary: true, onPress: () => app.resume() });
  by += 54;
  button(ctx, api, { x: bx, y: by, w: bw, label: 'Save Game', sub: 'Writes to this browser', onPress: () => app.saveGame() });
  by += 54;
  button(ctx, api, { x: bx, y: by, w: bw, h: 40, label: app.muted ? 'Sound: Off' : 'Sound: On', onPress: () => app.toggleMute() });
  by += 50;
  button(ctx, api, { x: bx, y: by, w: bw, h: 40, label: 'Restart the story', tone: 'danger', onPress: () => app.restart() });
  by += 50;
  button(ctx, api, { x: bx, y: by, w: bw, h: 40, label: 'Quit to title', onPress: () => app.toTitle() });

  // The pause card's footer hint.
  ctx.font = '500 11px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(246,240,226,0.34)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('ESC to resume', VIEW.w / 2, y + h - 22);
}

// ---------------------------------------------------------------- briefing

function drawBriefing(ctx, app, world, input, api) {
  void input;
  const b = app.briefing;
  if (!b) return;
  // A letterboxed card over a dimmed, slightly blurred-feeling city.
  ctx.fillStyle = 'rgba(9,9,12,0.72)';
  ctx.fillRect(0, 0, VIEW.w, VIEW.h);
  const w = 760;
  const x = VIEW.w / 2 - w / 2;
  const y = 116;
  const h = 468;
  ctx.save();
  // A card with a warm paper edge: the poster feel of a wanted notice.
  fillRoundRect(ctx, x + 4, y + 6, w, h, 6, 'rgba(6,6,8,0.6)');
  fillRoundRect(ctx, x, y, w, h, 6, 'rgba(20,20,24,0.97)');
  ctx.strokeStyle = 'rgba(240,183,63,0.34)';
  ctx.lineWidth = 1.6;
  roundRectPath(ctx, x, y, w, h, 6);
  ctx.stroke();
  // The gold corner brackets.
  ctx.strokeStyle = PALETTE.gold;
  ctx.lineWidth = 3;
  const bl = 26;
  ctx.beginPath();
  ctx.moveTo(x + 14, y + 14 + bl);
  ctx.lineTo(x + 14, y + 14);
  ctx.lineTo(x + 14 + bl, y + 14);
  ctx.moveTo(x + w - 14 - bl, y + 14);
  ctx.lineTo(x + w - 14, y + 14);
  ctx.lineTo(x + w - 14, y + 14 + bl);
  ctx.stroke();

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '700 10px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(246,240,226,0.5)';
  ctx.fillText(`${(b.giver ?? 'Job').toUpperCase()}  ·  BRIEFING`, x + 44, y + 52);
  ctx.font = '900 38px system-ui, sans-serif';
  ctx.fillStyle = '#f6f0e2';
  ctx.fillText(b.title, x + 42, y + 96);
  ctx.fillStyle = PALETTE.gold;
  ctx.fillRect(x + 44, y + 114, 56, 3);

  // The brief: wrapped, four lines at most, in a readable size.
  ctx.font = '400 15px/1.6 system-ui, sans-serif';
  ctx.fillStyle = 'rgba(246,240,226,0.82)';
  const lines = wrap(ctx, b.body, w - 88, '400 15px system-ui, sans-serif', 6);
  lines.forEach((line, i) => ctx.fillText(line, x + 44, y + 152 + i * 25));

  // The payout and the objectives in a row at the foot.
  const fy = y + h - 118;
  ctx.fillStyle = 'rgba(246,240,226,0.1)';
  ctx.fillRect(x + 44, fy - 14, w - 88, 1);
  ctx.font = '700 10px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(246,240,226,0.45)';
  ctx.fillText('PAYOUT', x + 44, fy + 10);
  ctx.font = '900 30px system-ui, sans-serif';
  ctx.fillStyle = '#b6f09a';
  ctx.fillText(money(b.payout), x + 44, fy + 44);
  ctx.font = '700 10px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(246,240,226,0.45)';
  ctx.fillText('OBJECTIVES', x + 220, fy + 10);
  ctx.font = '500 13px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(246,240,226,0.8)';
  b.objectives.slice(0, 3).forEach((o, i) => {
    ctx.fillStyle = PALETTE.gold;
    ctx.fillRect(x + 220, fy + 26 + i * 21, 4, 4);
    ctx.fillStyle = 'rgba(246,240,226,0.8)';
    ctx.fillText(o, x + 232, fy + 32 + i * 21);
  });
  ctx.restore();

  // The accept button, and a decline.
  button(ctx, api, {
    x: x + w - 300,
    y: y + h - 62,
    w: 250,
    h: 44,
    label: b.acceptLabel ?? 'Accept the job',
    primary: true,
    onPress: () => app.acceptBriefing(),
  });
  button(ctx, api, {
    x: x + 44,
    y: y + h - 62,
    w: 120,
    h: 44,
    label: 'Later',
    onPress: () => app.declineBriefing(),
  });
  void world;
}

// ---------------------------------------------------------------- the job board

function drawBoard(ctx, app, world, input, api) {
  void input;
  ctx.fillStyle = 'rgba(9,9,12,0.74)';
  ctx.fillRect(0, 0, VIEW.w, VIEW.h);
  const w = 800;
  const h = 480;
  const x = VIEW.w / 2 - w / 2;
  const y = 108;
  ctx.save();
  fillRoundRect(ctx, x, y, w, h, 12, 'rgba(18,19,23,0.97)');
  strokeRoundRect(ctx, x, y, w, h, 12, 'rgba(246,240,226,0.16)', 1.4);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '700 10px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(246,240,226,0.5)';
  ctx.fillText("RICO'S GARAGE  ·  THE BOARD", x + 34, y + 40);
  ctx.font = '900 30px system-ui, sans-serif';
  ctx.fillStyle = '#f6f0e2';
  ctx.fillText('Work, if you want it', x + 32, y + 78);
  ctx.restore();

  // Three job cards across.
  const cardW = (w - 68 - 32) / 3;
  const cy = y + 104;
  const cardH = 300;
  app.boardJobs.forEach((job, i) => {
    const cx = x + 34 + i * (cardW + 16);
    const hovered = app.boardHover === i;
    ctx.save();
    fillRoundRect(ctx, cx, cy, cardW, cardH, 10, hovered ? 'rgba(40,42,48,0.98)' : 'rgba(26,28,33,0.95)');
    strokeRoundRect(ctx, cx, cy, cardW, cardH, 10, hovered ? 'rgba(240,183,63,0.6)' : 'rgba(246,240,226,0.14)', 1.2);
    // The card's colour bar.
    ctx.fillStyle = job.color;
    ctx.fillRect(cx + 18, cy + 20, 30, 4);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.font = '800 18px system-ui, sans-serif';
    ctx.fillStyle = '#f6f0e2';
    ctx.fillText(job.title, cx + 18, cy + 54);
    ctx.font = '700 10px system-ui, sans-serif';
    ctx.fillStyle = job.color;
    ctx.fillText(`${money(job.payout)}`, cx + 18, cy + 80);
    // The description.
    ctx.font = '500 12px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(246,240,226,0.6)';
    const lines = wrap(ctx, job.body, cardW - 36, '500 12px system-ui, sans-serif', 5);
    lines.forEach((line, k) => ctx.fillText(line, cx + 18, cy + 108 + k * 18));
    // Stats line at the foot.
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(246,240,226,0.36)';
    ctx.fillText(job.meta, cx + 18, cy + cardH - 54);
    ctx.restore();
    button(ctx, api, {
      x: cx + 18,
      y: cy + cardH - 42,
      w: cardW - 36,
      h: 32,
      label: 'Take the job',
      primary: hovered,
      onPress: () => app.startSide(job.id),
    });
  });

  button(ctx, api, { x: x + w - 150, y: y + h - 56, w: 116, h: 38, label: 'Close', onPress: () => app.closeBoard() });
  void world;
}

// ---------------------------------------------------------------- death

function drawDead(ctx, app, world, input, api) {
  void input;
  ctx.fillStyle = 'rgba(24,8,6,0.5)';
  ctx.fillRect(0, 0, VIEW.w, VIEW.h);
  const w = 470;
  const h = 250;
  const x = VIEW.w / 2 - w / 2;
  const y = VIEW.h / 2 - h / 2 - 20;
  ctx.save();
  fillRoundRect(ctx, x, y, w, h, 12, 'rgba(14,12,14,0.94)');
  strokeRoundRect(ctx, x, y, w, h, 12, 'rgba(228,84,74,0.42)', 1.4);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '900 42px system-ui, sans-serif';
  ctx.fillStyle = '#e4544a';
  ctx.fillText('WASTED', VIEW.w / 2, y + 76);
  ctx.font = '500 13px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(246,240,226,0.66)';
  ctx.fillText(`Bayview General will patch you up. The bill is ${money(150)}.`, VIEW.w / 2, y + 108);
  ctx.fillStyle = 'rgba(246,240,226,0.4)';
  ctx.font = '500 11px system-ui, sans-serif';
  ctx.fillText('A job in progress is lost.', VIEW.w / 2, y + 130);
  ctx.restore();
  button(ctx, api, { x: x + 120, y: y + h - 68, w: w - 240, h: 44, label: 'Get up', primary: true, onPress: () => app.respawn() });
  void world;
}

// ---------------------------------------------------------------- helpers

function wrap(ctx, text, maxW, font, maxLines = 4) {
  ctx.font = font;
  const words = String(text ?? '').split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxW && line) {
      lines.push(line);
      line = word;
      if (lines.length === maxLines - 1) break;
    } else {
      line = test;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  return lines;
}

export { alpha, clamp, shade, starPath };
