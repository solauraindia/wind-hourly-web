import { saveLocalActuals } from "@/lib/actuals/local";
import { mergeDevices, parseDeliveryWorkbook } from "@/lib/importDelivery";
import { parseQuarter } from "@/lib/quarter";
import { loadDevices, saveDevices } from "@/lib/repo";

/**
 * Import a delivery workbook: device registry fields from "Hourly Files_details"
 * and, when a quarter is given, the actual / eligible / issued figures from Sheet1.
 */
export async function POST(req: Request) {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return Response.json({ error: "No file uploaded" }, { status: 400 });
  const quarter = parseQuarter(String(form.get("quarter") ?? ""));
  try {
    const parsed = await parseDeliveryWorkbook(new Uint8Array(await file.arrayBuffer()));
    const merged = mergeDevices(await loadDevices(), parsed.devices);
    await saveDevices(merged.devices);
    const actualRows = Object.keys(parsed.actuals).length;
    if (quarter && actualRows) await saveLocalActuals(quarter, file.name, parsed.actuals);
    return Response.json({ added: merged.added, updated: merged.updated, actualRows: quarter ? actualRows : 0 });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
