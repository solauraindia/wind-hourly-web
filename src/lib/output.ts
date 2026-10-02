import ExcelJS from "exceljs";
import type { HourlyPayload } from "./compute";
import type { Quarter } from "./quarter";
import { DAY, HOUR, LOCAL_TZ_NAME, fmtNaive, isoLocal, isoUtc } from "./time";
import type { Device } from "./types";

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

export const outputFileName = (device: Device, quarter: Quarter) => `${device.outputName}_hourly_${quarter.compact}.xlsx`;

const idCell = (s: string) => (/^\d{1,15}$/.test(s) ? Number(s) : s || null);

/**
 * Render the template workbook for one device and quarter. MeterData holds
 * only hours that have a value; MissingData lists every other quarter hour
 * with its reason, the power-estimated hours and the raw 10-min gaps.
 */
export async function renderMeterXlsx(p: HourlyPayload, device: Device, quarter: Quarter, unit: Unit): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Wind Hourly";
  const ws = wb.addWorksheet("MeterData", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.addRow([...TEMPLATE_COLUMNS]).font = { bold: true };
  let written = 0;
  p.kwh.forEach((kwh, i) => {
    if (kwh === null) return;
    const ts = quarter.start + i * HOUR;
    written++;
    ws.addRow([
      isoLocal(ts),
      LOCAL_TZ_NAME,
      isoUtc(ts),
      // kWh carry 3 decimals, so MWh are exact at 6
      unit === "MWh" ? Math.round(kwh * 1000) / 1e6 : kwh,
      unit,
      idCell(device.meterId),
      device.facilityId || null,
      device.registryId || null,
    ]);
  });
  ws.columns.forEach((c, i) => (c.width = [26, 15, 22, 12, 20, 16, 44, 18][i]));

  const at = (i: number) => fmtNaive(quarter.start + i * HOUR);
  const info = wb.addWorksheet("MissingData");
  const lines: (string | number)[][] = [
    [`Device: ${device.outputName} (${device.registryId})`],
    [`Source: ${p.sourceName}`],
    [`Quarter: ${quarter.key}  ${fmtNaive(quarter.start, false)} → ${fmtNaive(quarter.end - DAY, false)} (local ${LOCAL_TZ_NAME})`],
    [`Hours in quarter: ${p.kwh.length}`],
    [`Hourly rows in MeterData: ${written}`],
    [`  of which estimated from avg power (no register): ${p.estimated.length}`],
    [`Hours missing: ${p.missing.length}`],
    [],
    ["Missing hours"],
    ["hour_start_local", "reason"],
    ...p.missing.map(([i, reason]) => [at(i), reason]),
    [],
    ["Hours estimated from active-power average instead of the energy register"],
    ["hour_start_local"],
    ...p.estimated.map((i) => [at(i)]),
  ];
  if (p.gaps.length) {
    lines.push([], ["10-min SCADA gaps (consecutive missing timestamps collapsed)"], ["gap_start_local", "gap_end_local", "missing_slot_count", "duration_minutes"]);
    for (const [s, e, slots] of p.gaps) lines.push([fmtNaive(s), fmtNaive(e), slots, slots * 10]);
  }
  for (const l of lines) info.addRow(l);
  info.columns.forEach((c, i) => (c.width = [24, 44, 20, 18][i]));
  return new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}
