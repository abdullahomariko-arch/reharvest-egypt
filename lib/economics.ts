export type EconomicsInput = {
  deliveredKg: number;
  buyerPricePerKg: number;
  supplierPricePerPurchasedKg: number;
  sortingLossPct: number;
  transportPerDeliveredKg: number;
  handlingPerDeliveredKg: number;
  inspectionPerDeliveredKg: number;
  claimsReservePerDeliveredKg: number;
  paymentFeePct?: number;
  otherPerDeliveredKg?: number;
};

export type OrderEconomics = {
  deliveredKg: number;
  purchasedKg: number;
  revenue: number;
  purchaseCost: number;
  transportCost: number;
  handlingCost: number;
  inspectionCost: number;
  claimsReserve: number;
  paymentCost: number;
  otherCost: number;
  totalVariableCost: number;
  landedCostPerDeliveredKg: number;
  contribution: number;
  contributionPerDeliveredKg: number;
  contributionMarginPct: number;
  breakEvenBuyerPricePerKg: number;
};

export type EconomicGuardrails = {
  minimumContributionPerKg: number;
  minimumContributionMarginPct: number;
  maximumSortingLossPct: number;
};

export const PILOT_GUARDRAILS: EconomicGuardrails = {
  minimumContributionPerKg: 1,
  minimumContributionMarginPct: 10,
  maximumSortingLossPct: 15,
};

function requireFinitePositive(value: number, field: string) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive finite number`);
  }
}

function requireFiniteNonNegative(value: number, field: string) {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative finite number`);
  }
}

export function calculateOrderEconomics(input: EconomicsInput): OrderEconomics {
  requireFinitePositive(input.deliveredKg, "deliveredKg");
  requireFinitePositive(input.buyerPricePerKg, "buyerPricePerKg");
  requireFiniteNonNegative(input.supplierPricePerPurchasedKg, "supplierPricePerPurchasedKg");
  requireFiniteNonNegative(input.transportPerDeliveredKg, "transportPerDeliveredKg");
  requireFiniteNonNegative(input.handlingPerDeliveredKg, "handlingPerDeliveredKg");
  requireFiniteNonNegative(input.inspectionPerDeliveredKg, "inspectionPerDeliveredKg");
  requireFiniteNonNegative(input.claimsReservePerDeliveredKg, "claimsReservePerDeliveredKg");

  const paymentFeePct = input.paymentFeePct ?? 0;
  const otherPerDeliveredKg = input.otherPerDeliveredKg ?? 0;
  requireFiniteNonNegative(paymentFeePct, "paymentFeePct");
  requireFiniteNonNegative(otherPerDeliveredKg, "otherPerDeliveredKg");

  if (!Number.isFinite(input.sortingLossPct) || input.sortingLossPct < 0 || input.sortingLossPct >= 100) {
    throw new RangeError("sortingLossPct must be between 0 and less than 100");
  }

  const usableYield = 1 - input.sortingLossPct / 100;
  const purchasedKg = input.deliveredKg / usableYield;
  const revenue = input.deliveredKg * input.buyerPricePerKg;
  const purchaseCost = purchasedKg * input.supplierPricePerPurchasedKg;
  const transportCost = input.deliveredKg * input.transportPerDeliveredKg;
  const handlingCost = input.deliveredKg * input.handlingPerDeliveredKg;
  const inspectionCost = input.deliveredKg * input.inspectionPerDeliveredKg;
  const claimsReserve = input.deliveredKg * input.claimsReservePerDeliveredKg;
  const paymentCost = revenue * (paymentFeePct / 100);
  const otherCost = input.deliveredKg * otherPerDeliveredKg;
  const totalVariableCost = purchaseCost + transportCost + handlingCost + inspectionCost + claimsReserve + paymentCost + otherCost;
  const contribution = revenue - totalVariableCost;

  return {
    deliveredKg: input.deliveredKg,
    purchasedKg,
    revenue,
    purchaseCost,
    transportCost,
    handlingCost,
    inspectionCost,
    claimsReserve,
    paymentCost,
    otherCost,
    totalVariableCost,
    landedCostPerDeliveredKg: totalVariableCost / input.deliveredKg,
    contribution,
    contributionPerDeliveredKg: contribution / input.deliveredKg,
    contributionMarginPct: (contribution / revenue) * 100,
    breakEvenBuyerPricePerKg: totalVariableCost / input.deliveredKg,
  };
}

export function evaluateEconomicGuardrails(
  economics: OrderEconomics,
  sortingLossPct: number,
  guardrails: EconomicGuardrails = PILOT_GUARDRAILS,
) {
  const failures: string[] = [];

  if (economics.contributionPerDeliveredKg < guardrails.minimumContributionPerKg) {
    failures.push(`Contribution must be at least EGP ${guardrails.minimumContributionPerKg.toFixed(2)}/kg`);
  }
  if (economics.contributionMarginPct < guardrails.minimumContributionMarginPct) {
    failures.push(`Contribution margin must be at least ${guardrails.minimumContributionMarginPct.toFixed(1)}%`);
  }
  if (sortingLossPct > guardrails.maximumSortingLossPct) {
    failures.push(`Sorting loss cannot exceed ${guardrails.maximumSortingLossPct.toFixed(1)}%`);
  }

  return {
    approved: failures.length === 0,
    failures,
  };
}

