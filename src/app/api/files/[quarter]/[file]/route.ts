import { readOutputFile } from "@/lib/repo";

export async function GET(_req: Request, ctx: RouteContext<"/api/files/[quarter]/[file]">) {
  const { quarter, file } = await ctx.params;
  const name = decodeURIComponent(file);
  const data = await readOutputFile(quarter, name);
  if (!data) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(data), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${name}"`,
    },
  });
}
