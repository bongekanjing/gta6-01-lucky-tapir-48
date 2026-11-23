// The city of Solara: a seeded, hand-tuned grid of blocks and boulevards on a coastal bay.
// This module only builds data and answers spatial questions (what is solid, what is water, which
// district is here); nothing here draws or moves. Traffic, peds, police and the renderer read it.
//
// Layout: eleven avenues run north-south, nine boulevards run east-west, 400 apart, so every
// block is 280 across with a 16-wide sidewalk ring. West of the first avenue is the beach and the
// bay; the pier reaches into it. Districts come from a designed map, not noise, so the skyline, the
// palms and the shipping cranes sit where a real city would put them.

import { CITY_H, CITY_W, COLS, DISTRICTS, GRID, ROAD_HALF, ROWS, SHORE_X, WALK_W, WORLD, PARK_LANE } from './config.js';
import { createRandom } from './random.js';

/** The block grid's district map, row by row from the north: the city's shape in one glance. */
const DISTRICT_MAP = [
  ['beach', 'marina', 'marina', 'marina', 'marina', 'gardens', 'gardens', 'gardens', 'gardens', 'gardens'],
  ['beach', 'marina', 'marina', 'downtown', 'downtown', 'downtown', 'gardens', 'gardens', 'gardens', 'gardens'],
  ['beach', 'beach', 'marina', 'downtown', 'downtown', 'downtown', 'downtown', 'gardens', 'gardens', 'gardens'],
  ['beach', 'beach', 'oldtown', 'downtown', 'downtown', 'downtown', 'downtown', 'gardens', 'gardens', 'gardens'],
  ['beach', 'oldtown', 'oldtown', 'oldtown', 'downtown', 'downtown', 'marina', 'marina', 'gardens', 'gardens'],
  ['beach', 'oldtown', 'oldtown', 'oldtown', 'marina', 'marina', 'marina', 'marina', 'gardens', 'gardens'],
  ['docks', 'docks', 'docks', 'docks', 'docks', 'docks', 'docks', 'docks', 'docks', 'docks'],
  ['docks', 'docks', 'docks', 'docks', 'docks', 'docks', 'docks', 'docks', 'docks', 'docks'],
];

/** Facade colours by district: sun-bleached stucco, glass towers, container-town greys. */
const FACADES = {
  beach: ['#f6e6c9', '#f0d3ae', '#e9ddc4', '#f3d9bd', '#e2e6cf', '#f7e3d0'],
  marina: ['#efe0c9', '#ddcbb2', '#cfdcd4', '#edd3b7', '#f3e7d3', '#d8c9b4'],
  downtown: ['#d3d8db', '#bcc6cd', '#ddd4c8', '#adbbc4', '#e3dbce', '#c7bbad', '#9fadb8'],
  oldtown: ['#dca679', '#cd9068', '#e4b78e', '#bf7d5e', '#eacaa3', '#d49a6d'],
  docks: ['#aab3a8', '#97a19b', '#b8b5a6', '#929d95', '#c4bba6'],
  gardens: ['#e9e2cc', '#d7dfc5', '#f1e8d5', '#ccd8c0', '#e4dcc6'],
};

/** How tall a district's blocks are, how they split, and what their roofs look like. */
const SCALE = {
  beach: { hMin: 16, hMax: 34, split: 3, lots: [2, 3, 4], roof: 'tile' },
  marina: { hMin: 22, hMax: 62, split: 2, lots: [2, 3], roof: 'parapet' },
  downtown: { hMin: 74, hMax: 215, split: 1, lots: [1, 2], roof: 'tower' },
  oldtown: { hMin: 28, hMax: 66, split: 2, lots: [2, 3], roof: 'parapet' },
  docks: { hMin: 26, hMax: 52, split: 1, lots: [1, 2], roof: 'warehouse' },
  gardens: { hMin: 20, hMax: 56, split: 2, lots: [2, 3], roof: 'parapet' },
};

const SIDEWALK = ROAD_HALF + WALK_W;
const BLOCK = GRID - SIDEWALK * 2;

/** A solid rectangle the player and cars cannot pass through. */
const makeSolid = (x, y, w, h, kind) => ({ x, y, w, h, kind });

/** A block's perimeter path, the loop its pedestrians walk, inset from the sidewalk edge. */
function perimeterOf(block) {
  const pad = 7;
  const x0 = block.x + pad;
  const y0 = block.y + pad;
  const x1 = block.x + block.w - pad;
  const y1 = block.y + block.h - pad;
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

/** Split a lot into 1-4 building plots by one or two cuts. */
function splitLot(rnd, lot, maxLots) {
  if (maxLots <= 1) return [lot];
  const vertical = rnd.chance(0.5 + (lot.w > lot.h ? 0.4 : -0.4));
  const t = rnd.range(0.38, 0.63);
  if (vertical) {
    const cut = lot.x + lot.w * t;
    const a = { x: lot.x, y: lot.y, w: cut - lot.x - 5, h: lot.h };
    const b = { x: cut + 5, y: lot.y, w: lot.x + lot.w - cut - 5, h: lot.h };
    return maxLots >= 4 ? [...splitLot(rnd, a, 2), ...splitLot(rnd, b, 2)] : [a, b];
  }
  const cut = lot.y + lot.h * t;
  const a = { x: lot.x, y: lot.y, w: lot.w, h: cut - lot.y - 5 };
  const b = { x: lot.x, y: cut + 5, w: lot.w, h: lot.y + lot.h - cut - 5 };
  return maxLots >= 4 ? [...splitLot(rnd, a, 2), ...splitLot(rnd, b, 2)] : [a, b];
}

/** One building: footprint, height, facade, and the details the renderer needs. */
function makeBuilding(rnd, rect, district, scale, index) {
  const taller = rnd.chance(0.28) ? 1.35 : 1;
  const setback = scale.roof === 'tower' ? rnd.range(0.06, 0.16) : 0;
  const height = Math.round(rnd.range(scale.hMin, scale.hMax) * taller);
  const facade = rnd.pick(FACADES[district]);
  const building = {
    x: rect.x,
    y: rect.y,
    w: rect.w,
    h: rect.h,
    height,
    facade,
    roof: scale.roof,
    district,
    index,
    setback: setback > 0 ? { x: rect.x + rect.w * setback, y: rect.y + rect.h * setback, w: rect.w * (1 - setback * 2), h: rect.h * (1 - setback * 2) } : null,
    crown: height > 150 && rnd.chance(0.7),
    windowPitch: rnd.range(11, 15),
    windowW: rnd.range(3.5, 6),
    awning: height < 46 && rnd.chance(0.55) ? rnd.pick(['#c9553f', '#3f7a6a', '#c9a33a', '#496b93', '#a05a76']) : null,
    roofBits: [],
    sign: null,
  };
  const bits = rnd.int(0, 3);
  for (let i = 0; i < bits; i += 1) {
    const bw = rnd.range(6, 16);
    building.roofBits.push({
      x: rect.x + rnd.range(6, Math.max(7, rect.w - bw - 6)),
      y: rect.y + rnd.range(6, Math.max(7, rect.h - bw - 6)),
      w: bw,
      h: rnd.range(6, 13),
      kind: rnd.chance(0.4) ? 'tank' : 'ac',
    });
  }
  if (height < 60 && rnd.chance(0.35)) {
    building.sign = {
      text: rnd.pick(['HOTEL', 'BAR', 'CAFE', 'MOTEL', 'TACOS', 'AUTO', 'LIQUOR', 'SURF', 'PHARMACY', 'DINER']),
      color: rnd.pick(['#e4544a', '#3f8f8f', '#e0a33a', '#4a6f9c', '#8a5a8f']),
      side: rnd.chance(0.5) ? 's' : 'w',
    };
  }
  return building;
}

/** A park block: lawn, paths, trees and a fountain or bandstand. */
function makePark(rnd, block) {
  const cx = block.x + block.w / 2;
  const cy = block.y + block.h / 2;
  const trees = [];
  const count = rnd.int(5, 9);
  for (let i = 0; i < count; i += 1) {
    const side = rnd.int(0, 3);
    const t = rnd.range(0.1, 0.9);
    let x;
    let y;
    if (side === 0) [x, y] = [block.x + block.w * t, block.y + rnd.range(14, 40)];
    else if (side === 1) [x, y] = [block.x + block.w * t, block.y + block.h - rnd.range(14, 40)];
    else if (side === 2) [x, y] = [block.x + rnd.range(14, 40), block.y + block.h * t];
    else [x, y] = [block.x + block.w - rnd.range(14, 40), block.y + block.h * t];
    trees.push({ x, y, size: rnd.range(0.8, 1.25), tone: rnd.int(0, 2) });
  }
  return {
    fountain: rnd.chance(0.6) ? { x: cx, y: cy, r: rnd.range(17, 24) } : null,
    bandstand: rnd.chance(0.25) ? { x: cx + 40, y: cy - 30, r: 16 } : null,
    trees,
    path: rnd.chance(0.7),
  };
}

/** A parking lot: painted bays; parked cars come from vehicles.js. */
function makeLot(rnd, block) {
  const cols = rnd.int(3, 5);
  const rows = rnd.int(2, 3);
  const bays = [];
  const bw = 26;
  const bh = 46;
  const startX = block.x + (block.w - cols * bw) / 2;
  const startY = block.y + (block.h - rows * bh) / 2;
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      bays.push({ x: startX + c * bw, y: startY + r * bh, w: bw, h: bh, row: r, col: c });
    }
  }
  return { bays };
}

/**
 * Build the city. The returned object is plain data plus a few queries:
 *   blocks, buildings, solids, palms, props, piers, water, nodes, poi, spawn
 */
export function createCity(seed) {
  const rnd = createRandom(seed ^ 0x5f3759df);
  const blocks = [];
  const buildings = [];
  const solids = [];
  const palms = [];
  const props = [];
  const piers = [];
  const water = [];

  // Open water west of the shore; the pier crosses it.
  water.push({ x: WORLD.x0 - 400, y: WORLD.y0 - 400, w: SHORE_X - (WORLD.x0 - 400), h: WORLD.y1 - WORLD.y0 + 800, kind: 'sea' });

  // ---------------------------------------------------------------- blocks
  let buildingIndex = 0;
  for (let j = 0; j < ROWS - 1; j += 1) {
    for (let i = 0; i < COLS - 1; i += 1) {
      const district = DISTRICT_MAP[j][i];
      const scale = SCALE[district];
      const x = i * GRID + SIDEWALK;
      const y = j * GRID + SIDEWALK;
      const block = {
        i,
        j,
        x,
        y,
        w: BLOCK,
        h: BLOCK,
        district,
        name: DISTRICTS[district].name,
        buildings: [],
        kind: 'buildings',
        props: [],
        palms: [],
        perimeter: null,
        park: null,
        lot: null,
      };

      // A deliberate mix: parks and lots are rare downtown, common in the gardens and docks.
      const roll = rnd.next();
      const parkChance = district === 'gardens' ? 0.3 : district === 'beach' ? 0.12 : district === 'downtown' ? 0.06 : 0.14;
      const lotChance = district === 'docks' ? 0.32 : district === 'downtown' ? 0.04 : 0.12;

      if (roll < parkChance) {
        block.kind = 'park';
        block.park = makePark(rnd, block);
        if (rnd.chance(0.5)) {
          const pw = 58;
          const ph = 40;
          const px = block.x + block.w - pw - 18;
          const py = block.y + 18;
          const b = makeBuilding(rnd, { x: px, y: py, w: pw, h: ph }, district, { ...scale, hMin: 12, hMax: 18, roof: 'parapet' }, buildingIndex++);
          b.pavilion = true;
          block.buildings.push(b);
          buildings.push(b);
          solids.push(makeSolid(b.x, b.y, b.w, b.h, 'building'));
        }
      } else if (roll < parkChance + lotChance) {
        block.kind = 'lot';
        block.lot = makeLot(rnd, block);
      } else {
        const inset = rnd.range(8, 16);
        const lot = { x: block.x + inset, y: block.y + inset, w: block.w - inset * 2, h: block.h - inset * 2 };
        const lots = scale.roof === 'warehouse' ? [lot] : splitLot(rnd, lot, rnd.pick(scale.lots));
        for (const rect of lots) {
          const shrink = scale.roof === 'tile' ? 0.82 : scale.roof === 'warehouse' ? 0.94 : 0.9;
          const w = Math.max(34, rect.w * shrink);
          const h = Math.max(34, rect.h * shrink);
          const b = makeBuilding(rnd, { x: rect.x + (rect.w - w) / 2, y: rect.y + (rect.h - h) / 2, w, h }, district, scale, buildingIndex++);
          block.buildings.push(b);
          buildings.push(b);
          solids.push(makeSolid(b.x, b.y, b.w, b.h, 'building'));
        }
      }

      // Street furniture around the sidewalk ring.
      for (const side of ['n', 's', 'w', 'e']) {
        const horizontal = side === 'n' || side === 's';
        const along = horizontal ? block.w : block.h;
        const count = Math.max(1, Math.round(along / 130));
        for (let k = 0; k < count; k += 1) {
          const t = (k + 0.5) / count + rnd.range(-0.06, 0.06);
          let px;
          let py;
          if (side === 'n') [px, py] = [block.x + along * t, block.y - 9];
          else if (side === 's') [px, py] = [block.x + along * t, block.y + block.h + 9];
          else if (side === 'w') [px, py] = [block.x - 9, block.y + along * t];
          else [px, py] = [block.x + block.w + 9, block.y + along * t];
          const r = rnd.next();
          if (r < 0.45) props.push({ kind: 'lamp', x: px, y: py, side });
          else if (r < 0.7) props.push({ kind: 'bench', x: px, y: py, side });
          else if (r < 0.85) props.push({ kind: 'bin', x: px, y: py, side });
        }
        // Awnings against the buildings' street side.
        for (const b of block.buildings) {
          if (!b.awning) continue;
          if (side === 'n' && Math.abs(b.y - (block.y + 10)) < 30) props.push({ kind: 'awning', x: b.x + 6, y: b.y - 7, w: b.w - 12, side, color: b.awning });
          if (side === 'w' && Math.abs(b.x - (block.x + 10)) < 30) props.push({ kind: 'awning', x: b.x - 7, y: b.y + 6, h: b.h - 12, side, color: b.awning });
        }
      }

      // Palms: on the beach side of the west blocks, in parks, and sparingly elsewhere.
      const palmChance = district === 'beach' ? 0.75 : district === 'gardens' ? 0.5 : district === 'marina' ? 0.4 : 0.16;
      if (rnd.chance(palmChance)) {
        const n = rnd.int(1, district === 'beach' ? 3 : 2);
        for (let k = 0; k < n; k += 1) {
          const onWest = i === 0 && rnd.chance(0.7);
          const px = onWest ? block.x - rnd.range(20, 34) : block.x + rnd.range(20, block.w - 20);
          const py = block.y + rnd.range(14, block.h - 14);
          palms.push({ x: px, y: py, size: rnd.range(0.85, 1.3), phase: rnd.range(0, 6.28), lean: rnd.range(-0.25, 0.25) });
        }
      }

      block.perimeter = perimeterOf(block);
      blocks.push(block);
    }
  }

  // ---------------------------------------------------------------- the beach, pier and promenade
  for (let i = 0; i < 46; i += 1) {
    palms.push({
      x: rnd.range(SHORE_X + 12, -70),
      y: rnd.range(WORLD.y0 + 60, WORLD.y1 - 60),
      size: rnd.range(0.9, 1.45),
      phase: rnd.range(0, 6.28),
      lean: rnd.range(-0.35, 0.1),
      beach: true,
    });
  }
  for (let i = 0; i < 26; i += 1) {
    props.push({
      kind: 'umbrella',
      x: rnd.range(SHORE_X + 22, -80),
      y: rnd.range(WORLD.y0 + 120, WORLD.y1 - 120),
      color: rnd.pick(['#e4544a', '#f0b73f', '#3f8f8f', '#e0793f', '#f2e6cc', '#8a5a8f']),
      phase: rnd.range(0, 6.28),
    });
  }
  for (let i = 0; i < 34; i += 1) {
    props.push({
      kind: 'towel',
      x: rnd.range(SHORE_X + 30, -86),
      y: rnd.range(WORLD.y0 + 140, WORLD.y1 - 140),
      color: rnd.pick(['#e4544a', '#3f8f8f', '#f0b73f', '#f2e6cc']),
      rot: rnd.range(-0.4, 0.4),
    });
  }
  props.push({ kind: 'lifeguard', x: SHORE_X + 52, y: 1180, w: 26, h: 30 });

  // The pier: planks out over the water with a T-head at the end.
  const pierY = CITY_H * 0.5 + 60;
  const pierLen = 250;
  piers.push({ x: SHORE_X - pierLen, y: pierY, w: pierLen + 24, h: 64, kind: 'deck' });
  piers.push({ x: SHORE_X - pierLen - 40, y: pierY - 40, w: 96, h: 144, kind: 'deck' });
  for (let i = 0; i < 9; i += 1) {
    props.push({ kind: 'pierpost', x: SHORE_X - 18 - i * 28, y: pierY - 4 });
    props.push({ kind: 'pierpost', x: SHORE_X - 18 - i * 28, y: pierY + 66 });
  }
  props.push({ kind: 'pierlamp', x: SHORE_X - 40, y: pierY - 2 });
  props.push({ kind: 'pierlamp', x: SHORE_X - 40, y: pierY + 66 });
  props.push({ kind: 'boat', x: SHORE_X - 210, y: pierY + 96, angle: 0.05, color: '#e9e2cf', size: 1 });
  props.push({ kind: 'boat', x: SHORE_X - 150, y: pierY - 58, angle: -0.08, color: '#4a7f9c', size: 0.8 });

  for (let y = 40; y < CITY_H; y += 118) {
    palms.push({ x: -58, y, size: 1.1, phase: rnd.range(0, 6.28), lean: 0.12 });
  }
  props.push({ kind: 'seawall', x: SHORE_X, y: WORLD.y0, w: 10, h: WORLD.y1 - WORLD.y0 });

  // ---------------------------------------------------------------- road graph nodes
  const nodes = new Map();
  const key = (i, j) => `${i},${j}`;
  for (let j = 0; j < ROWS; j += 1) {
    for (let i = 0; i < COLS; i += 1) {
      nodes.set(key(i, j), { i, j, x: i * GRID, y: j * GRID, links: [] });
    }
  }
  for (let j = 0; j < ROWS; j += 1) {
    for (let i = 0; i < COLS; i += 1) {
      const a = nodes.get(key(i, j));
      if (i + 1 < COLS) {
        a.links.push({ to: key(i + 1, j), dir: 'E', dist: GRID });
        nodes.get(key(i + 1, j)).links.push({ to: key(i, j), dir: 'W', dist: GRID });
      }
      if (j + 1 < ROWS) {
        a.links.push({ to: key(i, j + 1), dir: 'S', dist: GRID });
        nodes.get(key(i, j + 1)).links.push({ to: key(i, j), dir: 'N', dist: GRID });
      }
    }
  }

  // ---------------------------------------------------------------- collision hash
  const CELL = 200;
  const hash = new Map();
  const hashKey = (cx, cy) => (cx * 73856093) ^ (cy * 19349663);
  for (const s of solids) {
    const x0 = Math.floor((s.x - 4) / CELL);
    const x1 = Math.floor((s.x + s.w + 4) / CELL);
    const y0 = Math.floor((s.y - 4) / CELL);
    const y1 = Math.floor((s.y + s.h + 4) / CELL);
    for (let cx = x0; cx <= x1; cx += 1) {
      for (let cy = y0; cy <= y1; cy += 1) {
        const k = hashKey(cx, cy);
        const list = hash.get(k);
        if (list) list.push(s);
        else hash.set(k, [s]);
      }
    }
  }

  const city = {
    seed,
    cols: COLS,
    rows: ROWS,
    grid: GRID,
    width: CITY_W,
    height: CITY_H,
    shoreX: SHORE_X,
    bounds: WORLD,
    blocks,
    buildings,
    solids,
    palms,
    props,
    piers,
    water,
    nodes,
    nodeKey: key,
    /** Solid rects near a point, from the spatial hash. */
    solidsNear(x, y, r = 140) {
      const out = [];
      const seen = new Set();
      const cx0 = Math.floor((x - r) / CELL);
      const cx1 = Math.floor((x + r) / CELL);
      const cy0 = Math.floor((y - r) / CELL);
      const cy1 = Math.floor((y + r) / CELL);
      for (let cx = cx0; cx <= cx1; cx += 1) {
        for (let cy = cy0; cy <= cy1; cy += 1) {
          const list = hash.get(hashKey(cx, cy));
          if (!list) continue;
          for (const s of list) {
            if (seen.has(s)) continue;
            seen.add(s);
            out.push(s);
          }
        }
      }
      return out;
    },
    /** Whether a point is open water (the pier is not). */
    isWater(x, y) {
      if (x >= SHORE_X) return false;
      for (const p of piers) {
        if (x > p.x - 6 && x < p.x + p.w + 6 && y > p.y - 6 && y < p.y + p.h + 6) return false;
      }
      return true;
    },
    isSand(x, y) {
      return x < ROAD_HALF && x >= SHORE_X;
    },
    /** The district name at a world point, for the HUD. */
    districtAt(x, y) {
      const i = Math.max(0, Math.min(COLS - 2, Math.floor((x - SIDEWALK) / GRID)));
      const j = Math.max(0, Math.min(ROWS - 2, Math.floor((y - SIDEWALK) / GRID)));
      return DISTRICTS[DISTRICT_MAP[j][i]].name;
    },
    /** Whether a point is on a road surface (engine notes, tyre smoke, police routes). */
    onRoad(x, y) {
      const rx = Math.abs(x - Math.round(x / GRID) * GRID);
      const ry = Math.abs(y - Math.round(y / GRID) * GRID);
      return rx <= ROAD_HALF || ry <= ROAD_HALF;
    },
    inCity(x, y) {
      return x > -ROAD_HALF && x < CITY_W + ROAD_HALF && y > -ROAD_HALF && y < CITY_H + ROAD_HALF;
    },
    parkLane: PARK_LANE,
  };

  // ---------------------------------------------------------------- named places
  const blockCenter = (i, j) => {
    const b = blocks.find((bl) => bl.i === i && bl.j === j);
    return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  };
  const garage = blockCenter(2, 4);
  const police = blockCenter(5, 3);
  const hospital = blockCenter(7, 2);
  const hotel = blockCenter(4, 2);
  const marina = blockCenter(6, 4);
  const docks = blockCenter(3, 7);
  const tower = blockCenter(5, 4);
  const pierHead = { x: SHORE_X - pierLen - 4, y: pierY + 32 };
  const beachSpot = { x: SHORE_X + 70, y: CITY_H * 0.5 - 120 };

  city.poi = {
    safehouse: { ...garage, name: "Rico's Garage" },
    police: { ...police, name: 'Solara PD' },
    hospital: { ...hospital, name: 'Bayview General' },
    hotel: { ...hotel, name: 'Hotel Mirador' },
    marina: { ...marina, name: 'Coral Marina' },
    docks: { ...docks, name: 'Pier Nine' },
    tower: { ...tower, name: 'Vantage Tower' },
    pier: pierHead,
    beach: beachSpot,
  };

  city.spawn = { x: garage.x - 108, y: garage.y + 44, angle: -0.4 };
  const gb = blocks.find((bl) => bl.i === 2 && bl.j === 4);
  city.safehouseLot = { x: gb.x + 10, y: gb.y + gb.h - 66, w: gb.w - 20, h: 56 };

  return city;
}
