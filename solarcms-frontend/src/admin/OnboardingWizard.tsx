/**
 * The onboarding wizard (§7.1), mirroring MASTER §6.5:
 * Client → Plant (`draft`) → Blocks *(optional)* → Devices → bindings →
 * `commissioning` → `active`.
 *
 * ⚠ **The Client is a step, not a mode.** Every Plant belongs to exactly one
 * Client — `plants.client_id` is NOT NULL — so the wizard asks which one
 * before it asks anything else, and the answer is visible in the header for
 * the rest of the flow. A Client Admin sees their own Client and confirms it;
 * a Super Admin picks one or creates one.
 *
 * This replaced a worse arrangement worth naming, because the shape of it
 * recurs: the Client used to be chosen by **switching the session into it**,
 * since the API took `client_id` from the token alone. That made the choice a
 * one-way door (the picker never rendered again once a session had a Client),
 * it cleared every cached query as a side effect of answering a form field,
 * and worst of all it made the Plant land under whichever Client the session
 * happened to be in rather than the one the operator named. The Client now
 * travels in the request, where it belongs, and the session is left alone.
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

import { useEffect, useState } from "react";
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
  { key: "client", label: "Client" },
  { key: "plant", label: "Plant" },
  { key: "blocks", label: "Blocks (optional)" },
  { key: "devices", label: "Devices" },
  { key: "commission", label: "Commission" },
] as const;

/** Step indices, named. Off-by-one in a five-step wizard is invisible. */
const STEP_CLIENT = 0;
const STEP_PLANT = 1;
const STEP_BLOCKS = 2;
const STEP_DEVICES = 3;
const STEP_COMMISSION = 4;

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
  /**
   * The enclosure this Device sits in — an MCR, an ICR, a panel.
   *
   * A *name*, not a row in the Device list beside it, because a Collector is
   * not a Device: it publishes nothing and carries no current, and the diagram
   * draws it as a box around its Devices rather than as one of them. Left
   * empty for equipment that sits in no enclosure, which is normal.
   */
  collector_code: string;
  block_index: number | null;
}

/**
 * The Collector segment of a canonical topic, if it has one.
 *
 * `scms/v1/{client}/{plant}/{collector}/{device}` is six segments and
 * `scms/v1/{client}/{plant}/{device}` is five, so counting them is the whole
 * test — and it is why the five-segment shape needed its own registry row
 * rather than an optional segment.
 *
 * ⚠ A suggestion for an empty form field and nothing more. At runtime the
 * topic is matched against the registry in `topic_patterns`, which is data; a
 * parser in the browser must never become a second, quietly diverging
 * definition of what a topic means (Guardrail 5).
 */
function collectorFromTopic(topic: string): string | null {
  const segments = topic.trim().split("/");
  if (segments.length !== 6) return null;
  const collector = segments[4]?.trim();
  return collector ? collector : null;
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
  collector_code: "",
  block_index: null,
});

export function OnboardingWizard(): JSX.Element {
  const canManage = usePermission("plant.manage");
  const isPlatformAdmin = usePermission("system.admin");
  const { me } = useAuth();
  const queryClient = useQueryClient();
  const modelsQuery = useDeviceModels();
  const typesQuery = useDeviceTypes();

  // A Client Admin's Client comes from their session and is not theirs to
  // change (I-9) — the API ignores any client_id they send. A Super Admin
  // belongs to no Client and must name one, which is why this is a step.
  const sessionClientId = me?.client_id ?? null;

  const clientsQuery = useQuery({
    queryKey: qk.clients(),
    queryFn: clientsApi.listClients,
    enabled: isPlatformAdmin,
    retry: false,
  });

  /**
   * Which Client this Plant will belong to.
   *
   * Seeded from the session for a Client Admin, who has exactly one and cannot
   * choose another. Null for a Super Admin until they pick — and the Plant
   * step is unreachable until they do, because there is no such thing as an
   * unfiled Plant.
   */
  const [clientId, setClientId] = useState<number | null>(sessionClientId);

  // `me` can arrive after the first render, and a Client Admin's Client comes
  // from it. Without this they land on the Client step with nothing selected
  // and no way to select anything — the list is Super-Admin-only.
  useEffect(() => {
    if (sessionClientId !== null) setClientId((current) => current ?? sessionClientId);
  }, [sessionClientId]);

  const [step, setStep] = useState(0);
  // The furthest step reached. `step` alone cannot drive the tabs: stepping back
  // to 1 would lower it and strand the work done at 3 with no way forward.
  const [maxStep, setMaxStep] = useState(0);
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
    if (!stepReachable(index)) return;
    setError(null);
    setStep(index);
  };

  /**
   * Which steps can be opened.
   *
   * Two gates, not one, because two different things have to exist. The Plant
   * step needs a Client — a Plant with no Client cannot be created and the
   * form would be a dead end. Every step past it needs the Plant itself: they
   * all act on a Plant id, and a stale `maxStep` after a reset would otherwise
   * point step 4 at nothing.
   */
  function stepReachable(index: number): boolean {
    if (index > maxStep) return false;
    if (index >= STEP_PLANT && clientId === null) return false;
    if (index > STEP_PLANT && plantId === null) return false;
    return true;
  }

  /**
   * Clear everything belonging to one Plant.
   *
   * Called when switching Client as well as when starting a second Plant —
   * `plantId` and the created Devices belong to the Client that was active when
   * they were made, and carrying them into a different Client would point the
   * later steps at another Client\u2019s Plant.
   */
  const resetWizard = (): void => {
    setStep(STEP_PLANT);
    setMaxStep(STEP_PLANT);
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
    setBlocks([]);
    setDevices([emptyDevice()]);
    setCreatedDevices([]);
    setError(null);
  };

  /**
   * Choose the Client and move on to the Plant.
   *
   * Nothing about the session changes — no token is re-issued and no cache is
   * cleared. The Client is a field on the next request, so picking a different
   * one only has to discard the Plant draft that was being written for the
   * previous one.
   */
  const chooseClient = (id: number, label: string): void => {
    setError(null);
    if (id !== clientId) resetWizard();
    setClientId(id);
    setMessage(`Onboarding a Plant for ${label}.`);
    setStep(STEP_PLANT);
    setMaxStep((previous) => Math.max(previous, STEP_PLANT));
  };

  const createPlant = useMutation({
    mutationFn: () =>
      plantsApi.createPlant({
        code: plant.code,
        name: plant.name,
        // Named in the request rather than taken from the session. A Client
        // Admin's copy is ignored by the API in favour of their own Client,
        // which is what stops one Client filing a Plant under another (I-9).
        client_id: clientId,
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
      }),
    onSuccess: (created) => {
      setPlantId(created.id);
      setError(null);
      setMessage(`Plant created in draft (id ${created.id}).`);
      advanceTo(STEP_BLOCKS);
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
      advanceTo(STEP_DEVICES);
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
        // A name, sent as typed. Empty means "in no enclosure", which is a
        // real answer — the five-segment topic shape has no collector at all.
        collector_code: device.collector_code.trim() || null,
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

      // ⚠ No second pass any more. Registration used to PATCH each Device
      // afterwards to apply "feeds into" and "reports via" chosen on the form;
      // neither is asked for now, so there is nothing to apply and the
      // all-or-nothing create stands on its own.
      return result;
    },
    onSuccess: (result) => {
      setCreatedDevices(result.devices);
      setError(null);
      setMessage(
        `${result.created} Device(s) registered. Wire them up in Plant ` +
          `Hierarchy, where the diagram is beside you as you do it.`,
      );
      advanceTo(STEP_COMMISSION);
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

  const chosenClient =
    clientsQuery.data?.find((entry) => entry.id === clientId) ?? null;
  // The Clients list is Super-Admin-only, so a Client Admin's label comes from
  // their own `/auth/me` instead. Falling through to "Client #2" told someone
  // their company's id and nothing else.
  const clientLabel = chosenClient
    ? `${chosenClient.code} · ${chosenClient.name}`
    : clientId !== null && clientId === sessionClientId && me?.client_name
      ? `${me.client_code ?? ""} · ${me.client_name}`.replace(/^ · /, "")
      : clientId !== null
        ? `Client #${clientId}`
        : "no Client chosen";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink">Plant onboarding</h1>
          <p className="text-xs text-ink-muted">
            A Client, then a Plant in <span className="font-mono">draft</span>,
            populated, then commissioned and activated.
          </p>
        </div>
        {/* Which Client this Plant is being filed under, visible from every
            step. Six screens later "whose Plant is this" must not need a
            scroll back to step one. */}
        {clientId !== null ? (
          <div className="flex shrink-0 items-center gap-2 rounded-control border border-line bg-surface-raised px-2.5 py-1.5">
            <span className="text-[11px] uppercase tracking-wide text-ink-faint">
              Client
            </span>
            <span className="text-xs font-medium text-ink">{clientLabel}</span>
            {isPlatformAdmin ? (
              <button
                type="button"
                onClick={() => {
                  setMessage(null);
                  setStep(STEP_CLIENT);
                }}
                className="text-[11px] text-accent hover:underline"
                title="Choose a different Client. The Plant draft is cleared, because a draft belongs to the Client it was started for."
              >
                change
              </button>
            ) : null}
          </div>
        ) : null}
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

      {step === STEP_CLIENT ? (
        <Panel
          title="1 · Client"
          subtitle="Every Plant belongs to exactly one Client. Choose it before the Plant exists, so it can never be filed under the wrong one."
        >
          {!isPlatformAdmin ? (
            // A Client Admin has exactly one Client and the API ignores any
            // other they might send. So this confirms rather than asks — but
            // it still appears, because "which Client is this Plant for" is
            // worth stating once rather than assuming.
            sessionClientId === null ? (
              <p className="max-w-2xl text-xs text-ink-muted">
                Your account has no Client membership, so there is no Client to
                create a Plant under. Ask a Super Admin to add you to one.
              </p>
            ) : (
              <div className="max-w-2xl space-y-3">
                <div className="rounded border border-line bg-surface px-3 py-2">
                  <p className="text-sm text-ink">{clientLabel}</p>
                  <p className="mt-0.5 text-xs text-ink-muted">
                    Your Client. A Plant you create belongs to it, and to no
                    other — that is enforced by the server, not by this form.
                  </p>
                </div>
                <Button
                  variant="primary"
                  onClick={() => chooseClient(sessionClientId, clientLabel)}
                >
                  Continue to the Plant
                </Button>
              </div>
            )
          ) : clientsQuery.isPending ? (
            <LoadingState />
          ) : clientsQuery.isError ? (
            <ErrorState
              error={clientsQuery.error}
              retry={() => void clientsQuery.refetch()}
            />
          ) : (
            <div className="max-w-2xl space-y-5">
              {clientsQuery.data.length > 0 ? (
                <div>
                  <h3 className="mb-1 text-sm font-medium text-ink">
                    Existing Client
                  </h3>
                  <p className="mb-2 text-xs text-ink-muted">
                    A Client can have any number of Plants. Choosing one here
                    does not change your session — nothing else you have open
                    is affected.
                  </p>
                  <ul className="space-y-1">
                    {clientsQuery.data.map((client) => (
                      <li key={client.id}>
                        <button
                          type="button"
                          onClick={() =>
                            chooseClient(
                              client.id,
                              `${client.code} · ${client.name}`,
                            )
                          }
                          className={`flex w-full items-center justify-between gap-3 rounded border px-3 py-2 text-left transition ${
                            client.id === clientId
                              ? "border-accent bg-accent/10"
                              : "border-line bg-surface hover:border-line-strong"
                          }`}
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-sm text-ink">
                              {client.name}
                            </span>
                            <span className="block truncate font-mono text-[11px] text-ink-muted">
                              {client.code}
                            </span>
                          </span>
                          <span className="flex shrink-0 items-center gap-1.5">
                            {client.is_demo ? (
                              <Badge tone="warn" title="A demonstration Client — Guests may reach it.">
                                demo
                              </Badge>
                            ) : null}
                            <Badge tone={client.id === clientId ? "accent" : "neutral"}>
                              {client.id === clientId ? "chosen" : client.status}
                            </Badge>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-xs text-ink-muted">
                  No Clients exist yet. Create the first one below — a Plant
                  cannot be created without one.
                </p>
              )}

              <div className="border-t border-line pt-4">
                <h3 className="mb-1 text-sm font-medium text-ink">New Client</h3>
                <p className="mb-3 text-xs text-ink-muted">
                  Create the Client, then continue straight into its first Plant.
                </p>
                <NewClientForm
                  submitLabel="Create Client and continue"
                  onCreated={(client) => {
                    setError(null);
                    void queryClient.invalidateQueries({ queryKey: qk.clients() });
                    chooseClient(client.id, `${client.code} · ${client.name}`);
                  }}
                />
              </div>
            </div>
          )}
        </Panel>
      ) : null}

      {step === STEP_PLANT ? (
        <Panel
          title="2 · Plant"
          subtitle={`Created in draft for ${clientLabel}, and excluded from portfolio totals until it is active.`}
          actions={
            <Button onClick={() => setStep(STEP_CLIENT)}>Back</Button>
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
            ⚠ The "planned Device counts" input was removed on 19 Sep 2026.

            It asked, at the moment a Plant was created, how many Devices of
            each Type it was *meant* to have — a figure typed from a contract
            before a single Device existed, which began drifting from reality
            the moment anyone registered one. Nothing downstream depended on it
            being right, so nothing ever caught it being wrong.

            The count that matters is the count of Devices that actually exist,
            and that needs no input at all: it is `count(*)` on `devices`, shown
            on the Plant Setup screen where Devices are registered. The table
            and the API field remain, unused, so no history is destroyed.
          */}

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

      {step === STEP_BLOCKS ? (
        <Panel
          title="3 · Blocks"
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
            <Button onClick={() => advanceTo(STEP_DEVICES)}>
              {blocks.length === 0
                ? "Continue without Blocks"
                : "Skip remaining"}
            </Button>
          </div>
        </Panel>
      ) : null}

      {step === STEP_DEVICES ? (
        <Panel
          title="4 · Devices"
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

          {/* Every enclosure already named on this form, offered to the next
              row. Two Devices in the same room must end up with the same
              spelling, or the diagram draws two boxes that look like one. */}
          <datalist id="wizard-collector-codes">
            {[...new Set(devices.map((d) => d.collector_code.trim()))]
              .filter((code) => code !== "")
              .sort((a, b) => a.localeCompare(b))
              .map((code) => (
                <option key={code} value={code} />
              ))}
          </datalist>

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
                  hint="scms/v1/{client}/{plant}/{collector}/{device}, or scms/v1/{client}/{plant}/{device} where there is no collector. The sole authority for origin."
                >
                  <input
                    value={device.source_address}
                    onChange={(event) => {
                      const topic = event.target.value;
                      updateDevice(index, {
                        source_address: topic,
                        // Read out of the topic the operator just typed, but
                        // only to fill an empty box. The topic is the sole
                        // authority for origin, so it is the best guess
                        // available — and overwriting a name they typed by
                        // hand would make the field feel possessed.
                        ...(device.collector_code.trim() === ""
                          ? { collector_code: collectorFromTopic(topic) ?? "" }
                          : {}),
                      });
                    }}
                    className={`${inputClass} font-mono text-xs`}
                  />
                </Field>
                <Field
                  label="Collector"
                  hint="The enclosure it sits in — an MCR, an ICR, a panel. Not a Device: nothing is wired through it, and the diagram draws it as a box around its Devices. Leave empty if it sits in none."
                >
                  <input
                    list="wizard-collector-codes"
                    value={device.collector_code}
                    placeholder="none"
                    onChange={(event) =>
                      updateDevice(index, {
                        collector_code: event.target.value,
                      })
                    }
                    className={inputClass}
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
                  ⚠ "Feeds into" and "Reports via" were removed from Device
                  registration on 19 Sep 2026, and their absence is deliberate.

                  Both are *discovered*, not designed. Which Collector transmits
                  a Device is already stated by its topic, and what a Device is
                  wired into is routinely corrected after the first day of real
                  data — so asking for either at the moment of registration
                  invites a guess, and a guess drawn into the Single Line
                  Diagram is indistinguishable from a fact.

                  Both are still first-class (MASTER §3.4); they are simply set
                  where they can be checked against something. The Collector
                  comes from the topic, and the wiring is set in Plant Hierarchy
                  beside the diagram it produces.
                */}
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

      {step === STEP_COMMISSION ? (
        <Panel
          title="5 · Bindings, then commission"
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
                setMessage(`Ready for another Plant for ${clientLabel}.`);
              }}
              title="Keep the same Client and start a second Plant for it. One Client can have any number."
            >
              Another Plant for this Client
            </Button>
            {isPlatformAdmin ? (
              <Button
                className="ml-2"
                onClick={() => {
                  resetWizard();
                  setStep(STEP_CLIENT);
                  setMaxStep(STEP_CLIENT);
                  setMessage(null);
                }}
              >
                A Plant for a different Client
              </Button>
            ) : null}
          </div>
        </Panel>
      ) : null}
    </div>
  );
}
