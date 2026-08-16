/**
 * The guard. Every blocking rule in ReHarvest passes through here so that four
 * things are always true and always testable:
 *
 *   1. The block has a reason the operator can read in Arabic or English.
 *   2. There is a correction path, not just a red screen.
 *   3. There is an authorised exception path — time-limited, scoped, reasoned.
 *   4. The decision, the rule version and the evidence are written to the audit log.
 *
 * A rule with no exception path gets worked around outside the system, which is
 * worse than a rule with a governed one.
 */

import { CONTROLS, type ControlRequirement, type DomainId } from './controls.generated.js';
import type { Role } from './state-machines.js';

export type Decision = 'ALLOW' | 'BLOCK' | 'HOLD' | 'ALLOW_WITH_EXCEPTION';

export interface EvidenceRef {
  readonly kind: 'photo' | 'document' | 'lab_result' | 'bank_reference' | 'signature' | 'reading';
  readonly id: string;
  readonly capturedAt: string;
  readonly capturedBy: string;
  readonly sha256?: string;
}

export interface GuardRequest {
  readonly domainId: DomainId;
  readonly action: string;
  readonly subjectId: string;
  readonly actorId: string;
  readonly actorRoles: readonly Role[];
  readonly at: string;
  readonly idempotencyKey?: string;
  readonly evidence: readonly EvidenceRef[];
  readonly facts: Readonly<Record<string, unknown>>;
}

export interface GuardOutcome {
  readonly decision: Decision;
  readonly domainId: DomainId;
  readonly reasonCode: string;
  /** Shown to the person who hit the block. Plain language, no system vocabulary. */
  readonly messageEn: string;
  readonly messageAr: string;
  readonly correctionPath: string;
  readonly control: ControlRequirement;
  readonly ruleVersion: string;
  readonly exception?: ActiveException;
}

/**
 * A rule predicate returns null to allow, or a failure describing what is wrong.
 * Predicates are pure: they read `facts`, never a database. That is what makes
 * the 2,160 catalog cases replayable as unit tests.
 */
export type RulePredicate = (req: GuardRequest) => RuleFailure | null;

export interface RuleFailure {
  readonly reasonCode: string;
  readonly messageEn: string;
  readonly messageAr: string;
  readonly correctionPath: string;
  /** HOLD means reversible pause pending information; BLOCK means do not proceed. */
  readonly severity: 'BLOCK' | 'HOLD';
}

export interface RuleRegistration {
  readonly domainId: DomainId;
  readonly ruleVersion: string;
  readonly appliesTo: readonly string[];
  readonly predicate: RulePredicate;
  /** Roles that may raise a time-limited exception. Empty means no exception is possible. */
  readonly exceptionApprovers: readonly Role[];
  readonly maxExceptionHours: number;
}

export interface ActiveException {
  readonly exceptionId: string;
  readonly domainId: DomainId;
  readonly scopeSubjectId: string;
  readonly reason: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly expiresAt: string;
}

export interface AuditSink {
  record(entry: AuditEntry): void;
}

export interface AuditEntry {
  readonly at: string;
  readonly actorId: string;
  readonly action: string;
  readonly subjectId: string;
  readonly domainId: DomainId;
  readonly decision: Decision;
  readonly reasonCode: string;
  readonly ruleVersion: string;
  readonly evidenceIds: readonly string[];
  readonly exceptionId?: string;
}

export class ControlRegistry {
  private rules = new Map<string, RuleRegistration[]>();
  private exceptions: ActiveException[] = [];

  constructor(private readonly audit: AuditSink) {}

  register(rule: RuleRegistration): this {
    for (const action of rule.appliesTo) {
      const list = this.rules.get(action) ?? [];
      list.push(rule);
      this.rules.set(action, list);
    }
    return this;
  }

  grantException(
    e: Omit<ActiveException, 'exceptionId'> & { exceptionId?: string },
    approverRoles: readonly Role[],
  ): ActiveException {
    const rule = [...this.rules.values()].flat().find((r) => r.domainId === e.domainId);
    if (!rule || rule.exceptionApprovers.length === 0) {
      throw new Error(
        `${e.domainId} has no exception path. ${CONTROLS[e.domainId].hardRule} is absolute — resolve the condition instead.`,
      );
    }
    if (!rule.exceptionApprovers.some((r) => approverRoles.includes(r))) {
      throw new Error(`Exceptions to ${e.domainId} need one of: ${rule.exceptionApprovers.join(', ')}.`);
    }
    const hours = (new Date(e.expiresAt).getTime() - new Date(e.approvedAt).getTime()) / 3_600_000;
    if (hours <= 0 || hours > rule.maxExceptionHours) {
      throw new Error(`Exceptions to ${e.domainId} last at most ${rule.maxExceptionHours}h.`);
    }
    if (!e.reason || e.reason.trim().length < 12) {
      throw new Error('An exception needs a reason someone else can understand later.');
    }
    const granted: ActiveException = { exceptionId: e.exceptionId ?? cryptoId(), ...e };
    this.exceptions.push(granted);
    return granted;
  }

  /** Evaluate every rule bound to this action. First failure wins; blocks beat holds. */
  evaluate(req: GuardRequest): GuardOutcome {
    const applicable = (this.rules.get(req.action) ?? []).filter((r) => r.domainId === req.domainId);
    const control = CONTROLS[req.domainId];

    for (const rule of applicable) {
      const failure = rule.predicate(req);
      if (!failure) continue;

      const exception = this.exceptions.find(
        (x) =>
          x.domainId === req.domainId &&
          x.scopeSubjectId === req.subjectId &&
          new Date(x.expiresAt) > new Date(req.at),
      );

      const decision: Decision = exception
        ? 'ALLOW_WITH_EXCEPTION'
        : failure.severity === 'HOLD'
          ? 'HOLD'
          : 'BLOCK';

      const outcome: GuardOutcome = {
        decision,
        domainId: req.domainId,
        reasonCode: failure.reasonCode,
        messageEn: failure.messageEn,
        messageAr: failure.messageAr,
        correctionPath: failure.correctionPath,
        control,
        ruleVersion: rule.ruleVersion,
        exception,
      };
      this.audit.record({
        at: req.at,
        actorId: req.actorId,
        action: req.action,
        subjectId: req.subjectId,
        domainId: req.domainId,
        decision,
        reasonCode: failure.reasonCode,
        ruleVersion: rule.ruleVersion,
        evidenceIds: req.evidence.map((e) => e.id),
        exceptionId: exception?.exceptionId,
      });
      return outcome;
    }

    const ruleVersion = applicable[0]?.ruleVersion ?? 'none';
    this.audit.record({
      at: req.at,
      actorId: req.actorId,
      action: req.action,
      subjectId: req.subjectId,
      domainId: req.domainId,
      decision: 'ALLOW',
      reasonCode: 'OK',
      ruleVersion,
      evidenceIds: req.evidence.map((e) => e.id),
    });
    return {
      decision: 'ALLOW',
      domainId: req.domainId,
      reasonCode: 'OK',
      messageEn: 'Allowed.',
      messageAr: 'مسموح.',
      correctionPath: '',
      control,
      ruleVersion,
    };
  }

  /** Throws unless the action may proceed. Used at the top of every write handler. */
  assert(req: GuardRequest): GuardOutcome {
    const outcome = this.evaluate(req);
    if (outcome.decision === 'BLOCK' || outcome.decision === 'HOLD') {
      throw new ControlBlocked(outcome);
    }
    return outcome;
  }
}

export class ControlBlocked extends Error {
  constructor(readonly outcome: GuardOutcome) {
    super(`${outcome.domainId} ${outcome.reasonCode}: ${outcome.messageEn}`);
    this.name = 'ControlBlocked';
  }
}

function cryptoId(): string {
  return 'exc_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/* ------------------------------------------------------------------ *
 * The P0 rule set. These are the ones that must exist before the pilot
 * takes a second order. Each maps to a hard rule in the generated registry.
 * ------------------------------------------------------------------ */

export const P0_RULES: readonly RuleRegistration[] = [
  {
    domainId: 'D01',
    ruleVersion: '2026.08.1',
    appliesTo: ['party.activate'],
    exceptionApprovers: [],
    maxExceptionHours: 0,
    predicate: (req) =>
      req.facts.identityVerified === true && req.facts.representativeAuthorityVerified === true
        ? null
        : {
            reasonCode: 'PARTY_IDENTITY_UNVERIFIED',
            severity: 'BLOCK',
            messageEn: 'This account cannot trade yet. Identity and the named representative both need verifying.',
            messageAr: 'لا يمكن تفعيل هذا الحساب. يلزم التحقق من الهوية ومن صفة الممثل المفوّض.',
            correctionPath: 'Upload the commercial registration and the representative ID, then send for review.',
          },
  },
  {
    domainId: 'D14',
    ruleVersion: '2026.08.1',
    appliesTo: ['procurement.commit'],
    exceptionApprovers: ['executive'],
    maxExceptionHours: 48,
    predicate: (req) =>
      req.facts.demandState === 'CONFIRMED' || req.facts.demandState === 'DEPOSIT_CLEARED'
        ? null
        : {
            reasonCode: 'EXPOSURE_WITHOUT_CONFIRMED_DEMAND',
            severity: 'BLOCK',
            messageEn:
              'Buying against this order would put cash into perishable stock that nobody has committed to take.',
            messageAr: 'الشراء على هذا الطلب يضع نقدًا في بضاعة سريعة التلف دون التزام مؤكد من المشتري.',
            correctionPath: 'Collect a deposit or a signed confirmation, or buy against the approved speculative budget.',
          },
  },
  {
    domainId: 'D24',
    ruleVersion: '2026.08.1',
    appliesTo: ['payment.markCleared'],
    exceptionApprovers: [],
    maxExceptionHours: 0,
    predicate: (req) =>
      req.facts.payerMatched === true &&
      req.facts.bankReferenceMatched === true &&
      req.facts.amountMatched === true &&
      req.facts.reversalStatus === 'none'
        ? null
        : {
            reasonCode: 'FUNDS_NOT_CLEARED',
            severity: 'BLOCK',
            messageEn: 'A transfer screenshot is not cleared money. Match payer, reference, amount and reversal status first.',
            messageAr: 'صورة التحويل ليست تحصيلًا فعليًا. طابِق المُحوِّل والمرجع البنكي والمبلغ وحالة الاسترداد أولًا.',
            correctionPath: 'Open the settlement matcher and link this payment to the bank line.',
          },
  },
  {
    domainId: 'D28',
    ruleVersion: '2026.08.1',
    appliesTo: ['payment.submit'],
    exceptionApprovers: ['executive'],
    maxExceptionHours: 4,
    predicate: (req) => {
      const changedAt = req.facts.beneficiaryChangedAt as string | undefined;
      if (!changedAt) return null;
      const hours = (new Date(req.at).getTime() - new Date(changedAt).getTime()) / 3_600_000;
      return hours >= 24
        ? null
        : {
            reasonCode: 'BENEFICIARY_COOLDOWN_ACTIVE',
            severity: 'BLOCK',
            messageEn: `This supplier's bank account changed ${Math.floor(hours)}h ago. Payment waits 24h and a callback on a number you already had.`,
            messageAr: 'تم تغيير الحساب البنكي لهذا المورد حديثًا. الدفع ينتظر ٢٤ ساعة مع تأكيد هاتفي على رقم مُسجَّل مسبقًا.',
            correctionPath: 'Call the supplier on the number recorded before the change, then record the re-verification.',
          };
    },
  },
  {
    domainId: 'D31',
    ruleVersion: '2026.08.1',
    appliesTo: ['lot.release', 'lot.sell', 'lot.settle'],
    exceptionApprovers: [],
    maxExceptionHours: 0,
    predicate: (req) =>
      req.facts.openCriticalFoodSafetyHolds === 0
        ? null
        : {
            reasonCode: 'FOOD_SAFETY_HOLD_OPEN',
            severity: 'BLOCK',
            messageEn: 'This lot has an open critical food-safety hold. It cannot be sold at any price.',
            messageAr: 'على هذه الشحنة تحفّظ حرج يتعلق بسلامة الغذاء. لا يجوز بيعها بأي سعر.',
            correctionPath: 'Only the food safety officer can close this, on a recorded basis. Discounting is not a resolution.',
          },
  },
  {
    domainId: 'D34',
    ruleVersion: '2026.08.1',
    appliesTo: ['weight.accept', 'settlement.post'],
    exceptionApprovers: [],
    maxExceptionHours: 0,
    predicate: (req) =>
      req.facts.scaleCalibrationValid === true && req.facts.netWeightPositive === true
        ? null
        : {
            reasonCode: 'WEIGHT_NOT_SETTLEABLE',
            severity: 'BLOCK',
            messageEn: 'This weight cannot settle money. Check the scale calibration and the tare template, then re-weigh.',
            messageAr: 'لا يصلح هذا الوزن للتسوية المالية. راجع معايرة الميزان ووزن الفارغ ثم أعد الوزن.',
            correctionPath: 'Recalibrate the scale or pick the correct crate tare, then capture the reading again.',
          },
  },
  {
    domainId: 'D47',
    ruleVersion: '2026.08.1',
    appliesTo: ['payment.approve', 'lot.release', 'party.activate', 'override.approve'],
    exceptionApprovers: [],
    maxExceptionHours: 0,
    predicate: (req) =>
      req.facts.createdByActor === true
        ? {
            reasonCode: 'SELF_APPROVAL_BLOCKED',
            severity: 'BLOCK',
            messageEn: 'You raised this. Someone else has to approve it.',
            messageAr: 'أنت من أنشأ هذا الإجراء، ويلزم اعتماده من شخص آخر.',
            correctionPath: 'Send it to a second approver from the same team.',
          }
        : null,
  },
  {
    domainId: 'D53',
    ruleVersion: '2026.08.1',
    appliesTo: ['payment.submit', 'settlement.post', 'lot.dispose'],
    exceptionApprovers: [],
    maxExceptionHours: 0,
    predicate: (req) =>
      req.idempotencyKey
        ? null
        : {
            reasonCode: 'IDEMPOTENCY_KEY_MISSING',
            severity: 'BLOCK',
            messageEn: 'This action cannot be undone, so it needs a key that stops it running twice after a lost connection.',
            messageAr: 'هذا إجراء لا يمكن التراجع عنه، ويحتاج مفتاحًا يمنع تنفيذه مرتين عند انقطاع الاتصال.',
            correctionPath: 'The client generates the key. If you are seeing this, retry from the app rather than the console.',
          },
  },
  {
    domainId: 'D54',
    ruleVersion: '2026.08.1',
    appliesTo: ['automation.execute'],
    exceptionApprovers: [],
    maxExceptionHours: 0,
    predicate: (req) => {
      const forbidden = ['food_safety_release', 'legal_determination', 'irreversible_payment'];
      const kind = req.facts.automatedDecisionKind as string;
      return forbidden.includes(kind)
        ? {
            reasonCode: 'AUTONOMOUS_DECISION_FORBIDDEN',
            severity: 'BLOCK',
            messageEn: 'A person has to make this call. The system can prepare it and show its reasoning, nothing more.',
            messageAr: 'هذا القرار يتخذه شخص مسؤول. يمكن للنظام تجهيزه وعرض مبرراته فقط.',
            correctionPath: 'Route to the named owner with the recommendation attached.',
          }
        : null;
    },
  },
];

export function buildP0Registry(audit: AuditSink): ControlRegistry {
  const registry = new ControlRegistry(audit);
  for (const rule of P0_RULES) registry.register(rule);
  return registry;
}
