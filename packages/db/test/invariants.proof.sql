-- Setup
INSERT INTO parties (id, kind, legal_name_ar, phone_e164, state)
VALUES ('11111111-1111-4111-8111-111111111111','supplier','محطة فرز النوبارية','+201001234567','ACTIVE')
ON CONFLICT DO NOTHING;

INSERT INTO lots (id, lot_code, supplier_id, source_id, crop, harvest_date, state,
                  accepted_grams, ask_price_per_kg_piastres, container_count,
                  packaging_spec_id, packaging_spec_version)
VALUES ('aaaaaaaa-1111-4111-8111-111111111111','LOT-TEST-001',
        '11111111-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111',
        'tomato', now(), 'AVAILABLE', 800000, 875, 25, 'plastic_standard', 2)
ON CONFLICT DO NOTHING;

\echo '--- TEST 1: over-committing a lot must fail (D14) ---'
DO $$ BEGIN
  UPDATE lots SET reserved_grams = 900000 WHERE lot_code = 'LOT-TEST-001';
  RAISE EXCEPTION 'FAIL: over-commit was allowed';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: over-commit refused';
END $$;

\echo '--- TEST 2: reserving within availability must succeed ---'
UPDATE lots SET reserved_grams = 800000 WHERE lot_code = 'LOT-TEST-001';
\echo 'PASS: legitimate reservation accepted'

\echo '--- TEST 3: a weighing where tare exceeds gross must fail (D34) ---'
DO $$ BEGIN
  INSERT INTO weighings (lot_id, gross_grams, tare_grams, net_grams, scale_id,
                         scale_calibration_valid_until, packaging_spec_id,
                         packaging_spec_version, captured_by, idempotency_key)
  VALUES ('aaaaaaaa-1111-4111-8111-111111111111', 812500, 850000, -37500, 'scale-01',
          now() + interval '1 year', 'plastic_standard', 2,
          '11111111-1111-4111-8111-111111111111', 'w-bad');
  RAISE EXCEPTION 'FAIL: impossible weighing was accepted';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: tare-exceeds-gross refused';
END $$;

\echo '--- TEST 4: net must equal gross minus tare exactly ---'
DO $$ BEGIN
  INSERT INTO weighings (lot_id, gross_grams, tare_grams, net_grams, scale_id,
                         scale_calibration_valid_until, packaging_spec_id,
                         packaging_spec_version, captured_by, idempotency_key)
  VALUES ('aaaaaaaa-1111-4111-8111-111111111111', 812500, 12500, 805000, 'scale-01',
          now() + interval '1 year', 'plastic_standard', 2,
          '11111111-1111-4111-8111-111111111111', 'w-fudged');
  RAISE EXCEPTION 'FAIL: fudged net weight accepted';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: arithmetic-mismatch refused';
END $$;

\echo '--- TEST 5: a correct weighing is accepted ---'
INSERT INTO weighings (lot_id, gross_grams, tare_grams, net_grams, scale_id,
                       scale_calibration_valid_until, packaging_spec_id,
                       packaging_spec_version, captured_by, idempotency_key)
VALUES ('aaaaaaaa-1111-4111-8111-111111111111', 812500, 12500, 800000, 'scale-01',
        now() + interval '1 year', 'plastic_standard', 2,
        '11111111-1111-4111-8111-111111111111', 'w-good');
\echo 'PASS: valid weighing accepted'

\echo '--- TEST 6: a recorded weighing cannot be edited (D53) ---'
DO $$ BEGIN
  UPDATE weighings SET net_grams = 900000 WHERE idempotency_key = 'w-good';
  RAISE EXCEPTION 'FAIL: weighing was editable';
EXCEPTION WHEN restrict_violation THEN RAISE NOTICE 'PASS: weighing is append-only';
END $$;

\echo '--- TEST 7: a recorded weighing cannot be deleted ---'
DO $$ BEGIN
  DELETE FROM weighings WHERE idempotency_key = 'w-good';
  RAISE EXCEPTION 'FAIL: weighing was deletable';
EXCEPTION WHEN restrict_violation THEN RAISE NOTICE 'PASS: weighing cannot be deleted';
END $$;

\echo '--- TEST 8: a duplicate idempotency key is rejected ---'
DO $$ BEGIN
  INSERT INTO weighings (lot_id, gross_grams, tare_grams, net_grams, scale_id,
                         scale_calibration_valid_until, packaging_spec_id,
                         packaging_spec_version, captured_by, idempotency_key)
  VALUES ('aaaaaaaa-1111-4111-8111-111111111111', 812500, 12500, 800000, 'scale-01',
          now() + interval '1 year', 'plastic_standard', 2,
          '11111111-1111-4111-8111-111111111111', 'w-good');
  RAISE EXCEPTION 'FAIL: duplicate weighing accepted';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'PASS: replay deduplicated';
END $$;

\echo '--- TEST 9: a lot cannot reach the market without a price ---'
DO $$ BEGIN
  INSERT INTO lots (lot_code, supplier_id, source_id, crop, harvest_date, state,
                    accepted_grams, ask_price_per_kg_piastres)
  VALUES ('LOT-TEST-NOPRICE','11111111-1111-4111-8111-111111111111',
          '11111111-1111-4111-8111-111111111111','tomato', now(), 'AVAILABLE', 800000, 0);
  RAISE EXCEPTION 'FAIL: priceless lot reached the market';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: priceless lot refused';
END $$;

\echo '--- TEST 10: a packaging spec must be complete or absent, never half ---'
DO $$ BEGIN
  INSERT INTO lots (lot_code, supplier_id, source_id, crop, harvest_date, state,
                    accepted_grams, ask_price_per_kg_piastres, packaging_spec_id)
  VALUES ('LOT-TEST-HALFSPEC','11111111-1111-4111-8111-111111111111',
          '11111111-1111-4111-8111-111111111111','tomato', now(), 'AVAILABLE', 800000, 875,
          'plastic_standard');
  RAISE EXCEPTION 'FAIL: half a packaging spec was accepted';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: incomplete spec refused';
END $$;
