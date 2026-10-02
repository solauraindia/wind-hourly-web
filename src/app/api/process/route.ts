import { requireApiUser } from "@/lib/auth/server";
import type { HourlyPayload } from "@/lib/compute";
import { appDb } from "@/lib/db";
import { loadMappings, saveHourly } from "@/lib/store";

/**
 * Store one device's hourly statement for a quarter. The browser parses the raw
 * files and posts only the computed hourly array (~2,200 values), which keeps
 * requests far below Vercel's 4.5 MB body limit and means raw files are never uploaded.
 */
export async function POST(req: Request) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const payload = (await req.json()) as HourlyPayload;
  const db = appDb();
  if (!(await loadMappings(db)).some((m) => m.registryId === payload.registryId)) {
    return Response.json({ error: `Unknown device '${payload.registryId}'` }, { status: 400 });
  }
  try {
    return Response.json({ result: await saveHourly(db, payload, user.email) });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
