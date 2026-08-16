/**
 * شاشة دفع العربون — Deposit checkout.
 *
 * This is the screen that turns "yes, probably" into confirmed demand, so the
 * copy on it does real work. It says plainly what the deposit does and what it
 * does not do, because a buyer who thinks a deposit is a full payment disputes
 * the balance three weeks later.
 *
 * The method list comes from the server. A buyer with no order history sees
 * wallet, card and kiosk cash — kiosk matters more than it looks, because a
 * cash-first kitchen that will not send a bank transfer for a first order will
 * happily walk to an Aman outlet, and that is the difference between a real
 * deposit and a WhatsApp promise.
 *
 * Card details never touch this app. We mount Paymob's checkout in a WebView
 * with a client_secret, which keeps the whole build out of PCI scope.
 */

import React, { useState, useCallback } from 'react';
import { View, Text, Pressable, ScrollView, ActivityIndicator, StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';

import { Money } from '@reharvest/core/money';
import type { PaymentMethod } from '@reharvest/payments/paymob';
import { color, type, space, touch, radius } from '../ui/theme';

type MoneyValue = Parameters<typeof Money.format>[0];

export interface CheckoutProps {
  readonly orderCode: string;
  readonly cropAr: string;
  readonly quantityLabelAr: string;
  readonly totalDue: MoneyValue;
  readonly depositDue: MoneyValue;
  readonly deliveryWindowAr: string;
  /** Fetches a fresh Paymob intention. Intentions are short-lived, so this is
   *  called when the buyer picks a method, not when the screen mounts. */
  readonly startPayment: (method: PaymentMethod) => Promise<{ clientSecret: string; publicKey: string }>;
  readonly availableMethods: readonly PaymentMethod[];
  readonly onCleared: () => void;
  readonly onCancel: () => void;
}

const METHOD_COPY: Record<PaymentMethod, { titleAr: string; subtitleAr: string }> = {
  wallet: { titleAr: 'محفظة إلكترونية', subtitleAr: 'فودافون كاش، اتصالات كاش، أورنج موني' },
  card: { titleAr: 'بطاقة بنكية', subtitleAr: 'ميزة، فيزا، ماستركارد' },
  kiosk_cash: { titleAr: 'دفع نقدي من منفذ أمان', subtitleAr: 'يصلك كود، وتدفع نقدًا خلال ٤٨ ساعة' },
  bank_transfer: { titleAr: 'تحويل بنكي / إنستاباي', subtitleAr: 'يُحتسب بعد وصول التحويل فعليًا' },
  bnpl: { titleAr: 'تقسيط (فاليو / سهولة)', subtitleAr: 'متاح لعملاء لديهم سجل طلبات سابق' },
};

export default function CheckoutScreen(props: CheckoutProps) {
  const [selected, setSelected] = useState<PaymentMethod | null>(null);
  const [session, setSession] = useState<{ clientSecret: string; publicKey: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const begin = useCallback(
    async (method: PaymentMethod) => {
      setSelected(method);
      setError(null);
      setLoading(true);
      try {
        setSession(await props.startPayment(method));
      } catch {
        // Never blame the buyer for our network. Say what to do next.
        setError('تعذّر فتح صفحة الدفع. تحقق من الاتصال وحاول مرة أخرى، أو اختر وسيلة دفع أخرى.');
      } finally {
        setLoading(false);
      }
    },
    [props],
  );

  if (session) {
    return (
      <PaymobCheckout
        session={session}
        onCleared={props.onCleared}
        onDismiss={() => {
          setSession(null);
          setSelected(null);
        }}
      />
    );
  }

  const balance = Money.sub(props.totalDue, props.depositDue);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={[type.label, { color: color.inkSoft }]}>{props.orderCode}</Text>
      <Text style={type.display}>{props.cropAr}</Text>
      <Text style={[type.body, { color: color.inkSoft }]}>
        {props.quantityLabelAr} · {props.deliveryWindowAr}
      </Text>

      <View style={{ height: space.lg }} />

      {/* The deposit is the largest figure on the screen because it is the
          number the buyer is about to act on. The total is context, not the ask. */}
      <View style={styles.amountPanel}>
        <Text style={[type.label, { color: color.crateWash }]}>العربون المطلوب الآن</Text>
        <Text style={[type.figureLarge, { color: '#FFFFFF' }]}>{Money.format(props.depositDue)}</Text>

        <View style={styles.divider} />

        <Row labelAr="إجمالي الطلب" value={Money.format(props.totalDue)} />
        <Row labelAr="الباقي عند الاستلام" value={Money.format(balance)} />
      </View>

      <View style={{ height: space.md }} />

      <Text style={[type.body, { color: color.inkSoft }]}>
        العربون يثبّت الكمية والسعر ويبدأ التجهيز. الباقي يُحسب على الوزن الصافي المستلم فعليًا، وليس على
        الوزن المتوقع.
      </Text>

      <View style={{ height: space.lg }} />
      <Text style={type.title}>اختر وسيلة الدفع</Text>
      <View style={{ height: space.sm }} />

      {props.availableMethods.map((method) => (
        <MethodRow
          key={method}
          method={method}
          selected={selected === method}
          busy={loading && selected === method}
          onPress={() => begin(method)}
        />
      ))}

      {error ? (
        <>
          <View style={{ height: space.md }} />
          <View style={styles.errorBox}>
            <Text style={[type.body, { color: color.reject }]}>{error}</Text>
          </View>
        </>
      ) : null}

      <View style={{ height: space.lg }} />
      <Pressable onPress={props.onCancel} style={styles.secondary}>
        <Text style={[type.label, { color: color.crateDeep }]}>الرجوع دون دفع</Text>
      </Pressable>

      <View style={{ height: space.md }} />
      <Text style={[type.label, { color: color.inkSoft, fontSize: 13, textAlign: 'center' }]}>
        بيانات البطاقة تُدخل على صفحة مزوّد الدفع مباشرة ولا تمر عبر التطبيق
      </Text>
    </ScrollView>
  );
}

/* ------------------------------------------------------------------ *
 * Paymob Unified Checkout, mounted with the client_secret.
 *
 * Note what this component does *not* do: it never tells the app that payment
 * succeeded. The redirect only closes the sheet. The order advances when the
 * signed webhook reaches our server and clears reconciliation — a client that
 * can declare itself paid is a client that will.
 * ------------------------------------------------------------------ */

function PaymobCheckout({
  session,
  onCleared,
  onDismiss,
}: {
  session: { clientSecret: string; publicKey: string };
  onCleared: () => void;
  onDismiss: () => void;
}) {
  const [ready, setReady] = useState(false);

  const html = `<!doctype html><html lang="ar" dir="rtl"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;background:${color.paper};font-family:system-ui}</style>
</head><body>
<div id="paymob-checkout"></div>
<script src="https://accept.paymob.com/js/v1/paymob.js"></script>
<script>
  Paymob("${session.publicKey}").checkout("${session.clientSecret}").mount("#paymob-checkout");
</script>
</body></html>`;

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <View style={styles.sheetHeader}>
        <Pressable onPress={onDismiss} hitSlop={12} accessibilityLabel="إغلاق صفحة الدفع">
          <Text style={[type.label, { color: color.crateDeep }]}>إلغاء</Text>
        </Pressable>
        <Text style={type.label}>الدفع الآمن</Text>
        <View style={{ width: 48 }} />
      </View>

      {!ready ? (
        <View style={styles.centered}>
          <ActivityIndicator color={color.crate} />
        </View>
      ) : null}

      <WebView
        source={{ html }}
        onLoadEnd={() => setReady(true)}
        onNavigationStateChange={(nav) => {
          // The redirect means the buyer finished at the provider. We move them
          // to a "waiting for confirmation" state, not to "paid".
          if (nav.url.includes('/payment-complete')) onCleared();
        }}
        style={{ flex: 1, opacity: ready ? 1 : 0 }}
      />
    </View>
  );
}

/* ------------------------------------------------------------------ */

function MethodRow({
  method,
  selected,
  busy,
  onPress,
}: {
  method: PaymentMethod;
  selected: boolean;
  busy: boolean;
  onPress: () => void;
}) {
  const copy = METHOD_COPY[method];
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      style={[styles.methodRow, selected && styles.methodRowSelected]}
      accessibilityRole="button"
      accessibilityLabel={copy.titleAr}
    >
      <View style={{ flex: 1 }}>
        <Text style={[type.bodyStrong, { color: color.ink }]}>{copy.titleAr}</Text>
        <Text style={[type.label, { color: color.inkSoft, fontSize: 14 }]}>{copy.subtitleAr}</Text>
      </View>
      {busy ? <ActivityIndicator color={color.crate} /> : null}
    </Pressable>
  );
}

function Row({ labelAr, value }: { labelAr: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={[type.body, { color: color.crateWash }]}>{labelAr}</Text>
      <Text style={[type.figure, { color: '#FFFFFF', fontSize: 17 }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.paper },
  content: { padding: space.lg, paddingBottom: space.xxl },
  amountPanel: { backgroundColor: color.crateDeep, borderRadius: radius.lg, padding: space.lg },
  divider: { height: 1, backgroundColor: '#2E5F80', marginVertical: space.md },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: space.xs },
  methodRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: touch.primary,
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.hairline,
    borderRadius: radius.md,
    padding: space.md,
    marginBottom: space.sm,
  },
  methodRowSelected: { borderColor: color.crate, borderWidth: 2, backgroundColor: color.crateWash },
  errorBox: {
    backgroundColor: color.rejectWash,
    borderRightWidth: 6,
    borderRightColor: color.reject,
    borderRadius: radius.md,
    padding: space.md,
  },
  secondary: {
    minHeight: touch.min,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: color.crate,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.md,
    height: touch.min,
    borderBottomWidth: 1,
    borderBottomColor: color.hairline,
  },
  centered: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, alignItems: 'center', justifyContent: 'center' },
});
