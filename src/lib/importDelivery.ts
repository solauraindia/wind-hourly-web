import type { DeviceActuals } from "./actuals/types";
import { readWorkbook, num, str, type Sheet } from "./parsers/xlsx";
import { slug } from "./registry";
import type { Device } from "./types";

/**
 * Read a quarterly delivery workbook (e.g. "Q2 - Delivery_Detailed.xlsx"):
 *   • "Hourly Files_details": File Name | meter_id | eac_facility_id | eac_registry_id
 *     → the fields the raw exports don't carry, i.e. the device registry.
 *   • "Sheet1": the quarterly summary → client names, plus actual / eligible /
 *     issued figures (a stand-in for the cloud DB until it is connected).
 */
export async function parseDeliveryWorkbook(data: Uint8Array) {
  const sheets = await readWorkbook(data);
  const devices = parseFileDetails(sheets);
  const { clients, actuals } = parseSummarySheet(sheets, new Set(devices.map((d) => d.registryId)));
  for (const d of devices) d.client = clients.get(d.registryId) ?? d.client;
  return { devices, actuals };
}

function parseFileDetails(sheets: Sheet[]): Device[] {
  for (const s of sheets) {
    const h = s.rows.findIndex((r) => r.some((c) => str(c) === "File Name") && r.some((c) => str(c) === "eac_registry_id"));
    if (h < 0) continue;
    const hdr = s.rows[h].map(str);
    const col = (n: string) => hdr.indexOf(n);
    const out: Device[] = [];
    for (const r of s.rows.slice(h + 1)) {
      const file = str(r[col("File Name")]);
      const registryId = str(r[col("eac_registry_id")]);
      if (!file || !registryId) continue;
      const outputName = file.replace(/_hourly_.*$/i, "").replace(/\.xlsx$/i, "");
      // "Ottapidaram-ERW01" → site prefix + turbine; "RSMKP-01" is a plain turbine name
      const prefixed = outputName.match(/^(.+)-([A-Za-z]+\d+)$/);
      const meter = r[col("meter_id")];
      out.push({
        id: slug(outputName),
        alias: prefixed ? prefixed[2] : outputName,
        outputName,
        sourceHint: prefixed ? prefixed[1] : undefined,
        client: "",
        meterId: typeof meter === "number" ? String(Math.round(meter)) : str(meter),
        facilityId: str(r[col("eac_facility_id")]),
        registryId,
      });
    }
    return out;
  }
  throw new Error("No sheet with a 'File Name … eac_registry_id' header found");
}

function parseSummarySheet(sheets: Sheet[], registryIds: Set<string>) {
  const clients = new Map<string, string>();
  const actuals: Record<string, DeviceActuals> = {};
  for (const s of sheets) {
    const h = s.rows.findIndex((r) => r.some((c) => /^eligible/i.test(str(c))));
    if (h < 0) continue;
    const hdr = s.rows[h].map(str);
    const eligibleCol = hdr.findIndex((c) => /^eligible/i.test(c));
    const issuedCol = hdr.findIndex((c) => /^issued/i.test(c));
    // the first three month headers left of "Eligible" are the actual-generation months
    const monthCols = hdr
      .map((c, i) => ({ c, i }))
      .filter(({ c, i }) => i < eligibleCol && /^[A-Za-z]{3,9}$/.test(c) && c !== "Total")
      .slice(0, 3)
      .map(({ i }) => i);
    for (const r of s.rows.slice(h + 1)) {
      const idCol = r.findIndex((c) => registryIds.has(str(c)));
      if (idCol < 0) continue;
      const registryId = str(r[idCol]);
      const client = str(r[idCol - 1]);
      if (client) clients.set(registryId, client);
      const actual = monthCols.map((c) => num(r[c])) as DeviceActuals["actualMWh"];
      actuals[registryId] = {
        registryId,
        actualMWh: actual,
        eligibleMWh: eligibleCol >= 0 ? num(r[eligibleCol]) : null,
        issuedMWh: issuedCol >= 0 ? num(r[issuedCol]) : null,
      };
    }
    break;
  }
  return { clients, actuals };
}

/** Merge imported devices into the registry by registry id, keeping existing ids and order. */
export function mergeDevices(existing: Device[], incoming: Device[]): { devices: Device[]; added: number; updated: number } {
  const byReg = new Map(existing.map((d) => [d.registryId, d]));
  let added = 0;
  let updated = 0;
  const devices = existing.map((d) => ({ ...d }));
  for (const inc of incoming) {
    const cur = byReg.get(inc.registryId);
    if (cur) {
      const i = devices.findIndex((d) => d.registryId === inc.registryId);
      devices[i] = { ...inc, id: cur.id, client: inc.client || cur.client, site: cur.site };
      updated++;
    } else {
      devices.push(inc);
      added++;
    }
  }
  return { devices, added, updated };
}
