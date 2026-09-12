/**
 * Pick a Region for a Plant, or add one inline.
 *
 * A Region is the state or grid area a Plant sits in (MASTER §1); its job is to
 * carry the grid emission factor behind CO₂-avoided (tender §18). The backend
 * 422s on a code it has never seen, so this is a dropdown of what exists plus,
 * for a Super Admin, a way to create the missing one without leaving the form.
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRegions } from "@/api/hooks";
import { qk } from "@/api/queryKeys";
import * as regionsApi from "@/api/endpoints/regions";
import { isApiError } from "@/api/problem";
import { usePermission } from "@/auth/usePermission";
import { Button, Field, inputClass } from "@/components/ui";

export function RegionSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (code: string) => void;
}): JSX.Element {
  const canCreate = usePermission("system.admin");
  const regionsQuery = useRegions();
  const queryClient = useQueryClient();

  const [adding, setAdding] = useState(false);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [factor, setFactor] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      regionsApi.createRegion({
        code: code.trim().toUpperCase(),
        name: name.trim(),
        grid_emission_factor_kg_per_kwh: factor ? Number(factor) : null,
      }),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: qk.regions() });
      onChange(created.code);
      setAdding(false);
      setCode("");
      setName("");
      setFactor("");
      setError(null);
    },
    onError: (err) =>
      setError(
        isApiError(err) ? err.displayMessage : "Could not create the Region.",
      ),
  });

  return (
    <Field
      label="Region"
      hint={
        regionsQuery.isError
          ? "Could not load Regions."
          : "Optional. Supplies the grid emission factor for CO₂. Codes follow ISO 3166-2, e.g. IN-UP."
      }
    >
      <div className="flex items-center gap-2">
        <select
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={inputClass}
          disabled={regionsQuery.isPending}
        >
          <option value="">— none —</option>
          {(regionsQuery.data ?? []).map((region) => (
            <option key={region.id} value={region.code}>
              {region.code} · {region.name}
            </option>
          ))}
        </select>
        {canCreate && !adding ? (
          <Button variant="secondary" onClick={() => setAdding(true)}>
            Add Region
          </Button>
        ) : null}
      </div>

      {adding ? (
        <div className="mt-2 rounded border border-line bg-surface p-3">
          <div className="grid grid-cols-3 gap-2">
            <input
              placeholder="Code (IN-UP)"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              className={inputClass}
              autoComplete="off"
            />
            <input
              placeholder="Name (Uttar Pradesh)"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className={inputClass}
              autoComplete="off"
            />
            <input
              type="number"
              step="0.0001"
              min="0"
              placeholder="kg CO₂ / kWh (optional)"
              value={factor}
              onChange={(event) => setFactor(event.target.value)}
              className={inputClass}
            />
          </div>
          {error ? <p className="mt-2 text-[11px] text-bad">{error}</p> : null}
          <div className="mt-2 flex gap-2">
            <Button
              variant="primary"
              disabled={!code.trim() || !name.trim() || create.isPending}
              onClick={() => create.mutate()}
            >
              {create.isPending ? "Creating…" : "Create Region"}
            </Button>
            <Button variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </Field>
  );
}
