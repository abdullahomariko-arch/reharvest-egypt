/**
 * Strings.
 *
 * Arabic is the source language, not a translation target. Every string was
 * written in Arabic first and then rendered into English, which is why the
 * English reads slightly plainer than marketing copy would — it is following
 * the Arabic rather than leading it.
 *
 * The register is deliberately Egyptian colloquial in places ("الفلوس اتسجلت")
 * rather than Modern Standard Arabic throughout. The people using this app are
 * packhouse foremen and kitchen buyers, and MSA in a work app reads like a
 * government form, which is the opposite of the trust this product needs.
 *
 * Rules for adding strings here:
 *   - A refusal always has a matching `.fix` key. No exceptions.
 *   - Numbers never get embedded in a sentence template that assumes their
 *     position, because Arabic and English put them in different places.
 *   - No string is reused across two different meanings to save space.
 */

import React, { createContext, useContext, useMemo, useState } from 'react';
import { I18nManager } from 'react-native';

export type Lang = 'ar' | 'en';

type Dict = Record<string, string>;

const AR: Dict = {
  'crop.tomato': 'طماطم',
  'crop.potato': 'بطاطس',
  'crop.onion': 'بصل',
  'crop.pepper': 'فلفل',
  'crop.orange': 'برتقال',

  'post.title': 'اعرض شحنة جديدة',
  'post.lede': 'صوّر المحصول كما هو. الوصف الصادق يبيع أسرع من الوصف المثالي.',
  'post.crop': 'المحصول',
  'post.gross': 'الوزن القائم بالكيلو',
  'post.grossHint': 'اقرأ الرقم من الميزان كما هو، دون تقريب.',
  'post.crates': 'عدد الصناديق',
  'post.cratesHint': 'الصندوق البلاستيك المعتمد وزنه ٠٫٥ كجم فارغًا.',
  'post.ask': 'السعر المطلوب للكيلو',
  'post.net': 'الوزن الصافي',
  'post.netIdle': 'القائم ناقص وزن الصناديق الفارغة.',
  'post.netOk': 'ده الرقم اللي بتتحسب عليه الفلوس.',
  'post.netFail': 'لا يمكن حسابه',
  'post.tare': 'وزن الفارغ',
  'post.value': 'قيمة الشحنة',
  'post.cta': 'اعرض الشحنة على المشترين',
  'post.done': 'تم العرض ✓',
  'post.foot': 'يُسجَّل الوزن باسمك، ولا يُعدَّل لاحقًا إلا بسجل تصحيح معتمد.',

  'qc.title': 'فحص الجودة',
  'qc.lede': 'عيّنة من {n} صناديق مختلفة، من أماكن متفرقة في الشحنة.',
  'qc.colour': 'اللون والنضج متجانسان',
  'qc.colour.sub': 'لا يزيد التفاوت عن درجتين',
  'qc.damage': 'نسبة التلف أقل من ١٢٪',
  'qc.damage.sub': 'العدّ الفعلي مسجّل في المحضر',
  'qc.ferment': 'لا توجد رائحة تخمّر',
  'qc.ferment.sub': 'تُفحص عند فتح الصندوق مباشرة',
  'qc.chemical': 'أثر رشّ كيماوي أو رائحة مبيد',
  'qc.chemical.sub': 'علّم هنا لو لاحظت أثرًا — دي حالة توقف فوري',
  'qc.cta': 'اعتمد الفحص',
  'qc.freezeCta': 'أوقف الشحنة',
  'qc.approvedDone': 'تم الاعتماد ✓',
  'qc.frozenDone': 'الشحنة موقوفة',
  'qc.approvedPill': 'معتمدة',
  'qc.frozenPill': 'موقوفة',
  'qc.incomplete': 'علّم على كل بنود الفحص الأساسية قبل الاعتماد.',
  'qc.foot': 'يُسجَّل الفحص باسمك ووقته، ويُربط بالشحنة نهائيًا.',
  'qc.freeze.msg': 'الشحنة موقوفة. اشتباه أثر كيماوي.',
  'qc.freeze.fix':
    'لا يُباع ولا يُنقل أي شيء من الشحنة دي. مفيش حد يقدر يتجاوز الإيقاف ده — لا مدير ولا صاحب الشركة. لازم معاين مؤهل يفحصها بنفسه ويرفع تقرير.',

  'block.QTY_NET_NOT_POSITIVE': 'وزن الصناديق الفارغة يساوي أو يزيد عن الوزن القائم.',
  'block.QTY_NET_NOT_POSITIVE.fix': 'راجع نوع الصندوق المختار وتأكد إن الميزان متصفّر، وأعد الوزن.',
  'block.QTY_BAD_CONTAINER_COUNT': 'عدد الصناديق لازم يكون رقم صحيح أكبر من صفر.',
  'block.QTY_BAD_CONTAINER_COUNT.fix': 'عُدّ الصناديق تاني واكتب الرقم بدون كسور.',
  'block.QTY_UNIT_MISMATCH': 'الوحدة غير متوافقة مع العملية دي.',
  'block.QTY_UNIT_MISMATCH.fix': 'تأكد إنك بتدخل وزن بالكيلو، مش عدد.',
};

const EN: Dict = {
  'crop.tomato': 'Tomato',
  'crop.potato': 'Potato',
  'crop.onion': 'Onion',
  'crop.pepper': 'Pepper',
  'crop.orange': 'Orange',

  'post.title': 'Post a new lot',
  'post.lede': 'Photograph the crop as it is. An honest listing sells faster than a flattering one.',
  'post.crop': 'Crop',
  'post.gross': 'Gross weight in kg',
  'post.grossHint': 'Read the scale exactly. Do not round.',
  'post.crates': 'Number of crates',
  'post.cratesHint': 'The approved plastic crate weighs 0.5 kg empty.',
  'post.ask': 'Asking price per kg',
  'post.net': 'Net weight',
  'post.netIdle': 'Gross minus the weight of the empty crates.',
  'post.netOk': 'This is the figure money is calculated on.',
  'post.netFail': 'Cannot be calculated',
  'post.tare': 'Empty crate weight',
  'post.value': 'Lot value',
  'post.cta': 'List this lot',
  'post.done': 'Listed ✓',
  'post.foot': 'The weight is recorded under your name and cannot be edited later without an approved correction.',

  'qc.title': 'Quality check',
  'qc.lede': 'Sample {n} separate crates, taken from different parts of the load.',
  'qc.colour': 'Colour and ripeness are consistent',
  'qc.colour.sub': 'No more than two grades of variation',
  'qc.damage': 'Damage below 12%',
  'qc.damage.sub': 'The counted figure goes in the report',
  'qc.ferment': 'No smell of fermentation',
  'qc.ferment.sub': 'Check the moment the crate is opened',
  'qc.chemical': 'Trace of spray or pesticide smell',
  'qc.chemical.sub': 'Tick this if you notice any — it is a hard stop',
  'qc.cta': 'Approve inspection',
  'qc.freezeCta': 'Freeze this lot',
  'qc.approvedDone': 'Approved ✓',
  'qc.frozenDone': 'Lot frozen',
  'qc.approvedPill': 'Approved',
  'qc.frozenPill': 'Frozen',
  'qc.incomplete': 'Tick every core check before approving.',
  'qc.foot': 'The inspection is recorded under your name and time, and bound to the lot permanently.',
  'qc.freeze.msg': 'Lot frozen. Suspected chemical trace.',
  'qc.freeze.fix':
    'Nothing from this lot can be sold or moved. Nobody can override this — not a manager, not the founder. A qualified inspector must examine it in person and file a report.',

  'block.QTY_NET_NOT_POSITIVE': 'The empty crates weigh as much as or more than the load.',
  'block.QTY_NET_NOT_POSITIVE.fix': 'Check which crate type is selected and that the scale was zeroed, then weigh again.',
  'block.QTY_BAD_CONTAINER_COUNT': 'Crate count must be a whole number above zero.',
  'block.QTY_BAD_CONTAINER_COUNT.fix': 'Count the crates again and enter the number without decimals.',
  'block.QTY_UNIT_MISMATCH': 'That unit does not apply to this operation.',
  'block.QTY_UNIT_MISMATCH.fix': 'Check you are entering a weight in kg, not a count.',
};

const CATALOGUE: Record<Lang, Dict> = { ar: AR, en: EN };

export type Translate = (key: string, vars?: Record<string, string | number>) => string;

const I18nContext = createContext<{ lang: Lang; t: Translate; setLang: (l: Lang) => void }>({
  lang: 'ar',
  t: (k) => k,
  setLang: () => {},
});

export function I18nProvider({ children, initial = 'ar' }: { children: React.ReactNode; initial?: Lang }) {
  const [lang, setLangState] = useState<Lang>(initial);

  const setLang = (l: Lang) => {
    // RTL is a native layout flag, so switching it needs a reload to take
    // effect fully. Callers are expected to prompt for that rather than
    // leaving the user in a half-mirrored layout.
    I18nManager.allowRTL(true);
    I18nManager.forceRTL(l === 'ar');
    setLangState(l);
  };

  const value = useMemo(() => {
    const t: Translate = (key, vars) => {
      // Falling back to Arabic rather than to the raw key means a missing
      // English string shows real words, not `qc.title`, in front of a customer.
      const raw = CATALOGUE[lang][key] ?? CATALOGUE.ar[key] ?? key;
      if (!vars) return raw;
      return Object.entries(vars).reduce((acc, [k, v]) => acc.split(`{${k}}`).join(String(v)), raw);
    };
    return { lang, t, setLang };
  }, [lang]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useT(): Translate {
  return useContext(I18nContext).t;
}

export function useLang() {
  const { lang, setLang } = useContext(I18nContext);
  return { lang, setLang };
}
