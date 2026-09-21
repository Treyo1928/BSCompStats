/**
 * One-off score sync, for development and for a manual backfill.
 *
 *   npm run sync
 *
 * Does exactly what the worker's periodic poll does, then exits - handy when
 * you want scores in the database without leaving the worker running.
 */
import { syncAll } from '../apps/worker/dist/sync.js';
import { closeBus } from '../apps/worker/dist/bus.js';
import { prisma } from '@bscs/db';

const started = Date.now();
console.log('Syncing tracked scores from BeatLeader...');

const { checked, written } = await syncAll();
console.log(
  `Checked ${checked} player/map pairs, wrote ${written} in ${((Date.now() - started) / 1000).toFixed(1)}s`,
);

const rows = await prisma.score.findMany({
  select: {
    accuracy: true,
    player: { select: { name: true } },
  },
});

const byPlayer = new Map();
for (const row of rows) {
  const list = byPlayer.get(row.player.name) ?? [];
  list.push(row.accuracy);
  byPlayer.set(row.player.name, list);
}

console.log(`\n${rows.length} scores stored:`);
for (const [name, accs] of [...byPlayer].sort()) {
  const mean = accs.reduce((a, b) => a + b, 0) / accs.length;
  console.log(`  ${name.padEnd(10)} ${String(accs.length).padStart(2)} maps   avg ${(mean * 100).toFixed(2)}%`);
}

await prisma.$disconnect();
// The worker keeps its Redis publisher open for the life of the process; a
// one-shot script has to close it or Node never exits.
await closeBus();
