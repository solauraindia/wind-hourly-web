/** Regression tests for the issues raised in the Fable review. */
import { describe, expect, it } from "vitest";
import type { DeviceActuals } from "@/lib/actuals";
import { computeHourly, quarterHours, type HourlyPayload } from "@/lib/compute";
import { irecActuals, irecDevices } from "@/lib/irec";
import { defaultQuarterKey, parseQuarter, recentQuarters } from "@/lib/quarter";
import {
  StaleMappingsError, deletionImpact, loadDevicesSafe, loadMappings, mappingsVersion, saveHourly, saveMappings, validatePayload,
} from "@/lib/store";
import { buildSummary, summaryTotals } from "@/lib/summary";
import type { Db } from "@/lib/db";
import type { Device, HourlyResult } from "@/lib/types";
import { cleanMapping, cleanMappings, contentDisposition, isAllowed, isAllowedAuthPath } from "@/lib/validate";
import { irecFixture } from "./db.test";
import { appTestDb } from "./support/pglite";

const q2 = parseQuarter("2026-Q2")!;
const n = quarterHours(q2);

function payload(over: Partial<HourlyPayload> = {}): HourlyPayload {
  const kwh = Array.from({ length: n }, (_, i) => (i === 5 ? null : 10.12345));
  return { registryId: "1.5MWIND016", quarter: q2.key, format: "regen-mean", sourceName: "src", kwh, estimated: [1], missing: [[5, "gap"]], gaps: [], ...over };
}

describe("auth path allow-list (decoded params)", () => {
  it("allows only sign-in/email, sign-out and get-session", () => {
    expect(isAllowedAuthPath(["sign-in", "email"])).toBe(true);
    expect(isAllowedAuthPath(["sign-out"])).toBe(true);
    expect(isAllowedAuthPath(["get-session"])).toBe(true);
  });
  it("refuses sign-up and social however the path is encoded", () => {
    // what Next hands over for /sign-up/email, /sign%2Dup/email and /sign-up%2Femail
    expect(isAllowedAuthPath(["sign-up", "email"])).toBe(false);
    expect(isAllowedAuthPath(["sign-up/email"])).toBe(false);
    expect(isAllowedAuthPath(["sign-in", "social"])).toBe(false);
    expect(isAllowedAuthPath(["sign-in/social"])).toBe(false);
    expect(isAllowedAuthPath(["sign-in%2Femail"])).toBe(false); // double-encoded stays encoded
    expect(isAllowedAuthPath(["SIGN-IN", "email"])).toBe(false);
    expect(isAllowedAuthPath(["magic-link", "verify"])).toBe(false);
    expect(isAllowedAuthPath(["email-otp", "send-verification-otp"])).toBe(false);
    expect(isAllowedAuthPath(["sign-in", "email", ""])).toBe(false);
  });
});

describe("ALLOWED_EMAILS fails closed", () => {
  it("admits nobody when the list is empty", () => {
    const prev = process.env.ALLOWED_EMAILS;
    process.env.ALLOWED_EMAILS = "";
    expect(isAllowed("anyone@solaurapower.com")).toBe(false);
    process.env.ALLOWED_EMAILS = " Ops@SolauraPower.com , x@y.in";
    expect(isAllowed("ops@solaurapower.com")).toBe(true);
    expect(isAllowed("other@solaurapower.com")).toBe(false);
    process.env.ALLOWED_EMAILS = prev;
  });
});

describe("output names and headers", () => {
  it("rejects names that break headers, zips or paths", () => {
    for (const bad of ["RSMKP–04", "../x", "a/b", 'a"b', "a;b", "with space", "", "தமிழ்"]) {
      expect(typeof cleanMapping({ registryId: "R1", alias: "ERW01", outputName: bad || "-" })).toBe("string");
    }
    expect(cleanMapping({ registryId: " R1 ", alias: "ERW 01", outputName: "Ottapidaram-ERW01", sourceHint: " " })).toEqual({
      registryId: "R1", alias: "ERW 01", outputName: "Ottapidaram-ERW01", sourceHint: undefined,
    });
  });
  it("rejects duplicates case-insensitively", () => {
    expect(cleanMappings([{ registryId: "A", alias: "X", outputName: "N1" }, { registryId: "B", alias: "Y", outputName: "n1" }])).toMatch(/Duplicate output name/);
    expect(cleanMappings("nope")).toMatch(/array/);
  });
  it("Content-Disposition is always a valid header value", () => {
    const cd = contentDisposition("RSMKP–04 \"x\"_hourly.xlsx");
    expect(() => new Headers({ "Content-Disposition": cd })).not.toThrow();
    expect(cd).toContain("filename*=UTF-8''RSMKP%E2%80%9304");
  });
});

describe("payload validation", () => {
  it("normalises a good payload", () => {
    const { payload: p } = validatePayload(payload({ estimated: [2, 1, 1] }));
    expect(p.kwh[0]).toBe(10.123);
    expect(p.estimated).toEqual([1, 2]);
  });
  it.each([
    ["gaps not triples", { gaps: [1] as unknown as HourlyPayload["gaps"] }, /gap/],
    ["gap outside quarter", { gaps: [[0, 1, 1]] as HourlyPayload["gaps"] }, /gap/],
    ["prototype format", { format: "constructor" as HourlyPayload["format"] }, /format/],
    ["estimated hour without value", { estimated: [5] }, /no value/],
    ["missing list disagrees", { missing: [] }, /do not match/],
    ["missing list extra", { missing: [[5, "a"], [6, "b"]] as [number, string][] }, /do not match/],
    ["huge source name", { sourceName: "x".repeat(201) }, /source name/],
    ["no registry id", { registryId: "" }, /registry/],
  ])("rejects %s", (_, over, err) => {
    expect(() => validatePayload(payload(over as Partial<HourlyPayload>))).toThrow(err);
  });
  it("browser-computed payloads always pass", async () => {
    const series = { kind: "hourly" as const, key: "k", alias: "A", format: "hourly-long" as const, sourceName: "f", hours: [[q2.start + 3_600_000, 5.5]] as [number, number][], blankHours: [] };
    expect(() => validatePayload(computeHourly(series, "1.5MWIND016", q2))).not.toThrow();
  });
});

describe("device mapping saves", () => {
  it("a stale version is rejected and nothing changes", async () => {
    const db = await appTestDb();
    const v = await mappingsVersion(db);
    const all = await loadMappings(db);
    await saveMappings(db, all, "a@x.in", v); // someone else saves first
    await expect(saveMappings(db, all.slice(1), "b@x.in", v)).rejects.toBeInstanceOf(StaleMappingsError);
    expect(await loadMappings(db)).toHaveLength(17);
  });
  it("swapping two output names in one save works", async () => {
    const db = await appTestDb();
    const all = await loadMappings(db);
    const [a, b] = [all[0].outputName, all[1].outputName];
    all[0] = { ...all[0], outputName: b };
    all[1] = { ...all[1], outputName: a };
    await saveMappings(db, all, null, await mappingsVersion(db));
    const after = await loadMappings(db);
    expect([after[0].outputName, after[1].outputName]).toEqual([b, a]);
  });
  it("reports which stored quarters a removal would delete", async () => {
    const db = await appTestDb();
    await saveHourly(db, payload(), null);
    const keep = (await loadMappings(db)).map((m) => m.registryId).filter((id) => id !== "1.5MWIND016");
    expect(await deletionImpact(db, keep)).toEqual([{ registryId: "1.5MWIND016", outputName: "RSMKP-04", quarters: ["2026-Q2"] }]);
    expect(await deletionImpact(db, [])).toHaveLength(1);
  });
});

describe("irec", () => {
  it("never double-counts when device_meta_id repeats", async () => {
    const irec = await irecFixture();
    await irec.pg.exec(`
      INSERT INTO devices (device_meta_id, project_description, htsc_no, status, company_id) VALUES ('1.5MWIND016', 'old copy', '000', 'Inactive', 1);
      INSERT INTO devices_monthly_data (device_id, period, actual_gen, eligible_gen) VALUES (3, 202604, 999, 999);
      INSERT INTO issuances (device_id, period, issued_units) VALUES (3, 202604, 999);`);
    const a = await irecActuals(irec, q2, ["1.5MWIND016"]);
    expect(a["1.5MWIND016"].actualMWh[0]).toBe(109.061);
    expect(a["1.5MWIND016"].eligibleMWh).toBeCloseTo(1003.091, 6);
    expect((await irecDevices(irec, ["1.5MWIND016"])).get("1.5MWIND016")!.meterId).toBe("59244760157");
  });
  it("pages keep working when irec is down", async () => {
    const app = await appTestDb();
    const down: Db = { query: async () => { throw new Error("endpoint is disabled"); }, transaction: async () => {} };
    const { devices, irecError } = await loadDevicesSafe(app, down);
    expect(devices).toHaveLength(17);
    expect(irecError).toMatch(/disabled/);
  });
});

describe("summary math", () => {
  const dev = (id: string): Device => ({ id, registryId: id, alias: id, outputName: id, client: "C", meterId: "1", facilityId: "F", inIrec: true });
  const res = (id: string, m: [number, number, number]) => ({ registryId: id, monthlyMWh: m, totalMWh: m[0] + m[1] + m[2] }) as HourlyResult;
  it("diff = actual − hourly, min = min(eligible, hourly), eligible falls back to actual", () => {
    const actuals: Record<string, DeviceActuals> = {
      A: { registryId: "A", actualMWh: [100, 200, 300], eligibleMWh: 500, issuedMWh: 480 },
      B: { registryId: "B", actualMWh: [10, null, 30], eligibleMWh: null, issuedMWh: null },
    };
    const rows = buildSummary([dev("A"), dev("B"), dev("C")], { A: res("A", [90, 210, 320]), B: res("B", [5, 5, 5]) }, actuals);
    expect(rows[0]).toMatchObject({ actualTotal: 600, eligible: 500, hourlyTotal: 620, diff: -20, min: 500, issued: 480 });
    expect(rows[1]).toMatchObject({ actualTotal: 40, eligible: 40, hourlyTotal: 15, diff: 25, min: 15 });
    expect(rows[2]).toMatchObject({ actualTotal: null, hourly: null, diff: null, min: null });
    expect(summaryTotals(rows)).toMatchObject({ actualTotal: 640, hourlyTotal: 635, min: 515, issued: 480 });
  });
});

describe("default quarter uses India time", () => {
  it("rolls over at midnight IST, not UTC", () => {
    expect(defaultQuarterKey(new Date("2026-09-30T18:00:00Z"))).toBe("2026-Q2"); // 23:30 IST, Sep 30
    expect(defaultQuarterKey(new Date("2026-09-30T19:00:00Z"))).toBe("2026-Q3"); // 00:30 IST, Oct 1
    expect(defaultQuarterKey(new Date("2026-12-31T19:00:00Z"))).toBe("2026-Q4"); // 00:30 IST, Jan 1
    expect(recentQuarters(2, new Date("2026-09-30T19:00:00Z"))).toEqual(["2026-Q4", "2026-Q3"]);
  });
});
