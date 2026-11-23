// Small maths and drawing helpers shared by every system. Nothing here touches the game state,
// so it stays dependency-free and cheap to import anywhere.

export const TAU = Math.PI * 2;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (a, b, v) => {
  const t = clamp(invLerp(a, b, v), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Frame-rate independent smoothing: the fraction of the way to the target after dt seconds. */
export const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.exp(-rate * dt));

export const dist2 = (ax, ay, bx, by) => {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
};
export const dist = (ax, ay, bx, by) => Math.sqrt(dist2(ax, ay, bx, by));

/** An angle in (-PI, PI]. */
export function wrapAngle(a) {
  let r = a % TAU;
  if (r > Math.PI) r -= TAU;
  if (r <= -Math.PI) r += TAU;
  return r;
}
/** The signed shortest turn from a to b, in (-PI, PI]. */
export const angleDiff = (a, b) => wrapAngle(b - a);
/** Turn a toward b by at most maxStep radians. */
export function turnToward(a, b, maxStep) {
  const d = angleDiff(a, b);
  return wrapAngle(a + clamp(d, -maxStep, maxStep));
}
export const dampAngle = (a, b, rate, dt) => turnToward(a, b, Math.abs(angleDiff(a, b)) * (1 - Math.exp(-rate * dt)));

export const rightOf = (angle) => ({ x: -Math.sin(angle), y: Math.cos(angle) });
export const forwardOf = (angle) => ({ x: Math.cos(angle), y: Math.sin(angle) });

export const easeOutCubic = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
export const easeInOutCubic = (t) => {
  const v = clamp(t, 0, 1);
  return v < 0.5 ? 4 * v * v * v : 1 - Math.pow(-2 * v + 2, 3) / 2;
};

/** Money as the HUD prints it. */
export function money(n) {
  const v = Math.round(n);
  return `$${v.toLocaleString('en-US')}`;
}

/** A hex colour mixed toward white (amt > 0) or black (amt < 0), amt in [-1, 1]. */
export function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const mix = (c) => Math.round(amt >= 0 ? c + (255 - c) * amt : c * (1 + amt));
  return `#${((1 << 24) | (mix(r) << 16) | (mix(g) << 8) | mix(b)).toString(16).slice(1)}`;
}

/** A hex colour as rgba(). */
export function alpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

export function fillRoundRect(ctx, x, y, w, h, r, fill) {
  roundRectPath(ctx, x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
}

export function strokeRoundRect(ctx, x, y, w, h, r, stroke, width = 1) {
  roundRectPath(ctx, x, y, w, h, r);
  ctx.strokeStyle = stroke;
  ctx.lineWidth = width;
  ctx.stroke();
}

export function circlePath(ctx, x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, Math.max(0.1, r), 0, TAU);
}

/** A regular star path, pointing up. */
export function starPath(ctx, x, y, outer, inner, points = 5, rotation = -Math.PI / 2) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i += 1) {
    const r = i % 2 === 0 ? outer : inner;
    const a = rotation + (i * Math.PI) / points;
    const px = x + Math.cos(a) * r;
    const py = y + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

export function pointInRect(px, py, r) {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

/** Push a circle out of an axis-aligned rect; returns null or the shortest push {x, y, nx, ny, depth}. */
export function circleRectPush(cx, cy, radius, r) {
  const nx = clamp(cx, r.x, r.x + r.w);
  const ny = clamp(cy, r.y, r.y + r.h);
  const dx = cx - nx;
  const dy = cy - ny;
  const d2 = dx * dx + dy * dy;
  if (d2 > radius * radius) return null;
  if (d2 > 1e-6) {
    const d = Math.sqrt(d2);
    return { x: cx + (dx / d) * (radius - d), y: cy + (dy / d) * (radius - d), nx: dx / d, ny: dy / d, depth: radius - d };
  }
  // Centre inside the rect: leave by the nearest face.
  const left = cx - r.x;
  const right = r.x + r.w - cx;
  const top = cy - r.y;
  const bottom = r.y + r.h - cy;
  const m = Math.min(left, right, top, bottom);
  if (m === left) return { x: r.x - radius, y: cy, nx: -1, ny: 0, depth: radius + left };
  if (m === right) return { x: r.x + r.w + radius, y: cy, nx: 1, ny: 0, depth: radius + right };
  if (m === top) return { x: cx, y: r.y - radius, nx: 0, ny: -1, depth: radius + top };
  return { x: cx, y: r.y + r.h + radius, nx: 0, ny: 1, depth: radius + bottom };
}

/** The first point where a ray leaves a rect, or Infinity when it never enters one. */
export function rayRect(ox, oy, dx, dy, r) {
  let tmin = -Infinity;
  let tmax = Infinity;
  if (Math.abs(dx) < 1e-9) {
    if (ox < r.x || ox > r.x + r.w) return Infinity;
  } else {
    let t1 = (r.x - ox) / dx;
    let t2 = (r.x + r.w - ox) / dx;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
  }
  if (Math.abs(dy) < 1e-9) {
    if (oy < r.y || oy > r.y + r.h) return Infinity;
  } else {
    let t1 = (r.y - oy) / dy;
    let t2 = (r.y + r.h - oy) / dy;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
  }
  if (tmax < Math.max(tmin, 0)) return Infinity;
  return tmin >= 0 ? tmin : 0;
}

/** Text with manual letter spacing (canvas letterSpacing is Chrome-only, so this stays portable). */
export function drawSpacedText(ctx, text, x, y, spacing, align = 'left') {
  const chars = [...text];
  const widths = chars.map((c) => ctx.measureText(c).width);
  const total = widths.reduce((a, b) => a + b, 0) + spacing * Math.max(0, chars.length - 1);
  let cx = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
  const oldAlign = ctx.textAlign;
  ctx.textAlign = 'left';
  for (let i = 0; i < chars.length; i += 1) {
    ctx.fillText(chars[i], cx, y);
    cx += widths[i] + spacing;
  }
  ctx.textAlign = oldAlign;
  return total;
}

/** A deterministic noise-ish value in [0,1) from integers, for per-building variation. */
export function hash01(a, b = 0, c = 0) {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
