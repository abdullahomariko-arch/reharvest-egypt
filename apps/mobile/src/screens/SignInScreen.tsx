/**
 * Sign in.
 *
 * Phone number and a code, not email and password. Packhouse foremen and kitchen
 * buyers have a phone number; a meaningful share do not have a working email
 * address they check, and a password they will never remember becomes a shared
 * password written on the office wall.
 *
 * Invite-only is enforced on the server: an unrecognised number is told to
 * contact ReHarvest rather than being offered a sign-up flow, because this is a
 * closed marketplace where every party is vetted before they can trade.
 */

import React, { useState } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';

import { color, space, type } from '../ui/theme';
import { Field, PrimaryButton, BlockCard } from '../ui/components';
import { useT } from '../i18n/index';
import { useSession, type Role } from '../session';

const DEMO: Record<string, { role: Role; name: string; context: string; partyId: string }> = {
  '01001234567': { role: 'supplier', name: 'عبدالله عمر', context: 'محطة فرز النوبارية', partyId: 'party_nubaria' },
  '01001234568': { role: 'buyer', name: 'مطاعم القاهرة', context: 'مطاعم القاهرة للبيتزا', partyId: 'party_cairo_pizza' },
  '01001234569': { role: 'inspector', name: 'فاطمة حسن', context: 'المعاينة الميدانية', partyId: 'party_reharvest' },
  '01001234570': { role: 'ops', name: 'إدارة ريهارفست', context: 'إدارة ريهارفست', partyId: 'party_reharvest' },
};

export default function SignInScreen() {
  const t = useT();
  const { signIn } = useSession();
  const [phone, setPhone] = useState('01001234567');
  const [rejected, setRejected] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const normalised = phone.replace(/[^\d]/g, '').replace(/^20/, '0');
    const found = DEMO[normalised];
    if (!found) {
      setRejected(true);
      return;
    }
    setBusy(true);
    try {
      await signIn({
        userId: `u_${found.role}`,
        displayName: found.name,
        partyId: found.partyId,
        contextLabel: found.context,
        role: found.role,
        token: `demo-token-${found.role}`,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
      <View style={{ height: space.xl }} />
      <Text style={type.display}>{t('signin.title')}</Text>
      <Text style={[type.body, { marginTop: space.sm }]}>{t('signin.lede')}</Text>

      <View style={{ height: space.lg }} />

      <Field
        label={t('signin.phone')}
        hint={t('signin.phoneHint')}
        value={phone}
        onChangeText={(v) => {
          setPhone(v);
          setRejected(false);
        }}
        keyboardType="number-pad"
      />

      {rejected ? (
        <BlockCard
          message={t('signin.unknown.msg')}
          correction={t('signin.unknown.fix')}
          domainId="D01"
          reasonCode="PARTY_NOT_INVITED"
        />
      ) : null}

      <View style={{ height: space.sm }} />
      <PrimaryButton label={t('signin.cta')} onPress={submit} disabled={busy || phone.length < 10} />
      <Text style={[type.hint, { textAlign: 'center', marginTop: 11 }]}>{t('signin.foot')}</Text>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surface },
  content: { padding: space.md, paddingBottom: space.xxl },
});
