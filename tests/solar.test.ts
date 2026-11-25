import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { computeHourly } from "@/lib/compute";
import { buildHourly } from "@/lib/hourly";
import { renderMeterXlsx } from "@/lib/output";
import { detectAndParse } from "@/lib/parsers/detect";
import {
  capacityLabel, fixDayMonthSwaps, hourLabel, hoursFromCounter, hoursFromIntervals, looksCumulative, mergeSolarSeries,
  parseSolarDayBlocks, parseSolarHourGrid, parseSolarReadingGrid, sourceStem,
} from "@/lib/parsers/solar";
import { readHtmlTables, type Row } from "@/lib/parsers/xlsx";
import { parseQuarter } from "@/lib/quarter";
import { suggestDevice } from "@/lib/registry";
import { loadDevices, loadHourly, saveHourly } from "@/lib/store";
import { HOUR, MINUTE, naive } from "@/lib/time";
import type { Series } from "@/lib/types";
import { appTestDb, irecFixture } from "./support/pglite";

const time = (h: number) => new Date(Date.UTC(1899, 11, 30, h));
const day = (d: number, m = 4) => new Date(Date.UTC(2026, m - 1, d));
const hours = (s: Series) => (s.kind === "hourly" ? new Map(s.hours) : new Map());
const at = (d: number, h: number, m = 4) => naive(2026, m, d, h);

describe("labels", () => {
  it("reads capacity and hour labels", () => {
    expect(capacityLabel("6MW-APRIL")).toBe("6MW");
    expect(capacityLabel("x", "Jayavilas_8 MW.xlsx")).toBe("8MW");
    expect(capacityLabel("none")).toBeNull();
    expect(hourLabel(time(6))).toBe(6);
    expect(hourLabel("18:00:00")).toBe(18);
    expect(hourLabel(0.25)).toBe(6);
    expect(hourLabel("06:30")).toBeNull();
    expect(hourLabel(day(1))).toBeNull();
  });

  it("strips export dates and copy numbers from file names", () => {
    expect(sourceStem("KM Knitwear_2MW-Daily Generation TEB-21-11-2026 (3).xls")).toBe("KM Knitwear_2MW-Daily Generation TEB");
    expect(sourceStem("Jayavilas_4 MW.xlsx")).toBe("Jayavilas_4 MW");
  });
});

describe("solar-hour-grid", () => {
  it("days down the side: labels mark the hour start, '-' is missing, unlisted hours are zero", () => {
    const rows: Row[] = [["6MW GENERATION"], ["Date", time(6), time(7), time(8), time(9), time(10), time(11)], [day(1), 10, 20, "-", 40, 50, 60]];
    const [s] = parseSolarHourGrid({ name: "6MW-APRIL", rows }, "ALC.xlsx");
    const h = hours(s);
    expect(s.alias).toBe("6MW");
    expect(h.get(at(1, 6))).toBe(10);
    expect(h.get(at(1, 11))).toBe(60);
    expect(h.has(at(1, 8))).toBe(false);
    expect(s.kind === "hourly" && s.blankHours).toEqual([at(1, 8)]);
    expect(h.get(at(1, 0))).toBe(0);
    expect(h.get(at(1, 12))).toBe(0);
    expect(h.size).toBe(23);
  });

  it("days across the top", () => {
    const rows: Row[] = [[null, day(1), day(2), day(3), day(4), day(5)], ...[6, 7, 8].map((h) => [time(h), h, h, h, h, h] as Row)];
    const [s] = parseSolarHourGrid({ name: "10MW-JUNE", rows }, "ALC.xlsx");
    expect(s.alias).toBe("10MW");
    expect(hours(s).get(at(3, 7))).toBe(7);
    expect(hours(s).size).toBe(5 * 24);
  });
});

describe("hour-ending readings roll forward", () => {
  const grid = (cols: (number | null)[][]): Row[] => [
    [null, "3MW SOLAR HOURLY GENERATION REPORT"],
    [null, "Time/Date", ...cols.map((_, i) => day(i + 1))],
    ...[8, 9, 10, 11].map((h, r) => [null, time(h), ...cols.map((c) => c[r])] as Row),
    [null, "Total Unit", ...cols.map((c) => c.reduce<number>((a, b) => a + (b ?? 0), 0))],
  ];

  it("labels mark the hour end; a blank rolls into the next reading, spread by the typical profile", () => {
    const [s] = parseSolarReadingGrid({ name: "Apr", rows: grid([[100, 200, 300, 400], [100, null, 500, 400]]) }, "Acsen.xlsx");
    const h = hours(s);
    expect(s.alias).toBe("3MW");
    expect(h.get(at(1, 7))).toBe(100); // 08:00 = 07:00–08:00
    expect(h.get(at(1, 10))).toBe(400);
    // day 2: 500 covers 09–10 and 10–11; typical 200 : 300
    expect(h.get(at(2, 8))).toBeCloseTo(200);
    expect(h.get(at(2, 9))).toBeCloseTo(300);
    expect(s.kind === "hourly" && s.estimatedHours).toEqual([at(2, 8), at(2, 9)]);
    // daily totals are kept
    const day2 = [...h].filter(([t]) => t >= at(2, 0) && t < at(3, 0)).reduce((a, [, v]) => a + v, 0);
    expect(day2).toBeCloseTo(1000);
  });

  it("a day without readings is missing; trailing blanks after the last reading are zero", () => {
    const [s] = parseSolarReadingGrid({ name: "Apr", rows: grid([[null, null, null, null], [100, 200, null, null]]) }, "Acsen.xlsx");
    const b = buildHourly(s);
    expect([at(1, 7), at(1, 8), at(1, 9), at(1, 10)].every((t) => b.dropped.get(t) === "blank cell in source")).toBe(true);
    expect(b.hours.get(at(2, 9))).toBe(0);
    expect(b.hours.get(at(2, 10))).toBe(0);
  });

  it("day blocks: plant groups sum their inverter columns", () => {
    const block = (d: number, rows: [number, number | null, number | null, number | null][]): Row[] => [
      ["DATE: ", day(d), "TIME", "HOURLY GII", "HOURLY GHI", "SSML", null, null, "SSTPL"],
      [null, null, null, null, null, "3MW HOURLY INV GEN", "2MW HOURLY INV GEN", null, "2MW HOURLY INV GEN"],
      ...rows.map(([h, a, b, c]) => [null, null, time(h), 0.5, 0.5, a, b, null, c] as Row),
      [null, null, null, null, null, 1, 1, null, 1],
    ];
    // day 2 skips the 10:00 row, so 11:00 covers two hours
    const rows = [...block(1, [[9, 300, 200, 190], [10, 600, 400, 390], [11, 900, 600, 590]]), ...block(2, [[9, 300, 200, 190], [11, 1500, 1000, 980]])];
    const series = parseSolarDayBlocks({ name: "OCT 2026", rows }, "Sambandam.xlsx");
    const ssml = series.find((s) => s.alias === "SSML")!;
    const sstpl = series.find((s) => s.alias === "SSTPL")!;
    expect(hours(ssml).get(at(1, 8))).toBe(500);
    expect(hours(ssml).get(at(1, 10))).toBe(1500);
    expect(hours(sstpl).get(at(1, 9))).toBe(390);
    expect(hours(ssml).get(at(2, 9))! + hours(ssml).get(at(2, 10))!).toBeCloseTo(2500);
    expect(hours(ssml).get(at(2, 9))).toBeCloseTo(1000); // typical 1000 : 1500
  });
});

describe("solar counters", () => {
  const min = (d: number, h: number, mi = 0) => at(d, h) + mi * MINUTE;

  it("differences the counter at hour boundaries, treats a fall as a reset, zeroes the night", () => {
    // a daily counter holding yesterday's total until it resets at 06:30
    const s: [number, number][] = [];
    for (let h = 0; h < 24; h++) s.push([min(1, h), h < 7 ? 900 : h < 12 ? (h - 6) * 100 : 500]);
    const out = hoursFromCounter(s, 5000);
    expect(out.hours.get(at(1, 5))).toBe(0); // 900 → 900
    expect(out.hours.get(at(1, 6))).toBe(100); // reset: 900 → 100 counts 100
    expect(out.hours.get(at(1, 7))).toBe(100);
    expect(out.hours.get(at(1, 11))).toBe(0);
    expect(out.hours.has(at(1, 2))).toBe(false); // night: filled with zero on output
    expect(out.hours.has(at(1, 19))).toBe(false);
  });

  it("shrugs off single-sample spikes and flags counter glitches", () => {
    const s: [number, number][] = [];
    for (let t = 0; t < 24 * 60; t++) s.push([min(1, 0, t), Math.max(0, t - 6 * 60)]);
    s[10 * 60][1] = 63_000_000; // spike exactly on 10:00
    for (let t = 13 * 60 - 5; t <= 13 * 60 + 5; t++) s[t] = [s[t][0], 9e6]; // a run of bad readings at 13:00
    const out = hoursFromCounter(s, 5000);
    // the median around a spiked boundary is off by at most a sample (one minute's energy)
    expect(Math.abs(out.hours.get(at(1, 9))! - 60)).toBeLessThanOrEqual(1);
    expect(Math.abs(out.hours.get(at(1, 10))! - 60)).toBeLessThanOrEqual(1);
    expect(out.dropped.get(at(1, 12))).toMatch(/counter glitch/);
    expect(out.dropped.get(at(1, 13))).toBe("counter glitch (back from a jump)");
    expect(out.hours.get(at(1, 14))).toBe(60);
  });

  it("interval energy: stamps mark the interval end, daylight hours need all four", () => {
    const s: [number, number][] = [];
    for (let k = 0; k < 96; k++) s.push([at(1, 0) + (k + 1) * 15 * MINUTE, k >= 28 && k < 72 ? 100 : 0]);
    s.splice(40, 1); // the 10:00–10:15 interval (stamped 10:15)
    const out = hoursFromIntervals(s);
    expect(out.hours.get(at(1, 7))).toBe(400);
    expect(out.dropped.get(at(1, 10))).toBe("only 3/4 interval readings");
    expect(out.days.size).toBe(1); // the trailing 00:00 stamp closes day 1, not a new day
  });

  it("tells counters from interval energy", () => {
    const counter: [number, number][] = [];
    const interval: [number, number][] = [];
    for (let h = 5; h < 19; h++) {
      counter.push([at(1, h), (h - 5) * 100]);
      interval.push([at(1, h), 100 - Math.abs(12 - h) * 10]);
    }
    expect(looksCumulative(counter)).toBe(true);
    expect(looksCumulative(interval)).toBe(false);
  });

  it("repairs day/month swaps only when the sheet goes back and forth in time", () => {
    const d = (m: number, dd: number) => Date.UTC(2026, m - 1, dd);
    // logged 4–6 Jan, stored month-first
    expect(fixDayMonthSwaps([d(4, 1), d(4, 1), d(5, 1), d(6, 1)])).toEqual([d(1, 4), d(1, 4), d(1, 5), d(1, 6)]);
    const steady = [d(4, 1), d(4, 2), d(4, 3), d(4, 13)];
    expect(fixDayMonthSwaps(steady)).toEqual(steady);
    // one stray old row at the end is left alone
    const stray = [d(9, 1), d(9, 2), d(9, 3), d(9, 4), d(7, 31)];
    expect(fixDayMonthSwaps(stray)).toEqual(stray);
  });
});

describe("HTML .xls and merging", () => {
  it("reads portal HTML tables", () => {
    const html = `﻿<html><table><caption>KM Knitwear_2MW-Daily Generation TEB</caption><thead><tr><th>Time (HH:MM)</th><th>Irradiance(W/m&sup2;)</th><th>Today Energy(kWh)</th></tr></thead>
      <tbody><tr><th scope="row">2026-04-01 00:00:00</th><td>-4.72</td><td>0</td></tr></tbody></table></html>`;
    const [t] = readHtmlTables(new TextEncoder().encode(html));
    expect(t.rows[0]).toEqual(["KM Knitwear_2MW-Daily Generation TEB"]);
    expect(t.rows[2]).toEqual(["2026-04-01 00:00:00", "-4.72", "0"]);
  });

  it("joins monthly files of one plant, keeps plants with the same capacity apart", () => {
    const mk = (src: string, alias: string, ts: number): Series => ({ kind: "hourly", key: src, alias, format: "solar-interval", sourceName: src, hours: [[ts, 1]], blankHours: [] });
    const { series } = mergeSolarSeries([
      mk("KM Knitwear_2MW-Daily Generation TEB-21-11-2026.xls", "2MW", at(1, 10)),
      mk("KM Knitwear_2MW-Daily Generation TEB-21-11-2026 (1).xls", "2MW", at(1, 10, 5)),
      mk("Jayavishnu_2MW-Daily Generation TEB-21-11-2026.xls", "2MW", at(1, 10)),
      mk("Sambandam Group_Oct.xlsx", "SSML", at(1, 10, 10)),
      mk("Sambandham Group _ 5 & 2 MW.xlsx", "SSML", at(1, 10)),
    ]);
    expect(series.map((s) => `${s.alias}|${s.sourceName}`).sort()).toEqual([
      "2MW|Jayavishnu_2MW-Daily Generation TEB-21-11-2026.xls",
      "2MW|KM Knitwear_2MW-Daily Generation TEB-21-11-2026.xls + KM Knitwear_2MW-Daily Generation TEB-21-11-2026 (1).xls",
      "SSML|Sambandam Group_Oct.xlsx + Sambandham Group _ 5 & 2 MW.xlsx",
    ]);
  });
});

/* Real exports (skipped when the files are not on this machine) ------------------ */

const RAW = process.env.SOLAR_DIR ?? "/Users/bhuvanesh/Downloads/Solar- Hourly Profile";

function loadAll(dir: string, prefix = ""): { name: string; data: Uint8Array }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? loadAll(path.join(dir, e.name), `${prefix}${e.name}/`) : [{ name: prefix + e.name, data: readFileSync(path.join(dir, e.name)) }],
  );
}

const monthMWh = (s: Series, month: string) => {
  let t = 0;
  for (const [ts, v] of buildHourly(s).hours) if (new Date(ts).toISOString().startsWith(month)) t += v;
  return t / 1000;
};

describe.skipIf(!existsSync(RAW))("solar exports", () => {
  it("parses every plant and maps it to its device", async () => {
    const { series, warnings } = await detectAndParse(loadAll(RAW));
    expect(warnings).toEqual([]);
    const devices = [
      ["5MWSES10023", "5MW", "Jayajothi"], ["8MWSES10001", "8MW", "Jayavilas"], ["4MWSES10014", "4MW", "Jayavilas"],
      ["10MWSOLA002", "10MW", "ALC"], ["6MWSSOLA001", "6MW", "ALC"], ["5MWSES10001", "SSML", undefined], ["2MWSES10001", "SSTPL", undefined],
      ["2MWSES10082", "2MW", "KM Knitwear"], ["2MWSES10081", "2MW", "Jayavishnu"], ["3MWSES10038", "3MW", "Acsen"],
    ].map(([registryId, alias, sourceHint]) => ({ registryId: registryId!, alias: alias!, outputName: registryId!, sourceHint }));
    const mapped = series.map((s) => suggestDevice(s.alias, s.sourceName, devices)?.registryId);
    expect([...mapped].sort()).toEqual(devices.map((d) => d.registryId).sort());

    const by = (id: string) => series[mapped.indexOf(id)];
    // April against irec actual_gen (export meter); inverter readings run 1–5% above it
    const irecApril: Record<string, number> = {
      "10MWSOLA002": 2091.3, "6MWSSOLA001": 1213.8, "5MWSES10001": 940.3, "2MWSES10001": 378.7, "2MWSES10082": 399.1,
      "2MWSES10081": 397.1, "3MWSES10038": 561.8, "4MWSES10014": 743.4, "8MWSES10001": 1508.7,
    };
    for (const [id, mwh] of Object.entries(irecApril)) {
      const r = monthMWh(by(id), "2026-04") / mwh;
      expect(r, id).toBeGreaterThan(1);
      expect(r, id).toBeLessThan(1.05);
    }
    // Jayajothi: from July on (its early rows had day and month swapped)
    for (const [month, mwh] of [["2026-07", 849.0], ["2026-08", 844.0], ["2026-09", 884.4]] as const) {
      const r = monthMWh(by("5MWSES10023"), month) / mwh;
      expect(r, month).toBeGreaterThan(1);
      expect(r, month).toBeLessThan(1.06);
    }
  });

  it("Acsen hours add up to the sheet's own daily totals", async () => {
    const { series } = await detectAndParse(loadAll(RAW).filter((f) => f.name.includes("Acsen")));
    // the Oct-26 sheet's 'Total Unit' row leaves out one 07:00 reading (123 kWh on 4 Oct)
    const totals: Record<string, number> = { "2026-04": 575918, "2026-07": 481069 };
    for (const [m, kwh] of Object.entries(totals)) expect(monthMWh(series[0], m) * 1000).toBeCloseTo(kwh, 3);
  });

  it("night hours are zero", async () => {
    const { series } = await detectAndParse(loadAll(RAW).filter((f) => f.name.includes("KM Knitwear")));
    const h = buildHourly(series[0]).hours;
    expect(h.get(at(2, 2))).toBe(0);
    expect(h.get(at(2, 21))).toBe(0);
    expect(h.get(at(2, 12))).toBeGreaterThan(1500);
    expect(h.get(at(2, 12) + HOUR)).toBeGreaterThan(1500);
  });
});

describe.skipIf(!existsSync(path.join(RAW, "ALC -6 MW&10MW GEN DATA.xlsx")))("solar end to end", () => {
  it("a 10 MW plant's hours (above the 3 MWh a turbine can make) are stored and written", async () => {
    const name = "ALC -6 MW&10MW GEN DATA.xlsx";
    const { series } = await detectAndParse([{ name, data: readFileSync(path.join(RAW, name)) }]);
    const s = series.find((x) => x.alias === "10MW")!;
    const q2 = parseQuarter("2026-Q2")!;
    const [app, irec] = await Promise.all([appTestDb(), irecFixture()]);
    const result = await saveHourly(app, computeHourly(s, "10MWSOLA002", q2), null);
    expect(result.totalMWh).toBeCloseTo(monthMWh(s, "2026-04") + monthMWh(s, "2026-05") + monthMWh(s, "2026-06"), 6);
    const stored = (await loadHourly(app, "10MWSOLA002", q2))!;
    const device = (await loadDevices(app, irec)).find((d) => d.registryId === "10MWSOLA002")!;
    const xlsx = await renderMeterXlsx(stored, device, q2, "MWh");
    expect(xlsx.byteLength).toBeGreaterThan(10_000);
  });
});
