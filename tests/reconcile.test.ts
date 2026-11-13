import { describe, expect, it } from "vitest";
import { DEFAULT_RULE, estimateMissing, reconcileMonth, scaleMonth, validateRule } from "@/lib/reconcile";

const sum = (v: (number | null)[]) => v.reduce<number>((s, x) => s + (x ?? 0), 0);
const RATING = 2700;

describe("validateRule", () => {
  it("accepts the default and rejects a band that excludes the margin", () => {
    expect(validateRule(DEFAULT_RULE)).toEqual({ marginPct: 2, bandMinPct: 1, bandMaxPct: 3 });
    expect(validateRule({ marginPct: 2, bandMinPct: 2.5, bandMaxPct: 3 })).toMatch(/band/);
    expect(validateRule({ marginPct: 11, bandMinPct: 1, bandMaxPct: 12 })).toMatch(/10/);
    expect(validateRule("x")).toMatch(/rule/);
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

  it("rounds to 3 decimals without missing the target", () => {
    const r = scaleMonth([1.1111, 2.2222, 3.3333], 7.777, RATING);
    for (const v of r.values) expect(Math.round((v as number) * 1000) / 1000).toBe(v);
    expect(sum(r.values)).toBeCloseTo(7.777, 6);
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

  it("leaves a month at or above the target unchanged", () => {
    const r = reconcileMonth({ hours: [700, 700], siblings: [], ratingKwh: RATING, targetKwh: 1000, fill: true });
    expect(r.values).toEqual([700, 700]);
    expect(r.afterKwh).toBe(1400);
  });
});
