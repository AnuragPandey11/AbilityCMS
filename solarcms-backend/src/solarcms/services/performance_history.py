"""Performance History: one Plant, a run of days, each day's figures.

The Performance History screen's calendar and bars (`GET /plants/{id}/history`).
Read-only, and **the Reports' own arithmetic**, never a second copy of it:

* each **month** is the Monthly Plant Report's row for that month, built by
  `report_tables.build_monthly_plant` from the same reads, so the screen and a
  downloaded Monthly Report can never disagree about a month;
* each **day** is the same rule applied per Plant-local day — energy from the
  KPI screen's register precedence with `split_steps` (a step across midnight
  belongs to no day), irradiation from the stations measuring that day
  (`irradiation_by_label`), PR over the 15-minute periods both sides measured
  (`pr_matching.summarise_by_label`), peak from 15-minute buckets, coverage as
  the Daily Plant Report counts it;
* the **period** figures are the whole window's: energy as `plant_energy`
  totals it (including any step no single day can claim), PR pooled over every
  matched period rather than a mean of daily percentages.

Three rules held here, each one a Guardrail:

* nothing to read is `None`, never 0.0 — a day nothing measured is not a day
  that made nothing (Guardrail 23);
* every figure travels with its coverage, and is never corrected for it
  (Guardrail 18);
* a ratio outside what it can physically be is returned unaltered and flagged
  (Guardrail 33).

⚠ No money: revenue is shown only to someone given the Revenue tab
(`routers/revenue.py`), and this route needs `dashboard.view` alone.
⚠ Plant availability is not here: it is folded minute by minute
(`services/availability`), at most `AVAILABILITY_DAYS_PER_PASS` days per
request, and a year of it would not answer while the reader waits.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date, datetime
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from solarcms.domain.assumptions import (
    PLANT_ENERGY_COUNTER_PRECEDENCE,
    PLANT_FREQUENCY_SOURCE_PRECEDENCE,
    PLANT_IMPORT_COUNTER_PRECEDENCE,
    PLANT_IRRADIATION_SOURCE,
    PLANT_POWER_SOURCE_PRECEDENCE,
    REPORT_RATIO_CEILING,
)
from solarcms.domain.counters import DeviceSeries, plant_energy
from solarcms.domain.formulas import specific_yield
from solarcms.domain.irradiation import LiveIrradiance, irradiation_notes, plant_irradiation
from solarcms.domain.periods import ReportWindow, report_window
from solarcms.domain.pr_matching import (
    PrBasis,
    matched_performance_ratio,
    plant_periods,
    pr_basis_note,
    summarise_by_label,
)
from solarcms.domain.tiering import Tier
from solarcms.services import report_tables as rt
from solarcms.services.energy import read_counter_series, read_live_irradiance

#: Why a ratio is flagged, in the Monthly Report's words.
_IMPLAUSIBLE = ("outside what the ratio can physically be — the energy and the "
                "irradiation cover different spans")


def _round(value: float | None, digits: int) -> float | None:
    """As the report tables round for JSON — and NaN, which JSON cannot carry, as nothing."""
    if value is None or value != value:  # NaN
        return None
    return round(value, digits)


def _ratio_flag(ratio: float | None) -> bool:
    return ratio is not None and not 0.0 <= ratio <= REPORT_RATIO_CEILING


def _pr(basis: PrBasis | None, dc_kwp: float) -> float | None:
    if basis is None:
        return None
    return matched_performance_ratio(basis, dc_kwp).value


def build_history(
    plant: rt.PlantInfo, window: ReportWindow, series: Sequence[DeviceSeries],
    stats: dict[tuple[str, str], dict[date, rt.Stat]], *,
    live: Sequence[LiveIrradiance], counter_tier: Tier, stats_tier: Tier, now: datetime,
) -> dict[str, Any]:
    """The response body. Pure: every read is the caller's."""
    zone = plant.zone
    ac = plant.ac_kw or None
    dc = plant.dc_kwp or 0.0
    day_key = rt._day_key(zone)

    energy = plant_energy(series, PLANT_ENERGY_COUNTER_PRECEDENCE, plant_ac_capacity_kw=ac)
    stations = [s for s in series if (s.device_type_code, s.tag_code) == PLANT_IRRADIATION_SOURCE]
    irradiation = plant_irradiation(stations, live)
    made_by_day = rt.split_steps(energy.steps, day_key)
    irr_by_day = rt._station_means(irradiation, day_key)
    matched = (plant_periods(energy, irradiation, dc)
               if energy.value is not None and irradiation.value is not None else ())
    pr_by_day = summarise_by_label(matched, day_key)
    power_pair, power = rt.pick_source(stats, PLANT_POWER_SOURCE_PRECEDENCE)
    today = now.astimezone(zone).date()

    days: list[dict[str, Any]] = []
    for day in window.days:
        key = day.isoformat()
        made = made_by_day.totals.get(key) if energy.value is not None else None
        irr = irr_by_day.get(key) if irradiation.value is not None else None
        pr = _pr(pr_by_day.get(key), dc) if made is not None and irr is not None else None
        power_day = power.get(day)
        hours = rt._hours_in(day, window, plant)
        days.append({
            "date": key,
            "in_progress": day == today,
            "energy_kwh": _round(made, 3),
            "irradiation_kwh_m2": _round(irr, 4),
            "specific_yield": _round(
                specific_yield(made, dc).value if made is not None else None, 4),
            # A percentage, as every Report carries it.
            "performance_ratio": _round(pr * 100.0 if pr is not None else None, 3),
            "performance_ratio_flagged": _ratio_flag(pr),
            "peak_power_kw": _round(power_day.peak_sum if power_day else None, 3),
            "coverage": _round(
                rt._coverage(power_day.buckets if power_day else 0, hours, stats_tier)
                if power_pair else None, 1),
        })

    # The months are the Monthly Plant Report's rows, built from the same reads.
    monthly = rt.build_monthly_plant(plant, window, series, stats, live=live,
                                     counter_tier=counter_tier, stats_tier=stats_tier)
    flagged_months = {(index, key) for index, key, _why in monthly.flags}
    months = [{
        "month": row["month"],
        "days": row["days"],
        "energy_kwh": _round(row["energy_kwh"], 3),
        "irradiation_kwh_m2": _round(row["irradiation_kwh_m2"], 4),
        "specific_yield": _round(row["specific_yield"], 4),
        "performance_ratio": _round(row["performance_ratio"], 3),
        "performance_ratio_flagged": (index, "performance_ratio") in flagged_months,
        "cuf": _round(row["cuf"], 3),
        "cuf_flagged": (index, "cuf") in flagged_months,
        "peak_power_kw": _round(row["peak_power_kw"], 3),
        "coverage": _round(row["coverage"], 1),
    } for index, row in enumerate(monthly.rows)]

    # The whole window: PR pooled over every matched period, never a mean of days.
    whole = summarise_by_label(matched, lambda _at: "all").get("all")
    both = energy.value is not None and irradiation.value is not None
    period_pr = _pr(whole, dc) if both else None
    measured = [d for d in days if d["energy_kwh"] is not None]
    peaks = [d["peak_power_kw"] for d in days if d["peak_power_kw"] is not None]

    notes = [
        rt._energy_note(energy, per="day"),
        ("Irradiation is the mean of the Weather Stations measuring each day: its daily GHI "
         "register, or its live GHI integrated where the register read nothing."
         if irradiation.value is not None else
         "Irradiation is not known — no Weather Station reported — so PR is not either."),
        *irradiation_notes(irradiation),
        "PR is energy over DC capacity over irradiation, counting only the 15-minute periods "
        "in which both were measured; the period's PR is pooled over all of them, not a mean "
        "of the days. Provisional pending the client's formulas (OPEN-16).",
    ]
    if not dc:
        notes.append("No DC capacity is recorded for this Plant, so specific yield and PR "
                     "are not known. Record it in the Plant's settings.")
    if whole is not None and (note := pr_basis_note("The period's PR", whole, zone)):
        notes.append(note)
    if power_pair:
        notes.append(rt._coverage_note(
            stats_tier, rt._source_phrase(power_pair[0], rt._device_count(power)), "day"))
    notes += [n for n in (rt._unattributed_note("energy", made_by_day, zone),
                          rt._refused_note(energy, day_key),
                          rt._flagged_note(rt._flagged_total(power))) if n]
    notes.append("An empty day is a day with nothing to read, never a day that made nothing. "
                 f"Registers read from the {counter_tier.value} tier.")

    return {
        "plant_id": plant.id,
        "timezone": plant.timezone,
        "first_day": window.first_day.isoformat(),
        "last_day": window.last_day.isoformat(),
        "dc_capacity_kwp": plant.dc_kwp,
        "ac_capacity_kw": plant.ac_kw,
        "energy_label": rt._energy_label(energy),
        "source_tier": counter_tier.value,
        "stats_tier": stats_tier.value,
        "days": days,
        "months": months,
        "totals": {
            "days": len(days),
            "days_with_energy": len(measured),
            "energy_kwh": _round(energy.value, 3),
            "irradiation_kwh_m2": _round(irradiation.value, 4),
            "specific_yield": _round(
                specific_yield(energy.value, dc).value if energy.value is not None else None, 4),
            "performance_ratio": _round(period_pr * 100.0 if period_pr is not None else None, 3),
            "performance_ratio_flagged": _ratio_flag(period_pr),
            "peak_power_kw": max(peaks) if peaks else None,
            # The share of PR's energy it stood on — said beside it (Guardrail 18).
            "pr_energy_share": _round(whole.energy_share, 4) if whole is not None else None,
        },
        "notes": notes,
        "generated_at": now,
    }


async def plant_history(
    session: AsyncSession, plant_id: int, first_day: date, last_day: date, now: datetime,
) -> dict[str, Any] | None:
    """The body, or None where the caller cannot see the Plant (RLS decides).

    Raises ValueError with a sentence for the reader when the days are not a
    period the Reports would accept (backwards, past today, over a year).
    """
    plant = await rt.fetch_plant(session, plant_id)
    if plant is None:
        return None
    window = report_window("custom", now, plant.zone, first_day, last_day)
    day_tier = rt._day_tier(window, now)
    stats_tier = rt._stats_tier(window, now)
    # Exactly what the Monthly Plant Report reads, so its rows can be built too.
    series = (await read_counter_series(
        session, tier=day_tier,
        pairs=[*PLANT_ENERGY_COUNTER_PRECEDENCE, *PLANT_IMPORT_COUNTER_PRECEDENCE,
               PLANT_IRRADIATION_SOURCE],
        start=window.start, end=window.end, plant_ids=[plant.id],
    )).get(plant.id, [])
    stats = await rt.fetch_day_stats(
        session, plant, window, stats_tier,
        [*PLANT_POWER_SOURCE_PRECEDENCE, *PLANT_FREQUENCY_SOURCE_PRECEDENCE])
    live = (await read_live_irradiance(
        session, tier=day_tier, start=window.start, end=window.end, plant_ids=[plant.id],
    )).get(plant.id, [])
    return build_history(plant, window, series, stats, live=live,
                         counter_tier=day_tier, stats_tier=stats_tier, now=now)
