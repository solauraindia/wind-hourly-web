"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ENERGY_LABELS, type Device, type EnergyType } from "@/lib/types";
import { EnergyBadge } from "./EnergyType";
import { IconAlert, IconCheck, IconX } from "./Icons";

type Row = Device & { isNew?: boolean };

const EDITABLE: { key: "registryId" | "alias" | "sourceHint" | "outputName" | "site"; label: string; width: string; hint: string }[] = [
  { key: "registryId", label: "Registry id", width: "w-[130px]", hint: "irec devices.device_meta_id (eac_registry_id)" },
  { key: "outputName", label: "Output name", width: "w-[170px]", hint: "File stem: <name>_hourly_2026Q2.xlsx" },
  { key: "alias", label: "Raw alias", width: "w-[110px]", hint: "Turbine name, or a solar plant's capacity label or code (6MW, SSML), as it appears in the raw export" },
  { key: "sourceHint", label: "Source hint", width: "w-[120px]", hint: "Text in the raw file name that disambiguates repeated aliases" },
  { key: "site", label: "Site", width: "w-[120px]", hint: "Physical site; turbines or plants at the same site are used as evidence when reconciling logger gaps" },
];

const blank = (): Row => ({ id: "", registryId: "", alias: "", outputName: "", client: "", meterId: "", facilityId: "", inIrec: false, energyType: null, isNew: true });

/**
 * `type` only hides rows: every device stays in state and is sent on save, so
 * a filtered view never deletes the devices it is not showing.
 */
export function DevicesEditor({ initial, version: initialVersion, irecUnavailable, type = null }: { initial: Device[]; version: string; irecUnavailable: boolean; type?: EnergyType | null }) {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>(initial);
  // the table fingerprint the next save is checked against; refreshed by every successful save
  const [version, setVersion] = useState(initialVersion);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // keep in sync after an import refreshes the server props
  const [seen, setSeen] = useState(initial);
  if (seen !== initial && !editing) {
    setSeen(initial);
    setRows(initial);
    setVersion(initialVersion);
  }

  const shown = (d: Row) => !type || d.isNew || d.energyType === type;
  const visible = rows.filter(shown).length;

  const set = (i: number, key: keyof Row, value: string) => setRows((r) => r.map((d, j) => (j === i ? { ...d, [key]: value } : d)));

  async function save() {
    setBusy(true);
    setMsg(null);
    const devices = rows.map(({ registryId, alias, outputName, sourceHint, site }) => ({ registryId, alias, outputName, sourceHint, site }));
    const put = (confirmDelete: string[] = []) =>
      fetch("/api/devices", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version, devices, confirmDelete }) });
    try {
      let res = await put();
      let json = await res.json();
      if (res.status === 409 && json.needsConfirmation) {
        const list = (json.needsConfirmation as { registryId: string; outputName: string; quarters: string[] }[])
          .map((d) => `• ${d.outputName} (${d.registryId}): ${d.quarters.join(", ")}`)
          .join("\n");
        if (!window.confirm(`Removing these devices permanently deletes their stored hourly data:\n\n${list}\n\nContinue?`)) {
          setMsg({ ok: false, text: "Not saved — nothing was deleted." });
          return;
        }
        res = await put(json.needsConfirmation.map((d: { registryId: string }) => d.registryId));
        json = await res.json();
      }
      if (!res.ok) throw new Error(json.error);
      setRows(json.devices);
      setVersion(json.version);
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
          <h2 className="text-[15px] font-semibold">
            {type ? `${ENERGY_LABELS[type]} devices · ${visible} of ${rows.length}` : `Devices · ${rows.length}`}
          </h2>
          <p className="text-[12.5px] text-muted">Order here is the order of the quarter summary. Removing a device also deletes its stored hourly data.</p>
        </div>
        <div className="ml-auto flex gap-2">
          {editing ? (
            <>
              <button className="btn btn-sm" onClick={() => setRows((r) => [...r, blank()])}>Add device</button>
              <button className="btn btn-sm" onClick={() => { setRows(initial); setEditing(false); setMsg(null); }} disabled={busy}>Cancel</button>
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
              {EDITABLE.map((c) => (
                <th key={c.key} className={`th whitespace-nowrap ${c.width}`} title={c.hint}>{c.label}</th>
              ))}
              <th className="th border-l w-[200px] max-w-[200px]" title="irec companies.company_name">Client</th>
              <th className="th w-[120px]" title="irec devices.htsc_no">meter_id</th>
              <th className="th w-[250px] max-w-[250px]" title="irec devices.project_description">eac_facility_id</th>
              {editing && <th className="th pr-5" />}
            </tr>
          </thead>
          <tbody>
            {visible === 0 && (
              <tr>
                <td className="td py-10 text-center text-muted" colSpan={10}>
                  {rows.length === 0 ? "No devices yet — import a delivery workbook above or add one." : irecUnavailable ? "irec is unavailable, so device types are unknown." : `No ${type ? ENERGY_LABELS[type].toLowerCase() : ""} devices.`}
                </td>
              </tr>
            )}
            {rows.map((d, i) => !shown(d) ? null : (
              <tr key={d.id || `new-${i}`} className="hover:bg-surface-2/60">
                <td className="td num pl-5 text-muted">{i + 1}</td>
                {EDITABLE.map((c) => (
                  <td key={c.key} className={`td ${c.width} ${editing ? "py-1.5" : ""}`}>
                    {editing && (c.key !== "registryId" || d.isNew) ? (
                      <input className="input h-8 text-[13px]" value={d[c.key] ?? ""} onChange={(e) => set(i, c.key, e.target.value)} />
                    ) : (
                      <span className={`flex items-center gap-1.5 truncate text-[13px] ${c.key === "outputName" ? "font-medium" : ""} ${!d[c.key] ? "text-faint" : ""}`}>
                        <span className="truncate">{d[c.key] || "—"}</span>
                        {c.key === "registryId" && <EnergyBadge type={d.energyType} />}
                      </span>
                    )}
                  </td>
                ))}
                {d.isNew ? (
                  <td className="td border-l text-[12.5px] text-faint" colSpan={3}>Filled from irec on save</td>
                ) : irecUnavailable ? (
                  <td className="td border-l text-[12.5px] text-warn" colSpan={3}>irec unavailable</td>
                ) : !d.inIrec ? (
                  <td className="td border-l text-[12.5px] text-danger" colSpan={3}>Registry id not found in irec</td>
                ) : (
                  <>
                    <td className="td border-l w-[200px] max-w-[200px]"><span className="block truncate text-[13px] text-muted" title={d.client}>{d.client || "—"}</span></td>
                    <td className="td num text-[13px] text-muted">{d.meterId || "—"}</td>
                    <td className="td w-[250px] max-w-[250px]"><span className="block truncate text-[13px] text-muted" title={d.facilityId}>{d.facilityId || "—"}</span></td>
                  </>
                )}
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
