#!/usr/bin/env node
/**
 * Applies migrations in order.
 *
 * Two modes, because a fresh install and an upgrade are genuinely different:
 *
 *   fresh    every migration, including 0009, which makes encryption mandatory.
 *            A new database has no legacy rows, so there is nothing to backfill
 *            and no reason to leave the constraint off.
 *
 *   upgrade  everything except 0009. Existing rows may predate encryption, and
 *            0009 refuses to run while any of them do. Backfill first, then
 *            apply 0009 explicitly.
 *
 * The previous arrangement left 0009 out of `db:migrate` entirely, which meant a
 * fresh install finished *without* mandatory encryption and nobody was told.
 * That is the failure this file exists to prevent: the safe path has to be the
 * default, and the unsafe one has to be asked for.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readdirSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = resolve(root, 'packages/db/migrations');

const mode = process.argv[2] ?? 'fresh';
if (!['fresh', 'upgrade'].includes(mode)) {
  console.error('Usage: migrate.mjs [fresh|upgrade]\n\n' +
    '  fresh    new database: every migration, encryption mandatory at the end\n' +
    '  upgrade  existing database: everything except 0009. Backfill, then apply 0009.');
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

// Discovered and sorted, so a new migration is never missed because someone
// forgot to add it to a hand-maintained list.
const all = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
const MANDATORY_ENCRYPTION = '0009_encryption_mandatory.sql';

const toApply = mode === 'fresh' ? all : all.filter((f) => f !== MANDATORY_ENCRYPTION);

console.log(`${mode} install: applying ${toApply.length} migration(s).`);

for (const file of toApply) {
  const r = spawnSync('psql', [process.env.DATABASE_URL, '-v', 'ON_ERROR_STOP=1', '-q', '-f', resolve(dir, file)], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  if (r.status !== 0) {
    console.error(`FAILED at ${file}`);
    process.exit(1);
  }
  console.log(`  ok  ${file}`);
}

if (mode === 'upgrade') {
  console.log(
    `\n${MANDATORY_ENCRYPTION} was NOT applied.\n` +
      'Backfill legacy beneficiary rows first:\n' +
      '  npx tsx scripts/beneficiary-keys.ts status\n' +
      '  npx tsx scripts/beneficiary-keys.ts backfill --id <uuid> --account <number>\n' +
      `then: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/db/migrations/${MANDATORY_ENCRYPTION}`,
  );
}
