/**
 * The checkbox menu the power trend's comparisons are chosen from.
 *
 * An option this Plant cannot answer stays listed, disabled, with its reason —
 * an option that silently disappears reads as a feature that does not exist.
 */

import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { CheckboxMenu } from "@/components/ui/CheckboxMenu";

type Key = "radiation" | "exp_ac";

const options = [
  { value: "radiation" as Key, label: "Direct radiation", description: "From the weather station." },
  {
    value: "exp_ac" as Key,
    label: "Exp Power (AC)",
    disabledReason: "No AC capacity is recorded for this Plant.",
  },
];

describe("checkbox menu", () => {
  it("opens, says why a disabled option is off, and reports a toggle", () => {
    let chosen: Set<Key> = new Set();
    render(
      <CheckboxMenu label="Select options" options={options} selected={chosen} onChange={(next) => (chosen = next)} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Select options/ }));

    const off = screen.getByRole("checkbox", { name: /Exp Power \(AC\)/ });
    expect(off).toBeDisabled();
    expect(screen.getByText("No AC capacity is recorded for this Plant.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: /Direct radiation/ }));
    expect([...chosen]).toEqual(["radiation"]);
  });

  it("does not count a chosen option this Plant cannot draw", () => {
    render(
      <CheckboxMenu
        label="Select options"
        options={options}
        selected={new Set<Key>(["exp_ac"])}
        onChange={() => {}}
      />,
    );
    // Chosen but disabled: nothing is being shown, so there is no count.
    expect(screen.getByRole("button", { name: /Select options/ }).textContent).toBe("Select options");
  });

  it("closes on Escape", () => {
    render(<CheckboxMenu label="Select options" options={options} selected={new Set<Key>()} onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Select options/ }));
    expect(screen.getByRole("group")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
  });
});
