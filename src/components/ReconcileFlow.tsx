"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { DEFAULT_RULE, RULE_LIMIT_PCT, type Rule } from "@/lib/reconcile";
import type { ApplyOutcome, GridCell, GridRow, Plan, Skipped } from "@/lib/reconcileStore";
import { IconAlert, IconCheck, IconX } from "./Icons";
import { Spinner } from "./Pending";

const f1 = (v: number | null) => (v === null ? "—" : v.toLocaleString("en-IN", { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
const f3 = (v: number | null) => (v === null ? "—" : v.toLocaleString("en-IN", { minimumFractionDigits: 3, maximumFractionDigits: 3 }));
const sign = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)}%`;
const pct = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(v)}%`;
const signed3 = (v: number) => `${v < 0 ? "−" : "+"}${f3(Math.abs(v))}`;
const key = (registryId: string, mi: number) => `${registryId}|${mi}`;
const gapPct = (c: GridCell) => (c.statementMWh !== null && c.issuedMWh ? (c.statementMWh / c.issuedMWh - 1) * 100 : null);

type Step = "pick" | "review" | "confirm";

export function ReconcileFlow({ quarter, monthLabels, rows }: { quarter: string; monthLabels: string[]; rows: GridRow[] }) {
  const router = useRouter();
  const [sel, setSel] = useState<string[]>([]);
  const [noFill, setNoFill] = useState<Set<string>>(new Set());
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [rule, setRule] = useState<Rule>(DEFAULT_RULE);
  const [ruleOpen, setRuleOpen] = useState(false);
  const [plans, setPlans] = useState<(Plan | Skipped)[]>([]);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const [result, setResult] = useState<{ outcomes: ApplyOutcome[]; undone?: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cells = useMemo(() => new Map(rows.flatMap((r) => r.cells.map((c) => [key(r.registryId, c.mi), { row: r, cell: c }] as const))), [rows]);
  const pickable = (k: string) => ["short", "covered"].includes(cells.get(k)?.cell.status ?? "");
  // drop picks that stopped being pickable (e.g. after applying)
  const picked = sel.filter(pickable);
  const ruleOk = rule.bandMinPct <= rule.marginPct && rule.marginPct <= rule.marginMaxPct && rule.marginMaxPct <= rule.bandMaxPct && rule.bandMinPct >= -RULE_LIMIT_PCT && rule.bandMaxPct <= RULE_LIMIT_PCT;

  // preview whenever the selection, the rule or a fill switch changes
  const previewKey = JSON.stringify([picked, [...noFill].sort(), rule]);
  useEffect(() => {
    if (!picked.length || !ruleOk) return;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const items = picked.map((k) => ({ registryId: cells.get(k)!.row.registryId, mi: cells.get(k)!.cell.mi, fill: !noFill.has(k) }));
        const res = await fetch("/api/reconcile/preview", {
          method: "POST", headers: { "Content-Type": "application/json" }, signal: ctrl.signal,
          body: JSON.stringify({ quarter, rule, items }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? res.statusText);
        setPlans(json.plans);
      } catch (e) {
        if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    }, 250);
    return () => {
      ctrl.abort();
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey, quarter]);

  // only plans for what is picked now (a stale preview may still be in state)
  const live = ruleOk ? plans.filter((p) => picked.includes(key(p.registryId, p.mi))) : [];
  const ready = live.filter((p): p is Plan => !("skipped" in p));
  const skippedPlans = live.filter((p): p is Skipped => "skipped" in p);
  const needNote = ready.filter((p) => p.banked && !(notes[key(p.registryId, p.mi)] ?? "").trim());
  const added = ready.reduce((s, p) => s + (p.result.afterKwh - p.result.beforeKwh) / 1000, 0);
  const step: Step = confirming ? "confirm" : picked.length ? "review" : "pick";
  const detailPlan = ready.find((p) => key(p.registryId, p.mi) === detail) ?? ready[0];

  function toggle(keys: string[]) {
    const ks = keys.filter(pickable);
    if (!ks.length) return;
    const allOn = ks.every((k) => sel.includes(k));
    setSel((s) => (allOn ? s.filter((k) => !ks.includes(k)) : [...new Set([...s, ...ks])]));
    setConfirming(false);
    setResult(null);
  }
  const clear = () => {
    setSel([]);
    setConfirming(false);
  };

  async function apply() {
    setBusy(true);
    setError(null);
    try {
      const items = ready.map((p) => ({ registryId: p.registryId, mi: p.mi, fill: p.fill, processedAt: p.processedAt, note: notes[key(p.registryId, p.mi)] }));
      const res = await fetch("/api/reconcile/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ quarter, rule, items }) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? res.statusText);
      setResult({ outcomes: json.outcomes });
      setSel([]);
      setConfirming(false);
      router.refresh();
      window.scrollTo({ top: 0 });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function undo(ids: number[]) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/reconcile/undo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ quarter, ids }) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? res.statusText);
      const failed = (json.results as { ok: boolean; reason?: string }[]).filter((r) => !r.ok);
      if (failed.length) setError(failed.map((f) => f.reason).join(" · "));
      setResult((r) => (r && r.outcomes.some((o) => o.id && ids.includes(o.id)) ? { ...r, undone: true } : r));
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const name = (registryId: string) => rows.find((r) => r.registryId === registryId)?.outputName ?? registryId;
  const appliedIds = result?.undone ? [] : (result?.outcomes.flatMap((o) => (o.id ? [o.id] : [])) ?? []);

  return (
    <div className="space-y-5">
      <Steps step={step} />

      {result && (
        <div className="card space-y-2 px-5 py-4 text-[13.5px]" role="status">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-medium">{result.undone ? "Reconciliation undone." : "Reconciliation finished."}</span>
            {appliedIds.length > 0 && (
              <button className="btn btn-sm" disabled={busy} onClick={() => undo(appliedIds)}>Undo {appliedIds.length === 1 ? "it" : `all ${appliedIds.length}`}</button>
            )}
            <button className="ml-auto text-faint hover:text-ink" aria-label="Dismiss" onClick={() => setResult(null)}><IconX /></button>
          </div>
          {!result.undone && (
            <ul className="space-y-1">
              {result.outcomes.map((o) => (
                <li key={key(o.registryId, o.mi)} className="flex items-center gap-2">
                  <span className={`chip ${o.status === "applied" ? "bg-ok-soft text-ok" : o.status === "partly applied" ? "bg-warn-soft text-warn" : "bg-surface-2 text-muted"}`}>{o.status}</span>
                  <span className="font-medium">{name(o.registryId)} {monthLabels[o.mi]}</span>
                  {o.reason && <span className="text-muted">· {o.reason}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {error && (
        <div className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger"><IconAlert className="mt-0.5 shrink-0" /> {error}</div>
      )}

      <section className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3.5">
          <div>
            <h2 className="text-[15px] font-semibold">Statement against issued</h2>
            <p className="text-[12.5px] text-muted">Each cell is one device and month. Any month with issuance can be picked: months below the target are raised, months above it are lowered.</p>
          </div>
          <div className="ml-auto flex gap-2">
            <button className="btn btn-sm" onClick={() => toggle([...cells.keys()].filter((k) => !sel.includes(k)))}>Select all</button>
            <button className="btn btn-sm" onClick={clear} disabled={!picked.length}>Clear selection</button>
          </div>
        </div>
        <Legend />
        <div className="overflow-x-auto">
          <table className="w-full border-separate border-spacing-0">
            <thead>
              <tr>
                <th className="th pl-5">Device</th>
                {monthLabels.map((m, mi) => (
                  <th key={m} className="th cursor-pointer text-center hover:text-accent" title={`Select or clear every month with issuance in ${m}`} onClick={() => toggle(rows.map((r) => key(r.registryId, mi)))}>{m}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.registryId}>
                  <td className="td cursor-pointer pl-5" title={`Select or clear every month with issuance for ${r.outputName}`} onClick={() => toggle(r.cells.map((c) => key(r.registryId, c.mi)))}>
                    <div className="font-medium">{r.outputName}</div>
                    <div className="num text-[12px] text-muted">{r.registryId} · {r.ratingMw ?? "?"} MW{r.site ? ` · ${r.site}` : ""}</div>
                  </td>
                  {r.cells.map((c) => (
                    <td key={c.mi} className="td px-1.5 py-1.5">
                      <Cell cell={c} on={sel.includes(key(r.registryId, c.mi))} busy={busy} onToggle={() => toggle([key(r.registryId, c.mi)])} onUndo={(id) => undo([id])} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center gap-3 border-t border-line px-5 py-3 text-[13px] text-muted">
          <span>
            Rule: scale each picked month to <b className="font-medium text-ink">issued {pct(rule.marginPct)} to {pct(rule.marginMaxPct)}</b> (picked per device and month) · band <b className="font-medium text-ink">{pct(rule.bandMinPct)} to {pct(rule.bandMaxPct)}</b> · never above the turbine rating
          </span>
          <button className="ml-auto font-medium text-accent" onClick={() => setRuleOpen((o) => !o)} aria-expanded={ruleOpen}>{ruleOpen ? "Done" : "Change rule"}</button>
        </div>
        {ruleOpen && (
          <div className="flex flex-wrap gap-5 px-5 pb-4 text-[13px]">
            {([["marginPct", "Target from issued"], ["marginMaxPct", "to issued"], ["bandMinPct", "Band from issued"], ["bandMaxPct", "to issued"]] as const).map(([k, label]) => (
              <label key={k} className="flex items-center gap-2" htmlFor={`rule-${k}`}>
                {label}
                <input id={`rule-${k}`} className="input num h-8 w-20 text-right" type="number" step="0.1" min={-RULE_LIMIT_PCT} max={RULE_LIMIT_PCT} value={rule[k]}
                  onChange={(e) => Number.isFinite(e.target.valueAsNumber) && setRule((r) => ({ ...r, [k]: e.target.valueAsNumber }))} /> %
              </label>
            ))}
            {!ruleOk && <span className="text-danger">The band must contain the target range, within ±{RULE_LIMIT_PCT}% of issued.</span>}
          </div>
        )}
      </section>

      <section className="card overflow-hidden">
        <div className="flex items-center gap-3 border-b border-line px-5 py-3.5">
          <div>
            <h2 className="text-[15px] font-semibold">Review before and after</h2>
            <p className="text-[12.5px] text-muted">Only the months you picked. MWh; % is the statement against issued. Click a row for the day-by-day view.</p>
          </div>
          {loading && <Spinner className="ml-auto text-accent" />}
        </div>
        {!picked.length ? (
          <div className="px-5 py-10 text-center text-[13.5px] text-muted">
            <div className="mb-1 font-medium text-ink">Nothing to review yet</div>
            Pick the months to reconcile in the grid above.
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full border-separate border-spacing-0 text-[13.5px]">
                <thead>
                  <tr>
                    <th className="th pl-5">Device</th>
                    <th className="th text-right">Issued</th>
                    <th className="th text-right">Actual</th>
                    <th className="th border-l text-right">Before</th>
                    <th className="th text-right">vs issued</th>
                    <th className="th border-l text-right">After</th>
                    <th className="th text-right">vs issued</th>
                    <th className="th border-l text-right">Filled</th>
                    <th className="th text-right">Scaled</th>
                    <th className="th">Check</th>
                    <th className="th" title="Fill hours the logger missed, from neighbouring turbines">Fill gaps</th>
                    <th className="th pr-5" />
                  </tr>
                </thead>
                <tbody className="num">
                  {ready.map((p) => {
                    const k = key(p.registryId, p.mi);
                    const before = p.result.beforeKwh / 1000;
                    return (
                      <tr key={k} className={`cursor-pointer ${detailPlan === p ? "bg-accent-soft/60" : "hover:bg-surface-2"}`} onClick={() => setDetail(k)}>
                        <td className="td pl-5"><div className="font-medium">{p.outputName} · {monthLabels[p.mi]}</div><div className="text-[12px] text-muted">{p.registryId} · {p.ratingMw} MW</div></td>
                        <td className="td text-right">{f3(p.issuedMWh)}</td>
                        <td className={`td text-right ${p.banked ? "text-warn" : ""}`}>{f3(p.actualMWh)}</td>
                        <td className="td border-l text-right">{f3(before)}</td>
                        <td className={`td text-right ${before < p.issuedMWh ? "text-danger" : ""}`}>{sign((before / p.issuedMWh - 1) * 100)}</td>
                        <td className="td border-l text-right font-semibold">{f3(p.result.afterKwh / 1000)}</td>
                        <td className={`td text-right ${p.inBand ? "text-ok" : "text-warn"}`}>{sign(p.afterPct)}</td>
                        <td className="td border-l text-right" title={`${p.result.filledIdx.length} hours filled · ${p.result.hoursCalm} left empty (calm) · ${p.result.hoursNoEvidence} without evidence`}>+{f3(p.result.fillKwh / 1000)}</td>
                        <td className="td text-right">{signed3(p.result.scaleKwh / 1000)}</td>
                        <td className="td">
                          <div className="flex flex-wrap gap-1">
                            {p.result.shortKwh > 0 ? <span className="chip bg-danger-soft text-danger">Rating reached · {f1(p.result.shortKwh / 1000)} short</span>
                              : p.inBand ? <span className="chip bg-ok-soft text-ok">In band</span> : <span className="chip bg-warn-soft text-warn">Outside band</span>}
                            {p.banked && <span className="chip bg-warn-soft text-warn">Needs note</span>}
                            {p.fillShare !== null && p.fill && p.fillShare < 0.5 && (
                              <span className="chip bg-surface-2 text-muted" title="Most of this gap is not explained by missing hours: check the source file">Gaps explain {Math.round(p.fillShare * 100)}%</span>
                            )}
                          </div>
                        </td>
                        <td className="td" onClick={(e) => e.stopPropagation()}>
                          <input type="checkbox" className="size-4 accent-[var(--accent)]" aria-label={`Fill missing hours for ${p.outputName} ${monthLabels[p.mi]}`} checked={p.fill}
                            onChange={() => setNoFill((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; })} />
                        </td>
                        <td className="td pr-5 text-right" onClick={(e) => e.stopPropagation()}>
                          <button className="rounded px-1.5 text-faint hover:bg-danger-soft hover:text-danger" aria-label={`Remove ${p.outputName} ${monthLabels[p.mi]}`} onClick={() => setSel((s) => s.filter((x) => x !== k))}><IconX width={14} height={14} /></button>
                        </td>
                      </tr>
                    );
                  })}
                  {skippedPlans.map((s) => (
                    <tr key={key(s.registryId, s.mi)}>
                      <td className="td pl-5 font-medium">{name(s.registryId)} · {monthLabels[s.mi]}</td>
                      <td className="td text-muted" colSpan={10}>Can&apos;t reconcile: {s.skipped}</td>
                      <td className="td pr-5 text-right"><button className="rounded px-1.5 text-faint hover:text-danger" aria-label="Remove" onClick={() => setSel((x) => x.filter((k) => k !== key(s.registryId, s.mi)))}><IconX width={14} height={14} /></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {detailPlan && <Detail plan={detailPlan} label={monthLabels[detailPlan.mi]} />}
          </>
        )}
      </section>

      {confirming && ready.length > 0 && (
        <section className="space-y-3 rounded-xl border border-accent bg-surface px-5 py-4" aria-label="Confirm reconciliation">
          <h3 className="text-[15px] font-semibold">Apply reconciliation to {ready.length} month{ready.length > 1 ? "s" : ""}?</h3>
          <ul className="list-disc space-y-1 pl-5 text-[13.5px] text-muted">
            <li><span className="text-ink">{ready.map((p) => `${p.outputName} ${monthLabels[p.mi]}`).join(", ")}</span></li>
            <li>{added < 0 ? "Removes" : "Adds"} <span className="num text-ink">{f3(Math.abs(added))} MWh</span> in total; each month is aimed at issued {pct(rule.marginPct)} to {pct(rule.marginMaxPct)}.</li>
            <li>These values become the hourly record: downloads and the summary use them. The original readings are kept, so you can undo.</li>
          </ul>
          {ready.filter((p) => p.banked).map((p) => {
            const k = key(p.registryId, p.mi);
            return (
              <label key={k} className="block text-[13px]" htmlFor={`note-${k}`}>
                Note for {p.outputName} {monthLabels[p.mi]}: issued is {f3(p.issuedMWh - (p.actualMWh ?? 0))} MWh above actual
                <input id={`note-${k}`} className="input mt-1" placeholder="Required, e.g. banked from March" value={notes[k] ?? ""} onChange={(e) => setNotes((n) => ({ ...n, [k]: e.target.value }))} />
              </label>
            );
          })}
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn" onClick={() => setConfirming(false)} disabled={busy}>Back to selection</button>
            <button className="btn btn-primary" onClick={apply} disabled={busy || loading || needNote.length > 0}>
              {busy ? "Applying…" : `Apply to ${ready.length} month${ready.length > 1 ? "s" : ""}`}
            </button>
            {needNote.length > 0 && <span className="text-[12.5px] text-muted">{needNote.length} note{needNote.length > 1 ? "s" : ""} still needed</span>}
          </div>
        </section>
      )}

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface/95 backdrop-blur md:left-56">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-3 px-6 py-3">
          <div className="text-[13.5px]">
            {picked.length ? (
              <>
                <b className="font-semibold">{picked.length} month{picked.length > 1 ? "s" : ""}</b> selected
                <div className="text-[12px] text-muted">{signed3(added)} MWh · {ready.filter((p) => p.inBand && !p.result.shortKwh).length} of {ready.length} land in the band</div>
              </>
            ) : (
              <><b className="font-semibold">Nothing selected</b><div className="text-[12px] text-muted">Pick months in the grid</div></>
            )}
          </div>
          <div className="ml-auto flex gap-2">
            <button className="btn" onClick={clear} disabled={!picked.length}>Clear selection</button>
            <button className="btn btn-primary" disabled={!ready.length || confirming || loading || !ruleOk} onClick={() => { setConfirming(true); setTimeout(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }), 0); }}>
              Review and confirm
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Steps({ step }: { step: Step }) {
  const order: Step[] = ["pick", "review", "confirm"];
  const labels = ["Pick months", "Review before and after", "Confirm"];
  const at = order.indexOf(step);
  return (
    <ol className="flex flex-wrap gap-2 text-[12.5px]">
      {labels.map((l, i) => (
        <li key={l} className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${i === at ? "border-accent bg-accent-soft text-accent" : "border-line text-faint"}`}>
          <span className={`grid size-[18px] place-items-center rounded-full text-[11px] font-semibold ${i < at ? "bg-ok text-white" : i === at ? "bg-accent text-white" : "bg-surface-2 text-muted"}`}>
            {i < at ? <IconCheck width={10} height={10} /> : i + 1}
          </span>
          {l}
        </li>
      ))}
    </ol>
  );
}

function Legend() {
  const items: [string, string][] = [
    ["bg-danger-soft", "More than 5% below issued"],
    ["bg-warn-soft", "Below issued"],
    ["bg-surface-2", "At or above issued"],
    ["bg-ok-soft", "Reconciled"],
  ];
  return (
    <div className="flex flex-wrap gap-4 border-b border-line px-5 py-2.5 text-[12px] text-muted">
      {items.map(([c, l]) => <span key={l} className="flex items-center gap-1.5"><i className={`size-3 rounded-[3px] border border-line-strong ${c}`} />{l}</span>)}
      <span><b className="text-[11px] text-warn">BANKED</b> issued above actual, needs a note</span>
    </div>
  );
}

function Cell({ cell: c, on, busy, onToggle, onUndo }: { cell: GridCell; on: boolean; busy: boolean; onToggle: () => void; onUndo: (id: number) => void }) {
  const g = gapPct(c);
  const base = "relative grid w-full min-w-[124px] gap-0.5 rounded-lg border px-2.5 py-1.5 text-right num";
  const sub = c.statementMWh !== null && c.issuedMWh !== null ? `${f1(c.statementMWh)} of ${f1(c.issuedMWh)}` : c.statementMWh !== null ? `${f1(c.statementMWh)} MWh` : "";
  const flag = c.banked ? <span className="absolute bottom-1.5 left-2 text-[10.5px] font-semibold text-warn">BANKED</span> : null;
  if (c.status === "noData") return <div className={`${base} border-dashed border-line text-faint`}><span className="text-[13px]">No data</span></div>;
  if (c.status === "none") return <div className={`${base} border-dashed border-line`}><span className="text-[13px] text-faint">No issuance</span><span className="text-[11.5px] text-faint">{sub}</span></div>;
  if (c.status === "reconciled") {
    const rec = c.reconciliation!;
    return (
      <div className={`${base} border-transparent bg-ok-soft`} title={`Reconciled ${new Date(rec.appliedAt).toLocaleString("en-IN")}${rec.appliedBy ? ` by ${rec.appliedBy}` : ""}: ${f3(rec.beforeKWh / 1000)} → ${f3(rec.afterKWh / 1000)} MWh${rec.note ? `\nNote: ${rec.note}` : ""}`}>
        <span className="text-[13.5px] font-semibold text-ok">{g !== null ? sign(g) : "—"}</span>
        <span className="text-[11.5px] text-ok">Reconciled · <button className="underline underline-offset-2 hover:text-ink disabled:opacity-50" disabled={busy} onClick={() => onUndo(rec.id)}>Undo</button></span>
      </div>
    );
  }
  const deep = g !== null && g < -5;
  const covered = c.status === "covered";
  return (
    <button type="button" aria-pressed={on} onClick={onToggle}
      className={`${base} cursor-pointer ${on ? "border-accent bg-accent-soft ring-1 ring-accent" : covered ? "border-transparent bg-surface-2 hover:border-line-strong" : deep ? "border-transparent bg-danger-soft hover:border-danger" : "border-transparent bg-warn-soft hover:border-warn"}`}>
      <span className={`absolute left-2 top-2 grid size-4 place-items-center rounded border ${on ? "border-accent bg-accent text-white" : "border-line-strong bg-surface"}`}>{on && <IconCheck width={10} height={10} />}</span>
      <span className={`text-[13.5px] font-semibold ${on ? "text-accent" : covered ? "text-ok" : deep ? "text-danger" : "text-warn"}`}>{g !== null ? sign(g) : "—"}</span>
      <span className="text-[11.5px] text-muted">{sub}</span>
      {flag}
    </button>
  );
}

function Detail({ plan: p, label }: { plan: Plan; label: string }) {
  const days = p.daily.before.length;
  const tot = p.daily.before.map((b, i) => b + p.daily.fill[i] + Math.max(p.daily.scale[i], 0));
  const max = Math.max(...tot, 0.001);
  const W = 640, H = 180, L = 34, B = 20, T = 8, bw = (W - L - 6) / days;
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  return (
    <div className="grid gap-0 border-t border-line lg:grid-cols-[minmax(0,1fr)_280px]">
      <div className="min-w-0 px-5 py-4">
        <div className="mb-2 flex flex-wrap gap-4 text-[12px] text-muted">
          <span className="flex items-center gap-1.5"><i className="size-2.5 rounded-sm bg-line-strong" />Before</span>
          <span className="flex items-center gap-1.5"><i className="size-2.5 rounded-sm bg-warn" />Filled gaps</span>
          <span className="flex items-center gap-1.5"><i className="size-2.5 rounded-sm bg-accent" />Scaled up</span>
          <span className="flex items-center gap-1.5"><i className="size-2.5 rounded-sm bg-danger opacity-40" />Scaled down</span>
          <span>{p.outputName} · {label} · daily MWh</span>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`Daily MWh before and after for ${p.outputName} ${label}`}>
          {[0, max / 2, max].map((t) => (
            <g key={t}><line x1={L} x2={W - 4} y1={y(t)} y2={y(t)} stroke="var(--border)" /><text x={L - 6} y={y(t) + 3} textAnchor="end" fontSize="10" fill="var(--faint)">{t.toFixed(0)}</text></g>
          ))}
          {p.daily.before.map((b, i) => {
            const x = L + 3 + i * bw, w = Math.max(bw - 3, 1);
            const f = p.daily.fill[i], s = p.daily.scale[i];
            return (
              <g key={i}>
                <rect x={x} y={y(b + Math.min(s, 0))} width={w} height={Math.max(y(0) - y(b + Math.min(s, 0)), 0)} fill="var(--border-strong)" rx={1.5}><title>{`Day ${i + 1}: ${f3(b)} before`}</title></rect>
                {s < 0 && <rect x={x} y={y(b)} width={w} height={y(b + s) - y(b)} fill="var(--danger)" opacity={0.4} rx={1.5}><title>{`Day ${i + 1}: −${f3(-s)} scaled down`}</title></rect>}
                {f > 0 && <rect x={x} y={y(b + f)} width={w} height={y(b) - y(b + f)} fill="var(--warn)" rx={1.5}><title>{`Day ${i + 1}: +${f3(f)} filled`}</title></rect>}
                {s > 0 && <rect x={x} y={y(b + f + s)} width={w} height={y(b + f) - y(b + f + s)} fill="var(--accent)" rx={1.5}><title>{`Day ${i + 1}: +${f3(s)} scaled`}</title></rect>}
                {((i + 1) % 5 === 0 || i === 0) && <text x={x + w / 2} y={H - 5} textAnchor="middle" fontSize="10" fill="var(--faint)">{i + 1}</text>}
              </g>
            );
          })}
        </svg>
      </div>
      <dl className="grid grid-cols-[auto_auto] content-start gap-x-3 gap-y-1.5 border-t border-line px-5 py-4 text-[13px] lg:border-l lg:border-t-0">
        <dt className="text-muted">Issued</dt><dd className="num text-right">{f3(p.issuedMWh)}</dd>
        <dt className="text-muted">Target ({pct(p.targetPct)})</dt><dd className="num text-right">{f3(p.targetMWh)}</dd>
        <dt className="text-muted">Before</dt><dd className="num text-right">{f3(p.result.beforeKwh / 1000)}</dd>
        <dt className="text-muted">After</dt><dd className="num text-right font-semibold">{f3(p.result.afterKwh / 1000)}</dd>
        <dt className="text-muted">Hours filled</dt><dd className="num text-right">{p.result.filledIdx.length}</dd>
        <dt className="text-muted">Left empty (calm)</dt><dd className="num text-right">{p.result.hoursCalm}</dd>
        <dt className="text-muted">No evidence</dt><dd className="num text-right">{p.result.hoursNoEvidence}</dd>
        <dt className="text-muted">Hours scaled</dt><dd className="num text-right">{p.result.hoursRaised}</dd>
        <dt className="text-muted">Factor</dt><dd className="num text-right">×{p.result.factor.toFixed(4)}</dd>
        <dt className="text-muted">At rating</dt><dd className="num text-right">{p.result.hoursAtRating} h · {(p.ratingMw * 1000).toLocaleString("en-IN")} kWh/h</dd>
      </dl>
    </div>
  );
}
