/**
 * One screen for Clients, with the two jobs kept apart.
 *
 * ── Why a mode switch and not a "+ New" button ──────────────────────────────
 * Adding a Client and editing one are different tasks that happen to share a
 * noun, and folding them together made both hard to find: creating was a small
 * button beside a list, and editing was an unlabelled side effect of clicking a
 * row. Someone arriving to change a GST number saw a list, a create button, and
 * no evidence that editing was possible at all — which is exactly the report
 * that produced this rewrite.
 *
 * So the screen states its two jobs at the top and shows one of them.
 *
 * ── Why every commercial field is here, unfolded ────────────────────────────
 * They were briefly hidden behind a disclosure on the theory that a shorter
 * form is a kinder one. It is not, for a record somebody is transcribing off a
 * contract: a field you cannot see is a field you do not know to fill in, and
 * the contract dates in particular are the reason this record exists.
 *
 * ── The rules this screen exists to hold ────────────────────────────────────
 * 1. **Creating never depends on the broker.** Discovery *prefills* the code
 *    when the equipment is already publishing; with the broker unreachable the
 *    form still works, because a Client is often registered before it is wired.
 * 2. **The code is typed once and never again.** It must match the `{client}`
 *    segment of the topic (Guardrail 5), so editing it later would break every
 *    Device's origin at once — silently, since the resolver matches registered
 *    Devices by exact `source_address` first and would keep working until the
 *    next new Device arrived.
 * 3. **A Client is never created without a login.** Both are one transaction on
 *    the server — one object, or none.
 * 4. **Nothing here registers a Device.** Discovery proposes; registration is a
 *    separate, deliberate act on the Plants screen.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as discoveryApi from "@/api/endpoints/discovery";
import * as clientsApi from "@/api/endpoints/clients";
import { qk } from "@/api/queryKeys";
import { isApiError } from "@/api/problem";
import { usePermission } from "@/auth/usePermission";
import {
  Badge, Button, Field, Panel, PasswordInput, SegmentedControl, inputClass,
} from "@/components/ui";
import { EmptyState, ErrorState, ForbiddenState, SkeletonPanel } from "@/components/state";
import { JsonTree } from "@/components/json/JsonTree";
import { formatAge } from "@/format/datetime";
import type { Client } from "@/api/schemas";
import type { DiscoveredClient } from "@/api/endpoints/discovery";

const AGE = (iso: string): string =>
  formatAge((Date.now() - Date.parse(iso)) / 1000);

type RoleCode = "admin" | "employee" | "guest";

/** Both jobs this screen does. One is shown at a time, named in the switch. */
type Mode = "edit" | "new";

const BLANK = {
  code: "", name: "", email: "", password: "", full_name: "",
  role_code: "admin" as RoleCode, is_demo: false,
  client_number: "", gst_number: "", contact_email: "",
  contract_start_date: "", contract_valid_days: "",
};

/**
 * A Client worth showing: registered, publishing, or both.
 *
 * ⚠ The union matters. Listing only discovered codes made a registered Client
 * whose broker had gone quiet vanish from the screen entirely — and with it any
 * way to edit it. Registration is a fact about us; publishing is a fact about
 * them, and neither implies the other.
 */
interface Entry {
  code: string;
  client: Client | undefined;
  found: DiscoveredClient | undefined;
}

export function ClientsAdmin(): JSX.Element {
  const canAdmin = usePermission("system.admin");
  const queryClient = useQueryClient();

  const [mode, setMode] = useState<Mode>("edit");
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [form, setForm] = useState({ ...BLANK });
  /**
   * Whether the display name is still following the code.
   *
   * It stops the moment the name is typed in — an auto-fill that overwrites
   * what somebody just wrote is worse than no auto-fill at all.
   */
  const [nameTouched, setNameTouched] = useState(false);

  const discovered = useQuery({
    queryKey: ["discovery", "clients"],
    queryFn: discoveryApi.discoverClients,
    // The broker is the live thing here; a stale list invites onboarding a
    // Client that stopped publishing an hour ago.
    refetchInterval: 15_000,
    retry: false,
  });

  const registered = useQuery({
    queryKey: qk.clients(),
    queryFn: clientsApi.listClients,
    retry: false,
  });

  const create = useMutation({
    mutationFn: () =>
      clientsApi.createClient({
        code: form.code.trim(),
        name: form.name.trim(),
        is_demo: form.is_demo,
        // Empty strings are sent as null rather than "", so "not filled in"
        // stays distinguishable from "deliberately blank".
        client_number: form.client_number.trim() || null,
        gst_number: form.gst_number.trim() || null,
        contact_email: form.contact_email.trim() || null,
        contract_start_date: form.contract_start_date || null,
        contract_valid_days: form.contract_valid_days
          ? Number(form.contract_valid_days)
          : null,
        // Sent together on purpose: the server creates both in one transaction,
        // so a failure here leaves no half-made Client behind.
        first_user: {
          email: form.email,
          password: form.password,
          full_name: form.full_name || null,
          role_code: form.role_code,
        },
      }),
    onSuccess: (client) => {
      setError(null);
      setNote(`Client ${client.code} created, and ${form.email} can sign in now.`);
      // Straight into editing the thing just made: the remaining work — the
      // contract record, its Plants — is editing, and leaving the create form
      // open invites making it twice.
      setSelected(client.code);
      setMode("edit");
      setForm({ ...BLANK });
      void queryClient.invalidateQueries({ queryKey: qk.clients() });
      void queryClient.invalidateQueries({ queryKey: ["discovery", "clients"] });
    },
    onError: (err) => {
      setNote(null);
      setError(isApiError(err) ? err.displayMessage : "Could not create the Client.");
    },
  });

  if (!canAdmin) {
    return (
      <ForbiddenState detail="Managing Clients requires the system.admin permission. Broker discovery is Super Admin only: an unregistered topic carries no Client, and attributing one by reading the topic is exactly the guess the isolation model refuses to make." />
    );
  }

  const entries: Entry[] = (() => {
    const byCode = new Map<string, Entry>();
    for (const client of registered.data ?? []) {
      byCode.set(client.code, { code: client.code, client, found: undefined });
    }
    for (const found of discovered.data ?? []) {
      const existing = byCode.get(found.client_code);
      if (existing) existing.found = found;
      else byCode.set(found.client_code, {
        code: found.client_code, client: undefined, found,
      });
    }
    // Unregistered first — they are the only rows needing a decision.
    return [...byCode.values()].sort(
      (a, b) => (a.client ? 1 : 0) - (b.client ? 1 : 0) || a.code.localeCompare(b.code),
    );
  })();

  const current = entries.find((e) => e.code === selected) ?? null;

  /**
   * Said instead of a "last heard" time when there is nothing to say.
   *
   * ⚠ Never "not publishing": with discovery unavailable, or the broker
   * unreachable, silence here means we did not look — asserting the Client is
   * quiet would be a claim we have no basis for.
   */
  const canDiscoverNote = discovered.isError ? "broker not reachable" : "not publishing";

  /** Start creating, with anything already known filled in. */
  const startNew = (code = ""): void => {
    setError(null);
    setNote(null);
    setForm({
      ...BLANK,
      code,
      // A starting point only; the display name is ours to choose.
      name: code
        ? code.toLowerCase().replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
        : "",
    });
    setNameTouched(false);
    setMode("new");
  };

  /** Typing the code fills the display name in, until the name is touched. */
  const setCode = (code: string): void =>
    setForm((f) => ({
      ...f,
      code,
      name: nameTouched
        ? f.name
        : code.toLowerCase().replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    }));

  const readyToCreate =
    form.code.trim() !== "" &&
    form.name.trim() !== "" &&
    /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email) &&
    form.password.length >= 8;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="page-title">Clients</h1>
          <p className="max-w-2xl mt-1.5 text-sm leading-relaxed text-ink-muted">
            {mode === "new"
              ? "Register a new Client and the login that comes with it. Nothing here needs the broker."
              : "Change a Client's details, contract record or access, and see what it is publishing."}
          </p>
        </div>
        <SegmentedControl<Mode>
          label="What to do with Clients"
          value={mode}
          onChange={(next) => (next === "new" ? startNew() : setMode("edit"))}
          options={[
            { value: "edit", label: "Edit a Client", hint: "Change an existing Client's details." },
            { value: "new", label: "+ Add a Client", hint: "Register a Client and its first login." },
          ]}
        />
      </div>

      {note ? (
        <p className="rounded border border-ok/30 bg-ok/10 px-3 py-2 text-xs text-ok">{note}</p>
      ) : null}
      {error ? (
        <p className="rounded border border-bad/30 bg-bad/10 px-3 py-2 text-xs text-bad">{error}</p>
      ) : null}

      {mode === "new" ? (
        <Panel
          title="New Client"
          subtitle="The Client and its first login are created together — a Client nobody can sign into looks finished but is not."
        >
          <Section
            title="Identity"
            detail="The code must match the topics its equipment publishes on; it cannot be changed afterwards."
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Client code"
                required
                hint="The {client} segment of the topic. Case-sensitive, and fixed once created."
              >
                <input
                  value={form.code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="KULAR_GREEN"
                  className={`${inputClass} font-mono`}
                  autoFocus
                />
              </Field>
              <Field label="Display name" required hint="Filled in from the code; change it freely.">
                <input
                  value={form.name}
                  onChange={(e) => {
                    setNameTouched(true);
                    setForm({ ...form, name: e.target.value });
                  }}
                  placeholder="Kular Green Energy"
                  className={inputClass}
                />
              </Field>
            </div>
            {/* Offered, never required. A code already arriving on the broker is
                the one spelling that is certainly right. */}
            {(discovered.data ?? []).some((d) => d.registered_client_id === null) ? (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-ink-faint">Publishing now:</span>
                {(discovered.data ?? [])
                  .filter((d) => d.registered_client_id === null)
                  .map((d) => (
                    <button
                      key={d.client_code}
                      type="button"
                      onClick={() => startNew(d.client_code)}
                      className="rounded border border-warn/40 bg-warn/5 px-1.5 py-0.5 font-mono text-[11px] text-ink hover:border-warn"
                      title={`${d.plant_codes.length} plant(s), last heard ${AGE(d.last_seen)} ago. Click to fill the code in.`}
                    >
                      {d.client_code}
                    </button>
                  ))}
              </div>
            ) : null}
          </Section>

          <Section
            title="First login"
            detail="Created in the same transaction as the Client. A Client Admin is granted every Plant of their own Client automatically, so Plants added later need no extra step; any other role starts with zero Plants — deliberately, because an empty assignment means none, never all."
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Email" required>
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  placeholder="admin@example.com"
                  className={inputClass}
                />
              </Field>
              <Field label="Full name">
                <input
                  value={form.full_name}
                  onChange={(e) => setForm({ ...form, full_name: e.target.value })}
                  className={inputClass}
                />
              </Field>
              <Field label="Password" required hint="At least 8 characters.">
                <PasswordInput
                  value={form.password}
                  onChange={(v) => setForm({ ...form, password: v })}
                />
              </Field>
              <Field label="Role" required>
                <select
                  value={form.role_code}
                  onChange={(e) =>
                    setForm({ ...form, role_code: e.target.value as RoleCode })
                  }
                  className={inputClass}
                >
                  <option value="admin">Client Admin — sees every Plant</option>
                  <option value="employee">Employee — needs Plant access granted</option>
                  <option value="guest">Guest — demonstration Clients only</option>
                </select>
              </Field>
            </div>
          </Section>

          <Section
            title="Contract and commercial record"
            detail="All optional, and all editable later. Recorded here because this is when the contract is in front of you."
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Client number" hint="Your own account reference for them. Must be unique.">
                <input
                  value={form.client_number}
                  onChange={(e) => setForm({ ...form, client_number: e.target.value })}
                  placeholder="ACC-4471"
                  className={inputClass}
                />
              </Field>
              <Field label="GST number" hint="15-character GSTIN. Shape checked; checksum is not.">
                <input
                  value={form.gst_number}
                  onChange={(e) => setForm({ ...form, gst_number: e.target.value })}
                  placeholder="27AAPFU0939F1ZV"
                  className={`${inputClass} font-mono`}
                />
              </Field>
              <Field
                label="Contact email"
                hint="⚠ The organisation's commercial contact — NOT a login. This address gets no account."
              >
                <input
                  type="email"
                  value={form.contact_email}
                  onChange={(e) => setForm({ ...form, contact_email: e.target.value })}
                  className={inputClass}
                />
              </Field>
              <Field label="Contract start" hint="Left blank with a duration below, today is assumed.">
                <input
                  type="date"
                  value={form.contract_start_date}
                  onChange={(e) => setForm({ ...form, contract_start_date: e.target.value })}
                  className={inputClass}
                />
              </Field>
              <Field
                label="Valid for (days)"
                hint="Asked as a duration because that is how a contract reads; stored as a real expiry date, since a day count is stale the day after it is written."
              >
                <input
                  type="number"
                  min={1}
                  value={form.contract_valid_days}
                  onChange={(e) => setForm({ ...form, contract_valid_days: e.target.value })}
                  placeholder="365"
                  className={inputClass}
                />
              </Field>
            </div>
            <label className="mt-3 flex items-center gap-2 text-xs text-ink-muted">
              <input
                type="checkbox"
                checked={form.is_demo}
                onChange={(e) => setForm({ ...form, is_demo: e.target.checked })}
              />
              Demonstration Client
              <span className="text-ink-faint">
                (⚠ an access switch, not a label — a Guest may only ever reach one)
              </span>
            </label>
          </Section>

          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3">
            <Button
              variant="primary"
              disabled={!readyToCreate || create.isPending}
              onClick={() => create.mutate()}
            >
              {create.isPending ? "Creating…" : "Create Client and login"}
            </Button>
            <Button variant="ghost" onClick={() => setMode("edit")}>
              Cancel
            </Button>
            {!readyToCreate ? (
              <span className="text-[11px] text-ink-faint">
                Needs a code, a display name, and a login with a password of at
                least 8 characters.
              </span>
            ) : null}
          </div>
        </Panel>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
          <Panel
            title="Clients"
            subtitle="Registered, plus any code the broker is publishing that is not registered yet."
          >
            {registered.isLoading ? (
              <SkeletonPanel lines={4} title={false} />
            ) : registered.isError ? (
              <ErrorState error={registered.error} retry={() => void registered.refetch()} />
            ) : entries.length === 0 ? (
              <EmptyState
                title="No Clients yet"
                detail="Nothing registered, and nothing publishing. Use “+ Add a Client” above — creating one never depends on the broker."
              />
            ) : (
              <ul className="space-y-1.5">
                {entries.map((entry) => (
                  <li key={entry.code}>
                    <button
                      type="button"
                      onClick={() => setSelected(entry.code)}
                      className={`w-full rounded border px-3 py-2 text-left transition ${
                        selected === entry.code
                          ? "border-accent bg-accent/10"
                          : entry.client
                            ? "border-line bg-surface hover:border-line-strong"
                            : "border-warn/40 bg-warn/5 hover:border-warn"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-mono text-xs font-medium text-ink">
                          {entry.code}
                        </span>
                        {entry.client ? (
                          <Badge tone="ok">registered</Badge>
                        ) : (
                          <Badge tone="warn">not registered</Badge>
                        )}
                      </div>
                      <div className="mt-1 truncate text-[11px] text-ink-muted">
                        {entry.client ? entry.client.name : "publishing, not set up yet"}
                      </div>
                      <div className="mt-0.5 text-[11px] text-ink-faint">
                        {entry.found
                          ? `${entry.found.plant_codes.length} plant(s) · last heard ${AGE(entry.found.last_seen)} ago`
                          : canDiscoverNote}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <div className="min-w-0 space-y-4">
            {current === null ? (
              <Panel title="Choose a Client">
                <p className="text-xs leading-relaxed text-ink-faint">
                  Pick one on the left to edit its details, its contract record and
                  its access — and to see the Plants and Devices publishing under it.
                </p>
              </Panel>
            ) : current.client ? (
              <>
                <EditClient
                  key={current.client.id}
                  client={current.client}
                  onSaved={(m) => {
                    setNote(m); setError(null);
                    void queryClient.invalidateQueries({ queryKey: qk.clients() });
                  }}
                  onError={(m) => { setError(m); setNote(null); }}
                />
                <BrokerActivity clientCode={current.code} />
              </>
            ) : (
              <Panel title={`${current.code} is publishing but is not registered`}>
                <p className="max-w-2xl text-xs leading-relaxed text-ink-muted">
                  Its equipment is sending on this code, but no Client exists for
                  it yet — so every message is quarantined rather than stored.
                  Registering it takes the code exactly as the topic spells it.
                </p>
                <Button
                  variant="primary"
                  className="mt-3"
                  onClick={() => startNew(current.code)}
                >
                  Set {current.code} up
                </Button>
              </Panel>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** A labelled group of fields inside one Panel — a subsection, not a screen. */
function Section({
  title, detail, children,
}: {
  title: string;
  detail?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section className="mt-4 border-t border-line pt-3 first:mt-0 first:border-t-0 first:pt-0">
      <h3 className="text-sm font-medium text-ink">{title}</h3>
      {detail ? (
        <p className="mb-3 mt-0.5 max-w-3xl text-[11px] leading-relaxed text-ink-muted">
          {detail}
        </p>
      ) : (
        <div className="mb-3" />
      )}
      {children}
    </section>
  );
}

/**
 * Edit an existing Client — everything about it except the one thing that must
 * not move.
 *
 * ⚠ The **code is not editable**, and its absence is deliberate. A Client's code
 * is what the topic carries (Guardrail 5), so changing it without the publisher
 * changing too would break every Device's origin at once — silently, since the
 * resolver matches registered Devices by exact `source_address` first and would
 * keep working until the first *new* Device arrived. If the code really must
 * change, the publisher changes first and the code follows.
 *
 * ⚠ Renewal takes an **end date**, where creation took a duration. "It now runs
 * to this date" is the actual operation; re-deriving it from a day count would
 * need a base date nobody has supplied, and the original start is often years ago.
 */
function EditClient({
  client, onSaved, onError,
}: {
  client: Client;
  onSaved: (message: string) => void;
  onError: (message: string) => void;
}): JSX.Element {
  const [form, setForm] = useState({
    name: client.name,
    status: client.status,
    is_demo: client.is_demo,
    client_number: client.client_number ?? "",
    gst_number: client.gst_number ?? "",
    contact_email: client.contact_email ?? "",
    contract_start_date: client.contract_start_date ?? "",
    contract_valid_till: client.contract_valid_till ?? "",
  });

  const save = useMutation({
    mutationFn: () =>
      clientsApi.updateClient(client.id, {
        name: form.name,
        status: form.status,
        is_demo: form.is_demo,
        client_number: form.client_number.trim() || null,
        gst_number: form.gst_number.trim() || null,
        contact_email: form.contact_email.trim() || null,
        contract_start_date: form.contract_start_date || null,
        contract_valid_till: form.contract_valid_till || null,
      }),
    onSuccess: () => onSaved(`${client.code} updated.`),
    onError: (err) =>
      onError(isApiError(err) ? err.displayMessage : "Could not update the Client."),
  });

  // Parsed as UTC midnight rather than local, so the countdown does not read one
  // day out for anyone east or west of the server.
  const expiry = client.contract_valid_till
    ? Math.round(
        (Date.parse(`${client.contract_valid_till}T00:00:00Z`) - Date.now()) / 86_400_000,
      )
    : null;

  return (
    <Panel
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono">{client.code}</span>
          <Badge tone={client.status === "active" ? "ok" : "warn"}>{client.status}</Badge>
          {client.is_demo ? <Badge tone="info">demonstration</Badge> : null}
          {expiry !== null ? (
            <Badge tone={expiry < 0 ? "bad" : expiry < 30 ? "warn" : "neutral"}>
              {expiry < 0 ? `contract expired ${-expiry}d ago` : `${expiry}d of contract left`}
            </Badge>
          ) : null}
        </span>
      }
      subtitle="The code comes from the topic and cannot be changed here."
    >
      <Section title="Identity and access">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Display name" required>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className={inputClass}
            />
          </Field>
          <Field
            label="Status"
            hint="Suspending a Client keeps its data and stops its people signing in."
          >
            <select
              value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value })}
              className={inputClass}
            >
              {["onboarding", "active", "suspended", "decommissioned"].map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </Field>
        </div>
        <label className="mt-3 flex items-center gap-2 text-xs text-ink-muted">
          <input
            type="checkbox"
            checked={form.is_demo}
            onChange={(e) => setForm({ ...form, is_demo: e.target.checked })}
          />
          Demonstration Client
          <span className="text-ink-faint">
            (⚠ an access switch, not a label — a Guest may only ever reach one)
          </span>
        </label>
      </Section>

      <Section
        title="Contract and commercial record"
        detail="All optional. Clearing a field here clears it on the Client."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Client number" hint="Your own account reference. Must be unique.">
            <input
              value={form.client_number}
              onChange={(e) => setForm({ ...form, client_number: e.target.value })}
              placeholder="ACC-4471"
              className={inputClass}
            />
          </Field>
          <Field label="GST number" hint="15-character GSTIN. Shape checked; checksum is not.">
            <input
              value={form.gst_number}
              onChange={(e) => setForm({ ...form, gst_number: e.target.value })}
              placeholder="27AAPFU0939F1ZV"
              className={`${inputClass} font-mono`}
            />
          </Field>
          <Field
            label="Contact email"
            hint="⚠ The organisation's commercial contact — NOT a login."
          >
            <input
              type="email"
              value={form.contact_email}
              onChange={(e) => setForm({ ...form, contact_email: e.target.value })}
              className={inputClass}
            />
          </Field>
          <Field label="Contract start">
            <input
              type="date"
              value={form.contract_start_date}
              onChange={(e) => setForm({ ...form, contract_start_date: e.target.value })}
              className={inputClass}
            />
          </Field>
          <Field
            label="Valid till"
            hint="A date, not a duration — renewing means “it now runs to this date”."
          >
            <input
              type="date"
              value={form.contract_valid_till}
              onChange={(e) => setForm({ ...form, contract_valid_till: e.target.value })}
              className={inputClass}
            />
          </Field>
        </div>
      </Section>

      <div className="mt-4 border-t border-line pt-3">
        <Button
          variant="primary"
          disabled={save.isPending || !form.name.trim()}
          onClick={() => save.mutate()}
        >
          {save.isPending ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </Panel>
  );
}

/**
 * What this Client is publishing, as a subsection rather than a screen.
 *
 * Folded by default: when you came here to fix a GST number, the broker is
 * noise. When you came here because nothing is arriving, it is the whole story.
 */
function BrokerActivity({ clientCode }: { clientCode: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [openTopic, setOpenTopic] = useState<string | null>(null);

  const plants = useQuery({
    queryKey: ["discovery", "plants", clientCode],
    queryFn: () => discoveryApi.discoverPlants(clientCode),
    enabled: open,
    retry: false,
  });

  const topic = useQuery({
    queryKey: ["discovery", "topic", openTopic],
    queryFn: () => discoveryApi.discoverTopic(openTopic as string),
    enabled: openTopic !== null,
    retry: false,
  });

  return (
    <Panel
      title="What this Client is publishing"
      subtitle="Read from what ingest has received. Registering Devices happens on the Plants screen."
      actions={
        <button
          type="button"
          onClick={() => setOpen((was) => !was)}
          aria-expanded={open}
          className="text-[11px] text-accent hover:underline"
        >
          {open ? "Hide" : "Show"}
        </button>
      }
    >
      {!open ? (
        <p className="text-xs text-ink-faint">
          Hidden by default — open it when you are checking whether data is
          arriving, rather than editing the Client.
        </p>
      ) : plants.isLoading ? (
        <SkeletonPanel lines={4} title={false} />
      ) : plants.isError ? (
        <ErrorState error={plants.error} retry={() => void plants.refetch()} />
      ) : (plants.data ?? []).length === 0 ? (
        <p className="text-xs leading-relaxed text-ink-faint">
          Nothing has arrived under this code in the last 7 days. That is what
          ingest received, not what the broker holds — if ingest cannot reach the
          broker, this stays empty whatever is being sent.
        </p>
      ) : (
        <div className="space-y-3">
          {plants.data!.map((plant) => (
            <div key={plant.plant_code} className="rounded border border-line">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
                <span className="font-mono text-xs font-medium text-ink">
                  {plant.plant_code}
                </span>
                <span className="flex items-center gap-1.5">
                  {plant.registered_plant_id ? (
                    <Badge tone="ok">registered</Badge>
                  ) : (
                    <Badge tone="warn">not registered</Badge>
                  )}
                  <Badge tone="neutral">{plant.device_count} device(s)</Badge>
                  {plant.unregistered_count > 0 ? (
                    <Badge tone="warn">{plant.unregistered_count} unregistered</Badge>
                  ) : null}
                </span>
              </div>
              <ul className="divide-y divide-line">
                {plant.devices.map((device) => (
                  <li key={device.topic} className="px-3 py-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      {device.collector_code ? (
                        <span
                          className="rounded border border-dashed border-line-strong px-1.5 py-0.5 text-[10px] text-ink-muted"
                          title="The enclosure this Device publishes from — a box, never a Device."
                        >
                          {device.collector_code}
                        </span>
                      ) : (
                        <span
                          className="px-1.5 text-[10px] text-ink-faint"
                          title="Five-segment topic: this Device sits in no enclosure. A real answer, not a gap."
                        >
                          no collector
                        </span>
                      )}
                      <span className="truncate text-xs text-ink">{device.device_code}</span>
                      {device.registered_device_id ? (
                        <Badge tone="ok">registered</Badge>
                      ) : (
                        <Badge tone="warn">new</Badge>
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          setOpenTopic(openTopic === device.topic ? null : device.topic)
                        }
                        className="ml-auto text-[11px] text-accent hover:underline"
                      >
                        {openTopic === device.topic ? "hide payload" : "view payload"}
                      </button>
                    </div>
                    {openTopic === device.topic ? (
                      <div className="mt-2">
                        {topic.isLoading ? (
                          <SkeletonPanel lines={4} title={false} />
                        ) : topic.isError ? (
                          <ErrorState error={topic.error} retry={() => void topic.refetch()} />
                        ) : topic.data ? (
                          <>
                            <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                              <Badge tone="neutral">{topic.data.messages} message(s)</Badge>
                              {topic.data.interval_s ? (
                                <Badge
                                  tone="info"
                                  title="Measured from the gaps between messages. This is what a Device's expected interval should be set to — health thresholds multiply it."
                                >
                                  every ~{topic.data.interval_s}s
                                </Badge>
                              ) : null}
                              {topic.data.quarantined ? (
                                <Badge tone="warn" title={topic.data.reason ?? undefined}>
                                  quarantined — no Device registered
                                </Badge>
                              ) : null}
                              {topic.data.last_seen ? (
                                <span className="text-ink-faint">
                                  last heard {AGE(topic.data.last_seen)} ago
                                </span>
                              ) : null}
                            </div>
                            <JsonTree
                              value={topic.data.last_payload}
                              empty="No payload recorded for this topic."
                            />
                          </>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
