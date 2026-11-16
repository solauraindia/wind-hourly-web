import { describe, expect, it } from "vitest";
import { DEFAULT_RULE, estimateMissing, reconcileMonth, scaleMonth, targetPct, validateRule } from "@/lib/reconcile";

const sum = (v: (number | null)[]) => v.reduce<number>((s, x) => s + (x ?? 0), 0);
const RATING = 2700;

describe("validateRule", () => {
  it("accepts the default and rejects a band that excludes the target range", () => {
    expect(validateRule(DEFAULT_RULE)).toEqual({ marginPct: 4, marginMaxPct: 5, bandMinPct: -5, bandMaxPct: 5 });
    expect(validateRule({ marginPct: 2, marginMaxPct: 2, bandMinPct: 2.5, bandMaxPct: 3 })).toMatch(/band/);
    expect(validateRule({ marginPct: 4, marginMaxPct: 5, bandMinPct: -5, bandMaxPct: 4.5 })).toMatch(/band/);
    expect(validateRule({ marginPct: 5, marginMaxPct: 4, bandMinPct: -5, bandMaxPct: 5 })).toMatch(/reversed/);
    expect(validateRule({ marginPct: -3, marginMaxPct: -3, bandMinPct: -5, bandMaxPct: 0 })).toEqual({ marginPct: -3, marginMaxPct: -3, bandMinPct: -5, bandMaxPct: 0 });
    expect(validateRule({ marginPct: 4, marginMaxPct: 6, bandMinPct: -5, bandMaxPct: 6 })).toMatch(/±5%/);
    expect(validateRule({ marginPct: 2, marginMaxPct: 2, bandMinPct: -6, bandMaxPct: 5 })).toMatch(/±5%/);
    expect(validateRule({ marginPct: 2, bandMinPct: -5, bandMaxPct: 5 })).toMatch(/numbers/);
    expect(validateRule("x")).toMatch(/rule/);
  });
});

describe("targetPct", () => {
  const months = ["2026-04", "2026-05", "2026-06"];
  const ids = ["1.5MWIND016", "1.5MWIND019", "2.7MES20003", "2.7MES20004", "2.1MES20005"];
  const picks = ids.flatMap((id) => months.map((m) => targetPct(DEFAULT_RULE, id, m)));

  it("stays inside the target range, at 2 decimals, and spreads across it", () => {
    for (const t of picks) {
      expect(t).toBeGreaterThanOrEqual(4);
      expect(t).toBeLessThanOrEqual(5);
      expect(Math.round(t * 100) / 100).toBe(t);
    }
    expect(new Set(picks).size).toBeGreaterThan(10);
  });

  it("is the same every time for a device and month", () => {
    expect(targetPct(DEFAULT_RULE, ids[0], months[0])).toBe(picks[0]);
  });

  it("is the fixed value when the range is a single point", () => {
    expect(targetPct({ ...DEFAULT_RULE, marginPct: 3, marginMaxPct: 3 }, ids[0], months[0])).toBe(3);
  });
});

describe("estimateMissing", () => {
  it("fills from producing siblings using this turbine's usual ratio to them", () => {
    // turbine runs at half its sibling; hour 2 missing while the sibling made 1000
    const hours = [500, 600, null, 400];
    const sib = [1000, 1200, 1000, 800];
    const { estimates, calm, noEvidence } = estimateMissing(hours, [sib], RATING);
    expect(estimates.get(2)).toBeCloseTo(500, 6);
    expect([calm, noEvidence]).toEqual([0, 0]);
  });

  it("leaves an hour empty when the siblings were calm", () => {
    const { estimates, calm } = estimateMissing([500, null, 400], [[1000, 20, 800]], RATING);
    expect(estimates.size).toBe(0);
    expect(calm).toBe(1);
  });

  it("without siblings, fills from the hour-of-day average when the gap's edges were producing", () => {
    // two days; hour 1 of day 2 missing; hour-of-day 1 averaged 300 on day 1
    const hours: (number | null)[] = new Array(48).fill(200);
    hours[1] = 300;
    hours[25] = null;
    const { estimates } = estimateMissing(hours, [], RATING);
    expect(estimates.get(25)).toBe(300);
  });

  it("without siblings, leaves the gap empty when both edges were calm, and counts no-evidence gaps", () => {
    const calmEdges: (number | null)[] = [800, 10, null, null, 0, 900];
    expect(estimateMissing(calmEdges, [], RATING)).toMatchObject({ calm: 2, noEvidence: 0 });
    const all: (number | null)[] = [null, null];
    expect(estimateMissing(all, [], RATING)).toMatchObject({ calm: 0, noEvidence: 2 });
  });

  it("caps estimates at the rating", () => {
    const { estimates } = estimateMissing([2600, null], [[1300, 2000]], RATING);
    expect(estimates.get(1)).toBe(RATING);
  });
});

describe("scaleMonth", () => {
  it("multiplies producing hours by one factor and lands exactly on the target", () => {
    const r = scaleMonth([100, 200, 0, -3, null, 300], 660, RATING);
    expect(r.values[2]).toBe(0);
    expect(r.values[3]).toBe(-3);
    expect(r.values[4]).toBeNull();
    expect(sum(r.values)).toBeCloseTo(660, 3);
    expect(r.factor).toBeCloseTo(663 / 600, 3);
    expect(r.shortKwh).toBe(0);
    expect(r.hoursRaised).toBe(3);
  });

  it("caps at the rating and spreads the spill-over; leaves hours already above the rating alone", () => {
    const r = scaleMonth([2500, 100, 2730], 2500 + 100 + 2730 + 400, RATING);
    expect(r.values[0]).toBe(RATING);
    expect(r.values[2]).toBe(2730);
    expect(sum(r.values)).toBeCloseTo(5730, 3);
    expect(r.hoursAtRating).toBe(1);
  });

  it("reports what is still short when the rating is reached everywhere", () => {
    const r = scaleMonth([1000, 1000], 6000, RATING);
    expect(r.values).toEqual([RATING, RATING]);
    expect(r.shortKwh).toBeCloseTo(600, 6);
  });

  it("reports the whole target as short when no hour can be raised", () => {
    const r = scaleMonth([0, null, 2700], 3000, RATING);
    expect(r.values).toEqual([0, null, 2700]);
    expect(r.shortKwh).toBe(300);
  });

  it("scales down by one factor and lands exactly on the target", () => {
    const r = scaleMonth([11.1, 22.2, null, 33.3], 55.5, RATING);
    for (const v of r.values) if (v !== null) expect(Math.round(v * 10) / 10).toBe(v);
    expect(sum(r.values)).toBeCloseTo(55.5, 6);
    expect(r.factor).toBeLessThan(1);
  });

  it("keeps whole kWh whole and 0.1 kWh at 0.1, without missing the target", () => {
    const whole = scaleMonth([1111, 2222, 3333], 7777, RATING);
    for (const v of whole.values) expect(Number.isInteger(v)).toBe(true);
    expect(sum(whole.values)).toBe(7777);
    const tenth = scaleMonth([111.1, 222.2, 333.3], 777.7, RATING);
    for (const v of tenth.values) expect(Math.round((v as number) * 10) / 10).toBe(v);
    expect(sum(tenth.values)).toBeCloseTo(777.7, 6);
  });
});

describe("reconcileMonth", () => {
  it("covers the gap from filled hours alone when they hold enough, leaving readings untouched", () => {
    const hours = [500, null, 500, null];
    const sib = [1000, 1000, 1000, 1000];
    const r = reconcileMonth({ hours, siblings: [sib], ratingKwh: RATING, targetKwh: 1600, fill: true });
    expect(r.values[0]).toBe(500);
    expect(r.values[2]).toBe(500);
    expect(r.values[1]).toBeCloseTo(300, 3);
    expect(r.values[3]).toBeCloseTo(300, 3);
    expect(r.filledIdx).toEqual([1, 3]);
    expect(r.fillKwh).toBeCloseTo(600, 3);
    expect(r.scaleKwh).toBe(0);
    expect(r.afterKwh).toBeCloseTo(1600, 3);
  });

  it("fills to the estimate, then scales everything for the rest", () => {
    const r = reconcileMonth({ hours: [500, null, 500], siblings: [[1000, 1000, 1000]], ratingKwh: RATING, targetKwh: 1800, fill: true });
    expect(r.fillKwh).toBeCloseTo(500, 3);
    expect(r.scaleKwh).toBeCloseTo(300, 3);
    expect(r.values[0]).toBeCloseTo(600, 3);
    expect(r.values[1]).toBeCloseTo(600, 3);
    expect(r.afterKwh).toBeCloseTo(1800, 3);
  });

  it("with filling off, only scales existing readings", () => {
    const r = reconcileMonth({ hours: [500, null, 500], siblings: [[1000, 1000, 1000]], ratingKwh: RATING, targetKwh: 1100, fill: false });
    expect(r.values[1]).toBeNull();
    expect(r.filledIdx).toEqual([]);
    expect(r.values[0]).toBeCloseTo(550, 3);
  });

  it("leaves a month exactly at the target unchanged", () => {
    const r = reconcileMonth({ hours: [500, 500], siblings: [], ratingKwh: RATING, targetKwh: 1000, fill: true });
    expect(r.values).toEqual([500, 500]);
    expect(r.factor).toBe(1);
  });

  it("a whole-kWh month stays whole, filled hours included, and the total lands on the target rounded to a kWh", () => {
    const r = reconcileMonth({ hours: [503, null, 497, 610], siblings: [[1000, 1013, 1000, 1200]], ratingKwh: RATING, targetKwh: 2215.37, fill: true });
    for (const v of r.values) expect(Number.isInteger(v)).toBe(true);
    expect(r.afterKwh).toBe(2215);
  });

  it("scales a month above the target down, without filling gaps", () => {
    const r = reconcileMonth({ hours: [700, null, 2700, 0], siblings: [[1400, 1400, 2700, 0]], ratingKwh: RATING, targetKwh: 2720, fill: true });
    expect(r.values[1]).toBeNull();
    expect(r.values[3]).toBe(0);
    expect(r.filledIdx).toEqual([]);
    expect(r.factor).toBeCloseTo(0.8, 6);
    expect(r.values[0]).toBeCloseTo(560, 3);
    expect(r.values[2]).toBeCloseTo(2160, 3);
    expect(r.afterKwh).toBeCloseTo(2720, 3);
    expect(r.scaleKwh).toBeCloseTo(-680, 3);
    expect(r.fillKwh).toBe(0);
    expect(r.shortKwh).toBe(0);
  });
});
