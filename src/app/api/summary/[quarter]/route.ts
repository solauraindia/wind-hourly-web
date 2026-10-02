import { getActualsProvider } from "@/lib/actuals";
import { parseQuarter } from "@/lib/quarter";
import { loadDevices, loadResults } from "@/lib/repo";
import { buildSummary, summaryWorkbook } from "@/lib/summary";

export async function GET(_req: Request, ctx: RouteContext<"/api/summary/[quarter]">) {
  const quarter = parseQuarter((await ctx.params).quarter);
  if (!quarter) return new Response("Invalid quarter", { status: 400 });
  const [devices, results, actuals] = await Promise.all([
    loadDevices(),
    loadResults(quarter.key),
    getActualsProvider().getQuarter(quarter),
  ]);
  const xlsx = await summaryWorkbook(quarter, buildSummary(devices, results, actuals));
  return new Response(new Uint8Array(xlsx), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${quarter.key}_summary.xlsx"`,
    },
  });
}
