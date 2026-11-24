import ExcelJS from "exceljs";
import { KWH_DECIMALS, decimalsOf, roundTo, type HourlyPayload } from "./compute";
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
export const missingFileName = (device: Device, quarter: Quarter) => `${device.outputName}_missing_${quarter.compact}.xlsx`;

/** The registry the devices are issued in, by its id in the validator's approved list (I-REC via Evident). */
export const EAC_REGISTRY_ID = "evident";
/**
 * Same zone as LOCAL_TZ_NAME under its older IANA name: the Bridge T-EAC validator
 * (provider-meter-data-validation.cfesuite.com) rejects "Asia/Kolkata" but accepts this.
 */
export const FILE_TZ_NAME = "Asia/Calcutta";

const idCell = (s: string) => (/^\d{1,15}$/.test(s) ? Number(s) : s || null);

/** Smallest positive value, in kWh, that a source of the given precision can express. */
export const smallestPositiveKwh = (kwhDecimals: number) => 10 ** -kwhDecimals;

export interface RenderOpts {
  /**
   * Internal demo mode (`SIMULATE_PLACEHOLDERS`): spread the zero/negative
   * placeholder across the source's last digit (1–9) instead of one constant.
   * Seeded by device, quarter and hour, so re-rendering gives the same file.
   */
  simulate?: boolean;
}

/** 1–9, stable for the same seed. Used only by simulation mode. */
export function simulatedDigit(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return 1 + ((h >>> 0) % 9);
}

/** The explicit simulation switch; off unless the environment asks for it. */
export const simulatePlaceholders = () => /^(1|true)$/i.test(process.env.SIMULATE_PLACEHOLDERS ?? "");

/**
 * Render the template workbook for one device and quarter, in the Meter Data for
 * Bridge T-EACs layout: one sheet, a row for every hour of the quarter. Hours
 * without a value are written as `null` (the plant may have produced, but nothing
 * was recorded). Hours that read zero or negative (idle, or standby draw) are
 * written as the smallest positive number the source's precision can express —
 * 0.001 MWh when it counts whole kWh, 0.0001 MWh when it logs 0.1 kWh — so every
 * row the file does carry stays positive for the validator's gross-metering check.
 * In simulation mode the placeholder's last digit varies 1–9 (see RenderOpts).
 */
export async function renderMeterXlsx(p: HourlyPayload, device: Device, quarter: Quarter, unit: Unit, opts: RenderOpts = {}): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Wind Hourly";
  const ws = wb.addWorksheet("MeterData", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.addRow([...TEMPLATE_COLUMNS]).font = { bold: true };
  const meterId = idCell(device.meterId) ?? device.registryId;
  // the source's smallest positive value: 1 kWh (0.001 MWh) or 0.1 kWh (0.0001 MWh)
  const floor = smallestPositiveKwh(decimalsOf(p.kwh));
  const placeholder = (i: number) =>
    roundTo(floor * (opts.simulate ? simulatedDigit(`${device.registryId}:${quarter.key}:${i}`) : 1), KWH_DECIMALS);
  // kWh carry at most 1 decimal (see roundKwh), so MWh are exact at 6
  const cell = (v: number) => (unit === "MWh" ? Math.round(v * 1000) / 1e6 : v);
  p.kwh.forEach((v, i) => {
    const ts = quarter.start + i * HOUR;
    ws.addRow([
      isoLocal(ts),
      FILE_TZ_NAME,
      isoUtc(ts),
      v === null ? (opts.simulate ? cell(placeholder(i)) : "null") : cell(v > 0 ? v : placeholder(i)),
      unit,
      meterId,
      device.registryId,
      EAC_REGISTRY_ID,
    ]);
  });
  ws.columns.forEach((c, i) => (c.width = [26, 15, 22, 12, 20, 16, 18, 15, 15][i]));
  // show the raw precision even when trailing digits are zero: 2.7 → 2.700 (whole kWh), 1.6869 stays 4
  if (unit === "MWh") ws.getColumn(4).eachCell((cell, row) => row > 1 && typeof cell.value === "number" && (cell.numFmt = "0.000#"));
  return new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

/**
 * The quality report that goes with a meter file: every quarter hour written as
 * null with its reason, the zero/negative hours written at the smallest positive
 * value, the power-estimated and reconciliation-filled hours, and the raw 10-min
 * gaps. Kept out of the meter file, which must have one sheet.
 */
export async function renderMissingXlsx(p: HourlyPayload, device: Device, quarter: Quarter, opts: RenderOpts = {}): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Wind Hourly";
  const written = p.kwh.filter((v) => v !== null).length;
  const floors = p.kwh.flatMap((v, i) => (v !== null && v <= 0 ? [[i, v] as [number, number]] : []));
  const floorKwh = smallestPositiveKwh(decimalsOf(p.kwh));
  const span = `${floorKwh}${opts.simulate ? `–${roundTo(floorKwh * 9, KWH_DECIMALS)}` : ""}`;
  const writtenAs = opts.simulate
    ? `${span} kWh (simulated demo values, seeded per hour)`
    : `${span} kWh (the smallest positive at this source's precision)`;
  const writtenKwh = (i: number) => roundTo(floorKwh * (opts.simulate ? simulatedDigit(`${device.registryId}:${quarter.key}:${i}`) : 1), KWH_DECIMALS);
  const at = (i: number) => fmtNaive(quarter.start + i * HOUR);
  const info = wb.addWorksheet("MissingData");
  const lines: (string | number)[][] = [
    [`Device: ${device.outputName} (${device.registryId})`],
    [`Source: ${p.sourceName}`],
    [`Quarter: ${quarter.key}  ${fmtNaive(quarter.start, false)} → ${fmtNaive(quarter.end - DAY, false)} (local ${LOCAL_TZ_NAME})`],
    [`Hours in quarter: ${p.kwh.length}`],
    [
      opts.simulate
        ? `Hours with a value in MeterData: ${p.kwh.length} (all rows filled; ${p.kwh.length - written} had no source reading)`
        : `Hours with a value in MeterData: ${written} (the other ${p.kwh.length - written} are written as null)`,
    ],
    [`  of which zero or negative: ${floors.length}, written as ${writtenAs}`],
    [`  of which estimated from avg power (no register): ${p.estimated.length}`],
    [opts.simulate ? `Hours with no source reading (simulated): ${p.missing.length}` : `Hours missing (null): ${p.missing.length}`],
    [],
    [opts.simulate ? "Hours with no source reading (written as simulated placeholders)" : "Missing hours"],
    opts.simulate ? ["hour_start_local", "reason", "written_kwh"] : ["hour_start_local", "reason"],
    ...p.missing.map(([i, reason]) => (opts.simulate ? [at(i), reason, writtenKwh(i)] : [at(i), reason])),
    [],
    ["Hours estimated from active-power average instead of the energy register"],
    ["hour_start_local"],
    ...p.estimated.map((i) => [at(i)]),
  ];
  if (floors.length) {
    lines.push(
      [],
      [`Zero or negative readings, written in MeterData as ${span} kWh${opts.simulate ? " (simulated)" : ""}`],
      opts.simulate ? ["hour_start_local", "source_kwh", "written_kwh"] : ["hour_start_local", "source_kwh"],
    );
    for (const [i, v] of floors) lines.push(opts.simulate ? [at(i), v, writtenKwh(i)] : [at(i), v]);
  }
  if (p.filled?.length) {
    lines.push([], ["Hours filled during reconciliation (logger gap, estimated from neighbouring turbines or this turbine's typical output)"], ["hour_start_local"]);
    for (const i of p.filled) lines.push([at(i)]);
  }
  if (p.gaps.length) {
    lines.push([], ["10-min SCADA gaps (consecutive missing timestamps collapsed)"], ["gap_start_local", "gap_end_local", "missing_slot_count", "duration_minutes"]);
    for (const [s, e, slots] of p.gaps) lines.push([fmtNaive(s), fmtNaive(e), slots, slots * 10]);
  }
  for (const l of lines) info.addRow(l);
  info.columns.forEach((c, i) => (c.width = [24, 44, 20, 18][i]));
  return new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}
