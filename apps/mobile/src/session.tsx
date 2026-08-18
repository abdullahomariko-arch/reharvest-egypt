/**
 * Session.
 *
 * Holds who is using the app and what they are allowed to do. Two rules:
 *
 * - The role here is a **display** decision only. It picks which tabs render.
 *   Every request is re-authorised on the server against the token, because a
 *   role held in client state is a role a modified client can claim.
 *
 * - The token goes in SecureStore (Keychain / Keystore), never AsyncStorage.
 *   These are shared work phones in packhouses; an unencrypted token on disk is
 *   a token the next shift can read.
 */

import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import * as SecureStore from 'expo-secure-store';

export type Role = 'supplier' | 'buyer' | 'inspector' | 'ops';

export interface Session {
  readonly userId: string;
  readonly displayName: string;
  readonly partyId: string;
  /** Shown in the app bar: the packhouse, the kitchen, the ops team. */
  readonly contextLabel: string;
  readonly role: Role;
  readonly token: string;
}

interface SessionState {
  readonly session: Session | null;
  readonly loading: boolean;
  signIn: (s: Session) => Promise<void>;
  signOut: () => Promise<void>;
  /** For staff who genuinely hold two roles during harvest peak, and for demos. */
  switchRole: (role: Role) => void;
}

const KEY = 'reharvest.session.v2';

const Ctx = createContext<SessionState>({
  session: null,
  loading: true,
  signIn: async () => {},
  signOut: async () => {},
  switchRole: () => {},
});

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const raw = await SecureStore.getItemAsync(KEY);
        if (raw) setSession(JSON.parse(raw) as Session);
      } catch {
        // A corrupt or unreadable session is not worth an error screen.
        // Treat it as signed out and let the person log in again.
        await SecureStore.deleteItemAsync(KEY).catch(() => {});
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const value = useMemo<SessionState>(
    () => ({
      session,
      loading,
      async signIn(s) {
        await SecureStore.setItemAsync(KEY, JSON.stringify(s));
        setSession(s);
      },
      async signOut() {
        await SecureStore.deleteItemAsync(KEY);
        setSession(null);
      },
      switchRole(role) {
        setSession((prev) => (prev ? { ...prev, role } : prev));
      },
    }),
    [session, loading],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionState {
  return useContext(Ctx);
}
