/**
 * Client filter and Plant search, above the Plant screens, for a platform
 * administrator.
 *
 * Mounted by the route, not by the page, because the pages replace themselves
 * with a skeleton while a newly chosen Plant loads — and a search box inside
 * that page would unmount mid-word, taking the caret and the rest of the query
 * with it. Here it survives the Plant changing underneath it, and moving
 * between the Plant screens.
 *
 * It narrows; the page's own Plant picker still chooses (see
 * `useFilteredPlantScope`, and the Alarms screen, whose picker also offers
 * "All").
 */

import { useEffect, useState } from "react";
import { useAuth } from "@/auth/AuthProvider";
import { SelectBox } from "@/components/ui";
import { IconClose, IconSearch } from "@/components/icons";
import { useSelection } from "@/state/selection";
import { usePlantFilter } from "@/state/usePlantFilter";
import { useDebouncedValue } from "@/state/useDebouncedValue";

/** Long enough that a typed word switches the Plant once, not once per letter. */
export const PLANT_SEARCH_DEBOUNCE_MS = 300;

export function PlantFilterBar(): JSX.Element | null {
  const { me } = useAuth();
  const filter = usePlantFilter();
  const { plantSearch, setPlantSearch, setClientId } = useSelection();
  const [text, setText] = useState(plantSearch);
  const settled = useDebouncedValue(text, PLANT_SEARCH_DEBOUNCE_MS);

  // Keyed on the settled text alone. Depending on the stored value as well
  // would let a clear, which writes the store at once, be overwritten by the
  // stale settled text for one debounce interval.
  useEffect(() => {
    setPlantSearch(settled);
  }, [settled, setPlantSearch]);

  if (!me?.platform_admin) return null;

  const clear = () => {
    setText("");
    setPlantSearch("");
  };
  const current = filter.clients.find((client) => client.id === filter.clientId);
  const total = me.plants.length;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <SelectBox
        label="Client"
        value={filter.clientId === null ? "" : String(filter.clientId)}
        onChange={(next) => setClientId(next === "" ? null : Number(next))}
        display={
          current ? (
            <>
              {current.code ? (
                <>
                  <span className="font-mono font-semibold text-accent">{current.code}</span>
                  <span className="text-ink-muted"> — </span>
                </>
              ) : null}
              {current.name ?? current.label}
            </>
          ) : (
            <span className="text-ink-muted">All Clients</span>
          )
        }
      >
        <option value="">All Clients</option>
        {filter.clients.map((client) => (
          <option key={client.id} value={client.id}>
            {client.code && client.name ? `${client.code} — ${client.name}` : client.label} (
            {client.plantCount})
          </option>
        ))}
      </SelectBox>

      <label className="surface-tile inline-flex w-full min-w-0 items-center gap-2 rounded-control border border-line px-3.5 py-2 text-sm transition focus-within:ring-2 focus-within:ring-accent/40 hover:border-line-strong sm:w-80">
        <IconSearch size={14} className="shrink-0 text-ink-muted" />
        <input
          type="text"
          inputMode="search"
          enterKeyHint="search"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && text !== "") {
              event.preventDefault();
              clear();
            }
          }}
          placeholder="Search Plant or Client"
          aria-label="Search Plants by Plant or Client name or code"
          className="min-w-0 flex-1 bg-transparent text-ink placeholder:text-ink-faint focus:outline-none"
        />
        {text !== "" ? (
          <button
            type="button"
            onClick={clear}
            aria-label="Clear search"
            className="shrink-0 rounded-control p-0.5 text-ink-muted transition hover:text-ink"
          >
            <IconClose size={12} />
          </button>
        ) : null}
      </label>

      {filter.active ? (
        <span className="text-sm text-ink-muted" aria-live="polite">
          {filter.matches.length === 0
            ? filter.search
              ? `No Plant or Client matches “${filter.search}”.`
              : "No Plants."
            : `${filter.matches.length} of ${total} Plants`}
        </span>
      ) : null}
    </div>
  );
}
