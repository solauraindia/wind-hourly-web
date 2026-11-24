import { requireApiUser } from "@/lib/auth/server";
import { appDb, irecDb } from "@/lib/db";
import { IrecUnavailableError, irecUnavailableResponse } from "@/lib/irec";
import { VALIDATOR_BATCH, validateFiles } from "@/lib/meterValidator";
import { outputFileName, renderMeterXlsx, simulatePlaceholders } from "@/lib/output";
import { parseQuarter } from "@/lib/quarter";
import { loadDevices, loadHourly } from "@/lib/store";

export const maxDuration = 60;

/**
 * Render the picked devices' hourly files exactly as the download does (stored
 * values, so reconciled months included) and run them through the Bridge T-EAC
 * validator. Body: { quarter, registryIds (≤ 20), unit? }. Stores nothing.
 */
export async function POST(req: Request) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const quarter = parseQuarter(typeof body?.quarter === "string" ? body.quarter : null);
  if (!quarter) return Response.json({ error: "Invalid quarter" }, { status: 400 });
  const ids = body?.registryIds;
  if (!Array.isArray(ids) || !ids.length || ids.length > VALIDATOR_BATCH || !ids.every((x) => typeof x === "string" && x.length <= 40)) {
    return Response.json({ error: `Pick 1 to ${VALIDATOR_BATCH} devices` }, { status: 400 });
  }
  const unit = body?.unit === "kWh" ? "kWh" : "MWh";
  try {
    const devices = new Map((await loadDevices(appDb(), irecDb())).map((d) => [d.registryId, d]));
    const files: { registryId: string; name: string; data: Uint8Array }[] = [];
    const notFound: string[] = [];
    const opts = { simulate: simulatePlaceholders() };
    for (const id of ids as string[]) {
      const device = devices.get(id);
      const payload = device && (await loadHourly(appDb(), id, quarter));
      if (!device || !payload) notFound.push(id);
      else files.push({ registryId: id, name: outputFileName(device, quarter), data: await renderMeterXlsx(payload, device, quarter, unit, opts) });
    }
    const results = files.length ? await validateFiles(files) : [];
    return Response.json({
      results: [
        ...files.map((f, i) => ({ registryId: f.registryId, ...results[i] })),
        ...notFound.map((registryId) => ({ registryId, fileName: "", status: "error", error: "Not processed for this quarter", checks: [], passed: 0, total: 0 })),
      ],
    });
  } catch (e) {
    if (e instanceof IrecUnavailableError) return irecUnavailableResponse(e);
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
