import { describe, expect, it } from "vitest";
import { quarterHours, type HourlyPayload } from "@/lib/compute";
import { backfillPrecision, roundToTotal } from "@/lib/precisionBackfill";
import { parseQuarter } from "@/lib/quarter";
import { DEFAULT_RULE } from "@/lib/reconcile";
import { applyItems, monthRange, undoReconciliation } from "@/lib/reconcileStore";
import { loadHourly, loadResults, saveHourly } from "@/lib/store";
import { appTestDb, irecFixture } from "./support/pglite";

const q2 = parseQuarter("2026-Q2")!;
const [aprFrom, aprTo] = monthRange(q2, 0);
const DEV = "1.5MWIND016";
const sum = (v: (number | null)[]) => v.reduce<number>((s, x) => s + (x ?? 0), 0);
const decimals = (v: number) => (String(v).split(".")[1] ?? "").length;

function payload(registryId: string, kwh: number, gapAt: number[] = []): HourlyPayload {
  const values = Array.from({ length: quarterHours(q2) }, (_, i) => (gapAt.includes(i) ? null : kwh));
  return {
    registryId, quarter: q2.key, format: "regen-mean", sourceName: "test", kwh: values, estimated: [],
    missing: values.flatMap((v, i) => (v === null ? [[i, "logger offline"] as [number, string]] : [])), gaps: [],
  };
}
const GAP = Array.from({ length: 10 }, (_, k) => aprFrom + 100 + k);

/** Data as the app stored it before: 0.001 kWh, including a reconciled April. */
async function legacy() {
  const [app, irec] = await Promise.all([appTestDb(), irecFixture()]);
  await saveHourly(app, payload(DEV, 100, GAP), "a@x");
  await saveHourly(app, payload("1.5MWIND019", 200), "a@x");
  const at = (await loadResults(app, q2.key))[DEV].processedAt;
  const [out] = await applyItems(app, irec, q2, [{ registryId: DEV, mi: 0, fill: true, processedAt: at }], DEFAULT_RULE, null);
  // old precision: reconciled hours and plain hours carried 3 decimals
  await app.query("UPDATE hourly_values SET kwh = kwh + 0.237 WHERE registry_id = $1 AND (original_kwh IS NOT NULL OR reconciliation_id IS NOT NULL)", [DEV]);
  await app.query("UPDATE hourly_values SET kwh = kwh - 0.237 * 709 / 10 WHERE registry_id = $1 AND reconciliation_id IS NOT NULL", [DEV]);
  await app.query("UPDATE hourly_values SET kwh = kwh + 0.123 WHERE registry_id = $1 AND original_kwh IS NULL AND reconciliation_id IS NULL", [DEV]);
  return { app, irec, recId: out.id! };
}

describe("roundToTotal", () => {
  it("rounds to whole units that add up to the target, never above the cap", () => {
    const r = roundToTotal([1.4, 1.4, 1.4, 1499.9], 0, 1504, 1500);
    expect(sum(r)).toBe(1504);
    expect(r[3]).toBe(1500);
    expect(roundToTotal([1.26, 2.24], 1, 3.5, 99)).toEqual([1.3, 2.2]);
  });
});

describe("backfillPrecision", () => {
  it("dry run changes nothing", async () => {
    const { app } = await legacy();
    const before = await loadHourly(app, DEV, q2);
    const plan = await backfillPrecision(app, false);
    expect(plan.find((c) => c.registryId === DEV)!.reconciliations).toHaveLength(1);
    expect(await loadHourly(app, DEV, q2)).toEqual(before);
  });

  it("rounds plain hours to 0.1 kWh, keeps a whole-kWh reconciled month whole on its total, and stays undoable", async () => {
    const { app, recId } = await legacy();
    const oldApril = sum((await loadHourly(app, DEV, q2))!.kwh.slice(aprFrom, aprTo));
    await backfillPrecision(app, true);

    const p = (await loadHourly(app, DEV, q2))!;
    for (const v of p.kwh) if (v !== null) expect(decimals(v)).toBeLessThanOrEqual(1);
    const april = p.kwh.slice(aprFrom, aprTo);
    for (const v of april) if (v !== null) expect(Number.isInteger(v)).toBe(true);
    expect(sum(april)).toBe(Math.round(oldApril));
    expect(p.kwh[aprTo]).toBe(100.1); // May, plain: 100.123 → 100.1

    const res = (await loadResults(app, q2.key))[DEV];
    expect(res.monthlyMWh[0]).toBeCloseTo(sum(april) / 1000, 6);
    const [rec] = await app.query<{ after_kwh: string; before_kwh: string }>("SELECT after_kwh, before_kwh FROM reconciliations WHERE id = $1", [recId]);
    expect(Number(rec.after_kwh)).toBe(sum(april));
    expect(Number(rec.before_kwh)).toBe(71000);

    expect(await backfillPrecision(app, true)).toEqual([]); // idempotent

    await undoReconciliation(app, q2, recId, null);
    const back = (await loadHourly(app, DEV, q2))!;
    expect(sum(back.kwh.slice(aprFrom, aprTo))).toBe(71000);
    expect(GAP.every((i) => back.kwh[i] === null)).toBe(true);
  });
});
