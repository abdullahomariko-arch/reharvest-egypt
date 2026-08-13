import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deliveryRiskContexts, deliveryRiskDomains, generateDeliveryRiskCatalog } from "./delivery-risk-definitions.ts";

const SCENARIO_COUNT = 2_000_000;
const SEED = 20_260_814;

type DeliveryEvent = {
  id: string;
  label: string;
  probability: number;
  delayMin: number;
  delayMax: number;
  costMin: number;
  costMax: number;
  unprotectedFailureChance: number;
  protectedFailureChance: number;
  protectedDelayFactor: number;
  protectedCostFactor: number;
  cargoRisk?: boolean;
  safetyRisk?: boolean;
  readinessRisk?: boolean;
  control: string;
};

const events: DeliveryEvent[] = [
  { id: "lowFuel", label: "Fuel or range failure", probability: 0.028, delayMin: 45, delayMax: 240, costMin: 350, costMax: 2_200, unprotectedFailureChance: 0.34, protectedFailureChance: 0.015, protectedDelayFactor: 0.18, protectedCostFactor: 0.32, readinessRisk: true, control: "Fuel-range gate with 25% reserve and evidence for the primary plus two backups" },
  { id: "primaryTruckUnavailable", label: "Primary truck unavailable", probability: 0.038, delayMin: 60, delayMax: 360, costMin: 800, costMax: 4_500, unprotectedFailureChance: 0.48, protectedFailureChance: 0.055, protectedDelayFactor: 0.28, protectedCostFactor: 0.55, readinessRisk: true, control: "Three independent, verified truck-driver pairs with response-time confirmation" },
  { id: "mechanicalFailure", label: "Mechanical or electrical failure", probability: 0.027, delayMin: 60, delayMax: 420, costMin: 1_000, costMax: 6_000, unprotectedFailureChance: 0.41, protectedFailureChance: 0.075, protectedDelayFactor: 0.42, protectedCostFactor: 0.62, readinessRisk: true, control: "Vehicle-specific pre-trip inspection, defect history, and cargo-transfer playbook" },
  { id: "tireBrakeSafety", label: "Tire, brake, or steering defect", probability: 0.016, delayMin: 70, delayMax: 480, costMin: 1_200, costMax: 8_000, unprotectedFailureChance: 0.45, protectedFailureChance: 0.045, protectedDelayFactor: 0.35, protectedCostFactor: 0.58, safetyRisk: true, readinessRisk: true, control: "Non-overridable safety inspection gate and verified roadside/backup response" },
  { id: "driverUnavailable", label: "Driver absent, ill, or fatigued", probability: 0.032, delayMin: 45, delayMax: 300, costMin: 400, costMax: 2_800, unprotectedFailureChance: 0.39, protectedFailureChance: 0.05, protectedDelayFactor: 0.3, protectedCostFactor: 0.5, readinessRisk: true, control: "Primary and backup driver confirmation, fitness declaration, and acknowledgement expiry" },
  { id: "supplierNotReady", label: "Supplier or lot not ready", probability: 0.072, delayMin: 30, delayMax: 300, costMin: 300, costMax: 3_500, unprotectedFailureChance: 0.28, protectedFailureChance: 0.08, protectedDelayFactor: 0.4, protectedCostFactor: 0.55, control: "Expiring supplier readiness confirmation with live lot, quantity, labour, and price evidence" },
  { id: "pickupAccess", label: "Pickup gate or access failure", probability: 0.045, delayMin: 25, delayMax: 210, costMin: 150, costMax: 1_800, unprotectedFailureChance: 0.19, protectedFailureChance: 0.035, protectedDelayFactor: 0.35, protectedCostFactor: 0.48, control: "Verified pin, gate, contact, road access, loading slot, and second contact" },
  { id: "loadingDelay", label: "Crates, labour, or loading delay", probability: 0.095, delayMin: 20, delayMax: 180, costMin: 150, costMax: 1_600, unprotectedFailureChance: 0.12, protectedFailureChance: 0.025, protectedDelayFactor: 0.48, protectedCostFactor: 0.58, cargoRisk: true, control: "Crate count, loading labour, equipment, stack, and maximum-loading-time gate" },
  { id: "quantityWeightMismatch", label: "Quantity or scale mismatch", probability: 0.068, delayMin: 25, delayMax: 180, costMin: 250, costMax: 3_200, unprotectedFailureChance: 0.21, protectedFailureChance: 0.045, protectedDelayFactor: 0.42, protectedCostFactor: 0.5, cargoRisk: true, control: "Calibrated pickup/delivery weights, tare controls, display photos, and discrepancy block" },
  { id: "produceCondition", label: "Produce condition deterioration", probability: 0.061, delayMin: 20, delayMax: 240, costMin: 700, costMax: 7_500, unprotectedFailureChance: 0.31, protectedFailureChance: 0.105, protectedDelayFactor: 0.55, protectedCostFactor: 0.58, cargoRisk: true, control: "Lot-specific condition limits, shade/ventilation, time thresholds, and reinspections" },
  { id: "routeDisruption", label: "Closure, restriction, or wrong route", probability: 0.076, delayMin: 25, delayMax: 260, costMin: 250, costMax: 2_600, unprotectedFailureChance: 0.2, protectedFailureChance: 0.04, protectedDelayFactor: 0.42, protectedCostFactor: 0.56, control: "Verified plan A/B/C, truck restrictions, offline route packet, and revised ETA workflow" },
  { id: "severeTraffic", label: "Severe traffic or queue", probability: 0.14, delayMin: 20, delayMax: 150, costMin: 150, costMax: 1_500, unprotectedFailureChance: 0.08, protectedFailureChance: 0.025, protectedDelayFactor: 0.65, protectedCostFactor: 0.72, cargoRisk: true, control: "Risk-adjusted departure time, live condition check, stop sequence, and time buffer" },
  { id: "weatherExposure", label: "Heat, rain, flood, dust, or wind", probability: 0.052, delayMin: 25, delayMax: 300, costMin: 350, costMax: 4_500, unprotectedFailureChance: 0.24, protectedFailureChance: 0.07, protectedDelayFactor: 0.5, protectedCostFactor: 0.6, cargoRisk: true, safetyRisk: true, control: "Weather thresholds, local confirmation, protective equipment, and reapproval after changes" },
  { id: "communicationLoss", label: "Phone, network, or contact failure", probability: 0.071, delayMin: 15, delayMax: 160, costMin: 80, costMax: 900, unprotectedFailureChance: 0.16, protectedFailureChance: 0.025, protectedDelayFactor: 0.35, protectedCostFactor: 0.45, control: "Charged phone, power bank, backup channel/contact, offline packet, and missed-ack escalation" },
  { id: "buyerNotReady", label: "Buyer receiver or dock not ready", probability: 0.059, delayMin: 30, delayMax: 300, costMin: 350, costMax: 4_000, unprotectedFailureChance: 0.33, protectedFailureChance: 0.09, protectedDelayFactor: 0.42, protectedCostFactor: 0.58, cargoRisk: true, control: "Expiring buyer readiness confirmation, backup receiver, waiting limit, and diversion option" },
  { id: "evidenceFailure", label: "Missing or unreliable handoff evidence", probability: 0.047, delayMin: 15, delayMax: 150, costMin: 150, costMax: 2_000, unprotectedFailureChance: 0.18, protectedFailureChance: 0.03, protectedDelayFactor: 0.32, protectedCostFactor: 0.48, control: "Mandatory typed evidence, quality checks, immutable events, and witnessed exception" },
  { id: "cashPaymentProblem", label: "Route cash or payment failure", probability: 0.036, delayMin: 25, delayMax: 220, costMin: 300, costMax: 5_500, unprotectedFailureChance: 0.25, protectedFailureChance: 0.045, protectedDelayFactor: 0.35, protectedCostFactor: 0.42, control: "Approved route float, dual approval, verified beneficiaries, idempotency, and reconciliation" },
  { id: "securityIncident", label: "Theft, tamper, or personal-safety event", probability: 0.007, delayMin: 60, delayMax: 720, costMin: 2_000, costMax: 22_000, unprotectedFailureChance: 0.62, protectedFailureChance: 0.24, protectedDelayFactor: 0.62, protectedCostFactor: 0.7, cargoRisk: true, safetyRisk: true, control: "Safe routes/stops, low cash, seals, check-ins, duress escalation, and cargo quarantine" },
  { id: "foodSafetyIncident", label: "Food-safety or traceability incident", probability: 0.0015, delayMin: 120, delayMax: 1_440, costMin: 8_000, costMax: 50_000, unprotectedFailureChance: 0.92, protectedFailureChance: 0.72, protectedDelayFactor: 0.82, protectedCostFactor: 0.78, cargoRisk: true, safetyRisk: true, control: "Non-overridable quarantine, recipient trace, recall workflow, and evidence preservation" },
  { id: "appOffline", label: "App, storage, or integration unavailable", probability: 0.055, delayMin: 10, delayMax: 180, costMin: 80, costMax: 1_500, unprotectedFailureChance: 0.15, protectedFailureChance: 0.018, protectedDelayFactor: 0.28, protectedCostFactor: 0.4, control: "Numbered offline route packet, visible sync state, idempotency, and reviewed reconciliation" },
];

type OutcomeCounters = {
  onTime: number;
  recoveredLate: number;
  majorDelay: number;
  failed: number;
  safetyStop: number;
  cargoCompromised: number;
  multiIncident: number;
};

type EventAccumulator = {
  count: number;
  unprotectedFailures: number;
  protectedFailures: number;
  unprotectedDelay: number;
  protectedDelay: number;
  unprotectedLoss: number;
  protectedLoss: number;
};

function mulberry32(seed: number) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const random = mulberry32(SEED);
const between = (minimum: number, maximum: number) => minimum + random() * (maximum - minimum);

function triangular(minimum: number, mode: number, maximum: number) {
  const u = random();
  const split = (mode - minimum) / (maximum - minimum);
  if (u < split) return minimum + Math.sqrt(u * (maximum - minimum) * (mode - minimum));
  return maximum - Math.sqrt((1 - u) * (maximum - minimum) * (maximum - mode));
}

function round(value: number, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function percentile(sorted: Float64Array, fraction: number) {
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function freshCounters(): OutcomeCounters {
  return { onTime: 0, recoveredLate: 0, majorDelay: 0, failed: 0, safetyStop: 0, cargoCompromised: 0, multiIncident: 0 };
}

function classify(counters: OutcomeCounters, failed: boolean, safetyStop: boolean, delay: number, buffer: number, cargoCompromised: boolean, incidentCount: number) {
  if (safetyStop) counters.safetyStop += 1;
  else if (failed) counters.failed += 1;
  else if (delay <= buffer) counters.onTime += 1;
  else if (delay <= 120) counters.recoveredLate += 1;
  else counters.majorDelay += 1;
  if (cargoCompromised) counters.cargoCompromised += 1;
  if (incidentCount >= 2) counters.multiIncident += 1;
}

const protectedDelays = new Float64Array(SCENARIO_COUNT);
const unprotectedDelays = new Float64Array(SCENARIO_COUNT);
const protectedLosses = new Float64Array(SCENARIO_COUNT);
const unprotectedLosses = new Float64Array(SCENARIO_COUNT);
const protectedCounters = freshCounters();
const unprotectedCounters = freshCounters();
const eventAccumulators: Record<string, EventAccumulator> = Object.fromEntries(events.map((event) => [event.id, { count: 0, unprotectedFailures: 0, protectedFailures: 0, unprotectedDelay: 0, protectedDelay: 0, unprotectedLoss: 0, protectedLoss: 0 }]));

let protectedDelaySum = 0;
let unprotectedDelaySum = 0;
let protectedLossSum = 0;
let unprotectedLossSum = 0;
let preventedUnsafeDispatches = 0;
let recoveredByBackup = 0;

for (let index = 0; index < SCENARIO_COUNT; index += 1) {
  const cargoValue = triangular(6_000, 14_000, 45_000);
  const deliveryBuffer = triangular(20, 50, 100);
  let protectedDelay = 0;
  let unprotectedDelay = 0;
  let protectedLoss = between(90, 260); // preventive control overhead
  let unprotectedLoss = 0;
  let protectedFailed = false;
  let unprotectedFailed = false;
  let protectedSafetyStop = false;
  let unprotectedSafetyStop = false;
  let protectedCargoCompromised = false;
  let unprotectedCargoCompromised = false;
  let incidentCount = 0;

  for (const event of events) {
    if (random() >= event.probability) continue;
    incidentCount += 1;
    const intensity = between(0.65, 1.35);
    const delay = between(event.delayMin, event.delayMax) * intensity;
    const cost = between(event.costMin, event.costMax) * intensity;
    const resolutionRoll = random();
    const cargoRoll = random();
    const accumulator = eventAccumulators[event.id];

    accumulator.count += 1;
    unprotectedDelay += delay;
    protectedDelay += delay * event.protectedDelayFactor;
    unprotectedLoss += cost;
    protectedLoss += cost * event.protectedCostFactor;
    accumulator.unprotectedDelay += delay;
    accumulator.protectedDelay += delay * event.protectedDelayFactor;
    accumulator.unprotectedLoss += cost;
    accumulator.protectedLoss += cost * event.protectedCostFactor;

    const unprotectedEventFailed = resolutionRoll < Math.min(0.98, event.unprotectedFailureChance * intensity);
    const protectedEventFailed = resolutionRoll < Math.min(0.92, event.protectedFailureChance * intensity);

    if (unprotectedEventFailed) {
      unprotectedFailed = true;
      accumulator.unprotectedFailures += 1;
    }
    if (protectedEventFailed) {
      protectedFailed = true;
      accumulator.protectedFailures += 1;
    } else if (unprotectedEventFailed && event.readinessRisk) {
      preventedUnsafeDispatches += 1;
      if (event.id === "primaryTruckUnavailable" || event.id === "mechanicalFailure" || event.id === "lowFuel") recoveredByBackup += 1;
    }

    if (event.cargoRisk) {
      if (cargoRoll < Math.min(0.95, event.unprotectedFailureChance * 0.8 * intensity)) unprotectedCargoCompromised = true;
      if (cargoRoll < Math.min(0.85, event.protectedFailureChance * 0.7 * intensity)) protectedCargoCompromised = true;
    }

    if (event.safetyRisk && unprotectedEventFailed) unprotectedSafetyStop = true;
    if (event.safetyRisk && protectedEventFailed) protectedSafetyStop = true;
  }

  if (incidentCount >= 2) {
    const compounding = 1 + Math.min(0.9, (incidentCount - 1) * 0.18);
    unprotectedDelay *= compounding;
    unprotectedLoss *= compounding;
    protectedDelay *= 1 + Math.min(0.4, (incidentCount - 1) * 0.08);
    protectedLoss *= 1 + Math.min(0.28, (incidentCount - 1) * 0.055);
    const compoundRoll = random();
    if (compoundRoll < Math.min(0.65, incidentCount * 0.055)) unprotectedFailed = true;
    if (compoundRoll < Math.min(0.28, incidentCount * 0.012)) protectedFailed = true;
  }

  if (unprotectedFailed || unprotectedSafetyStop) unprotectedLoss += cargoValue * (unprotectedSafetyStop ? between(0.85, 1.25) : between(0.45, 0.9));
  if (protectedFailed || protectedSafetyStop) protectedLoss += cargoValue * (protectedSafetyStop ? between(0.65, 1.05) : between(0.25, 0.65));
  if (unprotectedCargoCompromised && !unprotectedFailed) unprotectedLoss += cargoValue * between(0.12, 0.45);
  if (protectedCargoCompromised && !protectedFailed) protectedLoss += cargoValue * between(0.08, 0.28);

  protectedDelays[index] = protectedDelay;
  unprotectedDelays[index] = unprotectedDelay;
  protectedLosses[index] = protectedLoss;
  unprotectedLosses[index] = unprotectedLoss;
  protectedDelaySum += protectedDelay;
  unprotectedDelaySum += unprotectedDelay;
  protectedLossSum += protectedLoss;
  unprotectedLossSum += unprotectedLoss;

  classify(protectedCounters, protectedFailed, protectedSafetyStop, protectedDelay, deliveryBuffer, protectedCargoCompromised, incidentCount);
  classify(unprotectedCounters, unprotectedFailed, unprotectedSafetyStop, unprotectedDelay, deliveryBuffer, unprotectedCargoCompromised, incidentCount);
}

protectedDelays.sort();
unprotectedDelays.sort();
protectedLosses.sort();
unprotectedLosses.sort();

function summarize(counters: OutcomeCounters, delays: Float64Array, losses: Float64Array, delaySum: number, lossSum: number) {
  const pct = (value: number) => round((value / SCENARIO_COUNT) * 100);
  return {
    onTimePct: pct(counters.onTime),
    recoveredLatePct: pct(counters.recoveredLate),
    majorDelayPct: pct(counters.majorDelay),
    failedDeliveryPct: pct(counters.failed),
    safetyStopPct: pct(counters.safetyStop),
    cargoCompromisedPct: pct(counters.cargoCompromised),
    multiIncidentPct: pct(counters.multiIncident),
    averageDisruptionDelayMinutes: round(delaySum / SCENARIO_COUNT),
    medianDisruptionDelayMinutes: round(percentile(delays, 0.5)),
    p95DisruptionDelayMinutes: round(percentile(delays, 0.95)),
    p99DisruptionDelayMinutes: round(percentile(delays, 0.99)),
    averageDisruptionLossEgp: round(lossSum / SCENARIO_COUNT),
    medianDisruptionLossEgp: round(percentile(losses, 0.5)),
    p95DisruptionLossEgp: round(percentile(losses, 0.95)),
    p99DisruptionLossEgp: round(percentile(losses, 0.99)),
    worstDisruptionLossEgp: round(losses[losses.length - 1]),
    counts: counters,
  };
}

const protectedSummary = summarize(protectedCounters, protectedDelays, protectedLosses, protectedDelaySum, protectedLossSum);
const unprotectedSummary = summarize(unprotectedCounters, unprotectedDelays, unprotectedLosses, unprotectedDelaySum, unprotectedLossSum);

const catalog = generateDeliveryRiskCatalog();
const eventImpact = events.map((event) => {
  const value = eventAccumulators[event.id];
  return {
    id: event.id,
    label: event.label,
    illustrativeProbabilityPct: round(event.probability * 100),
    observedCount: value.count,
    observedPct: round((value.count / SCENARIO_COUNT) * 100),
    unprotectedFailureWhenTriggeredPct: round((value.unprotectedFailures / value.count) * 100),
    protectedFailureWhenTriggeredPct: round((value.protectedFailures / value.count) * 100),
    averageUnprotectedDelayWhenTriggeredMinutes: round(value.unprotectedDelay / value.count),
    averageProtectedDelayWhenTriggeredMinutes: round(value.protectedDelay / value.count),
    averageUnprotectedDirectLossWhenTriggeredEgp: round(value.unprotectedLoss / value.count),
    averageProtectedDirectLossWhenTriggeredEgp: round(value.protectedLoss / value.count),
    control: event.control,
  };
}).sort((a, b) => (b.unprotectedFailureWhenTriggeredPct * b.observedPct) - (a.unprotectedFailureWhenTriggeredPct * a.observedPct));

const output = {
  generatedAt: new Date().toISOString(),
  scenarioCount: SCENARIO_COUNT,
  seed: SEED,
  modelType: "Paired Monte Carlo delivery-resilience stress test",
  warning: "All event rates, delays, costs, and mitigations are illustrative stress assumptions for control design. They are not measured ReHarvest probabilities, Egyptian market forecasts, legal limits, or insurance estimates.",
  catalog: {
    riskCount: catalog.length,
    domainCount: deliveryRiskDomains.length,
    contextCount: deliveryRiskContexts.length,
    criticalCount: catalog.filter((risk) => risk.severity === "Critical").length,
    dispatchBlockCount: catalog.filter((risk) => risk.blockDispatch).length,
  },
  protected: protectedSummary,
  unprotected: unprotectedSummary,
  controlImpact: {
    failedDeliveryReductionPoints: round(unprotectedSummary.failedDeliveryPct - protectedSummary.failedDeliveryPct),
    safetyStopReductionPoints: round(unprotectedSummary.safetyStopPct - protectedSummary.safetyStopPct),
    cargoCompromiseReductionPoints: round(unprotectedSummary.cargoCompromisedPct - protectedSummary.cargoCompromisedPct),
    onTimeImprovementPoints: round(protectedSummary.onTimePct - unprotectedSummary.onTimePct),
    p95DelayImprovementMinutes: round(unprotectedSummary.p95DisruptionDelayMinutes - protectedSummary.p95DisruptionDelayMinutes),
    p95LossImprovementEgp: round(unprotectedSummary.p95DisruptionLossEgp - protectedSummary.p95DisruptionLossEgp),
    averageLossImprovementEgp: round(unprotectedSummary.averageDisruptionLossEgp - protectedSummary.averageDisruptionLossEgp),
    preventedUnsafeDispatches,
    recoveredByBackup,
  },
  assumptions: {
    routeControlOverheadEgp: { minimum: 90, maximum: 260 },
    deliveryBufferMinutes: { minimum: 20, mode: 50, maximum: 100 },
    cargoValueEgp: { minimum: 6_000, mode: 14_000, maximum: 45_000 },
    pairedComparison: "The protected and unprotected operations receive the same random disruptions and severity rolls.",
    events: events.map((event) => ({ id: event.id, label: event.label, illustrativeProbabilityPct: round(event.probability * 100), control: event.control })),
  },
  eventImpact,
  releaseGates: [
    "Primary truck plus two independent backup truck-driver pairs confirmed for the exact route window.",
    "Fuel evidence proves route distance, detour allowance, and at least a 25% reserve for all three vehicles.",
    "Safety inspection passes tires, wheels, brakes, steering, lights, mirrors, horn, wipers, spare, jack, and tools.",
    "Engine, cooling, battery, leaks, warning lights, maintenance expiry, registration, insurance, and permits pass.",
    "Cargo bay is clean, dry, pest-free, odour-free, compatible with previous cargo, and inspector-approved.",
    "Payload, crate count, dimensions, axle distribution, stack, airflow, doors, and securement pass.",
    "Primary and backup drivers confirm fitness, qualification, rest, contactability, and route understanding.",
    "Supplier reconfirms exact lot, grade, quantity, price, readiness, labour, documents, gate, and loading window.",
    "Buyer reconfirms receiver and backup, gate, dock, unloading labour, scale, quantity, criteria, price, and payment.",
    "Route packet contains verified pins, plan A/B/C, restrictions, conditions, safe stops, buffer, and offline directions.",
    "Phones, chargers, power banks, airtime/data, backup contacts, offline order packet, and escalation tree pass.",
    "Pickup and delivery weight controls, required photos, signatures, lot/vehicle links, and audit events are ready.",
    "Weather and security conditions remain inside defined thresholds; material changes automatically revoke release.",
    "Route float, toll/fuel methods, deposits, payment recipients, limits, and duplicate-payment controls pass.",
    "Diversion buyer, safe holding point, incident owner, emergency contacts, and cargo-transfer procedure are confirmed.",
  ],
  fuelExample: {
    rule: "Never release a delivery with only one truck or an unverified fuel statement.",
    primaryEvidence: "Current gauge and odometer photos, receipt, declared consumption, calculated route plus 25% reserve.",
    backupRequirement: "Two independently verified truck-driver pairs with sufficient capacity, fuel range, hygiene approval, response time, and authority to activate.",
    automaticBlock: "Any missing, stale, inconsistent, or insufficient fuel/capacity evidence blocks dispatch and opens refuel or backup activation.",
  },
};

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const diagnosticsDirectory = resolve(scriptDirectory, "../diagnostics");
mkdirSync(diagnosticsDirectory, { recursive: true });
writeFileSync(resolve(diagnosticsDirectory, "delivery-resilience-results.json"), `${JSON.stringify(output, null, 2)}\n`);
writeFileSync(resolve(diagnosticsDirectory, "delivery-risk-catalog.json"), `${JSON.stringify({
  generatedAt: output.generatedAt,
  riskCount: catalog.length,
  domainCount: deliveryRiskDomains.length,
  contextCount: deliveryRiskContexts.length,
  warning: output.warning,
  risks: catalog,
}, null, 2)}\n`);
writeFileSync(resolve(diagnosticsDirectory, "delivery-risk-app-catalog.json"), `${JSON.stringify({
  generatedAt: output.generatedAt,
  riskCount: catalog.length,
  domainCount: deliveryRiskDomains.length,
  risks: catalog.map(({ id, domain, context, scenario, appControl, severity }) => ({
    id,
    domain,
    context,
    scenario,
    appControl,
    severity,
  })),
}, null, 2)}\n`);

console.log(JSON.stringify(output, null, 2));
