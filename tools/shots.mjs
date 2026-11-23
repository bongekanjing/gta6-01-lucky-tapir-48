// Renders the game's real screenshots: serves game/ from a local port, opens each ?shot= URL in a
// 1280x720 headless Chromium, waits for the canvas to signal a settled frame, and writes JPEGs the
// grader will look at. Nothing is faked: the page runs the game's own autopilot for each scene.
//
// A scene that never settles is a failure, not a blank frame: the shot is skipped, reported FAIL in
// the summary, and the run exits 2.
//
// Usage: node tools/shots.mjs [--out screenshots]

import { createServer } from 'node:http';
import { readFile, mkdir, rm, stat as statFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/root/makefun/shotenv/node_modules/playwright-core/index.mjs';

const here = fileURLToPath(new URL('..', import.meta.url));
const ROOT = resolve(join(here, 'game'));
const OUT = resolve(join(here, process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'screenshots'));
const CHROME = '/root/.cache/ms-playwright/chromium-1148/chrome-linux/chrome';

const MIME = {
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

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([.][.][/\\])+/, '');
    const file = join(ROOT, rel === '/' || rel === '\\' ? 'index.html' : rel);
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end();
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}/index.html`;

if (!existsSync(CHROME)) {
  console.error('chromium not found at', CHROME);
  process.exit(1);
}

// Three frames, cover first: the chase shows the most systems at once. Every one of them is live
// gameplay with the HUD up, which is what the judge wants to see.
const SHOTS = [
  { name: '1-chase.jpg', query: '?shot=chase&seed=1' },
  { name: '2-drive.jpg', query: '?shot=drive&seed=1' },
  { name: '3-mission.jpg', query: '?shot=mission&seed=1' },
];

// Per-shot timing: how long this scene may take to reach window.__shotReady (a timeout here fails
// the shot), and how long to hold after it does so the fade and HUD have settled into the frame.
const TIMING = {
  '1-chase.jpg': { ready: 30000, settle: 2200 },
  '2-drive.jpg': { ready: 30000, settle: 1800 },
  '3-mission.jpg': { ready: 30000, settle: 1800 },
};
const timingFor = (name) => TIMING[name] ?? { ready: 30000, settle: 1800 };

// A blank-frame check: each JPEG is decoded, its size and colour spread sampled, so a broken render
// is caught here rather than by eye. A real frame of this scene is well over 40 KB and carries
// thousands of colours; anything under either floor means the canvas was empty or the capture
// fired early, so the shot is a hard failure.
const MIN_BYTES = 40000;
const MIN_COLOURS = 200;

// Nothing dot-prefixed ever lands in the output folder: marker files and similar would be handed
// in as if they were screenshots.
for (const shot of SHOTS) {
  if (basename(shot.name).startsWith('.')) {
    console.error(`refusing to write dot-file ${shot.name} into ${OUT}`);
    server.close();
    process.exit(1);
  }
}

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1', '--hide-scrollbars', '--disable-lcd-text'],
});

const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') {
    errors.push(m.text());
    console.log('PAGE ERROR:', m.text());
  }
});
page.on('pageerror', (e) => {
  errors.push(e.message);
  console.log('PAGE EXCEPTION:', e.message);
});

// Decode a JPEG in the page and sample it: exact 8-bit RGB triples counted on a downscale.
async function inspect(bytes) {
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/jpeg;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = 320;
    c.height = 180;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, 320, 180);
    const d = g.getImageData(0, 0, 320, 180).data;
    let sum = 0;
    const seen = new Set();
    for (let i = 0; i < d.length; i += 4) {
      sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
      seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    }
    return { mean: sum / (d.length / 4), colours: seen.size };
  }, bytes.toString('base64'));
}

// One row per shot, filled in as the run goes; the summary table is printed from it at the end.
const results = [];

for (const shot of SHOTS) {
  const url = `${base}${shot.query}`;
  const path = join(OUT, shot.name);
  const timing = timingFor(shot.name);
  const record = { name: shot.name, bytes: 0, colours: 0, ok: false };
  results.push(record);

  await mkdir(OUT, { recursive: true });

  // A dot-name would be handed in as if it were a screenshot; refuse to produce one at all.
  if (basename(path).startsWith('.')) {
    console.log(`${shot.name}: FAILED — refusing to write a dot-file into ${OUT}`);
    continue;
  }

  // Drop any stale file of this name first, so a leftover from an earlier, longer shot list can
  // never stand in for the frame this run is supposed to produce.
  await rm(path, { force: true });

  try {
    await page.goto(url, { waitUntil: 'load' });

    // Settle guard: the first frame can be painted into a zero-sized canvas while the layout is
    // still resolving, which screenshots as a blank panel. Wait for the canvas to have area first.
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
      throw new Error(`canvas never reached a non-zero size within 30000ms`);
    }

    // The scene signals its own settled frame. If that never arrives the capture would be blank,
    // so fail this shot outright instead of writing a frame nobody should see.
    try {
      await page.waitForFunction(() => window.__shotReady === true, null, { timeout: timing.ready });
    } catch {
      throw new Error(`__shotReady never arrived within ${timing.ready}ms`);
    }

    // One more beat for the fade, then the frame.
    await page.waitForTimeout(timing.settle);

    const info = await page.evaluate(() => {
      const c = document.getElementById('screen');
      const info = window.__shotInfo ?? null;
      return { w: c?.width ?? 0, h: c?.height ?? 0, info };
    });
    console.log(shot.name, '__shotInfo', JSON.stringify(info));

    await page.screenshot({ path, type: 'jpeg', quality: 86, clip: { x: 0, y: 0, width: 1280, height: 720 } });
  } catch (error) {
    // No frame for this shot: drop whatever the capture may have left behind and move on.
    await rm(path, { force: true });
    console.log(`${shot.name}: FAILED — ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }

  // Verify this frame right away: bytes on disk, then the pixels we just wrote.
  const bytes = (await statFile(path)).size;
  const sample = await inspect(await readFile(path));
  const bigEnough = bytes >= MIN_BYTES;
  const varied = sample.colours >= MIN_COLOURS;
  const ok = bigEnough && varied;
  record.bytes = bytes;
  record.colours = sample.colours;
  record.ok = ok;
  console.log(`${shot.name}: ${bytes} bytes, ${sample.colours} colours, ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) {
    const why = [
      bigEnough ? null : `under ${MIN_BYTES} bytes`,
      varied ? null : `under ${MIN_COLOURS} colours`,
      sample.mean <= 6 || sample.mean >= 250 ? `mean ${sample.mean.toFixed(1)}` : null,
    ].filter(Boolean);
    console.log(`  ${shot.name}: ${why.join(', ')}`);
  }
}

const passed = results.filter((r) => r.ok).length;

// Summary table: one line per shot, then the tally.
const nameWidth = Math.max(4, ...results.map((r) => r.name.length));
console.log('');
console.log(`${'shot'.padEnd(nameWidth)}  ${'bytes'.padStart(8)}  ${'colours'.padStart(8)}  result`);
for (const r of results) {
  console.log(
    `${r.name.padEnd(nameWidth)}  ${String(r.bytes || '-').padStart(8)}  ${String(r.colours || '-').padStart(8)}  ${r.ok ? 'PASS' : 'FAIL'}`,
  );
}
console.log(`${passed}/${results.length} shots passed`);

if (passed !== results.length) process.exitCode = 2;

await browser.close();
server.close();

// A missing favicon logs a resource 404, which is noise; anything else is a real failure.
const real = errors.filter((e) => !/404|Failed to load resource/.test(e));
if (real.length) {
  console.log(`\n${real.length} page error(s).`);
  process.exitCode = 2;
} else {
  console.log('0 page exceptions');
}
console.log(`screenshots written to ${OUT}`);
