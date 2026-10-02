import { requireApiUser } from "@/lib/auth/server";
import { appDb, irecDb } from "@/lib/db";
import { mergeMappings, parseDeliveryMappings } from "@/lib/importDelivery";
import { irecDevices } from "@/lib/irec";
import { loadMappings, saveMappings } from "@/lib/store";

/** Add/update device mappings from a delivery workbook's "Hourly Files_details" sheet. */
export async function POST(req: Request) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const file = (await req.formData()).get("file");
  if (!(file instanceof File)) return Response.json({ error: "No file uploaded" }, { status: 400 });
  try {
    const incoming = await parseDeliveryMappings(new Uint8Array(await file.arrayBuffer()));
    const known = await irecDevices(irecDb(), incoming.map((m) => m.registryId));
    const usable = incoming.filter((m) => known.has(m.registryId));
    const skipped = incoming.filter((m) => !known.has(m.registryId)).map((m) => m.registryId);
    const merged = mergeMappings(await loadMappings(appDb()), usable);
    await saveMappings(appDb(), merged.mappings, user.email);
    return Response.json({ added: merged.added, updated: merged.updated, skipped });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
