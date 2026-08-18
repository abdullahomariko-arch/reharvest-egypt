/**
 * The one route.
 *
 * Expo Router is used for the layout and font/session bootstrap, but navigation
 * inside the app is a small state machine in AppShell rather than a URL tree.
 * That is deliberate: this is a task app used one-handed in a yard, not a
 * document app. Deep links into a half-loaded weighing screen would be a
 * liability rather than a feature.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';

import AppShell, { type ScreenId } from '../src/navigation/AppShell';
import { useSession } from '../src/session';
import { useT } from '../src/i18n/index';
import { api, BlockedByRule, ApiError, type WireLot } from '../src/api/client';
import { egp } from '@reharvest/core/money';
import { grams, CRATE_SPECS } from '@reharvest/core/quantity';
import { color, space, type } from '../src/ui/theme';
import { PrimaryButton } from '../src/ui/components';

import SupplierHomeScreen from '../src/screens/SupplierHomeScreen';
import PostLotScreen from '../src/screens/PostLotScreen';
import MarketScreen from '../src/screens/MarketScreen';
import OrderDetailScreen from '../src/screens/OrderDetailScreen';
import CheckoutScreen from '../src/screens/CheckoutScreen';
import WeighAndAcceptScreen from '../src/screens/WeighAndAcceptScreen';
import QualityCheckScreen from '../src/screens/QualityCheckScreen';
import OpsDashboardScreen from '../src/screens/OpsDashboardScreen';
import PayoutApprovalScreen from '../src/screens/PayoutApprovalScreen';
import SignInScreen from '../src/screens/SignInScreen';

export default function Index() {
  const { session, loading, switchRole } = useSession();
  const t = useT();

  const [lots, setLots] = useState<WireLot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedLotId, setSelectedLotId] = useState<string | null>(null);
  const [activeOrder, setActiveOrder] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!session) return;
    setError(null);
    try {
      const res = await api.listLots(session.token, { mine: session.role === 'supplier' });
      setLots(res.lots);
      if (!selectedLotId && res.lots.length) setSelectedLotId(res.lots[0].lotId);
    } catch (e) {
      // Never show a raw error string to a person in a field. Say what it means
      // and what they can do, and keep whatever data is already on screen.
      setError(e instanceof ApiError && e.status === 0 ? t('err.offline') : t('err.load'));
    }
  }, [session, selectedLotId, t]);

  useEffect(() => {
    void load();
  }, [session?.token, session?.role]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  if (loading) {
    return (
      <View style={s.centred}>
        <ActivityIndicator color={color.brand} />
      </View>
    );
  }

  if (!session) return <SignInScreen />;

  const selected = lots?.find((l) => l.lotId === selectedLotId) ?? null;

  const render = (screen: ScreenId, navigate: (to: ScreenId) => void) => {
    if (!lots && !error) {
      return (
        <View style={s.centred}>
          <ActivityIndicator color={color.brand} />
        </View>
      );
    }

    if (error && !lots) {
      return (
        <View style={s.centred}>
          <Text style={[type.title, { textAlign: 'center' }]}>{error}</Text>
          <View style={{ height: space.md }} />
          <PrimaryButton label={t('err.retry')} onPress={() => void load()} />
        </View>
      );
    }

    const list = lots ?? [];

    switch (screen) {
      case 'sup.home':
        return (
          <SupplierHomeScreen
            stationName={session.contextLabel}
            owed={egp.fromPiastres(
              list
                .filter((l) => l.status === 'SETTLED' || l.status === 'MATCHED')
                .reduce((acc, l) => acc + (BigInt(l.pricePerKgPiastres) * BigInt(l.netGrams)) / 1000n, 0n),
            )}
            lots={list.map((l) => ({
              lotId: l.lotId,
              crop: l.crop,
              net: grams(BigInt(l.netGrams)),
              containerCount: l.containerCount,
              status: l.status as never,
              listedAt: l.listedAt,
              buyerCount: l.buyerCount,
            }))}
            refreshing={refreshing}
            onRefresh={refresh}
            onOpenLot={(id) => {
              setSelectedLotId(id);
              navigate('sup.post');
            }}
            onPostLot={() => navigate('sup.post')}
          />
        );

      case 'sup.post':
        return (
          <PostLotScreen
            stationName={session.contextLabel}
            onSubmit={async (draft) => {
              await api.createLot(session.token, draft.idempotencyKey, {
                crop: draft.cropId,
                grossGrams: draft.grossGrams.toString(),
                containerCount: draft.crateCount,
                packagingSpecId: 'plastic_standard',
                packagingSpecVersion: 2,
                pricePerKgPiastres: draft.askPerKg.amount.toString(),
                collectBy: new Date(Date.now() + 3 * 86_400_000).toISOString(),
              });
              await load();
            }}
          />
        );

      case 'buy.market':
        return (
          <MarketScreen
            lots={list.map((l) => ({
              lotId: l.lotId,
              crop: l.crop,
              grade: l.grade,
              pricePerKg: egp.fromPiastres(BigInt(l.pricePerKgPiastres)),
              available: grams(BigInt(l.availableGrams)),
              originName: l.originName,
              distanceKm: l.distanceKm,
              inspectedAt: l.inspectedAt,
              collectBy: new Date(l.collectBy).toLocaleDateString(),
              windowClosesToday: Date.parse(l.collectBy) - Date.now() < 86_400_000,
            }))}
            onOpenLot={(id) => {
              setSelectedLotId(id);
              navigate('buy.detail');
            }}
          />
        );

      case 'buy.detail':
        if (!selected) return <Empty label={t('err.noLot')} />;
        return (
          <OrderDetailScreen
            lotId={selected.lotId}
            crop={selected.crop}
            grade={selected.grade}
            originName={selected.originName}
            distanceKm={selected.distanceKm}
            pricePerKg={egp.fromPiastres(BigInt(selected.pricePerKgPiastres))}
            available={grams(BigInt(selected.availableGrams))}
            brix={selected.brix}
            inspectedAtLabel={selected.inspectedAt ? new Date(selected.inspectedAt).toLocaleString() : null}
            collectByLabel={new Date(selected.collectBy).toLocaleDateString()}
            onReserve={async (input) => {
              const order = await api.createOrder(session.token, input.idempotencyKey, {
                lotId: input.lotId,
                quantityGrams: input.quantity.value.toString(),
              });
              setActiveOrder(order.orderCode);
              navigate('buy.checkout');
            }}
          />
        );

      case 'buy.checkout':
        if (!activeOrder || !selected) return <Empty label={t('err.noOrder')} />;
        return (
          <CheckoutScreen
            orderCode={activeOrder}
            cropAr={t(`crop.${selected.crop}`)}
            quantityLabelAr={t('detail.available')}
            totalDue={egp.fromPiastres(BigInt(selected.pricePerKgPiastres))}
            depositDue={egp.fromPiastres(BigInt(selected.pricePerKgPiastres))}
            deliveryWindowAr={new Date(selected.collectBy).toLocaleDateString()}
            availableMethods={['wallet', 'card', 'kiosk_cash']}
            startPayment={async () => {
              const intent = await api.createDepositIntention(
                session.token,
                activeOrder,
                `deposit:${activeOrder}`,
              );
              return { clientSecret: intent.clientSecret, publicKey: intent.publicKey };
            }}
            onCleared={() => navigate('buy.market')}
            onCancel={() => navigate('buy.detail')}
          />
        );

      case 'ins.weigh':
        if (!selected) return <Empty label={t('err.noLot')} />;
        return (
          <WeighAndAcceptScreen
            lotId={selected.lotId}
            cropLabel={t(`crop.${selected.crop}`)}
            supplierName={selected.originName}
            expectedNet={grams(BigInt(selected.netGrams))}
            agreedPricePerKg={egp.fromPiastres(BigInt(selected.pricePerKgPiastres))}
            packagingSpec={CRATE_SPECS.plastic_standard_v2}
            scale={{
              kind: 'verified-scale',
              scaleId: 'scale-nubaria-01',
              // Supplied by the server with the session in production; the scale
              // bound to this station, with its live calibration certificate.
              calibrationValidUntil: '2027-06-04T00:00:00Z',
              capturedBy: session.userId,
              capturedAt: new Date().toISOString(),
            }}
            onRecord={async (input) => {
              await api.recordWeighing(session.token, input.idempotencyKey, selected.lotId, {
                grossGrams: input.grossGrams.toString(),
                containerCount: input.containerCount,
                scaleId: 'scale-nubaria-01',
              });
              await load();
            }}
          />
        );

      case 'ins.quality':
        if (!selected) return <Empty label={t('err.noLot')} />;
        return (
          <QualityCheckScreen
            lotId={selected.lotId}
            sampleCrates={3}
            onApprove={async ({ lotId, checks, idempotencyKey }) => {
              await api.recordInspection(session.token, idempotencyKey, lotId, { checks, freeze: false });
              await load();
            }}
            onFreeze={async ({ lotId, idempotencyKey }) => {
              await api.recordInspection(session.token, idempotencyKey, lotId, { checks: {}, freeze: true });
              await load();
            }}
          />
        );

      case 'ops.dash':
        return (
          <OpsDashboardScreen
            openExposure={egp.fromPiastres(
              list.reduce((acc, l) => acc + (BigInt(l.pricePerKgPiastres) * BigInt(l.netGrams)) / 1000n, 0n),
            )}
            realisedMarginPct="11.4%"
            concentrationPct={31}
            concentrationCeilingPct={35}
            alerts={list
              .filter((l) => l.status === 'FROZEN' || l.status === 'WINDOW_CLOSING')
              .map((l) => ({
                id: l.lotId,
                level: l.status === 'FROZEN' ? ('stop' as const) : ('warn' as const),
                title: t(`ops.alert.${l.status}`),
                detail: l.lotId,
              }))}
            refreshing={refreshing}
            onRefresh={refresh}
          />
        );

      case 'ops.payout':
        return (
          <PayoutApprovalScreen
            settlementId="STL-2026-0816-011"
            supplierName={selected?.originName ?? '—'}
            amount={egp.fromPounds(5_200)}
            channel="bank"
            accountMasked="CIB ••••7890"
            preparedBy={{ userId: session.userId, name: session.displayName, roleLabel: t('role.ops') }}
            approvers={[
              { userId: session.userId, name: session.displayName, roleLabel: t('role.ops') },
              { userId: 'u_finance_2', name: 'منى صلاح', roleLabel: t('payout.financeManager') },
            ]}
            beneficiaryChangedAt={null}
            onRelease={async () => {
              await refresh();
            }}
          />
        );
    }
  };

  return (
    <AppShell
      role={session.role}
      contextLabel={session.contextLabel}
      render={render}
      onSwitchRole={switchRole}
    />
  );
}

function Empty({ label }: { label: string }) {
  return (
    <View style={s.centred}>
      <Text style={[type.body, { textAlign: 'center' }]}>{label}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  centred: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.lg,
    backgroundColor: color.surface,
  },
});

export { BlockedByRule };
