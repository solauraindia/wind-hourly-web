import "server-only";
import type { HourlyPayload } from "./compute";
import type { Db } from "./db";
import { irecActuals, irecDevices } from "./irec";
import type { Quarter } from "./quarter";
import { reconcileMonth, targetPct, type MonthResult, type Rule } from "./reconcile";
import { loadHourly, loadMappings, loadResults, summarize } from "./store";
import { HOUR, LOCAL_OFFSET_MIN, MINUTE, naive } from "./time";
import type { DeviceMapping, HourlyResult } from "./types";

/* Month helpers ------------------------------------------------------------------ */

export type MonthIdx = 0 | 1 | 2;

/** Hour-index range [from, to) of a quarter month inside the quarter's hourly array. */
export function monthRange(q: Quarter, mi: MonthIdx): [number, number] {
  const [y, m] = q.months[mi];
  const start = naive(y, m, 1);
  const end = mi === 2 ? q.end : naive(q.months[mi + 1][0], q.months[mi + 1][1], 1);
  return [(start - q.start) / HOUR, (end - q.start) / HOUR];
}
export const monthKey = (q: Quarter, mi: MonthIdx) => `${q.months[mi][0]}-${String(q.months[mi][1]).padStart(2, "0")}`;
const toInstant = (naiveMs: number) => new Date(naiveMs - LOCAL_OFFSET_MIN * MINUTE).toISOString();

/* Records -------------------------------------------------------------------------- */

export interface Reconciliation {
  id: number;
  registryId: string;
  month: string;
  issuedMWh: number;
  beforeKWh: number;
  afterKWh: number;
  shortKWh: number;
  fillKWh: number;
  scaleKWh: number;
  hoursFilled: number;
  marginPct: number;
  note: string | null;
  appliedAt: string;
  appliedBy: string | null;
}

interface RecRow {
  id: number; registry_id: string; month: string; issued_mwh: string; before_kwh: string; after_kwh: string; short_kwh: string;
  fill_kwh: string; scale_kwh: string; hours_filled: number; margin_pct: string; note: string | null; applied_at: Date | string; applied_by: string | null;
}

/** Reconciliations currently in force for a quarter, keyed `registryId|YYYY-MM`. */
export async function activeReconciliations(db: Db, quarter: string): Promise<Map<string, Reconciliation>> {
  const rows = await db.query<RecRow>(
    `SELECT id, registry_id, month, issued_mwh, before_kwh, after_kwh, short_kwh, fill_kwh, scale_kwh, hours_filled, margin_pct, note, applied_at, applied_by
       FROM reconciliations WHERE quarter = $1 AND undone_at IS NULL AND superseded_at IS NULL`,
    [quarter],
  );
  return new Map(
    rows.map((r) => [
      `${r.registry_id}|${r.month}`,
      {
        id: r.id, registryId: r.registry_id, month: r.month, issuedMWh: Number(r.issued_mwh), beforeKWh: Number(r.before_kwh),
        afterKWh: Number(r.after_kwh), shortKWh: Number(r.short_kwh), fillKWh: Number(r.fill_kwh), scaleKWh: Number(r.scale_kwh),
        hoursFilled: r.hours_filled, marginPct: Number(r.margin_pct), note: r.note,
        appliedAt: new Date(r.applied_at).toISOString(), appliedBy: r.applied_by,
      },
    ]),
  );
}

/* Grid ----------------------------------------------------------------------------- */

export type CellStatus = "noData" | "none" | "covered" | "short" | "reconciled";

export interface GridCell {
  mi: MonthIdx;
  month: string;
  status: CellStatus;
  /** active statement total (after reconciliation, when reconciled) */
  statementMWh: number | null;
  issuedMWh: number | null;
  actualMWh: number | null;
  /** issued above actual: banking; applying needs a note */
  banked: boolean;
  reconciliation: Reconciliation | null;
}

export interface GridRow {
  registryId: string;
  outputName: string;
  site: string | null;
  ratingMw: number | null;
  cells: GridCell[];
}

/** Devices × months of a quarter, with what can be reconciled. Throws IrecUnavailableError when irec is down. */
export async function loadGrid(app: Db, irec: Db, quarter: Quarter): Promise<GridRow[]> {
  const mappings = await loadMappings(app);
  const ids = mappings.map((m) => m.registryId);
  const [results, master, actuals, recs] = await Promise.all([
    loadResults(app, quarter.key),
    ids.length ? irecDevices(irec, ids) : Promise.resolve(new Map()),
    ids.length ? irecActuals(irec, quarter, ids) : Promise.resolve({}),
    activeReconciliations(app, quarter.key),
  ]);
  return mappings.map((m) => {
    const r = results[m.registryId];
    const a = (actuals as Awaited<ReturnType<typeof irecActuals>>)[m.registryId];
    const cells = ([0, 1, 2] as MonthIdx[]).map((mi): GridCell => {
      const month = monthKey(quarter, mi);
      const rec = recs.get(`${m.registryId}|${month}`) ?? null;
      const statementMWh = r ? r.monthlyMWh[mi] : null;
      const issuedMWh = a?.issuedMonthlyMWh?.[mi] ?? null;
      const actualMWh = a?.actualMWh[mi] ?? null;
      const banked = issuedMWh !== null && actualMWh !== null && issuedMWh > actualMWh + 1e-6;
      const status: CellStatus = !r ? "noData" : rec ? "reconciled" : issuedMWh === null ? "none" : statementMWh! < issuedMWh ? "short" : "covered";
      return { mi, month, status, statementMWh, issuedMWh, actualMWh, banked, reconciliation: rec };
    });
    return { registryId: m.registryId, outputName: m.outputName, site: m.site ?? null, ratingMw: master.get(m.registryId)?.capacityMw ?? null, cells };
  });
}

/* Planning --------------------------------------------------------------------------- */

export interface Item {
  registryId: string;
  mi: MonthIdx;
  /** fill missing hours from evidence before scaling */
  fill: boolean;
}

export interface Plan {
  registryId: string;
  outputName: string;
  mi: MonthIdx;
  month: string;
  issuedMWh: number;
  actualMWh: number | null;
  banked: boolean;
  ratingMw: number;
  processedAt: string;
  fill: boolean;
  result: Omit<MonthResult, "values">;
  /** this month's target, % above issued */
  targetPct: number;
  targetMWh: number;
  afterPct: number;
  inBand: boolean;
  /** share of the added energy that came from filling logger gaps (null when nothing added) */
  fillShare: number | null;
  daily: { before: number[]; fill: number[]; scale: number[] };
}

export interface Skipped {
  registryId: string;
  mi: MonthIdx;
  skipped: string;
}

interface Context {
  quarter: Quarter;
  mappings: DeviceMapping[];
  results: Record<string, HourlyResult>;
  rating: Map<string, number | null>;
  actuals: Awaited<ReturnType<typeof irecActuals>>;
  recs: Map<string, Reconciliation>;
  payloads: Map<string, Promise<HourlyPayload | null>>;
}

async function context(app: Db, irec: Db, quarter: Quarter, ids: string[]): Promise<Context> {
  const [mappings, results, recs] = await Promise.all([loadMappings(app), loadResults(app, quarter.key), activeReconciliations(app, quarter.key)]);
  const known = ids.filter((id) => mappings.some((m) => m.registryId === id));
  const [master, actuals] = known.length
    ? await Promise.all([irecDevices(irec, known), irecActuals(irec, quarter, known)])
    : [new Map(), {} as Awaited<ReturnType<typeof irecActuals>>];
  return {
    quarter, mappings, results, recs, actuals,
    rating: new Map(known.map((id) => [id, master.get(id)?.capacityMw ?? null])),
    payloads: new Map(),
  };
}

function payload(app: Db, ctx: Context, registryId: string) {
  let p = ctx.payloads.get(registryId);
  if (!p) ctx.payloads.set(registryId, (p = loadHourly(app, registryId, ctx.quarter)));
  return p;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

async function planOne(app: Db, ctx: Context, item: Item, rule: Rule): Promise<{ plan: Plan; values: (number | null)[]; filledIdx: number[] } | Skipped> {
  const { quarter } = ctx;
  const skip = (why: string): Skipped => ({ registryId: item.registryId, mi: item.mi, skipped: why });
  const mapping = ctx.mappings.find((m) => m.registryId === item.registryId);
  if (!mapping) return skip("Unknown device");
  const r = ctx.results[item.registryId];
  if (!r) return skip("No hourly data for this quarter");
  const month = monthKey(quarter, item.mi);
  if (ctx.recs.has(`${item.registryId}|${month}`)) return skip("Already reconciled; undo it first");
  const ratingMw = ctx.rating.get(item.registryId);
  if (!ratingMw) return skip("No rating (project capacity) in irec");
  const a = ctx.actuals[item.registryId];
  const issuedMWh = a?.issuedMonthlyMWh?.[item.mi] ?? null;
  if (issuedMWh === null) return skip("Nothing issued for this month");
  const p = await payload(app, ctx, item.registryId);
  if (!p) return skip("No hourly data for this quarter");

  const [from, to] = monthRange(quarter, item.mi);
  const hours = p.kwh.slice(from, to);

  const siblings: (number | null)[][] = [];
  if (mapping.site) {
    for (const m of ctx.mappings) {
      if (m.registryId === item.registryId || m.site !== mapping.site || !ctx.results[m.registryId]) continue;
      const sp = await payload(app, ctx, m.registryId);
      if (sp) siblings.push(sp.kwh.slice(from, to));
    }
  }
  const tPct = targetPct(rule, item.registryId, month);
  const targetMWh = issuedMWh * (1 + tPct / 100);
  const res = reconcileMonth({ hours, siblings, ratingKwh: ratingMw * 1000, targetKwh: targetMWh * 1000, fill: item.fill });

  const days = Math.round((to - from) / 24);
  const daily = { before: new Array<number>(days).fill(0), fill: new Array<number>(days).fill(0), scale: new Array<number>(days).fill(0) };
  const filled = new Set(res.filledIdx);
  hours.forEach((v, h) => {
    const d = Math.floor(h / 24);
    const after = res.values[h] ?? 0;
    if (filled.has(h)) daily.fill[d] += after / 1000;
    else {
      daily.before[d] += (v ?? 0) / 1000;
      daily.scale[d] += (after - (v ?? 0)) / 1000;
    }
  });
  const afterMWh = res.afterKwh / 1000;
  const afterPct = (afterMWh / issuedMWh - 1) * 100;
  const added = res.afterKwh - res.beforeKwh;
  const { values, ...summary } = res;
  return {
    values: values,
    filledIdx: res.filledIdx.map((h) => h + from),
    plan: {
      registryId: item.registryId, outputName: mapping.outputName, mi: item.mi, month, issuedMWh,
      actualMWh: a?.actualMWh[item.mi] ?? null, banked: a?.actualMWh[item.mi] != null && issuedMWh > a.actualMWh[item.mi]! + 1e-6,
      ratingMw, processedAt: r.processedAt, fill: item.fill, result: summary, targetPct: tPct, targetMWh, afterPct,
      inBand: round2(afterPct) >= rule.bandMinPct && round2(afterPct) <= rule.bandMaxPct,
      fillShare: added > 0 ? res.fillKwh / added : null, daily,
    },
  };
}

export async function previewItems(app: Db, irec: Db, quarter: Quarter, items: Item[], rule: Rule): Promise<(Plan | Skipped)[]> {
  const ctx = await context(app, irec, quarter, [...new Set(items.map((i) => i.registryId))]);
  const out: (Plan | Skipped)[] = [];
  for (const item of items) {
    const p = await planOne(app, ctx, item, rule);
    out.push("skipped" in p ? p : p.plan);
  }
  return out;
}

/* Apply / undo ------------------------------------------------------------------------ */

/** Rewrite hourly_results for a device-quarter from a full payload (totals, coverage, quality); keeps processed_at. */
export function resultsUpdate(p: HourlyPayload, quarter: Quarter) {
  const s = summarize(p, quarter);
  const toKwh = (mwh: number) => Math.round(mwh * 1e6) / 1000;
  return {
    text: `UPDATE hourly_results SET hours_written = $3, hours_missing = $4, total_kwh = $5, monthly_kwh = $6,
             daily_coverage = $7, daily_kwh = $8, quality = $9 WHERE registry_id = $1 AND quarter = $2`,
    params: [
      p.registryId, quarter.key, s.hoursWritten, s.hoursMissing, toKwh(s.totalMWh), s.monthlyMWh.map(toKwh),
      s.dailyCoverage, s.dailyMWh.map((v) => v * 1000),
      JSON.stringify({ missing: p.missing, estimated: p.estimated, gaps: p.gaps, filled: p.filled ?? [] }),
    ],
  };
}

export interface ApplyItem extends Item {
  /** processedAt of the hourly data the preview was based on */
  processedAt: string;
  note?: string;
}

export interface ApplyOutcome {
  registryId: string;
  mi: MonthIdx;
  status: "applied" | "partly applied" | "skipped";
  reason?: string;
  id?: number;
}

const STALE = /changed since it was reviewed|no longer active/;

export async function applyItems(app: Db, irec: Db, quarter: Quarter, items: ApplyItem[], rule: Rule, user: string | null): Promise<ApplyOutcome[]> {
  const ctx = await context(app, irec, quarter, [...new Set(items.map((i) => i.registryId))]);
  const out: ApplyOutcome[] = [];
  for (const item of items) {
    const skip = (reason: string) => out.push({ registryId: item.registryId, mi: item.mi, status: "skipped", reason });
    const planned = await planOne(app, ctx, item, rule);
    if ("skipped" in planned) {
      skip(planned.skipped);
      continue;
    }
    const { plan, values } = planned;
    if (plan.processedAt !== item.processedAt) {
      skip("The hourly data was re-processed after you reviewed it; review again");
      continue;
    }
    const note = item.note?.trim().slice(0, 500) || null;
    if (plan.banked && !note) {
      skip("Issued is above actual (banking): add a note");
      continue;
    }

    const p = (await payload(app, ctx, item.registryId))!;
    const [from] = monthRange(quarter, item.mi);
    const filled = new Set(planned.filledIdx);
    const changedAt: string[] = [];
    const changedKwh: number[] = [];
    const filledAt: string[] = [];
    const filledKwh: number[] = [];
    values.forEach((v, h) => {
      const i = from + h;
      if (v === null || v === p.kwh[i]) return;
      (filled.has(i) ? filledAt : changedAt).push(toInstant(quarter.start + i * HOUR));
      (filled.has(i) ? filledKwh : changedKwh).push(v);
    });
    const reasons = new Map(p.missing);
    const filledMissing = planned.filledIdx.map((i) => [i, reasons.get(i) ?? "missing"] as [number, string]);
    const next: HourlyPayload = {
      ...p,
      kwh: p.kwh.map((v, i) => (i >= from && i < from + values.length ? values[i - from] : v)),
      missing: p.missing.filter(([i]) => !filled.has(i)),
      filled: [...new Set([...(p.filled ?? []), ...planned.filledIdx])].sort((a, b) => a - b),
    };
    const r = plan.result;
    const [{ id }] = await app.query<{ id: number }>("SELECT nextval(pg_get_serial_sequence('reconciliations', 'id'))::int AS id");
    try {
      await app.transaction([
        { text: "SELECT assert_hourly_processed_at($1, $2, $3)", params: [item.registryId, quarter.key, item.processedAt] },
        {
          text: `INSERT INTO reconciliations (id, registry_id, quarter, month, issued_mwh, actual_mwh, rating_mw, before_kwh, after_kwh,
                   short_kwh, margin_pct, band_min_pct, band_max_pct, filled, hours_filled, hours_calm, hours_no_evidence, fill_kwh,
                   scale_kwh, factor, hours_raised, hours_at_rating, filled_missing, note, applied_by)
                 OVERRIDING SYSTEM VALUE
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
          params: [
            id, item.registryId, quarter.key, plan.month, plan.issuedMWh, plan.actualMWh, plan.ratingMw, r.beforeKwh, r.afterKwh,
            r.shortKwh, plan.targetPct, rule.bandMinPct, rule.bandMaxPct, item.fill, r.filledIdx.length, r.hoursCalm, r.hoursNoEvidence,
            r.fillKwh, r.scaleKwh, r.factor, r.hoursRaised, r.hoursAtRating, JSON.stringify(filledMissing), note, user,
          ],
        },
        {
          text: `UPDATE hourly_values hv SET original_kwh = COALESCE(hv.original_kwh, hv.kwh), kwh = v.kwh
                   FROM unnest($2::timestamptz[], $3::numeric[]) AS v(hour_start, kwh)
                  WHERE hv.registry_id = $1 AND hv.hour_start = v.hour_start`,
          params: [item.registryId, changedAt, changedKwh],
        },
        {
          text: `INSERT INTO hourly_values (registry_id, hour_start, kwh, estimated, reconciliation_id)
                 SELECT $1, h, k, true, $4 FROM unnest($2::timestamptz[], $3::numeric[]) AS v(h, k)`,
          params: [item.registryId, filledAt, filledKwh, id],
        },
        resultsUpdate(next, quarter),
      ]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (STALE.test(msg)) skip("The hourly data changed after you reviewed it; review again");
      else if (msg.includes("reconciliations_one_active")) skip("Already reconciled; undo it first");
      else throw e;
      continue;
    }
    ctx.payloads.set(item.registryId, Promise.resolve(next));
    ctx.recs.set(`${item.registryId}|${plan.month}`, { id } as Reconciliation);
    out.push({ registryId: item.registryId, mi: item.mi, status: r.shortKwh > 0 ? "partly applied" : "applied", id });
  }
  return out;
}

export class ReconciliationNotActiveError extends Error {}

/** Put back the readings a reconciliation replaced and remove the hours it filled. */
export async function undoReconciliation(app: Db, quarter: Quarter, id: number, user: string | null): Promise<void> {
  const [rec] = await app.query<{ registry_id: string; month: string; filled_missing: [number, string][] | string }>(
    `SELECT registry_id, month, filled_missing FROM reconciliations
      WHERE id = $1 AND quarter = $2 AND undone_at IS NULL AND superseded_at IS NULL`,
    [id, quarter.key],
  );
  if (!rec) throw new ReconciliationNotActiveError("This reconciliation is no longer active");
  const mi = ([0, 1, 2] as MonthIdx[]).find((i) => monthKey(quarter, i) === rec.month)!;
  const [from, to] = monthRange(quarter, mi);
  const p = await loadHourly(app, rec.registry_id, quarter);
  if (!p) throw new ReconciliationNotActiveError("No hourly data for this quarter");
  const startAt = toInstant(quarter.start + from * HOUR);
  const endAt = toInstant(quarter.start + to * HOUR);
  const originals = await app.query<{ hour_start: Date | string; original_kwh: string }>(
    `SELECT hour_start, original_kwh FROM hourly_values
      WHERE registry_id = $1 AND hour_start >= $2 AND hour_start < $3 AND original_kwh IS NOT NULL`,
    [rec.registry_id, startAt, endAt],
  );
  const filledMissing = (typeof rec.filled_missing === "string" ? JSON.parse(rec.filled_missing) : rec.filled_missing) as [number, string][];
  const unfill = new Set(filledMissing.map(([i]) => i));
  const kwh = [...p.kwh];
  for (const i of unfill) kwh[i] = null;
  for (const o of originals) {
    const i = Math.round((new Date(o.hour_start).getTime() + LOCAL_OFFSET_MIN * MINUTE - quarter.start) / HOUR);
    kwh[i] = Number(o.original_kwh);
  }
  const next: HourlyPayload = {
    ...p,
    kwh,
    missing: [...p.missing, ...filledMissing].sort((a, b) => a[0] - b[0]),
    filled: (p.filled ?? []).filter((i) => !unfill.has(i)),
  };
  try {
    await app.transaction([
      { text: "SELECT assert_reconciliation_active($1)", params: [id] },
      { text: "DELETE FROM hourly_values WHERE reconciliation_id = $1", params: [id] },
      {
        text: `UPDATE hourly_values SET kwh = original_kwh, original_kwh = NULL
                WHERE registry_id = $1 AND hour_start >= $2 AND hour_start < $3 AND original_kwh IS NOT NULL`,
        params: [rec.registry_id, startAt, endAt],
      },
      resultsUpdate(next, quarter),
      { text: "UPDATE reconciliations SET undone_at = now(), undone_by = $2 WHERE id = $1", params: [id, user] },
    ]);
  } catch (e) {
    if (STALE.test(e instanceof Error ? e.message : String(e))) throw new ReconciliationNotActiveError("This reconciliation is no longer active");
    throw e;
  }
}
