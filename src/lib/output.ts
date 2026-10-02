import ExcelJS from "exceljs";
import { buildHourly, tenMinGaps } from "./hourly";
import { monthIndexInQuarter, type Quarter } from "./quarter";
import { outputFileName } from "./registry";
import { DAY, HOUR, LOCAL_TZ_NAME, fmtNaive, isoLocal, isoUtc } from "./time";
import type { Device, HourlyResult, Series } from "./types";

/** Column order of meter-data-template.xlsx — the output contract; do not reorder. */
export const TEMPLATE_COLUMNS = [
  "datetime_start_local",
  "local_timezone",
  "datetime_start_utc",
  "value",
  "unit_of_measurement",
  "meter_id",
  "eac_facility_id",
  "eac_registry_id",
] as const;

export type Unit = "MWh" | "kWh";

const idCell = (s: string) => (/^\d{1,15}$/.test(s) ? Number(s) : s || null);

/**
 * Turn one parsed series into the template workbook for one device and quarter.
 * Only hours inside the quarter are written; every quarter hour without a value
 * is listed on the MissingData sheet with the reason it is missing.
 */
export async function renderHourly(
  series: Series,
  device: Device,
  quarter: Quarter,
  unit: Unit,
): Promise<{ xlsx: Uint8Array; result: HourlyResult }> {
  const build = buildHourly(series);
  const inQ = (ts: number) => ts >= quarter.start && ts < quarter.end;
  const hours = [...build.hours.entries()].filter(([ts]) => inQ(ts)).sort((a, b) => a[0] - b[0]);
  const scale = unit === "MWh" ? 1 / 1000 : 1;
  const decimals = unit === "MWh" ? 6 : 3;
  const round = (v: number) => Math.round(v * 10 ** decimals) / 10 ** decimals;

  const wb = new ExcelJS.Workbook();
  wb.creator = "Wind Hourly";
  const ws = wb.addWorksheet("MeterData", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.addRow([...TEMPLATE_COLUMNS]).font = { bold: true };
  for (const [ts, kwh] of hours) {
    ws.addRow([
      isoLocal(ts),
      LOCAL_TZ_NAME,
      isoUtc(ts),
      round(kwh * scale),
      unit,
      idCell(device.meterId),
      device.facilityId || null,
      device.registryId || null,
    ]);
  }
  ws.columns.forEach((c, i) => (c.width = [26, 15, 22, 12, 20, 16, 44, 18][i]));

  // Data-quality sheet ---------------------------------------------------------
  const quarterHours = Math.round((quarter.end - quarter.start) / HOUR);
  const missing: [number, string][] = [];
  for (let ts = quarter.start; ts < quarter.end; ts += HOUR) {
    if (build.hours.has(ts)) continue;
    missing.push([ts, build.dropped.get(ts) ?? "no source data for this hour"]);
  }
  const estimated = [...build.estimated].filter(inQ).sort((a, b) => a - b);
  const gaps = tenMinGaps(build.sampleTimes.filter(inQ));

  const info = wb.addWorksheet("MissingData");
  const lines: (string | number)[][] = [
    [`Device: ${device.outputName} (${device.registryId})`],
    [`Source: ${series.sourceName}`],
    [`Quarter: ${quarter.key}  ${fmtNaive(quarter.start, false)} → ${fmtNaive(quarter.end - DAY, false)} (local ${LOCAL_TZ_NAME})`],
    [`Hours in quarter: ${quarterHours}`],
    [`Hourly rows in MeterData: ${hours.length}`],
    [`  of which estimated from avg power (no register): ${estimated.length}`],
    [`Hours missing: ${missing.length}`],
    [],
    ["Missing hours"],
    ["hour_start_local", "reason"],
    ...missing.map(([ts, r]) => [fmtNaive(ts), r]),
    [],
    ["Hours estimated from active-power average instead of the energy register"],
    ["hour_start_local"],
    ...estimated.map((ts) => [fmtNaive(ts)]),
  ];
  if (series.kind === "ten-min") {
    lines.push([], ["10-min SCADA gaps (consecutive missing timestamps collapsed)"], ["gap_start_local", "gap_end_local", "missing_slot_count", "duration_minutes"]);
    for (const g of gaps) lines.push([fmtNaive(g.start), fmtNaive(g.end), g.slots, g.slots * 10]);
  }
  for (const l of lines) info.addRow(l);
  info.columns.forEach((c, i) => (c.width = [24, 44, 20, 18][i]));

  // Result summary ---------------------------------------------------------------
  const days = Math.round((quarter.end - quarter.start) / DAY);
  const dailyCount = new Array<number>(days).fill(0);
  const dailyMWh = new Array<number>(days).fill(0);
  const monthly: [number, number, number] = [0, 0, 0];
  for (const [ts, kwh] of hours) {
    const d = Math.floor((ts - quarter.start) / DAY);
    dailyCount[d] += 1;
    dailyMWh[d] += kwh / 1000;
    monthly[monthIndexInQuarter(quarter, ts)] += kwh / 1000;
  }
  const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

  const result: HourlyResult = {
    deviceId: device.id,
    quarter: quarter.key,
    format: series.format,
    sourceName: series.sourceName,
    fileName: outputFileName(device, quarter.compact),
    unit,
    hoursInQuarter: quarterHours,
    hoursWritten: hours.length,
    hoursEstimated: estimated.length,
    hoursMissing: missing.length,
    // sum of the rounded values actually written, so the summary ties to the file
    totalMWh: r6(hours.reduce((s, [, kwh]) => s + round(kwh * scale), 0) / (unit === "MWh" ? 1 : 1000)),
    monthlyMWh: monthly.map(r6) as [number, number, number],
    dailyCoverage: dailyCount.map((c) => c / 24),
    dailyMWh: dailyMWh.map((v) => Math.round(v * 1000) / 1000),
    processedAt: new Date().toISOString(),
  };
  const buf = await wb.xlsx.writeBuffer();
  return { xlsx: new Uint8Array(buf as ArrayBuffer), result };
}
