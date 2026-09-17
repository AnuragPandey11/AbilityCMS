/**
 * The onboarding wizard (§7.1), mirroring MASTER §6.5:
 * Client → Plant (`draft`) → Blocks *(optional)* → Devices → bindings →
 * `commissioning` → `active`.
 *
 * ⚠ **`expected_interval_s` is required and prominent**, with the reason
 * attached. The 60s default is an assumption and the client's broker publishes
 * every ~2.78s; health thresholds multiply this column, so a Device registered
 * at 60s can sit silent for ten minutes while still reading as healthy.
 *
 * ⚠ **There is no "skip Blocks" toggle that defaults to creating one.** Zero
 * Blocks is the normal case (MASTER §2.2), so the Block step is opt-in and
 * skipping it is the unremarkable path.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDeviceModels, useDeviceTypes } from "@/api/hooks";
import { qk } from "@/api/queryKeys";
import * as clientsApi from "@/api/endpoints/clients";
import * as plantsApi from "@/api/endpoints/plants";
import * as devicesApi from "@/api/endpoints/devices";
import { isApiError } from "@/api/problem";
import { Button, Field, Panel, Badge, inputClass } from "@/components/ui";
import { ErrorState, ForbiddenState, LoadingState } from "@/components/state";
import { NewClientForm } from "@/admin/NewClientForm";
import { CommissioningPanel } from "@/admin/CommissioningPanel";
import { RegionSelect } from "@/admin/RegionSelect";
import { usePermission } from "@/auth/usePermission";
import { useAuth } from "@/auth/AuthProvider";
import { DEFAULT_TIMEZONE } from "@/format/datetime";

const STEPS = [
  { key: "plant", label: "Plant" },
  { key: "blocks", label: "Blocks (optional)" },
  { key: "devices", label: "Devices" },
  { key: "commission", label: "Commission" },
] as const;

interface DraftDevice {
  code: string;
  name: string;
  device_model_id: number | null;
  source_address: string;
  expected_interval_s: string;
  rated_capacity_kw: string;
  /**
   * How many inputs of the Model's repeating group this unit has — the PV
   * strings on this Inverter. Asked per Device, not per Model, because the same
   * datasheet covers a 12-string and a 24-string machine.
   */
  string_count: string;
  block_index: number | null;
  parent_index: number | null;
  reports_via_index: number | null;
}

const emptyDevice = (): DraftDevice => ({
  code: "",
  name: "",
  device_model_id: null,
  source_address: "",
  // Deliberately blank rather than pre-filled with 60: a default that is an
  // assumption should not arrive looking like a decision.
  expected_interval_s: "",
  rated_capacity_kw: "",
  string_count: "",
  block_index: null,
  parent_index: null,
  reports_via_index: null,
});

export function OnboardingWizard(): JSX.Element {
  const canManage = usePermission("plant.manage");
  const isPlatformAdmin = usePermission("system.admin");
  const { me, switchClient } = useAuth();
  const queryClient = useQueryClient();
  const modelsQuery = useDeviceModels();
  const typesQuery = useDeviceTypes();

  // A Plant belongs to a Client, and the backend takes that Client from the
  // token alone (I-9) — never from the request. A Super Admin signs in with no
  // active Client, so the wizard cannot start until one is chosen.
  const needsClient = me !== null && me.client_id === null;

  // ⚠ Deliberately NOT gated on `needsClient`. It was, and that made the Client
  // step a one-way door: once a session had switched into a Client, the flag was
  // false forever, the chooser never rendered again, and a Super Admin who had
  // onboarded one Client could not create or reach a second without signing out.
  const clientsQuery = useQuery({
    queryKey: qk.clients(),
    queryFn: clientsApi.listClients,
    enabled: isPlatformAdmin,
    retry: false,
  });

  const [step, setStep] = useState(0);
  // The furthest step reached. `step` alone cannot drive the tabs: stepping back
  // to 1 would lower it and strand the work done at 3 with no way forward.
  const [maxStep, setMaxStep] = useState(0);
  // Set when a Super Admin asks for the Client chooser again on purpose, as
  // opposed to arriving without a Client at all.
  const [changingClient, setChangingClient] = useState(false);
  const [plantId, setPlantId] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [plant, setPlant] = useState({
    code: "",
    name: "",
    region_code: "",
    ac_capacity_kw: "",
    dc_capacity_kwp: "",
    timezone: DEFAULT_TIMEZONE,
    latitude: "",
    longitude: "",
    commissioned_on: "",
  });

  // Planned Device count per Device Type code, as typed. Kept as strings so an
  // empty box stays empty rather than becoming a 0 the operator never entered —
  // "none planned" and "not filled in" are different statements, and only the
  // first should be stored.
  const [deviceCounts, setDeviceCounts] = useState<Record<string, string>>({});

  const [blocks, setBlocks] = useState<
    { code: string; name: string; capacity_kwp: string; id: number | null }[]
  >([]);
  const [devices, setDevices] = useState<DraftDevice[]>([emptyDevice()]);
  const [createdDevices, setCreatedDevices] = useState<
    { id: number; code: string }[]
  >([]);

  /** Move forward, remembering how far the wizard has got. */
  const advanceTo = (index: number): void => {
    setStep(index);
    setMaxStep((previous) => Math.max(previous, index));
  };

  /**
   * Jump to a step from the tab strip.
   *
   * Backwards is always allowed; forwards only as far as the wizard has already
   * reached, because every step past the first acts on a Plant that does not
   * exist until step 1 creates it. The guard is `plantId`, not the index: a
   * stale `maxStep` after a reset would otherwise let step 3 act on nothing.
   */
  const goToStep = (index: number): void => {
    if (index > maxStep) return;
    if (index > 0 && plantId === null) return;
    setError(null);
    setStep(index);
  };

  const stepReachable = (index: number): boolean =>
    index <= maxStep && (index === 0 || plantId !== null);

  /**
   * Clear everything belonging to one Plant.
   *
   * Called when switching Client as well as when starting a second Plant —
   * `plantId` and the created Devices belong to the Client that was active when
   * they were made, and carrying them into a different Client would point the
   * later steps at another Client\u2019s Plant.
   */
  const resetWizard = (): void => {
    setStep(0);
    setMaxStep(0);
    setPlantId(null);
    setPlant({
      code: "",
      name: "",
      region_code: "",
      ac_capacity_kw: "",
      dc_capacity_kwp: "",
      timezone: DEFAULT_TIMEZONE,
      latitude: "",
      longitude: "",
      commissioned_on: "",
    });
    setDeviceCounts({});
    setBlocks([]);
    setDevices([emptyDevice()]);
    setCreatedDevices([]);
    setError(null);
  };

  /** Switch the session into a Client, then start its onboarding clean. */
  const switchToClient = (clientId: number, label: string): void => {
    setError(null);
    switchClient(clientId)
      .then(() => {
        resetWizard();
        setChangingClient(false);
        setMessage(`Now onboarding under ${label}.`);
      })
      .catch(() => setError(`Could not switch to ${label}.`));
  };

  const createPlant = useMutation({
    mutationFn: () =>
      plantsApi.createPlant({
        code: plant.code,
        name: plant.name,
        region_code: plant.region_code || null,
        ac_capacity_kw: plant.ac_capacity_kw
          ? Number(plant.ac_capacity_kw)
          : null,
        dc_capacity_kwp: plant.dc_capacity_kwp
          ? Number(plant.dc_capacity_kwp)
          : null,
        timezone: plant.timezone,
        latitude: plant.latitude ? Number(plant.latitude) : null,
        longitude: plant.longitude ? Number(plant.longitude) : null,
        commissioned_on: plant.commissioned_on || null,
        device_counts: Object.fromEntries(
          Object.entries(deviceCounts)
            .filter(([, value]) => value.trim() !== "")
            .map(([code, value]) => [code, Number(value)]),
        ),
      }),
    onSuccess: (created) => {
      setPlantId(created.id);
      setError(null);
      setMessage(`Plant created in draft (id ${created.id}).`);
      advanceTo(1);
      void queryClient.invalidateQueries({ queryKey: ["plants"] });
    },
    onError: (err) =>
      setError(
        isApiError(err) ? err.displayMessage : "Could not create the Plant.",
      ),
  });

  const createBlocks = useMutation({
    mutationFn: async () => {
      const out: {
        code: string;
        name: string;
        capacity_kwp: string;
        id: number | null;
      }[] = [];
      for (const block of blocks) {
        if (block.id !== null) {
          out.push(block);
          continue;
        }
        const created = (await plantsApi.createBlock(plantId as number, {
          code: block.code,
          name: block.name,
          // NOT NULL by design: a Client who defines zones wants zone-level
          // performance, and PR is meaningless without a capacity to divide by.
          capacity_kwp: Number(block.capacity_kwp),
        })) as { id: number };
        out.push({ ...block, id: created.id });
      }
      return out;
    },
    onSuccess: (result) => {
      setBlocks(result);
      setError(null);
      setMessage(`${result.length} Block(s) created.`);
      advanceTo(2);
    },
    onError: (err) =>
      setError(
        isApiError(err) ? err.displayMessage : "Could not create Blocks.",
      ),
  });

  const importDevices = useMutation({
    mutationFn: async () => {
      const payload = devices.map((device) => ({
        code: device.code,
        name: device.name,
        device_model_id: device.device_model_id as number,
        source_address: device.source_address || null,
        expected_interval_s: Number(device.expected_interval_s),
        rated_capacity_kw: device.rated_capacity_kw
          ? Number(device.rated_capacity_kw)
          : null,
        string_count: device.string_count ? Number(device.string_count) : null,
        block_id:
          device.block_index !== null
            ? (blocks[device.block_index]?.id ?? null)
            : null,
        // Seed each Device's bindings from its Model's signal schedule, so it
        // decodes something from its first message rather than looking broken.
        bind_from_model: true,
      }));
      const result = await devicesApi.bulkImportDevices(
        plantId as number,
        payload,
      );

      // Wiring is applied as a second pass, on purpose. Creation is
      // all-or-nothing and inserts in order, so no Device in the batch can
      // reference another's id — they do not exist yet. Patching afterwards is
      // the only way the form's "feeds into" and "reports via" choices can
      // become real without giving up the atomic create.
      const wiring = devices
        .map((device, index) => ({ device, index }))
        .filter(
          ({ device }) =>
            device.parent_index !== null || device.reports_via_index !== null,
        );
      let wired = 0;
      for (const { device, index } of wiring) {
        const id = result.devices[index]?.id;
        if (id === undefined) continue;
        await devicesApi.updateDevice(id, {
          parent_device_id:
            device.parent_index !== null
              ? (result.devices[device.parent_index]?.id ?? null)
              : null,
          reports_via_device_id:
            device.reports_via_index !== null
              ? (result.devices[device.reports_via_index]?.id ?? null)
              : null,
        });
        wired += 1;
      }
      return { ...result, wired };
    },
    onSuccess: (result) => {
      setCreatedDevices(result.devices);
      setError(null);
      setMessage(
        `${result.created} Device(s) registered` +
          (result.wired ? `, ${result.wired} wired into the diagram.` : "."),
      );
      advanceTo(3);
      void queryClient.invalidateQueries({ queryKey: ["plants"] });
    },
    onError: (err) =>
      setError(
        isApiError(err) ? err.displayMessage : "Could not import the Devices.",
      ),
  });

  const setStatus = useMutation({
    mutationFn: ({ status, force }: { status: string; force?: boolean }) =>
      plantsApi.changePlantStatus(plantId as number, status, { force }),
    onSuccess: (_result, variables) => {
      setError(null);
      setMessage(`Plant moved to ${variables.status}.`);
      void queryClient.invalidateQueries({ queryKey: ["plants"] });
    },
    onError: (err) =>
      setError(
        isApiError(err)
          ? // A refusal is the readiness gate doing its job, not a fault. Said
            // plainly, with the way past it, or the operator reads it as a bug.
            `${err.displayMessage} Resolve the blocking issues listed above, or use "Activate anyway".`
          : "Could not change the status.",
      ),
  });

  if (!canManage) {
    return (
      <ForbiddenState detail="Onboarding requires the plant.manage permission." />
    );
  }

  const models = modelsQuery.data ?? [];
  // Grouped by Device Type in catalogue order, so every one of the client's 17
  // Types is visible at a glance — the integration-test fixtures ("Rep",
  // "Tier") would otherwise bury the reference Models.
  const modelGroups = (typesQuery.data ?? []).map((type) => ({
    type,
    models: models
      .filter((model) => model.device_type_code === type.code)
      .sort((a, b) =>
        a.manufacturer === "Reference"
          ? -1
          : b.manufacturer === "Reference"
            ? 1
            : 0,
      ),
  }));
  const updateDevice = (index: number, patch: Partial<DraftDevice>) =>
    setDevices((previous) =>
      previous.map((device, i) =>
        i === index ? { ...device, ...patch } : device,
      ),
    );

  const modelById = new Map(models.map((model) => [model.id, model]));

  /** How far this Model's repeating group runs — 28 for a String Inverter, 0 for a VCB. */
  const repeatMaxFor = (modelId: number | null): number =>
    modelId === null ? 0 : (modelById.get(modelId)?.repeat_max ?? 0);

  /**
   * What choosing this Model actually means, in Tags.
   *
   * Shown because "Reference String Inverter" says nothing about whether this
   * Device will decode 23 signals or 107, and the difference is entirely the
   * string count typed two fields to the left.
   */
  const modelSummary = (modelId: number | null, stringCount: string): string => {
    const model = modelId === null ? null : modelById.get(modelId);
    if (!model) return "Choose a Model to see what it will report.";
    const base = model.signal_count ?? 0;
    const repeat = model.repeat_max ?? 0;
    const strings = stringCount ? Number(stringCount) : 0;
    const perString = repeat > 0 ? 3 : 0;
    const derived = model.derived_count ?? 0;
    const bound = base - derived + Math.min(strings, repeat) * perString;
    const parts = [`${bound} Tag(s) will be bound`];
    if (derived > 0) parts.push(`${derived} computed from formulas`);
    if (repeat > 0 && strings === 0)
      parts.push(`no PV strings set — none of the ${repeat} will be bound`);
    return parts.join(" · ");
  };

  const devicesValid = devices.every(
    (device) =>
      device.code.trim() &&
      device.name.trim() &&
      device.device_model_id !== null &&
      device.expected_interval_s.trim() &&
      Number(device.expected_interval_s) > 0,
  );

  // Shown when the session has no Client at all, or when a Super Admin has
  // asked to change it. A Client Admin never sees it: their token is bound to
  // one Client (I-9) and switching is not theirs to do.
  const showClientPicker =
    step === 0 && (needsClient || (changingClient && isPlatformAdmin));

  const activeClient =
    clientsQuery.data?.find((entry) => entry.id === me?.client_id) ?? null;
  const activeClientLabel = activeClient
    ? `${activeClient.code} · ${activeClient.name}`
    : me?.client_id !== null && me?.client_id !== undefined
      ? `Client #${me.client_id}`
      : "no Client";

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-ink">Plant onboarding</h1>
        <p className="text-xs text-ink-muted">
          A Plant is created in <span className="font-mono">draft</span>,
          populated, then commissioned and activated.
        </p>
      </div>

      {/*
        Navigable, not decorative. These were inert Badges, which made the wizard
        one-way: a typo in the Plant name at step 1 could not be corrected from
        step 3 without starting over. A step is clickable once it has been
        reached — forward only as far as the work actually exists.
      */}
      <ol className="flex flex-wrap gap-2">
        {STEPS.map((entry, index) => {
          const reachable = stepReachable(index);
          const label = `${index + 1}. ${entry.label}`;
          return (
            <li key={entry.key}>
              {reachable ? (
                <button
                  type="button"
                  onClick={() => goToStep(index)}
                  aria-current={index === step ? "step" : undefined}
                  className="rounded-control focus:outline-none focus:ring-2 focus:ring-accent/40"
                  title={
                    index === step
                      ? "Current step"
                      : `Go back to ${entry.label}`
                  }
                >
                  <Badge tone={index === step ? "accent" : "ok"}>{label}</Badge>
                </button>
              ) : (
                <span
                  title={
                    plantId === null && index > 0
                      ? "Create the Plant first — every later step acts on it."
                      : "Not reached yet."
                  }
                  className="cursor-not-allowed opacity-60"
                >
                  <Badge tone="neutral">{label}</Badge>
                </span>
              )}
            </li>
          );
        })}
      </ol>

      {message ? (
        <div className="rounded border border-ok/30 bg-ok/10 px-3 py-2 text-xs text-ok">
          {message}
        </div>
      ) : null}
      {error ? (
        <div className="rounded border border-bad/30 bg-bad/10 px-3 py-2 text-xs text-bad">
          {error}
        </div>
      ) : null}

      {step === 0 && showClientPicker ? (
        <Panel
          title="1 · Client"
          subtitle={
            needsClient
              ? "A Plant is created under the active Client, which this session does not have yet."
              : `Currently onboarding under ${activeClientLabel}. Choosing another clears this Plant draft.`
          }
          actions={
            !needsClient ? (
              <Button onClick={() => setChangingClient(false)}>Cancel</Button>
            ) : undefined
          }
        >
          {!isPlatformAdmin ? (
            <p className="text-xs text-ink-muted">
              Your account has no Client membership. Ask a Super Admin to add
              you to a Client before onboarding a Plant.
            </p>
          ) : clientsQuery.isPending ? (
            <LoadingState />
          ) : clientsQuery.isError ? (
            <ErrorState
              error={clientsQuery.error}
              retry={() => void clientsQuery.refetch()}
            />
          ) : (
            <div className="max-w-2xl space-y-4">
              <div>
                <h3 className="mb-2 text-sm font-medium text-ink">
                  New Client
                </h3>
                <p className="mb-3 text-xs text-ink-muted">
                  Create the Client this Plant belongs to. The session switches
                  into it and the Plant form follows.
                </p>
                <NewClientForm
                  submitLabel="Create Client and continue"
                  onCreated={(client) => {
                    setError(null);
                    setMessage(`Client ${client.code} created.`);
                    switchToClient(client.id, client.code);
                  }}
                />
              </div>
              {clientsQuery.data.length > 0 ? (
                <div>
                  <h3 className="mb-2 text-sm font-medium text-ink">
                    Existing Client
                  </h3>
                  <p className="mb-3 text-xs text-ink-muted">
                    Or choose one that already exists. Switching Client clears
                    every cached query — nothing from another Client survives.
                  </p>
                  <ul className="space-y-1">
                    {clientsQuery.data.map((client) => (
                      <li
                        key={client.id}
                        className="flex items-center justify-between rounded border border-line bg-surface px-3 py-1.5"
                      >
                        <span className="text-sm text-ink">
                          <span className="font-mono text-xs text-ink-muted">
                            {client.code}
                          </span>{" "}
                          {client.name}
                        </span>
                        <Button
                          variant="primary"
                          disabled={client.id === me?.client_id}
                          onClick={() => switchToClient(client.id, client.code)}
                        >
                          {client.id === me?.client_id
                            ? "Current Client"
                            : "Use this Client"}
                        </Button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          )}
        </Panel>
      ) : null}

      {step === 0 && !showClientPicker ? (
        <Panel
          title="1 · Plant"
          subtitle={`Created in draft under ${activeClientLabel}, and excluded from portfolio totals until it is active.`}
          actions={
            isPlatformAdmin ? (
              <Button
                onClick={() => {
                  setMessage(null);
                  setChangingClient(true);
                }}
                title="Pick a different Client, or create a new one."
              >
                Change Client
              </Button>
            ) : undefined
          }
        >
          <div className="grid max-w-2xl grid-cols-2 gap-3">
            <Field
              label="Code"
              required
              hint="Unique within the Client. Used in MQTT topics."
            >
              <input
                value={plant.code}
                onChange={(event) =>
                  setPlant({ ...plant, code: event.target.value })
                }
                className={inputClass}
              />
            </Field>
            <Field label="Name" required>
              <input
                value={plant.name}
                onChange={(event) =>
                  setPlant({ ...plant, name: event.target.value })
                }
                className={inputClass}
              />
            </Field>
            <RegionSelect
              value={plant.region_code}
              onChange={(code) => setPlant({ ...plant, region_code: code })}
            />
            <Field
              label="Timezone"
              hint="Every timestamp for this Plant is displayed in this zone, not the viewer's."
            >
              <input
                value={plant.timezone}
                onChange={(event) =>
                  setPlant({ ...plant, timezone: event.target.value })
                }
                className={inputClass}
              />
            </Field>
            <Field label="AC capacity (kW)">
              <input
                type="number"
                value={plant.ac_capacity_kw}
                onChange={(event) =>
                  setPlant({ ...plant, ac_capacity_kw: event.target.value })
                }
                className={inputClass}
              />
            </Field>
            <Field
              label="DC capacity (kWp)"
              hint="Performance ratio divides by this; without it PR is undefined."
            >
              <input
                type="number"
                value={plant.dc_capacity_kwp}
                onChange={(event) =>
                  setPlant({ ...plant, dc_capacity_kwp: event.target.value })
                }
                className={inputClass}
              />
            </Field>
            <Field
              label="Latitude"
              hint="Decimal degrees. Used for sunrise/sunset and irradiance context."
            >
              <input
                type="number"
                step="any"
                value={plant.latitude}
                onChange={(event) =>
                  setPlant({ ...plant, latitude: event.target.value })
                }
                className={inputClass}
              />
            </Field>
            <Field label="Longitude" hint="Decimal degrees.">
              <input
                type="number"
                step="any"
                value={plant.longitude}
                onChange={(event) =>
                  setPlant({ ...plant, longitude: event.target.value })
                }
                className={inputClass}
              />
            </Field>
            <Field
              label="Commissioned on"
              hint="The date the Plant went live. Leave blank if it has not."
            >
              <input
                type="date"
                value={plant.commissioned_on}
                onChange={(event) =>
                  setPlant({ ...plant, commissioned_on: event.target.value })
                }
                className={inputClass}
              />
            </Field>
          </div>

          {/*
            Planned Device counts, driven by the seeded Device Type catalogue
            rather than a hardcoded list of fields — a Type added by a later seed
            appears here with no code change.

            ⚠ These are the contract or design-sheet figures, not the Devices
            themselves. Registering the Devices is step 3; this records how many
            there are *meant* to be, so commissioning progress is measurable
            before any of them exist.
          */}
          <div className="mt-6 max-w-2xl border-t border-line pt-4">
            <h3 className="text-sm font-medium text-ink">
              Planned Device counts
            </h3>
            <p className="mb-3 mt-1 text-xs leading-relaxed text-ink-muted">
              Optional. How many of each Device this Plant is designed to have,
              from the contract. This is not the same as registering them —
              that happens in step 3 — and the difference between the two is
              what is left to commission. Leave a box empty if the figure is
              unknown; enter 0 to state that the Plant has none.
            </p>
            {typesQuery.isPending ? (
              <LoadingState />
            ) : typesQuery.isError ? (
              <ErrorState
                error={typesQuery.error}
                retry={() => void typesQuery.refetch()}
              />
            ) : (
              <div className="grid grid-cols-3 gap-2">
                {[...typesQuery.data]
                  // Power-path Types first: an operator filling this in is
                  // thinking about Inverters and Transformers, and the
                  // Annunciator can wait for the bottom of the list.
                  .sort((a, b) =>
                    a.in_power_path === b.in_power_path
                      ? a.name.localeCompare(b.name)
                      : a.in_power_path
                        ? -1
                        : 1,
                  )
                  .map((type) => (
                    <Field key={type.code} label={type.name}>
                      <input
                        type="number"
                        min={0}
                        value={deviceCounts[type.code] ?? ""}
                        onChange={(event) =>
                          setDeviceCounts((previous) => ({
                            ...previous,
                            [type.code]: event.target.value,
                          }))
                        }
                        className={inputClass}
                      />
                    </Field>
                  ))}
              </div>
            )}
          </div>

          <Button
            variant="primary"
            className="mt-4"
            disabled={!plant.code || !plant.name || createPlant.isPending}
            onClick={() => createPlant.mutate()}
          >
            {createPlant.isPending ? "Creating…" : "Create Plant"}
          </Button>
        </Panel>
      ) : null}

      {step === 1 ? (
        <Panel
          title="2 · Blocks"
          subtitle="Optional. A Plant with zero Blocks is valid and normal — most are."
        >
          <p className="mb-3 max-w-2xl text-xs leading-relaxed text-ink-muted">
            A Block is a geographic grouping used for zone-level performance.
            Add them only if this Plant is actually divided into zones the
            Client wants reported separately. Devices attach directly to the
            Plant without one, and there is no "unassigned" Block.
          </p>

          {blocks.map((block, index) => (
            <div key={index} className="mb-2 grid grid-cols-3 gap-2">
              <input
                placeholder="Code"
                value={block.code}
                onChange={(event) =>
                  setBlocks((previous) =>
                    previous.map((entry, i) =>
                      i === index
                        ? { ...entry, code: event.target.value }
                        : entry,
                    ),
                  )
                }
                className={inputClass}
              />
              <input
                placeholder="Name"
                value={block.name}
                onChange={(event) =>
                  setBlocks((previous) =>
                    previous.map((entry, i) =>
                      i === index
                        ? { ...entry, name: event.target.value }
                        : entry,
                    ),
                  )
                }
                className={inputClass}
              />
              <input
                placeholder="Capacity kWp (required)"
                type="number"
                value={block.capacity_kwp}
                onChange={(event) =>
                  setBlocks((previous) =>
                    previous.map((entry, i) =>
                      i === index
                        ? { ...entry, capacity_kwp: event.target.value }
                        : entry,
                    ),
                  )
                }
                className={inputClass}
              />
            </div>
          ))}

          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              onClick={() =>
                setBlocks((previous) => [
                  ...previous,
                  { code: "", name: "", capacity_kwp: "", id: null },
                ])
              }
            >
              Add a Block
            </Button>
            {blocks.length > 0 ? (
              <Button
                variant="primary"
                disabled={createBlocks.isPending}
                onClick={() => createBlocks.mutate()}
              >
                {createBlocks.isPending
                  ? "Creating…"
                  : "Create Blocks and continue"}
              </Button>
            ) : null}
            {/* Skipping is the ordinary path, not an escape hatch. */}
            <Button onClick={() => advanceTo(2)}>
              {blocks.length === 0
                ? "Continue without Blocks"
                : "Skip remaining"}
            </Button>
          </div>
        </Panel>
      ) : null}

      {step === 2 ? (
        <Panel
          title="3 · Devices"
          subtitle="Imported all-or-nothing. A parent Device must be listed before its children."
        >
          <div className="mb-4 rounded border border-warn/30 bg-warn/10 px-3 py-2 text-[11px] leading-relaxed text-ink-muted">
            <strong className="text-warn">
              Expected interval must come from observation.
            </strong>{" "}
            Health thresholds multiply this column: a Device registered at 60s
            can sit silent for ten minutes and still read as healthy. Measure
            what the Device actually publishes — the client's broker publishes
            roughly every 2.8s — rather than accepting a default.
          </div>

          <div className="space-y-3">
            {devices.map((device, index) => (
              <div
                key={index}
                className="grid grid-cols-2 gap-2 rounded border border-line p-3 lg:grid-cols-4"
              >
                <Field label="Code" required>
                  <input
                    value={device.code}
                    onChange={(event) =>
                      updateDevice(index, { code: event.target.value })
                    }
                    className={inputClass}
                  />
                </Field>
                <Field label="Name" required>
                  <input
                    value={device.name}
                    onChange={(event) =>
                      updateDevice(index, { name: event.target.value })
                    }
                    className={inputClass}
                  />
                </Field>
                <Field label="Device Model" required>
                  <select
                    value={device.device_model_id ?? ""}
                    onChange={(event) =>
                      updateDevice(index, {
                        device_model_id: event.target.value
                          ? Number(event.target.value)
                          : null,
                      })
                    }
                    className={inputClass}
                  >
                    <option value="">Choose…</option>
                    {modelGroups.map(({ type, models: group }) => (
                      <optgroup
                        key={type.code}
                        label={`${type.name} (${type.code})`}
                      >
                        {group.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.manufacturer ? `${model.manufacturer} ` : ""}
                            {model.model_code}
                            {model.variant ? ` (${model.variant})` : ""}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </Field>
                <Field
                  label="Expected interval (s)"
                  required
                  hint="From observation, not the default."
                >
                  <input
                    type="number"
                    min={1}
                    value={device.expected_interval_s}
                    onChange={(event) =>
                      updateDevice(index, {
                        expected_interval_s: event.target.value,
                      })
                    }
                    className={`${inputClass} border-warn/40`}
                  />
                </Field>
                <Field
                  label="MQTT topic"
                  hint="scms/v1/{client}/{plant}/{collector}/{device} — the sole authority for origin."
                >
                  <input
                    value={device.source_address}
                    onChange={(event) =>
                      updateDevice(index, {
                        source_address: event.target.value,
                      })
                    }
                    className={`${inputClass} font-mono text-xs`}
                  />
                </Field>
                <Field label="Rated capacity (kW)">
                  <input
                    type="number"
                    value={device.rated_capacity_kw}
                    onChange={(event) =>
                      updateDevice(index, {
                        rated_capacity_kw: event.target.value,
                      })
                    }
                    className={inputClass}
                  />
                </Field>
                {repeatMaxFor(device.device_model_id) > 0 ? (
                  <Field
                    label="PV strings on this unit"
                    hint={`Up to ${repeatMaxFor(device.device_model_id)}. Only this many PV inputs are bound.`}
                  >
                    <input
                      type="number"
                      min={0}
                      max={repeatMaxFor(device.device_model_id)}
                      value={device.string_count}
                      onChange={(event) =>
                        updateDevice(index, {
                          string_count: event.target.value,
                        })
                      }
                      className={inputClass}
                    />
                  </Field>
                ) : null}
                {blocks.length > 0 ? (
                  <Field label="Block" hint="Where it is — not what it feeds.">
                    <select
                      value={device.block_index ?? ""}
                      onChange={(event) =>
                        updateDevice(index, {
                          block_index: event.target.value
                            ? Number(event.target.value)
                            : null,
                        })
                      }
                      className={inputClass}
                    >
                      <option value="">None</option>
                      {blocks.map((block, blockIndex) => (
                        <option key={blockIndex} value={blockIndex}>
                          {block.code}
                        </option>
                      ))}
                    </select>
                  </Field>
                ) : null}
                {/*
                  The two relationships that are not "where it is". Collapsing
                  either into the Block makes both unanswerable: without "feeds
                  into" there is no Single Line Diagram, and without "reports
                  via" a failed collector is recorded as equipment downtime and
                  corrupts every availability figure.
                */}
                <Field
                  label="Feeds into"
                  hint="Electrical parent — this is what draws the Single Line Diagram."
                >
                  <select
                    value={device.parent_index ?? ""}
                    onChange={(event) =>
                      updateDevice(index, {
                        parent_index: event.target.value
                          ? Number(event.target.value)
                          : null,
                      })
                    }
                    className={inputClass}
                  >
                    <option value="">Nothing (a diagram root)</option>
                    {devices.map((other, otherIndex) =>
                      otherIndex === index ? null : (
                        <option key={otherIndex} value={otherIndex}>
                          {other.code || `Device ${otherIndex + 1}`}
                        </option>
                      ),
                    )}
                  </select>
                </Field>
                <Field
                  label="Reports via"
                  hint="Which Collector transmits it. Separates comms loss from downtime."
                >
                  <select
                    value={device.reports_via_index ?? ""}
                    onChange={(event) =>
                      updateDevice(index, {
                        reports_via_index: event.target.value
                          ? Number(event.target.value)
                          : null,
                      })
                    }
                    className={inputClass}
                  >
                    <option value="">Publishes for itself</option>
                    {devices.map((other, otherIndex) =>
                      otherIndex === index ? null : (
                        <option key={otherIndex} value={otherIndex}>
                          {other.code || `Device ${otherIndex + 1}`}
                        </option>
                      ),
                    )}
                  </select>
                </Field>
                <div className="col-span-2 flex items-center justify-between border-t border-line pt-2 lg:col-span-4">
                  <span className="text-[11px] text-ink-faint">
                    {modelSummary(device.device_model_id, device.string_count)}
                  </span>
                  {devices.length > 1 ? (
                    <button
                      type="button"
                      onClick={() =>
                        setDevices((previous) =>
                          previous.filter((_, i) => i !== index),
                        )
                      }
                      className="text-[11px] text-bad hover:underline"
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-3 flex gap-2">
            <Button
              onClick={() =>
                setDevices((previous) => [...previous, emptyDevice()])
              }
            >
              Add a Device
            </Button>
            <Button
              variant="primary"
              disabled={!devicesValid || importDevices.isPending}
              onClick={() => importDevices.mutate()}
            >
              {importDevices.isPending
                ? "Importing…"
                : `Register ${devices.length} Device(s)`}
            </Button>
          </div>
        </Panel>
      ) : null}

      {step === 3 ? (
        <Panel
          title="4 · Bindings, then commission"
          subtitle="A Device decodes nothing until its Tags are bound."
        >
          <p className="max-w-2xl text-xs leading-relaxed text-ink-muted">
            {createdDevices.length} Device(s) are registered. Each needs its Tag
            bindings set before its Readings decode — that is done on the Device
            Bindings screen, where the current binding sits beside what is
            actually arriving.
          </p>
          <div className="mt-2 flex flex-wrap gap-1">
            {createdDevices.map((device) => (
              <Badge key={device.id} tone="neutral">
                {device.code}
              </Badge>
            ))}
          </div>

          {/*
            The readiness panel, not two unguarded buttons. Activating publishes
            this Plant into every Portfolio total the Client sees, and a
            half-mapped Plant dragging fleet PR down is the exact failure the
            status exists to prevent.
          */}
          <div className="mt-4">
            <CommissioningPanel plantId={plantId} />
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              disabled={setStatus.isPending}
              onClick={() => setStatus.mutate({ status: "commissioning" })}
            >
              Move to commissioning
            </Button>
            <Button
              variant="primary"
              disabled={setStatus.isPending}
              onClick={() => setStatus.mutate({ status: "active" })}
              title="Only an active Plant is counted in portfolio totals."
            >
              Activate
            </Button>
          </div>
          <p className="mt-2 text-[11px] text-ink-faint">
            A Plant stays out of every portfolio total until it is active, so
            activate it only once its Devices are bound and reporting. Activation
            is refused while blocking issues remain — override deliberately from
            the panel above if you know something the checks do not.
          </p>

          {/*
            Without this the wizard had no exit: finishing one Plant left every
            field populated and `plantId` pointing at the Plant just created, so
            the only way to start another was a page reload.
          */}
          <div className="mt-4 border-t border-line pt-3">
            <Button
              onClick={() => {
                resetWizard();
                setMessage("Ready for another Plant.");
              }}
            >
              Onboard another Plant
            </Button>
            {isPlatformAdmin ? (
              <Button
                className="ml-2"
                onClick={() => {
                  resetWizard();
                  setChangingClient(true);
                  setMessage(null);
                }}
              >
                Onboard a different Client
              </Button>
            ) : null}
          </div>
        </Panel>
      ) : null}
    </div>
  );
}
