import { readWorkbook, str } from "./parsers/xlsx";
import type { DeviceMapping } from "./types";

/**
 * Read device mappings from a delivery workbook's "Hourly Files_details" sheet
 * (File Name | meter_id | eac_facility_id | eac_registry_id). Only the file name
 * and registry id are used: meter, facility and client come from irec.
 */
export async function parseDeliveryMappings(data: Uint8Array): Promise<DeviceMapping[]> {
  for (const s of await readWorkbook(data)) {
    const h = s.rows.findIndex((r) => r.some((c) => str(c) === "File Name") && r.some((c) => str(c) === "eac_registry_id"));
    if (h < 0) continue;
    const hdr = s.rows[h].map(str);
    const fileCol = hdr.indexOf("File Name");
    const regCol = hdr.indexOf("eac_registry_id");
    const out: DeviceMapping[] = [];
    for (const r of s.rows.slice(h + 1)) {
      const file = str(r[fileCol]);
      const registryId = str(r[regCol]);
      if (!file || !registryId) continue;
      const outputName = file.replace(/_hourly_.*$/i, "").replace(/\.xlsx$/i, "");
      // "Ottapidaram-ERW01" → site prefix + turbine; "RSMKP-01" is a plain turbine name
      const prefixed = outputName.match(/^(.+)-([A-Za-z]+\d+)$/);
      out.push({
        registryId,
        alias: prefixed ? prefixed[2] : outputName,
        outputName,
        sourceHint: prefixed ? prefixed[1] : undefined,
      });
    }
    return out;
  }
  throw new Error("No sheet with a 'File Name … eac_registry_id' header found");
}

/** Merge imported mappings into the current list by registry id, keeping order. */
export function mergeMappings(existing: DeviceMapping[], incoming: DeviceMapping[]) {
  const out = existing.map((d) => ({ ...d }));
  let added = 0;
  let updated = 0;
  for (const inc of incoming) {
    const i = out.findIndex((d) => d.registryId === inc.registryId);
    if (i >= 0) {
      out[i] = inc;
      updated++;
    } else {
      out.push(inc);
      added++;
    }
  }
  return { mappings: out, added, updated };
}
