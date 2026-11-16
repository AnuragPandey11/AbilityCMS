/**
 * The sign-in screen is driven by AuthProvider's real steps: accepted
 * credentials and a readable account end "granted"; a refusal ends "idle" at
 * once, so the login form can say why.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider, useAuth } from "@/auth/AuthProvider";
import { useSignInScreen } from "@/auth/signInScreen";
import { setTokens } from "@/api/tokens";
import { ApiError } from "@/api/problem";
import * as authApi from "@/api/endpoints/auth";

vi.mock("@/api/endpoints/auth", () => ({
  login: vi.fn(),
  me: vi.fn(),
  logout: vi.fn(),
  switchClient: vi.fn(),
}));

const TOKENS = {
  access_token: "a",
  refresh_token: "r",
  token_type: "bearer",
  expires_at: "2099-01-01T00:00:00Z",
};

let signIn: ReturnType<typeof useAuth>["login"] = async () => ({ kind: "ok" });

function Grab(): null {
  signIn = useAuth().login;
  return null;
}

function mount() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AuthProvider>
        <Grab />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
  setTokens(null);
  useSignInScreen.getState().reset();
});

describe("signing in drives the screen", () => {
  it("ends granted when the credentials and the account both load", async () => {
    vi.mocked(authApi.login).mockResolvedValue(TOKENS);
    vi.mocked(authApi.me).mockResolvedValue({} as Awaited<ReturnType<typeof authApi.me>>);
    mount();
    await act(async () => {
      await signIn("a@b.co", "secret");
    });
    expect(useSignInScreen.getState().phase).toBe("granted");
  });

  it("ends idle at once when the credentials are refused", async () => {
    vi.mocked(authApi.login).mockRejectedValue(
      new ApiError({ status: 401, title: "Unauthorized", detail: "Invalid", type: "about:blank" }),
    );
    mount();
    let outcome;
    await act(async () => {
      outcome = await signIn("a@b.co", "wrong");
    });
    expect(outcome).toEqual({ kind: "invalid" });
    expect(useSignInScreen.getState().phase).toBe("idle");
  });

  it("ends idle when the account cannot be read after a good password", async () => {
    vi.mocked(authApi.login).mockResolvedValue(TOKENS);
    vi.mocked(authApi.me).mockRejectedValue(new Error("down"));
    mount();
    await act(async () => {
      await signIn("a@b.co", "secret");
    });
    expect(useSignInScreen.getState().phase).toBe("idle");
  });
});
