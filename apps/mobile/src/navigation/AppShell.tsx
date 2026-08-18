/**
 * App shell.
 *
 * One binary, four roles. A packhouse foreman, a kitchen buyer, a field
 * inspector and the ops team install the same app and see different tabs,
 * because the alternative — four apps in two stores in two languages — is four
 * times the release process for a company that has not proven the first corridor
 * yet.
 *
 * Role comes from the session, not from a picker. The `onSwitchRole` prop exists
 * for staff who genuinely hold two roles (an ops user covering inspections during
 * harvest peak) and for demos; it is not a general-purpose escape hatch, and the
 * server re-checks the role on every request regardless of what the app claims.
 */

import React, { useState, useMemo } from 'react';
import { View, Text, Pressable, SafeAreaView, StyleSheet } from 'react-native';

import { color, space, type, radius, touch } from '../ui/theme';
import { useT, useLang } from '../i18n/index';

export type Role = 'supplier' | 'buyer' | 'inspector' | 'ops';

export type ScreenId =
  | 'sup.home'
  | 'sup.post'
  | 'buy.market'
  | 'buy.detail'
  | 'buy.checkout'
  | 'ins.weigh'
  | 'ins.quality'
  | 'ops.dash'
  | 'ops.payout';

interface TabDef {
  readonly screen: ScreenId;
  readonly labelKey: string;
  readonly glyph: string;
}

const TABS: Record<Role, readonly TabDef[]> = {
  supplier: [
    { screen: 'sup.home', labelKey: 'tab.myLots', glyph: '▦' },
    { screen: 'sup.post', labelKey: 'tab.post', glyph: '＋' },
  ],
  buyer: [
    { screen: 'buy.market', labelKey: 'tab.market', glyph: '⬓' },
    { screen: 'buy.detail', labelKey: 'tab.order', glyph: '◇' },
  ],
  inspector: [
    { screen: 'ins.weigh', labelKey: 'tab.intake', glyph: '⚖' },
    { screen: 'ins.quality', labelKey: 'tab.quality', glyph: '✓' },
  ],
  ops: [
    { screen: 'ops.dash', labelKey: 'tab.today', glyph: '▤' },
    { screen: 'ops.payout', labelKey: 'tab.approvals', glyph: '⌸' },
  ],
};

/** Screens reached by drilling in rather than by tab. These get a back affordance. */
const PUSHED: Partial<Record<ScreenId, ScreenId>> = {
  'buy.checkout': 'buy.detail',
};

export interface AppShellProps {
  readonly role: Role;
  readonly contextLabel: string;
  readonly render: (screen: ScreenId, navigate: (to: ScreenId) => void) => React.ReactNode;
  readonly onSwitchRole?: (role: Role) => void;
}

export default function AppShell({ role, contextLabel, render, onSwitchRole }: AppShellProps) {
  const t = useT();
  const { lang, setLang } = useLang();
  const tabs = TABS[role];
  const [screen, setScreen] = useState<ScreenId>(tabs[0].screen);

  // Changing role must not leave the user on a screen their new role cannot see.
  const navigate = (to: ScreenId) => setScreen(to);
  const parent = PUSHED[screen];

  const title = useMemo(() => {
    const tab = tabs.find((x) => x.screen === screen);
    return tab ? t(tab.labelKey) : t(`title.${screen}`);
  }, [screen, tabs, t, lang]);

  return (
    <SafeAreaView style={s.root}>
      <View style={s.appbar}>
        {parent ? (
          <Pressable
            onPress={() => setScreen(parent)}
            accessibilityRole="button"
            accessibilityLabel={t('nav.back')}
            style={s.back}
            hitSlop={10}
          >
            <Text style={s.backGlyph}>{lang === 'ar' ? '›' : '‹'}</Text>
          </Pressable>
        ) : null}

        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={type.eyebrow} numberOfLines={1}>
            {contextLabel}
          </Text>
          <Text style={[type.title, { marginTop: 1 }]} numberOfLines={1}>
            {title}
          </Text>
        </View>

        {/* Language is a top-level control, not buried in settings. Plenty of
            packhouses have one English-reading manager and an Arabic-speaking
            floor, and the app gets passed between them mid-task. */}
        <Pressable
          onPress={() => setLang(lang === 'ar' ? 'en' : 'ar')}
          accessibilityRole="button"
          accessibilityLabel={t('nav.language')}
          style={s.langBtn}
          hitSlop={8}
        >
          <Text style={s.langText}>{lang === 'ar' ? 'EN' : 'ع'}</Text>
        </Pressable>
      </View>

      <View style={{ flex: 1 }}>{render(screen, navigate)}</View>

      <View style={s.tabbar}>
        {tabs.map((tab) => {
          const on = tab.screen === screen || PUSHED[screen] === tab.screen;
          return (
            <Pressable
              key={tab.screen}
              onPress={() => setScreen(tab.screen)}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              style={s.tab}
            >
              <Text style={[s.tabGlyph, on && { color: color.brand }]}>{tab.glyph}</Text>
              <Text style={[s.tabLabel, on && { color: color.brand }]} numberOfLines={1}>
                {t(tab.labelKey)}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {onSwitchRole ? (
        <View style={s.roleStrip}>
          {(['supplier', 'buyer', 'inspector', 'ops'] as const).map((r) => (
            <Pressable
              key={r}
              onPress={() => {
                onSwitchRole(r);
                setScreen(TABS[r][0].screen);
              }}
              style={[s.roleBtn, r === role && s.roleBtnOn]}
            >
              <Text style={[s.roleText, r === role && { color: color.onBrand }]}>{t(`role.${r}`)}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.surface },
  appbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: color.line,
  },
  back: {
    width: 34,
    height: 34,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: color.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backGlyph: { ...type.title, fontSize: 22, lineHeight: 26, color: color.ink },
  langBtn: {
    minWidth: 38,
    height: 34,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: color.line,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  langText: { ...type.label, fontSize: 13, color: color.inkMuted },
  tabbar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: color.line,
    paddingHorizontal: 8,
    paddingTop: 6,
    paddingBottom: 10,
  },
  tab: { flex: 1, alignItems: 'center', gap: 4, paddingVertical: 8, borderRadius: 12, minHeight: touch.min },
  tabGlyph: { fontSize: 19, color: color.inkMuted, lineHeight: 22 },
  tabLabel: { ...type.hint, fontSize: 11.5, color: color.inkMuted, fontWeight: '500' },
  roleStrip: {
    flexDirection: 'row',
    gap: 6,
    padding: 8,
    backgroundColor: color.surfaceSunk,
    borderTopWidth: 1,
    borderTopColor: color.line,
  },
  roleBtn: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: radius.sm,
    alignItems: 'center',
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.line,
  },
  roleBtnOn: { backgroundColor: color.brand, borderColor: color.brand },
  roleText: { ...type.hint, fontSize: 12, color: color.inkMuted, fontWeight: '500' },
});
