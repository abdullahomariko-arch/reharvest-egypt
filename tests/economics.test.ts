import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateOrderEconomics,
  evaluateEconomicGuardrails,
} from "../lib/economics.ts";

const baselineInput = {
  deliveredKg: 3_500,
  buyerPricePerKg: 9.5,
  supplierPricePerPurchasedKg: 4.75,
  sortingLossPct: 8,
  transportPerDeliveredKg: 1.8,
  handlingPerDeliveredKg: 0.35,
  inspectionPerDeliveredKg: 0.25,
  claimsReservePerDeliveredKg: 0.2,
};

test("calculates the transparent tomato pilot cost stack", () => {
  const result = calculateOrderEconomics(baselineInput);
  assert.equal(Math.round(result.purchasedKg), 3_804);
  assert.equal(Math.round(result.revenue), 33_250);
  assert.equal(Math.round(result.totalVariableCost), 27_171);
  assert.equal(Math.round(result.contribution), 6_079);
  assert.equal(result.contributionPerDeliveredKg.toFixed(2), "1.74");
  assert.equal(result.contributionMarginPct.toFixed(1), "18.3");
});

test("scales costs and contribution with delivered volume", () => {
  const large = calculateOrderEconomics(baselineInput);
  const small = calculateOrderEconomics({ ...baselineInput, deliveredKg: 1_200 });
  assert.equal((large.contribution / small.contribution).toFixed(6), (3_500 / 1_200).toFixed(6));
  assert.equal(large.contributionPerDeliveredKg.toFixed(6), small.contributionPerDeliveredKg.toFixed(6));
});

test("rejects impossible loss assumptions", () => {
  assert.throws(
    () => calculateOrderEconomics({ ...baselineInput, sortingLossPct: 100 }),
    /sortingLossPct/,
  );
});

test("blocks a match below the pilot contribution rules", () => {
  const weak = calculateOrderEconomics({
    ...baselineInput,
    supplierPricePerPurchasedKg: 6.8,
    deliveredKg: 1_200,
  });
  const decision = evaluateEconomicGuardrails(weak, baselineInput.sortingLossPct);
  assert.equal(decision.approved, false);
  assert.ok(decision.failures.length >= 2);
});

test("approves the corrected baseline economics", () => {
  const result = calculateOrderEconomics(baselineInput);
  assert.equal(evaluateEconomicGuardrails(result, baselineInput.sortingLossPct).approved, true);
});

