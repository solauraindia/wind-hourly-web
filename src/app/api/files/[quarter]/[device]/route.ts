import { requireApiUser } from "@/lib/auth/server";
import { appDb, irecDb } from "@/lib/db";
import { outputFileName, renderMeterXlsx } from "@/lib/output";
import { parseQuarter } from "@/lib/quarter";
import { loadDevices, loadHourly } from "@/lib/store";

/** Render one hourly file on demand from the stored values. ?unit=MWh|kWh */
export async function GET(req: Request, ctx: RouteContext<"/api/files/[quarter]/[device]">) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const params = await ctx.params;
  const quarter = parseQuarter(params.quarter);
  const unit = new URL(req.url).searchParams.get("unit") === "kWh" ? "kWh" : "MWh";
  const registryId = decodeURIComponent(params.device);
  if (!quarter) return new Response("Invalid quarter", { status: 400 });
  const device = (await loadDevices(appDb(), irecDb())).find((d) => d.registryId === registryId);
  const payload = device && (await loadHourly(appDb(), registryId, quarter));
  if (!device || !payload) return new Response("Not found", { status: 404 });
  const name = outputFileName(device, quarter);
  return new Response(new Uint8Array(await renderMeterXlsx(payload, device, quarter, unit)), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${name}"`,
    },
  });
}
