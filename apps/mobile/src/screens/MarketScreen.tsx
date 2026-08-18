/**
 * السوق — Buyer market.
 *
 * A kitchen buyer is deciding between this and a phone call to the man they
 * already use. So each row answers the three things that phone call would:
 * price per kilo, how far away it is, and whether anyone has actually looked
 * at the goods.
 *
 * Lots near the end of their collection window are surfaced, not buried. That
 * is where the discount is, and it is also where the platform earns its margin,
 * so hiding it would be working against both sides at once.
 */

import React, { useMemo, useState } from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native';

import { Money } from '@reharvest/core/money';
import { Qty, type Quantity } from '@reharvest/core/quantity';
import { color, space, type, radius, touch } from '../ui/theme';
import { Card, Pill } from '../ui/components';
import { ProduceMark, type CropId } from '../ui/ProduceMark';
import { useT, useLang } from '../i18n/index';

export interface MarketLot {
  readonly lotId: string;
  readonly crop: CropId;
  readonly grade: 'A' | 'B' | 'C';
  readonly pricePerKg: Money;
  readonly available: Quantity;
  readonly originName: string;
  readonly distanceKm: number;
  readonly inspectedAt: string | null;
  readonly collectBy: string;
  readonly windowClosesToday: boolean;
}

type Filter = 'all' | 'near' | 'closing' | 'sauce';

export interface MarketProps {
  readonly lots: readonly MarketLot[];
  readonly onOpenLot: (lotId: string) => void;
}

export default function MarketScreen({ lots, onOpenLot }: MarketProps) {
  const t = useT();
  const { lang } = useLang();
  const [filter, setFilter] = useState<Filter>('all');

  const shown = useMemo(() => {
    switch (filter) {
      case 'near':
        return [...lots].sort((a, b) => a.distanceKm - b.distanceKm);
      case 'closing':
        return lots.filter((l) => l.windowClosesToday);
      case 'sauce':
        return lots.filter((l) => l.grade === 'B' || l.grade === 'C');
      default:
        return lots;
    }
  }, [lots, filter]);

  const closingCount = lots.filter((l) => l.windowClosesToday).length;

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.content}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingBottom: 4 }}>
        {(['all', 'near', 'closing', 'sauce'] as const).map((f) => {
          const on = f === filter;
          return (
            <Pressable
              key={f}
              onPress={() => setFilter(f)}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              style={[s.chip, on && s.chipOn]}
            >
              <Text style={[s.chipText, on && { color: color.onBrand }]}>{t(`market.f.${f}`)}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      <View style={{ height: space.md }} />

      {closingCount > 0 && filter !== 'closing' ? (
        <Pressable onPress={() => setFilter('closing')} style={s.notice}>
          <View style={s.noticeDot} />
          <View style={{ flex: 1 }}>
            <Text style={[type.bodyStrong, { fontSize: 14 }]}>{t('market.closingTitle', { n: closingCount })}</Text>
            <Text style={[type.hint, { marginTop: 3 }]}>{t('market.closingBody')}</Text>
          </View>
        </Pressable>
      ) : null}

      {shown.length === 0 ? (
        <View style={s.empty}>
          <Text style={[type.title, { textAlign: 'center' }]}>{t('market.emptyTitle')}</Text>
          <Text style={[type.body, { textAlign: 'center', marginTop: 6 }]}>{t('market.emptyBody')}</Text>
        </View>
      ) : (
        shown.map((lot) => (
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
                  {/* Price per kilo, bare. The unit is in the column header of
                      every price list in every market in Egypt; repeating it on
                      each row is noise. */}
                  <Text style={type.figure}>{Money.format(lot.pricePerKg, 'en-EG').replace(/\s*(ج\.م|EGP)$/, '')}</Text>
                </View>

                <Text style={[type.hint, { marginTop: 3 }]} numberOfLines={1}>
                  {lot.originName} · {t('market.km', { n: lot.distanceKm })} · {t('market.available', { q: Qty.format(lot.available, 'en-EG') })}
                </Text>

                <View style={s.foot}>
                  <Pill label={lot.grade} variant="neutral" />
                  {lot.inspectedAt ? <Pill label={t('market.inspected')} variant="good" /> : null}
                  {lot.windowClosesToday ? (
                    <Pill label={t('market.closesToday')} variant="bad" />
                  ) : (
                    <Pill label={t('market.collectBy', { d: lot.collectBy })} />
                  )}
                </View>
              </View>
            </View>
          </Card>
        ))
      )}
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
  notice: {
    flexDirection: 'row',
    gap: 11,
    alignItems: 'flex-start',
    backgroundColor: color.amberSoft,
    borderWidth: 1,
    borderColor: '#EBD9BB',
    borderRadius: radius.sm,
    padding: 13,
    marginBottom: 11,
  },
  noticeDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: color.amber, marginTop: 6 },
  empty: { borderWidth: 1, borderColor: color.line, borderStyle: 'dashed', borderRadius: 14, padding: space.lg },
});
