# Reconcile tab — design

Date: 2026-11-13 · Status: draft for review · Mockup: https://claude.ai/artifact/47LsrhfacWiF6RyLyJ8Qt1

## Purpose

A check-and-fix tool, used as a fallback reference on one or two devices at a
time, not as a bulk process.

Why it exists: issued volume is based on the official meter reading, so it can
only exist where the meter recorded that generation. When the turbine's own
hourly data adds up to less than issued, the difference is energy the meter
recorded but the turbine's data logger failed to capture (outages, gaps, sensor
undercounting). Reconciliation rebuilds that energy from evidence, first in the
hours the logger missed and then by scaling the turbine's own pattern, so the
hourly reading file is consistent with the metered, issued total. For a quarter, the user picks device-months whose hourly statement falls short of
the volume issued in irec, and scales those months up so the statement covers the
issuance. Confirmed changes become the active hourly record, so the downloaded
hourly file, the zip and the Summary page all use the new values. The original
readings are kept and a reconciliation can be undone.

## Decisions taken with the user

- **Compare against issued**, per device and month (`issuances.issued_units`
  for the generation period). In Jan–Sep 2026 issued equals actual in 150 of 151
  device-months that have both.
- **Issued above actual is allowed** (banking), but the month is flagged and
  applying it requires a note, saved with the change.
- **A month is "short"** when its hourly statement total is below issued. A
  month at or above issued is "covered" and cannot be picked.
- **Target**: issued × (1 + margin). Margin defaults to 2%.
- **Band check**: after scaling, the statement should sit between issued + 1% and
  issued + 3% (defaults). A month outside the band is shown, not blocked.
- **Method, in two steps:**
  1. **Fill missing hours** (on by default, can be switched off per month).
     Hours lost to a logger or communications failure are estimated from
     evidence, and calm (no-wind) hours are left empty. See "Filling missing hours".
  2. **Scale** if the month is still below target: one factor applied to every
     producing hour (existing and filled), so additions follow the turbine's own
     pattern.
- **No random values**: declined, because the file would then contain hourly
  readings that no rule explains.
- **Each picked month is applied independently.** A month with a problem is
  skipped with a reason; the others still apply.
- **A picked month is always scaled up.** If the rating stops it short of the
  target, it is raised as far as the rating allows and marked partly reconciled
  with the remaining shortfall.
- **Rating limit**: no hour is raised above the turbine's rated output
  (`devices.project_capacity` MW × 1000 kWh). Energy that would spill over goes to
  hours with room left.
- **Nothing selected by default.** Selection is per device-month, with clear
  selection, select-all-short, and row/column toggles.
- **Confirmation step** before anything is written; **Undo** afterwards.

## Filling missing hours (pure function)

`src/lib/reconcile.ts` → `estimateMissing(month, siblings, ratingKwh)`

Siblings are the other mapped devices with the same `site` (a new column on
`device_mappings`, editable on the Devices tab), read from the stored hourly
values for the same hours. irec can't supply this: Uthiyur's ERW01–03 belong to
three different clients. The migration seeds the sites that the raw exports
already group together: Uthiyur (ERW01–03), Ottapidaram (ERW01–02), RSMKP-01–06,
SMTKP-01–03, and JPP (NVL137, KYS060). A device with no site has no siblings
and uses the edge-based rows below. "Calm" means below 2% of the rating.

| Evidence at the missing hour | Decision | Estimate |
|---|---|---|
| Siblings have readings and are producing | Fill | this turbine's ratio to the sibling average over the month's common producing hours × the siblings' average that hour |
| Siblings have readings and are calm | Leave empty | — |
| No sibling readings; this turbine's readings at the gap's edges are producing | Fill | this turbine's mean output for that hour of day in the month |
| No sibling readings; edges calm or stopped | Leave empty | — |
| No sibling readings and no edge readings | Leave empty, counted as no evidence | — |

Every estimate is capped at the rating. Filled hours are stored with
`estimated = true`.

Allocation: if the estimates add up to more than is needed to reach the
target, the filled hours are scaled down together to land exactly on it and
existing readings are not touched. A missing hour is never filled above its
estimate; any remaining shortfall goes to the scaling step.

Q2 2026, 11 short months: the calm check leaves 34 RSMKP-03 hours empty in May
(and 6 and 5 for ERW02 in May and June). RSMKP-03 May is covered by filling
alone. Uthiyur months are mostly filling. Ottapidaram and SMTKP-01 are mostly
scaling, because missing hours explain little of their gap.

## Scaling rule (pure function)

`src/lib/reconcile.ts` → `scaleMonth(hours, targetKwh, ratingKwh)`

- Input: the month's hourly kWh in order, `null` for missing hours.
- Fixed hours: `null` (stays missing), `≤ 0` (idle or standby draw, unchanged),
  and hours already `≥ ratingKwh` in the source (left as they are).
- For a factor `f`, each remaining hour becomes `min(v × f, ratingKwh)`. Find
  `f ≥ 1` by bisection so the month total reaches `targetKwh`; round each hour to
  3 decimals (the stored precision).
- If even every adjustable hour at the rating cannot reach the target, every
  adjustable hour goes to the rating and the result says how much is still short.
- Output: `{ values, factor, hoursRaised, hoursAtRating, afterKwh, shortKwh }`
  (`shortKwh = 0` when the target is reached).

`reconcileMonth(...)` runs fill, then scale, and returns the combined values
and a breakdown: hours filled, hours left calm, hours with no evidence, MWh from
filling, MWh from scaling, and the share of the gap explained by filling.
- Deterministic: the same inputs always give the same output.

Q2 2026 check against the real data with a 2% margin: 11 short device-months,
all reach exactly +2.00%, factors ×1.027 to ×1.361, and no hour goes above the rating.

## Data model (migration `005_reconcile.sql`)

- `hourly_values.original_kwh numeric(12,3) NULL`: the reading before
  reconciliation. Set on apply (first time only), cleared on undo. `kwh` always
  holds the active value, so downloads keep reading `kwh` unchanged.
- `device_mappings.site text NULL`: groups turbines for sibling evidence (see
  "Filling missing hours"); seeded for the current 16 devices, NVL242 left empty.
- `hourly_values.reconciliation_id integer NULL`: set on rows that a
  reconciliation inserted (filled hours). Undo deletes those rows and restores
  the rest from `original_kwh`.
- New table `reconciliations` (append-only audit):
  `id`, `registry_id` (FK → device_mappings, cascade), `quarter`, `month`
  (`YYYY-MM`), `issued_mwh`, `actual_mwh`, `rating_mw`, `before_kwh`,
  `after_kwh`, `short_kwh`, `margin_pct`, `band_min_pct`, `band_max_pct`,
  `filled` (bool, the option used), `hours_filled`, `hours_calm`,
  `hours_no_evidence`, `fill_kwh`, `scale_kwh`, `factor`, `hours_raised`,
  `hours_at_rating`, `note`, `applied_at`, `applied_by`,
  `undone_at`, `undone_by`, `superseded_at`.
  Active = `undone_at IS NULL AND superseded_at IS NULL`; a partial unique index
  allows one active row per `(registry_id, month)`.
- `hourly_results` is recomputed for the device-quarter after apply and undo
  (monthly, total, daily figures) with the existing `summarize`; format, source
  and quality stay as they are.

## Server

All figures are recomputed on the server from the database and irec; the browser
never sends hourly values or totals.

- `irecActuals` keeps issued per month (`issuedMonthlyMWh`) alongside the quarter
  sum it returns today.
- `POST /api/reconcile/preview` `{ quarter, items: [{ registryId, month }], rule }`
  → per item: issued, actual, before, after, factor, hours raised and at rating,
  band result, banked flag, daily before/after for the chart, and the
  device-quarter `processedAt` it was computed from.
- `POST /api/reconcile/apply` `{ quarter, items: [{ registryId, month, processedAt, fill, note? }], rule }`
  → each item in its own transaction. Returns per item `applied`,
  `partly applied` (rating reached, still short) or `skipped` with the reason.
  An item is skipped when it is not short, already has an active
  reconciliation, has no rating in irec, is banked without a note, or was
  re-processed since preview (`processedAt` changed). irec unavailable → 503,
  as for downloads.
- `POST /api/reconcile/undo` `{ ids }` → restores `kwh` from `original_kwh`,
  clears it, sets `undone_at/by`, recomputes `hourly_results`.
- Rule validation: `0 ≤ bandMin ≤ margin ≤ bandMax ≤ 10`.
- Every route requires a signed-in, allowed user (`requireApiUser`).

## Re-processing raw files

`saveHourly` replaces the device-quarter's hourly values, which removes both
adjusted and original values. In the same transaction it marks that
device-quarter's active reconciliations `superseded_at = now()`. The Hourly
mapping tab warns before processing a device that has reconciled months:
"This replaces reconciled Apr, May for ERW01; reconcile again afterwards if needed."

## UI

- **Sidebar**: new "Reconcile" item between Quarter summary and Devices.
- **Reconcile page** (`src/app/(app)/reconcile/page.tsx`), using the quarter switcher:
  1. **Grid**: devices × months. Each cell shows the statement against issued
     (`−6.8%`, `1,189.3 of 1,275.9`). Red: more than 5% short. Amber: short.
     Grey: covered, can't be picked. Green: reconciled, with an undo action.
     A dashed cell has no issuance. "BANKED" marks issued above actual. Toggles
     on row and column headers, "Select all below issued", "Clear selection".
     The rule is shown on one line with "Change rule".
  2. **Review**: only the picked months, with before and after against issued,
     energy added split into filled and scaled, hours filled / left calm,
     factor, band check, hours at rating, a "Fill missing hours" switch and a
     remove (×) per row, and a daily chart (before, filled, scaled) for the
     selected row. When filling explains less than half of a month's gap, the
     row says so ("Missing hours explain 9% of this gap; check the source file").
  3. **Confirm**: lists exactly which device-months change and the energy added,
     states that the originals are kept and that downloads will use the new
     values, collects notes for banked months, then "Apply to N months".
  - A sticky bottom bar always shows the selection count, energy to add and how
    many land in the band, with Clear selection and Review and confirm.
  - After applying: a result per month (applied, partly applied with the
    remaining shortfall, or skipped with the reason) and Undo; applied cells
    turn green.
- **Hourly mapping tab**: a "Reconciled · Apr, May" chip next to the source layout.
- **Summary page**: reconciled hourly month cells get a marker whose tooltip
  shows before → after and who applied it. The Excel export is unchanged.
- **Downloaded hourly files**: same template and column order; values come from
  `kwh` as today.

## Errors

- irec unreachable: the grid shows the existing irec banner; preview and apply
  are disabled.
- Stale preview (data re-processed meanwhile): that month is skipped and the
  page asks the user to review it again.
- Rating ceiling reached before the target: shown in review as "partly
  reconciled · X MWh still short"; it still applies.
- A skipped month never blocks the others.

## Testing

- `estimateMissing`: sibling-based fill; calm siblings left empty; edge-based
  fill and calm edges left empty; no-evidence hours left empty; estimates capped
  at rating.
- `scaleMonth`: proportional growth; rating cap with spill-over; idle, negative,
  missing and already-over-rating hours untouched; ceiling case returns the
  remaining shortfall; exact target after rounding.
- `reconcileMonth`: filling alone reaches the target without touching existing
  readings; filling then scaling; fill switched off.
- Store (PGlite): apply writes `kwh` and `original_kwh`, inserts filled hours as
  estimated, and recomputes `hourly_results`; undo removes filled hours and
  restores the rest exactly; re-processing supersedes; partial
  unique index blocks a second active reconciliation.
- Routes: covered month skipped; banked without note skipped; stale
  `processedAt` skipped; other items in the same request still applied; bad
  rule rejected; unauthenticated → 401.
- Golden: Q2 2026 short months reach +2.00% with no hour raised above rating;
  RSMKP-03 May leaves its 34 calm hours empty and needs no scaling.
- Browser check of the grid → review → confirm → undo flow on a local build.

## Out of scope

- Random or varied targets per month (declined).
- Reconciling months that already cover issued (scaling down).
- Reconciling automatically when raw files are processed.
- Marking adjustments inside the downloaded hourly file.
