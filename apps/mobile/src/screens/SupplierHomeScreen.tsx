/**
 * شحناتي — Supplier home.
 *
 * A packhouse foreman opens this app to answer one question, and it is not
 * "what have I listed". It is **"has anyone actually paid me"**. So money owed
 * sits at the top, and on every row the status is the loudest element — louder
 * than the crop name, louder than the weight.
 *
 * Rows are ordered by what needs the supplier's attention rather than by date:
 * a lot whose collection window closes today outranks one settled last week,
 * regardless of which was listed first.
 */

import React, { useMemo } from 'react';
import { View, Text, ScrollView, RefreshControl, StyleSheet } from 'react-native';

import { Money } from '@reharvest/core/money';
import { Qty, type Quantity } from '@reharvest/core/quantity';
import { color, space, type, LOT_STATUS } from '../ui/theme';
import { Card, Pill, Stat, PrimaryButton } from '../ui/components';
import { ProduceMark, type CropId } from '../ui/ProduceMark';
import { useT, useLang } from '../i18n/index';

export interface SupplierLot {
  readonly lotId: string;
  readonly crop: CropId;
  readonly net: Quantity;
  readonly containerCount: number;
  readonly status: keyof typeof LOT_STATUS;
  readonly listedAt: string;
  readonly buyerCount: number;
}

export interface SupplierHomeProps {
  readonly stationName: string;
  readonly lots: readonly SupplierLot[];
  readonly owed: Money;
  readonly refreshing?: boolean;
  readonly onRefresh?: () => void;
  readonly onOpenLot: (lotId: string) => void;
  readonly onPostLot: () => void;
}

/** Urgency first, then recency. A closing window is the only thing that can be too late to fix. */
const URGENCY: Record<string, number> = {
  WINDOW_CLOSING: 0,
  FROZEN: 1,
  AWAITING_DEPOSIT: 2,
  MATCHED: 3,
  RESERVED: 4,
  LISTED: 5,
  SETTLED: 6,
  DRAFT: 7,
};

export default function SupplierHomeScreen({
  stationName,
  lots,
  owed,
  refreshing = false,
  onRefresh,
  onOpenLot,
  onPostLot,
}: SupplierHomeProps) {
  const t = useT();
  const { lang } = useLang();
  const locale = lang === 'ar' ? 'ar-EG' : 'en-EG';

  const ordered = useMemo(
    () =>
      [...lots].sort(
        (a, b) =>
          (URGENCY[a.status] ?? 9) - (URGENCY[b.status] ?? 9) ||
          Date.parse(b.listedAt) - Date.parse(a.listedAt),
      ),
    [lots],
  );

  const listedCount = lots.filter((l) => l.status !== 'SETTLED' && l.status !== 'DRAFT').length;

  return (
    <ScrollView
      style={s.screen}
      contentContainerStyle={s.content}
      refreshControl={onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={color.brand} /> : undefined}
    >
      <Text style={type.eyebrow}>{stationName}</Text>

      <View style={{ height: space.sm }} />

      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Stat label={t('home.listed')} value={String(listedCount)} />
        {/* Money owed is shown without the currency suffix at this size —
            the label already says what it is, and the figure reads faster bare. */}
        <Stat label={t('home.owed')} value={Money.format(owed, locale).replace(/\s*(ج\.م|EGP)$/, '')} />
      </View>

      <View style={{ height: space.md }} />
      <Text style={type.eyebrow}>{t('home.current')}</Text>
      <View style={{ height: space.sm }} />

      {ordered.length === 0 ? (
        /* An empty screen is an instruction, not an apology. */
        <View style={s.empty}>
          <Text style={[type.title, { textAlign: 'center' }]}>{t('home.emptyTitle')}</Text>
          <Text style={[type.body, { textAlign: 'center', marginTop: 6 }]}>{t('home.emptyBody')}</Text>
          <View style={{ height: space.md }} />
          <PrimaryButton label={t('home.post')} onPress={onPostLot} />
        </View>
      ) : (
        ordered.map((lot) => {
          const status = LOT_STATUS[lot.status];
          return (
            <Card key={lot.lotId} onPress={() => onOpenLot(lot.lotId)}>
              <View style={{ flexDirection: 'row', gap: 13 }}>
                <View style={s.thumb}>
                  <ProduceMark crop={lot.crop} />
                </View>

                <View style={{ flex: 1 }}>
                  <View style={s.row1}>
                    <Text style={[type.bodyStrong, { fontSize: 15.5, fontWeight: '600', flex: 1 }]} numberOfLines={1}>
                      {t(`crop.${lot.crop}`)}
                    </Text>
                    <Text style={type.figure}>{Qty.format(lot.net, 'en-EG')}</Text>
                  </View>

                  <Text style={[type.hint, { marginTop: 3 }]}>
                    {t('home.containers', { n: lot.containerCount })}
                  </Text>

                  <View style={s.foot}>
                    <Pill label={status[lang]} variant={status.tone} />
                    {lot.buyerCount > 0 ? (
                      <Pill label={t('home.buyers', { n: lot.buyerCount })} />
                    ) : null}
                  </View>
                </View>
              </View>
            </Card>
          );
        })
      )}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surface },
  content: { padding: space.md, paddingBottom: space.xxl },
  thumb: {
    width: 52,
    height: 52,
    borderRadius: 11,
    backgroundColor: color.surfaceSunk,
    alignItems: 'center',
    justifyContent: 'center',
  },
  row1: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  foot: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 9, flexWrap: 'wrap' },
  empty: {
    borderWidth: 1,
    borderColor: color.line,
    borderStyle: 'dashed',
    borderRadius: 14,
    padding: space.lg,
  },
});
