import { MINUTE, fromExcelDate } from "../time";
import type { Series, TenMinSample } from "../types";
import { num, str, type Row } from "./xlsx";

/**
 * "Analogue Value Trending" export (JPP Mills): an `Interval` column plus one
 * `<turbine> Active Power` column per machine, 10-min average kW. The interval
 * stamp marks the END of the bucket (00:10 = 00:00–00:10), so samples are
 * shifted back 10 minutes. No register exists — hourly kWh = mean of 6 samples.
 */

export function findPowerTrendHeader(rows: Row[]): number {
  return rows.findIndex(
    (r, i) => i < 20 && /^interval$/i.test(str(r[0])) && r.slice(1).some((c) => /active power/i.test(str(c))),
  );
}

export function parsePowerTrend(rows: Row[], sourceName: string): Series[] {
  const h = findPowerTrendHeader(rows);
  if (h < 0) throw new Error(`${sourceName}: no 'Interval' header row`);
  const cols = rows[h]
    .map((c, i) => ({ i, alias: str(c).replace(/active power/i, "").trim() }))
    .filter((c) => c.i > 0 && c.alias);
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
