// Screenshot rig for SOLARA VICE.
//
// The rig serves game/ over a loopback HTTP server, points a headless Chromium at three staged
// game URLs, and writes the JPEG each scene produces. There is no compositing or retouching: the
// page runs the game's own renderer with its autopilot for that scene, and the browser captures
// whatever is actually on the canvas.
//
// Every frame is inspected before it reaches the disk. A scene that never signals readiness, a
// capture that is blank or off-spec, or a page-level error all count as failures and the process
// exits 2 — a plausible-looking but wrong gallery is worse than a loud failure.
//
// Usage: node tools/shots.mjs [--out <dir>]

import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/root/makefun/shotenv/node_modules/playwright-core/index.mjs';

// ---------------------------------------------------------------- configuration

const PROJECT = fileURLToPath(new URL('..', import.meta.url));
const GAME_ROOT = resolve(PROJECT, 'game');

const argOut = process.argv.indexOf('--out');
const OUT_DIR = resolve(PROJECT, argOut === -1 ? 'screenshots' : process.argv[argOut + 1]);

// The browser is taken from the environment when the harness provides one, otherwise from the
// tool cache on this box.
const CHROME = process.env.MAKEFUN_CHROME || '/root/.hermes/tools/chromium-1208/chrome-linux64/chrome';

const VIEWPORT = { width: 1280, height: 720 };

// A frame must be big enough and varied enough to be a real scene rather than an empty canvas.
const MIN_BYTES = 40000;
const MIN_COLOURS = 200;

// The gate's own limits on a submitted frame.
const MAX_BYTES = 262144;
const MAX_LONG_SIDE = 1280;
const MIN_SHORT_SIDE = 480;

// The entry ships three frames; four is the competition cap. Anything else means the rig and the
// entry have drifted apart.
const ALLOWED_COUNTS = [3, 4];

/**
 * The gallery, in submission order. Chase first: it puts the most systems (driving, pursuit,
 * wanted stars, live objective) into one frame.
 *
 * `ready` is how long the scene may take to raise window.__shotReady, `settle` is the extra hold
 * once it does, so the fade-in and the HUD have finished animating before the shutter.
 */
const SHOTS = [
  { name: '1-chase.jpg', query: '?shot=chase&seed=1', ready: 30000, settle: 2200 },
  { name: '2-drive.jpg', query: '?shot=drive&seed=1', ready: 30000, settle: 1800 },
  { name: '3-mission.jpg', query: '?shot=mission&seed=1', ready: 30000, settle: 1800 },
];

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// ---------------------------------------------------------------- static server

/** A read-only file server rooted at game/, with traversal refused. */
function serveGame() {
  const server = createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://127.0.0.1');
      let rel;
      try {
        rel = decodeURIComponent(pathname);
      } catch {
        rel = pathname;
      }
      const cleaned = normalize(rel).replace(/^([/\\]|\.\.[/\\])+/, '');
      const file = join(GAME_ROOT, cleaned || 'index.html');
      if (file !== GAME_ROOT && !file.startsWith(GAME_ROOT + sep)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(server)));
}

// ---------------------------------------------------------------- frame inspection

/**
 * Decode a JPEG inside the page and sample it: the true pixel dimensions of the decoded image,
 * a mean luminance, and how many distinct 8-bit RGB triples survive a downscale.
 */
function measureFrame(page, buffer) {
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/jpeg;base64,${b64}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const g = canvas.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, canvas.width, canvas.height);
    const px = g.getImageData(0, 0, canvas.width, canvas.height).data;
    const colours = new Set();
    let luma = 0;
    for (let i = 0; i < px.length; i += 4) {
      luma += (px[i] + px[i + 1] + px[i + 2]) / 3;
      colours.add((px[i] << 16) | (px[i + 1] << 8) | px[i + 2]);
    }
    return {
      width: img.naturalWidth,
      height: img.naturalHeight,
      mean: luma / (px.length / 4),
      colours: colours.size,
    };
  }, buffer.toString('base64'));
}

/**
 * Apply every gate rule to the captured bytes, in memory, and return the measurements plus a list
 * of complaints. An empty list means the frame may be written.
 */
async function vet(page, buffer) {
  const bytes = buffer.length;
  const sample = await measureFrame(page, buffer);
  const longSide = Math.max(sample.width, sample.height);
  const shortSide = Math.min(sample.width, sample.height);
  const complaints = [];
  if (bytes < MIN_BYTES) complaints.push(`${bytes}B is under the ${MIN_BYTES}B floor`);
  if (bytes > MAX_BYTES) complaints.push(`${bytes}B is over the ${MAX_BYTES}B ceiling`);
  if (sample.colours < MIN_COLOURS) complaints.push(`only ${sample.colours} distinct colours`);
  if (longSide > MAX_LONG_SIDE) complaints.push(`long side ${longSide} exceeds ${MAX_LONG_SIDE}`);
  if (shortSide < MIN_SHORT_SIDE) complaints.push(`short side ${shortSide} below ${MIN_SHORT_SIDE}`);
  if (sample.mean <= 6) complaints.push(`frame is black (mean ${sample.mean.toFixed(1)})`);
  if (sample.mean >= 250) complaints.push(`frame is white (mean ${sample.mean.toFixed(1)})`);
  return {
    bytes,
    colours: sample.colours,
    dims: `${sample.width}x${sample.height}`,
    complaints,
  };
}

// ---------------------------------------------------------------- main

if (!existsSync(CHROME)) {
  console.error(`no chromium at ${CHROME} (set MAKEFUN_CHROME to override)`);
  process.exit(1);
}

// Nothing dot-prefixed may be produced: a marker file would be submitted as if it were a shot.
for (const shot of SHOTS) {
  if (basename(shot.name).startsWith('.')) {
    console.error(`refusing to write dot-file "${shot.name}" into ${OUT_DIR}`);
    process.exit(1);
  }
}

await mkdir(OUT_DIR, { recursive: true });

const server = await serveGame();
const origin = `http://127.0.0.1:${server.address().port}/index.html`;

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1', '--hide-scrollbars', '--disable-lcd-text'],
});
const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });

// Anything the page reports is collected; a resource 404 (a missing favicon) is the only noise we
// are willing to ignore.
const pageErrors = [];
page.on('console', (msg) => {
  if (msg.type() !== 'error') return;
  pageErrors.push(msg.text());
  console.log('PAGE ERROR:', msg.text());
});
page.on('pageerror', (err) => {
  pageErrors.push(err.message);
  console.log('PAGE EXCEPTION:', err.message);
});

const rows = [];

for (const shot of SHOTS) {
  const target = join(OUT_DIR, shot.name);
  const row = { name: shot.name, bytes: 0, colours: 0, dims: '-', ok: false };
  rows.push(row);

  if (basename(target).startsWith('.')) {
    console.log(`${shot.name}: FAILED — dot-file target refused`);
    continue;
  }

  // A stale frame from an earlier run must never stand in for this one.
  await rm(target, { force: true });

  try {
    await page.goto(`${origin}${shot.query}`, { waitUntil: 'load' });

    // The first paint can land in a zero-sized canvas while layout settles; wait for area.
    let sized = true;
    try {
      await page.waitForFunction(
        () => {
          const c = document.getElementById('screen');
          return !!c && c.width > 0 && c.height > 0 && c.clientWidth > 0 && c.clientHeight > 0;
        },
        null,
        { timeout: 30000 },
      );
    } catch {
      sized = false;
    }
    if (!sized) throw new Error('canvas never reached a non-zero size within 30000ms');

    // The scene itself declares when it has settled. Without that signal a capture would be a
    // lottery, so a timeout is a hard failure for this shot.
    let ready = true;
    try {
      await page.waitForFunction(() => window.__shotReady === true, null, { timeout: shot.ready });
    } catch {
      ready = false;
    }
    if (!ready) throw new Error(`__shotReady never arrived within ${shot.ready}ms`);

    // One more beat for the fade and HUD animations.
    await page.waitForTimeout(shot.settle);

    const info = await page.evaluate(() => {
      const c = document.getElementById('screen');
      return { w: c?.width ?? 0, h: c?.height ?? 0, info: window.__shotInfo ?? null };
    });
    console.log(shot.name, '__shotInfo', JSON.stringify(info));

    const frame = await page.screenshot({
      type: 'jpeg',
      quality: 88,
      clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height },
    });

    // Vetted in memory: a rejected frame is never written, so no half-good JPEG can ship.
    const verdict = await vet(page, frame);
    row.bytes = verdict.bytes;
    row.colours = verdict.colours;
    row.dims = verdict.dims;
    if (verdict.complaints.length) throw new Error(`capture rejected: ${verdict.complaints.join('; ')}`);

    await writeFile(target, frame);
    const written = (await stat(target)).size;
    if (written !== frame.length) throw new Error(`wrote ${written}B, expected ${frame.length}B`);
  } catch (err) {
    await rm(target, { force: true });
    console.log(`${shot.name}: FAILED — ${err instanceof Error ? err.message : String(err)}`);
    continue;
  }

  row.ok = true;
  console.log(`${shot.name}: ${row.bytes} bytes, ${row.colours} colours, ${row.dims}, PASS`);
}

await browser.close();
server.close();

// ---------------------------------------------------------------- report

const passed = rows.filter((r) => r.ok).length;
const nameCol = Math.max(4, ...rows.map((r) => r.name.length));

console.log('');
console.log(`${'shot'.padEnd(nameCol)}  ${'bytes'.padStart(8)}  ${'colours'.padStart(8)}  ${'size'.padStart(9)}  result`);
for (const r of rows) {
  console.log(
    `${r.name.padEnd(nameCol)}  ${String(r.bytes || '-').padStart(8)}  ${String(r.colours || '-').padStart(8)}  ${String(r.dims).padStart(9)}  ${r.ok ? 'PASS' : 'FAIL'}`,
  );
}
console.log(`${passed}/${rows.length} shots passed`);

// The gallery is a fixed size, so count what actually landed on disk, not what we intended.
const onDisk = (await readdir(OUT_DIR)).filter((f) => !f.startsWith('.') && /\.jpe?g$/i.test(f)).sort();
const countOk = ALLOWED_COUNTS.includes(onDisk.length);
console.log(`${onDisk.length} jpeg(s) in ${OUT_DIR}: ${onDisk.join(', ') || 'none'}`);
if (!countOk) console.log(`FAIL: expected ${ALLOWED_COUNTS.join(' or ')} screenshots, found ${onDisk.length}`);

if (passed !== rows.length || !countOk) process.exitCode = 2;

const realErrors = pageErrors.filter((e) => !/404|Failed to load resource/i.test(e));
if (realErrors.length) {
  console.log(`\n${realErrors.length} page error(s).`);
  process.exitCode = 2;
} else {
  console.log('0 page exceptions');
}
console.log(`screenshots written to ${OUT_DIR}`);
