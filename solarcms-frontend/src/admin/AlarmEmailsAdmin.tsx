/**
 * Alarm Emails — who is emailed when an Alarm opens.
 *
 * A subscription is one person, one Plant or every Plant, and the lowest
 * severity they want: "medium" means medium, high and critical. Until this
 * screen a database administrator added each one as a row by hand.
 *
 * ⚠ **Nobody is emailed about a Plant they cannot see.** A Client Admin may be
 * subscribed to every Plant; anyone else only to Plants assigned to them under
 * Users, so the Plant list below offers exactly those. The server enforces it
 * on saving *and again when sending*, because access changes afterwards — so
 * each row shows the server's own verdict ("Sending", or "Not sent" with the
 * reason) rather than assuming a saved row reaches anybody.
 *
 * "Send test" goes through the real queue and mail server, and its outcome —
 * sent, or failed with the server's reason — appears under "Last email". That
 * is the check that a subscription actually reaches an inbox.
 */

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useReducedMotion } from "framer-motion";
import * as clientsApi from "@/api/endpoints/clients";
import * as api from "@/api/endpoints/notifications";
import type { Member, Subscription } from "@/api/endpoints/notifications";
import { qk } from "@/api/queryKeys";
import { isApiError } from "@/api/problem";
import { Badge, Button, Field, Panel, Reveal, inputClass } from "@/components/ui";
import { ErrorState, ForbiddenState, LoadingState } from "@/components/state";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { formatDateTime } from "@/format/datetime";
import { usePermission } from "@/auth/usePermission";
import { useAuth } from "@/auth/AuthProvider";

/** What each choice means, in the words the reader is deciding with. */
export const SEVERITY_CHOICES: { code: string; label: string }[] = [
  { code: "critical", label: "Critical only" },
  { code: "high", label: "High and critical" },
  { code: "medium", label: "Medium, high and critical" },
  { code: "low", label: "Every Alarm, low included" },
];

const EVERY_PLANT = "all";

function severityLabel(code: string): string {
  return SEVERITY_CHOICES.find((choice) => choice.code === code)?.label ?? code;
}

function personLabel(member: { email: string; full_name: string | null }): string {
  return member.full_name && member.full_name !== member.email
    ? `${member.full_name} (${member.email})`
    : member.email;
}

/** Long enough for a removed recipient to fade out before the list refreshes. */
const LEAVE_MS = 220;

export function AlarmEmailsAdmin(): JSX.Element {
  const canManage = usePermission("user.manage");
  const { me } = useAuth();
  const queryClient = useQueryClient();
  const isPlatformAdmin = me?.platform_admin === true;

  // A platform administrator belongs to no Client and chooses one here; a
  // Client Admin always manages their own, and never sends one.
  const [chosenClient, setChosenClient] = useState<number | "">("");
  const clientId = isPlatformAdmin ? (chosenClient === "" ? null : chosenClient) : null;
  const ready = canManage && (!isPlatformAdmin || clientId !== null);

  const clientsQuery = useQuery({
    queryKey: qk.clients(),
    queryFn: clientsApi.listClients,
    enabled: canManage && isPlatformAdmin,
  });
  const optionsQuery = useQuery({
    queryKey: qk.alarmEmailOptions(clientId),
    queryFn: () => api.subscriptionOptions(clientId),
    enabled: ready,
    retry: false,
  });
  const listQuery = useQuery({
    queryKey: qk.alarmEmails(clientId),
    queryFn: () => api.listSubscriptions(clientId),
    enabled: ready,
    retry: false,
  });

  const [adding, setAdding] = useState(false);
  const [userId, setUserId] = useState<number | "">("");
  const [plant, setPlant] = useState<string>("");
  const [severity, setSeverity] = useState("medium");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A test email is sent by the scheduler within seconds; look again twice so
  // its outcome appears without anyone pressing refresh.
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((id) => window.clearTimeout(id)), []);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["alarm-emails"] });
  const fail = (err: unknown, fallback: string) => {
    setMessage(null);
    setError(isApiError(err) ? err.displayMessage : fallback);
  };
  const done = (text: string) => {
    setError(null);
    setMessage(text);
    refresh();
  };

  // Recipients just removed, fading out before the list refreshes.
  const [leaving, setLeaving] = useState<ReadonlySet<number>>(new Set());
  const reduceMotion = useReducedMotion();

  const create = useMutation({
    mutationFn: () =>
      api.createSubscription({
        user_id: userId as number,
        plant_id: plant === EVERY_PLANT ? null : Number(plant),
        min_severity: severity,
        client_id: clientId,
      }),
    onSuccess: () => {
      setAdding(false);
      setUserId("");
      setPlant("");
      setSeverity("medium");
      done("Added. Use “Send test” to check the email arrives.");
    },
    onError: (err) => fail(err, "Could not add the subscription."),
  });
  const update = useMutation({
    mutationFn: (input: { id: number; body: { min_severity?: string; enabled?: boolean } }) =>
      api.updateSubscription(input.id, input.body),
    onSuccess: () => done("Saved."),
    onError: (err) => fail(err, "Could not save the change."),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.deleteSubscription(id),
    onSuccess: (_result, id) => {
      const removed = "Removed. They will no longer be emailed about these Alarms.";
      if (reduceMotion) {
        done(removed);
        return;
      }
      // The row fades out first, then the list refreshes without it.
      setLeaving((previous) => new Set(previous).add(id));
      window.setTimeout(() => done(removed), LEAVE_MS);
    },
    onError: (err) => fail(err, "Could not remove the subscription."),
  });
  const test = useMutation({
    mutationFn: (id: number) => api.sendTest(id),
    onSuccess: (result) => {
      done(
        `Test email queued to ${result.email}. Whether it was sent, or why not, appears under “Last email” within a few seconds.`,
      );
      timers.current.push(window.setTimeout(refresh, 4000), window.setTimeout(refresh, 12000));
    },
    onError: (err) => fail(err, "Could not send the test email."),
  });

  if (!canManage) {
    return <ForbiddenState detail="Managing Alarm emails requires the user.manage permission." />;
  }

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="max-w-2xl">
        <h1 className="page-title">Alarm Emails</h1>
        <p className="mt-1.5 text-sm text-ink-muted">
          Who is emailed when an Alarm opens. Each person is emailed only about Plants they can
          see: a Client Admin may receive every Plant, anyone else only the Plants assigned to
          them under Users.
        </p>
      </div>
      {ready && optionsQuery.data ? (
        <Button variant="primary" onClick={() => setAdding((previous) => !previous)}>
          {adding ? "Cancel" : "Add recipient"}
        </Button>
      ) : null}
    </div>
  );

  const clientPicker = isPlatformAdmin ? (
    <div className="max-w-sm">
      <Field label="Client" hint="You belong to no Client, so choose whose Alarm emails to manage.">
        <select
          value={chosenClient}
          onChange={(event) => {
            setChosenClient(event.target.value === "" ? "" : Number(event.target.value));
            setAdding(false);
            setMessage(null);
            setError(null);
          }}
          className={inputClass}
        >
          <option value="">Choose a Client…</option>
          {(clientsQuery.data ?? []).map((client) => (
            <option key={client.id} value={client.id}>
              {client.name} ({client.code})
            </option>
          ))}
        </select>
      </Field>
    </div>
  ) : null;

  if (!ready) {
    return (
      <div className="space-y-4">
        {header}
        {clientPicker}
      </div>
    );
  }
  if (optionsQuery.isLoading || listQuery.isLoading) {
    return (
      <div className="space-y-4">
        {header}
        {clientPicker}
        <LoadingState label="Loading Alarm emails" />
      </div>
    );
  }
  if (optionsQuery.isError || listQuery.isError) {
    return (
      <div className="space-y-4">
        {header}
        {clientPicker}
        <ErrorState
          error={optionsQuery.error ?? listQuery.error}
          retry={() => {
            void optionsQuery.refetch();
            void listQuery.refetch();
          }}
        />
      </div>
    );
  }

  const options = optionsQuery.data!;
  const rows = listQuery.data ?? [];
  const email = options.channels.find((channel) => channel.code === "email");
  const emailReady = email?.configured === true;
  const plantName = new Map(options.plants.map((p) => [p.id, `${p.code} — ${p.name}`]));
  const member: Member | undefined = options.members.find((m) => m.user_id === userId);
  // Exactly the Plants this person can see: never offer what the server refuses.
  const plantChoices = member
    ? member.sees_every_plant
      ? options.plants.map((p) => p.id)
      : member.plant_ids
    : [];

  const columns: Column<Subscription>[] = [
    {
      key: "person",
      header: "Person",
      render: (row) => (
        <span>
          <span className="font-medium">{row.full_name ?? row.email}</span>
          <span className="ml-2 text-ink-muted">{row.email}</span>
          {row.role_code ? (
            <span className="ml-2">
              <Badge tone="neutral">{row.role_code}</Badge>
            </span>
          ) : null}
        </span>
      ),
      sortValue: (row) => row.email,
      filterValue: (row) => `${row.email} ${row.full_name ?? ""} ${row.plant_code ?? ""}`,
    },
    {
      key: "plants",
      header: "Plants",
      width: "220px",
      render: (row) =>
        row.plant_id === null ? (
          <span>Every Plant</span>
        ) : (
          <span>{row.plant_code ? `${row.plant_code} — ${row.plant_name ?? ""}` : `Plant ${row.plant_id}`}</span>
        ),
      sortValue: (row) => row.plant_code ?? "",
    },
    {
      key: "severity",
      header: "Alarms",
      width: "220px",
      render: (row) => (
        <select
          aria-label={`Alarms emailed to ${row.email}`}
          value={row.min_severity}
          disabled={update.isPending}
          onChange={(event) =>
            update.mutate({ id: row.id, body: { min_severity: event.target.value } })
          }
          className={inputClass}
        >
          {SEVERITY_CHOICES.map((choice) => (
            <option key={choice.code} value={choice.code}>
              {choice.label}
            </option>
          ))}
        </select>
      ),
      sortValue: (row) => SEVERITY_CHOICES.findIndex((choice) => choice.code === row.min_severity),
    },
    {
      key: "status",
      header: "Status",
      width: "220px",
      render: (row) =>
        row.sending ? (
          <Badge tone="ok">Sending</Badge>
        ) : !row.enabled ? (
          <Badge tone="neutral">Paused</Badge>
        ) : (
          <span className="flex flex-col items-start gap-1">
            <Badge tone="warn">Not sent</Badge>
            <span className="text-[11px] leading-snug text-warn">{row.not_sent_reason}</span>
          </span>
        ),
      sortValue: (row) => (row.sending ? 0 : row.enabled ? 1 : 2),
    },
    {
      key: "last",
      header: "Last email",
      width: "220px",
      render: (row) => {
        const last = row.last_notification;
        if (!last) return <span className="text-ink-faint">none yet</span>;
        const tone = last.status === "failed" ? "bad" : last.status === "queued" ? "neutral" : "ok";
        return (
          <span className="flex flex-col items-start gap-1">
            <span className="flex items-center gap-2">
              <Badge tone={tone}>{last.status}</Badge>
              <span className="font-mono text-[11px] text-ink-muted">
                {last.at ? formatDateTime(last.at) : ""}
              </span>
            </span>
            {last.failure_reason ? (
              <span className="text-[11px] leading-snug text-bad">{last.failure_reason}</span>
            ) : null}
          </span>
        );
      },
    },
    {
      key: "actions",
      header: "",
      width: "230px",
      render: (row) => (
        <span className="flex justify-end gap-1">
          <Button
            variant="ghost"
            disabled={!row.sending || !emailReady || test.isPending}
            title={
              !emailReady
                ? (email?.reason ?? "Email is not configured on this server.")
                : row.sending
                  ? "Send one test email through the real mail server."
                  : (row.not_sent_reason ?? undefined)
            }
            onClick={() => test.mutate(row.id)}
          >
            Send test
          </Button>
          <Button
            variant="ghost"
            disabled={update.isPending}
            onClick={() => update.mutate({ id: row.id, body: { enabled: !row.enabled } })}
          >
            {row.enabled ? "Pause" : "Resume"}
          </Button>
          <Button
            variant="ghost"
            disabled={remove.isPending}
            onClick={() => remove.mutate(row.id)}
          >
            Remove
          </Button>
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      {header}
      {clientPicker}

      {!emailReady ? (
        <div className="rounded border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
          {email?.reason ?? "Email is not configured on this server."} Subscriptions can still be
          set up; they start sending once it is.
        </div>
      ) : null}
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

      <Reveal open={adding}>
        <Panel title="Add recipient" subtitle="Email only for now: nobody has a phone number on record for WhatsApp or SMS.">
          <div className="grid max-w-4xl grid-cols-1 gap-3 md:grid-cols-3">
            <Field label="Person" required>
              <select
                value={userId}
                onChange={(event) => {
                  setUserId(event.target.value === "" ? "" : Number(event.target.value));
                  setPlant("");
                }}
                className={inputClass}
              >
                <option value="">Choose a person…</option>
                {options.members.map((m) => (
                  <option key={m.user_id} value={m.user_id} disabled={!m.is_active}>
                    {personLabel(m)} · {m.role_code}
                    {m.is_active ? "" : " · disabled"}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Plants"
              required
              hint={
                member && !member.sees_every_plant
                  ? "Only the Plants assigned to them under Users. Every Plant needs a Client Admin."
                  : undefined
              }
            >
              <select
                value={plant}
                disabled={!member || plantChoices.length === 0}
                onChange={(event) => setPlant(event.target.value)}
                className={inputClass}
              >
                <option value="">
                  {!member
                    ? "Choose a person first"
                    : plantChoices.length === 0
                      ? "No Plants assigned to them"
                      : "Choose…"}
                </option>
                {member?.sees_every_plant ? <option value={EVERY_PLANT}>Every Plant</option> : null}
                {plantChoices.map((id) => (
                  <option key={id} value={id}>
                    {plantName.get(id) ?? `Plant ${id}`}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Alarms" hint="Use “High and critical” for fewer emails.">
              <select
                value={severity}
                onChange={(event) => setSeverity(event.target.value)}
                className={inputClass}
              >
                {SEVERITY_CHOICES.map((choice) => (
                  <option key={choice.code} value={choice.code}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {member && !member.sees_every_plant && plantChoices.length === 0 ? (
            <p className="mt-2 text-xs text-warn">
              {personLabel(member)} has no Plants assigned, so there is nothing they may be
              emailed about. Assign Plants to them under Users first.
            </p>
          ) : null}
          <Button
            variant="primary"
            className="mt-4"
            disabled={userId === "" || plant === "" || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? "Adding…" : "Add"}
          </Button>
        </Panel>
      </Reveal>

      <Panel
        title={`${rows.length} recipient${rows.length === 1 ? "" : "s"}`}
        subtitle={`Each row says whether a real Alarm would be emailed now. ${severityLabel("medium")} is the usual choice.`}
      >
        {rows.length === 0 ? (
          <p className="text-sm text-ink-muted">
            Nobody is emailed about this Client’s Alarms yet. Alarms still open and show on
            screen; “Add recipient” starts the emails.
          </p>
        ) : (
          <DataTable
            rows={rows}
            columns={columns}
            rowKey={(row) => row.id}
            animateArrivals
            leavingKeys={leaving}
            filterPlaceholder="Filter recipients…"
          />
        )}
      </Panel>
    </div>
  );
}
