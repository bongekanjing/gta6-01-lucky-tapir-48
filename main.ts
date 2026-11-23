// Submission entry point for gta6-01. The game sits in game/ right beside this file
// (static index.html plus its ES modules, nothing fetched at runtime), and the shots
// sit in screenshots/. This script stages both into the output folder the judge
// reads and writes the dossier.json summary there with the vendored builder.
// Every path is derived from this module's own location, so the process can start
// from any working directory. `node main.ts` on Node 22+, standard library only.
//
// Locally, where there is no /output, point MAKEFUN_OUTPUT_DIR at a scratch folder:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-game.ts';

// Folder this script lives in, which is also where game/ and screenshots/ live.
const projectDir = dirname(fileURLToPath(import.meta.url));

// The grader mounts its read area at /output; anything else can be named by env var.
const outputDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';

// The competition's limits, copied from its gate: the text budget for the dossier,
// how many shots it may embed and how large each may be, and the caps on the game
// tree (files, total bytes, longest path) that the judge would reject past.
const limits = {
  text_max_bytes: 163840,
  screenshots: { max: 4, max_bytes: 262144 },
  game_max_files: 993,
  game_max_bytes: 50331648,
  game_path_max_bytes: 1000,
};

// Mirror a folder into the output when the source is actually present; a missing
// screenshots/ is not an error, it just leaves the empty target folder behind.
function mirror(source: string, destination: string): void {
  if (existsSync(source)) cpSync(source, destination, { recursive: true });
}

function stage(): void {
  const gameDir = join(projectDir, 'game');
  const shotsDir = join(projectDir, 'screenshots');
  const stagedGame = join(outputDir, 'game');
  const stagedShots = join(outputDir, 'screenshots');

  if (!existsSync(join(gameDir, 'index.html'))) {
    throw new Error(`expected a playable game at ${gameDir}/index.html`);
  }

  mkdirSync(outputDir, { recursive: true });
  mkdirSync(stagedShots, { recursive: true });
  mirror(gameDir, stagedGame);
  mirror(shotsDir, stagedShots);

  const dossierPath = join(outputDir, 'dossier.json');
  const bytes = buildDossier(outputDir, limits);
  writeFileSync(dossierPath, bytes);

  console.log(`submitted ${outputDir}: dossier.json ${bytes.length} bytes`);
}

try {
  stage();
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`submission failed: ${detail}`);
  process.exitCode = 1;
}
