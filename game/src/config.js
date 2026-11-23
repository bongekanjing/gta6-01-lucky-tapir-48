// Every tuning number, colour and name in one place: the game reads its feel from here, so a
// balance pass is a single file, and the renderer and HUD share one palette instead of inventing
// their own. Logical resolution is fixed at 1280x720; the canvas is scaled to the window.

export const VIEW = { w: 1280, h: 720 };
/** Logical seconds per simulation step: the world advances in fixed steps, never in frame time. */
export const STEP = 1 / 60;
export const MAX_FRAME = 0.2;

// ---------------------------------------------------------------- the city grid
/** Distance between two parallel road centre lines. */
export const GRID = 400;
/** Half the asphalt: the road is 88 units wide, two lanes plus a parking shoulder. */
export const ROAD_HALF = 44;
/** Width of the paved sidewalk ring around every block. */
export const WALK_W = 16;
/** Where traffic drives, from the road centre line. */
export const LANE = 22;
/** Where parked cars sit, just inside the curb. */
export const PARK_LANE = 33;
export const COLS = 11;
export const ROWS = 9;
export const CITY_W = (COLS - 1) * GRID;
export const CITY_H = (ROWS - 1) * GRID;
/** The ocean starts west of this and the beach runs from the seawall to the boulevard. */
export const SHORE_X = -60;
export const BEACH_X = -150;
export const WORLD = { x0: -260, y0: -260, x1: CITY_W + 260, y1: CITY_H + 260 };

export const DISTRICTS = {
  marina: { name: 'Marina Flats', tint: '#e8c9a0' },
  beach: { name: 'Palm Strand', tint: '#f0d9ad' },
  downtown: { name: 'Solara Heights', tint: '#d9c3ad' },
  docks: { name: 'Coral Docks', tint: '#c9b9a4' },
  oldtown: { name: 'Old Vega', tint: '#e3b493' },
  gardens: { name: 'Tidewater', tint: '#cfd8ae' },
};

/** The city's mood: a warm late afternoon, sun low in the east-south-east. */
export const LIGHT = {
  sunX: 0.71,
  sunY: 0.33,
  shadowX: -0.58,
  shadowY: 0.72,
};

export const PALETTE = {
  asphalt: '#3b3b45',
  asphaltLight: '#474753',
  asphaltWorn: '#33333c',
  asphaltLine: '#e7ddc6',
  walk: '#cbbd9f',
  walkEdge: '#ab9a7d',
  curb: '#94866d',
  grass: '#7f9754',
  grassDark: '#65803f',
  sand: '#e4ca97',
  sandWet: '#c9aa79',
  oceanDeep: '#155a72',
  oceanMid: '#1d7d92',
  oceanShallow: '#43bcba',
  foam: '#eaf6ef',
  ink: '#1b1b22',
  paper: '#f7f1e3',
  gold: '#f0b73f',
  goldDeep: '#c98a17',
  blood: '#b53a34',
  hudRed: '#e4544a',
  hudGreen: '#8ed16a',
  glass: '#7fb7c4',
  roof: '#8d7f74',
};

export const PLAYER = {
  radius: 11,
  walkSpeed: 172,
  sprintSpeed: 296,
  accel: 1500,
  friction: 12,
  maxHealth: 100,
  maxArmour: 100,
  invulnAfterHit: 0.5,
  enterRange: 74,
  punchRange: 48,
  punchCooldown: 0.4,
  punchDamage: 15,
  respawnTime: 2.8,
};

export const WEAPONS = {
  fists: { name: 'Fists', ammo: Infinity, damage: PLAYER.punchDamage, rate: 0.4, spread: 0, range: 50, melee: true, sound: 'punch' },
  pistol: { name: 'Pistol', ammo: 12, maxAmmo: 108, damage: 26, rate: 0.2, spread: 0.035, range: 640, speed: 1550, sound: 'pistol' },
  smg: { name: 'SMG', ammo: 30, maxAmmo: 210, damage: 15, rate: 0.08, spread: 0.075, range: 540, speed: 1450, sound: 'smg' },
};

export const CAR = {
  length: 46,
  width: 23,
  radius: 25,
  accel: 340,
  reverseAccel: 210,
  brake: 800,
  drag: 0.6,
  maxSpeed: 440,
  maxReverse: 150,
  turn: 2.6,
  grip: 6.4,
  driftGrip: 1.2,
  handbrakeDrag: 2.4,
  health: 280,
};

/** The models on the street: name, body colour and a couple of proportions. */
export const CAR_MODELS = [
  { name: 'Corsa', body: '#d8583f', len: 0.94, wid: 0.96, roof: '#a83f2d', kind: 'coupe' },
  { name: 'Tide', body: '#e8dcc2', len: 1.02, wid: 1.02, roof: '#c9bda1', kind: 'sedan' },
  { name: 'Marabella', body: '#3a6f8f', len: 1.06, wid: 1.04, roof: '#2b546c', kind: 'sedan' },
  { name: 'Lanterna', body: '#c9a33a', len: 0.98, wid: 0.98, roof: '#a0822a', kind: 'coupe' },
  { name: 'Mako', body: '#3f8f74', len: 1.0, wid: 1.0, roof: '#2f6f5a', kind: 'sedan' },
  { name: 'Vanta', body: '#26262e', len: 0.92, wid: 0.94, roof: '#17171d', kind: 'coupe' },
  { name: 'Pescador', body: '#8a7fa8', len: 1.0, wid: 1.0, roof: '#6a6085', kind: 'sedan' },
  { name: 'Verano', body: '#e0793f', len: 0.96, wid: 0.98, roof: '#b95f2f', kind: 'coupe' },
  { name: 'Cormorant', body: '#6d8a54', len: 1.1, wid: 1.05, roof: '#55703f', kind: 'truck' },
  { name: 'Kingfisher', body: '#bfc7cc', len: 1.04, wid: 1.0, roof: '#9aa3a8', kind: 'sedan' },
];

export const POLICE = {
  carBody: '#eceadf',
  carStripe: '#26355f',
  carAccent: '#c8342e',
  officerHealth: 72,
  officerDamage: 9,
  officerRange: 430,
  officerRate: 0.7,
  carHealth: 360,
};

/** How much heat each crime adds, and what the levels are called. */
export const WANTED = {
  max: 5,
  decayDelay: 9,
  decayRate: 0.42,
  titles: ['Clear', 'Wanted', 'Wanted', 'Wanted', 'Most Wanted', 'City Lockdown'],
  spawnDelay: 1.8,
};

export const SAVE_KEY = 'solaravice.save.v1';
export const GAME_TITLE = 'SOLARA VICE';
export const GAME_SUBTITLE = 'a sun-bleached city, one bad afternoon';

/** Mission tuning: how close counts as arrival, and the rhythm of job offers at the garage. */
export const MISSIONS = {
  reach: 34,
  offerCooldown: 8,
  sidePayouts: { delivery: 520, race: 1400, hit: 1100 },
};
