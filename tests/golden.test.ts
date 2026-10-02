/**
 * Golden checks against the Python pipeline in ../wind-data-analysis (set 2,
 * Q2 2026) and the "As per Hourly Statement" columns of Q2 - Delivery_Detailed.xlsx.
 * Skipped automatically when the raw files are not on this machine.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildHourly } from "@/lib/hourly";
import { detectAndParse, type InputFile } from "@/lib/parsers/detect";
import { parseQuarter } from "@/lib/quarter";
import type { Series } from "@/lib/types";

const RAW = process.env.RAW_DIR ?? "/Users/bhuvanesh/Downloads/Hourly Raw Files";
const q2 = parseQuarter("2026-Q2")!;

function load(...names: string[]): InputFile[] {
  return names.flatMap((n) => {
    const p = path.join(RAW, n);
    if (n.endsWith("/")) return readdirSync(p).map((f) => ({ name: `${n}${f}`, data: readFileSync(path.join(p, f)) }));
    return [{ name: n, data: readFileSync(p) }];
  });
}

function monthly(s: Series) {
  const b = buildHourly(s);
  const m = [0, 0, 0];
  for (const [ts, v] of b.hours) {
    if (ts < q2.start || ts >= q2.end) continue;
    m[new Date(ts).getUTCMonth() - 3] += v / 1000;
  }
  return { m, total: m[0] + m[1] + m[2], build: b };
}

describe.skipIf(!existsSync(RAW))("golden Q2 2026", () => {
  it("Regen mean files match Python set-2 totals", async () => {
    const { series, warnings } = await detectAndParse(
      load("RSMKP-01 MEAN file 01.01.26/", ...[2, 3, 4, 5, 6].map((i) => `RSMKP-0${i} MEAN FILE APRL TO JUNE.zip`)),
    );
    const expected: Record<string, number> = {
      "RSMKP-01": 1_164_599, "RSMKP-02": 1_240_243, "RSMKP-03": 1_133_341,
      "RSMKP-04": 1_232_328, "RSMKP-05": 1_387_603, "RSMKP-06": 1_120_662,
    };
    console.log(warnings);
    for (const [alias, kwh] of Object.entries(expected)) {
      const s = series.find((x) => x.alias === alias)!;
      expect(s, alias).toBeDefined();
      const { total } = monthly(s);
      console.log(alias, total.toFixed(3));
      expect(Math.abs(total * 1000 - kwh), alias).toBeLessThan(1);
    }
  });

  it("SCADA stacked exports match Python totals", async () => {
    const { series } = await detectAndParse(load("uthiur data june.xlsx", "Ottapidaram - data april to june.xlsx"));
    const uth = (a: string) => series.find((s) => s.alias === a && s.sourceName.startsWith("uthiur"))!;
    for (const [a, kwh] of [["ERW01", 2_111_283], ["ERW02", 1_996_114], ["ERW03", 2_235_170]] as const) {
      const { total } = monthly(uth(a));
      expect(Math.abs(total * 1000 - kwh), a).toBeLessThan(1);
    }
    console.log(series.map((s) => `${s.sourceName}:${s.alias}`));
  });

  it("power trend + hourly rows match the delivery sheet's hourly statement", async () => {
    const { series } = await detectAndParse(load("JPP Mills Pvt Ltd Active power.xlsx", "NVL242 - Hourly Production.xlsx"));
    const expected: Record<string, number[]> = {
      KYS060: [192.774204, 667.180594, 1075.366932],
      NVL137: [103.125361, 560.275944, 948.386839],
      // the delivery sheet says 86.916 for April; the Python pipeline (and this one) give 89.169
      NVL242: [89.168844, 518.047, 852.241],
    };
    for (const [alias, months] of Object.entries(expected)) {
      const { m } = monthly(series.find((s) => s.alias === alias)!);
      console.log(alias, m);
      m.forEach((v, i) => expect(Math.abs(v - months[i]), `${alias} m${i}`).toBeLessThan(0.01));
    }
  });

  it("daily matrix parses all three SMTKP turbines", async () => {
    const { series } = await detectAndParse(load("Hourly Generation data_Santhosh Meenakshi.xlsx"));
    expect(series.map((s) => s.alias).sort()).toEqual(["SMTKP-01", "SMTKP-02", "SMTKP-03"]);
    for (const s of series) console.log(s.alias, monthly(s).m);
  });
});
