/**
 * Root layout.
 *
 * Three things happen before the app can render a single screen, and each one
 * is a real failure mode rather than boilerplate:
 *
 * 1. Fonts must load before first paint. Alexandria carries Arabic; falling back
 *    to the system face mid-render reflows every number on the screen, which on
 *    a weighing screen looks like the reading changed.
 *
 * 2. RTL has to be set before the first layout pass. React Native mirrors at the
 *    native level, so flipping it after mount leaves half the tree mirrored.
 *
 * 3. The session decides the role, which decides the tabs. Rendering tabs before
 *    the session resolves would show a supplier the ops console for a frame.
 */

import React, { useEffect, useState } from 'react';
import { View, ActivityIndicator, I18nManager, StyleSheet } from 'react-native';
import { Slot } from 'expo-router';
import { useFonts } from 'expo-font';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { I18nProvider } from '../src/i18n/index';
import { SessionProvider } from '../src/session';
import { color } from '../src/ui/theme';

// Set before the first render pass, not inside a component body.
I18nManager.allowRTL(true);
I18nManager.forceRTL(true);

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Alexandria: require('../assets/fonts/Alexandria-Regular.ttf'),
    'Alexandria-Medium': require('../assets/fonts/Alexandria-Medium.ttf'),
    'Alexandria-SemiBold': require('../assets/fonts/Alexandria-SemiBold.ttf'),
    'IBMPlexMono-Medium': require('../assets/fonts/IBMPlexMono-Medium.ttf'),
    'IBMPlexMono-SemiBold': require('../assets/fonts/IBMPlexMono-SemiBold.ttf'),
  });

  const [minimumElapsed, setMinimumElapsed] = useState(false);
  useEffect(() => {
    // A splash that flashes for 80ms reads as a glitch. Hold briefly so the
    // transition into the app is deliberate rather than a flicker.
    const id = setTimeout(() => setMinimumElapsed(true), 350);
    return () => clearTimeout(id);
  }, []);

  // A missing font file must not brick the app in the field. Log it, render
  // with the system face, and let the person get on with their delivery.
  const ready = (fontsLoaded || !!fontError) && minimumElapsed;

  if (!ready) {
    return (
      <View style={s.splash}>
        <ActivityIndicator color={color.brand} />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <SessionProvider>
        <I18nProvider initial="ar">
          <StatusBar style="dark" backgroundColor={color.surface} />
          <Slot />
        </I18nProvider>
      </SessionProvider>
    </SafeAreaProvider>
  );
}

const s = StyleSheet.create({
  splash: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: color.surface },
});
