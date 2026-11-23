// The road network: directions, lane geometry, corner arcs, A* over the intersections, and the
// pure-pursuit follower every driver uses. Traffic, the police and the screenshot autopilot all
// steer with the same code, so a police car corners exactly like a taxi.
//
// Right-hand traffic throughout: driving east you keep to +y, driving south you keep to -x.

import { GRID, LANE, ROAD_HALF } from './config.js';
import { angleDiff, clamp, wrapAngle } from './util.js';

export const DIRS = {
  E: { x: 1, y: 0, angle: 0 },
  W: { x: -1, y: 0, angle: Math.PI },
  S: { x: 0, y: 1, angle: Math.PI / 2 },
  N: { x: 0, y: -1, angle: -Math.PI / 2 },
};
export const DIR_LIST = ['E', 'W', 'S', 'N'];
export const opposite = (d) => (d === 'E' ? 'W' : d === 'W' ? 'E' : d === 'S' ? 'N' : 'S');

/** The lane's centre offset from the road's centre line, for a direction of travel. */
export function laneOffset(dir) {
  switch (dir) {
    case 'E':
      return { x: 0, y: LANE };
    case 'W':
      return { x: 0, y: -LANE };
    case 'S':
      return { x: -LANE, y: 0 };
    default:
      return { x: LANE, y: 0 };
  }
}

/** The lane centre for a car driving `dir` along a road that passes through `node`. */
export function lanePoint(node, dir) {
  const o = laneOffset(dir);
  return { x: node.x + o.x, y: node.y + o.y };
}

/**
 * Where an incoming lane and an outgoing lane cross: the corner a turning car rounds. Both are
 * axis-aligned, so the corner is simply their perpendicular intersection.
 */
function laneCorner(nodeA, nodeB, inDir, outDir) {
  const a = DIRS[inDir];
  const A = lanePoint(nodeA, inDir);
  const B = lanePoint(nodeB, outDir);
  // Inbound horizontal: its line is y = A.y, so the corner shares that y and the outbound x.
  if (a.x !== 0) return { x: B.x, y: A.y };
  return { x: A.x, y: B.y };
}

/**
 * The path a car takes from one intersection to the next, entering along `inDir` and leaving along
 * `outDir`. Straight through: three points. A turn: a quadratic arc that is tangent to both lanes,
 * rounded at the corner. `radius` is how far before the corner the arc starts.
 */
export function turnPath(nodeA, nodeB, inDir, outDir, radius = 30) {
  const a = DIRS[inDir];
  const b = DIRS[outDir];
  const len = Math.abs(nodeB.x - nodeA.x) + Math.abs(nodeB.y - nodeA.y);
  const start = lanePoint(nodeA, inDir);
  const end = lanePoint(nodeB, outDir);
  const after = { x: end.x + b.x * 30, y: end.y + b.y * 30 };
  if (inDir === outDir) return { points: [start, end, after], length: len };

  const corner = laneCorner(nodeA, nodeB, inDir, outDir);
  const r = Math.min(radius, Math.abs(corner.x - start.x) * 0.8 + 1, Math.abs(corner.y - start.y) * 0.8 + 1);
  const p0 = { x: corner.x - a.x * r, y: corner.y - a.y * r };
  const p2 = { x: corner.x + b.x * r, y: corner.y + b.y * r };
  const pts = [start];
  // Quadratic Bezier p0 -> corner -> p2, sampled; the control point is the corner itself.
  const steps = 8;
  pts.push(p0);
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const u = 1 - t;
    pts.push({
      x: u * u * p0.x + 2 * u * t * corner.x + t * t * p2.x,
      y: u * u * p0.y + 2 * u * t * corner.y + t * t * p2.y,
    });
  }
  pts.push(end, after);
  return { points: pts, length: len };
}

/** Straight lane segment between two intersections, no turning. */
export function straightPath(nodeA, nodeB, dir) {
  const p0 = lanePoint(nodeA, dir);
  const p1 = lanePoint(nodeB, dir);
  const ext = DIRS[dir];
  return {
    points: [p0, p1, { x: p1.x + ext.x * 26, y: p1.y + ext.y * 26 }],
    length: Math.abs(nodeB.x - nodeA.x) + Math.abs(nodeB.y - nodeA.y),
  };
}

// ---------------------------------------------------------------- the follower

/**
 * A path a driver follows: points, cumulative lengths, and the speed limit per stretch.
 * `advance` never leaves the path; the caller decides when a path is finished.
 */
export function makePath(points, speedLimit = 260) {
  const pts = points.slice();
  const cum = [0];
  for (let i = 1; i < pts.length; i += 1) {
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  return { points: pts, cum, length: cum[cum.length - 1] ?? 0, speedLimit };
}

/** The point at distance s along a path, plus its tangent. */
export function pointAt(path, s) {
  const { points, cum } = path;
  const d = clamp(s, 0, path.length);
  if (points.length === 0) return { x: 0, y: 0, angle: 0 };
  if (points.length === 1) return { x: points[0].x, y: points[0].y, angle: 0 };
  let lo = 0;
  let hi = cum.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= d) lo = mid;
    else hi = mid;
  }
  const seg = Math.max(0.0001, cum[hi] - cum[lo]);
  const t = (d - cum[lo]) / seg;
  const a = points[lo];
  const b = points[hi];
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    angle: Math.atan2(b.y - a.y, b.x - a.x),
    index: lo,
  };
}

/** The point on the path nearest a world position: `{ s, dist, angle }`. */
export function nearestOnPath(path, x, y) {
  const { points, cum } = path;
  let best = { s: 0, dist: Infinity, angle: 0 };
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1;
    let t = ((x - a.x) * dx + (y - a.y) * dy) / len2;
    t = clamp(t, 0, 1);
    const px = a.x + dx * t;
    const py = a.y + dy * t;
    const d = Math.hypot(x - px, y - py);
    if (d < best.dist) best = { s: cum[i - 1] + t * Math.sqrt(len2), dist: d, angle: Math.atan2(dy, dx) };
  }
  return best;
}

/**
 * A pure-pursuit steering request: where the driver wants to be (a point `lookahead` ahead) and
 * how far off its own heading that is. The caller converts the angle error into steering input.
 */
export function pursuit(path, x, y, angle, lookahead = 52) {
  const near = nearestOnPath(path, x, y);
  const target = pointAt(path, near.s + lookahead + Math.min(30, Math.abs(0) * 0));
  const desired = Math.atan2(target.y - y, target.x - x);
  return { error: angleDiff(angle, desired), target, near, remaining: path.length - near.s };
}

// ---------------------------------------------------------------- A*

/** The intersection nearest a world point. */
export function nearestNodeKey(city, x, y) {
  const i = clamp(Math.round(x / GRID), 0, city.cols - 1);
  const j = clamp(Math.round(y / GRID), 0, city.rows - 1);
  return `${i},${j}`;
}

/** A* over intersections: an array of node keys from `from` to `to`, or null. */
export function findRoute(city, fromKey, toKey) {
  if (fromKey === toKey) return [fromKey];
  const open = [{ key: fromKey, f: 0 }];
  const came = new Map();
  const g = new Map([[fromKey, 0]]);
  const closed = new Set();
  const goal = city.nodes.get(toKey);
  if (!goal) return null;
  const h = (n) => Math.abs(n.i - goal.i) + Math.abs(n.j - goal.j);
  let guard = 0;
  while (open.length > 0 && guard < 5000) {
    guard += 1;
    // Small graphs; a linear scan of the open list is plenty.
    let bi = 0;
    for (let i = 1; i < open.length; i += 1) if (open[i].f < open[bi].f) bi = i;
    const cur = open.splice(bi, 1)[0];
    if (cur.key === toKey) {
      const out = [cur.key];
      let k = cur.key;
      while (came.has(k)) {
        k = came.get(k);
        out.unshift(k);
      }
      return out;
    }
    if (closed.has(cur.key)) continue;
    closed.add(cur.key);
    const node = city.nodes.get(cur.key);
    for (const link of node.links) {
      if (closed.has(link.to)) continue;
      const tentative = (g.get(cur.key) ?? 0) + link.dist;
      if (tentative < (g.get(link.to) ?? Infinity)) {
        g.set(link.to, tentative);
        came.set(link.to, cur.key);
        const n = city.nodes.get(link.to);
        open.push({ key: link.to, f: tentative + h(n) * GRID });
      }
    }
  }
  return null;
}

/**
 * A driving path from one world point to another: drive to the nearest intersection, follow the
 * A* route with proper lane offsets and corner arcs, then the final leg. Used by police pursuit,
 * mission drive objectives and the autopilot.
 */
export function routePath(city, fromX, fromY, toX, toY, speedLimit = 320) {
  const startKey = nearestNodeKey(city, fromX, fromY);
  const endKey = nearestNodeKey(city, toX, toY);
  const keys = findRoute(city, startKey, endKey);
  if (!keys) return null;
  const pts = [];
  const start = city.nodes.get(startKey);
  // From where we are to the first lane point.
  const first = keys[1] ? city.nodes.get(keys[1]) : start;
  const firstDir = keys.length > 1 ? dirBetween(start, first) : 'E';
  pts.push({ x: fromX, y: fromY });
  if (keys.length > 1) pts.push(lanePoint(start, firstDir));
  for (let i = 1; i < keys.length; i += 1) {
    const a = city.nodes.get(keys[i - 1]);
    const b = city.nodes.get(keys[i]);
    const inDir = dirBetween(a, b);
    const next = keys[i + 1] ? city.nodes.get(keys[i + 1]) : null;
    const outDir = next ? dirBetween(b, next) : inDir;
    const seg = inDir === outDir ? straightPath(a, b, inDir) : turnPath(a, b, inDir, outDir);
    for (const p of seg.points) pts.push(p);
  }
  // Final leg to the target.
  pts.push({ x: toX, y: toY });
  // Deduplicate points closer than 2 units.
  const clean = [];
  for (const p of pts) {
    const last = clean[clean.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 2) clean.push(p);
  }
  return makePath(clean, speedLimit);
}

/** The cardinal direction from node a to adjacent node b. */
export function dirBetween(a, b) {
  if (b.x > a.x) return 'E';
  if (b.x < a.x) return 'W';
  if (b.y > a.y) return 'S';
  return 'N';
}

/**
 * The next intersection a browsing car should take: mostly straight, sometimes a turn, never a
 * U-turn unless the road dead-ends. `rnd` is the world's seeded stream.
 */
export function chooseNext(city, key, lastDir, rnd) {
  const node = city.nodes.get(key);
  const options = node.links.filter((l) => l.dir !== opposite(lastDir) || node.links.length === 1);
  const list = options.length > 0 ? options : node.links;
  // Weight straight travel so traffic forms streams.
  const straight = list.filter((l) => l.dir === lastDir);
  if (straight.length > 0 && rnd.chance(0.62)) return { link: straight[0], dir: lastDir };
  const link = rnd.pick(list);
  return { link, dir: link.dir };
}

/** The path a browsing car takes for its next hop. */
export function hopPath(city, key, lastDir, rnd) {
  const choice = chooseNext(city, key, lastDir, rnd);
  const a = city.nodes.get(key);
  const b = city.nodes.get(choice.link.to);
  const inDir = DIRS[lastDir] ? lastDir : choice.dir;
  const seg = inDir === choice.dir ? straightPath(a, b, inDir) : turnPath(a, b, inDir, choice.dir);
  return { ...seg, toKey: choice.link.to, dir: choice.dir };
}

export { wrapAngle, clamp };
