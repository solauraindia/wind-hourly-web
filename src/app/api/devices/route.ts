import { requireApiUser } from "@/lib/auth/server";
import { appDb, irecDb } from "@/lib/db";
import { IrecUnavailableError, irecDevices, irecUnavailableResponse } from "@/lib/irec";
import { StaleMappingsError, deletionImpact, loadDevices, mappingsVersion, saveMappings } from "@/lib/store";
import { cleanMappings } from "@/lib/validate";

interface Body {
  /** device_mappings_version() the editor loaded; the save fails if it changed */
  version: string;
  devices: unknown;
  /** registry ids whose stored hourly data the user agreed to delete */
  confirmDelete?: string[];
}

/** Replace the device mappings (the Devices page saves the whole table, in order). */
async function handle(req: Request) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body || typeof body.version !== "string") return Response.json({ error: "Missing table version — reload the page" }, { status: 400 });
  const mappings = cleanMappings(body.devices);
  if (typeof mappings === "string") return Response.json({ error: mappings }, { status: 400 });

  const known = await irecDevices(irecDb(), mappings.map((m) => m.registryId));
  const unknown = mappings.filter((m) => !known.has(m.registryId)).map((m) => m.registryId);
  if (unknown.length) return Response.json({ error: `Not found in irec: ${unknown.join(", ")}` }, { status: 400 });

  const db = appDb();
  if ((await mappingsVersion(db)) !== body.version) {
    return Response.json({ error: "Devices were changed elsewhere since this page loaded — reload and try again." }, { status: 409 });
  }
  // removing a device deletes its hourly data in every quarter: require explicit confirmation
  const impact = await deletionImpact(db, mappings.map((m) => m.registryId));
  const confirmed = new Set(body.confirmDelete ?? []);
  const unconfirmed = impact.filter((d) => !confirmed.has(d.registryId));
  if (unconfirmed.length) return Response.json({ needsConfirmation: unconfirmed }, { status: 409 });

  try {
    await saveMappings(db, mappings, user.email, body.version);
  } catch (e) {
    const status = e instanceof StaleMappingsError ? 409 : 400;
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status });
  }
  const [devices, version] = await Promise.all([loadDevices(db, irecDb()), mappingsVersion(db)]);
  return Response.json({ devices, version });
}

export async function PUT(req: Request) {
  try {
    return await handle(req);
  } catch (e) {
    if (e instanceof IrecUnavailableError) return irecUnavailableResponse(e);
    throw e;
  }
}
