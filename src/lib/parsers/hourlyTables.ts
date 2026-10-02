import { HOUR, fromExcelDate, naive } from "../time";
import type { Series } from "../types";
import { num, str, type Row } from "./xlsx";

/* ------------------------------------------------------------------------- */
/* hourly-long: Turbine No | Date & Time | Production  (NVL242)               */
/* ------------------------------------------------------------------------- */

export function findHourlyLongHeader(rows: Row[]) {
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const hdr = rows[i].map((c) => str(c).toLowerCase());
    const turbine = hdr.findIndex((c) => c.startsWith("turbine") || c === "wtg" || c === "loc no");
    const dt = hdr.findIndex((c) => c.includes("date") && c.includes("time"));
    const val = hdr.findIndex((c) => c === "production" || c.startsWith("generation") || c.startsWith("energy"));
    if (turbine >= 0 && dt >= 0 && val >= 0) return { row: i, turbine, dt, val };
  }
  return null;
}

/** '1/1/2026\n00:00' (m/d/yyyy + HH:MM), a real Date cell, or '2026-01-01 00:00'. */
function parseDateTime(c: Row[number]): number | null {
  const d = fromExcelDate(c);
  if (d !== null) return d;
  const s = str(c);
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/);
  if (m) return naive(+m[3], +m[1], +m[2], +m[4], +m[5]);
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (m) return naive(+m[1], +m[2], +m[3], +m[4], +m[5]);
  return null;
}

export function parseHourlyLong(rows: Row[], sourceName: string): Series[] {
  const h = findHourlyLongHeader(rows);
  if (!h) throw new Error(`${sourceName}: no 'Turbine / Date & Time / Production' header`);
  const by = new Map<string, Map<number, number>>();
  for (let i = h.row + 1; i < rows.length; i++) {
    const r = rows[i];
    const alias = str(r[h.turbine]);
    const ts = parseDateTime(r[h.dt]);
    const v = num(r[h.val]);
    if (!alias || ts === null || v === null) continue;
    const m = by.get(alias) ?? new Map<number, number>();
    if (m.has(ts)) throw new Error(`${sourceName}: duplicate hour ${new Date(ts).toISOString()} for ${alias}`);
    m.set(ts, v);
    by.set(alias, m);
  }
  return [...by.entries()].map(([alias, m]) => ({
    kind: "hourly" as const,
    key: `hourly:${sourceName}:${alias}`,
    alias,
    format: "hourly-long" as const,
    sourceName,
    hours: [...m.entries()].sort((a, b) => a[0] - b[0]),
    blankHours: [],
  }));
}

/* ------------------------------------------------------------------------- */
/* daily-matrix: Location no. | Date | Month | 1 … 24 | Grand Total  (SMTKP)  */
/* Hour column N holds kWh for the hour starting N-1:00.                     */
/* ------------------------------------------------------------------------- */

export function findDailyMatrixHeader(rows: Row[]) {
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const r = rows[i];
    const hourCols: number[] = [];
    for (let h = 1; h <= 24; h++) {
      const c = r.findIndex((v) => v === h || str(v) === String(h));
      if (c < 0) break;
      hourCols.push(c);
    }
    if (hourCols.length !== 24) continue;
    const labels = r.map((c) => str(c).toLowerCase());
    const loc = labels.findIndex((c) => c.startsWith("location") || c.startsWith("loc") || c.startsWith("turbine") || c === "wtg");
    const date = labels.findIndex((c) => c === "date");
    const total = labels.findIndex((c) => c.includes("total"));
    if (loc >= 0 && date >= 0) return { row: i, loc, date, total, hourCols };
  }
  return null;
}

export function parseDailyMatrix(rows: Row[], sourceName: string): Series[] {
  const h = findDailyMatrixHeader(rows);
  if (!h) throw new Error(`${sourceName}: no 'Location / Date / 1..24' header`);
  const by = new Map<string, { hours: Map<number, number>; blank: number[] }>();
  for (let i = h.row + 1; i < rows.length; i++) {
    const r = rows[i];
    const alias = str(r[h.loc]);
    const day = fromExcelDate(r[h.date]);
    if (!alias || day === null) continue;
    const entry = by.get(alias) ?? { hours: new Map<number, number>(), blank: [] as number[] };
    by.set(alias, entry);
    let sum = 0;
    h.hourCols.forEach((col, k) => {
      const ts = day + k * HOUR;
      const v = num(r[col]);
      if (v === null) entry.blank.push(ts);
      else {
        entry.hours.set(ts, v);
        sum += v;
      }
    });
    const gt = h.total >= 0 ? num(r[h.total]) : null;
    if (gt !== null && Math.abs(sum - gt) > 0.51) {
      throw new Error(`${sourceName}: ${alias} ${new Date(day).toISOString().slice(0, 10)} hours sum ${sum} ≠ total ${gt}`);
    }
  }
  return [...by.entries()].map(([alias, e]) => ({
    kind: "hourly" as const,
    key: `matrix:${sourceName}:${alias}`,
    alias,
    format: "daily-matrix" as const,
    sourceName,
    hours: [...e.hours.entries()].sort((a, b) => a[0] - b[0]),
    blankHours: e.blank.sort((a, b) => a - b),
  }));
}
