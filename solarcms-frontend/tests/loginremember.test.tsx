/**
 * "Remember me" on the sign-in page decides whether a sign-in survives a reload:
 * ticked, the tokens are mirrored into localStorage; unticked, they live in the
 * tab's memory only and a reload (which reads storage) finds nothing.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LoginPage } from "@/components/layout/LoginPage";
import { getTokens, setPersistTokens, setTokens, type TokenPair } from "@/api/tokens";

const PAIR: TokenPair = {
  access_token: "a",
  refresh_token: "r",
  token_type: "bearer",
  expires_at: "2099-01-01T00:00:00Z",
};

// The real login stores the tokens it is given; do the same.
vi.mock("@/auth/AuthProvider", () => ({
  useAuth: () => ({
    login: async () => {
      setTokens(PAIR);
      return { kind: "ok" };
    },
  }),
}));

vi.mock("@/theme/ThemeProvider", () => ({
  useTheme: () => ({ resolved: "dark", choice: "dark", setChoice: () => {} }),
}));

const stored = () => window.localStorage.getItem("solarcms.tokens");

async function signIn(untick: boolean) {
  render(<LoginPage />);
  fireEvent.change(screen.getByPlaceholderText("Email"), { target: { value: "a@b.co" } });
  fireEvent.change(screen.getByPlaceholderText("Password"), { target: { value: "secret" } });
  if (untick) fireEvent.click(screen.getByLabelText(/remember me/i));
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
  await waitFor(() => expect(getTokens()).not.toBeNull());
}

beforeEach(() => {
  setTokens(null);
  setPersistTokens(true);
  window.localStorage.clear();
});

describe("remember me", () => {
  it("is ticked by default and keeps the sign-in across a reload", async () => {
    await signIn(false);
    expect(stored()).toContain('"access_token":"a"');
  });

  it("when unticked keeps the sign-in in memory only", async () => {
    await signIn(true);
    expect(stored()).toBeNull();
    expect(getTokens()?.access_token).toBe("a");
  });

  it("removes tokens already stored when a later sign-in is not remembered", () => {
    setTokens(PAIR);
    expect(stored()).not.toBeNull();
    setPersistTokens(false);
    expect(stored()).toBeNull();
    setTokens({ ...PAIR, access_token: "b" });
    expect(stored()).toBeNull();
  });

  it("has no forgotten-password link", () => {
    render(<LoginPage />);
    expect(screen.queryByText(/forgot/i)).toBeNull();
  });
});
