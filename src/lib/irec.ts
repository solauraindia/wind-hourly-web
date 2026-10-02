import "server-only";
import type { DeviceActuals } from "./actuals";
import type { Db } from "./db";
import type { Quarter } from "./quarter";

/** Device master data as held in irec (devices ⨝ companies). */
export interface IrecDevice {
  registryId: string; // devices.device_meta_id
  meterId: string; // devices.htsc_no
  facilityId: string; // devices.project_description
  client: string; // companies.company_name
  capacityMw: number | null;
  status: string | null;
}

export async function irecDevices(db: Db, registryIds?: string[]): Promise<Map<string, IrecDevice>> {
  const rows = await db.query<{
    registry_id: string;
    meter_id: string | null;
    facility_id: string | null;
    client: string | null;
    capacity: number | null;
    status: string | null;
  }>(
    `SELECT d.device_meta_id AS registry_id, d.htsc_no AS meter_id, d.project_description AS facility_id,
            c.company_name AS client, d.project_capacity AS capacity, d.status
       FROM devices d
       LEFT JOIN companies c ON c.company_id = d.company_id
      WHERE d.device_meta_id IS NOT NULL
        AND ($1::text[] IS NULL OR d.device_meta_id = ANY($1::text[]))`,
    [registryIds ?? null],
  );
  return new Map(
    rows.map((r) => [
      r.registry_id,
      {
        registryId: r.registry_id,
        meterId: r.meter_id?.trim() ?? "",
        facilityId: r.facility_id?.trim() ?? "",
        client: r.client?.trim() ?? "",
        capacityMw: r.capacity,
        status: r.status,
      },
    ]),
  );
}

const period = (y: number, m: number) => y * 100 + m;

/**
 * Actual and eligible generation (devices_monthly_data) and issued volume
 * (issuances), all MWh, for the three months of the quarter.
 */
export async function irecActuals(db: Db, quarter: Quarter, registryIds: string[]): Promise<Record<string, DeviceActuals>> {
  const periods = quarter.months.map(([y, m]) => period(y, m));
  const rows = await db.query<{ registry_id: string; period: number; actual: string | null; eligible: string | null; issued: string | null }>(
    `WITH p AS (SELECT unnest($2::int[]) AS period),
          dev AS (SELECT device_id, device_meta_id FROM devices WHERE device_meta_id = ANY($1::text[])),
          iss AS (SELECT device_id, period, SUM(issued_units) AS issued
                    FROM issuances WHERE period = ANY($2::int[]) GROUP BY device_id, period)
     SELECT dev.device_meta_id AS registry_id, p.period,
            m.actual_gen AS actual, m.eligible_gen AS eligible, iss.issued
       FROM dev CROSS JOIN p
       LEFT JOIN devices_monthly_data m ON m.device_id = dev.device_id AND m.period = p.period
       LEFT JOIN iss ON iss.device_id = dev.device_id AND iss.period = p.period`,
    [registryIds, periods],
  );
  const out: Record<string, DeviceActuals> = {};
  const n = (v: string | null) => (v === null ? null : Number(v));
  for (const r of rows) {
    const a = (out[r.registry_id] ??= {
      registryId: r.registry_id,
      actualMWh: [null, null, null],
      eligibleMWh: null,
      issuedMWh: null,
    });
    const i = periods.indexOf(Number(r.period));
    a.actualMWh[i] = n(r.actual);
    if (r.eligible !== null) a.eligibleMWh = (a.eligibleMWh ?? 0) + Number(r.eligible);
    if (r.issued !== null) a.issuedMWh = (a.issuedMWh ?? 0) + Number(r.issued);
  }
  return out;
}
