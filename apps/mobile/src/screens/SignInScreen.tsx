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
import Constants from 'expo-constants';

const API_BASE: string =
  (Constants.expoConfig?.extra?.apiBaseUrl as string) ?? 'http://localhost:8787';

/**
 * Egyptian mobile numbers, normalised to E.164.
 *
 * People write theirs as 01001234567, 0100 123 4567, or +201001234567. The
 * server matches on one canonical form, so the app converts rather than
 * rejecting a number that is perfectly valid as written.
 */
function toE164(input: string): string {
  const digits = input.replace(/\D/g, '');
  if (digits.startsWith('20')) return `+${digits}`;
  if (digits.startsWith('0')) return `+20${digits.slice(1)}`;
  return `+20${digits}`;
}

export default function SignInScreen() {
  const t = useT();
  const { signIn } = useSession();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'phone' | 'code'>('phone');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Ask for a code.
   *
   * The server answers identically whether or not the number is registered, so
   * this always advances to the code step. Showing "unknown number" here would
   * turn sign-in into a way to confirm who trades on an invite-only platform.
   */
  const requestCode = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/auth/request-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: toE164(phone) }),
      });
      if (res.status === 429) {
        setError(t('signin.rateLimited'));
        return;
      }
      if (!res.ok) {
        setError(t('signin.badPhone'));
        return;
      }
      setStage('code');
    } catch {
      setError(t('err.offline'));
    } finally {
      setBusy(false);
    }
  };

  const verifyCode = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/auth/verify-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: toE164(phone), code: code.trim() }),
      });

      if (!res.ok) {
        setError(t('signin.badCode'));
        return;
      }

      const body = (await res.json()) as {
        token: string;
        party: { id: string; displayName: string; roles: string[] };
      };

      // The role comes from the token the server issued, not from anything
      // chosen here.
      const role = (body.party.roles[0] ?? 'buyer') as Role;

      await signIn({
        userId: body.party.id,
        displayName: body.party.displayName,
        partyId: body.party.id,
        contextLabel: body.party.displayName,
        role,
        token: body.token,
      });
    } catch {
      setError(t('err.offline'));
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

      {stage === 'phone' ? (
        <Field
          label={t('signin.phone')}
          hint={t('signin.phoneHint')}
          value={phone}
          onChangeText={(v) => {
            setPhone(v);
            setError(null);
          }}
          keyboardType="number-pad"
        />
      ) : (
        <Field
          label={t('signin.code')}
          hint={t('signin.codeHint', { phone })}
          value={code}
          onChangeText={(v) => {
            setCode(v);
            setError(null);
          }}
          keyboardType="number-pad"
        />
      )}

      {error ? (
        <BlockCard message={error} correction={t('signin.retry')} domainId="D01" reasonCode="SIGN_IN_FAILED" />
      ) : null}

      <View style={{ height: space.sm }} />

      {stage === 'phone' ? (
        <PrimaryButton label={t('signin.cta')} onPress={requestCode} disabled={busy || phone.length < 10} />
      ) : (
        <>
          <PrimaryButton label={t('signin.verify')} onPress={verifyCode} disabled={busy || code.length < 6} />
          <View style={{ height: space.sm }} />
          <PrimaryButton
            label={t('signin.changeNumber')}
            variant="ghost"
            onPress={() => {
              setStage('phone');
              setCode('');
              setError(null);
            }}
          />
        </>
      )}
      <Text style={[type.hint, { textAlign: 'center', marginTop: 11 }]}>{t('signin.foot')}</Text>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surface },
  content: { padding: space.md, paddingBottom: space.xxl },
});
