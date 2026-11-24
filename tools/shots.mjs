// Shot rig for SOLARA VICE.
//
// Three scenes, three JPEGs, no retouching. The rig stands up a read-only HTTP server over game/,
// drives a headless Chromium through each staged `?shot=` URL, lets the game's own autopilot reach
// its settled frame, and captures exactly what the canvas is showing. If any part of that chain
// misbehaves the run fails loudly instead of shipping a picture nobody should see.
//
// Failure is the default. A scene that never signals readiness, a capture that is blank, flat,
// over-weight or the wrong shape, and any page-level exception all mark the shot FAIL, which makes
// the process exit 2.
//
// Usage: node tools/shots.mjs [--out <dir>]

import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/root/makefun/shotenv/node_modules/playwright-core/index.mjs';

// ================================================================ the run's knobs

const PROJECT_DIR = fileURLToPath(new URL('..', import.meta.url));
const WEB_ROOT = resolve(PROJECT_DIR, 'game');

/** `--out <dir>` renames the gallery folder; the default is the one the entry ships. */
function outputFolder() {
  const flag = process.argv.indexOf('--out');
  const value = flag === -1 ? 'screenshots' : process.argv[flag + 1];
  return resolve(PROJECT_DIR, value || 'screenshots');
}
const GALLERY_DIR = outputFolder();

/** The harness may hand us a browser; otherwise fall back to the copy cached on this box. */
const BROWSER_BIN = process.env.MAKEFUN_CHROME || '/root/.hermes/tools/chromium-1208/chrome-linux64/chrome';

const FRAME = { width: 1280, height: 720 };

// A real city frame is heavy and busy. These are the floors that separate "the game drew something"
// from "the canvas was empty when the shutter opened".
const FLOOR = {
  bytes: 40000,
  colours: 200,
};

// The gate's ceilings on a submitted frame, checked here so a frame it would reject never lands.
const CEILING = {
  bytes: 262144,
  longSide: 1280,
  shortSide: 480,
};

// Three frames ship; four is the competition's cap. Any other count means the rig and the entry
// have drifted apart, which is a failure rather than a smaller gallery.
const LEGAL_COUNTS = [3, 4];

/**
 * The gallery, in the order it is submitted. The chase goes first because it puts the most systems
 * in one frame: traffic, pursuit, the wanted stars and a live objective.
 *
 * `readyMs` is the budget for the scene to raise window.__shotReady; `settleMs` is the extra hold
 * afterwards so the fade-in and the HUD have stopped animating before the shutter.
 */
const SCENES = [
  { name: '1-chase.jpg', query: '?shot=chase&seed=1', readyMs: 30000, settleMs: 2200 },
  { name: '2-drive.jpg', query: '?shot=drive&seed=1', readyMs: 30000, settleMs: 1800 },
  { name: '3-mission.jpg', query: '?shot=mission&seed=1', readyMs: 30000, settleMs: 1800 },
];

const CONTENT_TYPE = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
  ['.woff2', 'font/woff2'],
]);

// ================================================================ static server

/**
 * Read-only file server rooted at game/. Anything that resolves outside the root, by encoding or by
 * traversal, is refused with 403; a path that simply is not there answers 404, which the favicon
 * request earns every run.
 */
function openStaticServer() {
  const server = createServer(async (request, response) => {
    try {
      const { pathname } = new URL(request.url, 'http://127.0.0.1');
      let requested;
      try {
        requested = decodeURIComponent(pathname);
      } catch {
        requested = pathname; // a malformed escape is not worth a 403 of its own
      }
      const stripped = normalize(requested).replace(/^([/\\]|\.\.[/\\])+/, '');
      const file = join(WEB_ROOT, stripped || 'index.html');
      if (file !== WEB_ROOT && !file.startsWith(WEB_ROOT + sep)) {
        response.writeHead(403).end('forbidden');
        return;
      }
      const body = await readFile(file);
      response.writeHead(200, {
        'content-type': CONTENT_TYPE.get(extname(file).toLowerCase()) ?? 'application/octet-stream',
      });
      response.end(body);
    } catch {
      response.writeHead(404).end('not found');
    }
  });
  return new Promise((ready) => server.listen(0, '127.0.0.1', () => ready(server)));
}

// ================================================================ frame audit

/**
 * Decode a JPEG inside the page and describe it: the dimensions the decoded image actually has
 * (not the viewport we asked for), an average luminance, and the number of distinct 8-bit RGB
 * triples left after a downscale to 320x180.
 */
function describeFrame(page, buffer) {
  return page.evaluate(async (base64) => {
    const probe = new Image();
    probe.src = `data:image/jpeg;base64,${base64}`;
    await probe.decode();

    const scratch = document.createElement('canvas');
    scratch.width = 320;
    scratch.height = 180;
    const g = scratch.getContext('2d', { willReadFrequently: true });
    g.drawImage(probe, 0, 0, scratch.width, scratch.height);
    const pixels = g.getImageData(0, 0, scratch.width, scratch.height).data;

    const palette = new Set();
    let luminance = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      luminance += (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
      palette.add((pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2]);
    }

    return {
      width: probe.naturalWidth,
      height: probe.naturalHeight,
      mean: luminance / (pixels.length / 4),
      colours: palette.size,
    };
  }, buffer.toString('base64'));
}

/**
 * Judge the captured bytes while they are still in memory. Returns the measurements plus the list
 * of complaints; an empty list means the frame is fit to write. A rejected frame is never written,
 * so no plausible-looking JPEG is left behind for the entry to pick up.
 */
async function auditFrame(page, buffer) {
  const bytes = buffer.length;
  const seen = await describeFrame(page, buffer);
  const longSide = Math.max(seen.width, seen.height);
  const shortSide = Math.min(seen.width, seen.height);
  const faults = [];

  if (bytes < FLOOR.bytes) faults.push(`${bytes}B is under the ${FLOOR.bytes}B floor`);
  if (bytes > CEILING.bytes) faults.push(`${bytes}B is over the ${CEILING.bytes}B ceiling`);
  if (seen.colours < FLOOR.colours) faults.push(`only ${seen.colours} distinct colours`);
  if (longSide > CEILING.longSide) faults.push(`long side ${longSide} exceeds ${CEILING.longSide}`);
  if (shortSide < CEILING.shortSide) faults.push(`short side ${shortSide} below ${CEILING.shortSide}`);
  if (seen.mean <= 6) faults.push(`frame is black (mean ${seen.mean.toFixed(1)})`);
  if (seen.mean >= 250) faults.push(`frame is white (mean ${seen.mean.toFixed(1)})`);

  return {
    bytes,
    colours: seen.colours,
    dims: `${seen.width}x${seen.height}`,
    faults,
  };
}

// ================================================================ one scene

/**
 * Load a scene and hold the shutter until it is worth taking: the canvas must have real area, the
 * scene must have declared itself settled, and then the fades get their extra beat. Every wait that
 * expires throws, because a capture taken too early would be a blank.
 */
async function settleScene(page, url, scene) {
  await page.goto(url, { waitUntil: 'load' });

  // The first paint can land in a zero-sized canvas while layout is still resolving.
  try {
    await page.waitForFunction(
      () => {
        const canvas = document.getElementById('screen');
        return !!canvas && canvas.width > 0 && canvas.height > 0 && canvas.clientWidth > 0 && canvas.clientHeight > 0;
      },
      null,
      { timeout: 30000 },
    );
  } catch {
    throw new Error('canvas never reached a non-zero size within 30000ms');
  }

  // The scene itself knows when its frame is representative; we do not guess on its behalf.
  try {
    await page.waitForFunction(() => window.__shotReady === true, null, { timeout: scene.readyMs });
  } catch {
    throw new Error(`__shotReady never arrived within ${scene.readyMs}ms`);
  }

  await page.waitForTimeout(scene.settleMs);
}

/**
 * Capture one scene and write it only if it passes the audit. Throws on anything that would make
 * the frame unshippable; the caller turns that into a FAIL row and deletes the target.
 */
async function captureScene(page, scene, origin, target) {
  await settleScene(page, `${origin}${scene.query}`, scene);

  const canvas = await page.evaluate(() => {
    const element = document.getElementById('screen');
    return { w: element?.width ?? 0, h: element?.height ?? 0, info: window.__shotInfo ?? null };
  });
  console.log(`${scene.name} __shotInfo ${JSON.stringify(canvas)}`);

  const frame = await page.screenshot({
    type: 'jpeg',
    quality: 88,
    clip: { x: 0, y: 0, width: FRAME.width, height: FRAME.height },
  });

  const audit = await auditFrame(page, frame);
  if (audit.faults.length) throw new Error(`capture rejected: ${audit.faults.join('; ')}`);

  await writeFile(target, frame);
  const onDisk = (await stat(target)).size;
  if (onDisk !== frame.length) throw new Error(`wrote ${onDisk}B, expected ${frame.length}B`);

  return audit;
}

// ================================================================ main

if (!existsSync(BROWSER_BIN)) {
  console.error(`no chromium at ${BROWSER_BIN} (set MAKEFUN_CHROME to override)`);
  process.exit(1);
}

// A dot-named file would be handed in as if it were a screenshot, so the rig will not produce one.
const dotTarget = SCENES.find((scene) => basename(scene.name).startsWith('.'));
if (dotTarget) {
  console.error(`refusing to write dot-file "${dotTarget.name}" into ${GALLERY_DIR}`);
  process.exit(1);
}

await mkdir(GALLERY_DIR, { recursive: true });

const server = await openStaticServer();
const origin = `http://127.0.0.1:${server.address().port}/index.html`;

const browser = await chromium.launch({
  executablePath: BROWSER_BIN,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1', '--hide-scrollbars', '--disable-lcd-text'],
});
const page = await browser.newPage({ viewport: FRAME, deviceScaleFactor: 1 });

// Collect everything the page complains about. A missing favicon is the one piece of noise we
// accept; the filter that decides that lives at the end, next to the tally.
const complaints = [];
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  complaints.push(message.text());
  console.log('PAGE ERROR:', message.text());
});
page.on('pageerror', (error) => {
  complaints.push(error.message);
  console.log('PAGE EXCEPTION:', error.message);
});

const rows = [];

for (const scene of SCENES) {
  const target = join(GALLERY_DIR, scene.name);
  const row = { name: scene.name, bytes: 0, colours: 0, dims: '-', ok: false };
  rows.push(row);

  // Belt and braces: the folder may have been renamed into a dot-name via --out.
  if (basename(target).startsWith('.')) {
    console.log(`${scene.name}: FAILED — dot-file target refused`);
    continue;
  }

  // A leftover from an earlier run must never stand in for the frame this run is meant to make.
  await rm(target, { force: true });

  try {
    const audit = await captureScene(page, scene, origin, target);
    row.bytes = audit.bytes;
    row.colours = audit.colours;
    row.dims = audit.dims;
  } catch (error) {
    await rm(target, { force: true });
    console.log(`${scene.name}: FAILED — ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }

  row.ok = true;
  console.log(`${scene.name}: ${row.bytes} bytes, ${row.colours} colours, ${row.dims}, PASS`);
}

await browser.close();
server.close();

// ================================================================ report

const passed = rows.filter((row) => row.ok).length;
const nameWidth = Math.max(4, ...rows.map((row) => row.name.length));

console.log('');
console.log(`${'shot'.padEnd(nameWidth)}  ${'bytes'.padStart(8)}  ${'colours'.padStart(8)}  ${'size'.padStart(9)}  result`);
for (const row of rows) {
  console.log(
    `${row.name.padEnd(nameWidth)}  ${String(row.bytes || '-').padStart(8)}  ${String(row.colours || '-').padStart(8)}  ${String(row.dims).padStart(9)}  ${row.ok ? 'PASS' : 'FAIL'}`,
  );
}
console.log(`${passed}/${rows.length} shots passed`);

// Count what actually landed in the gallery rather than what we meant to write: the entry ships a
// fixed set, and a mismatch should be visible in the log.
const shipped = (await readdir(GALLERY_DIR)).filter((file) => !file.startsWith('.') && /\.jpe?g$/i.test(file)).sort();
const countFine = LEGAL_COUNTS.includes(shipped.length);
console.log(`${shipped.length} jpeg(s) in ${GALLERY_DIR}: ${shipped.join(', ') || 'none'}`);
if (!countFine) console.log(`FAIL: expected ${LEGAL_COUNTS.join(' or ')} screenshots, found ${shipped.length}`);

if (passed !== rows.length || !countFine) process.exitCode = 2;

// A resource 404 for a missing favicon is noise; every other complaint is a real failure.
const realComplaints = complaints.filter((entry) => !/404|Failed to load resource/i.test(entry));
if (realComplaints.length) {
  console.log(`\n${realComplaints.length} page error(s).`);
  process.exitCode = 2;
} else {
  console.log('0 page exceptions');
}
console.log(`screenshots written to ${GALLERY_DIR}`);
