/**
 * State machines. Every material object in ReHarvest moves through an explicit,
 * enumerated state. Transitions are data, not `if` statements scattered through
 * request handlers, so that the rules can be tested, audited and shown to an operator.
 *
 * The single most important idea here: **interest is not demand**. Only
 * `CONFIRMED` and `DEPOSIT_CLEARED` may create procurement exposure. (D14, D17, D24.)
 */

export type Role =
  | 'supplier'
  | 'buyer'
  | 'ops_agent'
  | 'inspector'
  | 'food_safety_officer'
  | 'finance'
  | 'ops_manager'
  | 'executive';

export interface TransitionContext {
  readonly actorId: string;
  readonly actorRoles: readonly Role[];
  readonly at: string;
  /** Set when the actor also created the record being approved. Used to block self-approval (D47, D50). */
  readonly actorCreatedRecord: boolean;
  readonly idempotencyKey: string;
  readonly reasons: readonly string[];
}

export interface Transition<S extends string, E extends string> {
  readonly from: S;
  readonly event: E;
  readonly to: S;
  readonly requiresRole: readonly Role[];
  /** Control domains that justify this edge; surfaced in the audit log and in the ops console. */
  readonly controls: readonly string[];
  readonly forbidSelfApproval?: boolean;
  readonly guard?: (ctx: TransitionContext) => string | null;
}

export class TransitionDenied extends Error {
  constructor(
    message: string,
    readonly reasonCode: string,
    readonly controls: readonly string[],
    readonly correctionPath: string,
  ) {
    super(message);
    this.name = 'TransitionDenied';
  }
}

export class Machine<S extends string, E extends string> {
  constructor(
    readonly name: string,
    readonly initial: S,
    readonly transitions: readonly Transition<S, E>[],
    /** States from which nothing may leave without an authorised release. */
    readonly terminal: readonly S[] = [],
  ) {}

  can(from: S, event: E): boolean {
    return this.transitions.some((t) => t.from === from && t.event === event);
  }

  next(from: S, event: E, ctx: TransitionContext): S {
    const t = this.transitions.find((x) => x.from === from && x.event === event);
    if (!t) {
      throw new TransitionDenied(
        `${this.name}: "${event}" is not allowed from "${from}".`,
        'TRANSITION_NOT_DEFINED',
        [],
        `Allowed from here: ${this.transitions
          .filter((x) => x.from === from)
          .map((x) => x.event)
          .join(', ') || 'nothing — this state is closed'}`,
      );
    }
    if (t.requiresRole.length && !t.requiresRole.some((r) => ctx.actorRoles.includes(r))) {
      throw new TransitionDenied(
        `${this.name}: "${event}" needs one of ${t.requiresRole.join(', ')}.`,
        'TRANSITION_ROLE_DENIED',
        t.controls,
        `Ask a ${t.requiresRole[0].replace(/_/g, ' ')} to approve this step.`,
      );
    }
    if (t.forbidSelfApproval && ctx.actorCreatedRecord) {
      throw new TransitionDenied(
        `${this.name}: you cannot approve a record you created.`,
        'SELF_APPROVAL_BLOCKED',
        ['D47', 'D50', ...t.controls],
        'Route to a second authorised approver.',
      );
    }
    const guardFailure = t.guard?.(ctx);
    if (guardFailure) {
      throw new TransitionDenied(`${this.name}: ${guardFailure}`, 'TRANSITION_GUARD_FAILED', t.controls, guardFailure);
    }
    return t.to;
  }
}

/* ------------------------------------------------------------------ *
 * Party (supplier / buyer)  — D01, D02, D13, D28, D52
 * ------------------------------------------------------------------ */

export type PartyState =
  | 'DRAFT'
  | 'IDENTITY_SUBMITTED'
  | 'UNDER_REVIEW'
  | 'ACTIVE'
  | 'RESTRICTED'
  | 'FROZEN'
  | 'OFFBOARDED';

export type PartyEvent =
  | 'submit_identity'
  | 'send_to_review'
  | 'approve'
  | 'reject'
  | 'restrict'
  | 'freeze'
  | 'unfreeze'
  | 'offboard';

export const partyMachine = new Machine<PartyState, PartyEvent>(
  'Party',
  'DRAFT',
  [
    { from: 'DRAFT', event: 'submit_identity', to: 'IDENTITY_SUBMITTED', requiresRole: [], controls: ['D01', 'D13'] },
    {
      from: 'IDENTITY_SUBMITTED',
      event: 'send_to_review',
      to: 'UNDER_REVIEW',
      requiresRole: ['ops_agent'],
      controls: ['D01', 'D02'],
    },
    {
      from: 'UNDER_REVIEW',
      event: 'approve',
      to: 'ACTIVE',
      requiresRole: ['ops_manager'],
      controls: ['D01', 'D02', 'D13'],
      forbidSelfApproval: true,
    },
    { from: 'UNDER_REVIEW', event: 'reject', to: 'DRAFT', requiresRole: ['ops_manager'], controls: ['D01'] },
    { from: 'ACTIVE', event: 'restrict', to: 'RESTRICTED', requiresRole: ['ops_manager'], controls: ['D03', 'D18'] },
    { from: 'RESTRICTED', event: 'approve', to: 'ACTIVE', requiresRole: ['ops_manager'], controls: ['D03', 'D48'] },
    { from: 'ACTIVE', event: 'freeze', to: 'FROZEN', requiresRole: ['ops_manager', 'finance'], controls: ['D47', 'D52'] },
    { from: 'RESTRICTED', event: 'freeze', to: 'FROZEN', requiresRole: ['ops_manager'], controls: ['D47'] },
    {
      from: 'FROZEN',
      event: 'unfreeze',
      to: 'RESTRICTED',
      requiresRole: ['executive'],
      controls: ['D47', 'D50'],
      forbidSelfApproval: true,
    },
    { from: 'RESTRICTED', event: 'offboard', to: 'OFFBOARDED', requiresRole: ['ops_manager'], controls: ['D44'] },
  ],
  ['OFFBOARDED'],
);

/* ------------------------------------------------------------------ *
 * Demand / order — the state machine that stops perishable stock being
 * bought against a WhatsApp "yes maybe". D14, D16, D17, D21, D24.
 * ------------------------------------------------------------------ */

export type OrderState =
  | 'INTEREST'
  | 'QUOTED'
  | 'CONDITIONAL'
  | 'DEPOSIT_PENDING'
  | 'DEPOSIT_CLEARED'
  | 'CONFIRMED'
  | 'ALLOCATED'
  | 'IN_FULFILMENT'
  | 'DELIVERED_PENDING_ACCEPTANCE'
  | 'ACCEPTED'
  | 'PARTIALLY_ACCEPTED'
  | 'SETTLED'
  | 'CANCELLED'
  | 'DISPUTED';

export type OrderEvent =
  | 'quote'
  | 'buyer_accepts_quote'
  | 'request_deposit'
  | 'deposit_cleared'
  | 'confirm'
  | 'allocate_lots'
  | 'start_fulfilment'
  | 'mark_delivered'
  | 'buyer_accepts'
  | 'buyer_partially_accepts'
  | 'settle'
  | 'cancel'
  | 'raise_dispute'
  | 'resolve_dispute';

/**
 * Only these states may cause the platform to spend money on produce.
 * Anything else calling `assertMayCreateExposure` is a bug that would have
 * become trapped perishable stock.
 */
export const EXPOSURE_CREATING_STATES: readonly OrderState[] = ['DEPOSIT_CLEARED', 'CONFIRMED', 'ALLOCATED', 'IN_FULFILMENT'];

export function assertMayCreateProcurementExposure(state: OrderState): void {
  if (!EXPOSURE_CREATING_STATES.includes(state)) {
    throw new TransitionDenied(
      `An order in "${state}" cannot authorise buying produce. Buyer interest is not confirmed demand.`,
      'EXPOSURE_WITHOUT_CONFIRMED_DEMAND',
      ['D14', 'D16', 'D23'],
      'Take a cleared deposit or a signed confirmation first, or purchase against the approved speculative risk budget instead.',
    );
  }
}

export const orderMachine = new Machine<OrderState, OrderEvent>(
  'Order',
  'INTEREST',
  [
    { from: 'INTEREST', event: 'quote', to: 'QUOTED', requiresRole: ['ops_agent'], controls: ['D20', 'D21'] },
    { from: 'QUOTED', event: 'buyer_accepts_quote', to: 'CONDITIONAL', requiresRole: ['buyer'], controls: ['D15', 'D17'] },
    { from: 'CONDITIONAL', event: 'request_deposit', to: 'DEPOSIT_PENDING', requiresRole: ['ops_agent'], controls: ['D24'] },
    {
      from: 'DEPOSIT_PENDING',
      event: 'deposit_cleared',
      to: 'DEPOSIT_CLEARED',
      requiresRole: ['finance'],
      controls: ['D24', 'D28'],
      guard: (ctx) =>
        ctx.reasons.includes('funds_matched_to_bank_reference')
          ? null
          : 'A deposit is only cleared when payer, bank reference, amount and reversal status all match. A screenshot is not cleared money.',
    },
    {
      from: 'DEPOSIT_CLEARED',
      event: 'confirm',
      to: 'CONFIRMED',
      requiresRole: ['ops_agent'],
      controls: ['D15', 'D17', 'D21'],
    },
    {
      from: 'CONDITIONAL',
      event: 'confirm',
      to: 'CONFIRMED',
      requiresRole: ['ops_manager'],
      controls: ['D14', 'D25'],
      forbidSelfApproval: true,
      guard: (ctx) =>
        ctx.reasons.includes('buyer_has_approved_credit_line')
          ? null
          : 'Confirming without a cleared deposit requires an approved credit line inside its limit and ageing rules.',
    },
    { from: 'CONFIRMED', event: 'allocate_lots', to: 'ALLOCATED', requiresRole: ['ops_agent'], controls: ['D09', 'D39'] },
    { from: 'ALLOCATED', event: 'start_fulfilment', to: 'IN_FULFILMENT', requiresRole: ['ops_agent'], controls: ['D35'] },
    { from: 'IN_FULFILMENT', event: 'mark_delivered', to: 'DELIVERED_PENDING_ACCEPTANCE', requiresRole: ['ops_agent'], controls: ['D29'] },
    { from: 'DELIVERED_PENDING_ACCEPTANCE', event: 'buyer_accepts', to: 'ACCEPTED', requiresRole: ['buyer'], controls: ['D15', 'D34'] },
    {
      from: 'DELIVERED_PENDING_ACCEPTANCE',
      event: 'buyer_partially_accepts',
      to: 'PARTIALLY_ACCEPTED',
      requiresRole: ['buyer'],
      controls: ['D27', 'D29', 'D34'],
    },
    { from: 'DELIVERED_PENDING_ACCEPTANCE', event: 'raise_dispute', to: 'DISPUTED', requiresRole: ['buyer', 'ops_agent'], controls: ['D27'] },
    { from: 'PARTIALLY_ACCEPTED', event: 'raise_dispute', to: 'DISPUTED', requiresRole: ['buyer'], controls: ['D27'] },
    {
      from: 'DISPUTED',
      event: 'resolve_dispute',
      to: 'PARTIALLY_ACCEPTED',
      requiresRole: ['ops_manager'],
      controls: ['D27', 'D48'],
      forbidSelfApproval: true,
    },
    {
      from: 'ACCEPTED',
      event: 'settle',
      to: 'SETTLED',
      requiresRole: ['finance'],
      controls: ['D26', 'D45'],
      forbidSelfApproval: true,
    },
    {
      from: 'PARTIALLY_ACCEPTED',
      event: 'settle',
      to: 'SETTLED',
      requiresRole: ['finance'],
      controls: ['D26', 'D27'],
      forbidSelfApproval: true,
    },
    { from: 'INTEREST', event: 'cancel', to: 'CANCELLED', requiresRole: ['buyer', 'ops_agent'], controls: ['D18'] },
    { from: 'QUOTED', event: 'cancel', to: 'CANCELLED', requiresRole: ['buyer', 'ops_agent'], controls: ['D18'] },
    { from: 'CONDITIONAL', event: 'cancel', to: 'CANCELLED', requiresRole: ['buyer', 'ops_agent'], controls: ['D18'] },
    { from: 'DEPOSIT_PENDING', event: 'cancel', to: 'CANCELLED', requiresRole: ['ops_agent'], controls: ['D18'] },
    {
      from: 'CONFIRMED',
      event: 'cancel',
      to: 'CANCELLED',
      requiresRole: ['ops_manager'],
      controls: ['D18', 'D23'],
      guard: (ctx) =>
        ctx.reasons.some((r) => r.startsWith('cancellation_cost_owner:'))
          ? null
          : 'Cancelling confirmed demand strands perishable stock. Record who absorbs the committed cost before cancelling.',
    },
  ],
  ['SETTLED', 'CANCELLED'],
);

/* ------------------------------------------------------------------ *
 * Lot — D05, D09, D33, D39. A held lot is frozen for everything.
 * ------------------------------------------------------------------ */

export type LotState =
  | 'DECLARED'
  | 'SOURCE_VERIFIED'
  | 'INSPECTION_PENDING'
  | 'AVAILABLE'
  | 'PARTIALLY_RESERVED'
  | 'FULLY_RESERVED'
  | 'HELD'
  | 'QUARANTINED'
  | 'RELEASED_TO_ORDER'
  | 'CONSUMED'
  | 'DISPOSED'
  | 'EXPIRED';

export type LotEvent =
  | 'verify_source'
  | 'submit_for_inspection'
  | 'pass_inspection'
  | 'reserve'
  | 'reserve_fully'
  | 'unreserve'
  | 'place_hold'
  | 'quarantine'
  | 'release_hold'
  | 'food_safety_release'
  | 'release_to_order'
  | 'consume'
  | 'dispose'
  | 'expire';

/** No sale, mix, split, settlement or deletion may touch a lot in these states. */
export const FROZEN_LOT_STATES: readonly LotState[] = ['HELD', 'QUARANTINED', 'DISPOSED', 'EXPIRED'];

export function assertLotIsTradeable(state: LotState, lotId: string): void {
  if (FROZEN_LOT_STATES.includes(state)) {
    throw new TransitionDenied(
      `Lot ${lotId} is ${state.toLowerCase()} and cannot be sold, mixed, split or settled.`,
      'LOT_FROZEN',
      ['D09', 'D31', 'D33', 'D39'],
      state === 'QUARANTINED'
        ? 'Only an authorised food safety officer can close a critical hold. Lowering the price is not a resolution.'
        : 'Resolve and record the disposition of the hold first.',
    );
  }
}

export const lotMachine = new Machine<LotState, LotEvent>(
  'Lot',
  'DECLARED',
  [
    { from: 'DECLARED', event: 'verify_source', to: 'SOURCE_VERIFIED', requiresRole: ['ops_agent'], controls: ['D05', 'D06'] },
    { from: 'SOURCE_VERIFIED', event: 'submit_for_inspection', to: 'INSPECTION_PENDING', requiresRole: ['ops_agent'], controls: ['D30'] },
    {
      from: 'INSPECTION_PENDING',
      event: 'pass_inspection',
      to: 'AVAILABLE',
      requiresRole: ['inspector'],
      controls: ['D29', 'D30', 'D34'],
      guard: (ctx) =>
        ctx.reasons.includes('sample_plan_complete')
          ? null
          : 'The generated sample plan is not complete. Convenience sampling hides exactly the defects that cause rejection later.',
    },
    { from: 'AVAILABLE', event: 'reserve', to: 'PARTIALLY_RESERVED', requiresRole: ['ops_agent'], controls: ['D09'] },
    { from: 'PARTIALLY_RESERVED', event: 'reserve', to: 'PARTIALLY_RESERVED', requiresRole: ['ops_agent'], controls: ['D09'] },
    { from: 'PARTIALLY_RESERVED', event: 'reserve_fully', to: 'FULLY_RESERVED', requiresRole: ['ops_agent'], controls: ['D09'] },
    { from: 'PARTIALLY_RESERVED', event: 'unreserve', to: 'AVAILABLE', requiresRole: ['ops_agent'], controls: ['D09'] },
    { from: 'FULLY_RESERVED', event: 'unreserve', to: 'PARTIALLY_RESERVED', requiresRole: ['ops_agent'], controls: ['D09'] },
    // A hold can be placed from anywhere a lot is alive.
    ...(['SOURCE_VERIFIED', 'INSPECTION_PENDING', 'AVAILABLE', 'PARTIALLY_RESERVED', 'FULLY_RESERVED'] as LotState[]).flatMap(
      (from): Transition<LotState, LotEvent>[] => [
        { from, event: 'place_hold', to: 'HELD', requiresRole: ['ops_agent', 'inspector', 'food_safety_officer'], controls: ['D39'] },
        { from, event: 'quarantine', to: 'QUARANTINED', requiresRole: ['inspector', 'food_safety_officer'], controls: ['D31', 'D32'] },
      ],
    ),
    { from: 'HELD', event: 'release_hold', to: 'AVAILABLE', requiresRole: ['ops_manager'], controls: ['D39'], forbidSelfApproval: true },
    {
      from: 'QUARANTINED',
      event: 'food_safety_release',
      to: 'AVAILABLE',
      requiresRole: ['food_safety_officer'],
      controls: ['D31', 'D32', 'D54'],
      forbidSelfApproval: true,
      guard: (ctx) =>
        ctx.reasons.includes('lab_or_documented_basis_recorded')
          ? null
          : 'A critical food-safety hold closes only on a recorded, authorised basis. Unknown safety status is never acceptable quality.',
    },
    { from: 'QUARANTINED', event: 'dispose', to: 'DISPOSED', requiresRole: ['food_safety_officer'], controls: ['D40'] },
    { from: 'HELD', event: 'dispose', to: 'DISPOSED', requiresRole: ['ops_manager'], controls: ['D40'], forbidSelfApproval: true },
    { from: 'FULLY_RESERVED', event: 'release_to_order', to: 'RELEASED_TO_ORDER', requiresRole: ['ops_agent'], controls: ['D33'] },
    { from: 'PARTIALLY_RESERVED', event: 'release_to_order', to: 'RELEASED_TO_ORDER', requiresRole: ['ops_agent'], controls: ['D33'] },
    { from: 'RELEASED_TO_ORDER', event: 'consume', to: 'CONSUMED', requiresRole: ['ops_agent'], controls: ['D39'] },
    { from: 'AVAILABLE', event: 'expire', to: 'EXPIRED', requiresRole: ['ops_agent'], controls: ['D07', 'D38'] },
    { from: 'PARTIALLY_RESERVED', event: 'expire', to: 'EXPIRED', requiresRole: ['ops_agent'], controls: ['D07', 'D38'] },
  ],
  ['CONSUMED', 'DISPOSED', 'EXPIRED'],
);

/* ------------------------------------------------------------------ *
 * Payment — D24, D26, D28. Beneficiary changes and payments are never
 * the same step, and never the same day without escalation.
 * ------------------------------------------------------------------ */

export type PaymentState =
  | 'DRAFT'
  | 'AWAITING_BENEFICIARY_COOLDOWN'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'SUBMITTED_TO_PSP'
  | 'CLEARED'
  | 'FAILED'
  | 'REVERSED';

export type PaymentEvent =
  | 'prepare'
  | 'beneficiary_changed'
  | 'cooldown_elapsed'
  | 'approve'
  | 'submit'
  | 'psp_cleared'
  | 'psp_failed'
  | 'reverse';

export const BENEFICIARY_COOLDOWN_HOURS = 24;

export const paymentMachine = new Machine<PaymentState, PaymentEvent>(
  'Payment',
  'DRAFT',
  [
    { from: 'DRAFT', event: 'prepare', to: 'PENDING_APPROVAL', requiresRole: ['finance'], controls: ['D26'] },
    {
      from: 'DRAFT',
      event: 'beneficiary_changed',
      to: 'AWAITING_BENEFICIARY_COOLDOWN',
      requiresRole: ['finance', 'ops_manager'],
      controls: ['D28'],
    },
    {
      from: 'PENDING_APPROVAL',
      event: 'beneficiary_changed',
      to: 'AWAITING_BENEFICIARY_COOLDOWN',
      requiresRole: ['finance', 'ops_manager'],
      controls: ['D28'],
    },
    {
      from: 'AWAITING_BENEFICIARY_COOLDOWN',
      event: 'cooldown_elapsed',
      to: 'PENDING_APPROVAL',
      requiresRole: ['finance'],
      controls: ['D28'],
      guard: (ctx) =>
        ctx.reasons.includes('beneficiary_reverified_out_of_band')
          ? null
          : `A changed bank account waits ${BENEFICIARY_COOLDOWN_HOURS}h and is re-verified on a channel the requester did not choose.`,
    },
    {
      from: 'PENDING_APPROVAL',
      event: 'approve',
      to: 'APPROVED',
      requiresRole: ['ops_manager', 'executive'],
      controls: ['D26', 'D47', 'D50'],
      forbidSelfApproval: true,
    },
    {
      from: 'APPROVED',
      event: 'submit',
      to: 'SUBMITTED_TO_PSP',
      requiresRole: ['finance'],
      controls: ['D53'],
      guard: (ctx) => (ctx.idempotencyKey ? null : 'An irreversible payment requires an idempotency key.'),
    },
    { from: 'SUBMITTED_TO_PSP', event: 'psp_cleared', to: 'CLEARED', requiresRole: [], controls: ['D24', 'D26'] },
    { from: 'SUBMITTED_TO_PSP', event: 'psp_failed', to: 'FAILED', requiresRole: [], controls: ['D53'] },
    { from: 'FAILED', event: 'prepare', to: 'PENDING_APPROVAL', requiresRole: ['finance'], controls: ['D26'] },
    { from: 'CLEARED', event: 'reverse', to: 'REVERSED', requiresRole: ['finance'], controls: ['D24', 'D27'] },
  ],
  ['REVERSED'],
);
