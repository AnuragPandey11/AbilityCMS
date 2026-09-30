/**
 * Client and Plant codes are confirmed against the broker, not typed blind.
 *
 * The failure this guards against happened: a Client registered as
 * `kular-green` while every topic said `KULAR_GREEN`. Nothing errored, every
 * existing Device kept resolving by exact topic, and the first new one would
 * have been quarantined.
 */

import { useState } from "react";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  PublishingCodes,
  looseKey,
  nearMiss,
  usePrefillOnce,
  type PublishingCode,
} from "@/admin/PublishingCodes";

const code = (value: string, unregistered = true): PublishingCode => ({
  code: value,
  unregistered,
  title: "3 device(s), last heard 20s ago.",
});

describe("a near-miss", () => {
  it("differs only by case, hyphens, underscores or spaces", () => {
    expect(looseKey("kular-green")).toBe(looseKey("KULAR_GREEN"));
    expect(looseKey("Kular Green")).toBe("KULARGREEN");
    expect(nearMiss("kular-green", [code("KULAR_GREEN")])).toBe("KULAR_GREEN");
  });

  it("is never an exact match, a different code, or a registered one", () => {
    expect(nearMiss("KULAR_GREEN", [code("KULAR_GREEN")])).toBeNull();
    expect(nearMiss("KULAR_NORTH", [code("KULAR_GREEN")])).toBeNull();
    // Already registered: nothing to register it as, so nothing to offer.
    expect(nearMiss("kular-green", [code("KULAR_GREEN", false)])).toBeNull();
    expect(nearMiss("   ", [code("KULAR_GREEN")])).toBeNull();
  });
});

describe("beside the field", () => {
  it("warns about a near-miss and fixes it in one click", () => {
    const picked: string[] = [];
    render(<PublishingCodes typed="kular-green" codes={[code("KULAR_GREEN")]} onPick={(c) => picked.push(c)} />);
    expect(screen.getByRole("alert").textContent).toContain("The broker is receiving KULAR_GREEN");
    fireEvent.click(screen.getByText("Use KULAR_GREEN"));
    expect(picked).toEqual(["KULAR_GREEN"]);
  });

  it("confirms an exact match, and offers the codes still to register", () => {
    render(
      <PublishingCodes
        typed="SF_NORTH"
        codes={[code("SF_NORTH"), code("SF_SOUTH"), code("WH1", false)]}
        onPick={() => {}}
      />,
    );
    expect(screen.getByText(/matches what the broker is receiving/)).toBeTruthy();
    // The one typed is not offered again, and a registered one never is.
    expect(screen.queryByRole("button", { name: "SF_NORTH" })).toBeNull();
    expect(screen.getByRole("button", { name: "SF_SOUTH" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "WH1" })).toBeNull();
  });

  it("renders nothing where discovery has nothing to say", () => {
    const { container } = render(<PublishingCodes typed="X" codes={undefined} onPick={() => {}} />);
    expect(container.innerHTML).toBe("");
  });
});

function Field({ codes, initial = "" }: { codes: PublishingCode[] | undefined; initial?: string }) {
  const [value, setValue] = useState(initial);
  const prefilled = usePrefillOnce(value, codes, setValue);
  return (
    <>
      <input aria-label="code" value={value} onChange={(e) => setValue(e.target.value)} />
      <span data-testid="prefilled">{String(prefilled)}</span>
    </>
  );
}

describe("prefilling", () => {
  const field = () => screen.getByLabelText("code") as HTMLInputElement;

  it("fills the one code arriving, and says it did", () => {
    render(<Field codes={[code("SF_NORTH"), code("WH1", false)]} />);
    expect(field().value).toBe("SF_NORTH");
    expect(screen.getByTestId("prefilled").textContent).toBe("true");
  });

  it("never chooses between two", () => {
    render(<Field codes={[code("SF_NORTH"), code("SF_SOUTH")]} />);
    expect(field().value).toBe("");
  });

  it("never overwrites what was typed", () => {
    render(<Field codes={[code("SF_NORTH")]} initial="MY_PLANT" />);
    expect(field().value).toBe("MY_PLANT");
  });

  it("does not come back once cleared", () => {
    render(<Field codes={[code("SF_NORTH")]} />);
    fireEvent.change(field(), { target: { value: "" } });
    expect(field().value).toBe("");
  });

  it("waits while nothing is known, rather than deciding on a stale value", () => {
    const { rerender } = render(<Field codes={undefined} initial="" />);
    expect(field().value).toBe("");
    rerender(<Field codes={[code("SF_NORTH")]} />);
    expect(field().value).toBe("SF_NORTH");
  });
});
