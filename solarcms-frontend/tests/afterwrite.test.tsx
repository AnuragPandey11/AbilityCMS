/**
 * A change shows wherever it is on screen, without a page reload.
 *
 * Each write used to refresh only the list its own button belonged to, and
 * half the writes were not `useMutation`s at all. The rest of the screen sat on
 * its cache — a minute for Plants, Devices and the diagram, the whole session
 * for the catalogue and for `/auth/me`, which drives the Plant picker — so a
 * renamed Plant kept its old name until the page was reloaded.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { request, setWriteHandler } from "@/api/client";
import { customTable } from "@/api/endpoints/reports";
import { CONFIGURATION_REFRESH_MS, staleAfterWrite, WRITE_SETTLE_MS } from "@/api/afterWrite";
import { CONFIGURATION } from "@/api/hooks";
import { qk } from "@/api/queryKeys";
import { setTokens } from "@/api/tokens";
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

/** Let the refresh after a write run, and everything it sets, inside `act`. */
async function settle(): Promise<void> {
  await act(() => new Promise((resolve) => setTimeout(resolve, WRITE_SETTLE_MS + 50)));
}

describe("which requests are announced as writes", () => {
  const written: string[] = [];

  beforeEach(() => {
    written.length = 0;
    setWriteHandler((path) => written.push(path));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), "http://localhost").pathname.replace(/^\/api/, "");
        if (path === "/refused") return respond({ title: "Conflict", status: 409 }, 409);
        if (path === "/reports/custom/table") {
          return respond({ kind: "custom", title: "t", columns: [], rows: [], notes: [] });
        }
        return init?.method === "DELETE" ? respond(null, 204) : respond({ ok: true });
      }),
    );
  });

  afterEach(() => {
    setWriteHandler(() => {});
    vi.unstubAllGlobals();
  });

  it("announces every method that changes something, including an empty reply", async () => {
    await request("/devices/7", { method: "PATCH", body: { name: "x" } });
    await request("/plants", { method: "POST", body: {} });
    await request("/users/3/plants", { method: "PUT", body: [] });
    await request("/devices/7/topics", { method: "DELETE" });
    expect(written).toEqual(["/devices/7", "/plants", "/users/3/plants", "/devices/7/topics"]);
  });

  it("does not announce a read", async () => {
    await request("/plants/1");
    expect(written).toEqual([]);
  });

  it("does not announce a write the server refused", async () => {
    await expect(request("/refused", { method: "POST", body: {} })).rejects.toThrow();
    expect(written).toEqual([]);
  });

  it("leaves signing in and switching Client to the full reset", async () => {
    await request("/auth/switch-client", { method: "POST", body: { client_id: 2 } });
    expect(written).toEqual([]);
  });

  it("never announces the custom report preview, which is a query", async () => {
    // Announced, it would refresh every query on screen — itself included —
    // which would POST again, and announce again, for ever. The reply is not a
    // whole table, so the schema refuses it, loudly; only the request matters.
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    await customTable({} as Parameters<typeof customTable>[0]).catch(() => undefined);
    quiet.mockRestore();
    expect(written).toEqual([]);
  });
});

describe("what a write makes out of date", () => {
  it("refreshes configuration everywhere, not only the list the button was in", () => {
    for (const key of [qk.plantSld(1), qk.plantDashboard(1), qk.plantDevices(1), qk.allPlants(),
      qk.device(7), qk.bindings(7), qk.dataIssuesSummary(), qk.users(), qk.alarms({})]) {
      expect(staleAfterWrite(key, ["/devices/7"])).toBe(true);
    }
  });

  it("leaves what was recorded alone", () => {
    const readings = qk.readings({ deviceIds: [7] } as Parameters<typeof qk.readings>[0]);
    expect(staleAfterWrite(readings, ["/devices/7"])).toBe(false);
    expect(staleAfterWrite(qk.reportTable("daily_plant", 1, "today", null, null, null, null),
      ["/plants/1"])).toBe(false);
    expect(staleAfterWrite(qk.customTable({}), ["/reports/custom/saved"])).toBe(false);
    // The saved list is configuration, beside the preview in the same family.
    expect(staleAfterWrite(qk.savedReports(), ["/reports/custom/saved"])).toBe(true);
  });

  it("refreshes the session-cached catalogue only for a catalogue write", () => {
    expect(staleAfterWrite(qk.tags(), ["/devices/7"])).toBe(false);
    expect(staleAfterWrite(qk.tags(), ["/devices/7", "/catalog/tags"])).toBe(true);
    expect(staleAfterWrite(qk.deviceModels("INVERTER"), ["/catalog/device-models"])).toBe(true);
  });
});

describe("after a write, on screen", () => {
  let plantName = "Sunfield North";
  let sldAsked = 0;

  const identity = () => ({
    user_id: 1, client_id: 1, client_code: "SUNFIELD", client_name: "Sunfield", role: "admin",
    platform_admin: false, permissions: ["plant.manage"], dashboards: ["single_plant"],
    plants: [{ id: 1, code: "SF_NORTH", name: plantName, status: "active" }],
  });

  beforeEach(() => {
    plantName = "Sunfield North";
    sldAsked = 0;
    setTokens(TOKENS);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), "http://localhost").pathname.replace(/^\/api/, "");
        if (path === "/auth/me") return respond(identity());
        if (path === "/plants/1/sld") {
          sldAsked += 1;
          return respond({ name: plantName });
        }
        if (path === "/plants/1" && init?.method === "PATCH") {
          plantName = (JSON.parse(String(init.body)) as { name: string }).name;
          return respond({ id: 1 });
        }
        return respond({}, 404);
      }),
    );
  });

  afterEach(() => {
    // Unmounted first: clearing the tokens signs a mounted AuthProvider out.
    cleanup();
    setTokens(null);
    vi.unstubAllGlobals();
  });

  function Screen() {
    const { me } = useAuth();
    // Cached for ever: only the write can be what refreshes it.
    const sld = useQuery({
      queryKey: qk.plantSld(1),
      queryFn: () => request<{ name: string }>("/plants/1/sld"),
      staleTime: Number.POSITIVE_INFINITY,
    });
    return (
      <>
        <p>picker: {me?.plants[0]?.name ?? "…"}</p>
        <p>diagram: {sld.data?.name ?? "…"}</p>
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

  it("shows a renamed Plant in the picker and on the diagram, without a reload", async () => {
    await mount();
    expect(screen.getByText("picker: Sunfield North")).toBeInTheDocument();
    expect(screen.getByText("diagram: Sunfield North")).toBeInTheDocument();
    expect(sldAsked).toBe(1);

    // The way a settings drawer saves: a plain await, no `useMutation`, no
    // invalidation of its own.
    await request("/plants/1", { method: "PATCH", body: { name: "Sunfield N." } });
    await settle();

    expect(screen.getByText("picker: Sunfield N.")).toBeInTheDocument();
    expect(screen.getByText("diagram: Sunfield N.")).toBeInTheDocument();
    expect(sldAsked).toBe(2);
  });

  it("refreshes once after a run of writes, not once per write", async () => {
    await mount();
    for (const name of ["A", "B", "C"]) {
      await request("/plants/1", { method: "PATCH", body: { name } });
    }
    await settle();
    expect(screen.getByText("diagram: C")).toBeInTheDocument();
    expect(sldAsked).toBe(2);
  });

  it("shows somebody else's rename in the picker on coming back to the tab", async () => {
    await mount();
    expect(screen.getByText("picker: Sunfield North")).toBeInTheDocument();
    // Renamed in another browser: no write passes through this tab.
    plantName = "Renamed elsewhere";
    const shown = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle();
    shown.mockRestore();
    expect(screen.getByText("picker: Renamed elsewhere")).toBeInTheDocument();
  });

  it("does not ask while the tab is hidden", async () => {
    await mount();
    plantName = "Renamed elsewhere";
    const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle();
    hidden.mockRestore();
    expect(screen.getByText("picker: Sunfield North")).toBeInTheDocument();
  });
});

describe("somebody else's edit", () => {
  it("is re-asked for, not merely permitted to be", () => {
    // `staleTime` alone never refetches anything (tests/livecadence.test.ts);
    // without the interval another person's edit waited for a page reload.
    expect(CONFIGURATION.refetchInterval).toBe(CONFIGURATION_REFRESH_MS);
    expect(CONFIGURATION.staleTime).toBeLessThanOrEqual(CONFIGURATION.refetchInterval);
    expect(CONFIGURATION.refetchOnWindowFocus).toBe(true);
  });

  it("is at most about a minute behind", () => {
    expect(CONFIGURATION_REFRESH_MS).toBeLessThanOrEqual(60_000);
  });
});
