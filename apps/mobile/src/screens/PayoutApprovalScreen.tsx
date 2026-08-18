/**
 * صرف مستحقات — Payout approval.
 *
 * The last screen before money leaves. Three rules meet here, and all three
 * exist because of things that have happened to other people:
 *
 *   D28 — the person who prepared a payment cannot approve it. Same-person
 *         prepare-and-approve is how money leaves quietly, and it is the single
 *         control every auditor looks for first.
 *
 *   D28 — a beneficiary account changed within the last 24 hours cannot be paid.
 *         The standard fraud is a WhatsApp message from a "supplier" with new
 *         bank details an hour before the payment run. The cooldown costs a day
 *         and stops the entire class of attack.
 *
 *   D47 — the execution key is derived from the settlement id, never the clock,
 *         so a timeout and a retry produce the same key and the PSP deduplicates
 *         instead of paying twice.
 *
 * None of these are enforced here. They are enforced in the core guard and on
 * the server; this screen surfaces them early so the finance clerk finds out
 * before they have chased an approver, not after.
 */

import React, { useMemo, useState } from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native';

import { Money } from '@reharvest/core/money';
import { BENEFICIARY_COOLDOWN_HOURS } from '@reharvest/core/state-machines';
import { color, space, type, radius, touch } from '../ui/theme';
import { Instrument, BlockCard, PrimaryButton, Pill } from '../ui/components';
import { useT, useLang } from '../i18n/index';

export interface Approver {
  readonly userId: string;
  readonly name: string;
  readonly roleLabel: string;
}

export interface PayoutApprovalProps {
  readonly settlementId: string;
  readonly supplierName: string;
  readonly amount: Money;
  readonly channel: 'wallet' | 'bank';
  readonly accountMasked: string;
  readonly preparedBy: Approver;
  readonly approvers: readonly Approver[];
  /** ISO timestamp of the last beneficiary change, or null if never changed. */
  readonly beneficiaryChangedAt: string | null;
  readonly now?: string;
  readonly onRelease: (input: {
    settlementId: string;
    approvedBy: string;
    idempotencyKey: string;
  }) => Promise<void>;
}

export default function PayoutApprovalScreen(props: PayoutApprovalProps) {
  const t = useT();
  const { lang } = useLang();
  const locale = lang === 'ar' ? 'ar-EG' : 'en-EG';

  const [approverId, setApproverId] = useState<string>(
    props.approvers.find((a) => a.userId !== props.preparedBy.userId)?.userId ?? props.preparedBy.userId,
  );
  const [busy, setBusy] = useState(false);
  const [released, setReleased] = useState(false);

  // Derived from the settlement, never from Date.now(). A retry after a timeout
  // must produce the identical key or it becomes a second payment.
  const idempotencyKey = `payout:${props.settlementId}`;

  const block = useMemo(() => {
    if (approverId === props.preparedBy.userId) {
      return { domainId: 'D28', reasonCode: 'SELF_APPROVAL_FORBIDDEN' as const };
    }

    if (props.beneficiaryChangedAt) {
      const changed = Date.parse(props.beneficiaryChangedAt);
      const now = Date.parse(props.now ?? new Date().toISOString());
      const hours = (now - changed) / 3_600_000;
      if (hours < BENEFICIARY_COOLDOWN_HOURS) {
        return {
          domainId: 'D28',
          reasonCode: 'BENEFICIARY_COOLDOWN' as const,
          hoursLeft: Math.ceil(BENEFICIARY_COOLDOWN_HOURS - hours),
        };
      }
    }

    return null;
  }, [approverId, props.preparedBy.userId, props.beneficiaryChangedAt, props.now]);

  const release = async () => {
    if (block) return;
    setBusy(true);
    try {
      await props.onRelease({ settlementId: props.settlementId, approvedBy: approverId, idempotencyKey });
      setReleased(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.content}>
      <Text style={type.eyebrow}>{props.settlementId}</Text>
      <Text style={[type.display, { marginTop: 2 }]}>{t('payout.title')}</Text>

      <View style={{ height: space.md }} />

      <Instrument
        caption={t('payout.amount')}
        value={Money.format(props.amount, 'en-EG').replace(/\s*(ج\.م|EGP)$/, '')}
        unit="EGP"
        rows={[
          { label: t('payout.to'), value: props.supplierName },
          { label: t('payout.account'), value: props.accountMasked },
          { label: t('payout.prepared'), value: props.preparedBy.name },
        ]}
      />

      <View style={{ height: space.md }} />

      <Text style={[type.label, { marginBottom: 8 }]}>{t('payout.approver')}</Text>

      {props.approvers.map((a) => {
        const on = a.userId === approverId;
        const isSelf = a.userId === props.preparedBy.userId;
        return (
          <Pressable
            key={a.userId}
            onPress={() => setApproverId(a.userId)}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            style={[s.opt, on && s.optOn]}
          >
            <View style={{ flex: 1 }}>
              <Text style={[type.bodyStrong, { fontSize: 15 }]}>{a.name}</Text>
              <Text style={[type.hint, { marginTop: 2 }]}>{a.roleLabel}</Text>
            </View>
            {isSelf ? <Pill label={t('payout.you')} variant="neutral" /> : null}
          </Pressable>
        );
      })}

      <Text style={[type.hint, { marginTop: 4 }]}>{t('payout.approverHint')}</Text>

      {block ? (
        <BlockCard
          message={
            block.reasonCode === 'SELF_APPROVAL_FORBIDDEN'
              ? t('payout.self.msg')
              : t('payout.cooldown.msg', { h: block.hoursLeft ?? 0 })
          }
          correction={
            block.reasonCode === 'SELF_APPROVAL_FORBIDDEN' ? t('payout.self.fix') : t('payout.cooldown.fix')
          }
          domainId={block.domainId}
          reasonCode={block.reasonCode}
        />
      ) : null}

      <View style={{ height: space.md }} />

      {released ? (
        <View style={{ alignItems: 'flex-start', marginBottom: space.sm }}>
          <Pill label={t('payout.releasedPill')} variant="good" />
        </View>
      ) : null}

      <PrimaryButton
        label={released ? t('payout.releasedCta') : t('payout.cta')}
        onPress={release}
        disabled={!!block || busy || released}
      />
      <Text style={[type.hint, { textAlign: 'center', marginTop: 11 }]}>{t('payout.foot')}</Text>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surface },
  content: { padding: space.md, paddingBottom: space.xxl },
  opt: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: touch.row,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.sm,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 9,
  },
  optOn: { borderColor: color.brand, borderWidth: 2, backgroundColor: color.brandSoft },
});
