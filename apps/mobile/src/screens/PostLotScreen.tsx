/**
 * عرض شحنة — Supplier posts a lot.
 *
 * This is the screen that creates supply. Everything about it is arranged so the
 * supplier types what they can actually see (a scale reading, a crate count) and
 * the app derives everything that matters from that.
 *
 * The supplier never types a net weight. Net weight is the number both sides get
 * paid on, so it is computed, shown on the instrument, and not editable — a field
 * a person can type into is a field a person can round up.
 */

import React, { useMemo, useState } from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native';

import { Money, egp } from '@reharvest/core/money';
import { Qty, grams, kg, CRATE_SPECS, netFromGross, QuantityError } from '@reharvest/core/quantity';
import { color, space, type, radius, touch } from '../ui/theme';
import { Instrument, BlockCard, Field, PrimaryButton } from '../ui/components';
import { useT } from '../i18n/index';

const CROPS = [
  { id: 'tomato', ar: 'طماطم', en: 'Tomato' },
  { id: 'potato', ar: 'بطاطس', en: 'Potato' },
  { id: 'onion', ar: 'بصل', en: 'Onion' },
  { id: 'pepper', ar: 'فلفل', en: 'Pepper' },
  { id: 'orange', ar: 'برتقال', en: 'Orange' },
] as const;

export interface PostLotProps {
  readonly stationName: string;
  readonly onSubmit: (draft: {
    cropId: string;
    grossGrams: bigint;
    crateCount: number;
    netGrams: bigint;
    askPerKg: Money;
    idempotencyKey: string;
  }) => Promise<void>;
}

export default function PostLotScreen({ stationName, onSubmit }: PostLotProps) {
  const t = useT();
  const [cropId, setCropId] = useState<string>('tomato');
  const [gross, setGross] = useState('812.5');
  const [crates, setCrates] = useState('25');
  const [ask, setAsk] = useState('8.75');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  // One key per mount. A double-tap, or a retry after the network drops
  // mid-request, must not create a second lot.
  const idempotencyKey = useMemo(
    () => `lot:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 9)}`,
    [],
  );

  /**
   * Everything derived, in one place, so the render below has no arithmetic in
   * it. The rules run here — locally, before any network call — which is what
   * makes the refusal instant and makes the screen work with no signal.
   */
  const calc = useMemo(() => {
    const count = /^\d+$/.test(crates.trim()) ? Number(crates.trim()) : null;
    if (count === null || count <= 0) return { ready: false as const, blocked: null };

    let grossQty, price;
    try {
      grossQty = kg(gross);
      price = egp.fromDecimalString(ask);
    } catch {
      // Half-typed input is not an error worth shouting about. The instrument
      // simply shows no reading until there is something to read.
      return { ready: false as const, blocked: null };
    }

    try {
      // Throws if tare >= gross, which is the wrong-crate-template mistake.
      const net = netFromGross(grossQty, CRATE_SPECS.plastic_standard_v2, count);
      return {
        ready: true as const,
        blocked: null,
        net,
        tare: grams(grossQty.value - net.value),
        value: Money.perKgTimesGrams(price, net.value),
      };
    } catch (e) {
      if (e instanceof QuantityError) {
        return {
          ready: false as const,
          blocked: { domainId: 'D34', reasonCode: e.reasonCode, message: e.message },
        };
      }
      throw e;
    }
  }, [gross, crates, ask]);

  const submit = async () => {
    if (!calc.ready) return;
    setSubmitting(true);
    try {
      await onSubmit({
        cropId,
        grossGrams: kg(gross).value,
        crateCount: Number(crates),
        netGrams: calc.net.value,
        askPerKg: egp.fromDecimalString(ask),
        idempotencyKey,
      });
      setDone(true);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
      <Text style={type.eyebrow}>{stationName}</Text>
      <Text style={[type.display, { marginTop: 2 }]}>{t('post.title')}</Text>
      <Text style={[type.body, { marginTop: space.sm }]}>{t('post.lede')}</Text>

      <View style={{ height: space.lg }} />

      <Text style={[type.label, { marginBottom: 8 }]}>{t('post.crop')}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        {CROPS.map((c) => {
          const on = c.id === cropId;
          return (
            <Pressable
              key={c.id}
              onPress={() => setCropId(c.id)}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              style={[s.chip, on && s.chipOn]}
            >
              <Text style={[s.chipText, on && { color: color.onBrand }]}>{t(`crop.${c.id}`)}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      <View style={{ height: space.lg }} />

      <Field
        label={t('post.gross')}
        hint={t('post.grossHint')}
        value={gross}
        onChangeText={setGross}
      />
      <Field
        label={t('post.crates')}
        hint={t('post.cratesHint')}
        value={crates}
        onChangeText={setCrates}
        keyboardType="number-pad"
      />
      <Field label={t('post.ask')} value={ask} onChangeText={setAsk} />

      <Instrument
        caption={t('post.net')}
        value={calc.ready ? Qty.format(calc.net, 'en-EG').replace(' kg', '') : null}
        unit="kg"
        faulted={!!calc.blocked}
        note={calc.blocked ? t('post.netFail') : calc.ready ? t('post.netOk') : t('post.netIdle')}
        rows={
          calc.ready
            ? [
                { label: t('post.tare'), value: Qty.format(calc.tare, 'en-EG') },
                { label: t('post.value'), value: Money.format(calc.value), emphasis: true },
              ]
            : undefined
        }
      />

      {calc.blocked ? (
        <BlockCard
          message={t(`block.${calc.blocked.reasonCode}`)}
          correction={t(`block.${calc.blocked.reasonCode}.fix`)}
          domainId={calc.blocked.domainId}
          reasonCode={calc.blocked.reasonCode}
        />
      ) : null}

      <View style={{ height: space.md }} />

      <PrimaryButton
        label={done ? t('post.done') : t('post.cta')}
        onPress={submit}
        disabled={!calc.ready || submitting || done}
      />
      <Text style={[type.hint, { textAlign: 'center', marginTop: 11 }]}>{t('post.foot')}</Text>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surface },
  content: { padding: space.md, paddingBottom: space.xxl },
  chip: {
    minHeight: touch.min - 6,
    paddingHorizontal: 15,
    justifyContent: 'center',
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.pill,
  },
  chipOn: { backgroundColor: color.brand, borderColor: color.brand },
  chipText: { ...type.label, color: color.inkMuted },
});
