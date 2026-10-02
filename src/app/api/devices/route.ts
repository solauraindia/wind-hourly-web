import { requireApiUser } from "@/lib/auth/server";
import { appDb, irecDb } from "@/lib/db";
import { irecDevices } from "@/lib/irec";
import { loadDevices, saveMappings } from "@/lib/store";
import type { DeviceMapping } from "@/lib/types";

/** Replace the device mappings (the Devices page saves the whole table, in order). */
export async function PUT(req: Request) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const body = (await req.json()) as DeviceMapping[];
  if (!Array.isArray(body)) return Response.json({ error: "Expected an array of devices" }, { status: 400 });
  const mappings = body
    .map((d) => ({
      registryId: String(d.registryId ?? "").trim(),
      alias: String(d.alias ?? "").trim(),
      outputName: String(d.outputName ?? "").trim() || String(d.alias ?? "").trim(),
      sourceHint: String(d.sourceHint ?? "").trim() || undefined,
    }))
    .filter((d) => d.registryId);
  for (const key of ["registryId", "outputName"] as const) {
    const seen = new Set<string>();
    for (const m of mappings) {
      if (!m.alias) return Response.json({ error: `${m.registryId}: raw alias is required` }, { status: 400 });
      if (seen.has(m[key])) return Response.json({ error: `Duplicate ${key === "registryId" ? "registry id" : "output name"} '${m[key]}'` }, { status: 400 });
      seen.add(m[key]);
    }
  }
  const known = await irecDevices(irecDb(), mappings.map((m) => m.registryId));
  const unknown = mappings.filter((m) => !known.has(m.registryId)).map((m) => m.registryId);
  if (unknown.length) return Response.json({ error: `Not found in irec: ${unknown.join(", ")}` }, { status: 400 });
  await saveMappings(appDb(), mappings, user.email);
  return Response.json({ devices: await loadDevices(appDb(), irecDb()) });
}
