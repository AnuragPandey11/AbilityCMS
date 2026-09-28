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
 *
 * ── Suggestions on every letter; the page only once typing pauses ───────────
 * The box is a combobox. Its list is filtered in memory from the Plants the
 * token already carries, so it updates on each keystroke with nothing to wait
 * for. The page's narrowing is what stays debounced: it can move the Plant on
 * screen and fire that Plant's dozen queries, which a half-typed word should
 * not. Choosing a suggestion is deliberate rather than typing, so it commits at
 * once — the Plant's code goes into the box and the store, which narrows every
 * screen the same way, the Alarms screen included, whose Plant selection is
 * its own.
 */

import { useEffect, useId, useMemo, useState } from "react";
import { useAuth } from "@/auth/AuthProvider";
import type { MePlant } from "@/api/schemas";
import { SelectBox } from "@/components/ui";
import { IconClose, IconSearch } from "@/components/icons";
import { useSelection } from "@/state/selection";
import { matchPlants, usePlantFilter } from "@/state/usePlantFilter";
import { matchRanges } from "@/state/searchMatch";
import { useDebouncedValue } from "@/state/useDebouncedValue";

/** Long enough that a typed word switches the Plant once, not once per letter. */
export const PLANT_SEARCH_DEBOUNCE_MS = 300;

/** More than this and the list is a second picker; typing another letter narrows it. */
export const MAX_SUGGESTIONS = 8;

/** `text` with the parts the query matched in bold. */
function Highlighted({ text, query }: { text: string; query: string }): JSX.Element {
  const ranges = matchRanges(text, query);
  if (ranges.length === 0) return <>{text}</>;
  const parts: JSX.Element[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) parts.push(<span key={at}>{text.slice(at, start)}</span>);
    parts.push(
      <mark key={start} className="bg-transparent font-bold text-inherit">
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  }
  if (at < text.length) parts.push(<span key={at}>{text.slice(at)}</span>);
  return <>{parts}</>;
}

export function PlantFilterBar(): JSX.Element | null {
  const { me } = useAuth();
  const filter = usePlantFilter();
  const { plantSearch, setPlantSearch, setClientId, setPlantId } = useSelection();
  const [text, setText] = useState(plantSearch);
  const settled = useDebouncedValue(text, PLANT_SEARCH_DEBOUNCE_MS);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();

  // Keyed on the settled text alone. Depending on the stored value as well
  // would let a clear, which writes the store at once, be overwritten by the
  // stale settled text for one debounce interval.
  useEffect(() => {
    setPlantSearch(settled);
  }, [settled, setPlantSearch]);

  // The same rule as the page's narrowing, against the text as typed now.
  const { clientOf, clientId } = filter;
  const suggestions = useMemo(
    () => (text.trim() === "" ? [] : matchPlants(me?.plants ?? [], clientOf, clientId, text)),
    [text, me?.plants, clientOf, clientId],
  );

  if (!me?.platform_admin) return null;

  const shown = suggestions.slice(0, MAX_SUGGESTIONS);
  const listOpen = open && text.trim() !== "";
  const highlighted = listOpen ? shown[Math.min(active, shown.length - 1)] : undefined;
  const optionId = (plant: MePlant) => `${listId}-option-${plant.id}`;

  const clear = () => {
    setText("");
    setPlantSearch("");
    setOpen(false);
  };
  const choose = (plant: MePlant) => {
    setText(plant.code);
    setPlantSearch(plant.code);
    setPlantId(plant.id);
    setOpen(false);
  };
  const current = filter.clients.find((client) => client.id === filter.clientId);
  const total = me.plants.length;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <SelectBox
        size="sm"
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

      <div className="relative w-full min-w-0 sm:w-60">
        <label className="surface-tile flex w-full min-w-0 items-center gap-2 rounded-control border border-line px-2.5 py-1.5 text-xs transition focus-within:ring-2 focus-within:ring-accent/40 hover:border-line-strong">
          <IconSearch size={12} className="shrink-0 text-ink-muted" />
          <input
            type="text"
            inputMode="search"
            enterKeyHint="search"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={listOpen}
            aria-controls={listId}
            aria-activedescendant={highlighted ? optionId(highlighted) : undefined}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setActive(0);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            onKeyDown={(event) => {
              switch (event.key) {
                case "ArrowDown":
                case "ArrowUp": {
                  if (text.trim() === "") return;
                  event.preventDefault();
                  if (!listOpen) {
                    setOpen(true);
                    setActive(0);
                  } else if (shown.length > 0) {
                    const step = event.key === "ArrowDown" ? 1 : -1;
                    setActive((index) => (index + step + shown.length) % shown.length);
                  }
                  return;
                }
                case "Enter":
                  // The best match is highlighted from the first letter, so
                  // Enter takes it without an arrow key first.
                  if (highlighted) {
                    event.preventDefault();
                    choose(highlighted);
                  }
                  return;
                case "Escape":
                  // First Escape closes the list; the next clears the box.
                  if (listOpen) {
                    event.preventDefault();
                    setOpen(false);
                  } else if (text !== "") {
                    event.preventDefault();
                    clear();
                  }
                  return;
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

        {listOpen ? (
          <div className="surface-card absolute left-0 top-full z-30 mt-1.5 w-full min-w-[18rem] rounded-card border border-line p-1.5 shadow-card">
            <ul id={listId} role="listbox" aria-label="Matching Plants" className="max-h-80 overflow-y-auto">
              {shown.map((plant) => {
                const client = filter.clientOf(plant.id);
                const isActive = plant === highlighted;
                return (
                  <li
                    key={plant.id}
                    id={optionId(plant)}
                    role="option"
                    aria-selected={isActive}
                    // Keeps focus in the box, so the list is still open when
                    // the click lands.
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActive(shown.indexOf(plant))}
                    onClick={() => choose(plant)}
                    className={`flex cursor-pointer items-baseline gap-2 rounded-control px-2.5 py-1.5 text-xs ${
                      isActive ? "bg-accent/[0.12]" : ""
                    }`}
                  >
                    <span className="shrink-0 font-mono font-semibold text-accent">
                      <Highlighted text={plant.code} query={text} />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-ink">
                      <Highlighted text={plant.name} query={text} />
                    </span>
                    {client && filter.clientId === null ? (
                      <span className="max-w-[40%] shrink-0 truncate text-[11px] text-ink-muted">
                        <Highlighted text={client.name ?? client.label} query={text} />
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {shown.length === 0 ? (
              <p className="px-2.5 py-1.5 text-xs text-ink-muted">
                No Plant or Client matches “{text.trim()}”.
              </p>
            ) : null}
            {suggestions.length > shown.length ? (
              <p className="mt-1 border-t border-line px-2.5 pt-1.5 text-[11px] text-ink-faint">
                {suggestions.length - shown.length} more — keep typing to narrow
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      {filter.active ? (
        <span className="text-xs text-ink-muted" aria-live="polite">
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
