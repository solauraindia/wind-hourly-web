import { requireApiUser } from "@/lib/auth/server";
import { contentDisposition } from "@/lib/validate";
import { appDb, irecDb } from "@/lib/db";
import { irecActuals } from "@/lib/irec";
import { parseQuarter } from "@/lib/quarter";
import { loadDevices, loadResults } from "@/lib/store";
import { buildSummary, summaryWorkbook } from "@/lib/summary";

export async function GET(_req: Request, ctx: RouteContext<"/api/summary/[quarter]">) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const quarter = parseQuarter((await ctx.params).quarter);
  if (!quarter) return new Response("Invalid quarter", { status: 400 });
  const devices = await loadDevices(appDb(), irecDb());
  const [results, actuals] = await Promise.all([
    loadResults(appDb(), quarter.key),
    irecActuals(irecDb(), quarter, devices.map((d) => d.registryId)),
  ]);
  const xlsx = await summaryWorkbook(quarter, buildSummary(devices, results, actuals));
  return new Response(new Uint8Array(xlsx), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": contentDisposition(`${quarter.key}_summary.xlsx`),
    },
  });
}
