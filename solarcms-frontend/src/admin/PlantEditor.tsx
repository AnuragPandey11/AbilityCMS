/**
 * One screen for Plants, with the two jobs kept apart.
 *
 * ── Why a mode switch at the top ────────────────────────────────────────────
 * Creating a Plant and editing one were previously the same screen wearing one
 * hat: a Plant picker with a "+ New Plant" button beside it, which opened a
 * small form *in the header*, between the picker and the tabs. Two different
 * tasks shared one set of controls, and the shape of the page changed depending
 * on which you were half-way through — so neither was findable and the state of
 * the screen was ambiguous. They are now named, separate, and one at a time.
 *
 * ── Why editing is still one screen and not three ───────────────────────────
 * The arrangement before *that* split the work by **table** rather than by task
 * — Plant Setup owned `devices`, Plant Hierarchy owned `parent_device_id`,
 * Device Bindings owned `device_tag_bindings`. That is our schema showing
 * through the interface. Nobody thinks "I need to edit device_tag_bindings";
 * they think "what is wrong with INVERTER_7", and answering that meant three
 * screens and re-finding the Device on each. So editing is **one list of
 * Devices, and one row expands into everything about it**, with registered and
 * not-yet-registered Devices in the *same* list — "this Plant has twenty-one
 * Devices and three more are publishing" is one fact, not two screens' worth.
 *
 * ── What is deliberately not asked for here ─────────────────────────────────
 * **Feeds into** and **reports via** are absent from registration. Both are
 * discovered rather than designed: which Collector transmits a Device is
 * already stated by its topic, and what a Device is wired into is routinely
 * corrected after the first day of real data. Asking at registration invites a
 * guess, and a guess drawn into the Single Line Diagram is indistinguishable
 * from a fact. Both remain first-class (MASTER §3.4) — they are set where they
 * can be checked: the Collector by the topic, the wiring in Plant Hierarchy
 * beside the diagram it produces.
 */

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as discoveryApi from "@/api/endpoints/discovery";
import * as devicesApi from "@/api/endpoints/devices";
import * as plantsApi from "@/api/endpoints/plants";
import { useDeviceModels, usePlant, usePlantDevices } from "@/api/hooks";
import { isApiError } from "@/api/problem";
import { usePermission } from "@/auth/usePermission";
import { useAuth } from "@/auth/AuthProvider";
import * as clientsApi from "@/api/endpoints/clients";
import { usePlantScope } from "@/state/usePlantScope";
import { CommStatusBadge, PlantPicker } from "@/components/domain";
import { RegionSelect } from "@/admin/RegionSelect";
import { Badge, Button, Field, Panel, SegmentedControl, inputClass } from "@/components/ui";
import { EmptyState, ErrorState, ForbiddenState, SkeletonPanel } from "@/components/state";
import { JsonTree } from "@/components/json/JsonTree";
import { formatAge } from "@/format/datetime";
import type { DeviceListItem } from "@/api/schemas";
import type { DiscoveredDevice } from "@/api/endpoints/discovery";

const AGE = (iso: string): string => formatAge((Date.now() - Date.parse(iso)) / 1000);

/** Both jobs this screen does. One is shown at a time, named in the switch. */
type Mode = "edit" | "new";

/**
 * One row in the Device list.
 *
 * `device` is set when it is registered, `found` when the broker is publishing
 * it; both are set for the ordinary case of a registered Device that is also
 * still sending. Exactly one being null is what distinguishes the two states
 * worth calling out: *registered but silent* and *publishing but unknown to us*.
 */
interface Row {
  key: string;
  code: string;
  device: DeviceListItem | null;
  found: DiscoveredDevice | null;
}

export function PlantEditor(): JSX.Element {
  const canManage = usePermission("plant.manage");
  const canDiscover = usePermission("system.admin");
  const queryClient = useQueryClient();
  const { plants, plantId, setPlantId } = usePlantScope();

  const { refreshMe } = useAuth();
  const isPlatformAdmin = usePermission("system.admin");
  // Only a Super Admin needs to pick a Client, and only they may list them.
  const clientsQuery = useQuery({
    queryKey: ["clients"],
    queryFn: clientsApi.listClients,
    enabled: isPlatformAdmin,
    retry: false,
  });

  const plantQuery = usePlant(plantId);
  const devicesQuery = usePlantDevices(plantId);
  const modelsQuery = useDeviceModels();

  const [mode, setMode] = useState<Mode>("edit");
  const [tab, setTab] = useState<"devices" | "details">("devices");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [modelFor, setModelFor] = useState<Record<string, number | null>>({});
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  /**
   * A Plant just created, waiting to become selectable.
   *
   * ⚠ Not cosmetic. `usePlantScope` only honours a Plant id that appears in
   * `/auth/me` → `plants[]` (A-2), and silently resets to the first visible
   * Plant otherwise. Calling `setPlantId(newId)` straight after `refreshMe()`
   * therefore races the re-render: the correction effect runs against the old
   * list, decides the new Plant is not visible, and puts the selection back —
   * so the Plant is created, appears in the dropdown, and is not the one you
   * are looking at. Holding the id until the list contains it removes the race
   * rather than out-waiting it.
   */
  const [pendingPlantId, setPendingPlantId] = useState<number | null>(null);

  useEffect(() => {
    if (pendingPlantId === null) return;
    if (!plants.some((p) => p.id === pendingPlantId)) return;
    setPlantId(pendingPlantId);
    setPendingPlantId(null);
    // Straight to the Devices list of the Plant just made: a Plant with no
    // Devices is the one state where there is exactly one next thing to do.
    setMode("edit");
    setTab("devices");
  }, [pendingPlantId, plants, setPlantId]);

  const plant = plantQuery.data;
  const devices = useMemo(() => devicesQuery.data ?? [], [devicesQuery.data]);

  const discovered = useQuery({
    queryKey: ["discovery", "plants", plant?.client_code ?? null],
    queryFn: () => discoveryApi.discoverPlants(String(plant?.client_code)),
    enabled: canDiscover && Boolean(plant?.client_code),
    retry: false,
  });

  const observed = useQuery({
    queryKey: ["discovery", "topic", expanded, modelFor[expanded ?? ""] ?? null],
    queryFn: () => {
      const row = rows.find((r) => r.key === expanded);
      const topic = row?.found?.topic ?? row?.device?.source_address;
      const modelId = modelFor[expanded ?? ""] ?? null;
      const type = modelId
        ? modelsQuery.data?.find((m) => m.id === modelId)?.device_type_code
        : row?.device?.type_code;
      return discoveryApi.discoverTopic(String(topic), type ?? null);
    },
    enabled: canDiscover && expanded !== null,
    retry: false,
  });

  /**
   * Registered and discovered Devices, merged into one list.
   *
   * Matched on the topic, which is the only identifier both sides share — a
   * Device code alone would pair `MFM` inside the MCR with `MFM` outside it,
   * which are two different instruments on two different topics.
   */
  const rows: Row[] = useMemo(() => {
    const forThisPlant = discovered.data?.find((p) => p.plant_code === plant?.code);
    const byTopic = new Map<string, Row>();

    for (const device of devices) {
      const key = device.source_address ?? `device:${device.id}`;
      byTopic.set(key, { key, code: device.code, device, found: null });
    }
    for (const found of forThisPlant?.devices ?? []) {
      const existing = byTopic.get(found.topic);
      if (existing) existing.found = found;
      else byTopic.set(found.topic, {
        key: found.topic, code: found.device_code, device: null, found,
      });
    }

    const all = [...byTopic.values()];
    const query = filter.trim().toLowerCase();
    const matching = query
      ? all.filter((r) =>
          `${r.code} ${r.device?.type_code ?? ""} ${r.found?.collector_code ?? ""}`
            .toLowerCase()
            .includes(query),
        )
      : all;
    // ⚠ Ordered by what it costs to ignore, not by registration state.
    //
    // Unregistered *and publishing* is the expensive row: its data is being
    // discarded on every message, and that loss is permanent once raw retention
    // passes. Unregistered and silent is a retired topic shape — it costs
    // nothing, and registering one produces a Device that never reports.
    //
    // Sorting those two together is what turned this list into "+20 new" on a
    // Plant where all twenty were dead: a to-do list of corpses, which buries
    // the one row that matters and teaches everyone to ignore the badge.
    const rank = (r: Row): number => {
      if (r.device === null) return r.found?.status === "silent" ? 2 : 0;
      return 1;
    };
    return matching.sort(
      (a, b) =>
        rank(a) - rank(b) ||
        a.code.localeCompare(b.code, undefined, { numeric: true }),
    );
  }, [devices, discovered.data, plant?.code, filter]);

  const countsByType = useMemo(() => {
    const counts = new Map<string, number>();
    for (const device of devices) {
      counts.set(device.type_code, (counts.get(device.type_code) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [devices]);

  // Publishing now and registered to nothing. The badge counts only these,
  // because only these need a decision today.
  const unregistered = rows.filter(
    (r) => r.device === null && r.found?.status !== "silent",
  ).length;
  // Stopped, and never registered: retired shapes and corrected typos. Shown,
  // because hiding a topic entirely is how a real Device gets forgotten — but
  // never counted as work to do.
  const goneQuiet = rows.filter(
    (r) => r.device === null && r.found?.status === "silent",
  ).length;

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["plants", plantId, "devices"] });
    void queryClient.invalidateQueries({ queryKey: ["plants", plantId, "sld"] });
    void queryClient.invalidateQueries({ queryKey: ["discovery"] });
  };

  const register = useMutation({
    mutationFn: async (row: Row) => {
      const modelId = modelFor[row.key] ?? null;
      if (!row.found || modelId === null || plantId === null) {
        throw new Error("choose a Device Model first");
      }
      return devicesApi.createDevice(plantId, {
        code: row.found.device_code,
        name: row.found.device_code.replace(/[_-]+/g, " "),
        device_model_id: modelId,
        source_address: row.found.topic,
        // Read from the topic, never chosen — the topic decides the enclosure.
        collector_code: row.found.collector_code,
        // Measured, not the assumed 60s. Health thresholds multiply this.
        expected_interval_s: observed.data?.interval_s ?? 60,
        bind_from_model: true,
      });
    },
    onSuccess: (created) => {
      setError(null);
      setNote(
        `${created.code} registered${
          created.bindings ? ` with ${created.bindings.bound} Tag binding(s)` : ""
        }. Wire it up in Plant Hierarchy when you know what it feeds.`,
      );
      setExpanded(null);
      refresh();
    },
    onError: (err) =>
      setError(isApiError(err) ? err.displayMessage : "Could not register the Device."),
  });

  const changeStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) =>
      devicesApi.updateDevice(id, { status }),
    onSuccess: () => { setError(null); setNote("Device updated."); refresh(); },
    onError: (err) =>
      setError(isApiError(err) ? err.displayMessage : "Could not update the Device."),
  });

  const remove = useMutation({
    mutationFn: ({ id, force }: { id: number; force: boolean }) =>
      devicesApi.deleteDevice(id, force),
    onSuccess: (result) => {
      setError(null);
      setNote(
        `${result.code} removed` +
          (result.readings_deleted ? `, with ${result.readings_deleted} Reading(s).` : "."),
      );
      setExpanded(null);
      refresh();
    },
    onError: (err) =>
      setError(isApiError(err) ? err.displayMessage : "Could not remove the Device."),
  });

  if (!canManage) {
    return <ForbiddenState detail="Editing a Plant requires the plant.manage permission." />;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-ink">Plants &amp; Devices</h1>
          <p className="max-w-2xl text-xs leading-relaxed text-ink-muted">
            {mode === "new"
              ? "Register a new Plant under a Client. Its Devices come next, added by topic."
              : "Change a Plant's details, and add or remove its Devices. Open a Device to see its topic, its Tags and its health in one place."}
          </p>
        </div>
        <SegmentedControl<Mode>
          label="What to do with Plants"
          value={mode}
          onChange={(next) => { setMode(next); setError(null); }}
          options={[
            { value: "edit", label: "Edit a Plant", hint: "Change a Plant, or add and remove its Devices." },
            { value: "new", label: "+ Add a Plant", hint: "Register a new Plant under a Client." },
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
        <NewPlantPanel
          clients={clientsQuery.data ?? []}
          needsClient={isPlatformAdmin}
          canDiscover={canDiscover}
          onCancel={() => setMode("edit")}
          onCreated={async (newPlantId, message) => {
            setError(null);
            setNote(message);
            // A-2: the picker reads `/auth/me` → plants[], so without this the
            // new Plant exists on the server and is invisible in the UI —
            // indistinguishable from a create that silently failed.
            setPendingPlantId(newPlantId);
            await refreshMe();
          }}
          onError={(m) => { setError(m); setNote(null); }}
        />
      ) : (
        <>
          {/* The Plant being edited, named once and prominently — the picker is
              the subject of this mode, not an accessory to a header. */}
          <Panel
            title="Plant"
            subtitle={
              plant
                ? `${plant.code} · ${plant.client_name ?? "—"} · ${devices.length} device(s)`
                : "Choose which Plant to work on."
            }
            actions={
              <PlantPicker
                plants={plants}
                value={plantId}
                onChange={(id) => { setPlantId(id); setExpanded(null); }}
                label="Plant"
              />
            }
          >
            {plants.length === 0 ? (
              <p className="text-xs leading-relaxed text-ink-faint">
                No Plants are visible to your account. If you have just created
                one, it appears here as soon as access is granted; otherwise use
                “+ Add a Plant”.
              </p>
            ) : (
              <p className="text-xs leading-relaxed text-ink-faint">
                Everything below belongs to the Plant selected here. A Device can
                only ever feed into another at the same Plant.
              </p>
            )}
          </Panel>

          {plantId === null ? null : plantQuery.isLoading ? (
            <SkeletonPanel lines={6} />
          ) : plantQuery.isError ? (
            <ErrorState error={plantQuery.error} retry={() => void plantQuery.refetch()} />
          ) : (
            <>
              {/* ── Two tabs, because there are exactly two things here ────── */}
              <div className="flex flex-wrap items-center gap-2">
                {(["devices", "details"] as const).map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setTab(key)}
                    aria-current={tab === key ? "page" : undefined}
                    className={`rounded-control border px-3 py-1.5 text-xs font-medium transition ${
                      tab === key
                        ? "border-accent bg-accent/10 text-accent"
                        : "border-line bg-surface-raised text-ink-muted hover:text-ink"
                    }`}
                  >
                    {key === "devices" ? `Devices · ${devices.length}` : "Plant details"}
                    {key === "devices" && unregistered > 0 ? (
                      <span
                        className="ml-1.5 rounded bg-warn/20 px-1 text-[10px] text-warn"
                        title="Publishing now with nothing registered for them — their data is being discarded on every message."
                      >
                        +{unregistered} publishing
                      </span>
                    ) : null}
                    {key === "devices" && unregistered === 0 && goneQuiet > 0 ? (
                      <span
                        className="ml-1.5 rounded bg-surface px-1 text-[10px] text-ink-muted"
                        title="Topics that stopped publishing and were never registered — retired shapes, not equipment awaiting registration."
                      >
                        {goneQuiet} gone quiet
                      </span>
                    ) : null}
                  </button>
                ))}
                <Link
                  to="/admin/hierarchy"
                  className="ml-auto rounded-control border border-line bg-surface-raised px-3 py-1.5 text-xs text-ink-muted hover:text-ink"
                  title="Say what each Device feeds into, beside the diagram it produces."
                >
                  Wiring &amp; Diagram →
                </Link>
              </div>

              {tab === "details" ? (
                <PlantDetails
                  key={plant?.id}
                  plant={plant}
                  countsByType={countsByType}
                  onSaved={(m) => {
                    setNote(m); setError(null);
                    void queryClient.invalidateQueries({ queryKey: ["plants", plantId] });
                  }}
                />
              ) : (
                <Panel
                  title="Devices"
                  subtitle="Registered and, where discovery is available, what the broker is publishing. Counts are derived, never typed."
                  actions={
                    <input
                      type="search"
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                      placeholder="Filter…"
                      aria-label="Filter Devices"
                      className={`${inputClass} h-8 w-40 py-1 text-xs`}
                    />
                  }
                >
                  <div className="mb-3">
                    <AddDeviceByTopic
                      plantId={plantId}
                      models={modelsQuery.data ?? []}
                      onAdded={(m) => { setNote(m); setError(null); refresh(); }}
                      onError={(m) => { setError(m); setNote(null); }}
                    />
                  </div>

                  {devicesQuery.isLoading ? (
                    <SkeletonPanel lines={6} title={false} />
                  ) : rows.length === 0 ? (
                    <EmptyState
                      title="No Devices yet"
                      detail={
                        canDiscover
                          ? "Nothing registered, and nothing publishing under this Plant's code in the last 7 days. Add one by pasting its topic above — discovery shows what ingest has received, so if ingest cannot reach the broker this stays empty whatever is being sent."
                          : "Nothing registered. Add one by pasting the topic its publisher was configured with."
                      }
                    />
                  ) : (
                    <ul className="space-y-1">
                      {rows.map((row) => (
                        <DeviceRow
                          key={row.key}
                          row={row}
                          open={expanded === row.key}
                          onToggle={() =>
                            setExpanded(expanded === row.key ? null : row.key)
                          }
                          observed={expanded === row.key ? observed : null}
                          models={modelsQuery.data ?? []}
                          modelId={modelFor[row.key] ?? null}
                          onModel={(id) => setModelFor({ ...modelFor, [row.key]: id })}
                          onRegister={() => register.mutate(row)}
                          registering={register.isPending}
                          onStatus={(status) =>
                            row.device && changeStatus.mutate({ id: row.device.id, status })
                          }
                          canDiscover={canDiscover}
                          onRemove={() => {
                            if (!row.device) return;
                            const ok = window.confirm(
                              `Remove ${row.device.code}?\n\nIf it has stored Readings the ` +
                                `server refuses — decommission instead to keep its history.`,
                            );
                            if (ok) remove.mutate({ id: row.device.id, force: false });
                          }}
                        />
                      ))}
                    </ul>
                  )}
                </Panel>
              )}
            </>
          )}
        </>
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
 * Create a Plant — its own mode, with room for everything a Plant has.
 *
 * ⚠ `refreshMe()` after creating is load-bearing, not tidiness. The Plant
 * picker is driven by `/auth/me` → `plants[]` (A-2), so a Plant created without
 * re-reading it exists on the server and is invisible in the UI —
 * indistinguishable from a create that silently failed.
 *
 * ⚠ Capacities are asked for **here**, not left to a later visit, because PR
 * divides by DC capacity and CUF divides by AC capacity: without them both are
 * undefined, and an undefined PR on a live Plant reads as a broken calculation
 * rather than a missing field.
 */
function NewPlantPanel({
  clients, needsClient, canDiscover, onCreated, onCancel, onError,
}: {
  clients: { id: number; code: string; name: string }[];
  /** A Super Admin belongs to no Client, so they must name one (I-9). */
  needsClient: boolean;
  canDiscover: boolean;
  onCreated: (plantId: number, message: string) => void;
  onCancel: () => void;
  onError: (message: string) => void;
}): JSX.Element {
  const [form, setForm] = useState({
    clientId: "", code: "", name: "", region_code: "",
    ac_capacity_kw: "", dc_capacity_kwp: "",
    latitude: "", longitude: "", commissioned_on: "",
  });
  /**
   * Whether the display name is still following the code.
   *
   * It stops the moment the name is typed in — an auto-fill that overwrites
   * what somebody just wrote is worse than no auto-fill at all.
   */
  const [nameTouched, setNameTouched] = useState(false);

  // With exactly one Client there is no choice to make, so it is made. A Super
  // Admin with one Client on the platform should not have to say which.
  useEffect(() => {
    if (!needsClient || form.clientId !== "" || clients.length !== 1) return;
    setForm((f) => ({ ...f, clientId: String(clients[0]!.id) }));
  }, [needsClient, clients, form.clientId]);

  const chosenClient = clients.find((c) => String(c.id) === form.clientId);

  /**
   * Plant codes already arriving under the chosen Client.
   *
   * Offered as a chip rather than a dropdown: the code may equally be one the
   * engineers have not started publishing yet, and a Plant that must be picked
   * from a list of what is live cannot be registered before it is wired.
   */
  const discovered = useQuery({
    queryKey: ["discovery", "plants", chosenClient?.code ?? null],
    queryFn: () => discoveryApi.discoverPlants(String(chosenClient?.code)),
    enabled: canDiscover && Boolean(chosenClient?.code),
    retry: false,
  });

  const create = useMutation({
    mutationFn: () =>
      plantsApi.createPlant({
        code: form.code.trim(),
        name: form.name.trim(),
        // Ignored for a Client Admin, whose Client comes from the session and
        // nothing else — they cannot file a Plant under another Client.
        client_id: form.clientId ? Number(form.clientId) : null,
        region_code: form.region_code || null,
        ac_capacity_kw: form.ac_capacity_kw ? Number(form.ac_capacity_kw) : null,
        dc_capacity_kwp: form.dc_capacity_kwp ? Number(form.dc_capacity_kwp) : null,
        latitude: form.latitude ? Number(form.latitude) : null,
        longitude: form.longitude ? Number(form.longitude) : null,
        commissioned_on: form.commissioned_on || null,
      }),
    onSuccess: (created) => {
      onCreated(
        created.id,
        `Plant ${form.code} created in draft. Add its Devices below, then set it active.`,
      );
    },
    onError: (err) =>
      onError(isApiError(err) ? err.displayMessage : "Could not create the Plant."),
  });

  const setCode = (code: string): void =>
    setForm((f) => ({
      ...f,
      code,
      name: nameTouched
        ? f.name
        : code.toLowerCase().replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    }));

  const ready =
    form.code.trim() !== "" &&
    form.name.trim() !== "" &&
    (!needsClient || form.clientId !== "");

  const unregisteredCodes = (discovered.data ?? []).filter(
    (p) => p.registered_plant_id === null,
  );

  return (
    <Panel
      title="New Plant"
      subtitle="Created in draft, so it stays out of Portfolio totals until you mark it active."
    >
      <Section
        title="Which Client, and what it is called"
        detail="Every Plant belongs to exactly one Client, and its code must match the {plant} segment of the topics its Devices publish on."
      >
        <div className="grid gap-3 sm:grid-cols-3">
          {needsClient ? (
            <Field label="Client" required hint="Fixed once created.">
              <select
                value={form.clientId}
                onChange={(e) => setForm({ ...form, clientId: e.target.value })}
                className={inputClass}
              >
                <option value="">Choose…</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>{c.code} — {c.name}</option>
                ))}
              </select>
            </Field>
          ) : null}
          <Field label="Plant code" required hint="Case-sensitive, and fixed once created.">
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
              onChange={(e) => { setNameTouched(true); setForm({ ...form, name: e.target.value }); }}
              placeholder="Kular Green Solar"
              className={inputClass}
            />
          </Field>
        </div>

        {unregisteredCodes.length > 0 ? (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-ink-faint">Publishing, not registered yet:</span>
            {unregisteredCodes.map((p) => (
              <button
                key={p.plant_code}
                type="button"
                onClick={() => setCode(p.plant_code)}
                className="rounded border border-warn/40 bg-warn/5 px-1.5 py-0.5 font-mono text-[11px] text-ink hover:border-warn"
                title={`${p.device_count} device(s), last heard ${AGE(p.last_seen)} ago. Click to fill the code in.`}
              >
                {p.plant_code}
              </button>
            ))}
          </div>
        ) : null}
      </Section>

      <Section
        title="Capacity and commissioning"
        detail="All optional, all editable later — but PR divides by DC capacity and CUF divides by AC capacity, so without them both read as undefined rather than as a missing field."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="AC capacity (kW)" hint="CUF divides by this.">
            <input
              type="number"
              min={0}
              value={form.ac_capacity_kw}
              onChange={(e) => setForm({ ...form, ac_capacity_kw: e.target.value })}
              className={inputClass}
            />
          </Field>
          <Field label="DC capacity (kWp)" hint="PR divides by this.">
            <input
              type="number"
              min={0}
              value={form.dc_capacity_kwp}
              onChange={(e) => setForm({ ...form, dc_capacity_kwp: e.target.value })}
              className={inputClass}
            />
          </Field>
          <Field label="Commissioned on" hint="The date it went live. Optional for a Plant still being built.">
            <input
              type="date"
              value={form.commissioned_on}
              onChange={(e) => setForm({ ...form, commissioned_on: e.target.value })}
              className={inputClass}
            />
          </Field>
          <RegionSelect
            value={form.region_code}
            onChange={(code) => setForm({ ...form, region_code: code })}
          />
          <Field label="Latitude" hint="Decimal degrees. Used for sunrise, sunset and irradiance.">
            <input
              type="number"
              step="0.000001"
              value={form.latitude}
              onChange={(e) => setForm({ ...form, latitude: e.target.value })}
              className={inputClass}
            />
          </Field>
          <Field label="Longitude" hint="Decimal degrees.">
            <input
              type="number"
              step="0.000001"
              value={form.longitude}
              onChange={(e) => setForm({ ...form, longitude: e.target.value })}
              className={inputClass}
            />
          </Field>
        </div>
      </Section>

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <Button
          variant="primary"
          disabled={!ready || create.isPending}
          onClick={() => create.mutate()}
        >
          {create.isPending ? "Creating…" : "Create Plant"}
        </Button>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        {!ready ? (
          <span className="text-[11px] text-ink-faint">
            Needs {needsClient ? "a Client, " : ""}a code and a display name.
          </span>
        ) : null}
      </div>
    </Panel>
  );
}

/**
 * Add a Device by pasting the topic it publishes on.
 *
 * ⚠ This is the **primary** way to add a Device, and broker discovery is the
 * convenience layered on top — not the other way round. Getting that backwards
 * was a real failure: registration was briefly possible only by picking from
 * discovery, which is Super Admin only, so the Client Admin who actually runs
 * the Plant could not add anything at all. Worse, equipment that had not
 * started publishing yet could not be registered by anyone.
 *
 * The topic is written and published before we onboard, so it is the one thing
 * the operator reliably has. Paste it and the platform reads it back: the
 * Client, the Plant, the Collector and the Device code all come out of the
 * string, parsed against the live registry rather than a second parser here.
 */
function AddDeviceByTopic({
  plantId, models, onAdded, onError,
}: {
  plantId: number;
  models: { id: number; model_code: string; variant: string | null; device_type_code: string }[];
  onAdded: (message: string) => void;
  onError: (message: string) => void;
}): JSX.Element {
  const [topic, setTopic] = useState("");
  const [modelId, setModelId] = useState<number | null>(null);
  const [interval, setInterval] = useState("");
  const [open, setOpen] = useState(false);

  // Debounced so every keystroke of a long topic is not a request, and keyed on
  // the trimmed value so trailing whitespace does not look like a new topic.
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(topic.trim()), 350);
    return () => window.clearTimeout(timer);
  }, [topic]);

  const parsed = useQuery({
    queryKey: ["parse-topic", plantId, debounced],
    queryFn: () => plantsApi.parseTopic(plantId, debounced),
    enabled: debounced.length > 0,
    retry: false,
  });

  const add = useMutation({
    mutationFn: async () => {
      const info = parsed.data;
      if (!info?.usable || !info.device_code || modelId === null) {
        throw new Error("the topic is not usable yet");
      }
      return devicesApi.createDevice(plantId, {
        code: info.device_code,
        name: info.device_code.replace(/[_-]+/g, " "),
        device_model_id: modelId,
        source_address: info.topic,
        // Read out of the topic, never chosen — the topic decides the enclosure.
        collector_code: info.collector_code,
        // Typed only when the Device is not publishing yet and there is nothing
        // to measure. Health thresholds multiply this, so it is asked for
        // plainly rather than defaulted silently.
        expected_interval_s: interval ? Number(interval) : 60,
        bind_from_model: true,
      });
    },
    onSuccess: (created) => {
      onAdded(
        `${created.code} added${
          created.bindings ? ` with ${created.bindings.bound} Tag binding(s)` : ""
        }. Wire it up in Plant Hierarchy when you know what it feeds.`,
      );
      setTopic(""); setModelId(null); setInterval(""); setOpen(false);
    },
    onError: (err) =>
      onError(isApiError(err) ? err.displayMessage : "Could not add the Device."),
  });

  if (!open) {
    return (
      <Button variant="primary" onClick={() => setOpen(true)}>
        + Add a Device
      </Button>
    );
  }

  const info = parsed.data;
  return (
    <div className="rounded border border-accent/40 bg-accent/5 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-ink">Add a Device</h3>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-[11px] text-ink-muted hover:text-ink hover:underline"
        >
          Cancel
        </button>
      </div>

      <Field
        label="Topic"
        required
        hint="Paste the topic the engineers configured. Everything else is read from it — topic levels are case-sensitive."
      >
        <input
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="scms/v1/CLIENT/PLANT/COLLECTOR/DEVICE"
          className={`${inputClass} font-mono text-xs`}
          autoFocus
        />
      </Field>

      {debounced && parsed.isFetching ? (
        <p className="mt-2 text-[11px] text-ink-faint">Reading the topic…</p>
      ) : null}

      {info ? (
        <div className="mt-2 space-y-2">
          {info.problems.length > 0 ? (
            <ul className="space-y-1">
              {info.problems.map((problem) => (
                <li
                  key={problem}
                  className="rounded border border-bad/30 bg-bad/10 px-2 py-1 text-[11px] leading-relaxed text-bad"
                >
                  {problem}
                </li>
              ))}
            </ul>
          ) : (
            <div className="rounded border border-ok/30 bg-ok/10 px-2 py-1.5 text-[11px] text-ok">
              Reads as <strong>{info.device_code}</strong>
              {info.collector_code
                ? <> in collector <strong>{info.collector_code}</strong></>
                : <> in no collector</>}
              , at plant <strong>{info.plant_code}</strong>.
            </div>
          )}

          {info.usable ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Device Model" required hint="Decides which Tags it will decode.">
                <select
                  value={modelId ?? ""}
                  onChange={(e) => setModelId(e.target.value ? Number(e.target.value) : null)}
                  className={inputClass}
                >
                  <option value="">Choose…</option>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.device_type_code} — {m.model_code}
                      {m.variant ? ` (${m.variant})` : ""}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="Expected interval (s)"
                hint="How often it publishes. Health thresholds multiply this, so a Device set to 60s that really sends every 3s can sit silent for ten minutes and still read as healthy."
              >
                <input
                  type="number"
                  min={1}
                  value={interval}
                  onChange={(e) => setInterval(e.target.value)}
                  placeholder="60"
                  className={inputClass}
                />
              </Field>
            </div>
          ) : null}

          <Button
            variant="primary"
            disabled={!info.usable || modelId === null || add.isPending}
            onClick={() => add.mutate()}
          >
            {add.isPending ? "Adding…" : `Add ${info.device_code ?? "Device"}`}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** One Device: a scannable line, expanding into everything about it. */
function DeviceRow({
  row, open, onToggle, observed, models, modelId, onModel,
  onRegister, registering, onStatus, onRemove, canDiscover,
}: {
  canDiscover: boolean;
  row: Row;
  open: boolean;
  onToggle: () => void;
  observed: { data?: discoveryApi.ObservedTopic; isLoading: boolean } | null;
  models: { id: number; model_code: string; variant: string | null; device_type_code: string }[];
  modelId: number | null;
  onModel: (id: number | null) => void;
  onRegister: () => void;
  registering: boolean;
  onStatus: (status: string) => void;
  onRemove: () => void;
}): JSX.Element {
  const device = row.device;
  const found = row.found;
  const topic = device?.source_address ?? found?.topic ?? null;
  const collector = device?.collector_code ?? found?.collector_code ?? null;

  return (
    <li className={`rounded border ${device ? "border-line" : "border-warn/40 bg-warn/5"}`}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left"
      >
        <span className="w-3 shrink-0 text-ink-faint">{open ? "▾" : "▸"}</span>
        <span className="truncate text-xs font-medium text-ink">{row.code}</span>
        {device ? (
          <span className="truncate text-[11px] text-ink-muted">{device.type_code}</span>
        ) : row.found?.status === "silent" ? (
          // A topic that stopped. Not work to do: registering it would create a
          // Device that never reports, indistinguishable from broken equipment.
          <Badge tone="neutral">
            stopped publishing
          </Badge>
        ) : (
          <Badge tone="warn">not registered — data being discarded</Badge>
        )}
        {collector ? (
          <span
            className="rounded border border-dashed border-line-strong px-1.5 text-[10px] text-ink-muted"
            title="The enclosure it publishes from. Decided by the topic, not editable."
          >
            {collector}
          </span>
        ) : null}
        {device ? <CommStatusBadge status={device.comm_status} /> : null}
        {device && device.status !== "active" ? (
          <Badge tone="warn">{device.status}</Badge>
        ) : null}
        <span className="ml-auto shrink-0 text-[11px] text-ink-faint">
          {/* ⚠ Silence here is only meaningful if we could have heard. Without
              discovery there is nothing to compare against, so saying "not
              publishing" would assert a fact we have no basis for — and it did,
              against every Device, for anyone who was not a Super Admin. */}
          {found
            ? `${found.messages} msg · ${AGE(found.last_seen)} ago`
            : canDiscover
              ? "not publishing"
              : ""}
        </span>
      </button>

      {open ? (
        <div className="space-y-3 border-t border-line px-3 py-3">
          <dl className="grid gap-x-4 gap-y-1 text-[11px] sm:grid-cols-2">
            <Fact
              label="Topic"
              hint="The sole authority for where this Device's data comes from."
              wrap
            >
              <span className="font-mono">{topic ?? "—"}</span>
            </Fact>
            <Fact label="Collector" hint="Read from the topic. A Collector is an enclosure, never a Device.">
              {collector ?? "none"}
            </Fact>
            <Fact
              label="Interval"
              hint="Measured from real messages. Health thresholds multiply this, so it must not be guessed."
            >
              {observed?.data?.interval_s
                ? `~${observed.data.interval_s}s (measured)`
                : device
                  ? `${device.expected_interval_s}s (recorded)`
                  : "measuring…"}
            </Fact>
            <Fact label="Bound Tags" hint="How many signals this Device decodes.">
              {device ? (device.binding_count ?? "—") : "not registered"}
            </Fact>
          </dl>

          {/* ── Not registered: choose a Model and confirm ─────────────── */}
          {!device && found ? (
            <div className="rounded border border-line bg-surface p-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field
                  label="Device Model"
                  required
                  hint="Decides the Tag set — and sharpens the mapping below, because the same key means different things on different equipment."
                >
                  <select
                    value={modelId ?? ""}
                    onChange={(e) => onModel(e.target.value ? Number(e.target.value) : null)}
                    className={inputClass}
                  >
                    <option value="">Choose…</option>
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.device_type_code} — {m.model_code}
                        {m.variant ? ` (${m.variant})` : ""}
                      </option>
                    ))}
                  </select>
                </Field>
                <div className="flex items-end">
                  <Button
                    variant="primary"
                    disabled={modelId === null || registering}
                    onClick={onRegister}
                  >
                    {registering ? "Registering…" : `Register ${row.code}`}
                  </Button>
                </div>
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
                Topic, collector and interval come from the broker. What it feeds
                into is set later in Plant Hierarchy, where the diagram is beside
                you — it is discovered, not decided here.
              </p>
            </div>
          ) : null}

          {/* ── Tags arriving, mapped ─────────────────────────────────── */}
          {observed?.isLoading ? (
            <SkeletonPanel lines={3} title={false} />
          ) : observed?.data && observed.data.keys.length > 0 ? (
            <div>
              <p className="mb-1 flex flex-wrap items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-ink-muted">
                Tags arriving
                {observed.data.unmapped_count ? (
                  <span className="normal-case text-warn">
                    {observed.data.unmapped_count} unmatched
                  </span>
                ) : null}
                {device ? (
                  <Link
                    to="/admin/bindings"
                    className="ml-auto normal-case text-accent hover:underline"
                    title="Correct a mapping, a scale or an offset."
                  >
                    edit bindings →
                  </Link>
                ) : null}
              </p>
              <div className="grid max-h-48 gap-1 overflow-auto sm:grid-cols-2">
                {observed.data.keys.map((key) => (
                  <div
                    key={key.source_key}
                    className={`flex items-center gap-2 rounded border px-2 py-1 text-[11px] ${
                      key.unmapped ? "border-warn/40 bg-warn/5" : "border-line bg-surface"
                    }`}
                  >
                    <span className="font-mono text-ink">{key.source_key}</span>
                    <span className="truncate text-ink-faint">{String(key.sample_value)}</span>
                    <span className="ml-auto shrink-0">
                      {key.suggested_tag_code ? (
                        <span className="text-ok">→ {key.suggested_tag_code}</span>
                      ) : (
                        <span
                          className="text-warn"
                          title="Nothing in the catalogue maps this key. It is a real signal that would be discarded — map it on the bindings screen."
                        >
                          no match
                        </span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {observed?.data?.last_payload ? (
            <details>
              <summary className="cursor-pointer text-[11px] text-accent hover:underline">
                Raw payload
              </summary>
              <div className="mt-2">
                <JsonTree value={observed.data.last_payload} />
              </div>
            </details>
          ) : null}

          {device ? (
            <div className="flex flex-wrap gap-2 border-t border-line pt-2">
              {device.status === "active" ? (
                <button
                  type="button"
                  onClick={() => onStatus("decommissioned")}
                  className="text-[11px] text-ink-muted hover:text-ink hover:underline"
                  title="Stop ingesting and hide it from the diagram — its history is kept."
                >
                  decommission
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => onStatus("active")}
                  className="text-[11px] text-ok hover:underline"
                >
                  re-activate
                </button>
              )}
              <button
                type="button"
                onClick={onRemove}
                className="ml-auto text-[11px] text-bad hover:underline"
                title="Delete it entirely. Refused if it has stored Readings."
              >
                remove
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function Fact({
  label, hint, children, wrap = false,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  /**
   * Let the value wrap instead of truncating.
   *
   * For the topic specifically: it is the longest value here and the part that
   * matters most is the *end* — the Device code. Truncating it hides exactly
   * the segment the reader is checking, on the narrow screen where they are
   * most likely to be standing in the plant checking it.
   */
  wrap?: boolean;
}): JSX.Element {
  return (
    <div className="flex justify-between gap-3 border-b border-line/60 py-0.5">
      <dt className="shrink-0 text-ink-muted" title={hint}>{label}</dt>
      <dd
        className={`min-w-0 text-right text-ink ${wrap ? "break-all" : "truncate"}`}
      >
        {children}
      </dd>
    </div>
  );
}

/**
 * The Plant's own fields, plus the counts derived from its Devices.
 *
 * ⚠ Everything the create form asks for is editable here. It was briefly not —
 * region, coordinates and the commissioning date could be set once and never
 * corrected — which makes a typo permanent on a record nobody can re-create
 * without deleting the Plant.
 */
function PlantDetails({
  plant, countsByType, onSaved,
}: {
  plant: ReturnType<typeof usePlant>["data"];
  countsByType: [string, number][];
  onSaved: (message: string) => void;
}): JSX.Element {
  const [form, setForm] = useState({
    name: plant?.name ?? "",
    status: plant?.status ?? "draft",
    region_code: plant?.region_code ?? "",
    ac_capacity_kw: plant?.ac_capacity_kw?.toString() ?? "",
    dc_capacity_kwp: plant?.dc_capacity_kwp?.toString() ?? "",
    latitude: plant?.latitude?.toString() ?? "",
    longitude: plant?.longitude?.toString() ?? "",
    commissioned_on: plant?.commissioned_on ?? "",
  });
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      plantsApi.updatePlant(plant!.id, {
        name: form.name,
        status: form.status,
        region_code: form.region_code || null,
        ac_capacity_kw: form.ac_capacity_kw ? Number(form.ac_capacity_kw) : null,
        dc_capacity_kwp: form.dc_capacity_kwp ? Number(form.dc_capacity_kwp) : null,
        latitude: form.latitude ? Number(form.latitude) : null,
        longitude: form.longitude ? Number(form.longitude) : null,
        commissioned_on: form.commissioned_on || null,
      }),
    onSuccess: () => { setError(null); onSaved("Plant updated."); },
    onError: (err) =>
      setError(isApiError(err) ? err.displayMessage : "Could not update the Plant."),
  });

  if (!plant) return <Panel title="Plant"><p className="text-xs">—</p></Panel>;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
      <Panel
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{plant.code}</span>
            <Badge tone={plant.status === "active" ? "ok" : "warn"}>{plant.status}</Badge>
          </span>
        }
        subtitle={`${plant.client_name ?? "—"} · the code comes from the topic and cannot be changed here.`}
      >
        <Section title="Identity">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Display name" required>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className={inputClass}
              />
            </Field>
            <Field label="Status" hint="Only an active Plant counts toward Portfolio totals.">
              <select
                value={form.status}
                onChange={(e) => setForm({ ...form, status: e.target.value })}
                className={inputClass}
              >
                {["draft", "commissioning", "active", "decommissioned"].map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </Field>
          </div>
        </Section>

        <Section
          title="Capacity and commissioning"
          detail="PR divides by DC capacity and CUF divides by AC capacity; without them both are undefined, which is not the same as zero."
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="AC capacity (kW)" hint="CUF divides by this.">
              <input
                type="number"
                min={0}
                value={form.ac_capacity_kw}
                onChange={(e) => setForm({ ...form, ac_capacity_kw: e.target.value })}
                className={inputClass}
              />
            </Field>
            <Field label="DC capacity (kWp)" hint="PR divides by this.">
              <input
                type="number"
                min={0}
                value={form.dc_capacity_kwp}
                onChange={(e) => setForm({ ...form, dc_capacity_kwp: e.target.value })}
                className={inputClass}
              />
            </Field>
            <Field label="Commissioned on" hint="The date it went live.">
              <input
                type="date"
                value={form.commissioned_on}
                onChange={(e) => setForm({ ...form, commissioned_on: e.target.value })}
                className={inputClass}
              />
            </Field>
            <RegionSelect
              value={form.region_code}
              onChange={(code) => setForm({ ...form, region_code: code })}
            />
            <Field label="Latitude" hint="Decimal degrees.">
              <input
                type="number"
                step="0.000001"
                value={form.latitude}
                onChange={(e) => setForm({ ...form, latitude: e.target.value })}
                className={inputClass}
              />
            </Field>
            <Field label="Longitude" hint="Decimal degrees.">
              <input
                type="number"
                step="0.000001"
                value={form.longitude}
                onChange={(e) => setForm({ ...form, longitude: e.target.value })}
                className={inputClass}
              />
            </Field>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
            Timestamps on this Plant render in{" "}
            <span className="font-mono">{plant.timezone}</span>, never the
            browser's — an Asia/Kolkata Plant read in UTC attributes five and a
            half hours to the wrong day.
          </p>
        </Section>

        {error ? <p className="mt-3 text-xs text-bad">{error}</p> : null}
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

      <Panel
        title="What this Plant has"
        subtitle="Counted from the Devices that exist. Never typed in, so it cannot drift from reality."
      >
        {countsByType.length === 0 ? (
          <p className="text-xs text-ink-faint">
            No Devices registered yet — add them on the Devices tab.
          </p>
        ) : (
          <ul className="space-y-1">
            {countsByType.map(([type, count]) => (
              <li
                key={type}
                className="flex items-center justify-between rounded border border-line bg-surface px-2 py-1.5 text-xs"
              >
                <span className="text-ink">{type}</span>
                <span className="font-mono text-ink-muted">{count}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
