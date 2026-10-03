import { LOCAL_OFFSET_MIN, naive } from "./time";

export type QuarterKey = `${number}-Q${1 | 2 | 3 | 4}`;

export interface Quarter {
  key: QuarterKey;
  year: number;
  q: 1 | 2 | 3 | 4;
  /** inclusive naive-local start */
  start: number;
  /** exclusive naive-local end */
  end: number;
  /** [year, month(1-12)] for each of the three months */
  months: [number, number][];
  monthLabels: string[];
  /** e.g. 2026Q2 — used in output file names */
  compact: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function parseQuarter(key: string | undefined | null): Quarter | null {
  const m = key?.match(/^(\d{4})-Q([1-4])$/);
  if (!m) return null;
  const year = Number(m[1]);
  const q = Number(m[2]) as 1 | 2 | 3 | 4;
  const firstMonth = (q - 1) * 3 + 1;
  const months: [number, number][] = [0, 1, 2].map((i) => [year, firstMonth + i]);
  return {
    key: `${year}-Q${q}` as QuarterKey,
    year,
    q,
    start: naive(year, firstMonth, 1),
    end: q === 4 ? naive(year + 1, 1, 1) : naive(year, firstMonth + 3, 1),
    months,
    monthLabels: months.map(([, mo]) => MONTHS[mo - 1]),
    compact: `${year}Q${q}`,
  };
}

/** Calendar date at the sites (IST), whatever the server's own timezone is (UTC on Vercel). */
function siteToday(now: Date): { year: number; month0: number } {
  const local = new Date(now.getTime() + LOCAL_OFFSET_MIN * 60_000);
  return { year: local.getUTCFullYear(), month0: local.getUTCMonth() };
}

/** Most recently completed quarter relative to `now` — the usual reporting target. */
export function defaultQuarterKey(now = new Date()): QuarterKey {
  const { year, month0 } = siteToday(now);
  const q = Math.floor(month0 / 3); // 0-based current quarter
  return q === 0 ? (`${year - 1}-Q4` as QuarterKey) : (`${year}-Q${q}` as QuarterKey);
}

export function recentQuarters(count = 8, now = new Date()): QuarterKey[] {
  const out: QuarterKey[] = [];
  const today = siteToday(now);
  let year = today.year;
  let q = Math.floor(today.month0 / 3) + 1;
  for (let i = 0; i < count; i++) {
    out.push(`${year}-Q${q}` as QuarterKey);
    q -= 1;
    if (q === 0) {
      q = 4;
      year -= 1;
    }
  }
  return out;
}

export function monthIndexInQuarter(quarter: Quarter, ts: number): number {
  const d = new Date(ts);
  return d.getUTCFullYear() * 12 + d.getUTCMonth() - (quarter.year * 12 + quarter.months[0][1] - 1);
}
