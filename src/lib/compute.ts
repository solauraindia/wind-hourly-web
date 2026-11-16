import { buildHourly, tenMinGaps } from "./hourly";
import type { Quarter } from "./quarter";
import { HOUR } from "./time";
import type { Series, SourceFormat } from "./types";

/**
 * Everything the server needs to store one device's hourly statement for a
 * quarter. Built in the browser from the raw files, so only this compact
 * array crosses the network (raw uploads never leave the user's machine).
 */
export interface HourlyPayload {
  registryId: string;
  quarter: string;
  format: SourceFormat;
  sourceName: string;
  /** kWh per quarter hour (index 0 = first hour of the quarter); null = missing */
  kwh: (number | null)[];
  /** hour indices filled from the active-power average */
  estimated: number[];
  /** [hour index, reason] for every null in `kwh` */
  missing: [number, string][];
  /** 10-min SCADA gaps inside the quarter: [start, end, slots] (naive-local ms) */
  gaps: [number, number, number][];
  /** hour indices filled by a reconciliation (logger gaps estimated from evidence) */
  filled?: number[];
}

/** Long zip/file names are kept for reference but capped. */
export const SOURCE_NAME_MAX = 200;

export const quarterHours = (q: Quarter) => Math.round((q.end - q.start) / HOUR);

/**
 * Hourly kWh keep the raw files' precision: registers count whole kWh and power
 * is logged to about 0.1 kW, so an hour is whole kWh (3 decimals in MWh) or
 * 0.1 kWh (4 decimals in MWh), never finer.
 */
export const KWH_DECIMALS = 1;
export const roundTo = (v: number, decimals: number) => Math.round(v * 10 ** decimals) / 10 ** decimals;
export const roundKwh = (v: number) => roundTo(v, KWH_DECIMALS);

/** Decimals the values actually use (0 for whole kWh), at most KWH_DECIMALS. */
export function decimalsOf(values: (number | null)[]): number {
  let d = 0;
  for (const v of values) {
    if (v === null) continue;
    while (d < KWH_DECIMALS && Math.abs(roundTo(v, d) - v) > 1e-9) d++;
    if (d === KWH_DECIMALS) break;
  }
  return d;
}

export function computeHourly(series: Series, registryId: string, quarter: Quarter): HourlyPayload {
  const build = buildHourly(series);
  const n = quarterHours(quarter);
  const kwh: (number | null)[] = new Array(n).fill(null);
  const estimated: number[] = [];
  const missing: [number, string][] = [];
  for (let i = 0; i < n; i++) {
    const ts = quarter.start + i * HOUR;
    const v = build.hours.get(ts);
    if (v === undefined) {
      missing.push([i, build.dropped.get(ts) ?? "no source data for this hour"]);
      continue;
    }
    kwh[i] = roundKwh(v);
    if (build.estimated.has(ts)) estimated.push(i);
  }
  const inQ = (ts: number) => ts >= quarter.start && ts < quarter.end;
  return {
    registryId,
    quarter: quarter.key,
    format: series.format,
    sourceName: series.sourceName.slice(0, SOURCE_NAME_MAX),
    kwh,
    estimated,
    missing,
    gaps: series.kind === "ten-min" ? tenMinGaps(build.sampleTimes.filter(inQ)).map((g) => [g.start, g.end, g.slots]) : [],
  };
}
