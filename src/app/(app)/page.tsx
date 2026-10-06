import Link from "next/link";
import { CoverageStrip } from "@/components/CoverageStrip";
import { DownloadButton } from "@/components/DownloadButton";
import { LinkPending } from "@/components/Pending";
import { PageHeader } from "@/components/PageHeader";
import { ProcessFlow } from "@/components/ProcessFlow";
import { Stat } from "@/components/Stat";
import { mwh, pct, quarterLabel } from "@/lib/format";
import { quarterFromSearch } from "@/lib/pageQuarter";
import { appDb, irecDb } from "@/lib/db";
import { loadDevicesSafe, loadResults } from "@/lib/store";
import { IrecBanner } from "@/components/IrecBanner";
import { FORMAT_LABELS } from "@/lib/types";

export default async function ProcessPage({ searchParams }: PageProps<"/">) {
  const quarter = await quarterFromSearch(searchParams);
  const unit = (await searchParams).unit === "kWh" ? "kWh" : "MWh";
  const [{ devices, irecError }, results] = await Promise.all([loadDevicesSafe(appDb(), irecDb()), loadResults(appDb(), quarter.key)]);
  const done = devices.filter((d) => results[d.registryId]);
  const total = done.reduce((s, d) => s + results[d.registryId].totalMWh, 0);
  const hoursQ = done.reduce((s, d) => s + results[d.registryId].hoursInQuarter, 0);
  const hoursW = done.reduce((s, d) => s + results[d.registryId].hoursWritten, 0);
  const est = done.reduce((s, d) => s + results[d.registryId].hoursEstimated, 0);

  return (
    <>
      <PageHeader
        title="Hourly mapping"
        subtitle="Drop raw turbine exports in any supported layout — they are detected, mapped to devices and written in the meter-data template."
        quarter={quarter.key}
      />
      <div className="mx-auto max-w-[1400px] space-y-6 px-6 py-6">
        <IrecBanner error={irecError} />
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Devices processed" value={`${done.length} / ${devices.length}`} hint={quarterLabel(quarter.key)} />
          <Stat label="Hourly statement total" value={`${mwh(total, 1)} MWh`} hint="sum of written hours" />
          <Stat label="Hour coverage" value={hoursQ ? pct(hoursW / hoursQ) : "—"} hint={hoursQ ? `${(hoursQ - hoursW).toLocaleString()} hours missing` : "nothing processed yet"} tone={hoursQ && hoursW / hoursQ < 0.95 ? "warn" : undefined} />
          <Stat label="Power-estimated hours" value={est.toLocaleString()} hint="register unusable, power used" />
        </section>

        <ProcessFlow devices={devices} quarter={quarter.key} />

        <section className="card overflow-hidden">
          <div className="flex items-center gap-3 border-b border-line px-5 py-3.5">
            <div>
              <h2 className="text-[15px] font-semibold">Hourly files · {quarterLabel(quarter.key)}</h2>
              <p className="text-[12.5px] text-muted">Table in MWh. Files are rendered from the stored hourly values when downloaded.</p>
            </div>
            <div className="ml-auto flex items-center gap-2 text-[13px]">
              <span className="text-muted">File unit</span>
              <div className="flex rounded-lg border border-line-strong p-0.5">
                {(["MWh", "kWh"] as const).map((u) => (
                  <Link
                    key={u}
                    scroll={false}
                    href={`/?q=${quarter.key}${u === "kWh" ? "&unit=kWh" : ""}`}
                    className={`rounded-md px-2.5 py-1 text-[12.5px] font-medium ${unit === u ? "bg-accent text-white" : "text-muted hover:text-ink"}`}
                  >
                    <LinkPending pending={<span className="animate-pulse">{u}</span>}>{u}</LinkPending>
                  </Link>
                ))}
              </div>
              {done.length > 0 && (
                <DownloadButton className="btn btn-sm" href={`/api/bundle/${quarter.key}?unit=${unit}`}>
                  Download all (.zip)
                </DownloadButton>
              )}
            </div>
          </div>
          {devices.length === 0 ? (
            <div className="px-5 py-10 text-center text-sm text-muted">
              No devices yet. <Link className="font-medium text-accent underline-offset-2 hover:underline" href={`/devices?q=${quarter.key}`}>Add devices</Link> to map raw turbine names to irec devices.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-separate border-spacing-0">
                <thead>
                  <tr>
                    <th className="th pl-4">Device</th>
                    <th className="th">Source layout</th>
                    {quarter.monthLabels.map((m) => (
                      <th key={m} className="th text-right">{m}</th>
                    ))}
                    <th className="th text-right">Total</th>
                    <th className="th">Coverage</th>
                    <th className="th whitespace-nowrap text-right" title="Hours estimated from power / hours missing">Est. / Miss.</th>
                    <th className="th pr-4" />
                  </tr>
                </thead>
                <tbody>
                  {devices.map((d) => {
                    const r = results[d.registryId];
                    return (
                      <tr key={d.id} className={r ? "hover:bg-surface-2/60" : "text-faint"}>
                        <td className="td pl-4">
                          <div className="whitespace-nowrap font-medium text-ink">{d.outputName}</div>
                          <div className="num text-[12px] text-muted">{d.registryId}{!d.inIrec && !irecError && <span className="ml-1.5 text-danger">· not in irec</span>}</div>
                        </td>
                        <td className="td" title={r ? `${r.sourceName}\nprocessed ${new Date(r.processedAt).toLocaleString("en-IN")}${r.processedBy ? ` by ${r.processedBy}` : ""}` : undefined}>
                          {r ? (
                            <span className="chip whitespace-nowrap bg-accent-soft text-accent">{FORMAT_LABELS[r.format]}</span>
                          ) : (
                            <span className="chip bg-surface-2 text-faint">Not processed</span>
                          )}
                        </td>
                        {[0, 1, 2].map((i) => (
                          <td key={i} className="td num whitespace-nowrap px-2 text-right">{r ? mwh(r.monthlyMWh[i]) : "—"}</td>
                        ))}
                        <td className="td num text-right font-semibold text-ink">{r ? mwh(r.totalMWh) : "—"}</td>
                        <td className="td">
                          {r && (
                            <div className="flex items-center gap-2">
                              <CoverageStrip coverage={r.dailyCoverage} mwh={r.dailyMWh} start={quarter.start} />
                              <span className={`num text-[12.5px] ${r.hoursWritten / r.hoursInQuarter < 0.95 ? "text-warn" : "text-muted"}`}>
                                {pct(r.hoursWritten / r.hoursInQuarter)}
                              </span>
                            </div>
                          )}
                        </td>
                        <td className="td num whitespace-nowrap text-right text-[13px] text-muted">{r ? `${r.hoursEstimated} / ${r.hoursMissing}` : ""}</td>
                        <td className="td pr-4 text-right">
                          {r && (
                            <DownloadButton className="btn btn-sm px-2" href={`/api/files/${quarter.key}/${encodeURIComponent(d.registryId)}?unit=${unit}`} title={`Download ${d.outputName}_hourly_${quarter.compact}.xlsx`} label={`Download ${d.outputName}`} />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
