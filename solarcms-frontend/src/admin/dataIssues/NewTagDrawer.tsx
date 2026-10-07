/**
 * Add a kind of reading the catalogue does not have yet — from the place the
 * need arises: a key the equipment sends that no Tag means.
 *
 * A Tag is a row, never a column or a release (Guardrail 1), and the catalogue
 * is the platform's, shared by every Client — so this is `system.admin` only,
 * and the form asks for the unit and range up front: a Tag without a range
 * stores a value in the wrong unit as good.
 */

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import * as catalogApi from "@/api/endpoints/catalog";
import { isApiError } from "@/api/problem";
import { qk } from "@/api/queryKeys";
import { Button, Drawer, Field, inputClass } from "@/components/ui";

const CATEGORIES = [
  { value: "electrical", label: "Electrical — voltage, current, power, frequency" },
  { value: "performance", label: "Performance — energy, yield, efficiency" },
  { value: "environmental", label: "Environmental — irradiance, temperature, wind" },
  { value: "diagnostic", label: "Diagnostic — internal temperatures, codes" },
  { value: "status", label: "Status — an on/off contact (never throttled)" },
] as const;

/** A Tag code as the catalogue spells them: capitals, digits and underscores. */
export function toTagCode(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^(\d)/, "T_$1")
    .slice(0, 64);
}

export function NewTagDrawer({
  suggestedCode,
  onClose,
  onCreated,
}: {
  /** The payload key that prompted it; the code starts from it. */
  suggestedCode: string | null;
  onClose: () => void;
  onCreated: (code: string) => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    code: toTagCode(suggestedCode ?? ""),
    name: "",
    unit: "",
    category: "electrical",
    min: "",
    max: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const min = form.min.trim() === "" ? null : Number(form.min);
  const max = form.max.trim() === "" ? null : Number(form.max);
  const problems = [
    !/^[A-Z][A-Z0-9_]*$/.test(form.code) && "The code must start with a letter and use capitals, digits and _.",
    form.name.trim() === "" && "Give it a name a person would read.",
    form.unit.trim() === "" && "Give its unit — use “code” for a status code or “bool” for a contact.",
    (min !== null && !Number.isFinite(min)) || (max !== null && !Number.isFinite(max))
      ? "The range must be numbers."
      : false,
    min !== null && max !== null && min > max && "The minimum cannot be above the maximum.",
  ].filter((p): p is string => typeof p === "string");

  const create = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await catalogApi.createTag({
        code: form.code,
        name: form.name.trim(),
        unit: form.unit.trim(),
        category: form.category,
        valid_min: min,
        valid_max: max,
      });
      await queryClient.invalidateQueries({ queryKey: qk.tags() });
      onCreated(form.code);
      onClose();
    } catch (err) {
      setError(isApiError(err) ? err.displayMessage : "Could not add the Tag.");
    } finally {
      setSaving(false);
    }
  };

  const set = (key: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  return (
    <Drawer
      open
      onClose={onClose}
      title="A new kind of reading"
      subtitle="Adds a Tag to the catalogue every Client shares. Once added, map the key to it."
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={saving || problems.length > 0}
            onClick={() => void create()}
          >
            {saving ? "Adding…" : `Add ${form.code || "Tag"}`}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <Field label="Code" required hint="How it is named everywhere: capitals, digits and _ only.">
          <input
            value={form.code}
            onChange={(event) => setForm((c) => ({ ...c, code: toTagCode(event.target.value) }))}
            className={`${inputClass} font-mono`}
          />
        </Field>
        <Field label="Name" required hint="What a person reads on a chart or a card.">
          <input value={form.name} onChange={set("name")} className={inputClass} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Unit" required hint="As it will be stored — kW, V, A, %, degC, W/m2…">
            <input value={form.unit} onChange={set("unit")} className={inputClass} />
          </Field>
          <Field label="Kind" required>
            <select value={form.category} onChange={set("category")} className={inputClass}>
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Lowest allowed" hint="A value below is kept but marked rejected.">
            <input value={form.min} onChange={set("min")} inputMode="decimal" className={inputClass} />
          </Field>
          <Field label="Highest allowed" hint="Leave both empty only if any value is possible.">
            <input value={form.max} onChange={set("max")} inputMode="decimal" className={inputClass} />
          </Field>
        </div>
        {problems.length > 0 ? (
          <ul className="space-y-0.5 text-[11px] text-ink-muted">
            {problems.map((problem) => <li key={problem}>• {problem}</li>)}
          </ul>
        ) : null}
        {error ? (
          <p className="rounded border border-bad/30 bg-bad/10 px-2 py-1 text-xs text-bad">{error}</p>
        ) : null}
      </div>
    </Drawer>
  );
}
