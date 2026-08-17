/**
 * Shared components.
 *
 * Two of these carry the product's whole personality and are worth reading
 * closely: `Instrument` and `BlockCard`.
 */

import React from 'react';
import { View, Text, Pressable, TextInput, StyleSheet, type ViewStyle } from 'react-native';
import { color, radius, space, touch, type, tone, type Tone } from './theme';

/* ══════════════════════════════════════════════════════════════════ *
 * Instrument — the signature element.
 *
 * A dark housing with phosphor-green figures, borrowed from the platform
 * scales in every Egyptian wholesale market. Its job is to mark, without
 * a caption, which numbers on this screen are measurements that turn into
 * money — as opposed to prices, counts, and everything else.
 *
 * It has exactly two states: reading, and unable to read. There is no
 * "approximately" state, because a scale does not have one.
 * ══════════════════════════════════════════════════════════════════ */

export interface InstrumentRow {
  readonly label: string;
  readonly value: string;
  readonly emphasis?: boolean;
}

export function Instrument({
  caption,
  value,
  unit,
  note,
  rows,
  faulted = false,
  style,
}: {
  caption: string;
  /** The reading. Pass null when it cannot be computed — never pass a guess. */
  value: string | null;
  unit?: string;
  note?: string;
  rows?: readonly InstrumentRow[];
  /** Turns the readout red. Set when a rule has refused the input. */
  faulted?: boolean;
  style?: ViewStyle;
}) {
  return (
    <View style={[s.inst, style]}>
      <Text style={s.instCap}>{caption.toUpperCase()}</Text>

      <Text
        style={[type.readout, faulted && { color: color.ledRed }]}
        // The readout is the answer to the screen's question, so it is
        // announced first regardless of where it sits visually.
        accessibilityLiveRegion="polite"
      >
        {value ?? '—'}
        {value && unit ? <Text style={[type.readoutUnit, faulted && { color: color.ledRed }]}> {unit}</Text> : null}
      </Text>

      {note ? <Text style={s.instNote}>{note}</Text> : null}

      {rows?.length ? (
        <>
          <View style={s.instRule} />
          {rows.map((r) => (
            <View key={r.label} style={s.instRow}>
              <Text style={s.instRowLabel}>{r.label}</Text>
              <Text style={[s.instRowValue, r.emphasis && { color: color.led, fontSize: 19 }]}>{r.value}</Text>
            </View>
          ))}
        </>
      ) : null}
    </View>
  );
}

/* ══════════════════════════════════════════════════════════════════ *
 * BlockCard — how this app refuses.
 *
 * Every refusal says three things, always in this order:
 *   what is wrong · what to do about it · which rule refused
 *
 * The third line looks like developer detail but is the most important of
 * the three in practice. It means a supplier arguing with a refusal has a
 * reference to quote down the phone, and support can find the same rule
 * without a screenshot. A refusal with no path forward gets worked around
 * on WhatsApp — which is exactly the behaviour this platform replaces.
 * ══════════════════════════════════════════════════════════════════ */

export function BlockCard({
  message,
  correction,
  domainId,
  reasonCode,
}: {
  message: string;
  correction: string;
  domainId: string;
  reasonCode: string;
}) {
  return (
    <View style={s.block} accessibilityRole="alert">
      <Text style={s.blockMsg}>{message}</Text>
      <Text style={s.blockFix}>{correction}</Text>
      <Text style={s.blockCode}>
        {domainId} · {reasonCode}
      </Text>
    </View>
  );
}

/* ------------------------------------------------------------------ */

export function Pill({ label, variant = 'neutral' }: { label: string; variant?: Tone }) {
  const t = tone[variant];
  return (
    <View style={[s.pill, { backgroundColor: t.bg }]}>
      <Text style={[s.pillText, { color: t.fg }]}>{label}</Text>
    </View>
  );
}

export function Card({
  onPress,
  children,
  style,
}: {
  onPress?: () => void;
  children: React.ReactNode;
  style?: ViewStyle;
}) {
  const Wrapper = onPress ? Pressable : View;
  return (
    <Wrapper onPress={onPress} style={({ pressed }: any) => [s.card, pressed && s.cardPressed, style]}>
      {children}
    </Wrapper>
  );
}

export function Field({
  label,
  hint,
  value,
  onChangeText,
  keyboardType = 'decimal-pad',
  numeric = true,
}: {
  label: string;
  hint?: string;
  value: string;
  onChangeText: (t: string) => void;
  keyboardType?: 'decimal-pad' | 'number-pad' | 'default';
  numeric?: boolean;
}) {
  return (
    <View style={{ marginBottom: space.md }}>
      <Text style={[type.label, { marginBottom: 7 }]}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        keyboardType={keyboardType}
        style={[s.input, numeric && s.inputNumeric]}
        // Numeric entry stays left-to-right even in Arabic. A weight typed
        // right-to-left is how a digit ends up in the wrong column.
        textAlign={numeric ? 'left' : undefined}
        accessibilityLabel={label}
      />
      {hint ? <Text style={[type.hint, { marginTop: 6 }]}>{hint}</Text> : null}
    </View>
  );
}

export function PrimaryButton({
  label,
  onPress,
  disabled,
  variant = 'solid',
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: 'solid' | 'ghost';
}) {
  const ghost = variant === 'ghost';
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [
        s.btn,
        ghost && s.btnGhost,
        disabled && s.btnDisabled,
        pressed && !disabled && (ghost ? s.btnGhostPressed : s.btnPressed),
      ]}
    >
      <Text style={[s.btnText, ghost && { color: color.ink }, disabled && { color: color.inkMuted }]}>{label}</Text>
    </Pressable>
  );
}

export function CheckRow({
  title,
  subtitle,
  checked,
  onToggle,
  /** A check that, when ticked, stops the process rather than advancing it. */
  isFault = false,
}: {
  title: string;
  subtitle?: string;
  checked: boolean;
  onToggle: () => void;
  isFault?: boolean;
}) {
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      style={s.check}
    >
      <View
        style={[
          s.box,
          checked && { backgroundColor: isFault ? color.danger : color.brand, borderColor: isFault ? color.danger : color.brand },
        ]}
      >
        {checked ? <Text style={s.tick}>✓</Text> : null}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[type.bodyStrong, { fontWeight: '400', fontSize: 14.5 }]}>{title}</Text>
        {subtitle ? <Text style={[type.hint, { marginTop: 3 }]}>{subtitle}</Text> : null}
      </View>
    </Pressable>
  );
}

export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.stat}>
      <Text style={[type.hint, { fontSize: 11.5, lineHeight: 16 }]}>{label}</Text>
      <Text style={[type.figureLarge, { marginTop: 5 }]}>{value}</Text>
    </View>
  );
}

/* ------------------------------------------------------------------ */

const s = StyleSheet.create({
  inst: { backgroundColor: color.inst, borderRadius: radius.lg, padding: space.lg },
  instCap: { ...type.eyebrow, color: color.ledDim, letterSpacing: 1.1 },
  instNote: { ...type.hint, color: color.instText, marginTop: 9 },
  instRule: { height: 1, backgroundColor: color.instRule, marginVertical: 15 },
  instRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', paddingVertical: 4 },
  instRowLabel: { ...type.hint, color: color.instText, fontSize: 13.5 },
  instRowValue: { ...type.figure, color: color.instValue, fontWeight: '500' },

  block: {
    backgroundColor: color.dangerSoft,
    borderStartWidth: 5,
    borderStartColor: color.danger,
    borderRadius: radius.sm,
    padding: 14,
    marginTop: 14,
  },
  blockMsg: { ...type.bodyStrong, color: color.danger, fontWeight: '600', lineHeight: 22 },
  blockFix: { ...type.body, color: color.ink, marginTop: 7, lineHeight: 23 },
  blockCode: { ...type.hint, fontFamily: type.figure.fontFamily, fontSize: 11.5, marginTop: 9 },

  pill: { paddingHorizontal: 9, paddingVertical: 4, borderRadius: radius.pill },
  pillText: { ...type.eyebrow, fontSize: 11.5, letterSpacing: 0 },

  card: {
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.md,
    padding: 14,
    marginBottom: 11,
  },
  cardPressed: { borderColor: color.lineStrong, transform: [{ scale: 0.995 }] },

  input: {
    height: 52,
    backgroundColor: color.surfaceSunk,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.sm,
    paddingHorizontal: 14,
    ...type.bodyStrong,
  },
  inputNumeric: { ...type.figure, fontSize: 17, fontWeight: '500' },

  btn: {
    height: touch.primary,
    borderRadius: radius.sm,
    backgroundColor: color.brand,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: space.xs,
  },
  btnPressed: { backgroundColor: color.brandDeep },
  btnGhost: { backgroundColor: 'transparent', borderWidth: 1.5, borderColor: color.lineStrong, height: 50 },
  btnGhostPressed: { borderColor: color.brand },
  btnDisabled: { backgroundColor: color.line },
  btnText: { ...type.bodyStrong, fontSize: 15.5, fontWeight: '600', color: color.onBrand },

  check: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 11,
    paddingVertical: 13,
    borderBottomWidth: 1,
    borderBottomColor: color.line,
  },
  box: {
    width: 23,
    height: 23,
    borderRadius: 6,
    borderWidth: 1.7,
    borderColor: color.lineStrong,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  tick: { color: '#FFF', fontSize: 13, fontWeight: '700', lineHeight: 16 },

  stat: {
    flex: 1,
    backgroundColor: color.surfaceSunk,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.md,
    padding: 13,
  },
});
