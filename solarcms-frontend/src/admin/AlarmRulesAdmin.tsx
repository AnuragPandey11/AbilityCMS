/**
 * Alarm Rules (§7.3).
 *
 * ⚠ Platform defaults (`client_id: null`) are **read-only** to a Client. They
 * are rendered distinctly and editing is disabled; to change one, a Client
 * creates its own rule with the same code at the same scope or narrower. Scope
 * decides first (device → plant → device_type → client → global) and at the
 * same scope the Client's own rule wins. The backend enforces this — an UPDATE
 * against a default returns 404 rather than editing every Client's inherited
 * rule. Each row states its standing (`ruleStanding.ts`), because a rule at a
 * wider scope than the default it meant to replace is stored without error and
 * never wins.
 *
 * A platform administrator sees every Client's rules and must choose the owner
 * of a new one: a Client, or a platform default that every Client inherits.
 * Leaving that to the session is how a rule meant for one Client used to reach
 * all of them.
 *
 * ⚠ Rules with operator `is_true` / `is_false` carry **no threshold** — the
 * contact is the condition. The threshold fields are hidden entirely, not shown
 * disabled: a disabled input implies a value belongs there.
 *
 * The related backend rule, worth knowing while writing one: a threshold rule
 * against a Device Type that publishes only Digital Inputs is meaningless.
 * `TRANSFORMER` and `VCB` have no analogue value to compare, so they use
 * `is_true`/`is_false`.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAlarmRules, useDeviceTypes, useTags } from "@/api/hooks";
import { qk } from "@/api/queryKeys";
import * as alarmsApi from "@/api/endpoints/alarms";
import * as clientsApi from "@/api/endpoints/clients";
import type { AlarmRule } from "@/api/schemas";
import { OPERATORS, operatorNeedsThreshold } from "@/api/schemas";
import { isApiError } from "@/api/problem";
import { Button, Field, Panel, Badge, inputClass } from "@/components/ui";
import { ErrorState, ForbiddenState, LoadingState } from "@/components/state";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { SeverityBadge } from "@/components/domain";
import { formatNumber } from "@/format/value";
import { usePermission } from "@/auth/usePermission";
import { useAuth } from "@/auth/AuthProvider";
import { scopeLabel, standingOf, type Standing } from "./ruleStanding";

const DIGITAL_ONLY_TYPES = new Set(["TRANSFORMER", "VCB"]);

/** The owner select's value for a platform default; a Client is its id. */
const PLATFORM_OWNER = "platform";

function StandingNote({ standing }: { standing: Standing }): JSX.Element {
  return (
    <span
      className={`mt-0.5 block text-[11px] leading-snug ${
        standing.tone === "warn" ? "text-warn" : "text-ink-muted"
      }`}
    >
      {standing.text}
    </span>
  );
}

export function AlarmRulesAdmin(): JSX.Element {
  const canConfigure = usePermission("config.modify");
  const queryClient = useQueryClient();
  const rulesQuery = useAlarmRules(canConfigure);
  const tagsQuery = useTags();
  const typesQuery = useDeviceTypes();
  const { me } = useAuth();
  const isPlatformAdmin = me?.platform_admin ?? false;
  const clientsQuery = useQuery({
    queryKey: qk.clients(),
    queryFn: clientsApi.listClients,
    enabled: canConfigure && isPlatformAdmin,
    retry: false,
  });

  const [editing, setEditing] = useState<AlarmRule | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState({
    code: "",
    name: "",
    scope_type: "global",
    scope_id: "",
    tag_code: "",
    operator: "gt",
    threshold: "",
    threshold_high: "",
    clear_threshold: "",
    duration_s: "60",
    severity: "medium",
    classification: "",
    enabled: true,
    // Chosen, never inferred: "" until a platform administrator picks one.
    owner: me?.client_id != null ? String(me.client_id) : "",
  });

  const reset = () => {
    setEditing(null);
    setCreating(false);
    setError(null);
  };

  const body = () => ({
    code: form.code,
    name: form.name,
    scope_type: form.scope_type,
    scope_id: form.scope_id ? Number(form.scope_id) : null,
    tag_code: form.tag_code || null,
    operator: form.operator,
    // Omitted entirely for a boolean operator — the contact is the condition.
    threshold: needsThreshold && form.threshold ? Number(form.threshold) : null,
    threshold_high:
      needsThreshold && form.threshold_high
        ? Number(form.threshold_high)
        : null,
    clear_threshold:
      needsThreshold && form.clear_threshold
        ? Number(form.clear_threshold)
        : null,
    duration_s: Number(form.duration_s),
    severity: form.severity,
    classification: form.classification || null,
    enabled: form.enabled,
    // Sent only by a platform administrator; the server ignores it otherwise.
    ...(isPlatformAdmin && form.owner
      ? { client_id: form.owner === PLATFORM_OWNER ? null : Number(form.owner) }
      : {}),
  });

  const save = useMutation({
    mutationFn: () =>
      editing
        ? alarmsApi.updateAlarmRule(editing.id, body())
        : alarmsApi.createAlarmRule(body()),
    onSuccess: () => {
      reset();
      void queryClient.invalidateQueries({ queryKey: ["alarm-rules"] });
    },
    onError: (err) =>
      setError(
        isApiError(err) ? err.displayMessage : "Could not save the rule.",
      ),
  });

  if (!canConfigure) {
    return (
      <ForbiddenState detail="Alarm Rules require the config.modify permission." />
    );
  }
  if (rulesQuery.isLoading) return <LoadingState label="Loading rules" />;
  if (rulesQuery.isError) {
    return (
      <ErrorState
        error={rulesQuery.error}
        retry={() => void rulesQuery.refetch()}
      />
    );
  }

  const needsThreshold = operatorNeedsThreshold(form.operator);
  const rules = rulesQuery.data ?? [];
  const scopedType = typesQuery.data?.find(
    (type) =>
      form.scope_type === "device_type" && String(type.id) === form.scope_id,
  );
  const digitalOnlyWarning =
    scopedType && DIGITAL_ONLY_TYPES.has(scopedType.code) && needsThreshold;

  const clients = clientsQuery.data ?? [];
  // Who the rule being written will belong to: undefined until chosen.
  const draftOwner: number | null | undefined = editing
    ? editing.client_id
    : !isPlatformAdmin
      ? (me?.client_id ?? undefined)
      : form.owner === PLATFORM_OWNER
        ? null
        : form.owner
          ? Number(form.owner)
          : undefined;
  const draftStanding =
    form.code && draftOwner !== undefined
      ? standingOf(
          {
            id: editing?.id ?? -1,
            client_id: draftOwner,
            client_code:
              draftOwner === null
                ? null
                : (clients.find((client) => client.id === draftOwner)?.code ??
                  me?.client_code ??
                  null),
            code: form.code,
            scope_type: form.scope_type,
            scope_id: form.scope_id ? Number(form.scope_id) : null,
            scope_code: scopedType?.code ?? null,
          },
          rules,
        )
      : null;

  const beginEdit = (rule: AlarmRule) => {
    setEditing(rule);
    setCreating(false);
    setError(null);
    setForm({
      code: rule.code,
      name: rule.name,
      scope_type: rule.scope_type,
      scope_id: rule.scope_id === null ? "" : String(rule.scope_id),
      tag_code: rule.tag_code ?? "",
      operator: rule.operator,
      threshold: rule.threshold === null ? "" : String(rule.threshold),
      threshold_high:
        rule.threshold_high === null ? "" : String(rule.threshold_high),
      clear_threshold:
        rule.clear_threshold === null ? "" : String(rule.clear_threshold),
      duration_s: String(rule.duration_s),
      severity: rule.severity,
      classification: "",
      enabled: rule.enabled,
      owner: rule.client_id === null ? PLATFORM_OWNER : String(rule.client_id),
    });
  };

  const columns: Column<AlarmRule>[] = [
    {
      key: "code",
      header: "Rule",
      render: (rule) => {
        const standing = standingOf(rule, rules);
        return (
          <span
            className={rule.client_id === null ? "text-ink-muted" : "text-ink"}
          >
            <span className="font-medium">{rule.code}</span>
            <span className="ml-2">{rule.name}</span>
            {standing ? <StandingNote standing={standing} /> : null}
          </span>
        );
      },
      sortValue: (rule) => rule.code,
      filterValue: (rule) => `${rule.code} ${rule.name}`,
    },
    {
      key: "owner",
      header: "Owner",
      width: "150px",
      render: (rule) =>
        rule.client_id === null ? (
          <Badge
            tone="neutral"
            title="A platform default, inherited by every Client and read-only here. To change it, create a rule with the same code at the same scope or narrower — at the same scope the Client's own rule wins."
          >
            platform default
          </Badge>
        ) : (
          <Badge tone="accent">{rule.client_code ?? "this Client"}</Badge>
        ),
      sortValue: (rule) => rule.client_code ?? "",
      filterValue: (rule) => rule.client_code ?? "platform default",
    },
    {
      key: "scope",
      header: "Scope",
      width: "170px",
      render: (rule) => (
        <span className="text-ink-muted">{scopeLabel(rule)}</span>
      ),
      sortValue: (rule) => rule.scope_type,
      filterValue: (rule) => scopeLabel(rule),
    },
    {
      key: "condition",
      header: "Condition",
      render: (rule) => (
        <span className="font-mono text-xs">
          {rule.tag_code ?? "—"} {rule.operator}
          {/* A boolean operator has no threshold to show. */}
          {operatorNeedsThreshold(rule.operator)
            ? ` ${formatNumber(rule.threshold)}${
                rule.threshold_high !== null
                  ? `..${formatNumber(rule.threshold_high)}`
                  : ""
              }`
            : ""}
          <span className="ml-2 text-ink-faint">for {rule.duration_s}s</span>
        </span>
      ),
      filterValue: (rule) => `${rule.tag_code ?? ""} ${rule.operator}`,
    },
    {
      key: "severity",
      header: "Severity",
      width: "100px",
      render: (rule) => <SeverityBadge severity={rule.severity} />,
      sortValue: (rule) => rule.severity,
    },
    {
      key: "enabled",
      header: "Enabled",
      width: "90px",
      render: (rule) =>
        rule.enabled ? (
          <Badge tone="ok">on</Badge>
        ) : (
          <Badge tone="neutral">off</Badge>
        ),
      sortValue: (rule) => String(rule.enabled),
    },
    {
      key: "edit",
      header: "",
      width: "80px",
      render: (rule) =>
        rule.client_id === null ? (
          <span
            className="text-[11px] text-ink-faint"
            title={
              isPlatformAdmin
                ? "Platform defaults are seeded from domain/assumptions.py, and `cli seed` rewrites them — an edit made here would be undone. Change the file and re-seed."
                : "Platform defaults are read-only. Create your own rule with the same code at the same scope or narrower to replace one."
            }
          >
            read-only
          </span>
        ) : (
          <Button variant="ghost" onClick={() => beginEdit(rule)}>
            Edit
          </Button>
        ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="page-title">Alarm Rules</h1>
          <p className="mt-1.5 text-sm text-ink-muted">
            For each code, the narrowest rule wins: device → plant → device
            type → client → global. At the same scope, a Client's own rule beats
            the platform default.
          </p>
        </div>
        <Button
          variant="primary"
          onClick={() => {
            reset();
            setCreating(true);
          }}
        >
          New rule
        </Button>
      </div>

      {creating || editing ? (
        <Panel
          title={editing ? `Edit ${editing.code}` : "New rule"}
          subtitle={
            editing
              ? `Editing a rule owned by ${editing.client_code ?? "this Client"}.`
              : isPlatformAdmin
                ? "Choose who owns it: one Client, or a platform default every Client inherits."
                : `Created under ${me?.client_code ?? "this Client"}, for its Devices only.`
          }
          actions={
            <Button variant="ghost" onClick={reset}>
              Cancel
            </Button>
          }
        >
          <div className="grid max-w-4xl grid-cols-2 gap-3 lg:grid-cols-3">
            {isPlatformAdmin && !editing ? (
              <Field
                label="Owner"
                required
                hint="A platform default reaches every Client; a Client's rule reaches only its Devices."
              >
                <select
                  value={form.owner}
                  onChange={(event) =>
                    setForm({ ...form, owner: event.target.value })
                  }
                  className={inputClass}
                >
                  <option value="">Choose…</option>
                  <option value={PLATFORM_OWNER}>
                    Platform default (every Client)
                  </option>
                  {clients.map((client) => (
                    <option key={client.id} value={client.id}>
                      {client.code} — {client.name}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
            <Field label="Code" required>
              <input
                value={form.code}
                disabled={editing !== null}
                onChange={(event) =>
                  setForm({ ...form, code: event.target.value })
                }
                className={inputClass}
              />
            </Field>
            <Field label="Name" required>
              <input
                value={form.name}
                onChange={(event) =>
                  setForm({ ...form, name: event.target.value })
                }
                className={inputClass}
              />
            </Field>
            <Field label="Scope">
              <select
                value={form.scope_type}
                onChange={(event) =>
                  setForm({ ...form, scope_type: event.target.value })
                }
                className={inputClass}
              >
                <option value="global">global</option>
                <option value="device_type">device_type</option>
                <option value="plant">plant</option>
                <option value="device">device</option>
              </select>
            </Field>
            {form.scope_type === "device_type" ? (
              <Field label="Device Type">
                <select
                  value={form.scope_id}
                  onChange={(event) =>
                    setForm({ ...form, scope_id: event.target.value })
                  }
                  className={inputClass}
                >
                  <option value="">Choose…</option>
                  {(typesQuery.data ?? []).map((type) => (
                    <option key={type.id} value={type.id}>
                      {type.code}
                    </option>
                  ))}
                </select>
              </Field>
            ) : form.scope_type !== "global" ? (
              <Field label="Scope id">
                <input
                  type="number"
                  value={form.scope_id}
                  onChange={(event) =>
                    setForm({ ...form, scope_id: event.target.value })
                  }
                  className={inputClass}
                />
              </Field>
            ) : null}

            <Field label="Tag">
              <select
                value={form.tag_code}
                onChange={(event) =>
                  setForm({ ...form, tag_code: event.target.value })
                }
                className={inputClass}
              >
                <option value="">None</option>
                {(tagsQuery.data ?? []).map((tag) => (
                  <option key={tag.id} value={tag.code}>
                    {tag.code} ({tag.unit})
                    {tag.category === "status" ? " — digital" : ""}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label="Operator"
              hint="is_true / is_false compare a contact and take no threshold."
            >
              <select
                value={form.operator}
                onChange={(event) =>
                  setForm({ ...form, operator: event.target.value })
                }
                className={inputClass}
              >
                {OPERATORS.map((operator) => (
                  <option key={operator} value={operator}>
                    {operator}
                  </option>
                ))}
              </select>
            </Field>

            {/* Hidden entirely for boolean operators — not shown disabled. */}
            {needsThreshold ? (
              <>
                <Field label="Threshold">
                  <input
                    type="number"
                    value={form.threshold}
                    onChange={(event) =>
                      setForm({ ...form, threshold: event.target.value })
                    }
                    className={inputClass}
                  />
                </Field>
                <Field label="Threshold high" hint="For range operators.">
                  <input
                    type="number"
                    value={form.threshold_high}
                    onChange={(event) =>
                      setForm({ ...form, threshold_high: event.target.value })
                    }
                    className={inputClass}
                  />
                </Field>
                <Field
                  label="Clear threshold"
                  hint="Hysteresis: the value the condition must cross back over to clear."
                >
                  <input
                    type="number"
                    value={form.clear_threshold}
                    onChange={(event) =>
                      setForm({ ...form, clear_threshold: event.target.value })
                    }
                    className={inputClass}
                  />
                </Field>
              </>
            ) : (
              <div className="col-span-2 self-end rounded border border-line bg-surface px-3 py-2 text-[11px] leading-snug text-ink-muted">
                This operator takes no threshold — the contact is the condition.
              </div>
            )}

            <Field
              label="Duration (s)"
              hint="Debounce. Detection latency is the Tag's min_interval_s plus this."
            >
              <input
                type="number"
                value={form.duration_s}
                onChange={(event) =>
                  setForm({ ...form, duration_s: event.target.value })
                }
                className={inputClass}
              />
            </Field>
            <Field label="Severity">
              <select
                value={form.severity}
                onChange={(event) =>
                  setForm({ ...form, severity: event.target.value })
                }
                className={inputClass}
              >
                {["critical", "high", "medium", "low"].map((severity) => (
                  <option key={severity} value={severity}>
                    {severity}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Classification"
              hint="communication or equipment — kept separate."
            >
              <select
                value={form.classification}
                onChange={(event) =>
                  setForm({ ...form, classification: event.target.value })
                }
                className={inputClass}
              >
                <option value="">unset</option>
                <option value="communication">communication</option>
                <option value="equipment">equipment</option>
              </select>
            </Field>
            <label className="flex items-end gap-2 text-xs text-ink">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(event) =>
                  setForm({ ...form, enabled: event.target.checked })
                }
              />
              Enabled
            </label>
          </div>

          {digitalOnlyWarning ? (
            <div className="mt-3 rounded border border-warn/30 bg-warn/10 px-3 py-2 text-[11px] leading-relaxed text-ink-muted">
              <strong className="text-warn">
                {scopedType?.code} publishes only Digital Inputs.
              </strong>{" "}
              There is no analogue value to compare against a threshold — use{" "}
              <span className="font-mono">is_true</span> or{" "}
              <span className="font-mono">is_false</span> instead.
            </div>
          ) : null}

          {draftStanding ? (
            <div
              className={`mt-3 rounded border px-3 py-2 text-[11px] leading-relaxed ${
                draftStanding.tone === "warn"
                  ? "border-warn/30 bg-warn/10 text-ink"
                  : "border-line bg-surface text-ink-muted"
              }`}
            >
              {draftStanding.text}
            </div>
          ) : null}

          {error ? (
            <p className="mt-3 rounded border border-bad/30 bg-bad/10 px-3 py-2 text-xs text-bad">
              {error}
            </p>
          ) : null}

          <Button
            variant="primary"
            className="mt-4"
            disabled={
              !form.code ||
              !form.name ||
              (isPlatformAdmin && !editing && !form.owner) ||
              save.isPending
            }
            onClick={() => save.mutate()}
          >
            {save.isPending
              ? "Saving…"
              : editing
                ? "Save changes"
                : "Create rule"}
          </Button>
        </Panel>
      ) : null}

      <Panel title={`${rules.length} rule(s)`}>
        <DataTable
          rows={rules}
          columns={columns}
          rowKey={(rule) => rule.id}
          filterPlaceholder="Filter rules…"
        />
      </Panel>
    </div>
  );
}
