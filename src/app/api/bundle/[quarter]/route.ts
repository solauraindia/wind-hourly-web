import { zipSync } from "fflate";
import { loadResults, readOutputFile } from "@/lib/repo";

/** Every hourly file of the quarter in one zip. */
export async function GET(_req: Request, ctx: RouteContext<"/api/bundle/[quarter]">) {
  const { quarter } = await ctx.params;
  const results = Object.values(await loadResults(quarter));
  const entries: Record<string, Uint8Array> = {};
  for (const r of results) {
    const data = await readOutputFile(quarter, r.fileName);
    if (data) entries[r.fileName] = new Uint8Array(data);
  }
  if (!Object.keys(entries).length) return new Response("Nothing processed for this quarter", { status: 404 });
  const zip = zipSync(entries, { level: 6 });
  return new Response(new Uint8Array(zip), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="hourly_${quarter}.zip"`,
    },
  });
}
