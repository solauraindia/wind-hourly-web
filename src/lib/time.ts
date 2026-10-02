/**
 * Site-local timestamps are kept as "naive" epoch milliseconds: the wall-clock
 * reading encoded as if it were UTC (Date.UTC(y, m, d, h, mi)). This matches
 * how Excel stores dates (no zone) and keeps hour arithmetic DST-free.
 */

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const LOCAL_TZ_NAME = "Asia/Kolkata";
export const LOCAL_OFFSET_MIN = 330;

export function naive(y: number, m: number, d: number, h = 0, mi = 0): number {
  return Date.UTC(y, m - 1, d, h, mi);
}

const pad = (n: number) => String(n).padStart(2, "0");

export function fmtNaive(ts: number, withTime = true): string {
  const d = new Date(ts);
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return withTime ? `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00` : date;
}

const offsetSuffix = (() => {
  const sign = LOCAL_OFFSET_MIN >= 0 ? "+" : "-";
  const abs = Math.abs(LOCAL_OFFSET_MIN);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
})();

/** 2026-04-01T00:00:00+05:30 */
export function isoLocal(ts: number): string {
  return fmtNaive(ts).replace(" ", "T") + offsetSuffix;
}

/** 2026-03-31T18:30:00Z */
export function isoUtc(ts: number): string {
  return fmtNaive(ts - LOCAL_OFFSET_MIN * MINUTE).replace(" ", "T") + "Z";
}

export const floorHour = (ts: number) => ts - (((ts % HOUR) + HOUR) % HOUR);

/** Excel cells read by exceljs come back as JS Dates whose UTC fields hold the wall clock. */
export function fromExcelDate(v: unknown): number | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return Math.round(v.getTime() / 1000) * 1000;
  if (typeof v === "number" && v > 20000 && v < 80000) {
    // raw serial date (1900 system)
    return Math.round(((v - 25569) * DAY) / 1000) * 1000;
  }
  return null;
}
