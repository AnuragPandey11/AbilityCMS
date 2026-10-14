/**
 * The refresh after a write, at its edges: the identity it re-reads, the
 * timer that catches somebody else's edit, what it leaves alone, and what
 * happens once the screen has gone.
 *
 * `afterwrite.test.tsx` shows a change reaching the screen. These are the
 * promises around it that nothing on screen would reveal when broken: a
 * dropped request after a save must not sign anybody out, one Client's answer
 * must never land in another's session, an unchanged identity must not
 * re-render the application, and nothing may keep asking once unmounted.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { request, setWriteHandler } from "@/api/client";
import { CONFIGURATION_REFRESH_MS, WRITE_SETTLE_MS } from "@/api/afterWrite";
import { qk } from "@/api/queryKeys";
import type { Me } from "@/api/schemas";
import { getTokens, setTokens } from "@/api/tokens";
import { AuthProvider, useAuth } from "@/auth/AuthProvider";

function respond(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const TOKENS = {
  access_token: "a", refresh_token: "r", token_type: "bearer", expires_at: "2099-01-01T00:00:00Z",
};

async function settle(): Promise<void> {
  await act(() => new Promise((resolve) => setTimeout(resolve, WRITE_SETTLE_MS + 50)));
}

function pathOf(input: RequestInfo | URL): string {
  return new URL(String(input), "http://localhost").pathname.replace(/^\/api/, "");
}

describe("the identity and the cache after a write", () => {
  let plantName = "Sunfield North";
  let meFails = false;
  let meGate: Promise<void> | null = null;
  let asked: Record<string, number> = {};
  const seen = new Set<Me>();

  const identity = () => ({
    user_id: 1, client_id: 1, client_code: "SUNFIELD", client_name: "Sunfield", role: "admin",
    platform_admin: false, permissions: ["plant.manage"], dashboards: ["single_plant"],
    plants: [{ id: 1, code: "SF_NORTH", name: plantName, status: "active" }],
  });

  beforeEach(() => {
    plantName = "Sunfield North";
    meFails = false;
    meGate = null;
    asked = {};
    seen.clear();
    setTokens(TOKENS);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = pathOf(input);
        asked[path] = (asked[path] ?? 0) + 1;
        if (path === "/auth/me") {
          if (meGate) await meGate;
          return meFails ? respond({ title: "Bad gateway", status: 502 }, 502) : respond(identity());
        }
        if (path === "/readings") return respond({ readings: [] });
        if (path === "/catalog/tags" && !init?.method) return respond([]);
        return respond({ ok: true });
      }),
    );
  });

  afterEach(() => {
    cleanup();
    setTokens(null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function Screen() {
    const { me, status } = useAuth();
    if (me) seen.add(me);
    // Both cached for ever, so only the refresh after a write could re-ask.
    useQuery({
      queryKey: qk.readings({ deviceIds: [7] } as Parameters<typeof qk.readings>[0]),
      queryFn: () => request("/readings"),
      staleTime: Number.POSITIVE_INFINITY,
    });
    useQuery({
      queryKey: qk.tags(),
      queryFn: () => request("/catalog/tags"),
      staleTime: Number.POSITIVE_INFINITY,
    });
    return (
      <>
        <p>status: {status}</p>
        <p>picker: {me?.plants[0]?.name ?? "…"}</p>
      </>
    );
  }

  async function mount(): Promise<void> {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AuthProvider>
          <Screen />
        </AuthProvider>
      </QueryClientProvider>,
    );
    await settle();
  }

  it("keeps the identity and the session when the re-read fails", async () => {
    await mount();
    meFails = true;
    await request("/plants/1", { method: "PATCH", body: { name: "x" } });
    await settle();
    expect(asked["/auth/me"]).toBe(2);
    expect(screen.getByText("picker: Sunfield North")).toBeInTheDocument();
    expect(screen.getByText("status: authenticated")).toBeInTheDocument();
    expect(getTokens()).not.toBeNull();
  });

  it("drops an answer that arrives after the session changed", async () => {
    await mount();
    let release: () => void = () => {};
    meGate = new Promise((resolve) => {
      release = resolve;
    });
    plantName = "Asked under the old session";
    await request("/plants/1", { method: "PATCH", body: { name: "x" } });
    await settle();
    // Still in flight: the session changes under it, then the answer arrives.
    setTokens({ ...TOKENS, access_token: "another session" });
    release();
    await settle();
    expect(screen.getByText("picker: Sunfield North")).toBeInTheDocument();

    // The same answer under an unchanged session is taken: what dropped the
    // first was the change of session, not the timing.
    meGate = null;
    await request("/plants/1", { method: "PATCH", body: { name: "x" } });
    await settle();
    expect(screen.getByText("picker: Asked under the old session")).toBeInTheDocument();
  });

  it("keeps the same identity object when nothing in it changed", async () => {
    // A new object would re-render everything that reads the session, after
    // every save, for nothing.
    await mount();
    expect(seen.size).toBe(1);
    await request("/devices/7", { method: "PATCH", body: { name: "x" } });
    await settle();
    expect(asked["/auth/me"]).toBe(2);
    expect(seen.size).toBe(1);
  });

  it("leaves recorded readings alone, and the catalogue unless it was written", async () => {
    await mount();
    expect(asked["/readings"]).toBe(1);
    expect(asked["/catalog/tags"]).toBe(1);

    await request("/devices/7", { method: "PATCH", body: { name: "x" } });
    await settle();
    expect(asked["/readings"]).toBe(1);
    expect(asked["/catalog/tags"]).toBe(1);

    // A run of writes is refreshed once, for every path in it: the catalogue
    // write is not forgotten because a Device write came after it.
    await request("/catalog/tags/3", { method: "PATCH", body: { unit: "kW" } });
    await request("/devices/7", { method: "PATCH", body: { name: "y" } });
    await settle();
    expect(asked["/catalog/tags"]).toBe(2);
    expect(asked["/readings"]).toBe(1);
  });

  it("re-asks once a minute while the tab is shown, never while it is hidden", async () => {
    const intervals = vi.spyOn(globalThis, "setInterval");
    await mount();
    const call = intervals.mock.calls.find(([, ms]) => ms === CONFIGURATION_REFRESH_MS);
    expect(call).toBeDefined();
    const tick = call?.[0] as () => void;
    plantName = "Renamed elsewhere";

    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => tick());
    await settle();
    expect(asked["/auth/me"]).toBe(1);

    visibility.mockReturnValue("visible");
    await act(async () => tick());
    await settle();
    expect(asked["/auth/me"]).toBe(2);
    expect(screen.getByText("picker: Renamed elsewhere")).toBeInTheDocument();
  });

  it("asks for nothing once unmounted", async () => {
    const cleared = vi.spyOn(globalThis, "clearInterval");
    const intervals = vi.spyOn(globalThis, "setInterval");
    await mount();
    const index = intervals.mock.calls.findIndex(([, ms]) => ms === CONFIGURATION_REFRESH_MS);
    const timer = intervals.mock.results[index]?.value as unknown;

    // A write whose refresh is still waiting to settle when the screen goes.
    await request("/plants/1", { method: "PATCH", body: { name: "x" } });
    cleanup();
    await settle();
    expect(asked["/auth/me"]).toBe(1);
    expect(cleared).toHaveBeenCalledWith(timer);

    // Neither a later write nor coming back to the tab reaches it.
    await request("/plants/1", { method: "PATCH", body: { name: "y" } });
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(asked["/auth/me"]).toBe(1);
  });

  it("does not ask for the identity when nobody is signed in", async () => {
    setTokens(null);
    await mount();
    expect(screen.getByText("status: anonymous")).toBeInTheDocument();
    await request("/plants/1", { method: "PATCH", body: { name: "x" } });
    await settle();
    expect(asked["/auth/me"]).toBeUndefined();
  });
});

describe("a write that needed a fresh token", () => {
  const written: string[] = [];
  let refreshWorks = true;
  let patches = 0;

  beforeEach(() => {
    written.length = 0;
    refreshWorks = true;
    patches = 0;
    setTokens(TOKENS);
    setWriteHandler((path) => written.push(path));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = pathOf(input);
        if (path === "/auth/refresh") {
          return refreshWorks
            ? respond({ ...TOKENS, access_token: "fresh" })
            : respond({ title: "Unauthorized", status: 401 }, 401);
        }
        if (init?.method === "PATCH") {
          patches += 1;
          // The first attempt finds the access token expired.
          return patches === 1
            ? respond({ title: "Unauthorized", status: 401 }, 401)
            : respond({ ok: true });
        }
        return respond({ ok: true });
      }),
    );
  });

  afterEach(() => {
    setWriteHandler(() => {});
    setTokens(null);
    vi.unstubAllGlobals();
  });

  it("is announced once, after the retry succeeds; the refresh is not a write", async () => {
    await request("/devices/7", { method: "PATCH", body: { name: "x" } });
    expect(patches).toBe(2);
    expect(written).toEqual(["/devices/7"]);
  });

  it("is not announced when the session could not be renewed", async () => {
    refreshWorks = false;
    await expect(request("/devices/7", { method: "PATCH", body: { name: "x" } })).rejects.toThrow();
    expect(written).toEqual([]);
  });

  it("reads the method whatever its case, and HEAD is never a write", async () => {
    await request("/plants/1", { method: "get" });
    await request("/plants/1", { method: "HEAD" });
    await request("/devices/7", { method: "delete" });
    expect(written).toEqual(["/devices/7"]);
  });
});
