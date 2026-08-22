#!/usr/bin/env node
/**
 * Beneficiary encryption maintenance.
 *
 *   npx tsx scripts/beneficiary-keys.ts status
 *   npx tsx scripts/beneficiary-keys.ts rotate [--dry-run]
 *   npx tsx scripts/beneficiary-keys.ts backfill --id <uuid> --account <number>
 *   npx tsx scripts/beneficiary-keys.ts verify
 *
 * Rotation exists as a command rather than a migration because it is not a
 * one-off. Keys get rotated on a schedule, after staff turnover, and in a hurry
 * after an incident. A scheme where rotation means editing SQL by hand is a
 * scheme where rotation never happens.
 *
 * `rotate` is resumable and safe to run repeatedly: each row is re-sealed in its
 * own transaction, and rows already under the active key are skipped. Killing it
 * halfway leaves a mixture of key ids, which is a supported state — that is the
 * entire reason each row carries the id of the key that sealed it.
 */

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

import { Keyring } from '../packages/core/src/crypto.ts';
import { createBeneficiaryRepository, SYSTEM_MAINTENANCE_ACTOR } from '../apps/api/src/repo/beneficiary.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const KEYS = process.env.FIELD_ENCRYPTION_KEYS;

if (!DATABASE_URL || !KEYS) {
  console.error('DATABASE_URL and FIELD_ENCRYPTION_KEYS must both be set. See .env.example.');
  process.exit(1);
}

const args = process.argv.slice(2);
const command = args[0];
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const client = postgres(DATABASE_URL, { max: 2 });
const db = drizzle(client);
const keyring = Keyring.fromEnv(KEYS);
const repo = createBeneficiaryRepository(db, keyring);

async function main() {
  switch (command) {
    case 'status': {
      const needsRotation = await repo.idsNeedingRotation();
      const needsBackfill = await repo.idsNeedingBackfill();

      console.log(`Active key:            ${keyring.activeKeyId}`);
      console.log(`Rows to re-seal:       ${needsRotation.length}`);
      console.log(`Rows without metadata: ${needsBackfill.length}`);

      if (needsBackfill.length) {
        console.log('\nThese rows predate encryption and cannot be paid until backfilled:');
        for (const r of needsBackfill) {
          // Never print the stored value: on a legacy row it may be the actual
          // account number in plaintext, and this output ends up in terminal
          // scrollback and CI logs.
          console.log(`  ${r.id}  (stored value withheld)`);
        }
      }
      break;
    }

    case 'rotate': {
      const dryRun = args.includes('--dry-run');
      const ids = await repo.idsNeedingRotation();

      if (ids.length === 0) {
        console.log(`Nothing to do. Every row is already sealed under ${keyring.activeKeyId}.`);
        break;
      }

      console.log(`${ids.length} row(s) to re-seal under ${keyring.activeKeyId}.`);
      if (dryRun) {
        console.log('Dry run — nothing written.');
        break;
      }

      const tally = { rotated: 0, 'already-current': 0, 'no-metadata': 0, unreadable: 0 };
      const unreadable: string[] = [];

      for (const id of ids) {
        const result = await repo.rotateRow(id);
        tally[result] += 1;
        if (result === 'unreadable') unreadable.push(id);
      }

      console.log(`Re-sealed ${tally.rotated}, already current ${tally['already-current']}.`);

      if (tally['no-metadata'] > 0) {
        console.log(`${tally['no-metadata']} row(s) have no encryption metadata — run backfill.`);
      }

      if (unreadable.length > 0) {
        /*
          Not a transient error. Either a key was retired from
          FIELD_ENCRYPTION_KEYS while rows still referenced it — put it back —
          or the row was sealed under an older scheme with no record binding, in
          which case the number must be re-entered from a trusted source. Either
          way these suppliers cannot be paid until it is resolved, so the command
          exits non-zero.
        */
        console.error(`\n${unreadable.length} row(s) could not be opened:`);
        unreadable.forEach((id) => console.error(`  ${id}`));
        console.error(
          '\nEither a key is missing from FIELD_ENCRYPTION_KEYS, or these rows predate the\n' +
            'record binding. Re-enter the account number with: backfill --id <uuid> --account <number>',
        );
        process.exitCode = 1;
      }
      break;
    }

    case 'backfill': {
      const id = flag('id');
      const account = flag('account');

      if (!id || !account) {
        console.error(
          'Usage: backfill --id <uuid> --account <number>\n\n' +
            'The account number is supplied deliberately rather than read from the column: ' +
            'legacy rows hold a mixture of plaintext and the literal string "enc:placeholder", ' +
            'and guessing which is which encrypts a placeholder and treats it as a real account.',
        );
        process.exit(1);
      }

      await repo.backfillRow(id, account, SYSTEM_MAINTENANCE_ACTOR);
      const after = await repo.byId(id);
      console.log(`Backfilled ${id}. Tail is now ${after?.accountTail}, sealed under ${after?.encryptionKeyId}.`);
      break;
    }

    /**
     * Proves every row can actually be opened.
     *
     * Worth running after a rotation and before a payment run: a row that
     * cannot be decrypted is a supplier who cannot be paid, and finding that
     * out during the run is the worst possible moment.
     */
    case 'verify': {
      const rows = await repo.idsNeedingBackfill();
      const all = await client`SELECT id FROM beneficiaries`;
      let ok = 0;
      const broken: string[] = [];

      for (const r of all) {
        try {
          await repo.revealForPayout(String(r.id), {
            settlementId: 'verify',
            actorId: SYSTEM_MAINTENANCE_ACTOR,
            actorRoles: ['finance'],
          });
          ok += 1;
        } catch (e) {
          broken.push(`${r.id}: ${(e as Error).message}`);
        }
      }

      console.log(`Readable: ${ok}/${all.length}`);
      if (rows.length) console.log(`Awaiting backfill: ${rows.length}`);
      if (broken.length) {
        console.error('\nUnreadable:');
        broken.forEach((b) => console.error(`  ${b}`));
        process.exitCode = 1;
      }
      break;
    }

    default:
      console.error(
        'Commands:\n' +
          '  status                                  what needs rotating or backfilling\n' +
          '  rotate [--dry-run]                      re-seal every row under the active key\n' +
          '  backfill --id <uuid> --account <num>    encrypt a row that predates encryption\n' +
          '  verify                                  prove every row can still be opened',
      );
      process.exit(1);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => client.end());
