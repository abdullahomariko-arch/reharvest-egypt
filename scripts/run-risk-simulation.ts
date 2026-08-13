import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { calculateOrderEconomics } from "../lib/economics.ts";

const SCENARIO_COUNT = 100_000;
const SEED = 20_260_813;

type Events = {
  buyerNoShow: boolean;
  supplierShortfall: boolean;
  partialRejection: boolean;
  vehicleBreakdown: boolean;
  paymentDefault: boolean;
  supplierReprice: boolean;
  foodSafetyIncident: boolean;
};

type Scenario = {
  quantity: number;
  buyerPrice: number;
  supplierPrice: number;
  sortingLossPct: number;
  transport: number;
  handling: number;
  inspection: number;
  claimsReserve: number;
  events: Events;
  eventValues: {
    shortfallPct: number;
    rejectionPct: number;
    repricePct: number;
    breakdownCost: number;
    diversionYieldPct: number;
    diversionPricePct: number;
    diversionCostPerKg: number;
    recoveryPct: number;
    unprotectedDiversionYieldPct: number;
    unprotectedDiversionPricePct: number;
    unprotectedDiversionCostPerKg: number;
    unprotectedRecoveryPct: number;
    breakdownDeteriorationPerKg: number;
    protectedCollectionCost: number;
    unprotectedCollectionCost: number;
    incidentCost: number;
  };
};

type Outcome = {
  contribution: number;
  contributionPerKg: number;
  contributionMarginPct: number;
  revenue: number;
  totalCost: number;
  category: "strong" | "viable" | "thin" | "loss" | "severeLoss";
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
const happens = (probability: number) => random() < probability;

function triangular(minimum: number, mode: number, maximum: number) {
  const u = random();
  const split = (mode - minimum) / (maximum - minimum);
  if (u < split) return minimum + Math.sqrt(u * (maximum - minimum) * (mode - minimum));
  return maximum - Math.sqrt((1 - u) * (maximum - minimum) * (maximum - mode));
}

function makeScenario(): Scenario {
  const buyerNoShow = happens(0.05);
  return {
    quantity: Math.round(triangular(500, 1_200, 3_500)),
    buyerPrice: triangular(8.5, 9.5, 11),
    supplierPrice: triangular(4, 4.75, 6.5),
    sortingLossPct: triangular(3, 8, 18),
    transport: triangular(1.2, 1.8, 3),
    handling: triangular(0.2, 0.35, 0.65),
    inspection: triangular(0.12, 0.25, 0.5),
    claimsReserve: triangular(0.1, 0.2, 0.7),
    events: {
      buyerNoShow,
      supplierShortfall: happens(0.08),
      partialRejection: happens(0.1),
      vehicleBreakdown: happens(0.03),
      paymentDefault: !buyerNoShow && happens(0.02),
      supplierReprice: happens(0.06),
      foodSafetyIncident: happens(0.001),
    },
    eventValues: {
      shortfallPct: between(0.05, 0.3),
      rejectionPct: between(0.05, 0.3),
      repricePct: between(0.05, 0.2),
      breakdownCost: between(600, 2_000),
      diversionYieldPct: between(0.65, 0.9),
      diversionPricePct: between(0.65, 0.85),
      diversionCostPerKg: between(0.5, 1.2),
      recoveryPct: between(0.1, 0.5),
      unprotectedDiversionYieldPct: between(0.3, 0.65),
      unprotectedDiversionPricePct: between(0.45, 0.7),
      unprotectedDiversionCostPerKg: between(0.8, 1.5),
      unprotectedRecoveryPct: between(0, 0.2),
      breakdownDeteriorationPerKg: between(0.08, 0.35),
      protectedCollectionCost: between(200, 1_000),
      unprotectedCollectionCost: between(500, 2_000),
      incidentCost: between(5_000, 20_000),
    },
  };
}

function classifyOutcome(contributionMarginPct: number, foodSafetyIncident: boolean): Outcome["category"] {
  if (foodSafetyIncident || contributionMarginPct < -20) return "severeLoss";
  if (contributionMarginPct < 0) return "loss";
  if (contributionMarginPct < 10) return "thin";
  if (contributionMarginPct < 20) return "viable";
  return "strong";
}

function resolveScenario(scenario: Scenario, protectedOperation: boolean): Outcome {
  const base = calculateOrderEconomics({
    deliveredKg: scenario.quantity,
    buyerPricePerKg: scenario.buyerPrice,
    supplierPricePerPurchasedKg: scenario.supplierPrice,
    sortingLossPct: scenario.sortingLossPct,
    transportPerDeliveredKg: scenario.transport,
    handlingPerDeliveredKg: scenario.handling,
    inspectionPerDeliveredKg: scenario.inspection,
    claimsReservePerDeliveredKg: scenario.claimsReserve,
  });

  let revenue = base.revenue;
  let totalCost = base.totalVariableCost;
  const { events, eventValues } = scenario;

  if (events.supplierReprice) {
    totalCost += base.purchaseCost * eventValues.repricePct;
  }

  if (events.supplierShortfall) {
    if (protectedOperation) {
      totalCost += base.purchaseCost * eventValues.shortfallPct * 0.2;
      totalCost += scenario.quantity * eventValues.shortfallPct * 0.25;
    } else {
      revenue -= base.revenue * eventValues.shortfallPct;
      totalCost -= base.purchaseCost * eventValues.shortfallPct;
    }
  }

  if (events.vehicleBreakdown) {
    totalCost += eventValues.breakdownCost;
    totalCost += scenario.quantity * eventValues.breakdownDeteriorationPerKg;
  }

  if (events.partialRejection && !events.buyerNoShow) {
    const rejectedKg = scenario.quantity * eventValues.rejectionPct;
    const salvageYield = protectedOperation ? eventValues.diversionYieldPct : eventValues.unprotectedDiversionYieldPct;
    const salvagePricePct = protectedOperation ? eventValues.diversionPricePct : eventValues.unprotectedDiversionPricePct;
    const lostBuyerRevenue = rejectedKg * scenario.buyerPrice;
    const salvageRevenue = rejectedKg * salvageYield * scenario.buyerPrice * salvagePricePct;
    revenue = revenue - lostBuyerRevenue + salvageRevenue;
    totalCost += rejectedKg * (protectedOperation ? eventValues.diversionCostPerKg : eventValues.unprotectedDiversionCostPerKg);
  }

  if (events.buyerNoShow) {
    const deposit = protectedOperation ? base.revenue * 0.3 : 0;
    const salvageYield = protectedOperation ? eventValues.diversionYieldPct : eventValues.unprotectedDiversionYieldPct;
    const salvagePricePct = protectedOperation ? eventValues.diversionPricePct : eventValues.unprotectedDiversionPricePct;
    revenue = deposit + scenario.quantity * salvageYield * scenario.buyerPrice * salvagePricePct;
    totalCost += scenario.quantity * (protectedOperation ? eventValues.diversionCostPerKg : eventValues.unprotectedDiversionCostPerKg);
  } else if (events.paymentDefault) {
    const deposit = protectedOperation ? base.revenue * 0.3 : 0;
    const balance = Math.max(0, revenue - deposit);
    const recovery = protectedOperation ? eventValues.recoveryPct : eventValues.unprotectedRecoveryPct;
    revenue = deposit + balance * recovery;
    totalCost += protectedOperation ? eventValues.protectedCollectionCost : eventValues.unprotectedCollectionCost;
  }

  if (events.foodSafetyIncident) {
    revenue = 0;
    totalCost += protectedOperation ? eventValues.incidentCost : eventValues.incidentCost * 1.5;
  }

  const contribution = revenue - totalCost;
  const contributionPerKg = contribution / scenario.quantity;
  const contributionMarginPct = revenue > 0 ? (contribution / revenue) * 100 : -100;

  return {
    contribution,
    contributionPerKg,
    contributionMarginPct,
    revenue,
    totalCost,
    category: classifyOutcome(contributionMarginPct, events.foodSafetyIncident),
  };
}

function percentile(sorted: number[], p: number) {
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function round(value: number, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function summarize(outcomes: Outcome[]) {
  const contributions = outcomes.map((item) => item.contribution).sort((a, b) => a - b);
  const contributionPerKg = outcomes.map((item) => item.contributionPerKg).sort((a, b) => a - b);
  const margins = outcomes.map((item) => item.contributionMarginPct).sort((a, b) => a - b);
  const counts = { strong: 0, viable: 0, thin: 0, loss: 0, severeLoss: 0 };
  for (const outcome of outcomes) counts[outcome.category] += 1;
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

  return {
    averageContributionEgp: round(mean(contributions)),
    medianContributionEgp: round(percentile(contributions, 0.5)),
    p05ContributionEgp: round(percentile(contributions, 0.05)),
    p95ContributionEgp: round(percentile(contributions, 0.95)),
    worstContributionEgp: round(contributions[0]),
    averageContributionPerKg: round(mean(contributionPerKg)),
    medianContributionPerKg: round(percentile(contributionPerKg, 0.5)),
    p05ContributionPerKg: round(percentile(contributionPerKg, 0.05)),
    medianContributionMarginPct: round(percentile(margins, 0.5)),
    probabilityOfLossPct: round(((counts.loss + counts.severeLoss) / outcomes.length) * 100),
    probabilityOfSevereLossPct: round((counts.severeLoss / outcomes.length) * 100),
    categories: Object.fromEntries(
      Object.entries(counts).map(([key, value]) => [key, { count: value, pct: round((value / outcomes.length) * 100) }]),
    ),
  };
}

const protectedOutcomes: Outcome[] = [];
const unprotectedOutcomes: Outcome[] = [];
const eventCounts: Record<keyof Events, number> = {
  buyerNoShow: 0,
  supplierShortfall: 0,
  partialRejection: 0,
  vehicleBreakdown: 0,
  paymentDefault: 0,
  supplierReprice: 0,
  foodSafetyIncident: 0,
};
const eventImpact = Object.fromEntries(
  (Object.keys(eventCounts) as (keyof Events)[]).map((event) => [event, { withCount: 0, withSum: 0, withoutCount: 0, withoutSum: 0 }]),
) as Record<keyof Events, { withCount: number; withSum: number; withoutCount: number; withoutSum: number }>;

for (let index = 0; index < SCENARIO_COUNT; index += 1) {
  const scenario = makeScenario();
  for (const event of Object.keys(eventCounts) as (keyof Events)[]) {
    if (scenario.events[event]) eventCounts[event] += 1;
  }
  const protectedOutcome = resolveScenario(scenario, true);
  protectedOutcomes.push(protectedOutcome);
  unprotectedOutcomes.push(resolveScenario(scenario, false));
  for (const event of Object.keys(eventCounts) as (keyof Events)[]) {
    if (scenario.events[event]) {
      eventImpact[event].withCount += 1;
      eventImpact[event].withSum += protectedOutcome.contribution;
    } else {
      eventImpact[event].withoutCount += 1;
      eventImpact[event].withoutSum += protectedOutcome.contribution;
    }
  }
}

const protectedSummary = summarize(protectedOutcomes);
const unprotectedSummary = summarize(unprotectedOutcomes);
const baseline = calculateOrderEconomics({
  deliveredKg: 3_500,
  buyerPricePerKg: 9.5,
  supplierPricePerPurchasedKg: 4.75,
  sortingLossPct: 8,
  transportPerDeliveredKg: 1.8,
  handlingPerDeliveredKg: 0.35,
  inspectionPerDeliveredKg: 0.25,
  claimsReservePerDeliveredKg: 0.2,
});

const result = {
  generatedAt: new Date().toISOString(),
  scenarioCount: SCENARIO_COUNT,
  seed: SEED,
  modelType: "Monte Carlo operational and unit-economics stress test",
  warning: "Stress-test assumptions are illustrative controls, not verified Egyptian market forecasts or measured event probabilities.",
  baseline: Object.fromEntries(Object.entries(baseline).map(([key, value]) => [key, round(value)])),
  assumptions: {
    orderQuantityKg: { min: 500, mode: 1_200, max: 3_500 },
    buyerPricePerKg: { min: 8.5, mode: 9.5, max: 11 },
    supplierPricePerKg: { min: 4, mode: 4.75, max: 6.5 },
    sortingLossPct: { min: 3, mode: 8, max: 18 },
    transportPerKg: { min: 1.2, mode: 1.8, max: 3 },
    eventProbabilitiesPct: {
      buyerNoShow: 5,
      supplierShortfall: 8,
      partialRejection: 10,
      vehicleBreakdown: 3,
      paymentDefaultAfterReceipt: 2,
      supplierReprice: 6,
      foodSafetyIncident: 0.1,
    },
    protectedControls: [
      "30% buyer deposit",
      "backup suppliers and split sourcing",
      "backup buyers and diversion workflow",
      "inspection before pickup",
      "backup transport and incident escalation",
    ],
  },
  observedEventCounts: Object.fromEntries(
    Object.entries(eventCounts).map(([key, value]) => [key, { count: value, pct: round((value / SCENARIO_COUNT) * 100) }]),
  ),
  eventImpactProtected: Object.fromEntries(
    Object.entries(eventImpact).map(([key, value]) => {
      const averageWithEvent = value.withSum / value.withCount;
      const averageWithoutEvent = value.withoutSum / value.withoutCount;
      return [key, {
        averageContributionWithEventEgp: round(averageWithEvent),
        averageContributionWithoutEventEgp: round(averageWithoutEvent),
        estimatedImpactEgp: round(averageWithEvent - averageWithoutEvent),
      }];
    }),
  ),
  protected: protectedSummary,
  unprotected: unprotectedSummary,
  controlImpact: {
    lossProbabilityReductionPoints: round(unprotectedSummary.probabilityOfLossPct - protectedSummary.probabilityOfLossPct),
    severeLossProbabilityReductionPoints: round(unprotectedSummary.probabilityOfSevereLossPct - protectedSummary.probabilityOfSevereLossPct),
    averageContributionImprovementEgp: round(protectedSummary.averageContributionEgp - unprotectedSummary.averageContributionEgp),
    p05ContributionImprovementEgp: round(protectedSummary.p05ContributionEgp - unprotectedSummary.p05ContributionEgp),
  },
};

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(currentDirectory, "../diagnostics/monte-carlo-results.json");
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify(result, null, 2));
