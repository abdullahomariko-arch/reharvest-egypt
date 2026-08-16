/**
 * Design tokens.
 *
 * Where these come from: the app is used one-handed, in daylight, on a cheap
 * Android phone, by someone standing next to a scale with tomato juice on their
 * fingers. Every decision below is downstream of that.
 *
 *  - Arabic is the primary language, not a translation layer. Layout is RTL by
 *    default and the Latin build is the mirror.
 *  - Nothing lighter than 500 weight and nothing under 15pt, because the screen
 *    is being read in direct sun.
 *  - Colour carries one meaning only: crate blue is the product, clay is a
 *    warning, and deep red is reserved exclusively for a hard block. If red
 *    appears anywhere decorative, the block loses its force.
 *
 * The palette is taken from the physical objects: the blue polypropylene crate
 * every Egyptian packing house uses, kraft liner, the olive of the leaves, and
 * the exact red of a rejected tomato.
 */

export const color = {
  /** Screen and card surfaces — kraft paper, not white. Less glare outdoors. */
  paper: '#F2EDE3',
  paperRaised: '#FBF8F2',
  ink: '#1C1A16',
  inkSoft: '#5C574C',
  hairline: '#D8D0C0',

  /** The crate. Primary actions, selected states, the brand. */
  crate: '#1F5C86',
  crateDeep: '#123B58',
  crateWash: '#DCE8F0',

  /** Olive — confirmed, cleared, accepted. */
  olive: '#4F6B33',
  oliveWash: '#E4EAD9',

  /** Clay — hold, pending, needs attention but reversible. */
  clay: '#B4661F',
  clayWash: '#F6E7D6',

  /** Reject red — hard blocks and food-safety holds only. Never decorative. */
  reject: '#9E2B20',
  rejectWash: '#F7DFDC',
} as const;

/**
 * Type scale. Two families:
 *   IBM Plex Sans Arabic  — Arabic and Latin body, wide apertures, reads at size
 *   IBM Plex Mono         — weights, lot IDs, money. Tabular figures matter when
 *                           an operator is comparing 812.5 against 812.0 at a glance.
 */
export const font = {
  body: 'IBMPlexSansArabic-Medium',
  bodyBold: 'IBMPlexSansArabic-SemiBold',
  display: 'IBMPlexSansArabic-Bold',
  mono: 'IBMPlexMono-Medium',
} as const;

export const type = {
  display: { fontFamily: font.display, fontSize: 30, lineHeight: 40 },
  title: { fontFamily: font.display, fontSize: 22, lineHeight: 32 },
  body: { fontFamily: font.body, fontSize: 17, lineHeight: 28 },
  bodyStrong: { fontFamily: font.bodyBold, fontSize: 17, lineHeight: 28 },
  label: { fontFamily: font.bodyBold, fontSize: 15, lineHeight: 22 },
  /** Lot IDs, kilograms, EGP. Tabular so digits line up column-wise. */
  figure: { fontFamily: font.mono, fontSize: 20, lineHeight: 28, fontVariant: ['tabular-nums'] as const },
  figureLarge: { fontFamily: font.mono, fontSize: 34, lineHeight: 42, fontVariant: ['tabular-nums'] as const },
} as const;

export const space = { xs: 4, sm: 8, md: 16, lg: 24, xl: 36, xxl: 56 } as const;

/** Minimum 56pt. A gloved or wet thumb is not a mouse pointer. */
export const touch = { min: 56, primary: 64 } as const;

export const radius = { sm: 6, md: 12, lg: 18 } as const;

/**
 * The signature element of this product: the block card.
 *
 * When the app refuses something, it never shows a bare error. It shows what is
 * wrong, which rule refused it, what to do instead, and — when one exists — who
 * can authorise an exception. A refusal without a correction path gets worked
 * around on WhatsApp, which is exactly the behaviour the platform exists to replace.
 */
export const blockCard = {
  container: {
    backgroundColor: color.rejectWash,
    borderRightWidth: 6, // RTL: the rule stripe sits on the reading edge
    borderRightColor: color.reject,
    borderRadius: radius.md,
    padding: space.md,
  },
  holdContainer: {
    backgroundColor: color.clayWash,
    borderRightWidth: 6,
    borderRightColor: color.clay,
    borderRadius: radius.md,
    padding: space.md,
  },
} as const;

export const statusPalette = {
  INTEREST: { bg: color.paperRaised, fg: color.inkSoft, ar: 'اهتمام' },
  QUOTED: { bg: color.crateWash, fg: color.crateDeep, ar: 'عرض سعر' },
  CONDITIONAL: { bg: color.crateWash, fg: color.crateDeep, ar: 'مبدئي' },
  DEPOSIT_PENDING: { bg: color.clayWash, fg: color.clay, ar: 'بانتظار العربون' },
  DEPOSIT_CLEARED: { bg: color.oliveWash, fg: color.olive, ar: 'العربون محصَّل' },
  CONFIRMED: { bg: color.oliveWash, fg: color.olive, ar: 'مؤكَّد' },
  ALLOCATED: { bg: color.oliveWash, fg: color.olive, ar: 'مخصَّص' },
  IN_FULFILMENT: { bg: color.crateWash, fg: color.crateDeep, ar: 'قيد التجهيز' },
  DELIVERED_PENDING_ACCEPTANCE: { bg: color.clayWash, fg: color.clay, ar: 'بانتظار الاستلام' },
  ACCEPTED: { bg: color.oliveWash, fg: color.olive, ar: 'مقبول' },
  PARTIALLY_ACCEPTED: { bg: color.clayWash, fg: color.clay, ar: 'مقبول جزئيًا' },
  SETTLED: { bg: color.oliveWash, fg: color.olive, ar: 'مسوّى' },
  CANCELLED: { bg: color.paperRaised, fg: color.inkSoft, ar: 'ملغى' },
  DISPUTED: { bg: color.rejectWash, fg: color.reject, ar: 'نزاع' },
} as const;

export const lotStatusPalette = {
  DECLARED: { bg: color.paperRaised, fg: color.inkSoft, ar: 'مُسجَّلة' },
  SOURCE_VERIFIED: { bg: color.crateWash, fg: color.crateDeep, ar: 'المصدر موثَّق' },
  INSPECTION_PENDING: { bg: color.clayWash, fg: color.clay, ar: 'بانتظار الفحص' },
  AVAILABLE: { bg: color.oliveWash, fg: color.olive, ar: 'متاحة' },
  PARTIALLY_RESERVED: { bg: color.crateWash, fg: color.crateDeep, ar: 'محجوزة جزئيًا' },
  FULLY_RESERVED: { bg: color.crateWash, fg: color.crateDeep, ar: 'محجوزة بالكامل' },
  HELD: { bg: color.rejectWash, fg: color.reject, ar: 'موقوفة' },
  QUARANTINED: { bg: color.rejectWash, fg: color.reject, ar: 'حجر صحي' },
  RELEASED_TO_ORDER: { bg: color.oliveWash, fg: color.olive, ar: 'مُفرج عنها لطلب' },
  CONSUMED: { bg: color.paperRaised, fg: color.inkSoft, ar: 'مستهلكة' },
  DISPOSED: { bg: color.paperRaised, fg: color.inkSoft, ar: 'مُعدمة' },
  EXPIRED: { bg: color.paperRaised, fg: color.inkSoft, ar: 'منتهية' },
} as const;
