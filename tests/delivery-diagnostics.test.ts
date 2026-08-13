import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function readJson(relativePath: string) {
  return JSON.parse(await readFile(new URL(relativePath, import.meta.url), "utf8"));
}

test("stores exactly two million seeded delivery scenarios", async () => {
  const results = await readJson("../diagnostics/delivery-resilience-results.json");

  assert.equal(results.scenarioCount, 2_000_000);
  assert.equal(results.seed, 20_260_814);
  assert.equal(results.catalog.riskCount, 1_000);
  assert.equal(results.releaseGates.length, 15);
  assert.ok(results.protected.failedDeliveryPct < results.unprotected.failedDeliveryPct);
  assert.ok(results.protected.onTimePct > results.unprotected.onTimePct);
  assert.ok(results.protected.p95DisruptionDelayMinutes < results.unprotected.p95DisruptionDelayMinutes);
  assert.ok(results.controlImpact.preventedUnsafeDispatches > 0);
  assert.ok(results.controlImpact.recoveredByBackup > 0);
});

test("catalog contains one thousand complete and unique practical cases", async () => {
  const catalog = await readJson("../diagnostics/delivery-risk-catalog.json");
  const ids = new Set(catalog.risks.map((risk: { id: string }) => risk.id));
  const domains = new Set(catalog.risks.map((risk: { domain: string }) => risk.domain));
  const contexts = new Set(catalog.risks.map((risk: { context: string }) => risk.context));

  assert.equal(catalog.riskCount, 1_000);
  assert.equal(catalog.risks.length, 1_000);
  assert.equal(ids.size, 1_000);
  assert.equal(domains.size, 25);
  assert.equal(contexts.size, 5);
  for (const risk of catalog.risks) {
    for (const field of ["scenario", "consequence", "prevention", "detection", "fallback", "appControl", "requiredEvidence"]) {
      assert.ok(risk[field]?.length > 10, `${risk.id} is missing ${field}`);
    }
    assert.ok(risk.owner?.length > 2, `${risk.id} is missing owner`);
  }
});

test("fuel shortage and two-backup enforcement are built into the interface", async () => {
  const catalog = await readJson("../diagnostics/delivery-risk-catalog.json");
  const source = await readFile(new URL("../app/reharvest-app.tsx", import.meta.url), "utf8");
  const fuelCases = catalog.risks.filter((risk: { domain: string }) => risk.domain === "Fuel and range");

  assert.equal(fuelCases.length, 40);
  assert.ok(fuelCases.some((risk: { appControl: string }) => /two.*backup/i.test(risk.appControl)));
  assert.match(source, /Primary \+ two backups/);
  assert.match(source, /fuel-backup-two/);
  assert.match(source, /routeReady/);
  assert.match(source, /deliveryRiskCatalog\.risks/);
});
