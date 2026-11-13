import { HOUR, MINUTE, fromExcelDate } from "../time";
import type { Series, TenMinSample } from "../types";
import { num, str, type Row } from "./xlsx";

/**
 * "Analogue Value Trending" export (JPP Mills): an `Interval` column plus one
 * column per machine, average kW over each interval. It comes in two shapes:
 *
 * - 10-min, headers `<turbine> Active Power`. The stamp marks the END of the
 *   bucket (00:10 = 00:00–00:10), so samples are shifted back 10 minutes and
 *   hourly kWh = mean of 6 samples.
 * - hourly, headers just `<turbine>`. The stamp marks the START of the hour
 *   (verified against the 10-min export: every overlapping hour equals the mean
 *   of its six 10-min samples), and an hour's average kW is its kWh.
 *
 * No register exists in either. Turbine columns are the contiguous labelled
 * cells after `Interval`; anything past the first blank header is scratch.
 */

export type PowerTrendFormat = "power-trend" | "power-trend-hourly";

export function findPowerTrendHeader(rows: Row[]): number {
  return rows.findIndex((r, i) => i < 20 && /^interval$/i.test(str(r[0])) && str(r[1]) !== "");
}

function turbineColumns(header: Row) {
  const cols: { i: number; alias: string }[] = [];
  for (let i = 1; i < header.length && str(header[i]); i++) cols.push({ i, alias: str(header[i]).replace(/active power/i, "").trim() });
  return cols;
}

/** The layout by stamp spacing, or null when no timestamps follow the header. */
export function powerTrendFormat(rows: Row[]): PowerTrendFormat | null {
  const h = findPowerTrendHeader(rows);
  if (h < 0) return null;
  let prev: number | null = null;
  let step = Infinity;
  for (let r = h + 1; r < rows.length; r++) {
    const ts = fromExcelDate(rows[r][0]);
    if (ts === null) continue;
    if (prev !== null && ts > prev) step = Math.min(step, ts - prev);
    prev = ts;
  }
  if (prev === null) return null;
  return step === HOUR ? "power-trend-hourly" : "power-trend";
}

export function parsePowerTrend(rows: Row[], sourceName: string): Series[] {
  const h = findPowerTrendHeader(rows);
  if (h < 0) throw new Error(`${sourceName}: no 'Interval' header row`);
  const cols = turbineColumns(rows[h]);
  return powerTrendFormat(rows) === "power-trend-hourly" ? parseHourly(rows, h, cols, sourceName) : parseTenMin(rows, h, cols, sourceName);
}

function parseTenMin(rows: Row[], h: number, cols: { i: number; alias: string }[], sourceName: string): Series[] {
  const series = cols.map((c) => ({ ...c, samples: [] as TenMinSample[] }));
  for (let r = h + 1; r < rows.length; r++) {
    const end = fromExcelDate(rows[r][0]);
    if (end === null) continue;
    for (const s of series) {
      const v = num(rows[r][s.i]);
      if (v !== null) s.samples.push({ ts: end - 10 * MINUTE, reg: null, pw: v });
    }
  }
  return series.map((s) => ({
    kind: "ten-min" as const,
    key: `power:${sourceName}:${s.alias}`,
    alias: s.alias,
    format: "power-trend" as const,
    sourceName,
    powerOnly: true,
    samples: s.samples.sort((a, b) => a.ts - b.ts),
  }));
}

function parseHourly(rows: Row[], h: number, cols: { i: number; alias: string }[], sourceName: string): Series[] {
  const series = cols.map((c) => ({ ...c, hours: new Map<number, number>(), blank: [] as number[] }));
  for (let r = h + 1; r < rows.length; r++) {
    const start = fromExcelDate(rows[r][0]);
    if (start === null) continue;
    for (const s of series) {
      if (s.hours.has(start)) throw new Error(`${sourceName}: duplicate hour ${new Date(start).toISOString()} for ${s.alias}`);
      const v = num(rows[r][s.i]);
      if (v === null) s.blank.push(start);
      else s.hours.set(start, v);
    }
  }
  return series.map((s) => ({
    kind: "hourly" as const,
    key: `power-hourly:${sourceName}:${s.alias}`,
    alias: s.alias,
    format: "power-trend-hourly" as const,
    sourceName,
    hours: [...s.hours.entries()].sort((a, b) => a[0] - b[0]),
    blankHours: s.blank.sort((a, b) => a - b),
  }));
}
