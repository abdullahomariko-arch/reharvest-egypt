#!/usr/bin/env node
/**
 * Runs every integration suite.
 *
 * This script previously only printed instructions, so `npm run test:integration`
 * exited 0 having tested nothing — the worst possible result, because it looks
 * like a passing suite in a CI log.
 *
 * It expects two API instances already running (the concurrency scenarios need
 * two processes to mean anything) and a migrated database.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readdirSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = resolve(root, 'test/integration');

const required = ['DATABASE_URL', 'AUTH_SIGNING_SECRET', 'FIELD_ENCRYPTION_KEYS'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing required environment: ${missing.join(', ')}`);
  process.exit(1);
}

// Discovered rather than listed, so a new suite is picked up automatically
// instead of being silently skipped because someone forgot to add it here.
const suites = readdirSync(dir)
  .filter((f) => f.endsWith('.mjs') && !f.startsWith('_'))
  .sort();

console.log(`Running ${suites.length} integration suites.\n`);

const failed = [];
for (const suite of suites) {
  console.log(`--- ${suite}`);
  const r = spawnSync('npx', ['tsx', resolve(dir, suite)], { stdio: 'inherit', cwd: root });
  if (r.status !== 0) failed.push(suite);
}

console.log(`\n${suites.length - failed.length}/${suites.length} suites passed.`);
if (failed.length) {
  console.error(`Failed: ${failed.join(', ')}`);
  process.exit(1);
}
