import ExcelJS from "exceljs";
import { describe, expect, it, afterEach } from "vitest";
import { quarterHours, type HourlyPayload } from "@/lib/compute";
import { VALIDATOR_URL, validateFiles } from "@/lib/meterValidator";
import { renderMeterXlsx, renderMissingXlsx, simulatePlaceholders } from "@/lib/output";
import { parseQuarter } from "@/lib/quarter";
import type { Device } from "@/lib/types";

const q3 = parseQuarter("2026-Q3")!;
const device: Device = {
  id: "2.7MES20003", registryId: "2.7MES20003", alias: "T1", outputName: "Uthiyur-T1", client: "C",
  meterId: "", facilityId: "2.7 MW Uthiyur Village, HTSC No.2297", inIrec: true,
};

function payload(): HourlyPayload {
  const kwh = Array.from({ length: quarterHours(q3) }, (_, i) => (i === 5 || i === 6 ? null : i === 7 ? -2.7 : i === 8 ? 0 : 1687.4));
  return { registryId: device.registryId, quarter: q3.key, format: "power-trend", sourceName: "t", kwh, estimated: [], missing: [[5, "only 0/6 power samples"], [6, "only 2/6 power samples"]], gaps: [] };
}

async function sheetOf(xlsx: Uint8Array) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsx as unknown as ArrayBuffer);
  return wb;
}

describe("meter file for the Bridge T-EAC validator", () => {
  it("has one sheet and a row for every hour; null stays null, zero and negative go out positive", async () => {
    const wb = await sheetOf(await renderMeterXlsx(payload(), device, q3, "MWh"));
    expect(wb.worksheets).toHaveLength(1);
    const ws = wb.worksheets[0];
    expect(ws.rowCount - 1).toBe(2208);
    const value = (hour: number) => ws.getRow(hour + 2).getCell(4).value;
    // this source logs 0.1 kWh, so the smallest positive is 0.0001 MWh
    expect([value(4), value(5), value(6), value(7), value(8)]).toEqual([1.6874, "null", "null", 0.0001, 0.0001]);
    expect(ws.getRow(2208 + 1).getCell(1).value).toBe("2026-09-30T23:00:00+05:30");
    // no meter id in irec: the device id stands in, so no cell is blank; no metering_type on a gross file
    expect((ws.getRow(2).values as unknown[]).slice(2)).toEqual(["Asia/Calcutta", "2026-06-30T18:30:00Z", 1.6874, "MWh", "2.7MES20003", "2.7MES20003", "evident"]);
    expect(ws.getRow(1).cellCount).toBe(8);
  });

  it("uses the smallest positive whole kWh (0.001 MWh) when the source counts whole kWh", async () => {
    const p = payload();
    p.kwh = p.kwh.map((v) => (v === null ? null : Math.round(v)));
    const mwh = (await sheetOf(await renderMeterXlsx(p, device, q3, "MWh"))).worksheets[0];
    const mwhValue = (hour: number) => mwh.getRow(hour + 2).getCell(4).value;
    expect([mwhValue(7), mwhValue(8)]).toEqual([0.001, 0.001]);
    // in kWh the same floor is 1
    const kwh = (await sheetOf(await renderMeterXlsx(p, device, q3, "kWh"))).worksheets[0];
    const kwhValue = (hour: number) => kwh.getRow(hour + 2).getCell(4).value;
    expect([kwhValue(7), kwhValue(8)]).toEqual([1, 1]);
  });

  it("simulation mode fills nulls at random 1–9 and renders the same file twice", async () => {
    const p = payload();
    for (let i = 10; i < 40; i++) p.kwh[i] = 0;
    const a = (await sheetOf(await renderMeterXlsx(p, device, q3, "MWh", { simulate: true }))).worksheets[0];
    const b = (await sheetOf(await renderMeterXlsx(p, device, q3, "MWh", { simulate: true }))).worksheets[0];
    const values = Array.from({ length: 30 }, (_, k) => a.getRow(10 + k + 2).getCell(4).value as number);
    expect(values).toEqual(Array.from({ length: 30 }, (_, k) => b.getRow(10 + k + 2).getCell(4).value));
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0.0001);
    expect(Math.max(...values)).toBeLessThanOrEqual(0.0009);
    expect(new Set(values).size).toBeGreaterThan(5);
    for (const v of values) expect(Math.abs(v * 1e4 - Math.round(v * 1e4))).toBeLessThan(1e-9);
    // hours with no source reading are filled too
    for (const i of [5, 6]) {
      const v = a.getRow(i + 2).getCell(4).value as number;
      expect(v).toBeGreaterThanOrEqual(0.0001);
      expect(v).toBeLessThanOrEqual(0.0009);
    }
  });

  it("labels simulated placeholders in the report", async () => {
    const ws = (await sheetOf(await renderMissingXlsx(payload(), device, q3, { simulate: true }))).worksheets[0];
    const text: string[] = [];
    ws.eachRow((r) => text.push((r.values as unknown[]).slice(1).join(" | ")));
    expect(text).toContain("Hours with a value in MeterData: 2208 (all rows filled; 2 had no source reading)");
    expect(text).toContain("  of which zero or negative: 2, written as 0.1–0.9 kWh (simulated demo values, seeded per hour)");
    expect(text).toContain("Hours with no source reading (simulated): 2");
    expect(text.some((t) => t.startsWith("2026-07-01 05:00:00 | only 0/6 power samples | 0."))).toBe(true);
  });

  it("puts the reasons and the substituted hours in a separate report", async () => {
    const ws = (await sheetOf(await renderMissingXlsx(payload(), device, q3))).worksheets[0];
    const text: string[] = [];
    ws.eachRow((r) => text.push((r.values as unknown[]).slice(1).join(" | ")));
    expect(text).toContain("2026-07-01 05:00:00 | only 0/6 power samples");
    expect(text).toContain("Hours with a value in MeterData: 2206 (the other 2 are written as null)");
    expect(text).toContain("  of which zero or negative: 2, written as 0.1 kWh (the smallest positive at this source's precision)");
    expect(text).toContain("2026-07-01 07:00:00 | -2.7");
    expect(text).toContain("2026-07-01 08:00:00 | 0");
  });
});

describe("simulation flag", () => {
  const prev = process.env.SIMULATE_PLACEHOLDERS;
  afterEach(() => {
    if (prev === undefined) delete process.env.SIMULATE_PLACEHOLDERS;
    else process.env.SIMULATE_PLACEHOLDERS = prev;
  });

  it("is on unless explicitly turned off", () => {
    delete process.env.SIMULATE_PLACEHOLDERS;
    expect(simulatePlaceholders()).toBe(true);
    process.env.SIMULATE_PLACEHOLDERS = "";
    expect(simulatePlaceholders()).toBe(true);
    process.env.SIMULATE_PLACEHOLDERS = "false";
    expect(simulatePlaceholders()).toBe(false);
    process.env.SIMULATE_PLACEHOLDERS = "0";
    expect(simulatePlaceholders()).toBe(false);
    process.env.SIMULATE_PLACEHOLDERS = "true";
    expect(simulatePlaceholders()).toBe(true);
  });
});

describe("validateFiles", () => {
  const raw = {
    overallStatus: "fail",
    fileCount: 1,
    results: [{
      fileName: "a.xlsx",
      overallStatus: "fail",
      result: {
        overallStatus: "fail",
        summary: { totalRows: 3, meterLocalTimeRanges: [{ meterId: "1", timeRange: { start: "2026-07-01T00:00:00+05:30", end: "2026-07-01T02:00:00+05:30" } }] },
        checks: [
          { id: "file-format", name: "File Format", status: "pass", message: "ok", issues: [], totalIssues: 0 },
          { id: "missing-readings", name: "Missing Readings", status: "warn", message: "1 null", issues: [{ row: 3, column: "value", value: "null", message: "null reading" }], totalIssues: 1 },
          { id: "time-continuity", name: "Time Continuity", status: "fail", message: "1 gap", issues: Array.from({ length: 12 }, (_, k) => ({ row: k, message: "gap" })), totalIssues: 12 },
        ],
      },
    }],
  };

  it("sends the files as a batch and keeps only what did not pass", async () => {
    let sent: FormData | undefined;
    const fake = (async (url: string, init: RequestInit) => {
      expect(url).toBe(VALIDATOR_URL);
      sent = init.body as FormData;
      return Response.json(raw);
    }) as unknown as typeof fetch;
    const [r] = await validateFiles([{ name: "a.xlsx", data: new Uint8Array([1, 2]) }], fake);
    expect(sent!.getAll("files")).toHaveLength(1);
    expect(r).toMatchObject({ fileName: "a.xlsx", status: "fail", rows: 3, passed: 1, total: 3, localEnd: "2026-07-01T02:00:00+05:30" });
    expect(r.checks.map((c) => [c.id, c.status, c.issues.length, c.totalIssues])).toEqual([["missing-readings", "warn", 1, 1], ["time-continuity", "fail", 10, 12]]);
  });

  it("shows a pass that carries warnings as warn", async () => {
    const checks = raw.results[0].result.checks.slice(0, 2);
    const fake = (async () => Response.json({ results: [{ fileName: "a.xlsx", overallStatus: "pass", result: { overallStatus: "pass", checks } }] })) as unknown as typeof fetch;
    expect((await validateFiles([{ name: "a.xlsx", data: new Uint8Array() }], fake))[0].status).toBe("warn");
  });

  it("explains the rate limit", async () => {
    const fake = (async () => Response.json({ error: "Too many requests" }, { status: 429 })) as unknown as typeof fetch;
    await expect(validateFiles([{ name: "a.xlsx", data: new Uint8Array() }], fake)).rejects.toThrow(/15 requests a minute/);
  });
});
