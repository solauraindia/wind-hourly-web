import { renderHourly, type Unit } from "@/lib/output";
import { parseQuarter } from "@/lib/quarter";
import { loadDevices, saveResult } from "@/lib/repo";
import type { HourlyResult } from "@/lib/types";
import { getUpload } from "@/lib/uploads";

export const maxDuration = 300;

interface Body {
  uploadId: string;
  quarter: string;
  unit?: Unit;
  mappings: { seriesKey: string; deviceId: string }[];
}

/** Build the template workbook for every mapped series and store it under the quarter. */
export async function POST(req: Request) {
  const body = (await req.json()) as Body;
  const quarter = parseQuarter(body.quarter);
  if (!quarter) return Response.json({ error: `Invalid quarter '${body.quarter}'` }, { status: 400 });
  const upload = getUpload(body.uploadId);
  if (!upload) return Response.json({ error: "Upload expired — please add the files again" }, { status: 410 });

  const mappings = body.mappings.filter((m) => m.deviceId);
  const seen = new Set<string>();
  for (const m of mappings) {
    if (seen.has(m.deviceId)) return Response.json({ error: `Device '${m.deviceId}' is mapped to more than one series` }, { status: 400 });
    seen.add(m.deviceId);
  }

  const devices = new Map((await loadDevices()).map((d) => [d.id, d]));
  const results: HourlyResult[] = [];
  const errors: { seriesKey: string; message: string }[] = [];
  for (const m of mappings) {
    const series = upload.series.find((s) => s.key === m.seriesKey);
    const device = devices.get(m.deviceId);
    if (!series || !device) {
      errors.push({ seriesKey: m.seriesKey, message: !series ? "Unknown series" : `Unknown device '${m.deviceId}'` });
      continue;
    }
    try {
      const { xlsx, result } = await renderHourly(series, device, quarter, body.unit ?? "MWh");
      if (result.hoursWritten === 0) {
        errors.push({ seriesKey: m.seriesKey, message: `No data inside ${quarter.key}` });
        continue;
      }
      await saveResult(result, xlsx);
      results.push(result);
    } catch (e) {
      errors.push({ seriesKey: m.seriesKey, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return Response.json({ results, errors });
}
