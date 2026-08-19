/**
 * Design tokens.
 *
 * The palette is derived from the objects this app is used around: a plastic
 * crate, a platform scale, a delivery note. Two decisions carry the whole thing:
 *
 * 1. The chrome is quiet and light, because most of this app is used outdoors
 *    at 7am with the sun overhead. Nothing here relies on subtle contrast.
 *
 * 2. Anything that is a *measurement* — net weight, money due, an amount being
 *    released — is shown on a dark instrument panel with phosphor-green figures.
 *    Egyptian wholesale markets run on big illuminated platform scales, and this
 *    borrows that vocabulary deliberately. It means a supplier can tell at a
 *    glance which numbers on the screen are the ones that become money.
 *
 * Red is reserved. It appears only when the app refuses to do something. It is
 * never used for emphasis, branding, or a delete button, so that when it does
 * appear it is unambiguous.
 */

import { Platform, type TextStyle } from 'react-native';

export const color = {
  /* chrome */
  bg: '#EFEDE7',
  surface: '#FFFFFF',
  surfaceSunk: '#F7F6F2',
  line: '#E2DFD6',
  lineStrong: '#CFCBBE',

  /* text */
  ink: '#131714',
  inkMuted: '#6E7369',
  onBrand: '#FFFFFF',

  /* brand — vine green, from the plant rather than the fruit */
  brand: '#14684A',
  brandDeep: '#0D4A34',
  brandSoft: '#E0EDE6',

  /* the instrument */
  inst: '#0C1411',
  instRule: '#223028',
  instText: '#8FA69A',
  instValue: '#DDEAE3',
  led: '#63E39D',
  ledDim: '#2E5744',
  ledRed: '#FF7261',

  /* states */
  amber: '#A96D14',
  amberSoft: '#F7EAD5',
  danger: '#AE3125',
  dangerSoft: '#F8E2DE',
} as const;

export const radius = { sm: 10, md: 14, lg: 20, pill: 999 } as const;

export const space = { xs: 6, sm: 10, md: 16, lg: 22, xl: 30, xxl: 44 } as const;

/**
 * Touch targets. 56 is above the platform minimum on purpose — the primary
 * actions here get tapped with cold hands, wet hands, and gloves on.
 */
export const touch = { min: 48, row: 62, primary: 56 } as const;

const sans = Platform.select({ ios: 'Alexandria', android: 'Alexandria', default: 'Alexandria' })!;
const mono = Platform.select({
  ios: 'IBMPlexMono-Medium',
  android: 'IBMPlexMono-Medium',
  default: 'IBM Plex Mono',
})!;

/**
 * Every numeric style is monospaced with tabular figures. A weight that shifts
 * horizontally as the digits change reads as unstable, and this is an app where
 * the numbers need to look like they came off an instrument.
 */
export const type = {
  display: { fontFamily: sans, fontSize: 25, fontWeight: '600', letterSpacing: -0.4, lineHeight: 32, color: color.ink },
  title: { fontFamily: sans, fontSize: 18, fontWeight: '600', letterSpacing: -0.2, color: color.ink },
  body: { fontFamily: sans, fontSize: 14.5, fontWeight: '300', lineHeight: 25, color: color.inkMuted },
  bodyStrong: { fontFamily: sans, fontSize: 15, fontWeight: '500', color: color.ink },
  label: { fontFamily: sans, fontSize: 13.5, fontWeight: '500', color: color.ink },
  eyebrow: { fontFamily: sans, fontSize: 11.5, fontWeight: '500', letterSpacing: 0.6, color: color.inkMuted },
  hint: { fontFamily: sans, fontSize: 12.5, fontWeight: '300', lineHeight: 20, color: color.inkMuted },

  /* instrument faces */
  readout: { fontFamily: mono, fontSize: 42, fontWeight: '600', letterSpacing: -0.6, color: color.led },
  readoutUnit: { fontFamily: mono, fontSize: 19, fontWeight: '400', color: color.led, opacity: 0.62 },
  figure: { fontFamily: mono, fontSize: 15, fontWeight: '600', color: color.ink },
  figureLarge: { fontFamily: mono, fontSize: 21, fontWeight: '600', color: color.ink },
} satisfies Record<string, TextStyle>;

/* ------------------------------------------------------------------ *
 * Status vocabulary.
 *
 * Every state a supplier or buyer can see has exactly one label and one
 * tone, defined here rather than at each call site. Two screens showing
 * the same state in different words is how people stop trusting the app.
 * ------------------------------------------------------------------ */

export type Tone = 'neutral' | 'good' | 'warn' | 'bad';

export const tone: Record<Tone, { bg: string; fg: string }> = {
  neutral: { bg: color.surfaceSunk, fg: color.inkMuted },
  good: { bg: color.brandSoft, fg: color.brandDeep },
  warn: { bg: color.amberSoft, fg: color.amber },
  bad: { bg: color.dangerSoft, fg: color.danger },
};

export const LOT_STATUS: Record<string, { ar: string; en: string; tone: Tone }> = {
  DRAFT: { ar: 'مسودة', en: 'Draft', tone: 'neutral' },
  LISTED: { ar: 'معروضة', en: 'Listed', tone: 'neutral' },
  RESERVED: { ar: 'محجوزة', en: 'Reserved', tone: 'good' },
  MATCHED: { ar: 'تم المطابقة', en: 'Matched', tone: 'good' },
  AWAITING_DEPOSIT: { ar: 'بانتظار عربون', en: 'Awaiting deposit', tone: 'warn' },
  WINDOW_CLOSING: { ar: 'تنتهي المهلة اليوم', en: 'Window closes today', tone: 'bad' },
  FROZEN: { ar: 'موقوفة', en: 'Frozen', tone: 'bad' },
  SETTLED: { ar: 'تم التحصيل', en: 'Settled', tone: 'good' },
};

export const ORDER_STATUS: Record<string, { ar: string; en: string; tone: Tone }> = {
  INTEREST: { ar: 'اهتمام', en: 'Interest', tone: 'neutral' },
  QUOTED: { ar: 'عرض سعر', en: 'Quoted', tone: 'neutral' },
  DEPOSIT_PENDING: { ar: 'بانتظار العربون', en: 'Awaiting deposit', tone: 'warn' },
  DEPOSIT_CLEARED: { ar: 'العربون وصل', en: 'Deposit cleared', tone: 'good' },
  CONFIRMED: { ar: 'مؤكد', en: 'Confirmed', tone: 'good' },
  ALLOCATED: { ar: 'تم التخصيص', en: 'Allocated', tone: 'good' },
  IN_FULFILMENT: { ar: 'تحت التجهيز', en: 'Being prepared', tone: 'neutral' },
  DELIVERED_PENDING_ACCEPTANCE: { ar: 'بانتظار الاستلام', en: 'Awaiting acceptance', tone: 'warn' },
  ACCEPTED: { ar: 'تم الاستلام', en: 'Accepted', tone: 'good' },
  PARTIALLY_ACCEPTED: { ar: 'استلام جزئي', en: 'Partially accepted', tone: 'warn' },
  SETTLED: { ar: 'تمت التسوية', en: 'Settled', tone: 'good' },
  DISPUTED: { ar: 'محل نزاع', en: 'Disputed', tone: 'bad' },
  CANCELLED: { ar: 'ملغي', en: 'Cancelled', tone: 'bad' },
};
