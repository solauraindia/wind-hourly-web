import { zipSync } from "fflate";
import { requireApiUser } from "@/lib/auth/server";
import { appDb, irecDb } from "@/lib/db";
import { outputFileName, renderMeterXlsx } from "@/lib/output";
import { parseQuarter } from "@/lib/quarter";
import { loadDevices, loadHourly, loadResults } from "@/lib/store";

export const maxDuration = 60;

/** Every hourly file of the quarter, rendered on demand, in one zip. ?unit=MWh|kWh */
export async function GET(req: Request, ctx: RouteContext<"/api/bundle/[quarter]">) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const quarter = parseQuarter((await ctx.params).quarter);
  if (!quarter) return new Response("Invalid quarter", { status: 400 });
  const unit = new URL(req.url).searchParams.get("unit") === "kWh" ? "kWh" : "MWh";
  const db = appDb();
  const [devices, results] = await Promise.all([loadDevices(db, irecDb()), loadResults(db, quarter.key)]);
  const entries: Record<string, Uint8Array> = {};
  for (const d of devices.filter((d) => results[d.registryId])) {
    const payload = await loadHourly(db, d.registryId, quarter);
    if (payload) entries[outputFileName(d, quarter)] = await renderMeterXlsx(payload, d, quarter, unit);
  }
  if (!Object.keys(entries).length) return new Response("Nothing processed for this quarter", { status: 404 });
  return new Response(new Uint8Array(zipSync(entries, { level: 6 })), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="hourly_${quarter.compact}.zip"`,
    },
  });
}
