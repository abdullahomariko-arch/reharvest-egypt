/**
 * تفاصيل الشحنة — Buyer order detail.
 *
 * The screen where a kitchen commits money. Two things it does that a normal
 * marketplace checkout does not:
 *
 * 1. It states, in plain words, that the balance is calculated on the weight
 *    actually received rather than the weight ordered. Buyers assume the
 *    opposite, and an assumption discovered at delivery becomes a dispute.
 *
 * 2. It refuses a quantity above what is available instead of accepting the
 *    order and sorting it out later. Overselling one lot to two kitchens is
 *    the single failure that loses both customers at once (D14).
 */

import React, { useMemo, useState } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';

import { Money, egp } from '@reharvest/core/money';
import { Qty, kg, type Quantity } from '@reharvest/core/quantity';
import { color, space, type, radius } from '../ui/theme';
import { Instrument, BlockCard, Field, PrimaryButton, Pill } from '../ui/components';
import { ProduceMark, type CropId } from '../ui/ProduceMark';
import { useT, useLang } from '../i18n/index';

/** 30% deposit. Held here as a constant so it is one edit, not a scatter of literals. */
const DEPOSIT_BASIS_POINTS = 3000n;

export interface OrderDetailProps {
  readonly lotId: string;
  readonly crop: CropId;
  readonly grade: 'A' | 'B' | 'C';
  readonly originName: string;
  readonly distanceKm: number;
  readonly pricePerKg: Money;
  readonly available: Quantity;
  readonly brix?: string;
  readonly inspectedAtLabel: string | null;
  readonly collectByLabel: string;
  readonly onReserve: (input: { lotId: string; quantity: Quantity; deposit: Money; idempotencyKey: string }) => Promise<void>;
}

export default function OrderDetailScreen(props: OrderDetailProps) {
  const t = useT();
  const { lang } = useLang();
  const locale = lang === 'ar' ? 'ar-EG' : 'en-EG';

  const [qtyText, setQtyText] = useState(() => String(Number(props.available.value / 1000n)));
  const [busy, setBusy] = useState(false);
  const [reserved, setReserved] = useState(false);

  const idempotencyKey = useMemo(
    () => `reserve:${props.lotId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
    [props.lotId],
  );

  const calc = useMemo(() => {
    let q;
    try {
      q = kg(qtyText);
    } catch {
      return { ready: false as const, over: false };
    }
    if (q.value <= 0n) return { ready: false as const, over: false };

    // D14 — availableToPromise must never go negative. Refuse at the point of
    // entry rather than letting the server discover it after the buyer has paid.
    if (q.value > props.available.value) {
      return { ready: false as const, over: true, requested: q };
    }

    const total = Money.perKgTimesGrams(props.pricePerKg, q.value);
    const deposit = egp.fromPiastres((total.amount * DEPOSIT_BASIS_POINTS + 5000n) / 10000n);
    const balance = Money.sub(total, deposit);
    return { ready: true as const, over: false, quantity: q, total, deposit, balance };
  }, [qtyText, props.available.value, props.pricePerKg]);

  const reserve = async () => {
    if (!calc.ready) return;
    setBusy(true);
    try {
      await props.onReserve({
        lotId: props.lotId,
        quantity: calc.quantity,
        deposit: calc.deposit,
        idempotencyKey,
      });
      setReserved(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
      <View style={{ flexDirection: 'row', gap: 14, alignItems: 'center' }}>
        <View style={s.thumb}>
          <ProduceMark crop={props.crop} size={40} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={type.title}>{t(`crop.${props.crop}`)}</Text>
          <Text style={[type.body, { marginTop: 3 }]} numberOfLines={1}>
            {props.originName} · {t('market.km', { n: props.distanceKm })}
          </Text>
        </View>
      </View>

      <View style={{ height: space.md }} />

      <View style={s.spec}>
        <SpecRow label={t('detail.grade')} value={`${props.grade} — ${t(`detail.grade.${props.grade}`)}`} />
        {props.brix ? <SpecRow label={t('detail.brix')} value={props.brix} mono /> : null}
        <SpecRow
          label={t('detail.inspected')}
          value={props.inspectedAtLabel ?? t('detail.notInspected')}
        />
        <SpecRow label={t('detail.window')} value={props.collectByLabel} />
        <SpecRow label={t('detail.available')} value={Qty.format(props.available, 'en-EG')} mono />
      </View>

      <View style={{ height: space.md }} />

      <Field
        label={t('detail.qty')}
        hint={t('detail.qtyHint', { q: Qty.format(props.available, locale) })}
        value={qtyText}
        onChangeText={setQtyText}
        keyboardType="number-pad"
      />

      <Instrument
        caption={t('detail.deposit')}
        value={calc.ready ? Money.format(calc.deposit, 'en-EG').replace(/\s*(ج\.م|EGP)$/, '') : null}
        unit="EGP"
        faulted={calc.over}
        note={calc.over ? t('detail.overNote') : t('detail.depositNote')}
        rows={
          calc.ready
            ? [
                { label: t('detail.unit'), value: Money.format(props.pricePerKg, 'en-EG').replace(/\s*(ج\.م|EGP)$/, '') },
                { label: t('detail.total'), value: Money.format(calc.total, 'en-EG').replace(/\s*(ج\.م|EGP)$/, '') },
                { label: t('detail.balance'), value: Money.format(calc.balance, 'en-EG').replace(/\s*(ج\.م|EGP)$/, '') },
              ]
            : undefined
        }
      />

      {calc.over ? (
        <BlockCard
          message={t('detail.over.msg', { q: Qty.format(props.available, locale) })}
          correction={t('detail.over.fix')}
          domainId="D14"
          reasonCode="ATP_EXCEEDED"
        />
      ) : null}

      <View style={{ height: space.md }} />
      <Text style={type.body}>{t('detail.settleNote')}</Text>
      <View style={{ height: space.sm }} />

      {reserved ? (
        <View style={{ alignItems: 'flex-start', marginBottom: space.sm }}>
          <Pill label={t('detail.reservedPill')} variant="good" />
        </View>
      ) : null}

      <PrimaryButton
        label={reserved ? t('detail.reservedCta') : t('detail.cta')}
        onPress={reserve}
        disabled={!calc.ready || busy || reserved}
      />
      <Text style={[type.hint, { textAlign: 'center', marginTop: 11 }]}>{t('detail.foot')}</Text>
    </ScrollView>
  );
}

function SpecRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={s.specRow}>
      <Text style={[type.body, { fontSize: 14 }]}>{label}</Text>
      <Text style={mono ? type.figure : [type.bodyStrong, { fontSize: 14 }]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surface },
  content: { padding: space.md, paddingBottom: space.xxl },
  thumb: {
    width: 66,
    height: 66,
    borderRadius: 14,
    backgroundColor: color.surfaceSunk,
    alignItems: 'center',
    justifyContent: 'center',
  },
  spec: {
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  specRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 7,
  },
});
