/**
 * Authorisation.
 *
 * Role and record ownership, kept in one file so the rules can be read together
 * rather than inferred from thirty handlers. Every check answers one of two
 * questions:
 *
 *   Do you hold a role that may do this at all?      (role)
 *   Is this particular record yours?                  (ownership)
 *
 * Both are needed. Role alone let one supplier set the settlement weight on
 * another supplier's produce — reproduced through HTTP, returning 200 with a
 * fabricated 986.5kg. Ownership alone would let a buyer pass a food-safety
 * inspection on a lot they had ordered.
 *
 * The default is refusal: a caller who is neither the record's owner nor
 * platform staff is denied, and new endpoints have to opt in deliberately.
 */

export interface Actor {
  readonly userId: string;
  readonly partyId: string;
  readonly roles: readonly string[];
}

export class Forbidden extends Error {
  constructor(
    message: string,
    readonly reasonCode: string,
    /** What the caller could legitimately do instead. */
    readonly correctionPath: string,
  ) {
    super(message);
    this.name = 'Forbidden';
  }
}

/** Roles belonging to the platform rather than to a trading counterparty. */
const PLATFORM_ROLES = ['ops_agent', 'ops_manager', 'finance', 'executive', 'inspector', 'food_safety_officer'];

/** Roles that make you a party to a trade, with interests of your own. */
const COUNTERPARTY_ROLES = ['supplier', 'buyer'];

/**
 * Platform staff, for the purpose of bypassing ownership checks.
 *
 * Holding a counterparty role disqualifies you, whatever else you hold. This is
 * not hypothetical: a supplier account carrying `ops_agent` was able to record
 * an intake weighing on a *different* supplier's lot, because the staff bypass
 * fired before ownership was ever considered — reproduced as a 200 setting a
 * fabricated 986.5kg settlement weight on someone else's produce.
 *
 * If a real employee also trades on the platform, they need two accounts. That
 * is the correct answer rather than an inconvenience: the alternative is a
 * person who can approve their own supply.
 */
export const isPlatformStaff = (actor: Actor): boolean =>
  actor.roles.some((r) => PLATFORM_ROLES.includes(r)) &&
  !actor.roles.some((r) => COUNTERPARTY_ROLES.includes(r));

export const hasRole = (actor: Actor, ...allowed: readonly string[]): boolean =>
  actor.roles.some((r) => allowed.includes(r));

function deny(message: string, reasonCode: string, correction: string): never {
  throw new Forbidden(message, reasonCode, correction);
}

/* ------------------------------------------------------------------ *
 * Lots
 * ------------------------------------------------------------------ */

export function assertMayListLot(actor: Actor): void {
  if (!hasRole(actor, 'supplier') && !isPlatformStaff(actor)) {
    deny(
      'Only a supplier can list a lot.',
      'ROLE_NOT_PERMITTED',
      'Buyers order from the market; suppliers list what they have.',
    );
  }
}

/**
 * Recording an intake weighing.
 *
 * This is the number both sides are paid on, so it is restricted twice: the
 * caller needs an intake role, and the lot must be theirs unless they are
 * platform staff doing the weighing at a collection point.
 */
export function assertMayWeighLot(actor: Actor, lot: { supplierId: string; lotCode: string }): void {
  if (!hasRole(actor, 'ops_agent', 'inspector', 'supplier')) {
    deny(
      'Your role cannot record an intake weighing.',
      'ROLE_NOT_PERMITTED',
      'Intake weighings are recorded by an ops agent or inspector at the station.',
    );
  }

  if (isPlatformStaff(actor)) return;

  if (lot.supplierId !== actor.partyId) {
    deny(
      `Lot ${lot.lotCode} belongs to another supplier.`,
      'NOT_YOUR_LOT',
      'You can only weigh lots your own business listed.',
    );
  }
}

/**
 * Passing or quarantining an inspection.
 *
 * Never the supplier and never the buyer, regardless of who owns the lot. A
 * supplier certifying their own produce is the conflict of interest the whole
 * inspection step exists to remove, and a buyer doing it would let them
 * quarantine a competitor's stock.
 */
export function assertMayInspect(actor: Actor): void {
  if (!hasRole(actor, 'inspector', 'food_safety_officer', 'ops_manager')) {
    deny(
      'Only an inspector or food safety officer can record an inspection.',
      'ROLE_NOT_PERMITTED',
      'A supplier cannot certify their own produce, and a buyer cannot certify what they are buying.',
    );
  }
}

/* ------------------------------------------------------------------ *
 * Orders
 * ------------------------------------------------------------------ */

export function assertMayPlaceOrder(actor: Actor): void {
  if (!hasRole(actor, 'buyer') && !isPlatformStaff(actor)) {
    deny(
      'Only a buyer can place an order.',
      'ROLE_NOT_PERMITTED',
      'Suppliers list lots; buyers order them.',
    );
  }
}

/**
 * Reading or acting on an order.
 *
 * Commercial terms are competitive information. Two kitchens buying the same
 * crop must not be able to read each other's prices by guessing an order code,
 * which was reproduced: buyer B read buyer A's order total over HTTP.
 */
export function assertMayAccessOrder(actor: Actor, order: { buyerId: string; orderCode: string }): void {
  if (isPlatformStaff(actor)) return;

  if (order.buyerId !== actor.partyId) {
    /*
      Deliberately the same message whether the order exists or not. Saying
      "not yours" for a real code and "not found" for an invented one turns
      this endpoint into a way to confirm which order codes are real.
    */
    deny(
      `No order ${order.orderCode} is available to you.`,
      'NOT_YOUR_ORDER',
      'You can only see orders your own business placed.',
    );
  }
}

/* ------------------------------------------------------------------ *
 * Internal endpoints
 * ------------------------------------------------------------------ */

/**
 * The audit integrity check.
 *
 * It reports whether the hash chain is intact, and how many entries exist. Left
 * open, it tells anyone on the network how much activity the platform has and
 * — more usefully to an attacker — whether tampering has been noticed yet.
 */
export function assertMayReadInternal(actor: Actor): void {
  if (!hasRole(actor, 'ops_manager', 'executive', 'finance')) {
    deny(
      'That endpoint is restricted.',
      'ROLE_NOT_PERMITTED',
      'Audit integrity is visible to ops managers, finance and executives.',
    );
  }
}
