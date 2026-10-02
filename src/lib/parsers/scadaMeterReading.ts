import { MINUTE, fromExcelDate } from "../time";
import type { Series, TenMinSample } from "../types";
import { num, str, type Row } from "./xlsx";

/**
 * "Meter Reading\Operational Data - Wind Turbines" export (Uthiyur, Ottapidaram).
 * Turbine blocks are stacked in one sheet; the turbine name appears in column A
 * only on each block's first row. Column order differs between exports, so the
 * timestamp / lifetime register / power columns are located by header name.
 */

export function findScadaHeader(rows: Row[]): number {
  return rows.findIndex((r, i) => i < 40 && str(r[0]) === "System Name" && r.some((c) => str(c) === "Time Stamp"));
}

export function parseScada(rows: Row[], sourceName: string): Series[] {
  const h = findScadaHeader(rows);
  if (h < 0) throw new Error(`${sourceName}: no 'System Name' header row`);
  const header = rows[h].map(str);
  const tsCol = header.indexOf("Time Stamp");
  const regCol = header.findIndex((c) => c.startsWith("Lifetime Production"));
  const pwCol = header.findIndex((c) => c === "Power(kW)" || c.startsWith("Power"));
  if (regCol < 0 && pwCol < 0) throw new Error(`${sourceName}: neither a lifetime register nor a power column found`);

  const blocks = new Map<string, Map<number, TenMinSample>>();
  let current: Map<number, TenMinSample> | null = null;
  for (let i = h + 1; i < rows.length; i++) {
    const r = rows[i];
    const name = str(r[0]);
    const raw = fromExcelDate(r[tsCol]);
    // the logger occasionally emits off-grid stamps (10:09:36); keep only the 10-min grid
    const ts = raw !== null && raw % (10 * MINUTE) === 0 ? raw : null;
    if (name && !name.includes(",") && raw !== null) {
      const alias = name.replace(/\s+/g, "");
      current = blocks.get(alias) ?? new Map();
      blocks.set(alias, current);
    }
    if (!current || ts === null) continue;
    const reg = regCol >= 0 ? num(r[regCol]) : null;
    const pw = pwCol >= 0 ? num(r[pwCol]) : null;
    if (reg === null && pw === null) continue;
    current.set(ts, { ts, reg, pw });
  }

  return [...blocks.entries()].map(([alias, m]) => ({
    kind: "ten-min" as const,
    key: `scada:${sourceName}:${alias}`,
    alias,
    format: "scada-meter-reading" as const,
    sourceName,
    powerOnly: regCol < 0,
    samples: [...m.values()].sort((a, b) => a.ts - b.ts),
  }));
}
