/**
 * شاشة الوزن والاستلام — Weigh and accept.
 *
 * This is the screen where money is decided, so it is the screen where the
 * controls have to be visible rather than implied. It is also the reference
 * implementation for every other form in the app:
 *
 *   1. The rule runs on the device, before the network. An operator standing in
 *      a packing house with one bar of signal finds out the tare is wrong in
 *      200ms, not after a failed sync.
 *   2. A refusal is a BlockCard: what is wrong, which rule, what to do next.
 *      Never a toast, never a red border with no words.
 *   3. Nothing irreversible leaves this screen without an idempotency key, so a
 *      double tap on a frozen phone cannot post the weight twice. (D53.)
 */

import React, { useMemo, useState, useCallback } from 'react';
import { View, Text, TextInput, Pressable, ScrollView, I18nManager, StyleSheet } from 'react-native';

import { kg, grams, Qty, QuantityError, assertSettlementWeight, type WeightSource } from '@reharvest/core/quantity';
import { Money, egp } from '@reharvest/core/money';
import { color, type, space, touch, radius, blockCard } from '../ui/theme';

I18nManager.allowRTL(true);

/* ------------------------------------------------------------------ *
 * BlockCard — the signature component.
 * ------------------------------------------------------------------ */

export interface Refusal {
  readonly severity: 'BLOCK' | 'HOLD';
  readonly reasonCode: string;
  readonly messageAr: string;
  readonly correctionPathAr: string;
  readonly domainId?: string;
  /** Present only when a governed exception path exists for this rule. */
  readonly exceptionApproverAr?: string;
}

export function BlockCard({ refusal, onRequestException }: { refusal: Refusal; onRequestException?: () => void }) {
  const isBlock = refusal.severity === 'BLOCK';
  return (
    <View style={isBlock ? blockCard.container : blockCard.holdContainer} accessibilityRole="alert">
      <Text style={[type.bodyStrong, { color: isBlock ? color.danger : color.amber }]}>{refusal.messageAr}</Text>

      <View style={{ height: space.sm }} />
      <Text style={[type.body, { color: color.ink }]}>{refusal.correctionPathAr}</Text>

      {refusal.exceptionApproverAr ? (
        <Pressable
          onPress={onRequestException}
          style={styles.exceptionButton}
          accessibilityLabel={`طلب استثناء من ${refusal.exceptionApproverAr}`}
        >
          <Text style={[type.label, { color: color.brandDeep }]}>
            طلب استثناء من {refusal.exceptionApproverAr}
          </Text>
        </Pressable>
      ) : null}

      <View style={{ height: space.sm }} />
      <Text style={[type.label, { color: color.inkMuted, fontSize: 13 }]}>
        {refusal.domainId ? `${refusal.domainId} · ` : ''}
        {refusal.reasonCode}
      </Text>
    </View>
  );
}

/* ------------------------------------------------------------------ *
 * Screen
 * ------------------------------------------------------------------ */

export interface WeighAndAcceptProps {
  readonly lotId: string;
  readonly cropAr: string;
  readonly supplierNameAr: string;
  readonly agreedPricePerKg: ReturnType<typeof egp.fromDecimalString>;
  readonly scale: WeightSource;
  readonly crateTareGrams: bigint;
  readonly onPost: (result: AcceptedWeight) => Promise<void>;
}

export interface AcceptedWeight {
  readonly lotId: string;
  readonly grossGrams: bigint;
  readonly tareGrams: bigint;
  readonly netGrams: bigint;
  readonly lineTotal: ReturnType<typeof egp.fromDecimalString>;
  readonly scaleId: string;
  readonly idempotencyKey: string;
}

export default function WeighAndAcceptScreen(props: WeighAndAcceptProps) {
  const [grossText, setGrossText] = useState('');
  const [crateCount, setCrateCount] = useState('');
  const [posting, setPosting] = useState(false);

  // One stable key per screen mount. Retrying after a dropped connection reuses
  // it, so the server can recognise the repeat instead of posting twice.
  const idempotencyKey = useMemo(
    () => `weigh:${props.lotId}:${Date.now().toString(36)}`,
    [props.lotId],
  );

  const evaluation = useMemo(() => evaluate(props, grossText, crateCount), [props, grossText, crateCount]);

  const post = useCallback(async () => {
    if (!evaluation.ok || posting) return;
    setPosting(true);
    try {
      await props.onPost({ ...evaluation.value, idempotencyKey });
    } finally {
      setPosting(false);
    }
  }, [evaluation, posting, props, idempotencyKey]);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={[type.label, { color: color.inkMuted }]}>{props.supplierNameAr}</Text>
      <Text style={type.display}>{props.cropAr}</Text>
      <Text style={[type.figure, { color: color.inkMuted }]}>{props.lotId}</Text>

      <View style={{ height: space.lg }} />

      <Field
        labelAr="الوزن القائم (كجم)"
        hintAr="اقرأ الرقم من الميزان كما هو"
        value={grossText}
        onChange={setGrossText}
        keyboardType="decimal-pad"
      />

      <Field
        labelAr="عدد الصناديق"
        hintAr={`وزن الصندوق الفارغ ${Number(props.crateTareGrams) / 1000} كجم حسب المواصفة المعتمدة`}
        value={crateCount}
        onChange={setCrateCount}
        keyboardType="number-pad"
      />

      <View style={{ height: space.lg }} />

      {/* The net weight is the number that becomes money, so it gets the
          largest type on the screen and is never editable by hand. */}
      <View style={styles.netPanel}>
        <Text style={[type.label, { color: color.brandSoft }]}>الوزن الصافي</Text>
        <Text style={[type.figureLarge, { color: '#FFFFFF' }]}>
          {evaluation.ok ? Qty.format(grams(evaluation.value.netGrams)) : '—'}
        </Text>
        <View style={{ height: space.sm }} />
        <Text style={[type.body, { color: color.brandSoft }]}>
          {evaluation.ok ? `${Money.format(evaluation.value.lineTotal)} على سعر ${Money.format(props.agreedPricePerKg)}/كجم` : 'أدخل الوزن وعدد الصناديق'}
        </Text>
      </View>

      {!evaluation.ok && evaluation.refusal ? (
        <>
          <View style={{ height: space.md }} />
          <BlockCard refusal={evaluation.refusal} />
        </>
      ) : null}

      <View style={{ height: space.lg }} />

      <Pressable
        onPress={post}
        disabled={!evaluation.ok || posting}
        style={[styles.primary, (!evaluation.ok || posting) && styles.primaryDisabled]}
        accessibilityRole="button"
      >
        <Text style={[type.bodyStrong, { color: evaluation.ok ? '#FFFFFF' : color.inkMuted }]}>
          {posting ? 'جارٍ التسجيل…' : 'تسجيل الوزن واستلام الشحنة'}
        </Text>
      </Pressable>

      <View style={{ height: space.sm }} />
      <Text style={[type.label, { color: color.inkMuted, textAlign: 'center' }]}>
        يُسجَّل هذا الوزن باسمك ولا يمكن تعديله لاحقًا إلا بسجل تصحيح معتمد
      </Text>
    </ScrollView>
  );
}

/* ------------------------------------------------------------------ *
 * The rule, run locally. Identical logic runs again server-side —
 * the client copy is for speed and clarity, never for authority.
 * ------------------------------------------------------------------ */

type Evaluation =
  | { ok: true; value: Omit<AcceptedWeight, 'idempotencyKey'>; refusal?: undefined }
  | { ok: false; refusal?: Refusal };

function evaluate(props: WeighAndAcceptProps, grossText: string, crateText: string): Evaluation {
  if (!grossText.trim() || !crateText.trim()) return { ok: false };

  try {
    assertSettlementWeight(props.scale);
  } catch (e) {
    return {
      ok: false,
      refusal: {
        severity: 'BLOCK',
        domainId: 'D34',
        reasonCode: (e as QuantityError).reasonCode ?? 'QTY_UNVERIFIED_SETTLEMENT_WEIGHT',
        messageAr: 'لا يصلح هذا الميزان للتسوية المالية — المعايرة منتهية أو غير مسجَّلة.',
        correctionPathAr: 'استخدم ميزانًا معايرًا، أو سجِّل المعايرة الجديدة قبل الاستلام.',
      },
    };
  }

  let gross;
  try {
    gross = kg(grossText);
  } catch {
    return {
      ok: false,
      refusal: {
        severity: 'BLOCK',
        domainId: 'D51',
        reasonCode: 'QTY_UNPARSEABLE',
        messageAr: 'صيغة الوزن غير مقروءة.',
        correctionPathAr: 'اكتب الوزن بالكيلوجرام، بثلاث خانات عشرية كحد أقصى، مثل ٨١٢٫٥',
      },
    };
  }

  const count = Number(crateText);
  if (!Number.isInteger(count) || count <= 0) {
    return {
      ok: false,
      refusal: {
        severity: 'BLOCK',
        domainId: 'D51',
        reasonCode: 'QTY_FRACTIONAL_COUNT',
        messageAr: 'عدد الصناديق يجب أن يكون رقمًا صحيحًا أكبر من صفر.',
        correctionPathAr: 'أعد عدّ الصناديق على الميزان.',
      },
    };
  }

  const tare = grams(BigInt(count) * props.crateTareGrams);

  try {
    const net = Qty.net(gross, tare);
    return {
      ok: true,
      value: {
        lotId: props.lotId,
        grossGrams: gross.value,
        tareGrams: tare.value,
        netGrams: net.value,
        lineTotal: Money.perKgTimesGrams(props.agreedPricePerKg, net.value),
        scaleId: props.scale.kind === 'verified-scale' ? props.scale.scaleId : '',
      },
    };
  } catch (e) {
    // The most common real failure: the wrong crate template is selected, so
    // the tare eats the whole load. Say that, rather than "invalid input".
    return {
      ok: false,
      refusal: {
        severity: 'BLOCK',
        domainId: 'D34',
        reasonCode: (e as QuantityError).reasonCode ?? 'QTY_NET_NOT_POSITIVE',
        messageAr: `وزن الفارغ (${Qty.format(tare)}) أكبر من أو يساوي الوزن القائم (${Qty.format(gross)}).`,
        correctionPathAr: 'تأكد من نوع الصندوق المختار ومن تصفير الميزان، ثم أعد الوزن.',
      },
    };
  }
}

/* ------------------------------------------------------------------ */

function Field({
  labelAr,
  hintAr,
  value,
  onChange,
  keyboardType,
}: {
  labelAr: string;
  hintAr: string;
  value: string;
  onChange: (v: string) => void;
  keyboardType: 'decimal-pad' | 'number-pad';
}) {
  return (
    <View style={{ marginBottom: space.md }}>
      <Text style={[type.label, { color: color.ink }]}>{labelAr}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        keyboardType={keyboardType}
        style={styles.input}
        placeholderTextColor={color.inkMuted}
      />
      <Text style={[type.label, { color: color.inkMuted, fontSize: 13, marginTop: space.xs }]}>{hintAr}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surface },
  content: { padding: space.lg, paddingBottom: space.xxl },
  input: {
    ...type.figure,
    color: color.ink,
    backgroundColor: color.surfaceSunk,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.md,
    minHeight: touch.min,
    paddingHorizontal: space.md,
    marginTop: space.sm,
    textAlign: 'right',
  },
  netPanel: {
    backgroundColor: color.brandDeep,
    borderRadius: radius.lg,
    padding: space.lg,
  },
  primary: {
    backgroundColor: color.brand,
    minHeight: touch.primary,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryDisabled: { backgroundColor: color.line },
  exceptionButton: {
    marginTop: space.md,
    minHeight: touch.min,
    borderRadius: radius.sm,
    borderWidth: 1.5,
    borderColor: color.brand,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.md,
  },
});
