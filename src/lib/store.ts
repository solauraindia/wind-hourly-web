import "server-only";
import { MAX_HOURLY_KWH } from "./hourly";
import { quarterHours, type HourlyPayload } from "./compute";
import type { Db } from "./db";
import { irecDevices } from "./irec";
import { monthIndexInQuarter, parseQuarter, type Quarter } from "./quarter";
import { DAY, HOUR, LOCAL_OFFSET_MIN, MINUTE } from "./time";
import { FORMAT_LABELS, type Device, type DeviceMapping, type HourlyResult } from "./types";

/* Device mappings ------------------------------------------------------------ */

export async function loadMappings(db: Db): Promise<DeviceMapping[]> {
  const rows = await db.query<{ registry_id: string; alias: string; output_name: string; source_hint: string | null }>(
    "SELECT registry_id, alias, output_name, source_hint FROM device_mappings ORDER BY sort_order, output_name",
  );
  return rows.map((r) => ({ registryId: r.registry_id, alias: r.alias, outputName: r.output_name, sourceHint: r.source_hint ?? undefined }));
}

/** Mappings joined with irec master data, in summary order. */
export async function loadDevices(app: Db, irec: Db): Promise<Device[]> {
  const mappings = await loadMappings(app);
  const master = mappings.length ? await irecDevices(irec, mappings.map((m) => m.registryId)) : new Map();
  return mappings.map((m) => {
    const d = master.get(m.registryId);
    return { ...m, id: m.registryId, client: d?.client ?? "", meterId: d?.meterId ?? "", facilityId: d?.facilityId ?? "", inIrec: !!d };
  });
}

/** Replace all mappings (the Devices page saves the whole table); order = array order. */
export async function saveMappings(db: Db, mappings: DeviceMapping[], user: string | null): Promise<void> {
  const ids = mappings.map((m) => m.registryId);
  await db.transaction([
    // hourly data of removed devices goes with them (FK cascade)
    { text: "DELETE FROM device_mappings WHERE NOT (registry_id = ANY($1::text[]))", params: [ids] },
    {
      text: `INSERT INTO device_mappings (registry_id, alias, output_name, source_hint, sort_order, updated_by, updated_at)
             SELECT * , now() FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::int[], $6::text[])
             ON CONFLICT (registry_id) DO UPDATE SET alias = EXCLUDED.alias, output_name = EXCLUDED.output_name,
               source_hint = EXCLUDED.source_hint, sort_order = EXCLUDED.sort_order,
               updated_by = EXCLUDED.updated_by, updated_at = now()`,
      params: [
        ids,
        mappings.map((m) => m.alias),
        mappings.map((m) => m.outputName),
        mappings.map((m) => m.sourceHint ?? null),
        mappings.map((_, i) => i + 1),
        mappings.map(() => user),
      ],
    },
  ]);
}

/* Hourly results --------------------------------------------------------------- */

/** Reject anything that could not have come from computeHourly. */
export function validatePayload(p: HourlyPayload): Quarter {
  const quarter = parseQuarter(p.quarter);
  if (!quarter) throw new Error(`invalid quarter '${p.quarter}'`);
  if (!(p.format in FORMAT_LABELS)) throw new Error(`unknown format '${p.format}'`);
  const n = quarterHours(quarter);
  if (!Array.isArray(p.kwh) || p.kwh.length !== n) throw new Error(`expected ${n} hourly values`);
  for (const v of p.kwh) {
    if (v !== null && (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > MAX_HOURLY_KWH)) throw new Error(`hourly value out of range: ${v}`);
  }
  const idx = (i: unknown) => Number.isInteger(i) && (i as number) >= 0 && (i as number) < n;
  if (!p.estimated.every(idx) || !p.missing.every(([i, r]) => idx(i) && typeof r === "string")) throw new Error("bad hour indices");
  if (!p.kwh.some((v) => v !== null)) throw new Error(`no data inside ${quarter.key}`);
  return quarter;
}

export function summarize(p: HourlyPayload, quarter: Quarter): Omit<HourlyResult, "processedAt" | "processedBy"> {
  const days = Math.round((quarter.end - quarter.start) / DAY);
  const count = new Array<number>(days).fill(0);
  const dayKwh = new Array<number>(days).fill(0);
  const monthly = [0, 0, 0];
  let total = 0;
  p.kwh.forEach((v, i) => {
    if (v === null) return;
    const ts = quarter.start + i * HOUR;
    const d = Math.floor(i / 24);
    count[d] += 1;
    dayKwh[d] += v;
    monthly[monthIndexInQuarter(quarter, ts)] += v;
    total += v;
  });
  const mwh6 = (kwh: number) => Math.round(kwh * 1000) / 1e6; // exact: kWh have 3 decimals
  const written = p.kwh.filter((v) => v !== null).length;
  return {
    registryId: p.registryId,
    quarter: quarter.key,
    format: p.format,
    sourceName: p.sourceName,
    hoursInQuarter: p.kwh.length,
    hoursWritten: written,
    hoursEstimated: p.estimated.length,
    hoursMissing: p.kwh.length - written,
    totalMWh: mwh6(total),
    monthlyMWh: monthly.map(mwh6) as [number, number, number],
    dailyCoverage: count.map((c) => c / 24),
    dailyMWh: dayKwh.map((v) => Math.round(v) / 1000),
  };
}

/** naive-local ms ↔ real instant (timestamptz) */
const toInstant = (naiveMs: number) => new Date(naiveMs - LOCAL_OFFSET_MIN * MINUTE).toISOString();
const fromInstant = (d: Date | string) => new Date(d).getTime() + LOCAL_OFFSET_MIN * MINUTE;

/** Store one device's quarter, replacing any earlier run for that device and quarter. */
export async function saveHourly(db: Db, p: HourlyPayload, user: string | null): Promise<HourlyResult> {
  const quarter = validatePayload(p);
  const s = summarize(p, quarter);
  const hours: string[] = [];
  const values: number[] = [];
  const est: boolean[] = [];
  const estSet = new Set(p.estimated);
  p.kwh.forEach((v, i) => {
    if (v === null) return;
    hours.push(toInstant(quarter.start + i * HOUR));
    values.push(v);
    est.push(estSet.has(i));
  });
  const quality = { missing: p.missing, estimated: p.estimated, gaps: p.gaps };
  const toKwh = (mwh: number) => Math.round(mwh * 1e6) / 1000;
  await db.transaction([
    {
      text: "DELETE FROM hourly_values WHERE registry_id = $1 AND hour_start >= $2 AND hour_start < $3",
      params: [p.registryId, toInstant(quarter.start), toInstant(quarter.end)],
    },
    {
      text: `INSERT INTO hourly_values (registry_id, hour_start, kwh, estimated)
             SELECT $1, * FROM unnest($2::timestamptz[], $3::numeric[], $4::boolean[])`,
      params: [p.registryId, hours, values, est],
    },
    {
      text: `INSERT INTO hourly_results (registry_id, quarter, format, source_name, hours_in_quarter, hours_written,
               hours_estimated, hours_missing, total_kwh, monthly_kwh, daily_coverage, daily_kwh, quality, processed_at, processed_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now(), $14)
             ON CONFLICT (registry_id, quarter) DO UPDATE SET format = EXCLUDED.format, source_name = EXCLUDED.source_name,
               hours_in_quarter = EXCLUDED.hours_in_quarter, hours_written = EXCLUDED.hours_written,
               hours_estimated = EXCLUDED.hours_estimated, hours_missing = EXCLUDED.hours_missing,
               total_kwh = EXCLUDED.total_kwh, monthly_kwh = EXCLUDED.monthly_kwh, daily_coverage = EXCLUDED.daily_coverage,
               daily_kwh = EXCLUDED.daily_kwh, quality = EXCLUDED.quality, processed_at = now(), processed_by = EXCLUDED.processed_by`,
      params: [
        p.registryId, quarter.key, p.format, p.sourceName, s.hoursInQuarter, s.hoursWritten, s.hoursEstimated,
        s.hoursMissing, toKwh(s.totalMWh), s.monthlyMWh.map(toKwh), s.dailyCoverage, s.dailyMWh.map((v) => v * 1000),
        JSON.stringify(quality), user,
      ],
    },
  ]);
  return { ...s, processedAt: new Date().toISOString(), processedBy: user };
}

interface ResultRow {
  registry_id: string;
  quarter: string;
  format: HourlyResult["format"];
  source_name: string;
  hours_in_quarter: number;
  hours_written: number;
  hours_estimated: number;
  hours_missing: number;
  total_kwh: string;
  monthly_kwh: string[];
  daily_coverage: number[];
  daily_kwh: number[];
  processed_at: Date | string;
  processed_by: string | null;
}

export async function loadResults(db: Db, quarter: string): Promise<Record<string, HourlyResult>> {
  const rows = await db.query<ResultRow>(
    `SELECT registry_id, quarter, format, source_name, hours_in_quarter, hours_written, hours_estimated, hours_missing,
            total_kwh, monthly_kwh, daily_coverage, daily_kwh, processed_at, processed_by
       FROM hourly_results WHERE quarter = $1`,
    [quarter],
  );
  // kWh carry 3 decimals, so this is exact at 6
  const mwh = (kwh: string | number) => Math.round(Number(kwh) * 1000) / 1e6;
  return Object.fromEntries(
    rows.map((r) => [
      r.registry_id,
      {
        registryId: r.registry_id,
        quarter: r.quarter,
        format: r.format,
        sourceName: r.source_name,
        hoursInQuarter: r.hours_in_quarter,
        hoursWritten: r.hours_written,
        hoursEstimated: r.hours_estimated,
        hoursMissing: r.hours_missing,
        totalMWh: mwh(r.total_kwh),
        monthlyMWh: r.monthly_kwh.map(mwh) as [number, number, number],
        dailyCoverage: r.daily_coverage.map(Number),
        dailyMWh: r.daily_kwh.map((v) => Number(v) / 1000),
        processedAt: new Date(r.processed_at).toISOString(),
        processedBy: r.processed_by,
      },
    ]),
  );
}

/** Rebuild the payload of a stored run — the input for rendering the .xlsx. */
export async function loadHourly(db: Db, registryId: string, quarter: Quarter): Promise<HourlyPayload | null> {
  const [meta] = await db.query<{ format: HourlyPayload["format"]; source_name: string; quality: HourlyPayload | string }>(
    "SELECT format, source_name, quality FROM hourly_results WHERE registry_id = $1 AND quarter = $2",
    [registryId, quarter.key],
  );
  if (!meta) return null;
  const rows = await db.query<{ hour_start: Date | string; kwh: string }>(
    "SELECT hour_start, kwh FROM hourly_values WHERE registry_id = $1 AND hour_start >= $2 AND hour_start < $3 ORDER BY hour_start",
    [registryId, toInstant(quarter.start), toInstant(quarter.end)],
  );
  const kwh: (number | null)[] = new Array(quarterHours(quarter)).fill(null);
  for (const r of rows) kwh[Math.round((fromInstant(r.hour_start) - quarter.start) / HOUR)] = Number(r.kwh);
  const q = (typeof meta.quality === "string" ? JSON.parse(meta.quality) : meta.quality) as Pick<HourlyPayload, "missing" | "estimated" | "gaps">;
  return { registryId, quarter: quarter.key, format: meta.format, sourceName: meta.source_name, kwh, ...q };
}
