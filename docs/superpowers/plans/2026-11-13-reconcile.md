# Reconcile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Reconcile tab that fills logger gaps from evidence and scales short device-months up to issued + margin within the turbine rating, writes the result as the active hourly record, and can undo it.

**Architecture:** Pure math in `src/lib/reconcile.ts` (no I/O, fully unit-tested). Server orchestration in `src/lib/reconcileStore.ts` (loads quarter arrays via `loadHourly`, irec issued/actual/rating, siblings by `site`; applies and undoes with one non-interactive transaction per month). Three API routes. One client component for grid → review → confirm, ported from the approved mockup.

**Tech Stack:** Next.js 16 app router, Neon serverless Postgres (PGlite in tests), Vitest, Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-11-13-reconcile-design.md`

## Global Constraints

- Defaults: margin 2%, band +1% to +3%; rule valid only when `0 ≤ bandMin ≤ margin ≤ bandMax ≤ 10`.
- Calm threshold: below 2% of the rating.
- Rating: irec `devices.project_capacity` MW × 1000 kWh per hour; no hour raised above it; source hours already above it are left unchanged.
- Values stored with 3 decimals (kWh).
- Each picked month applied independently; a skipped month never blocks others.
- MeterData sheet column order unchanged (`TEMPLATE_COLUMNS`).
- No random values anywhere.
- Every route requires `requireApiUser`.

## Review Focus

- Re-processing raw files for a reconciled device: reconciliation marked superseded, filled rows gone, no orphan `original_kwh` (Task 3 test).
- Undo after filling: filled hours become missing again with their original reasons; totals return exactly (Task 3 test).
- Month boundaries: hours of the neighbouring month never change (Task 1 and 3 tests).
- Device with no rating in irec or no issuance: not pickable, skipped with reason (Task 3 test).
- Sibling with its own reconciliation: evidence uses its active values; acceptable, no crash (Task 3 test).

---

### Task 1: Pure reconcile math

**Files:** Create `src/lib/reconcile.ts`; Test `tests/reconcile.test.ts`

**Interfaces — Produces:**
```ts
export interface Rule { marginPct: number; bandMinPct: number; bandMaxPct: number }
export const DEFAULT_RULE: Rule
export function validateRule(r: unknown): Rule | string
export interface MonthInput { hours: (number | null)[]; siblings: (number | null)[][]; ratingKwh: number; targetKwh: number; fill: boolean }
export interface MonthResult {
  values: (number | null)[]; beforeKwh: number; afterKwh: number; shortKwh: number;
  filledIdx: number[]; hoursCalm: number; hoursNoEvidence: number; fillKwh: number; scaleKwh: number;
  factor: number; hoursRaised: number; hoursAtRating: number;
}
export function estimateMissing(hours, siblings, ratingKwh): { estimates: Map<number, number>; calm: number; noEvidence: number }
export function scaleMonth(values, targetKwh, ratingKwh, fixed?: Set<number>): { values; factor; hoursRaised; hoursAtRating; afterKwh; shortKwh }
export function reconcileMonth(m: MonthInput): MonthResult
```

- [ ] Tests: sibling fill uses ratio × sibling average; calm siblings leave hour empty; edge-based fill when no siblings; calm edges leave empty; no evidence counted; estimates capped at rating; filling alone reaches target without touching existing hours (estimates scaled down); fill then scale; fill off → scale only; rating ceiling returns `shortKwh > 0` with all adjustable hours at rating; hours ≤ 0 and ≥ rating unchanged; result rounded to 3 decimals and lands on target within 0.01 kWh; validateRule rejects bandMin > margin.
- [ ] Run `pnpm vitest run tests/reconcile.test.ts` → FAIL, implement, → PASS.

### Task 2: Schema, sites, issued per month

**Files:** Create `db/migrations/005_reconcile.sql`; Modify `src/lib/types.ts` (DeviceMapping.site), `src/lib/store.ts` (loadMappings/saveMappings site; saveHourly supersede), `src/lib/validate.ts` (cleanMapping site), `src/lib/irec.ts` + `src/lib/actuals.ts` (issuedMonthlyMWh), `src/lib/compute.ts` (HourlyPayload.filled?), `src/lib/output.ts` (filled section), `src/components/DevicesEditor.tsx` (Site column); Test `tests/db.test.ts`, `tests/hardening.test.ts`.

Migration:
```sql
ALTER TABLE device_mappings ADD COLUMN site text;
UPDATE device_mappings SET site = CASE
  WHEN registry_id IN ('2.7MES20003','2.7MES20004','2.7MES20005') THEN 'Uthiyur'
  WHEN registry_id IN ('2.7MES20012','2.7MES20013') THEN 'Ottapidaram'
  WHEN output_name LIKE 'RSMKP-%' THEN 'RSMKP'
  WHEN output_name LIKE 'SMTKP-%' THEN 'SMTKP'
  WHEN registry_id IN ('2.1MES20005','2.1MWIND020') THEN 'JPP' END;
ALTER TABLE hourly_values ADD COLUMN original_kwh numeric(12,3), ADD COLUMN reconciliation_id integer;
CREATE TABLE reconciliations (... columns from spec ..., filled_missing jsonb NOT NULL DEFAULT '[]');
CREATE UNIQUE INDEX reconciliations_one_active ON reconciliations (registry_id, month) WHERE undone_at IS NULL AND superseded_at IS NULL;
```
- [ ] Tests: seeded sites (16 set, NVL242 null); site round-trips through saveMappings; irecActuals returns `issuedMonthlyMWh` `[109.061, null, 512.005]` for the fixture; saveHourly supersedes active reconciliations; renderMeterXlsx lists `filled` hours in their own section.

### Task 3: Reconcile store

**Files:** Create `src/lib/reconcileStore.ts`; Test `tests/reconcileStore.test.ts`

**Interfaces — Produces:**
```ts
export interface GridCell { month: string; mi: 0|1|2; beforeMWh: number | null; issuedMWh: number | null; actualMWh: number | null;
  status: "none" | "noData" | "covered" | "short" | "reconciled"; banked: boolean; reconciliation?: ReconciliationRow }
export interface GridRow { registryId: string; outputName: string; site: string | null; ratingMw: number | null; processedAt: string | null; cells: GridCell[] }
export async function loadGrid(app: Db, irec: Db, quarter: Quarter): Promise<GridRow[]>
export interface PreviewItem { registryId: string; mi: 0|1|2; fill: boolean }
export interface Plan { registryId; outputName; mi; month; issuedMWh; actualMWh; banked; ratingMw; processedAt;
  result: MonthResult; afterPct: number; inBand: boolean; fillShare: number | null;
  daily: { before: number[]; fill: number[]; scale: number[] } }
export async function previewItems(app, irec, quarter, items: PreviewItem[], rule: Rule): Promise<(Plan | { registryId; mi; skipped: string })[]>
export async function applyItems(app, irec, quarter, items: (PreviewItem & { processedAt: string; note?: string })[], rule, user): Promise<{ registryId; mi; status: "applied" | "partly applied" | "skipped"; reason?: string; id?: number }[]>
export async function undoReconciliation(app, id: number, user): Promise<void>
```
- [ ] Tests on PGlite + irec fixture: apply writes kwh/original_kwh, inserts filled rows estimated with reconciliation_id, updates hourly_results monthly totals and quality (missing minus filled, filled list); other months untouched; second apply on same month skipped; stale processedAt skipped while another item applies; banked without note skipped; no rating skipped; undo restores totals, missing reasons and deletes filled rows; re-process after apply supersedes.

### Task 4: API routes

**Files:** Create `src/app/api/reconcile/preview/route.ts`, `apply/route.ts`, `undo/route.ts`.
- [ ] Each: `requireApiUser`; parse quarter; `validateRule`; items ≤ 60; irec errors → `irecUnavailableResponse`. Return JSON from the store functions.

### Task 5: Reconcile page and UI markers

**Files:** Create `src/app/(app)/reconcile/page.tsx`, `src/components/ReconcileFlow.tsx`; Modify `src/components/Sidebar.tsx`, `src/app/(app)/page.tsx` (Reconciled chip), `src/app/(app)/summary/page.tsx` (marker), `src/components/ProcessFlow.tsx` (warning before replacing reconciled months).
- [ ] Grid (no default selection; row/column toggles; select all short; clear), review table with fill switch, × remove, daily chart, fill-share warning; confirm box with notes; result list with Undo; sticky bar.
- [ ] Verify in a local production build: pick ERW01 Jun → review → apply → download file shows new total → undo restores.

### Task 6: Ship

- [ ] `pnpm typecheck && pnpm lint && pnpm test`; `pnpm db:migrate` against Neon; commit; push; check deployment.
