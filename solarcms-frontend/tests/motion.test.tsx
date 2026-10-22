/**
 * The interface motion: drawers that slide, a toggle whose pill slides, rows
 * that leave, content that reveals.
 *
 * Animations finish at once under test (`tests/setup.ts`), so these assert what
 * the motion must never break — the scroll lock, focus, and what is on screen
 * once it has finished — rather than how anything moved.
 */
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Drawer } from "@/components/ui/Drawer";
import { Reveal, SegmentedControl } from "@/components/ui";
import { DataTable } from "@/components/tables/DataTable";

function Handover({ which }: { which: "a" | "b" | null }): JSX.Element {
  return (
    <>
      <Drawer open={which === "a"} onClose={() => undefined} title="Stage">
        <p>stage list</p>
      </Drawer>
      <Drawer open={which === "b"} onClose={() => undefined} title="Device">
        <p>device detail</p>
      </Drawer>
    </>
  );
}

describe("Drawer", () => {
  it("locks the page while open and gives it back once closed", async () => {
    const { rerender } = render(<Handover which="a" />);
    expect(document.body.style.overflow).toBe("hidden");

    rerender(<Handover which={null} />);
    expect(document.body.style.overflow).toBe("");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps the page locked through a handover, and unlocks after the last", async () => {
    const { rerender } = render(<Handover which="a" />);
    // One closes as the next opens, in the same commit: the first is still
    // sliding out while the second slides in.
    rerender(<Handover which="b" />);
    expect(document.body.style.overflow).toBe("hidden");
    await waitFor(() => expect(screen.queryByText("stage list")).toBeNull());
    expect(document.body.style.overflow).toBe("hidden");

    rerender(<Handover which={null} />);
    expect(document.body.style.overflow).toBe("");
  });

  it("leaves focus in the drawer that took over, not the one leaving", async () => {
    const { rerender } = render(<Handover which="a" />);
    rerender(<Handover which="b" />);
    await waitFor(() => expect(screen.queryByText("stage list")).toBeNull());
    expect(screen.getByRole("dialog", { name: "Device" })).toHaveFocus();
  });

  it("closes on Escape with the latest handler", () => {
    const closed: string[] = [];
    function Host(): JSX.Element {
      const [label, setLabel] = useState("first");
      return (
        <>
          <button type="button" onClick={() => setLabel("second")}>
            change
          </button>
          <Drawer open onClose={() => closed.push(label)} title="Panel">
            <p>body</p>
          </Drawer>
        </>
      );
    }
    render(<Host />);
    fireEvent.click(screen.getByText("change"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(closed).toEqual(["second"]);
  });
});

describe("SegmentedControl", () => {
  it("is still a radio group with one raised pill, on the chosen option", () => {
    function Host(): JSX.Element {
      const [value, setValue] = useState<"day" | "week">("day");
      return (
        <SegmentedControl
          label="Period"
          value={value}
          onChange={setValue}
          options={[
            { value: "day", label: "Day" },
            { value: "week", label: "Week" },
          ]}
        />
      );
    }
    const { container } = render(<Host />);
    fireEvent.click(screen.getByRole("radio", { name: "Week" }));
    expect(screen.getByRole("radio", { name: "Week" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Day" })).toHaveAttribute("aria-checked", "false");
    const pills = container.querySelectorAll("span[aria-hidden]");
    expect(pills).toHaveLength(1);
    expect(screen.getByRole("radio", { name: "Week" }).contains(pills[0] as Node)).toBe(true);
  });
});

describe("Reveal", () => {
  it("shows its content when open and removes it once closed", async () => {
    const { rerender } = render(
      <Reveal open={false}>
        <p>detail</p>
      </Reveal>,
    );
    expect(screen.queryByText("detail")).toBeNull();
    rerender(
      <Reveal open>
        <p>detail</p>
      </Reveal>,
    );
    expect(screen.getByText("detail")).toBeInTheDocument();
    rerender(
      <Reveal open={false}>
        <p>detail</p>
      </Reveal>,
    );
    await waitFor(() => expect(screen.queryByText("detail")).toBeNull());
  });
});

describe("DataTable rows that come and go", () => {
  const columns = [{ key: "name", header: "Name", render: (row: { id: number; name: string }) => row.name }];

  it("fades out a row the caller marks as leaving, and keeps the rest", async () => {
    const rows = [
      { id: 1, name: "COMM_LOST" },
      { id: 2, name: "VCB_TRIP" },
    ];
    const { rerender } = render(
      <DataTable rows={rows} columns={columns} rowKey={(row) => row.id} leavingKeys={new Set()} />,
    );
    rerender(
      <DataTable rows={rows} columns={columns} rowKey={(row) => row.id} leavingKeys={new Set([2])} />,
    );
    const leaving = screen.getByText("VCB_TRIP").closest("tr") as HTMLElement;
    const staying = screen.getByText("COMM_LOST").closest("tr") as HTMLElement;
    await waitFor(() => expect(leaving.style.opacity).toBe("0"));
    expect(staying.style.opacity).not.toBe("0");
  });

  it("shows a row that arrives between refreshes", async () => {
    const first = [{ id: 1, name: "COMM_LOST" }];
    const { rerender } = render(
      <DataTable rows={first} columns={columns} rowKey={(row) => row.id} animateArrivals />,
    );
    await act(async () => {
      rerender(
        <DataTable
          rows={[{ id: 3, name: "PLANT_SILENT" }, ...first]}
          columns={columns}
          rowKey={(row) => row.id}
          animateArrivals
        />,
      );
    });
    await waitFor(() => {
      const arrived = screen.getByText("PLANT_SILENT").closest("tr") as HTMLElement;
      expect(arrived.style.opacity).toBe("1");
    });
  });
});
