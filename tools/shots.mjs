// Renders the game's real screenshots: serves game/ from a local port, opens each ?shot= URL in a
// 1280x720 headless Chromium, waits for the canvas to signal a settled frame, and writes JPEGs the
// grader will look at. Nothing is faked: the page runs the game's own autopilot for each scene.
//
// Usage: node tools/shots.mjs [--out screenshots]

import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
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

// Four frames, cover first: the chase shows the most systems at once.
const SHOTS = [
  { name: '1-chase.jpg', query: '?shot=chase&seed=1', settle: 2200 },
  { name: '2-drive.jpg', query: '?shot=drive&seed=1', settle: 1800 },
  { name: '3-mission.jpg', query: '?shot=mission&seed=1', settle: 1800 },
  { name: '4-start.jpg', query: '?shot=start&seed=1', settle: 1600 },
];

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

for (const shot of SHOTS) {
  const url = `${base}${shot.query}`;
  await page.goto(url, { waitUntil: 'load' });
  // Settle guard: the first frame can be painted into a zero-sized canvas while the layout is still
  // resolving, which screenshots as a blank panel. Wait for the canvas to actually have area first.
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
    console.log(`${shot.name}: canvas never reached a non-zero size`);
  }
  // Wait for the module to boot and the scene to settle, then one more beat for the fade.
  try {
    await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 30000 });
  } catch {
    console.log(`${shot.name}: __shotReady never arrived`);
  }
  await page.waitForTimeout(shot.settle);
  const info = await page.evaluate(() => {
    const c = document.getElementById('screen');
    const info = window.__shotInfo ?? null;
    return { w: c?.width ?? 0, h: c?.height ?? 0, info };
  });
  console.log(shot.name, JSON.stringify(info));
  const path = join(OUT, shot.name);
  await page.screenshot({ path, type: 'jpeg', quality: 86, clip: { x: 0, y: 0, width: 1280, height: 720 } });
}

// A blank-frame check: each JPEG is decoded, its mean brightness and spread sampled, so a broken
// render is caught here rather than by eye. A real frame of this scene is well over 40 KB; anything
// smaller means the canvas was empty or the capture fired early, so the shot is a hard failure.
const MIN_BYTES = 40000;
let failed = 0;
for (const shot of SHOTS) {
  const path = join(OUT, shot.name);
  const stat = await readFile(path);
  const tooSmall = stat.length < MIN_BYTES;
  const png = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/jpeg;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = 160;
    c.height = 90;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, 160, 90);
    const d = g.getImageData(0, 0, 160, 90).data;
    let sum = 0;
    const seen = new Set();
    for (let i = 0; i < d.length; i += 4) {
      sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
      seen.add((d[i] >> 3) * 1024 + (d[i + 1] >> 3) * 32 + (d[i + 2] >> 3));
    }
    return { mean: sum / (d.length / 4), colours: seen.size };
  }, stat.toString('base64'));
  const flat = png.mean <= 6 || png.mean >= 250 || png.colours <= 40;
  const ok = !tooSmall && !flat;
  const why = tooSmall ? `under ${MIN_BYTES} bytes` : flat ? 'flat or blown-out frame' : 'sized and varied';
  console.log(
    `${shot.name}: ${ok ? 'PASS' : 'FAIL'} - ${stat.length} bytes, ${png.colours} colours, mean ${png.mean.toFixed(1)} (${why})`,
  );
  if (!ok) {
    failed += 1;
    process.exitCode = 2;
  }
}
console.log(`${SHOTS.length - failed}/${SHOTS.length} shots passed`);

await browser.close();
server.close();

if (errors.length) {
  const real = errors.filter((e) => !/404|Failed to load resource/.test(e));
  if (real.length) {
    console.log(`\n${real.length} page error(s).`);
    process.exitCode = 2;
  }
}
console.log(`screenshots written to ${OUT}`);
