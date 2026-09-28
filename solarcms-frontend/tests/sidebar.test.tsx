/**
 * The sidebar folds to an icon rail from `lg` up, and remembers that it did.
 *
 * jsdom applies no media queries, so the breakpoint contract is asserted on the
 * classes: every rail class must be `lg:`-prefixed, or the slide-over below
 * `lg` would open as a 72px strip of unlabelled icons. What must survive the
 * fold is asserted directly — the links keep their names, and the open-Alarm
 * count stays on screen, since it is the reason to glance at a folded menu.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Me } from "@/api/schemas";

const me: Me = {
  user_id: 1,
  client_id: 20,
  client_code: "ROOFCO",
  client_name: "Roofco Rooftops",
  role: "admin",
  platform_admin: false,
  permissions: ["dashboard.view"],
  plants: [],
  dashboards: ["portfolio", "single_plant", "alarms"],
};

vi.mock("@/auth/AuthProvider", () => ({
  useAuth: () => ({ me, status: "authenticated", logout: async () => undefined }),
}));

vi.mock("@/api/hooks", () => ({
  useAlarms: () => ({ data: [{ id: 1 }, { id: 2 }, { id: 3 }] }),
}));

vi.mock("@/live/LiveIndicator", () => ({ LiveIndicator: () => null }));

const { AppShell } = await import("@/components/layout/AppShell");
const { ThemeProvider } = await import("@/theme/ThemeProvider");
const { SIDEBAR_STORAGE_KEY } = await import("@/state/useSidebarCollapsed");

function renderShell() {
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={["/d/portfolio"]}>
        <AppShell />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

function sidebar(): HTMLElement {
  const aside = document.getElementById("app-sidebar");
  if (!aside) throw new Error("no sidebar");
  return aside;
}

beforeEach(() => {
  localStorage.clear();
});

describe("collapsible sidebar", () => {
  it("opens expanded, with labels and no tooltips", () => {
    renderShell();
    const toggle = screen.getByRole("button", { name: "Collapse the sidebar" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(sidebar().className).not.toContain("lg:w-[4.5rem]");
    expect(screen.getByRole("link", { name: "Portfolio" })).not.toHaveAttribute("title");
  });

  it("folds to a rail that keeps each link's name and the Alarm count", () => {
    renderShell();
    fireEvent.click(screen.getByRole("button", { name: "Collapse the sidebar" }));

    expect(screen.getByRole("button", { name: "Expand the sidebar" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(sidebar().className).toContain("lg:w-[4.5rem]");

    const portfolio = screen.getByRole("link", { name: "Portfolio" });
    expect(portfolio).toHaveAttribute("title", "Portfolio");
    // The label is hidden visually on the rail only — never below `lg`.
    const label = portfolio.querySelector("span");
    expect(label?.className).toContain("lg:sr-only");
    expect(label?.className.split(/\s+/)).not.toContain("sr-only");

    expect(screen.getByTitle("3 Alarm(s) open and not yet acknowledged")).toHaveTextContent("3");
  });

  it("stays full width below lg whatever the preference", () => {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, "collapsed");
    renderShell();
    const classes = sidebar().className.split(/\s+/);
    expect(classes).toContain("w-60");
    expect(classes).not.toContain("w-[4.5rem]");
  });

  it("remembers the choice across a reload", () => {
    const first = renderShell();
    fireEvent.click(screen.getByRole("button", { name: "Collapse the sidebar" }));
    expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe("collapsed");
    first.unmount();

    renderShell();
    expect(screen.getByRole("button", { name: "Expand the sidebar" })).toBeInTheDocument();
  });
});
