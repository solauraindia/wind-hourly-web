import { describe, expect, it } from "vitest";
import { quarterHours, type HourlyPayload } from "@/lib/compute";
import { parseQuarter } from "@/lib/quarter";
import { DEFAULT_RULE, targetPct } from "@/lib/reconcile";
import { activeReconciliations, applyItems, loadGrid, monthRange, previewItems, undoReconciliation, type Plan } from "@/lib/reconcileStore";
import { loadHourly, loadResults, saveHourly } from "@/lib/store";
import { appTestDb, irecFixture } from "./support/pglite";

const q2 = parseQuarter("2026-Q2")!;
const [aprFrom, aprTo] = monthRange(q2, 0);
const DEV = "1.5MWIND016"; // RSMKP-04, rating 1.5 MW in the irec fixture
const SIB = "1.5MWIND019"; // RSMKP-01, same site, not in the irec fixture (no rating)

/** 100 kWh every hour, 10 April hours missing; the sibling makes 200 every hour. */
function payload(registryId: string, kwh: number, gapAt: number[] = []): HourlyPayload {
  const values = Array.from({ length: quarterHours(q2) }, (_, i) => (gapAt.includes(i) ? null : kwh));
  return {
    registryId, quarter: q2.key, format: "regen-mean", sourceName: "test", kwh: values, estimated: [],
    missing: values.flatMap((v, i) => (v === null ? [[i, "logger offline"] as [number, string]] : [])), gaps: [],
  };
}
const APR_TARGET = 109.061 * (1 + targetPct(DEFAULT_RULE, DEV, "2026-04") / 100);
const GAP = Array.from({ length: 10 }, (_, k) => aprFrom + 100 + k);

async function setup() {
  const [app, irec] = await Promise.all([appTestDb(), irecFixture()]);
  await saveHourly(app, payload(DEV, 100, GAP), "a@x");
  await saveHourly(app, payload(SIB, 200), "a@x");
  return { app, irec };
}

const processedAt = async (app: Awaited<ReturnType<typeof appTestDb>>) => (await loadResults(app, q2.key))[DEV].processedAt;

describe("reconcile store", () => {
  it("grid marks short, covered and no-issuance months", async () => {
    const { app, irec } = await setup();
    const row = (await loadGrid(app, irec, q2)).find((r) => r.registryId === DEV)!;
    expect(row.ratingMw).toBe(1.5);
    expect(row.site).toBe("RSMKP");
    expect(row.cells.map((c) => c.status)).toEqual(["short", "none", "short"]);
    expect(row.cells[0].statementMWh).toBeCloseTo(71, 6);
  });

  it("previews: fills the logger gap from the sibling, then scales to its target in issued +4% to +5%", async () => {
    const { app, irec } = await setup();
    const [p] = (await previewItems(app, irec, q2, [{ registryId: DEV, mi: 0, fill: true }], DEFAULT_RULE)) as Plan[];
    expect(p.result.filledIdx).toHaveLength(10);
    expect(p.result.fillKwh).toBeCloseTo(1000, 3);
    expect(p.result.afterKwh / 1000).toBeCloseTo(APR_TARGET, 3);
    expect(p.afterPct).toBeCloseTo(p.targetPct, 3); // whole-kWh hours: the total lands to the nearest kWh
    expect(p.targetPct).toBeGreaterThanOrEqual(4);
    expect(p.targetPct).toBeLessThanOrEqual(5);
    expect(p.inBand).toBe(true);
    expect(p.daily.before).toHaveLength(30);
  });

  it("applies: active values change, originals kept, filled hours estimated, other months untouched", async () => {
    const { app, irec } = await setup();
    const before = (await loadResults(app, q2.key))[DEV];
    const [out] = await applyItems(app, irec, q2, [{ registryId: DEV, mi: 0, fill: true, processedAt: before.processedAt }], DEFAULT_RULE, "a@x");
    expect(out.status).toBe("applied");
    const after = (await loadResults(app, q2.key))[DEV];
    expect(after.monthlyMWh[0]).toBeCloseTo(APR_TARGET, 3);
    expect(after.monthlyMWh.slice(1)).toEqual(before.monthlyMWh.slice(1));
    expect(after.processedAt).toBe(before.processedAt);
    const p = (await loadHourly(app, DEV, q2))!;
    expect(p.filled).toEqual(GAP);
    expect(p.missing.some(([i]) => GAP.includes(i))).toBe(false);
    expect(p.kwh[aprTo]).toBe(100); // first hour of May
    const [{ n, f }] = await app.query<{ n: number; f: number }>(
      "SELECT count(*) FILTER (WHERE original_kwh IS NOT NULL)::int AS n, count(*) FILTER (WHERE reconciliation_id IS NOT NULL AND estimated)::int AS f FROM hourly_values WHERE registry_id = $1",
      [DEV],
    );
    expect([n, f]).toEqual([710, 10]);
  });

  it("applies each month on its own: skips stale, no-rating and repeat items without blocking the rest", async () => {
    const { app, irec } = await setup();
    const at = await processedAt(app);
    const out = await applyItems(app, irec, q2, [
      { registryId: DEV, mi: 0, fill: true, processedAt: "2020-01-01T00:00:00.000Z" },
      { registryId: SIB, mi: 0, fill: true, processedAt: at },
      { registryId: DEV, mi: 2, fill: true, processedAt: at },
      { registryId: DEV, mi: 1, fill: true, processedAt: at },
    ], DEFAULT_RULE, null);
    expect(out.map((o) => o.status)).toEqual(["skipped", "skipped", "applied", "skipped"]);
    expect(out[0].reason).toMatch(/re-processed/);
    expect(out[1].reason).toMatch(/rating/);
    expect(out[3].reason).toMatch(/Nothing issued/);
    const again = await applyItems(app, irec, q2, [{ registryId: DEV, mi: 2, fill: true, processedAt: at }], DEFAULT_RULE, null);
    expect(again[0].reason).toMatch(/Already reconciled/);
  });

  it("a month above issued can be picked and is scaled down to its target", async () => {
    const { app, irec } = await setup();
    await saveHourly(app, payload(DEV, 200), "a@x"); // April: 144 MWh against 109.061 issued
    const row = (await loadGrid(app, irec, q2)).find((r) => r.registryId === DEV)!;
    expect(row.cells[0].status).toBe("covered");
    const [out] = await applyItems(app, irec, q2, [{ registryId: DEV, mi: 0, fill: true, processedAt: await processedAt(app) }], DEFAULT_RULE, null);
    expect(out.status).toBe("applied");
    const after = (await loadResults(app, q2.key))[DEV];
    expect(after.monthlyMWh[0]).toBeCloseTo(APR_TARGET, 3);
  });

  it("needs a note when issued is above actual (banking)", async () => {
    const { app, irec } = await setup();
    await irec.query("INSERT INTO issuances (device_id, period, issued_units) VALUES (1, 202605, 400)"); // actual is 382.025
    const at = await processedAt(app);
    const [noNote] = await applyItems(app, irec, q2, [{ registryId: DEV, mi: 1, fill: false, processedAt: at }], DEFAULT_RULE, null);
    expect(noNote.reason).toMatch(/note/);
    const [withNote] = await applyItems(app, irec, q2, [{ registryId: DEV, mi: 1, fill: false, processedAt: at, note: "banked from March" }], DEFAULT_RULE, null);
    expect(withNote.status).toBe("applied");
    const [{ note }] = await app.query<{ note: string }>("SELECT note FROM reconciliations WHERE id = $1", [withNote.id]);
    expect(note).toBe("banked from March");
  });

  it("undo restores the readings, the missing hours and their reasons exactly", async () => {
    const { app, irec } = await setup();
    const before = (await loadResults(app, q2.key))[DEV];
    const original = (await loadHourly(app, DEV, q2))!;
    const [out] = await applyItems(app, irec, q2, [{ registryId: DEV, mi: 0, fill: true, processedAt: before.processedAt }], DEFAULT_RULE, null);
    await undoReconciliation(app, q2, out.id!, "a@x");
    const after = (await loadResults(app, q2.key))[DEV];
    expect(after.monthlyMWh).toEqual(before.monthlyMWh);
    expect(after.hoursMissing).toBe(before.hoursMissing);
    const p = (await loadHourly(app, DEV, q2))!;
    expect(p.kwh).toEqual(original.kwh);
    expect(p.missing).toEqual(original.missing);
    expect(p.filled).toEqual([]);
    expect((await activeReconciliations(app, q2.key)).size).toBe(0);
    await expect(undoReconciliation(app, q2, out.id!, null)).rejects.toThrow(/no longer active/);
  });

  it("re-processing raw files supersedes the reconciliation", async () => {
    const { app, irec } = await setup();
    const [out] = await applyItems(app, irec, q2, [{ registryId: DEV, mi: 0, fill: true, processedAt: await processedAt(app) }], DEFAULT_RULE, null);
    await saveHourly(app, payload(DEV, 100, GAP), "a@x");
    expect((await activeReconciliations(app, q2.key)).size).toBe(0);
    const [{ s }] = await app.query<{ s: boolean }>("SELECT superseded_at IS NOT NULL AS s FROM reconciliations WHERE id = $1", [out.id]);
    expect(s).toBe(true);
    expect((await loadResults(app, q2.key))[DEV].monthlyMWh[0]).toBeCloseTo(71, 6);
  });
});
