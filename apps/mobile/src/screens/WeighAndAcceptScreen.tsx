/**
 * الاستلام والوزن — Weigh and accept.
 *
 * The screen the whole business rests on. This is where a number becomes an
 * obligation: everything downstream — what the supplier is paid, what the buyer
 * is billed, what margin the platform books — is derived from the figure entered
 * here, and none of it can be corrected later without an audited reversal.
 *
 * Four things it refuses to do:
 *
 * 1. **Accept a net weight typed by a person.** Net is derived from gross minus
 *    a counted tare. There is no field for it.
 *
 * 2. **Settle against an uncalibrated scale.** `assertSettlementWeight` blocks a
 *    weight whose calibration certificate has expired. An out-of-calibration
 *    platform scale drifting 2% is 16kg on an 800kg load, every load, in one
 *    direction, and nobody notices for a season.
 *
 * 3. **Silently absorb a shortfall.** A delivery materially under the ordered
 *    quantity is flagged before acceptance, because the buyer is billed on this
 *    figure and needs to have agreed to it.
 *
 * 4. **Post twice.** The idempotency key is fixed per mount, so a double-tap or
 *    a retry after a timeout is one weighing, not two.
 */

import React, { useMemo, useState } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';

import { Money, egp } from '@reharvest/core/money';
import {
  Qty,
  kg,
  grams,
  netFromGross,
  assertSettlementWeight,
  QuantityError,
  type Quantity,
  type PackagingSpec,
  type WeightSource,
} from '@reharvest/core/quantity';
import { color, space, type } from '../ui/theme';
import { Instrument, BlockCard, Field, PrimaryButton, Pill } from '../ui/components';
import { useT, useLang } from '../i18n/index';

/** Below this, a shortfall is ordinary shrinkage. Above it, somebody must agree. */
const SHORTFALL_TOLERANCE_BP = 500n; // 5%

export interface WeighAndAcceptProps {
  readonly lotId: string;
  readonly cropLabel: string;
  readonly supplierName: string;
  readonly expectedNet: Quantity;
  readonly agreedPricePerKg: Money;
  readonly packagingSpec: PackagingSpec;
  readonly scale: WeightSource;
  readonly onRecord: (result: {
    lotId: string;
    grossGrams: bigint;
    containerCount: number;
    netGrams: bigint;
    lineTotal: Money;
    idempotencyKey: string;
  }) => Promise<void>;
}

export default function WeighAndAcceptScreen(props: WeighAndAcceptProps) {
  const t = useT();
  const { lang } = useLang();
  const locale = lang === 'ar' ? 'ar-EG' : 'en-EG';

  const [gross, setGross] = useState('');
  const [containers, setContainers] = useState('');
  const [busy, setBusy] = useState(false);
  const [recorded, setRecorded] = useState(false);

  // Fixed for the life of the mount. Deriving it from the clock would make a
  // retry after a timeout look like a second delivery.
  const idempotencyKey = useMemo(
    () => `weighing:${props.lotId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
    [props.lotId],
  );

  /** Checked once, before anything else, because it invalidates every reading. */
  const scaleFault = useMemo(() => {
    try {
      assertSettlementWeight(props.scale);
      return null;
    } catch (e) {
      return e instanceof QuantityError ? e.reasonCode : 'QTY_UNVERIFIED_SETTLEMENT_WEIGHT';
    }
  }, [props.scale]);

  const calc = useMemo(() => {
    if (scaleFault) return { ready: false as const, fault: scaleFault };

    const count = /^\d+$/.test(containers.trim()) ? Number(containers.trim()) : null;
    if (count === null || count <= 0) return { ready: false as const, fault: null };

    let grossQty: Quantity;
    try {
      grossQty = kg(gross);
    } catch {
      return { ready: false as const, fault: null };
    }

    try {
      const net = netFromGross(grossQty, props.packagingSpec, count);
      const difference = net.value - props.expectedNet.value;
      const shortfallLimit = (props.expectedNet.value * SHORTFALL_TOLERANCE_BP) / 10_000n;
      return {
        ready: true as const,
        fault: null,
        net,
        tare: grams(grossQty.value - net.value),
        difference,
        materiallyShort: -difference > shortfallLimit,
        lineTotal: Money.perKgTimesGrams(props.agreedPricePerKg, net.value),
      };
    } catch (e) {
      if (e instanceof QuantityError) return { ready: false as const, fault: e.reasonCode };
      throw e;
    }
  }, [gross, containers, scaleFault, props.packagingSpec, props.expectedNet, props.agreedPricePerKg]);

  const record = async () => {
    if (!calc.ready) return;
    setBusy(true);
    try {
      await props.onRecord({
        lotId: props.lotId,
        grossGrams: kg(gross).value,
        containerCount: Number(containers),
        netGrams: calc.net.value,
        lineTotal: calc.lineTotal,
        idempotencyKey,
      });
      setRecorded(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
      <Text style={type.eyebrow}>{props.lotId}</Text>
      <Text style={[type.display, { marginTop: 2 }]}>{props.cropLabel}</Text>
      <Text style={[type.body, { marginTop: 3 }]}>{props.supplierName}</Text>

      <View style={{ height: space.lg }} />

      <Field
        label={t('weigh.gross')}
        hint={t('weigh.grossHint')}
        value={gross}
        onChangeText={setGross}
      />
      <Field
        label={t('weigh.containers')}
        hint={t('weigh.containersHint')}
        value={containers}
        onChangeText={setContainers}
        keyboardType="number-pad"
      />

      <Instrument
        caption={t('weigh.net')}
        value={calc.ready ? Qty.format(calc.net, 'en-EG').replace(' kg', '') : null}
        unit="kg"
        faulted={!!calc.fault}
        note={calc.fault ? t('weigh.cannotRead') : calc.ready ? t('weigh.netOk') : t('weigh.netIdle')}
        rows={
          calc.ready
            ? [
                { label: t('weigh.tare'), value: Qty.format(calc.tare, 'en-EG') },
                { label: t('weigh.expected'), value: Qty.format(props.expectedNet, 'en-EG') },
                {
                  label: t('weigh.difference'),
                  value: `${calc.difference >= 0n ? '+' : ''}${Qty.format(grams(calc.difference), 'en-EG')}`,
                },
                { label: t('weigh.lineTotal'), value: Money.format(calc.lineTotal, 'en-EG'), emphasis: true },
              ]
            : undefined
        }
      />

      {calc.fault ? (
        <BlockCard
          message={t(`block.${calc.fault}`)}
          correction={t(`block.${calc.fault}.fix`)}
          domainId={calc.fault.startsWith('QTY_SCALE') || calc.fault.startsWith('QTY_UNVERIFIED') ? 'D26' : 'D34'}
          reasonCode={calc.fault}
        />
      ) : null}

      {/*
        A shortfall is a warning, not a block. The inspector is standing in front
        of the load; refusing to let them record what is actually on the scale
        would send the transaction back to WhatsApp. What it must not do is pass
        silently, so it is stated and it travels with the record.
      */}
      {calc.ready && calc.materiallyShort ? (
        <View style={s.warn}>
          <Text style={[type.bodyStrong, { color: color.amber, fontSize: 14.5 }]}>{t('weigh.short.msg')}</Text>
          <Text style={[type.body, { color: color.ink, marginTop: 6 }]}>{t('weigh.short.fix')}</Text>
          <Text style={[type.hint, { marginTop: 8 }]}>D24 · QTY_SHORT_VS_ORDER</Text>
        </View>
      ) : null}

      <View style={{ height: space.md }} />

      {recorded ? (
        <View style={{ alignItems: 'flex-start', marginBottom: space.sm }}>
          <Pill label={t('weigh.recordedPill')} variant="good" />
        </View>
      ) : null}

      <PrimaryButton
        label={recorded ? t('weigh.recordedCta') : t('weigh.cta')}
        onPress={record}
        disabled={!calc.ready || busy || recorded}
      />

      <Text style={[type.hint, { textAlign: 'center', marginTop: 11 }]}>
        {props.scale.kind === 'verified-scale'
          ? t('weigh.calibration', {
              id: props.scale.scaleId,
              d: new Date(props.scale.calibrationValidUntil).toLocaleDateString(locale),
            })
          : t('weigh.noScale')}
      </Text>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surface },
  content: { padding: space.md, paddingBottom: space.xxl },
  warn: {
    backgroundColor: color.amberSoft,
    borderStartWidth: 5,
    borderStartColor: color.amber,
    borderRadius: 10,
    padding: 14,
    marginTop: 14,
  },
});
