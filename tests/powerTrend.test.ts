import { describe, expect, it } from "vitest";
import { sniffSheet } from "@/lib/parsers/detect";
import { parsePowerTrend } from "@/lib/parsers/powerTrend";
import type { Row } from "@/lib/parsers/xlsx";
import { HOUR, MINUTE, naive } from "@/lib/time";

const t0 = naive(2026, 7, 1);
const at = (ms: number) => new Date(ms);

describe("Analogue Value Trending export", () => {
  it("still reads the 10-min 'Active Power' layout with interval-end stamps", () => {
    const rows: Row[] = [
      ["Interval", "NVL137 Active Power", "KYS060 Active Power"],
      ...Array.from({ length: 6 }, (_, i): Row => [at(t0 + (i + 1) * 10 * MINUTE), 100 + i, 200]),
    ];
    expect(sniffSheet(rows)).toBe("power-trend");
    const [nvl] = parsePowerTrend(rows, "f.xlsx");
    expect(nvl.kind).toBe("ten-min");
    if (nvl.kind !== "ten-min") return;
    expect(nvl.alias).toBe("NVL137");
    expect(nvl.samples[0].ts).toBe(t0);
  });

  it("reads the hourly layout: bare turbine headers, hour-start stamps, value is the hour's kWh", () => {
    // as exported: stray scratch cells to the right of the data must not become turbines
    const rows: Row[] = [
      ["Interval", "NVL137", "KYS060", null, null, null, null, null, null, 0],
      [at(t0), 2079.4167, 2263.1333],
      [at(t0 + HOUR), 2285.0333, 2261.3333, null, null, null, "KYS060+J2"],
      [at(t0 + 2 * HOUR), -2.7167, null],
    ];
    expect(sniffSheet(rows)).toBe("power-trend-hourly");
    const series = parsePowerTrend(rows, "NVL137  KYS060 Hourly Generation.xlsx");
    expect(series.map((s) => s.alias)).toEqual(["NVL137", "KYS060"]);
    const [nvl, kys] = series;
    if (nvl.kind !== "hourly" || kys.kind !== "hourly") throw new Error("expected hourly series");
    expect(nvl.format).toBe("power-trend-hourly");
    expect(nvl.hours).toEqual([[t0, 2079.4167], [t0 + HOUR, 2285.0333], [t0 + 2 * HOUR, -2.7167]]);
    expect(kys.hours).toHaveLength(2);
    expect(kys.blankHours).toEqual([t0 + 2 * HOUR]);
  });

  it("does not take a sheet whose first column merely says Interval but holds no times", () => {
    expect(sniffSheet([["Interval", "Notes"], ["a", "b"]])).toBeNull();
  });
});
