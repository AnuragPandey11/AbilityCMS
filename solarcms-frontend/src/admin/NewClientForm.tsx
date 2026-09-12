/**
 * Create a Client (`POST /clients`, Super Admin only).
 *
 * A new Client starts in `onboarding` and has no Plants; `onCreated` receives
 * the row so the caller can switch the session into it and carry on — the
 * onboarding wizard does exactly that, because a Plant cannot be created
 * without an active Client (I-9).
 *
 * ⚠ The commercial fields (GSTIN, client number, contact, contract) are
 * PROPOSED, not client-confirmed — migration 0019. All optional: a Client is
 * still creatable from a code and a name alone, which is how the test broker's
 * provisional Client exists.
 */

import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { qk } from "@/api/queryKeys";
import * as clientsApi from "@/api/endpoints/clients";
import { isApiError } from "@/api/problem";
import { Button, Field, inputClass } from "@/components/ui";

// The API enforces this too, and so does a CHECK constraint. Repeated here only
// so the operator is told before the round trip, never as the authority.
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

const today = (): string => new Date().toISOString().slice(0, 10);

/** Shown live beside the day count, so the stored date is never a surprise. */
function expiryPreview(start: string, days: string): string | null {
  const n = Number(days);
  if (!days.trim() || !Number.isFinite(n) || n < 1) return null;
  const date = new Date(`${start || today()}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + n);
  return date.toISOString().slice(0, 10);
}

export function NewClientForm({
  onCreated,
  submitLabel = "Create Client",
}: {
  onCreated?: (client: clientsApi.CreatedClient) => void;
  submitLabel?: string;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [isDemo, setIsDemo] = useState(false);
  const [clientNumber, setClientNumber] = useState("");
  const [gstNumber, setGstNumber] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contractStart, setContractStart] = useState(today());
  const [contractDays, setContractDays] = useState("");
  const [error, setError] = useState<string | null>(null);

  const gstError =
    gstNumber.trim() && !GSTIN.test(gstNumber.trim().toUpperCase())
      ? "Not a 15-character GSTIN (e.g. 27AAPFU0939F1ZV)."
      : undefined;

  const validTill = useMemo(
    () => expiryPreview(contractStart, contractDays),
    [contractStart, contractDays],
  );

  const reset = (): void => {
    setCode("");
    setName("");
    setIsDemo(false);
    setClientNumber("");
    setGstNumber("");
    setContactEmail("");
    setContractStart(today());
    setContractDays("");
  };

  const create = useMutation({
    mutationFn: () =>
      clientsApi.createClient({
        code: code.trim(),
        name: name.trim(),
        is_demo: isDemo,
        // Empty means "not supplied", which is null — not an empty string. A
        // blank GSTIN stored as "" would fail the CHECK constraint, and a blank
        // client_number would collide with the next blank one on the unique
        // index, where NULLs never collide.
        client_number: clientNumber.trim() || null,
        gst_number: gstNumber.trim().toUpperCase() || null,
        contact_email: contactEmail.trim() || null,
        contract_start_date: contractDays.trim() ? contractStart : null,
        contract_valid_days: contractDays.trim() ? Number(contractDays) : null,
      }),
    onSuccess: (created) => {
      setError(null);
      reset();
      void queryClient.invalidateQueries({ queryKey: qk.clients() });
      onCreated?.(created);
    },
    onError: (err) =>
      setError(
        isApiError(err) ? err.displayMessage : "Could not create the Client.",
      ),
  });

  const canSubmit =
    code.trim() !== "" && name.trim() !== "" && !gstError && !create.isPending;

  return (
    <form
      className="max-w-2xl"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit) create.mutate();
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Code"
          required
          hint="Globally unique. Used as the first segment of MQTT topics."
        >
          <input
            value={code}
            onChange={(event) => setCode(event.target.value)}
            className={inputClass}
            autoComplete="off"
          />
        </Field>
        <Field label="Name" required>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            className={inputClass}
            autoComplete="off"
          />
        </Field>
      </div>

      <fieldset className="mt-5 border-t border-line pt-4">
        <legend className="sr-only">Commercial details</legend>
        <p className="mb-3 text-[11px] uppercase tracking-wide text-ink-faint">
          Commercial details — all optional
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Client number" hint="Your own account reference.">
            <input
              value={clientNumber}
              onChange={(event) => setClientNumber(event.target.value)}
              className={inputClass}
              autoComplete="off"
            />
          </Field>
          <Field
            label="GST number"
            error={gstError}
            hint="15-character GSTIN. Format checked, checksum not verified."
          >
            <input
              value={gstNumber}
              onChange={(event) =>
                setGstNumber(event.target.value.toUpperCase())
              }
              className={inputClass}
              autoComplete="off"
              placeholder="27AAPFU0939F1ZV"
              maxLength={15}
            />
          </Field>
          <Field
            label="Contact email"
            hint="The organisation's commercial contact. Not a login — this address gets no account."
          >
            <input
              type="email"
              value={contactEmail}
              onChange={(event) => setContactEmail(event.target.value)}
              className={inputClass}
              autoComplete="off"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Contract start">
              <input
                type="date"
                value={contractStart}
                onChange={(event) => setContractStart(event.target.value)}
                className={inputClass}
              />
            </Field>
            <Field label="Valid for (days)">
              <input
                type="number"
                min={1}
                value={contractDays}
                onChange={(event) => setContractDays(event.target.value)}
                className={inputClass}
                placeholder="365"
              />
            </Field>
          </div>
        </div>
        {validTill ? (
          <p className="mt-2 text-[11px] text-ink-faint">
            Contract valid till{" "}
            <span className="font-medium text-ink">{validTill}</span> — stored as
            a date, not a day count.
          </p>
        ) : null}
      </fieldset>

      <label className="mt-4 flex items-center gap-2 text-xs text-ink">
        <input
          type="checkbox"
          checked={isDemo}
          onChange={(event) => setIsDemo(event.target.checked)}
        />
        Demonstration Client
        <span
          className="text-ink-faint"
          title="An access-control switch, not a label: a Guest may only ever reach a demonstration Client."
        >
          (permits Guest access)
        </span>
      </label>
      {error ? (
        <div className="mt-3 rounded border border-bad/30 bg-bad/10 px-3 py-2 text-xs text-bad">
          {error}
        </div>
      ) : null}
      <Button
        type="submit"
        variant="primary"
        className="mt-4"
        disabled={!canSubmit}
      >
        {create.isPending ? "Creating…" : submitLabel}
      </Button>
    </form>
  );
}
