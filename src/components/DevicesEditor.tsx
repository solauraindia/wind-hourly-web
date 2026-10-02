"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Device } from "@/lib/types";
import { IconAlert, IconCheck, IconX } from "./Icons";

const COLUMNS: { key: keyof Device; label: string; width: string; hint?: string }[] = [
  { key: "outputName", label: "Output name", width: "w-[170px]", hint: "File stem: <name>_hourly_2026Q2.xlsx" },
  { key: "alias", label: "Raw alias", width: "w-[110px]", hint: "Turbine name as it appears in the raw export" },
  { key: "sourceHint", label: "Source hint", width: "w-[120px]", hint: "Text in the raw file name that disambiguates repeated aliases" },
  { key: "client", label: "Client", width: "w-[210px] max-w-[210px]" },
  { key: "meterId", label: "meter_id", width: "w-[130px]" },
  { key: "facilityId", label: "eac_facility_id", width: "w-[250px] max-w-[250px]" },
  { key: "registryId", label: "eac_registry_id", width: "w-[130px]" },
];

const blank = (): Device => ({ id: "", alias: "", outputName: "", client: "", meterId: "", facilityId: "", registryId: "" });

export function DevicesEditor({ initial }: { initial: Device[] }) {
  const router = useRouter();
  const [rows, setRows] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // keep in sync after an import refreshes the server props
  const [seen, setSeen] = useState(initial);
  if (seen !== initial && !editing) {
    setSeen(initial);
    setRows(initial);
  }

  const set = (i: number, key: keyof Device, value: string) => setRows((r) => r.map((d, j) => (j === i ? { ...d, [key]: value } : d)));

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/devices", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(rows) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      setRows(json.devices);
      setEditing(false);
      setMsg({ ok: true, text: `Saved ${json.devices.length} devices.` });
      router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card overflow-hidden">
      <div className="flex items-center gap-3 border-b border-line px-5 py-3.5">
        <div>
          <h2 className="text-[15px] font-semibold">Registry · {rows.length} devices</h2>
          <p className="text-[12.5px] text-muted">Order here is the order of the quarter summary.</p>
        </div>
        <div className="ml-auto flex gap-2">
          {editing ? (
            <>
              <button className="btn btn-sm" onClick={() => setRows((r) => [...r, blank()])}>Add device</button>
              <button className="btn btn-sm" onClick={() => { setRows(initial); setEditing(false); }} disabled={busy}>Cancel</button>
              <button className="btn btn-primary btn-sm" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save changes"}</button>
            </>
          ) : (
            <button className="btn btn-sm" onClick={() => setEditing(true)}>Edit</button>
          )}
        </div>
      </div>
      {msg && (
        <div className={`mx-5 mt-3 flex items-center gap-2 rounded-lg px-3 py-2 text-[13px] ${msg.ok ? "bg-ok-soft text-ok" : "bg-danger-soft text-danger"}`}>
          {msg.ok ? <IconCheck /> : <IconAlert />} {msg.text}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-0">
          <thead>
            <tr>
              <th className="th pl-5">#</th>
              {COLUMNS.map((c) => (
                <th key={c.key} className={`th whitespace-nowrap ${c.width}`} title={c.hint}>{c.label}</th>
              ))}
              {editing && <th className="th pr-5" />}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td className="td py-10 text-center text-muted" colSpan={COLUMNS.length + 2}>
                  No devices yet — import a delivery workbook above.
                </td>
              </tr>
            )}
            {rows.map((d, i) => (
              <tr key={d.id || `new-${i}`} className="hover:bg-surface-2/60">
                <td className="td num pl-5 text-muted">{i + 1}</td>
                {COLUMNS.map((c) => (
                  <td key={c.key} className={`td ${c.width} ${editing ? "py-1.5" : ""}`}>
                    {editing ? (
                      <input className="input h-8 text-[13px]" value={(d[c.key] as string) ?? ""} onChange={(e) => set(i, c.key, e.target.value)} />
                    ) : (
                      <span className={`block truncate text-[13px] ${c.key === "outputName" ? "font-medium" : c.key === "sourceHint" && !d.sourceHint ? "text-faint" : ""}`} title={(d[c.key] as string) ?? ""}>
                        {(d[c.key] as string) || "—"}
                      </span>
                    )}
                  </td>
                ))}
                {editing && (
                  <td className="td pr-5">
                    <button aria-label="Remove device" className="grid size-7 place-items-center rounded-md text-faint hover:bg-danger-soft hover:text-danger" onClick={() => setRows((r) => r.filter((_, j) => j !== i))}>
                      <IconX width={14} height={14} />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
