/**
 * The New Client form in Plant Onboarding creates the Client's first login with
 * it, in the same request — as Clients → "+ Add a Client" does. It used to
 * create a Client nobody could sign into.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const clients = vi.hoisted(() => ({
  createClient: vi.fn(async () => ({
    id: 9, code: "SUNFIELD", name: "Sunfield", status: "onboarding", is_demo: false,
  })),
}));
vi.mock("@/api/endpoints/clients", () => clients);

import { NewClientForm } from "@/admin/NewClientForm";

function renderForm(onCreated = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <NewClientForm submitLabel="Create" onCreated={onCreated} />
    </QueryClientProvider>,
  );
  return onCreated;
}

const field = (label: RegExp) => screen.getByLabelText(label);

beforeEach(() => clients.createClient.mockClear());

describe("New Client form", () => {
  it("cannot create a Client until its first login is filled in", () => {
    renderForm();
    fireEvent.change(field(/^Code/), { target: { value: "SUNFIELD" } });
    fireEvent.change(field(/^Name/), { target: { value: "Sunfield" } });
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();

    fireEvent.change(field(/^Email/), { target: { value: "owner@sunfield.example" } });
    fireEvent.change(field(/^Password/), { target: { value: "short" } });
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
  });

  it("sends the Client and its login together, a Client Admin by default", async () => {
    const onCreated = renderForm();
    fireEvent.change(field(/^Code/), { target: { value: "SUNFIELD" } });
    fireEvent.change(field(/^Name/), { target: { value: "Sunfield" } });
    fireEvent.change(field(/^Email/), { target: { value: "owner@sunfield.example" } });
    fireEvent.change(field(/^Full name/), { target: { value: "Owner" } });
    fireEvent.change(field(/^Password/), { target: { value: "longenough1" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(clients.createClient).toHaveBeenCalledTimes(1));
    expect(clients.createClient).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "SUNFIELD",
        first_user: {
          email: "owner@sunfield.example", password: "longenough1",
          full_name: "Owner", role_code: "admin",
        },
      }),
    );
    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 9 }), "owner@sunfield.example"),
    );
  });
});
