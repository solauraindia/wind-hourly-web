import "server-only";
import { MAX_HOURLY_KWH } from "./hourly";
import { quarterHours, round3, type HourlyPayload } from "./compute";
import type { Db } from "./db";
import { irecDevices, type IrecDevice } from "./irec";
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

function join(mappings: DeviceMapping[], master: Map<string, IrecDevice>): Device[] {
  return mappings.map((m) => {
    const d = master.get(m.registryId);
    return { ...m, id: m.registryId, client: d?.client ?? "", meterId: d?.meterId ?? "", facilityId: d?.facilityId ?? "", inIrec: !!d };
  });
}

/** Mappings joined with irec master data, in summary order. Throws if irec is unreachable. */
export async function loadDevices(app: Db, irec: Db): Promise<Device[]> {
  const mappings = await loadMappings(app);
  return join(mappings, mappings.length ? await irecDevices(irec, mappings.map((m) => m.registryId)) : new Map());
}

/**
 * Same as loadDevices, but keeps pages usable when irec is down: devices come
 * back without irec fields and `irecError` says why. Downloads must use the
 * strict version so a file is never written with empty meter/facility ids.
 */
export async function loadDevicesSafe(app: Db, irec: Db): Promise<{ devices: Device[]; irecError: string | null }> {
  const mappings = await loadMappings(app);
  try {
    return { devices: join(mappings, mappings.length ? await irecDevices(irec, mappings.map((m) => m.registryId)) : new Map()), irecError: null };
  } catch (e) {
    return { devices: join(mappings, new Map()), irecError: e instanceof Error ? e.message : String(e) };
  }
}

/** Fingerprint of the mapping table, handed to the editor and checked on save. */
export async function mappingsVersion(db: Db): Promise<string> {
  const [r] = await db.query<{ v: string }>("SELECT device_mappings_version() AS v");
  return r.v;
}

/** Devices that would lose stored hourly data if `keep` were saved, with the affected quarters. */
export async function deletionImpact(db: Db, keep: string[]): Promise<{ registryId: string; outputName: string; quarters: string[] }[]> {
  const rows = await db.query<{ registry_id: string; output_name: string; quarters: string[] }>(
    `SELECT m.registry_id, m.output_name, array_agg(r.quarter ORDER BY r.quarter) AS quarters
       FROM device_mappings m JOIN hourly_results r USING (registry_id)
      WHERE NOT (m.registry_id = ANY($1::text[]))
      GROUP BY m.registry_id, m.output_name ORDER BY m.output_name`,
    [keep],
  );
  return rows.map((r) => ({ registryId: r.registry_id, outputName: r.output_name, quarters: r.quarters }));
}

export class StaleMappingsError extends Error {}

/**
 * Replace all mappings (the Devices page saves the whole table; order = array
 * order). Removing a device deletes its hourly data for every quarter (FK
 * cascade), so callers must check deletionImpact and get confirmation first.
 * `expectedVersion` makes the save fail if anyone changed the table since it
 * was loaded — a stale tab can't silently drop someone else's device.
 */
export async function saveMappings(db: Db, mappings: DeviceMapping[], user: string | null, expectedVersion: string): Promise<void> {
  const ids = mappings.map((m) => m.registryId);
  try {
    await db.transaction([
      { text: "SELECT assert_device_mappings_version($1)", params: [expectedVersion] },
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
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("changed since they were loaded")) throw new StaleMappingsError("Devices were changed elsewhere since this page loaded — reload and try again.");
    if (msg.includes("device_mappings_output_name_key")) throw new Error("Two devices have the same output name");
    throw e;
  }
}

/* Hourly results --------------------------------------------------------------- */

/**
 * Reject anything that could not have come from computeHourly and return a
 * normalised copy: kWh rounded to 3 decimals, `estimated` ⊆ hours with a value,
 * `missing` = exactly the hours without one, gaps inside the quarter.
 */
export function validatePayload(input: HourlyPayload): { payload: HourlyPayload; quarter: Quarter } {
  const p = (input ?? {}) as Partial<HourlyPayload>;
  const quarter = parseQuarter(typeof p.quarter === "string" ? p.quarter : null);
  if (!quarter) throw new Error(`invalid quarter '${p.quarter}'`);
  if (typeof p.registryId !== "string" || !p.registryId || p.registryId.length > 40) throw new Error("invalid registry id");
  if (typeof p.format !== "string" || !Object.hasOwn(FORMAT_LABELS, p.format)) throw new Error(`unknown format '${p.format}'`);
  if (typeof p.sourceName !== "string" || !p.sourceName.trim() || p.sourceName.length > 200) throw new Error("source name must be 1–200 characters");
  const n = quarterHours(quarter);
  if (!Array.isArray(p.kwh) || p.kwh.length !== n) throw new Error(`expected ${n} hourly values`);
  const kwh = p.kwh.map((v) => {
    if (v === null) return null;
    if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > MAX_HOURLY_KWH) throw new Error(`hourly value out of range: ${v}`);
    return round3(v);
  });
  if (!kwh.some((v) => v !== null)) throw new Error(`no data inside ${quarter.key}`);
  const isIdx = (i: unknown): i is number => Number.isInteger(i) && (i as number) >= 0 && (i as number) < n;

  if (!Array.isArray(p.estimated) || !p.estimated.every(isIdx)) throw new Error("bad estimated hour indices");
  const estimated = [...new Set(p.estimated)].sort((a, b) => a - b);
  if (estimated.some((i) => kwh[i] === null)) throw new Error("an estimated hour has no value");

  if (!Array.isArray(p.missing) || !p.missing.every((m) => Array.isArray(m) && isIdx(m[0]) && typeof m[1] === "string" && m[1].length <= 200)) {
    throw new Error("bad missing hour entries");
  }
  const reasons = new Map(p.missing.map(([i, r]) => [i, r]));
  const nullIdx = kwh.flatMap((v, i) => (v === null ? [i] : []));
  if (reasons.size !== nullIdx.length || nullIdx.some((i) => !reasons.has(i))) throw new Error("missing hours do not match the empty hourly values");
  const missing = nullIdx.map((i) => [i, reasons.get(i)!] as [number, string]);

  if (!Array.isArray(p.gaps) || p.gaps.length > 20_000) throw new Error("bad gaps list");
  const inQ = (t: unknown) => Number.isInteger(t) && (t as number) >= quarter.start && (t as number) < quarter.end;
  for (const g of p.gaps) {
    if (!Array.isArray(g) || g.length !== 3 || !inQ(g[0]) || !inQ(g[1]) || g[1] < g[0] || !Number.isInteger(g[2]) || g[2] < 1) {
      throw new Error("bad gap entry");
    }
  }
  return {
    quarter,
    payload: { registryId: p.registryId, quarter: quarter.key, format: p.format as HourlyPayload["format"], sourceName: p.sourceName.trim(), kwh, estimated, missing, gaps: p.gaps },
  };
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
export async function saveHourly(db: Db, input: HourlyPayload, user: string | null): Promise<HourlyResult> {
  const { payload: p, quarter } = validatePayload(input);
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
