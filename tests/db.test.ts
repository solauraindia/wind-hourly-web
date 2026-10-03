import { existsSync, readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { computeHourly, quarterHours, type HourlyPayload } from "@/lib/compute";
import { irecActuals, irecDevices } from "@/lib/irec";
import { renderMeterXlsx } from "@/lib/output";
import { detectAndParse } from "@/lib/parsers/detect";
import { parseQuarter } from "@/lib/quarter";
import { loadDevices, loadHourly, loadMappings, loadResults, mappingsVersion, saveHourly, saveMappings } from "@/lib/store";
import { appTestDb, irecFixture } from "./support/pglite";

const q2 = parseQuarter("2026-Q2")!;


function payload(registryId: string, fill: (i: number) => number | null): HourlyPayload {
  const kwh = Array.from({ length: quarterHours(q2) }, (_, i) => fill(i));
  return {
    registryId,
    quarter: q2.key,
    format: "regen-mean",
    sourceName: "test",
    kwh,
    estimated: [3],
    missing: kwh.flatMap((v, i) => (v === null ? [[i, "register sample missing at hour boundary"] as [number, string]] : [])),
    gaps: [[q2.start, q2.start + 600_000, 2]],
  };
}

describe("app database", () => {
  it("migrations seed the 17 Q2 device mappings", async () => {
    const db = await appTestDb();
    const m = await loadMappings(db);
    expect(m).toHaveLength(17);
    expect(m[3]).toEqual({ registryId: "2.7MES20012", alias: "ERW01", outputName: "Ottapidaram-ERW01", sourceHint: "Ottapidaram" });
  });

  it("joins mappings with irec master data", async () => {
    const [app, irec] = await Promise.all([appTestDb(), irecFixture()]);
    const devices = await loadDevices(app, irec);
    const d = devices.find((x) => x.registryId === "1.5MWIND016")!;
    expect(d).toMatchObject({ meterId: "59244760157", client: "Rajaguru Spinning Mills Pvt Ltd", inIrec: true, outputName: "RSMKP-04" });
    expect(devices.find((x) => x.registryId === "2.1MWIND007")!.inIrec).toBe(false);
    expect((await irecDevices(irec, ["1.5MWIND016", "2.7MES20003", "nope"])).size).toBe(2);
  });

  it("stores, replaces and reloads an hourly statement exactly", async () => {
    const db = await appTestDb();
    const first = await saveHourly(db, payload("1.5MWIND016", () => 1), "a@x.in");
    expect(first.totalMWh).toBeCloseTo(2.184, 9);
    const p = payload("1.5MWIND016", (i) => (i % 100 === 7 ? null : 123.456));
    const r = await saveHourly(db, p, "b@x.in");
    expect(r.hoursMissing).toBe(22);
    expect(r.totalMWh).toBe(Math.round((2184 - 22) * 123456) / 1e6);
    const back = await loadHourly(db, "1.5MWIND016", q2);
    expect(back).toEqual(p);
    const results = await loadResults(db, q2.key);
    expect(Object.keys(results)).toEqual(["1.5MWIND016"]);
    expect(results["1.5MWIND016"]).toMatchObject({ processedBy: "b@x.in", totalMWh: r.totalMWh, monthlyMWh: r.monthlyMWh });
    const [{ n }] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM hourly_values");
    expect(n).toBe(2184 - 22);
  });

  it("rejects malformed payloads", async () => {
    const db = await appTestDb();
    await expect(saveHourly(db, { ...payload("1.5MWIND016", () => 1), kwh: [1, 2] }, null)).rejects.toThrow(/expected 2184/);
    await expect(saveHourly(db, payload("1.5MWIND016", () => 99999), null)).rejects.toThrow(/out of range/);
    await expect(saveHourly(db, payload("1.5MWIND016", () => null), null)).rejects.toThrow(/no data/);
  });

  it("removing a mapping deletes its hourly data; order follows the array", async () => {
    const db = await appTestDb();
    await saveHourly(db, payload("1.5MWIND016", () => 1), null);
    const keep = (await loadMappings(db)).filter((m) => m.registryId !== "1.5MWIND016").reverse();
    await saveMappings(db, keep, "a@x.in", await mappingsVersion(db));
    expect((await loadMappings(db)).map((m) => m.registryId)).toEqual(keep.map((m) => m.registryId));
    expect(await loadResults(db, q2.key)).toEqual({});
  });
});

describe("irec actuals", () => {
  it("sums eligible and issuances within the quarter only", async () => {
    const irec = await irecFixture();
    const a = await irecActuals(irec, q2, ["1.5MWIND016", "2.7MES20003"]);
    expect(a["1.5MWIND016"].actualMWh).toEqual([109.061, 382.025, 708.754]);
    expect(a["1.5MWIND016"].eligibleMWh).toBeCloseTo(1003.091, 6);
    expect(a["1.5MWIND016"].issuedMWh).toBeCloseTo(621.066, 6);
    expect(a["2.7MES20003"]).toEqual({ registryId: "2.7MES20003", actualMWh: [null, null, null], eligibleMWh: null, issuedMWh: null });
  });
});

const RAW = "/Users/bhuvanesh/Downloads/Hourly Raw Files/RSMKP-04 MEAN FILE APRL TO JUNE.zip";
describe.skipIf(!existsSync(RAW))("end to end", () => {
  it("raw zip → browser compute → database → xlsx keeps the Python total", async () => {
    const { series } = await detectAndParse([{ name: "RSMKP-04 MEAN FILE APRL TO JUNE.zip", data: readFileSync(RAW) }]);
    const [app, irec] = await Promise.all([appTestDb(), irecFixture()]);
    const result = await saveHourly(app, computeHourly(series[0], "1.5MWIND016", q2), null);
    expect(result.totalMWh).toBeCloseTo(1232.327614, 6);
    const device = (await loadDevices(app, irec)).find((d) => d.registryId === "1.5MWIND016")!;
    const xlsx = await renderMeterXlsx((await loadHourly(app, "1.5MWIND016", q2))!, device, q2, "MWh");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx as unknown as ArrayBuffer);
    const ws = wb.getWorksheet("MeterData")!;
    let sum = 0;
    ws.eachRow((row, n) => {
      if (n > 1) sum += Number(row.getCell(4).value);
    });
    expect(ws.rowCount - 1).toBe(2164);
    expect(sum).toBeCloseTo(1232.327614, 6);
    expect(ws.getRow(2).values).toEqual([
      undefined, "2026-04-01T00:00:00+05:30", "Asia/Kolkata", "2026-03-31T18:30:00Z", ws.getRow(2).getCell(4).value,
      "MWh", 59244760157, "1.5 MW at Seepalakottai Village, HTSC 0157", "1.5MWIND016",
    ]);
  });
});
