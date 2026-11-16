import "server-only";
import { decimalsOf, roundKwh, roundTo, type HourlyPayload } from "./compute";
import type { Db } from "./db";
import { parseQuarter, type Quarter } from "./quarter";
import { monthKey, monthRange, resultsUpdate, type MonthIdx } from "./reconcileStore";
import { loadHourly } from "./store";
import { HOUR, LOCAL_OFFSET_MIN, MINUTE } from "./time";

/**
 * One-off: bring data stored at 0.001 kWh to the raw files' precision (see roundKwh).
 *
 * - plain hours and the originals kept under reconciled hours: rounded to 0.1 kWh;
 * - reconciled months: the month's precision from its rounded readings (whole kWh
 *   or 0.1 kWh), with the reconciled hours rounded so the month total stays on
 *   its target at that precision (largest remainder), never above the rating;
 * - the reconciliation record's before/after/scale and the quarter totals follow.
 *
 * processed_at is kept, so reconciliations stay active. Idempotent.
 */

interface Row {
  hour_start: Date | string;
  kwh: string;
  original_kwh: string | null;
  reconciliation_id: number | null;
}

interface Rec {
  id: number;
  month: string;
  rating_mw: string;
  before_kwh: string;
  after_kwh: string;
  fill_kwh: string;
  scale_kwh: string;
}

export interface MonthChange {
  id: number;
  month: string;
  decimals: number;
  beforeKwh: [number, number];
  afterKwh: [number, number];
}

export interface DeviceQuarterChange {
  registryId: string;
  quarter: string;
  hoursChanged: number;
  totalKwh: [number, number];
  reconciliations: MonthChange[];
}

const fromInstant = (d: Date | string) => new Date(d).getTime() + LOCAL_OFFSET_MIN * MINUTE;
const sum = (v: number[]) => v.reduce((s, x) => s + x, 0);

/** Round `values` to `dp` so they add up to `target` (already at `dp`), none above `cap`. */
export function roundToTotal(values: number[], dp: number, target: number, cap: number): number[] {
  const unit = 10 ** dp;
  const scaled = values.map((v) => Math.round(v * unit * 1e6) / 1e6);
  const floors = scaled.map((x) => Math.floor(x + 1e-9));
  let need = Math.round(target * unit) - sum(floors);
  const order = scaled.map((x, i) => [x - floors[i], i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (need <= 0) break;
    if ((floors[i] + 1) / unit > cap) continue;
    floors[i] += 1;
    need -= 1;
  }
  return floors.map((f) => f / unit);
}

async function backfillOne(db: Db, registryId: string, quarter: Quarter, apply: boolean): Promise<DeviceQuarterChange | null> {
  const p = await loadHourly(db, registryId, quarter);
  if (!p) return null;
  const rows = await db.query<Row>(
    `SELECT hour_start, kwh, original_kwh, reconciliation_id FROM hourly_values
      WHERE registry_id = $1 AND hour_start >= $2 AND hour_start < $3`,
    [registryId, new Date(quarter.start - LOCAL_OFFSET_MIN * MINUTE).toISOString(), new Date(quarter.end - LOCAL_OFFSET_MIN * MINUTE).toISOString()],
  );
  const recs = await db.query<Rec>(
    `SELECT id, month, rating_mw, before_kwh, after_kwh, fill_kwh, scale_kwh FROM reconciliations
      WHERE registry_id = $1 AND quarter = $2 AND undone_at IS NULL AND superseded_at IS NULL`,
    [registryId, quarter.key],
  );

  const at = (r: Row) => Math.round((fromInstant(r.hour_start) - quarter.start) / HOUR);
  const byIdx = new Map(rows.map((r) => [at(r), r]));
  const kwh: (number | null)[] = [...p.kwh];
  const original = new Map<number, number>();
  // plain hours and kept originals
  for (const [i, r] of byIdx) {
    if (r.original_kwh !== null) original.set(i, roundKwh(Number(r.original_kwh)));
    else if (r.reconciliation_id === null) kwh[i] = roundKwh(Number(r.kwh));
  }

  const changes: MonthChange[] = [];
  const recUpdates: { text: string; params: unknown[] }[] = [];
  for (const rec of recs) {
    const mi = ([0, 1, 2] as MonthIdx[]).find((m) => monthKey(quarter, m) === rec.month);
    if (mi === undefined) continue;
    const [from, to] = monthRange(quarter, mi);
    const adjusted: number[] = [];
    const filled: number[] = [];
    const raw: number[] = [];
    for (let i = from; i < to; i++) {
      const r = byIdx.get(i);
      if (!r) continue;
      if (r.reconciliation_id === rec.id) filled.push(i);
      else if (original.has(i)) {
        adjusted.push(i);
        raw.push(original.get(i)!);
      } else raw.push(kwh[i]!);
    }
    const dp = decimalsOf(raw);
    const changed = [...adjusted, ...filled];
    const fixed = sum(raw) - sum(adjusted.map((i) => original.get(i)!)); // untouched hours, already rounded
    const exact = changed.map((i) => Number(byIdx.get(i)!.kwh));
    const target = roundTo(fixed + sum(exact), dp);
    const rounded = roundToTotal(exact, dp, roundTo(target - fixed, dp), Number(rec.rating_mw) * 1000);
    changed.forEach((i, k) => (kwh[i] = rounded[k]));

    const beforeKwh = roundTo(sum(raw), 3);
    const afterKwh = roundTo(fixed + sum(rounded), 3);
    // fill_kwh is the estimate before scaling, which rounding doesn't change; scaling takes the difference
    const fillKwh = Number(rec.fill_kwh);
    const scaleKwh = roundTo(afterKwh - beforeKwh - fillKwh, 3);
    changes.push({ id: rec.id, month: rec.month, decimals: dp, beforeKwh: [Number(rec.before_kwh), beforeKwh], afterKwh: [Number(rec.after_kwh), afterKwh] });
    const next = [beforeKwh, afterKwh, fillKwh, scaleKwh];
    if (next.some((v, k) => v !== Number([rec.before_kwh, rec.after_kwh, rec.fill_kwh, rec.scale_kwh][k]))) {
      recUpdates.push({
        text: "UPDATE reconciliations SET before_kwh = $2, after_kwh = $3, fill_kwh = $4, scale_kwh = $5 WHERE id = $1",
        params: [rec.id, ...next],
      });
    }
  }

  const hours: string[] = [];
  const values: number[] = [];
  const originals: (number | null)[] = [];
  for (const [i, r] of byIdx) {
    const o = r.original_kwh === null ? null : original.get(i)!;
    if (kwh[i] === Number(r.kwh) && (o === null || o === Number(r.original_kwh))) continue;
    hours.push(new Date(r.hour_start).toISOString());
    values.push(kwh[i]!);
    originals.push(o);
  }
  const totalBefore = roundTo(sum(p.kwh.map((v) => v ?? 0)), 3);
  const totalAfter = roundTo(sum(kwh.map((v) => v ?? 0)), 3);
  if (!hours.length && !recUpdates.length) return null;

  if (apply) {
    const next: HourlyPayload = { ...p, kwh };
    await db.transaction([
      {
        text: `UPDATE hourly_values hv SET kwh = v.kwh, original_kwh = v.original_kwh
                 FROM unnest($2::timestamptz[], $3::numeric[], $4::numeric[]) AS v(hour_start, kwh, original_kwh)
                WHERE hv.registry_id = $1 AND hv.hour_start = v.hour_start`,
        params: [registryId, hours, values, originals],
      },
      ...recUpdates,
      resultsUpdate(next, quarter),
    ]);
  }
  return { registryId, quarter: quarter.key, hoursChanged: hours.length, totalKwh: [totalBefore, totalAfter], reconciliations: changes };
}

export async function backfillPrecision(db: Db, apply: boolean): Promise<DeviceQuarterChange[]> {
  const pairs = await db.query<{ registry_id: string; quarter: string }>(
    "SELECT registry_id, quarter FROM hourly_results ORDER BY quarter, registry_id",
  );
  const out: DeviceQuarterChange[] = [];
  for (const { registry_id, quarter } of pairs) {
    const q = parseQuarter(quarter);
    if (!q) continue;
    const c = await backfillOne(db, registry_id, q, apply);
    if (c) out.push(c);
  }
  return out;
}
