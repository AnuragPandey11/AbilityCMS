/**
 * The sign-in screen's state: which step of signing in is under way.
 *
 * A store rather than component state because the screen outlives the page
 * that starts it: a successful sign-in replaces the login page with the
 * dashboard at once, and the screen stays over that switch, so the dashboard's
 * first requests run underneath it and it fades away onto a page already
 * filling in.
 *
 * The bar is **driven by the real steps, never by a timer alone**. A sign-in is
 * one request and then the account's details; neither reports how far along it
 * is, so each step has a ceiling the bar eases towards while it runs and only
 * the step finishing lets it go further. It reaches 100% only once the account
 * has actually loaded. A failure removes the screen at once, so the login form
 * can say why.
 */

import { create } from "zustand";

export type SignInPhase = "idle" | "verifying" | "profile" | "granted" | "closing";

/** Shortest time before the screen starts to fade, from the click. */
export const SIGN_IN_MIN_VISIBLE_MS = 2400;
/** How long "Access granted" at 100% stays before fading, at the least. */
export const SIGN_IN_GRANTED_HOLD_MS = 600;
/** Once signed in, the bar fills over at least this long — never in a jump. */
export const SIGN_IN_MIN_FILL_MS = 700;
/** The fade onto the application. */
export const SIGN_IN_FADE_MS = 450;

export const SIGN_IN_LABEL: Record<Exclude<SignInPhase, "idle">, string> = {
  verifying: "Authenticating",
  profile: "Loading workspace",
  granted: "Access granted",
  closing: "Access granted",
};

// Each step's ceiling, and how fast the bar closes on it (per millisecond).
const CEILING: Record<SignInPhase, number> = {
  idle: 0,
  verifying: 45,
  profile: 88,
  granted: 100,
  closing: 100,
};
const RATE: Record<SignInPhase, number> = {
  idle: 0,
  verifying: 0.0018,
  profile: 0.003,
  granted: 0,
  closing: 0,
};

/**
 * The bar's next value, `dtMs` after `current`. Never moves backwards.
 *
 * While a step runs the bar eases towards that step's ceiling. Once signed in
 * it fills to 100 evenly over the `msToFull` left, so a sign-in that took a
 * moment still fills across the screen's time instead of jumping to the end.
 */
export function nextProgress(
  current: number,
  phase: SignInPhase,
  dtMs: number,
  msToFull = 0,
): number {
  if (phase === "idle") return 0;
  const ceiling = CEILING[phase];
  if (current >= ceiling) return current;
  if (phase === "granted" || phase === "closing") {
    if (msToFull <= dtMs) return 100;
    return current + ((100 - current) * dtMs) / msToFull;
  }
  const next = current + (ceiling - current) * (1 - Math.exp(-RATE[phase] * dtMs));
  // Close enough to the end to call it done; an asymptote never prints 100.
  if (ceiling === 100 && next > 99.5) return 100;
  return next;
}

interface SignInScreenState {
  phase: SignInPhase;
  startedAt: number;
  grantedAt: number;
  /** When the bar should reach 100, set on success. */
  fullAt: number;
  /** The credentials are on their way. */
  begin: () => void;
  /** Accepted; the account's details are loading. */
  profile: () => void;
  /** Signed in. The screen finishes the bar, holds, then fades. */
  succeed: () => void;
  /** Refused or failed: gone at once, so the form can explain. */
  fail: () => void;
  close: () => void;
  reset: () => void;
}

export const useSignInScreen = create<SignInScreenState>((set, get) => ({
  phase: "idle",
  startedAt: 0,
  grantedAt: 0,
  fullAt: 0,
  begin: () => set({ phase: "verifying", startedAt: Date.now(), grantedAt: 0, fullAt: 0 }),
  profile: () => {
    if (get().phase === "verifying") set({ phase: "profile" });
  },
  succeed: () => {
    const { phase } = get();
    if (phase === "verifying" || phase === "profile") {
      const now = Date.now();
      set({ phase: "granted", grantedAt: now, fullAt: fullAt(get().startedAt, now) });
    }
  },
  fail: () => set({ phase: "idle" }),
  close: () => {
    if (get().phase === "granted") set({ phase: "closing" });
  },
  reset: () => set({ phase: "idle", startedAt: 0, grantedAt: 0, fullAt: 0 }),
}));

/**
 * When the bar should reach 100 for a sign-in that began at `startedAt` and
 * succeeded at `grantedAt`: in time to hold "Access granted" before the
 * minimum is up, and never sooner than a visible fill.
 */
export function fullAt(startedAt: number, grantedAt: number): number {
  return Math.max(
    startedAt + SIGN_IN_MIN_VISIBLE_MS - SIGN_IN_GRANTED_HOLD_MS,
    grantedAt + SIGN_IN_MIN_FILL_MS,
  );
}

/** How long to stay on "Access granted" once the bar is full at `now`. */
export function grantedHoldMs(startedAt: number, now: number): number {
  return Math.max(startedAt + SIGN_IN_MIN_VISIBLE_MS - now, SIGN_IN_GRANTED_HOLD_MS);
}
