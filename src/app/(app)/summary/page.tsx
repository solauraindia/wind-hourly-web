import { IconDatabase, IconDownload } from "@/components/Icons";
import { PageHeader } from "@/components/PageHeader";
import { Stat } from "@/components/Stat";
import type { DeviceActuals } from "@/lib/actuals";
import { appDb, irecDb } from "@/lib/db";
import { irecActuals } from "@/lib/irec";
import { mwh, quarterLabel } from "@/lib/format";
import { quarterFromSearch } from "@/lib/pageQuarter";
import { loadDevicesSafe, loadResults } from "@/lib/store";
import { buildSummary, summaryTotals } from "@/lib/summary";

export default async function SummaryPage({ searchParams }: PageProps<"/summary">) {
  const quarter = await quarterFromSearch(searchParams);
  const [{ devices, irecError }, results] = await Promise.all([loadDevicesSafe(appDb(), irecDb()), loadResults(appDb(), quarter.key)]);
  let actuals: Record<string, DeviceActuals> = {};
  let actualsError: string | null = irecError;
  if (!irecError) try {
    actuals = await irecActuals(irecDb(), quarter, devices.map((d) => d.registryId));
  } catch (e) {
    actualsError = e instanceof Error ? e.message : String(e);
  }
  const rows = buildSummary(devices, results, actuals);
  const t = summaryTotals(rows);
  const withActuals = Object.values(actuals).filter((a) => a.actualMWh.some((v) => v !== null)).length;
  const [m1, m2, m3] = quarter.monthLabels;

  return (
    <>
      <PageHeader
        title="Quarter summary"
        subtitle="Actual generation and eligible credits against the hourly statement, per device."
        quarter={quarter.key}
        actions={
          <a className="btn" href={`/api/summary/${quarter.key}`}>
            <IconDownload /> Export .xlsx
          </a>
        }
      />
      <div className="mx-auto max-w-[1400px] space-y-6 px-6 py-6">
        <div className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-[13px] ${actualsError ? "border-danger/30 bg-danger-soft" : "border-line bg-surface"}`}>
          <span className={`mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg ${actualsError ? "bg-danger/10 text-danger" : "bg-accent-soft text-accent"}`}>
            <IconDatabase />
          </span>
          <div>
            <div className="font-medium">Actuals, eligible credits &amp; issuances · irec database (read-only, live)</div>
            <div className="mt-0.5 text-muted">
              {actualsError
                ? `Could not read irec: ${actualsError}`
                : `devices_monthly_data has ${quarterLabel(quarter.key)} figures for ${withActuals} of ${devices.length} devices; issued = Σ issuances over the quarter.`}
            </div>
          </div>
        </div>

        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Actual generation" value={`${mwh(t.actualTotal, 1)}`} hint="MWh · irec actual_gen" />
          <Stat label="Hourly statement" value={`${mwh(t.hourlyTotal, 1)}`} hint="MWh · from generated files" />
          <Stat label="Claimable (Σ min)" value={`${mwh(t.min, 1)}`} hint="MWh · min(eligible, hourly)" tone="ok" />
          <Stat label="Issued as per Evident" value={`${mwh(t.issued, 1)}`} hint="MWh" />
        </section>

        <section className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-separate border-spacing-0 text-sm">
              <thead>
                <tr>
                  <th className="th sticky left-0 z-[2] border-b-0 border-r bg-surface" />
                  <th className="th border-l bg-surface text-center normal-case tracking-normal text-ink" colSpan={4}>Actual generation</th>
                  <th className="th border-b-0 border-l bg-surface" />
                  <th className="th border-l bg-surface text-center normal-case tracking-normal text-ink" colSpan={4}>As per hourly statement</th>
                  <th className="th border-b-0 border-l bg-surface" colSpan={3} />
                </tr>
                <tr>
                  <th className="th sticky left-0 z-[2] border-r pl-5">Device · client</th>
                  {[m1, m2, m3].map((m, i) => <th key={m} className={`th text-right ${i === 0 ? "border-l" : ""}`}>{m}</th>)}
                  <th className="th text-right">Total</th>
                  <th className="th border-l text-right">Eligible</th>
                  {[m1, m2, m3].map((m, i) => <th key={m} className={`th text-right ${i === 0 ? "border-l" : ""}`}>{m}</th>)}
                  <th className="th text-right">Total</th>
                  <th className="th border-l text-right">Diff</th>
                  <th className="th text-right">Min</th>
                  <th className="th pr-5 text-right">Issued</th>
                </tr>
              </thead>
              <tbody className="num">
                {rows.map((r) => {
                  const off = r.diff !== null && r.actualTotal ? Math.abs(r.diff) / r.actualTotal > 0.1 : false;
                  return (
                    <tr key={r.deviceId} className="group hover:bg-surface-2">
                      <td className="td sticky left-0 z-[1] w-[260px] max-w-[260px] border-r bg-surface pl-5 group-hover:bg-surface-2" title={`${r.deviceName}`}>
                        <div className="flex items-baseline gap-2">
                          <span className="text-[12px] text-faint">{r.sl}</span>
                          <span className="whitespace-nowrap font-medium">{r.registryId}</span>
                        </div>
                        <div className="truncate text-[12px] text-muted">{r.client || "—"}</div>
                      </td>
                      {r.actual.map((v, i) => <td key={i} className={`td text-right ${i === 0 ? "border-l" : ""}`}>{mwh(v)}</td>)}
                      <td className="td text-right font-medium">{mwh(r.actualTotal)}</td>
                      <td className="td border-l text-right">{mwh(r.eligible)}</td>
                      {[0, 1, 2].map((i) => <td key={i} className={`td text-right ${i === 0 ? "border-l" : ""}`}>{r.hourly ? mwh(r.hourly[i]) : <span className="text-faint">—</span>}</td>)}
                      <td className="td text-right font-medium">{mwh(r.hourlyTotal)}</td>
                      <td className={`td border-l text-right ${off ? "font-medium text-warn" : r.diff !== null && r.diff < 0 ? "text-danger" : ""}`} title={off ? "Differs from actuals by more than 10%" : undefined}>
                        {mwh(r.diff)}
                      </td>
                      <td className="td text-right font-semibold text-ok">{mwh(r.min)}</td>
                      <td className="td pr-5 text-right">{mwh(r.issued)}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="num">
                <tr className="bg-surface-2 font-semibold">
                  <td className="td sticky left-0 z-[1] border-r bg-surface-2 pl-5">Total · {rows.length} devices</td>
                  {t.actual.map((v, i) => <td key={i} className={`td text-right ${i === 0 ? "border-l" : ""}`}>{mwh(v)}</td>)}
                  <td className="td text-right">{mwh(t.actualTotal)}</td>
                  <td className="td border-l text-right">{mwh(t.eligible)}</td>
                  {t.hourly.map((v, i) => <td key={i} className={`td text-right ${i === 0 ? "border-l" : ""}`}>{mwh(v)}</td>)}
                  <td className="td text-right">{mwh(t.hourlyTotal)}</td>
                  <td className="td border-l text-right">{mwh(t.diff)}</td>
                  <td className="td text-right text-ok">{mwh(t.min)}</td>
                  <td className="td pr-5 text-right">{mwh(t.issued)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </section>
        <p className="text-[12.5px] text-faint">
          All figures in MWh. Diff = actual total − hourly total (amber when they differ by more than 10%). Min = min(eligible, hourly total). Eligible = Σ eligible_gen (after banking); it falls back to the actual total when irec has none.
        </p>
      </div>
    </>
  );
}
