/**
 * لوحة الإدارة — Ops dashboard.
 *
 * Deliberately not a metrics wall. Three numbers that describe how much trouble
 * the business could currently be in, then a queue of things that need a human
 * decision today.
 *
 * The concentration meter is the one people underrate. Revenue can look healthy
 * while a third of the exposure sits with a single kitchen, and the day that
 * kitchen stops paying is the day the whole quarter goes. It is shown as a share
 * of money at risk, never as a count of buyers, because five buyers where one is
 * 80% of the book is not diversification (D53).
 */

import React from 'react';
import { View, Text, ScrollView, Pressable, RefreshControl, StyleSheet } from 'react-native';

import { Money } from '@reharvest/core/money';
import { color, space, type, radius } from '../ui/theme';
import { Stat } from '../ui/components';
import { useT, useLang } from '../i18n/index';

export type AlertLevel = 'info' | 'warn' | 'stop';

export interface OpsAlert {
  readonly id: string;
  readonly level: AlertLevel;
  readonly title: string;
  readonly detail: string;
  readonly onOpen?: () => void;
}

export interface OpsDashboardProps {
  readonly openExposure: Money;
  readonly realisedMarginPct: string;
  readonly concentrationPct: number;
  readonly concentrationCeilingPct: number;
  readonly alerts: readonly OpsAlert[];
  readonly refreshing?: boolean;
  readonly onRefresh?: () => void;
}

export default function OpsDashboardScreen({
  openExposure,
  realisedMarginPct,
  concentrationPct,
  concentrationCeilingPct,
  alerts,
  refreshing = false,
  onRefresh,
}: OpsDashboardProps) {
  const t = useT();
  const { lang } = useLang();
  const locale = lang === 'ar' ? 'ar-EG' : 'en-EG';

  const over = concentrationPct >= concentrationCeilingPct;
  // Amber well before the ceiling, because by the time you are at it, the
  // exposure is already committed and cannot be unwound this week.
  const hot = concentrationPct >= concentrationCeilingPct * 0.8;

  // Stops first. An alert that blocks trade outranks one that merely costs money.
  const ordered = [...alerts].sort(
    (a, b) => rank(a.level) - rank(b.level),
  );

  return (
    <ScrollView
      style={s.screen}
      contentContainerStyle={s.content}
      refreshControl={onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={color.brand} /> : undefined}
    >
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Stat
          label={t('ops.exposure')}
          value={Money.format(openExposure, locale).replace(/\s*(ج\.م|EGP)$/, '')}
        />
        <Stat label={t('ops.margin')} value={realisedMarginPct} />
      </View>

      <View style={{ height: space.sm }} />

      <View style={s.meterCard}>
        <View style={s.meterHead}>
          <Text style={[type.label, { flex: 1 }]}>{t('ops.concentration')}</Text>
          <Text style={[type.figure, over && { color: color.danger }]}>{concentrationPct}%</Text>
        </View>

        <View style={s.meterTrack}>
          <View
            style={[
              s.meterFill,
              { width: `${Math.min(100, concentrationPct)}%` },
              hot && { backgroundColor: color.amber },
              over && { backgroundColor: color.danger },
            ]}
          />
          {/* The ceiling is drawn on the track rather than written underneath it,
              so the reading is "how close am I", not "what was the limit again". */}
          <View style={[s.ceiling, { insetInlineStart: `${concentrationCeilingPct}%` }]} />
        </View>

        <Text style={[type.hint, { marginTop: 9 }]}>
          {t('ops.concentrationHint', { ceiling: concentrationCeilingPct })}
        </Text>
      </View>

      <View style={{ height: space.md }} />
      <Text style={type.eyebrow}>{t('ops.needsYou')}</Text>
      <View style={{ height: space.sm }} />

      {ordered.length === 0 ? (
        <View style={s.clear}>
          <Text style={[type.title, { textAlign: 'center' }]}>{t('ops.clearTitle')}</Text>
          <Text style={[type.body, { textAlign: 'center', marginTop: 6 }]}>{t('ops.clearBody')}</Text>
        </View>
      ) : (
        ordered.map((a) => {
          const Row = a.onOpen ? Pressable : View;
          return (
            <Row
              key={a.id}
              onPress={a.onOpen}
              style={[s.alert, a.level === 'warn' && s.alertWarn, a.level === 'stop' && s.alertStop]}
            >
              <View
                style={[
                  s.dot,
                  a.level === 'warn' && { backgroundColor: color.amber },
                  a.level === 'stop' && { backgroundColor: color.danger },
                ]}
              />
              <View style={{ flex: 1 }}>
                <Text style={[type.bodyStrong, { fontSize: 14 }]}>{a.title}</Text>
                <Text style={[type.hint, { marginTop: 3 }]}>{a.detail}</Text>
              </View>
            </Row>
          );
        })
      )}
    </ScrollView>
  );
}

function rank(level: AlertLevel): number {
  return level === 'stop' ? 0 : level === 'warn' ? 1 : 2;
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surface },
  content: { padding: space.md, paddingBottom: space.xxl },
  meterCard: {
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.md,
    padding: 14,
  },
  meterHead: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  meterTrack: {
    height: 9,
    borderRadius: 99,
    backgroundColor: color.line,
    marginTop: 9,
    overflow: 'hidden',
    position: 'relative',
  },
  meterFill: { height: '100%', borderRadius: 99, backgroundColor: color.brand },
  ceiling: { position: 'absolute', top: -2, bottom: -2, width: 2, backgroundColor: color.ink, opacity: 0.35 },
  alert: {
    flexDirection: 'row',
    gap: 11,
    alignItems: 'flex-start',
    backgroundColor: color.surfaceSunk,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.sm,
    padding: 13,
    marginBottom: 9,
  },
  alertWarn: { backgroundColor: color.amberSoft, borderColor: '#EBD9BB' },
  alertStop: { backgroundColor: color.dangerSoft, borderColor: '#F0CFC9' },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: color.inkMuted, marginTop: 6 },
  clear: { borderWidth: 1, borderColor: color.line, borderStyle: 'dashed', borderRadius: 14, padding: space.lg },
});
