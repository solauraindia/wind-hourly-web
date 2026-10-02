import { saveDevices } from "@/lib/repo";
import { slug } from "@/lib/registry";
import type { Device } from "@/lib/types";

/** Replace the device registry (the Devices page saves the whole table). */
export async function PUT(req: Request) {
  const body = (await req.json()) as Device[];
  if (!Array.isArray(body)) return Response.json({ error: "Expected an array of devices" }, { status: 400 });
  const devices = body
    .map((d) => ({ ...d, id: d.id || slug(d.outputName || d.alias), sourceHint: d.sourceHint?.trim() || undefined }))
    .filter((d) => d.alias && d.registryId);
  const ids = new Set<string>();
  for (const d of devices) {
    if (ids.has(d.id)) return Response.json({ error: `Duplicate device '${d.outputName}'` }, { status: 400 });
    ids.add(d.id);
  }
  await saveDevices(devices);
  return Response.json({ devices });
}
