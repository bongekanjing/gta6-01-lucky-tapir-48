// A small seeded generator (mulberry32): every run from the same seed builds the same city, the
// same traffic and the same screenshot. A stream is an object of small helpers over one 32-bit
// state, so callers read as `rnd.range(2, 5)` instead of juggling a bare function. The world keeps
// one stream and the renderer another, so a dropped frame never changes the simulation.

/**
 * A seeded stream. `next()` is the raw generator; the rest are conveniences over it.
 * Splitting (`fork()`) gives an independent stream so decoration never shifts world layout.
 */
export function createRandom(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    /** A float in [low, high). */
    range: (low, high) => low + next() * (high - low),
    /** A whole number in [low, high]. */
    int: (low, high) => Math.floor(low + next() * (high - low + 1)),
    /** true with probability p. */
    chance: (p) => next() < p,
    /** One element of a non-empty array. */
    pick: (list) => list[Math.floor(next() * list.length)],
    /** A direction in radians. */
    angle: () => next() * Math.PI * 2,
    /** A shuffled copy of list (the original is left alone). */
    shuffle(list) {
      const out = list.slice();
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        const t = out[i];
        out[i] = out[j];
        out[j] = t;
      }
      return out;
    },
    /** An independent stream derived from this one. */
    fork: () => createRandom((next() * 4294967296) >>> 0),
  };
}
