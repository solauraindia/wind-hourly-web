"use client";

import Link from "next/link";
import { Fragment, useState } from "react";
import type { FileValidation } from "@/lib/meterValidator";
import { DownloadButton } from "./DownloadButton";
import { IconAlert, IconCheck, IconX } from "./Icons";
import { Spinner } from "./Pending";
import { Stat } from "./Stat";

export interface ValidateRow {
  registryId: string;
  outputName: string;
  client: string;
  hoursMissing: number;
  /** month labels with a reconciliation in force */
  reconciled: string[];
}

type Result = FileValidation & { registryId: string };

/** The validator takes at most 20 files a request and 15 requests a minute. */
const BATCH = 20;

const STATUS = {
  pass: { label: "Pass", cls: "bg-ok-soft text-ok", Icon: IconCheck },
  warn: { label: "Pass with warnings", cls: "bg-warn-soft text-warn", Icon: IconAlert },
  fail: { label: "Fail", cls: "bg-danger-soft text-danger", Icon: IconX },
  error: { label: "Not validated", cls: "bg-danger-soft text-danger", Icon: IconAlert },
} as const;

export function ValidateFlow({ quarter, compact, rows, simulate }: { quarter: string; compact: string; rows: ValidateRow[]; simulate: boolean }) {
  const [results, setResults] = useState<Record<string, Result>>({});
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  async function run(ids: string[]) {
    setError(null);
    setRunning(new Set(ids));
    try {
      for (let k = 0; k < ids.length; k += BATCH) {
        const batch = ids.slice(k, k + BATCH);
        const res = await fetch("/api/validate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ quarter, registryIds: batch }),
        });
        const body = (await res.json().catch(() => null)) as { results?: Result[]; error?: string } | null;
        if (!res.ok || !body?.results) throw new Error(body?.error ?? `Validation failed (${res.status})`);
        setResults((prev) => ({ ...prev, ...Object.fromEntries(body.results!.map((r) => [r.registryId, r])) }));
        setRunning((prev) => new Set([...prev].filter((id) => !batch.includes(id))));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(new Set());
    }
  }

  const done = Object.values(results);
  const count = (s: Result["status"]) => done.filter((r) => r.status === s).length;
  const busy = running.size > 0;

  if (!rows.length) {
    return (
      <div className="card px-5 py-10 text-center text-sm text-muted">
        Nothing processed for this quarter yet. <Link className="font-medium text-accent underline-offset-2 hover:underline" href={`/?q=${quarter}`}>Process raw files</Link> first.
      </div>
    );
  }

  return (
    <>
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Validated" value={`${done.length} / ${rows.length}`} hint="files this session" />
        <Stat label="Pass" value={count("pass")} tone={count("pass") ? "ok" : undefined} hint="no warnings" />
        <Stat label="Pass with warnings" value={count("warn")} tone={count("warn") ? "warn" : undefined} hint="e.g. null hours" />
        <Stat label="Fail" value={count("fail") + count("error")} tone={count("fail") + count("error") ? "warn" : undefined} hint="must be fixed" />
      </section>

      <section className="card overflow-hidden">
        <div className="flex items-center gap-3 border-b border-line px-5 py-3.5">
          <div>
            <h2 className="text-[15px] font-semibold">Hourly files</h2>
            <p className="text-[12.5px] text-muted">
              Each file is rendered from the stored values (MWh) and sent to provider-meter-data-validation.cfesuite.com, which says it keeps nothing. Results are not saved.
            </p>
          </div>
          <button type="button" className="btn btn-primary btn-sm ml-auto" disabled={busy} onClick={() => run(rows.map((r) => r.registryId))}>
            {busy ? <Spinner /> : <IconCheck />}
            Validate all
          </button>
        </div>
        {error && <div className="border-b border-danger/30 bg-danger-soft px-5 py-2.5 text-[13px] text-danger">{error}</div>}
        <div className="overflow-x-auto">
          <table className="w-full border-separate border-spacing-0">
            <thead>
              <tr>
                <th className="th pl-5">Device</th>
                <th className="th">Values</th>
                <th className="th text-right" title={simulate ? "Hours with no source reading (filled with simulated placeholders)" : "Hours written as null"}>{simulate ? "No reading" : "Null hours"}</th>
                <th className="th">Result</th>
                <th className="th">Checks not passed</th>
                <th className="th pr-5" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const r = results[row.registryId];
                const s = r && STATUS[r.status];
                const isOpen = open === row.registryId && r && (r.checks.length > 0 || r.error);
                return (
                  <Fragment key={row.registryId}>
                    <tr className="hover:bg-surface-2/60">
                      <td className="td pl-5">
                        <div className="whitespace-nowrap font-medium text-ink">{row.outputName}</div>
                        <div className="num text-[12px] text-muted">{row.registryId}{row.client && ` · ${row.client}`}</div>
                      </td>
                      <td className="td">
                        {row.reconciled.length ? (
                          <span className="chip whitespace-nowrap bg-ok-soft text-ok" title="These months go out with their reconciled values">
                            Reconciled · {row.reconciled.join(", ")}
                          </span>
                        ) : (
                          <span className="chip whitespace-nowrap bg-surface-2 text-muted">As processed</span>
                        )}
                      </td>
                      <td className={`td num text-right ${row.hoursMissing ? "text-warn" : "text-muted"}`}>{row.hoursMissing.toLocaleString()}</td>
                      <td className="td">
                        {running.has(row.registryId) ? (
                          <span className="inline-flex items-center gap-1.5 text-[13px] text-muted"><Spinner /> Validating…</span>
                        ) : s ? (
                          <span className={`chip whitespace-nowrap ${s.cls}`}>
                            <s.Icon width={13} height={13} />
                            {s.label}
                            {r.total > 0 && <span className="num font-normal opacity-80">· {r.passed}/{r.total}</span>}
                          </span>
                        ) : (
                          <span className="text-[13px] text-faint">—</span>
                        )}
                      </td>
                      <td className="td text-[13px]">
                        {r?.error ? (
                          <span className="text-danger">{r.error}</span>
                        ) : r?.checks.length ? (
                          <button type="button" className="text-left text-ink underline-offset-2 hover:underline" onClick={() => setOpen(isOpen ? null : row.registryId)}>
                            {r.checks.map((c) => c.name).join(", ")}
                            <span className="ml-1.5 text-accent">{isOpen ? "Hide" : "Details"}</span>
                          </button>
                        ) : r ? (
                          <span className="text-muted">None</span>
                        ) : null}
                      </td>
                      <td className="td pr-5">
                        <div className="flex items-center justify-end gap-1.5">
                          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run([row.registryId])}>
                            Validate
                          </button>
                          <DownloadButton
                            className="btn btn-sm px-2"
                            href={`/api/files/${quarter}/${encodeURIComponent(row.registryId)}`}
                            title={`Download ${row.outputName}_hourly_${compact}.xlsx`}
                            label={`Download ${row.outputName}`}
                          />
                          <DownloadButton
                            className="btn btn-sm"
                            href={`/api/files/${quarter}/${encodeURIComponent(row.registryId)}?report=missing`}
                            title={`Download ${row.outputName}_missing_${compact}.xlsx: every null hour with its reason, plus the zero/negative hours written at the smallest positive value`}
                          >
                            Missing
                          </DownloadButton>
                        </div>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={6} className="td bg-surface-2/50 px-5 py-4">
                          <div className="space-y-4">
                            {r.checks.map((c) => (
                              <div key={c.id}>
                                <div className="flex items-baseline gap-2 text-[13px]">
                                  <span className={`chip ${STATUS[c.status === "warn" ? "warn" : "fail"].cls}`}>{c.status === "warn" ? "Warning" : "Fail"}</span>
                                  <span className="font-medium">{c.name}</span>
                                  <span className="text-muted">{c.message}</span>
                                </div>
                                {c.issues.length > 0 && (
                                  <table className="mt-2 w-full max-w-3xl text-[12.5px]">
                                    <thead>
                                      <tr className="text-left text-faint">
                                        <th className="py-1 pr-3 font-medium">Row</th>
                                        <th className="py-1 pr-3 font-medium">Column</th>
                                        <th className="py-1 pr-3 font-medium">Value</th>
                                        <th className="py-1 font-medium">Issue</th>
                                      </tr>
                                    </thead>
                                    <tbody className="num">
                                      {c.issues.map((i, k) => (
                                        <tr key={k} className="border-t border-line">
                                          <td className="py-1 pr-3">{i.row ?? "—"}</td>
                                          <td className="py-1 pr-3">{i.column ?? "—"}</td>
                                          <td className="py-1 pr-3">{i.value ?? "—"}</td>
                                          <td className="py-1">{i.message}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                )}
                                {c.totalIssues > c.issues.length && (
                                  <p className="mt-1 text-[12px] text-faint">Showing {c.issues.length} of {c.totalIssues.toLocaleString()} issues.</p>
                                )}
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      <p className="text-[12.5px] text-faint">
        Files have a row for every hour of the quarter; {simulate ? "hours with no source reading are filled with the same simulated placeholder" : <>hours without a value are written as <code>null</code>, which the validator accepts with a warning
        (those hours cannot be certified)</>}. Zero and negative readings (standby draw) are written as a small positive value at the source precision, so every written row is positive;
        the Missing report gives the value written for each. Timezone is written as Asia/Calcutta, the same zone as Asia/Kolkata, because the validator does not accept the newer name.
      </p>
    </>
  );
}
