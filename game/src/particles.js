// Particles: a fixed pool of short-lived sprites and a small decal layer. Everything is drawn by
// render.js; this module only integrates positions, ages and fade. Kinds: spark, smoke, dust,
// blood, flash, debris, splash, ring.

const MAX = 900;

export function createParticles() {
  const items = [];
  for (let i = 0; i < MAX; i += 1) {
    items.push({ life: 0, max: 1, x: 0, y: 0, vx: 0, vy: 0, kind: 'spark', size: 1, color: '#fff', drag: 2, grow: 0, grav: 0, rot: 0, spin: 0 });
  }
  return {
    items,
    cursor: 0,
    count: 0,
    /** Take a free slot (overwriting the oldest when full). */
    spawn(kind, x, y, opts = {}) {
      let p = null;
      for (let i = 0; i < MAX; i += 1) {
        const idx = (this.cursor + i) % MAX;
        if (items[idx].life <= 0) {
          p = items[idx];
          this.cursor = (idx + 1) % MAX;
          break;
        }
      }
      if (!p) {
        p = items[this.cursor];
        this.cursor = (this.cursor + 1) % MAX;
      }
      p.kind = kind;
      p.x = x;
      p.y = y;
      p.vx = opts.vx ?? 0;
      p.vy = opts.vy ?? 0;
      p.life = opts.life ?? 0.6;
      p.max = p.life;
      p.size = opts.size ?? 3;
      p.color = opts.color ?? '#ffffff';
      p.drag = opts.drag ?? 2.4;
      p.grow = opts.grow ?? 0;
      p.grav = opts.grav ?? 0;
      p.rot = opts.rot ?? 0;
      p.spin = opts.spin ?? 0;
      p.alpha = opts.alpha ?? 1;
      return p;
    },
    update(dt) {
      let live = 0;
      for (const p of items) {
        if (p.life <= 0) continue;
        p.life -= dt;
        if (p.life <= 0) continue;
        live += 1;
        const d = Math.exp(-p.drag * dt);
        p.vx *= d;
        p.vy *= d;
        p.vy += p.grav * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.size += p.grow * dt;
        p.rot += p.spin * dt;
      }
      this.count = live;
    },
    clear() {
      for (const p of items) p.life = 0;
      this.count = 0;
    },
  };
}

/** A burst of sparks from a point, thrown in a cone around `angle`. */
export function burstSparks(particles, x, y, angle, count, rnd) {
  for (let i = 0; i < count; i += 1) {
    const a = angle + (rnd.next() - 0.5) * 2.4;
    const sp = 90 + rnd.next() * 230;
    particles.spawn('spark', x, y, {
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp,
      life: 0.22 + rnd.next() * 0.36,
      size: 1.4 + rnd.next() * 1.8,
      color: rnd.chance(0.6) ? '#ffd27a' : '#fff1c9',
      drag: 3.4,
      grav: 220,
    });
  }
  // A little smoke to carry the impact.
  for (let i = 0; i < Math.ceil(count / 3); i += 1) {
    particles.spawn('smoke', x + (rnd.next() - 0.5) * 14, y + (rnd.next() - 0.5) * 14, {
      vx: (rnd.next() - 0.5) * 30,
      vy: -12 - rnd.next() * 22,
      life: 0.7 + rnd.next() * 0.7,
      size: 5 + rnd.next() * 6,
      grow: 14,
      color: '#8d8272',
      alpha: 0.32,
      drag: 1.2,
    });
  }
}

/** Muzzle flash: a quick puff of light and a wisp of smoke at the barrel. */
export function muzzle(particles, x, y, angle, weapon, rnd) {
  const big = weapon === 'pistol' ? 1 : 1.5;
  particles.spawn('flash', x, y, { life: 0.07, size: 12 * big, color: '#ffe6a3', drag: 1, rot: angle });
  for (let i = 0; i < 3; i += 1) {
    particles.spawn('spark', x, y, {
      vx: Math.cos(angle) * (120 + rnd.next() * 160) + (rnd.next() - 0.5) * 60,
      vy: Math.sin(angle) * (120 + rnd.next() * 160) + (rnd.next() - 0.5) * 60,
      life: 0.12,
      size: 1.6,
      color: '#ffe9b0',
      drag: 4,
    });
  }
  particles.spawn('smoke', x, y, { vx: Math.cos(angle) * 26, vy: Math.sin(angle) * 26 - 8, life: 0.5, size: 3, grow: 10, color: '#bdb3a2', alpha: 0.25, drag: 1.4 });
}

/** Tyre smoke and gravel from a sliding car. */
export function tyreSmoke(particles, x, y, angle, intensity, rnd) {
  const back = -angle;
  const ox = x - Math.cos(angle) * 16;
  const oy = y - Math.sin(angle) * 16;
  particles.spawn('smoke', ox + (rnd.next() - 0.5) * 10, oy + (rnd.next() - 0.5) * 10, {
    vx: Math.cos(back) * 30 + (rnd.next() - 0.5) * 30,
    vy: Math.sin(back) * 30 + (rnd.next() - 0.5) * 30 - 8,
    life: 0.5 + rnd.next() * 0.6,
    size: 5 + rnd.next() * 6,
    grow: 26,
    color: '#d8cfbd',
    alpha: 0.2 * intensity,
    drag: 1.6,
  });
}

/** Dust kicked up by a running pedestrian or a landing. */
export function footDust(particles, x, y, rnd) {
  particles.spawn('dust', x, y, { vx: (rnd.next() - 0.5) * 20, vy: (rnd.next() - 0.5) * 20, life: 0.3, size: 2.4, grow: 6, color: '#d9cba8', alpha: 0.3, drag: 3 });
}

/** An explosion: fireball, smoke, sparks and a shockwave ring. */
export function explosion(particles, x, y, rnd) {
  particles.spawn('flash', x, y, { life: 0.16, size: 52, color: '#ffd27a', drag: 0.4, grow: 60 });
  for (let i = 0; i < 26; i += 1) {
    const a = rnd.angle();
    const sp = 40 + rnd.next() * 220;
    particles.spawn('spark', x, y, { vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.4 + rnd.next() * 0.7, size: 1.6 + rnd.next() * 2.4, color: rnd.chance(0.5) ? '#ffb347' : '#ffe9b0', drag: 1.6, grav: 140 });
  }
  for (let i = 0; i < 22; i += 1) {
    const a = rnd.angle();
    const sp = 20 + rnd.next() * 90;
    particles.spawn('smoke', x + Math.cos(a) * 8, y + Math.sin(a) * 8, {
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp - 20,
      life: 1.2 + rnd.next() * 1.6,
      size: 12 + rnd.next() * 14,
      grow: 30,
      color: rnd.chance(0.4) ? '#5a5148' : '#8c8272',
      alpha: 0.4,
      drag: 1.1,
    });
  }
  for (let i = 0; i < 8; i += 1) {
    const a = rnd.angle();
    particles.spawn('debris', x, y, { vx: Math.cos(a) * (60 + rnd.next() * 160), vy: Math.sin(a) * (60 + rnd.next() * 160) - 60, life: 0.9 + rnd.next(), size: 2 + rnd.next() * 3, color: '#3a3a3a', drag: 1.2, grav: 320, spin: rnd.range(-8, 8) });
  }
  particles.spawn('ring', x, y, { life: 0.5, size: 8, grow: 210, color: '#ffd9a0', alpha: 0.5, drag: 0 });
}

/** Blood spray on a hit. */
export function bloodSpray(particles, x, y, angle, count, rnd) {
  for (let i = 0; i < count; i += 1) {
    const a = angle + (rnd.next() - 0.5) * 1.5;
    const sp = 40 + rnd.next() * 120;
    particles.spawn('blood', x, y, { vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.3 + rnd.next() * 0.3, size: 1.6 + rnd.next() * 2, color: '#8f2b26', drag: 2.2, grav: 160 });
  }
}

/** A water splash for the pier and the shoreline. */
export function splash(particles, x, y, rnd) {
  for (let i = 0; i < 10; i += 1) {
    particles.spawn('splash', x, y, { vx: (rnd.next() - 0.5) * 50, vy: -40 - rnd.next() * 70, life: 0.4 + rnd.next() * 0.4, size: 2, color: '#dff4ef', drag: 1.4, grav: 260 });
  }
}
