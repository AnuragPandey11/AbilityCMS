/**
 * Platform administration: Clients and the audit trail.
 *
 * Both are `system.admin`. The audit trail is read-only by construction — no
 * write route exists, and every row is written in the same transaction as the
 * change it records.
 *
 * Platform health — the processes' heartbeats, the broker, ingest lag and
 * aggregate freshness — has its own page, System Health (`SystemHealthAdmin`).
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { qk } from "@/api/queryKeys";
import * as auditApi from "@/api/endpoints/audit";
import * as clientsApi from "@/api/endpoints/clients";
import type { AuditEntry, Client } from "@/api/schemas";
import { Panel, Badge, inputClass } from "@/components/ui";
import { ErrorState, ForbiddenState, LoadingState } from "@/components/state";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { NewClientForm } from "@/admin/NewClientForm";
import { formatDateTime } from "@/format/datetime";
import { usePermission } from "@/auth/usePermission";
import { useAuth } from "@/auth/AuthProvider";

export function SystemAdmin(): JSX.Element {
  const isPlatformAdmin = usePermission("system.admin");
  const { switchClient, me } = useAuth();
  const [auditAction, setAuditAction] = useState("");
  const [switchError, setSwitchError] = useState<string | null>(null);

  const clientsQuery = useQuery({
    queryKey: qk.clients(),
    queryFn: clientsApi.listClients,
    enabled: isPlatformAdmin,
    retry: false,
  });
  const auditQuery = useQuery({
    queryKey: qk.audit({ action: auditAction }),
    queryFn: () =>
      auditApi.listAudit({ action: auditAction || null, limit: 200 }),
    enabled: isPlatformAdmin,
    retry: false,
  });

  if (!isPlatformAdmin) {
    return (
      <ForbiddenState detail="Platform administration requires the system.admin permission." />
    );
  }

  const clientColumns: Column<Client>[] = [
    {
      key: "code",
      header: "Client",
      render: (client) => (
        <span>
          <span className="font-medium">{client.code}</span>
          <span className="ml-2 text-ink-muted">{client.name}</span>
        </span>
      ),
      sortValue: (client) => client.code,
      filterValue: (client) => `${client.code} ${client.name}`,
    },
    {
      key: "status",
      header: "Status",
      width: "130px",
      render: (client) => <Badge tone="neutral">{client.status}</Badge>,
      sortValue: (client) => client.status,
    },
    {
      key: "demo",
      header: "Demo",
      width: "110px",
      render: (client) =>
        client.is_demo ? (
          <Badge
            tone="warn"
            title="An access-control switch, not a label: a Guest may only ever reach a demonstration Client."
          >
            demo
          </Badge>
        ) : (
          <span className="text-ink-faint">—</span>
        ),
      sortValue: (client) => String(client.is_demo),
    },
    {
      key: "switch",
      header: "",
      width: "120px",
      render: (client) => (
        <button
          type="button"
          className="text-xs text-accent hover:underline"
          title="Switching Client clears every cached query — nothing from the previous Client survives."
          onClick={() => {
            setSwitchError(null);
            switchClient(client.id).catch(() =>
              setSwitchError(`Could not switch to ${client.code}.`),
            );
          }}
          disabled={client.id === me?.client_id}
        >
          {client.id === me?.client_id ? "current" : "switch to"}
        </button>
      ),
    },
  ];

  const auditColumns: Column<AuditEntry>[] = [
    {
      key: "occurred",
      header: "When",
      width: "170px",
      render: (entry) => (
        <span className="font-mono text-xs">
          {formatDateTime(entry.occurred_at)}
        </span>
      ),
      sortValue: (entry) => Date.parse(entry.occurred_at),
    },
    {
      key: "action",
      header: "Action",
      width: "180px",
      render: (entry) => (
        <span className="font-mono text-xs">{entry.action}</span>
      ),
      sortValue: (entry) => entry.action,
      filterValue: (entry) => entry.action,
    },
    {
      key: "actor",
      header: "Actor",
      render: (entry) =>
        entry.actor_email ?? (entry.user_id ? `#${entry.user_id}` : "—"),
      filterValue: (entry) => entry.actor_email ?? "",
    },
    {
      key: "entity",
      header: "Entity",
      width: "160px",
      render: (entry) =>
        entry.entity_type
          ? `${entry.entity_type}#${entry.entity_id ?? "?"}`
          : "—",
      filterValue: (entry) => entry.entity_type ?? "",
    },
    {
      key: "client",
      header: "Client",
      width: "90px",
      render: (entry) =>
        entry.client_id === null ? (
          <span className="text-ink-faint" title="A platform-level change.">
            platform
          </span>
        ) : (
          `#${entry.client_id}`
        ),
      sortValue: (entry) => entry.client_id,
    },
    {
      key: "ip",
      header: "IP",
      width: "130px",
      render: (entry) => (
        <span className="font-mono text-xs text-ink-muted">
          {entry.ip_address ?? "—"}
        </span>
      ),
      filterValue: (entry) => entry.ip_address ?? "",
    },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="page-title">System</h1>
        <p className="mt-1.5 text-sm text-ink-muted">
          Clients, and the immutable audit trail.
        </p>
      </div>

      {switchError ? (
        <div className="rounded border border-bad/30 bg-bad/10 px-3 py-2 text-xs text-bad">
          {switchError}
        </div>
      ) : null}

      {/* Platform health has its own page now, with each process's heartbeat
          beside the database figures that used to open this one. */}
      <p className="text-sm text-ink-muted">
        Processes, the broker, ingest lag and aggregate freshness are on{" "}
        <Link to="/admin/health" className="font-medium text-accent hover:underline">
          System Health
        </Link>
        .
      </p>

      <Panel
        title="Clients"
        subtitle="Switching Client is a full state reset — every cached query is discarded."
      >
        {clientsQuery.isLoading ? (
          <LoadingState label="Loading Clients" />
        ) : clientsQuery.isError ? (
          <ErrorState error={clientsQuery.error} />
        ) : (
          <DataTable
            rows={clientsQuery.data ?? []}
            columns={clientColumns}
            rowKey={(client) => client.id}
            filterPlaceholder="Filter Clients…"
          />
        )}
      </Panel>

      <Panel
        title="New Client"
        subtitle="A Client owns Plants, Users and Alarms. It starts in onboarding with no Plants — use “switch to” above, then Plant onboarding, to add the first one."
      >
        <NewClientForm />
      </Panel>

      <Panel
        title="Audit trail"
        subtitle="Immutable. There is no write route, deliberately."
        actions={
          <input
            value={auditAction}
            onChange={(event) => setAuditAction(event.target.value)}
            placeholder="Filter by action, e.g. auth.login"
            className={`${inputClass} w-64`}
          />
        }
      >
        {auditQuery.isLoading ? (
          <LoadingState label="Loading audit" />
        ) : auditQuery.isError ? (
          <ErrorState error={auditQuery.error} />
        ) : (
          <DataTable
            rows={auditQuery.data ?? []}
            columns={auditColumns}
            rowKey={(entry) => entry.id}
            filterPlaceholder="Filter entries…"
          />
        )}
      </Panel>
    </div>
  );
}
