/**
 * فحص الجودة — Inspector quality check.
 *
 * Most refusals in this app have a way forward: correct the input, get an
 * approval, request a time-limited exception. This screen contains the one that
 * does not.
 *
 * If the inspector flags a suspected chemical or pesticide trace (D31), the lot
 * freezes and nothing — not a manager, not a director, not the founder — can
 * release it from inside the software. That is deliberate. A food-safety
 * override that exists is a food-safety override that gets used at 6pm on a
 * Thursday when a delivery is late, and the whole platform's credibility with
 * NFSA and with buyers rests on it never having been possible.
 *
 * The unchecked boxes here are also load-bearing: an inspector who has not
 * looked cannot silently pass a lot by doing nothing, because submission
 * requires the positive checks to be ticked, and each tick is attributed.
 */

import React, { useState } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';

import { color, space, type } from '../ui/theme';
import { BlockCard, CheckRow, PrimaryButton, Pill } from '../ui/components';
import { useT } from '../i18n/index';

export interface QualityCheckProps {
  readonly lotId: string;
  readonly sampleCrates: number;
  readonly onApprove: (result: { lotId: string; checks: Record<string, boolean>; idempotencyKey: string }) => Promise<void>;
  readonly onFreeze: (result: { lotId: string; reasonCode: string; idempotencyKey: string }) => Promise<void>;
}

/**
 * `fault: true` inverts the meaning of a tick. Ticking a fault row is the
 * inspector saying "I saw this", which stops the process rather than advancing it.
 */
const CHECKS = [
  { id: 'colour', fault: false },
  { id: 'damage', fault: false },
  { id: 'ferment', fault: false },
  { id: 'chemical', fault: true },
] as const;

export default function QualityCheckScreen({ lotId, sampleCrates, onApprove, onFreeze }: QualityCheckProps) {
  const t = useT();
  const [state, setState] = useState<Record<string, boolean>>({
    colour: false,
    damage: false,
    ferment: false,
    chemical: false,
  });
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<'approved' | 'frozen' | null>(null);

  const idempotencyKey = React.useMemo(() => `inspect:${lotId}:${Date.now().toString(36)}`, [lotId]);

  const chemicalFlagged = state.chemical;
  const positivesComplete = CHECKS.filter((c) => !c.fault).every((c) => state[c.id]);

  const toggle = (id: string) => setState((prev) => ({ ...prev, [id]: !prev[id] }));

  const act = async () => {
    setBusy(true);
    try {
      if (chemicalFlagged) {
        await onFreeze({ lotId, reasonCode: 'FOOD_SAFETY_HARD_STOP', idempotencyKey });
        setOutcome('frozen');
      } else {
        await onApprove({ lotId, checks: state, idempotencyKey });
        setOutcome('approved');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.content}>
      <Text style={type.eyebrow}>{lotId}</Text>
      <Text style={[type.display, { marginTop: 2 }]}>{t('qc.title')}</Text>
      <Text style={[type.body, { marginTop: space.sm }]}>{t('qc.lede', { n: sampleCrates })}</Text>

      <View style={{ height: space.lg }} />

      {CHECKS.map((c) => (
        <CheckRow
          key={c.id}
          title={t(`qc.${c.id}`)}
          subtitle={t(`qc.${c.id}.sub`)}
          checked={!!state[c.id]}
          onToggle={() => toggle(c.id)}
          isFault={c.fault}
        />
      ))}

      {chemicalFlagged ? (
        <BlockCard
          message={t('qc.freeze.msg')}
          correction={t('qc.freeze.fix')}
          domainId="D31"
          reasonCode="FOOD_SAFETY_HARD_STOP"
        />
      ) : null}

      <View style={{ height: space.md }} />

      {outcome ? (
        <View style={{ alignItems: 'flex-start', marginBottom: space.sm }}>
          <Pill
            label={outcome === 'frozen' ? t('qc.frozenPill') : t('qc.approvedPill')}
            variant={outcome === 'frozen' ? 'bad' : 'good'}
          />
        </View>
      ) : null}

      {/*
        One button, two meanings. When a fault is flagged it becomes the freeze
        action, styled as a refusal rather than an approval — the inspector is
        never asked to press "approve" on a lot they have just failed.
      */}
      <PrimaryButton
        label={
          outcome === 'frozen'
            ? t('qc.frozenDone')
            : outcome === 'approved'
              ? t('qc.approvedDone')
              : chemicalFlagged
                ? t('qc.freezeCta')
                : t('qc.cta')
        }
        onPress={act}
        disabled={busy || !!outcome || (!chemicalFlagged && !positivesComplete)}
        variant={chemicalFlagged ? 'ghost' : 'solid'}
      />

      {!chemicalFlagged && !positivesComplete ? (
        <Text style={[type.hint, { textAlign: 'center', marginTop: 11 }]}>{t('qc.incomplete')}</Text>
      ) : (
        <Text style={[type.hint, { textAlign: 'center', marginTop: 11 }]}>{t('qc.foot')}</Text>
      )}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surface },
  content: { padding: space.md, paddingBottom: space.xxl },
});
