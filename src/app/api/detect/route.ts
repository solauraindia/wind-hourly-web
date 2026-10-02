import { detectAndParse, type InputFile } from "@/lib/parsers/detect";
import { suggestDevice } from "@/lib/registry";
import { loadDevices } from "@/lib/repo";
import type { SeriesInfo } from "@/lib/types";
import { putUpload } from "@/lib/uploads";

export const maxDuration = 300;

/** Parse uploaded raw files, auto-detect their layout and suggest a device per series. */
export async function POST(req: Request) {
  const form = await req.formData();
  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  const paths = form.getAll("paths").map(String);
  if (!files.length) return Response.json({ error: "No files uploaded" }, { status: 400 });

  const inputs: InputFile[] = await Promise.all(
    files.map(async (f, i) => ({ name: paths[i] || f.name, data: new Uint8Array(await f.arrayBuffer()) })),
  );
  const [{ series, warnings }, devices] = await Promise.all([detectAndParse(inputs), loadDevices()]);
  const uploadId = putUpload(series, warnings);

  const info: SeriesInfo[] = series.map((s) => {
    const ts = s.kind === "ten-min" ? s.samples.map((x) => x.ts) : s.hours.map(([t]) => t);
    return {
      key: s.key,
      alias: s.alias,
      format: s.format,
      sourceName: s.sourceName,
      points: ts.length,
      firstTs: ts.length ? ts[0] : null,
      lastTs: ts.length ? ts[ts.length - 1] : null,
      suggestedDeviceId: suggestDevice(s.alias, s.sourceName, devices)?.id ?? null,
    };
  });
  info.sort((a, b) => a.sourceName.localeCompare(b.sourceName) || a.alias.localeCompare(b.alias));
  return Response.json({ uploadId, series: info, warnings });
}
