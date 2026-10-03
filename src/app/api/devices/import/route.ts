import { requireApiUser } from "@/lib/auth/server";
import { appDb, irecDb } from "@/lib/db";
import { mergeMappings, parseDeliveryMappings } from "@/lib/importDelivery";
import { irecDevices } from "@/lib/irec";
import { loadMappings, mappingsVersion, saveMappings } from "@/lib/store";
import { cleanMapping } from "@/lib/validate";

/**
 * Add/update device mappings from a delivery workbook's "Hourly Files_details"
 * sheet. Never removes devices; rows that fail validation or are unknown to
 * irec are skipped and reported.
 */
export async function POST(req: Request) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const file = (await req.formData()).get("file");
  if (!(file instanceof File)) return Response.json({ error: "No file uploaded" }, { status: 400 });
  try {
    const skipped: string[] = [];
    const valid = (await parseDeliveryMappings(new Uint8Array(await file.arrayBuffer()))).flatMap((raw) => {
      const m = cleanMapping(raw);
      if (typeof m === "string") skipped.push(m);
      return typeof m === "string" ? [] : [m];
    });
    const known = await irecDevices(irecDb(), valid.map((m) => m.registryId));
    for (const m of valid) if (!known.has(m.registryId)) skipped.push(`${m.registryId}: not found in irec`);
    const db = appDb();
    const version = await mappingsVersion(db);
    const merged = mergeMappings(await loadMappings(db), valid.filter((m) => known.has(m.registryId)));
    const names = merged.mappings.map((m) => m.outputName.toLowerCase());
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup) return Response.json({ error: `Import would create a duplicate output name '${dup}'` }, { status: 400 });
    await saveMappings(db, merged.mappings, user.email, version);
    return Response.json({ added: merged.added, updated: merged.updated, skipped });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
