/**
 * The Alarm Emails screen: it offers each person only the Plants they can see,
 * shows the server's verdict on every row, and never offers a test email that
 * a real Alarm would not produce.
 *
 * The API is mocked at the endpoint module, so what is asserted is exactly the
 * call each control makes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { Subscription, SubscriptionOptions } from "@/api/endpoints/notifications";

const me = { permissions: ["user.manage", "dashboard.view"], plants: [], dashboards: [] };
vi.mock("@/auth/AuthProvider", () => ({
  useAuth: () => ({ me, status: "authenticated", refreshMe: vi.fn(), logout: vi.fn() }),
}));
vi.mock("@/api/endpoints/clients", () => ({ listClients: vi.fn(async () => []) }));

let options: SubscriptionOptions;
let rows: Subscription[];

const api = vi.hoisted(() => ({
  listSubscriptions: vi.fn(),
  subscriptionOptions: vi.fn(),
  createSubscription: vi.fn(async () => ({})),
  updateSubscription: vi.fn(async () => ({})),
  deleteSubscription: vi.fn(async () => undefined),
  sendTest: vi.fn(async () => ({ notification_id: 1, email: "asha@example.com" })),
}));
vi.mock("@/api/endpoints/notifications", () => api);

import { AlarmEmailsAdmin } from "@/admin/AlarmEmailsAdmin";

function baseOptions(): SubscriptionOptions {
  return {
    client_id: 4,
    members: [
      { user_id: 1, email: "asha@example.com", full_name: "Asha", is_active: true,
        role_code: "admin", plant_ids: [], sees_every_plant: true },
      { user_id: 2, email: "ravi@example.com", full_name: "Ravi", is_active: true,
        role_code: "employee", plant_ids: [11], sees_every_plant: false },
    ],
    plants: [
      { id: 11, code: "NORTH", name: "North Mill" },
      { id: 12, code: "SOUTH", name: "South Mill" },
    ],
    channels: [
      { code: "email", label: "Email", available: true, configured: true, reason: null },
      { code: "sms", label: "SMS", available: false, configured: false, reason: "no phone" },
    ],
    severities: [],
  };
}

function row(partial: Partial<Subscription> & Pick<Subscription, "id" | "user_id" | "email">): Subscription {
  return {
    client_id: 4, full_name: null, role_code: "admin", plant_id: null, plant_code: null,
    plant_name: null, channel: "email", min_severity: "medium", enabled: true,
    receives: ["medium", "high", "critical"], sending: true, not_sent_reason: null,
    last_notification: null, ...partial,
  };
}

function renderScreen() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AlarmEmailsAdmin />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  options = baseOptions();
  rows = [
    row({ id: 7, user_id: 1, email: "asha@example.com", full_name: "Asha",
      last_notification: { status: "failed", at: "2026-10-13T10:00:00Z", subject: "x",
        failure_reason: "smtp error: 554 Email address is not verified" } }),
    row({ id: 8, user_id: 2, email: "ravi@example.com", full_name: "Ravi",
      role_code: "employee", plant_id: 12, plant_code: "SOUTH", plant_name: "South Mill",
      sending: false, not_sent_reason: "Ravi cannot see that Plant." }),
  ];
  api.listSubscriptions.mockImplementation(async () => rows);
  api.subscriptionOptions.mockImplementation(async () => options);
  for (const fn of Object.values(api)) fn.mockClear();
});

describe("Alarm Emails", () => {
  it("shows the server's verdict and the last email's failure on each row", async () => {
    renderScreen();
    expect(await screen.findByText("Ravi cannot see that Plant.")).toBeInTheDocument();
    expect(screen.getByText(/554 Email address is not verified/)).toBeInTheDocument();

    const ravi = screen.getByText("ravi@example.com").closest("tr")!;
    expect(within(ravi).getByRole("button", { name: "Send test" })).toBeDisabled();
    const asha = screen.getByText("asha@example.com").closest("tr")!;
    fireEvent.click(within(asha).getByRole("button", { name: "Send test" }));
    await waitFor(() => expect(api.sendTest).toHaveBeenCalledWith(7));
  });

  it("offers each person only the Plants they can see", async () => {
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: "Add recipient" }));

    const person = screen.getByLabelText(/Person/);
    const plants = () => screen.getByLabelText(/Plants/) as HTMLSelectElement;
    const offered = () => [...plants().options].map((o) => o.textContent);

    fireEvent.change(person, { target: { value: "2" } });
    expect(offered()).toEqual(["Choose…", "NORTH — North Mill"]);

    fireEvent.change(person, { target: { value: "1" } });
    expect(offered()).toEqual([
      "Choose…", "Every Plant", "NORTH — North Mill", "SOUTH — South Mill",
    ]);
    fireEvent.change(plants(), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText(/fewer emails/), { target: { value: "high" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(api.createSubscription).toHaveBeenCalledWith({
        user_id: 1, plant_id: null, min_severity: "high", client_id: null,
      }),
    );
  });

  it("says when someone has no Plants to be emailed about", async () => {
    options.members[1]!.plant_ids = [];
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: "Add recipient" }));
    fireEvent.change(screen.getByLabelText(/Person/), { target: { value: "2" } });
    expect(screen.getByText(/has no Plants assigned/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
  });

  it("warns when no email server is configured, and offers no test", async () => {
    options.channels[0] = {
      code: "email", label: "Email", available: true, configured: false,
      reason: "No email server is configured on this server.",
    };
    renderScreen();
    expect(await screen.findByText(/No email server is configured/)).toBeInTheDocument();
    for (const button of screen.getAllByRole("button", { name: "Send test" })) {
      expect(button).toBeDisabled();
    }
  });
});
