/**
 * The sign-in screen follows the real steps of signing in: its bar never runs
 * past the step under way, reaches 100% only once signed in, and a failure
 * removes it at once.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import {
  SIGN_IN_GRANTED_HOLD_MS,
  SIGN_IN_MIN_FILL_MS,
  SIGN_IN_MIN_VISIBLE_MS,
  fullAt,
  grantedHoldMs,
  nextProgress,
  useSignInScreen,
} from "@/auth/signInScreen";
import { SignInScreen } from "@/components/layout/SignInScreen";

vi.mock("@/theme/ThemeProvider", () => ({
  useTheme: () => ({ resolved: "dark", choice: "dark", setChoice: () => {} }),
}));

describe("the bar", () => {
  it("never passes the step under way, however long it takes", () => {
    expect(nextProgress(0, "verifying", 60_000)).toBeLessThanOrEqual(45);
    expect(nextProgress(30, "profile", 60_000)).toBeLessThanOrEqual(88);
  });

  it("reaches 100 only once signed in", () => {
    expect(nextProgress(88, "profile", 60_000)).toBeLessThan(100);
    expect(nextProgress(88, "granted", 16, 0)).toBe(100);
  });

  it("fills evenly once signed in, rather than jumping to the end", () => {
    // Halfway through the time left, halfway through the gap.
    expect(nextProgress(20, "granted", 500, 1000)).toBe(60);
  });

  it("never moves backwards into a lower step", () => {
    expect(nextProgress(70, "verifying", 16)).toBe(70);
  });

  it("is empty when idle", () => {
    expect(nextProgress(50, "idle", 16)).toBe(0);
  });
});

describe("how long it stays", () => {
  it("fills a quick sign-in across the screen's minimum time", () => {
    expect(fullAt(0, 150)).toBe(SIGN_IN_MIN_VISIBLE_MS - SIGN_IN_GRANTED_HOLD_MS);
  });

  it("still fills visibly after a slow sign-in", () => {
    expect(fullAt(0, 5_000)).toBe(5_000 + SIGN_IN_MIN_FILL_MS);
  });

  it("holds 'Access granted' until the minimum has passed", () => {
    const full = SIGN_IN_MIN_VISIBLE_MS - SIGN_IN_GRANTED_HOLD_MS;
    expect(grantedHoldMs(0, full)).toBe(SIGN_IN_GRANTED_HOLD_MS);
    expect(grantedHoldMs(0, 6_000)).toBe(SIGN_IN_GRANTED_HOLD_MS);
  });
});

describe("the screen", () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    useSignInScreen.getState().reset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    useSignInScreen.getState().reset();
  });

  it("is absent until a sign-in begins", () => {
    render(<SignInScreen />);
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("names the step under way", () => {
    render(<SignInScreen />);
    act(() => useSignInScreen.getState().begin());
    expect(screen.getByRole("status")).toHaveTextContent(/authenticating/i);
    act(() => useSignInScreen.getState().profile());
    expect(screen.getByRole("status")).toHaveTextContent(/loading workspace/i);
    act(() => useSignInScreen.getState().succeed());
    expect(screen.getByRole("status")).toHaveTextContent(/access granted/i);
  });

  it("goes at once when the sign-in fails", () => {
    render(<SignInScreen />);
    act(() => useSignInScreen.getState().begin());
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    act(() => useSignInScreen.getState().fail());
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("cannot be granted without having begun", () => {
    useSignInScreen.getState().succeed();
    expect(useSignInScreen.getState().phase).toBe("idle");
  });
});
