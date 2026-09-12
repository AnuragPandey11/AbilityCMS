/**
 * Theme and password-reveal behaviour.
 *
 * The theme assertions are about the *mechanism* rather than about specific
 * colours: `data-theme` on <html>, persistence, and the fact that an explicit
 * choice survives a remount. Asserting hex values here would only restate
 * `index.css` and would break on every palette tweak.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";

import { ThemeProvider, applyTheme } from "@/theme/ThemeProvider";
import { ThemeToggle } from "@/theme/ThemeToggle";
import { PasswordInput } from "@/components/ui";
import { qualityColor } from "@/theme/tokens";

function withTheme(children: ReactNode) {
  return render(<ThemeProvider>{children}</ThemeProvider>);
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

describe("theme", () => {
  it("defaults to following the system, leaving no data-theme attribute", () => {
    withTheme(<ThemeToggle />);
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("writes an explicit choice to <html> and remembers it", () => {
    withTheme(<ThemeToggle />);

    fireEvent.click(screen.getByRole("button"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem("solarcms.theme")).toBe("dark");

    fireEvent.click(screen.getByRole("button"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem("solarcms.theme")).toBe("light");
  });

  it("restores a stored choice on mount, so a reload does not flash the default", () => {
    localStorage.setItem("solarcms.theme", "dark");
    withTheme(<ThemeToggle />);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("removes the attribute when following the system again", () => {
    act(() => {
      applyTheme("dark");
    });
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    act(() => {
      applyTheme("system");
    });
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("keeps every quality code a distinct colour (Guardrail 4)", () => {
    // The fallback palette must be complete: a missing token resolves to black
    // and would merge "out of range" with "unparseable".
    const colours = [0, 1, 2, 3].map(qualityColor);
    expect(new Set(colours).size).toBe(4);
    expect(colours).not.toContain("rgb(0 0 0)");
  });
});

describe("password reveal", () => {
  it("starts masked and toggles the input type without losing the value", () => {
    let value = "";
    const { rerender } = render(
      <PasswordInput
        value={value}
        onChange={(next) => {
          value = next;
        }}
      />,
    );

    const input = () => document.querySelector("input") as HTMLInputElement;
    expect(input().type).toBe("password");

    fireEvent.change(input(), { target: { value: "hunter2" } });
    expect(value).toBe("hunter2");
    rerender(<PasswordInput value={value} onChange={() => undefined} />);

    const reveal = screen.getByRole("button", { name: /show password/i });
    expect(reveal).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(reveal);
    // The value must survive the type flip — a remount here would clear it.
    expect(input().type).toBe("text");
    expect(input().value).toBe("hunter2");
    expect(screen.getByRole("button", { name: /hide password/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: /hide password/i }));
    expect(input().type).toBe("password");
    expect(input().value).toBe("hunter2");
  });

  it("keeps the reveal out of the tab order so tabbing reaches submit", () => {
    render(<PasswordInput value="" onChange={() => undefined} />);
    expect(screen.getByRole("button", { name: /show password/i })).toHaveAttribute(
      "tabindex",
      "-1",
    );
  });
});
