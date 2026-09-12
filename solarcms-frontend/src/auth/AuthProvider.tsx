/**
 * Token lifecycle, the session's identity, and Client switching.
 *
 * The one behaviour here that matters more than the rest: switching Client is a
 * **full state reset**. Every cached Plant, Device and Reading belonged to the
 * previous Client, and showing one of them after a switch is the single worst
 * bug this frontend can have (§3.1, Guardrail 10).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import * as authApi from "@/api/endpoints/auth";
import { setSessionLostHandler } from "@/api/client";
import { getTokens, onTokensChanged, setTokens } from "@/api/tokens";
import { ApiError, isApiError } from "@/api/problem";
import type { Me } from "@/api/schemas";

export type LoginOutcome =
  | { kind: "ok" }
  | { kind: "invalid" }
  | { kind: "no_membership"; detail: string }
  /** 409: the User belongs to several Clients and must pick one (§3.3). */
  | { kind: "choose_client"; detail: string }
  | { kind: "error"; detail: string };

interface AuthContextValue {
  me: Me | null;
  status: "loading" | "authenticated" | "anonymous";
  login: (email: string, password: string, clientId?: number) => Promise<LoginOutcome>;
  logout: () => Promise<void>;
  switchClient: (clientId: number) => Promise<void>;
  refreshMe: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const queryClient = useQueryClient();
  const [me, setMe] = useState<Me | null>(null);
  const [status, setStatus] = useState<AuthContextValue["status"]>("loading");

  /** Drop every cached byte. Used on logout and on a Client switch. */
  const resetEverything = useCallback(() => {
    queryClient.cancelQueries();
    // clear(), not invalidateQueries(): invalidation leaves the previous
    // Client's data resident and renderable while the refetch is in flight.
    queryClient.clear();
    setMe(null);
  }, [queryClient]);

  const loadMe = useCallback(async () => {
    if (!getTokens()) {
      setMe(null);
      setStatus("anonymous");
      return;
    }
    try {
      const identity = await authApi.me();
      setMe(identity);
      setStatus("authenticated");
    } catch {
      setTokens(null);
      setMe(null);
      setStatus("anonymous");
    }
  }, []);

  useEffect(() => {
    // The client wrapper calls this when a refresh has already failed.
    setSessionLostHandler(() => {
      resetEverything();
      setStatus("anonymous");
    });
    return () => setSessionLostHandler(() => {});
  }, [resetEverything]);

  useEffect(() => {
    void loadMe();
  }, [loadMe]);

  useEffect(
    // Another tab logging out must not leave this one holding a live cache.
    () =>
      onTokensChanged((tokens) => {
        if (tokens === null) {
          resetEverything();
          setStatus("anonymous");
        }
      }),
    [resetEverything],
  );

  const login = useCallback<AuthContextValue["login"]>(
    async (email, password, clientId) => {
      try {
        const tokens = await authApi.login(email, password, clientId);
        resetEverything();
        setTokens(tokens);
        await loadMe();
        return { kind: "ok" };
      } catch (error) {
        if (!isApiError(error)) {
          return { kind: "error", detail: "Could not reach the server." };
        }
        const problem = error as ApiError;
        // The backend returns an identical 401 for a wrong password, an unknown
        // user and a deactivated account. Distinguishing them in the UI would
        // reintroduce the account enumerator it was careful to avoid (§3.3).
        if (problem.status === 401) return { kind: "invalid" };
        if (problem.status === 403) {
          return { kind: "no_membership", detail: problem.displayMessage };
        }
        if (problem.status === 409) {
          return { kind: "choose_client", detail: problem.displayMessage };
        }
        return { kind: "error", detail: problem.displayMessage };
      }
    },
    [loadMe, resetEverything],
  );

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch {
      // A failed logout must still clear the client side; the token is what
      // matters locally and the server-side audit row is best-effort here.
    }
    setTokens(null);
    resetEverything();
    setStatus("anonymous");
  }, [resetEverything]);

  const switchClient = useCallback(
    async (clientId: number) => {
      const tokens = await authApi.switchClient(clientId);
      // Order matters: clear first, then install the new token. Clearing after
      // would leave a window in which a refetch under the new token merges into
      // the old Client's cache entries.
      resetEverything();
      setTokens(tokens);
      await loadMe();
    },
    [loadMe, resetEverything],
  );

  const value = useMemo<AuthContextValue>(
    () => ({ me, status, login, logout, switchClient, refreshMe: loadMe }),
    [me, status, login, logout, switchClient, loadMe],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}
