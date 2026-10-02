import ExcelJS from "exceljs";
import type { ActualsSnapshot } from "./actuals/types";
import type { Quarter } from "./quarter";
import type { Device, HourlyResult } from "./types";

export interface SummaryRow {
  sl: number;
  deviceId: string;
  client: string;
  registryId: string;
  deviceName: string;
  actual: [number | null, number | null, number | null];
  actualTotal: number | null;
  eligible: number | null;
  hourly: [number, number, number] | null;
  hourlyTotal: number | null;
  /** actual total − hourly total */
  diff: number | null;
  /** min(eligible, hourly total) — the volume that can be claimed */
  min: number | null;
  issued: number | null;
}

const sum3 = (v: (number | null)[]) => (v.every((x) => x === null) ? null : v.reduce<number>((s, x) => s + (x ?? 0), 0));

/** Mirrors "Sheet1" of the quarterly delivery workbook. */
export function buildSummary(devices: Device[], results: Record<string, HourlyResult>, actuals: ActualsSnapshot): SummaryRow[] {
  return devices.map((d, i) => {
    const a = actuals.rows[d.registryId];
    const r = results[d.id];
    const actual = a?.actualMWh ?? [null, null, null];
    const actualTotal = sum3(actual);
    const eligible = a?.eligibleMWh ?? actualTotal;
    const hourlyTotal = r ? r.totalMWh : null;
    return {
      sl: i + 1,
      deviceId: d.id,
      client: d.client,
      registryId: d.registryId,
      deviceName: d.facilityId,
      actual,
      actualTotal,
      eligible,
      hourly: r ? r.monthlyMWh : null,
      hourlyTotal,
      diff: actualTotal !== null && hourlyTotal !== null ? actualTotal - hourlyTotal : null,
      min: eligible !== null && hourlyTotal !== null ? Math.min(eligible, hourlyTotal) : null,
      issued: a?.issuedMWh ?? null,
    };
  });
}

export function summaryTotals(rows: SummaryRow[]) {
  const t = (f: (r: SummaryRow) => number | null) => sum3(rows.map(f));
  return {
    actual: [0, 1, 2].map((i) => t((r) => r.actual[i])) as (number | null)[],
    actualTotal: t((r) => r.actualTotal),
    eligible: t((r) => r.eligible),
    hourly: [0, 1, 2].map((i) => t((r) => r.hourly?.[i] ?? null)) as (number | null)[],
    hourlyTotal: t((r) => r.hourlyTotal),
    diff: t((r) => r.diff),
    min: t((r) => r.min),
    issued: t((r) => r.issued),
  };
}

/** Excel export laid out like the delivery workbook, with live formulas for the derived columns. */
export async function summaryWorkbook(quarter: Quarter, rows: SummaryRow[]): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(`${quarter.key} Summary`, { views: [{ state: "frozen", ySplit: 4, xSplit: 5 }] });
  const [m1, m2, m3] = quarter.monthLabels;
  ws.getCell("F3").value = "Actual Generation";
  ws.mergeCells("F3:H3");
  ws.getCell("K3").value = "As per Hourly Statement";
  ws.mergeCells("K3:M3");
  ws.getRow(4).values = [
    undefined, "Sl No", "Client", "Device ID", "Device Name",
    m1, m2, m3, "Total", "Eligible Credits after Banking",
    m1, m2, m3, "Total", "Diff", "Min", "Issued as per Evident",
  ];
  for (const r of [3, 4]) ws.getRow(r).font = { bold: true };

  rows.forEach((r, i) => {
    const n = 5 + i;
    const row = ws.getRow(n);
    row.values = [
      undefined, r.sl, r.client, r.registryId, r.deviceName,
      r.actual[0], r.actual[1], r.actual[2],
      { formula: `SUM(F${n}:H${n})` },
      r.eligible !== null && r.actualTotal !== null && Math.abs(r.eligible - r.actualTotal) < 1e-6 ? { formula: `I${n}` } : r.eligible,
      r.hourly?.[0] ?? null, r.hourly?.[1] ?? null, r.hourly?.[2] ?? null,
      r.hourly ? { formula: `SUM(K${n}:M${n})` } : null,
      r.hourly ? { formula: `I${n}-N${n}` } : null,
      r.hourly ? { formula: `MIN(J${n},N${n})` } : null,
      r.issued,
    ] as ExcelJS.CellValue[];
  });
  const last = 4 + rows.length;
  const total = ws.getRow(last + 1);
  total.getCell(3).value = "Total";
  for (const col of ["F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q"]) {
    ws.getCell(`${col}${last + 1}`).value = { formula: `SUM(${col}5:${col}${last})` };
  }
  total.font = { bold: true };
  for (let c = 6; c <= 17; c++) ws.getColumn(c).numFmt = "#,##0.000";
  ws.columns.forEach((c, i) => (c.width = [4, 7, 40, 14, 44, 11, 11, 11, 12, 16, 11, 11, 11, 12, 11, 12, 14][i]));
  return new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}
