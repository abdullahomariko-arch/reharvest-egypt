/**
 * Seed.
 *
 * Creates the first corridor from the concept document: sauce-grade tomatoes
 * from a Nubaria packing station to Cairo pizza and pasta kitchens.
 *
 * The data is deliberately not tidy. It includes a lot that failed inspection,
 * a beneficiary whose bank details changed this morning, and an order where the
 * buyer underpaid the deposit — because a seed where everything is in the happy
 * path lets broken refusal paths ship unnoticed.
 *
 * Idempotent: safe to run repeatedly against the same database.
 */

import postgres from 'postgres';
import { issueToken } from '../../../apps/api/src/auth.ts';
import { drizzle } from 'drizzle-orm/postgres-js';

import { Keyring } from '../../core/src/crypto.ts';
import { createBeneficiaryRepository } from '../../../apps/api/src/repo/beneficiary.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. See .env.example.');
  process.exit(1);
}

const sql = postgres(url, { max: 2 });

/** Stable UUIDs so re-running does not fill the database with duplicates. */
const ID = {
  nubaria: '11111111-1111-4111-8111-111111111111',
  kafrElDawwar: '11111111-1111-4111-8111-111111111112',
  cairoPizza: '22222222-2222-4222-8222-222222222221',
  pastaHouse: '22222222-2222-4222-8222-222222222222',
  reharvest: '33333333-3333-4333-8333-333333333333',
  benNubaria: '44444444-4444-4444-8444-444444444441',
  // User ids are UUIDs because that is what captured_by, prepared_by and
  // approved_by are in the database. Friendly strings fail at the INSERT.
  userSupplier: '00000000-0000-4000-8000-000000000001',
  userBuyer: '00000000-0000-4000-8000-000000000002',
  userInspector: '00000000-0000-4000-8000-000000000003',
  userOps: '00000000-0000-4000-8000-000000000004',
} as const;

async function main() {
  console.log('Seeding ReHarvest…');

  await sql`
    INSERT INTO parties (id, kind, legal_name_ar, phone_e164, state, identity_verified_at, created_at)
    VALUES
      (${ID.nubaria}, 'supplier', 'محطة فرز النوبارية', '+201001234567', 'ACTIVE', now(), now()),
      (${ID.kafrElDawwar}, 'supplier', 'مزارع كفر الدوار', '+201001234571', 'ACTIVE', now(), now()),
      (${ID.cairoPizza}, 'buyer', 'مطاعم القاهرة للبيتزا', '+201001234568', 'ACTIVE', now(), now()),
      (${ID.pastaHouse}, 'buyer', 'بيت المكرونة', '+201001234572', 'ACTIVE', now(), now()),
      (${ID.reharvest}, 'internal', 'ReHarvest Egypt', '+201001234570', 'ACTIVE', now(), now())
    ON CONFLICT (id) DO NOTHING;
  `;

  /*
    A beneficiary whose details changed six hours ago. Any payout attempt
    against this supplier must be blocked by the 24-hour cooldown, and the
    trigger in 0001_invariants.sql is what enforces it. If a change to the
    payout path ever breaks that rule, seeding this row is what makes it
    obvious in development rather than in production.
  */
  /*
    Real encryption, even in the seed. A placeholder here would mean the
    decryption path never runs in development, and the first time anyone
    exercises it would be against a production bank account.
  */
  const keys = process.env.FIELD_ENCRYPTION_KEYS;
  const ACCOUNT = '1234567890';

  if (keys) {
    /*
      Through the repository, exactly as the application does.

      A seed that writes the column directly is a second encryption
      implementation that nobody maintains, and the first thing to drift when
      the binding or the key format changes.
    */
    const repo = createBeneficiaryRepository(drizzle(sql), Keyring.fromEnv(keys));

    const existing = await repo.currentForParty(ID.nubaria);
    if (existing) {
      console.log(`  beneficiary already present (tail ${existing.accountTail})`);
    } else {
      const created = await repo.record({
        partyId: ID.nubaria,
        channel: 'bank',
        accountNumber: ACCOUNT,
        holderName: 'محطة فرز النوبارية',
        bankCode: 'CIB',
        actorId: ID.userOps,
        actorRoles: ['ops_manager'],
        // Six hours ago on purpose: any payout against this supplier must be
        // blocked by the 24-hour cooldown. Seeding the awkward case is what
        // makes a broken rule obvious in development rather than in production.
        at: new Date(Date.now() - 6 * 3600_000).toISOString(),
      });
      console.log(`  1 beneficiary (encrypted, tail ${created.accountTail})`);
    }
  } else {
    console.log('  skipping beneficiary — FIELD_ENCRYPTION_KEYS not set');
  }

  /*
    postgres.js will not bind a bigint parameter, so gram and piastre values are
    passed as strings and cast in SQL. This is the same discipline the API uses
    on the wire: integer minor units never travel as JavaScript numbers.
  */
  const lots = [
    { code: 'LOT-20260818-TOM-017', supplier: ID.nubaria, crop: 'tomato', state: 'AVAILABLE', accepted: '800000', price: '875', crates: 25 },
    { code: 'LOT-20260818-TOM-018', supplier: ID.nubaria, crop: 'tomato', state: 'PARTIALLY_RESERVED', accepted: '1200000', price: '820', crates: 40 },
    { code: 'LOT-20260818-POT-004', supplier: ID.kafrElDawwar, crop: 'potato', state: 'AVAILABLE', accepted: '640000', price: '420', crates: 32 },
    // Failed inspection. Must never appear in a buyer's market list.
    { code: 'LOT-20260817-TOM-011', supplier: ID.nubaria, crop: 'tomato', state: 'QUARANTINED', accepted: '500000', price: '875', crates: 20 },
    // Weighed but not yet inspected — proves the gap between weight and sellable.
    { code: 'LOT-20260818-ONI-002', supplier: ID.kafrElDawwar, crop: 'onion', state: 'INSPECTION_PENDING', accepted: '1500000', price: '610', crates: 30 },
  ];

  for (const lot of lots) {
    const reserved = lot.state === 'PARTIALLY_RESERVED' ? '400000' : '0';
    const held = lot.state === 'QUARANTINED' ? lot.accepted : '0';
    await sql`
      INSERT INTO lots (lot_code, supplier_id, source_id, crop, harvest_date, state,
                        accepted_grams, reserved_grams, held_grams,
                        ask_price_per_kg_piastres, container_count,
                        packaging_spec_id, packaging_spec_version, collect_by)
      VALUES (${lot.code}, ${lot.supplier}, ${lot.supplier}, ${lot.crop}, now() - interval '1 day',
              ${lot.state}::lot_state, ${lot.accepted}::bigint, ${reserved}::bigint, ${held}::bigint,
              ${lot.price}::bigint, ${lot.crates},
              'plastic_standard', 2, now() + interval '3 days')
      ON CONFLICT (lot_code) DO NOTHING;
    `;
  }

  console.log(`  ${lots.length} lots`);

  const secret = process.env.AUTH_SIGNING_SECRET;
  if (secret && secret.length >= 32) {
    // Printed so a developer can curl the API immediately without building a
    // sign-in flow first. These are development tokens against a local secret.
    const tokens = await Promise.all([
      issueToken(
        { userId: ID.userSupplier, partyId: ID.nubaria, roles: ['supplier', 'ops_agent'], displayName: 'عبدالله عمر' },
        secret,
      ),
      issueToken(
        { userId: ID.userBuyer, partyId: ID.cairoPizza, roles: ['buyer'], displayName: 'مطاعم القاهرة للبيتزا' },
        secret,
      ),
      issueToken(
        { userId: ID.userInspector, partyId: ID.reharvest, roles: ['inspector'], displayName: 'فاطمة حسن' },
        secret,
      ),
      issueToken(
        { userId: ID.userOps, partyId: ID.reharvest, roles: ['ops_agent', 'ops_manager', 'finance'], displayName: 'إدارة ريهارفست' },
        secret,
      ),
    ]);

    console.log('\nDevelopment tokens (local secret only — never reuse in production):');
    ['supplier', 'buyer', 'inspector', 'ops'].forEach((role, i) => {
      console.log(`\n  ${role}:\n    ${tokens[i]}`);
    });
    console.log('\n  curl -H "Authorization: Bearer <token>" http://localhost:8787/lots\n');
  } else {
    console.log('\nAUTH_SIGNING_SECRET not set (or under 32 chars) — skipping token generation.');
  }

  console.log('Done.');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(() => sql.end());
