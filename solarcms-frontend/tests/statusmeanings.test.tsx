/**
 * A status code is shown with the meaning the client recorded for the Plant,
 * or as sent — never translated by a guess.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusCodeValue } from "@/components/devices/StatusMeanings";

describe("StatusCodeValue", () => {
  it("shows the client's meaning beside the code", () => {
    render(
      <StatusCodeValue
        value={512}
        meaning={{ code: 512, label: "Grid connected", kind: "normal", note: null }}
      />,
    );
    expect(screen.getByText("Grid connected")).toBeTruthy();
    expect(screen.getByText("512")).toBeTruthy();
  });

  it("shows a code nobody described as sent, and says why", () => {
    render(<StatusCodeValue value={40960} meaning={null} />);
    const code = screen.getByText("40960");
    expect(code.getAttribute("title")).toMatch(/shown as sent/);
  });

  it("colours a fault as bad news and a standby plainly", () => {
    const { rerender } = render(
      <StatusCodeValue value={7} meaning={{ code: 7, label: "Trip", kind: "fault", note: null }} />,
    );
    expect(screen.getByText("Trip").className).toMatch(/text-bad/);
    rerender(
      <StatusCodeValue value={3} meaning={{ code: 3, label: "Waiting", kind: "standby", note: null }} />,
    );
    expect(screen.getByText("Waiting").className).not.toMatch(/text-(ok|warn|bad)/);
  });
});
