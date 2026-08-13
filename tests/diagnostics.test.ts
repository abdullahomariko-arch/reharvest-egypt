import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("stores exactly 100,000 reproducible diagnostic scenarios", async () => {
  const url = new URL("../diagnostics/monte-carlo-results.json", import.meta.url);
  const diagnostics = JSON.parse(await readFile(url, "utf8"));
  assert.equal(diagnostics.scenarioCount, 100_000);
  assert.equal(diagnostics.seed, 20_260_813);
  assert.equal(diagnostics.baseline.contributionPerDeliveredKg, 1.74);
  assert.equal(diagnostics.baseline.contributionMarginPct, 18.28);
  assert.ok(diagnostics.protected.probabilityOfLossPct > 0);
  assert.ok(diagnostics.controlImpact.p05ContributionImprovementEgp > 0);
});

test("the interface uses computed economics and exposes diagnostics", async () => {
  const url = new URL("../app/reharvest-app.tsx", import.meta.url);
  const source = await readFile(url, "utf8");

  assert.match(source, /tomatoPilotEconomics\.contributionPerDeliveredKg/);
  assert.match(source, /diagnostics\.scenarioCount/);
  assert.match(source, /Diagnostics/);
  assert.doesNotMatch(source, /EGP 8\.40/);
});
