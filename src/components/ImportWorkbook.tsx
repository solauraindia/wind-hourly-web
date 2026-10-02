"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { quarterLabel } from "@/lib/format";
import { IconAlert, IconCheck, IconUpload } from "./Icons";

export function ImportWorkbook({ quarter }: { quarter: string }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [withActuals, setWithActuals] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function upload(file: File) {
    setBusy(true);
    setMsg(null);
    const form = new FormData();
    form.append("file", file);
    if (withActuals) form.append("quarter", quarter);
    try {
      const res = await fetch("/api/devices/import", { method: "POST", body: form });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      setMsg({
        ok: true,
        text: `${json.added} added, ${json.updated} updated${json.actualRows ? ` · actuals for ${json.actualRows} devices saved to ${quarterLabel(quarter)}` : ""}.`,
      });
      router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card flex flex-wrap items-center gap-4 px-5 py-4">
      <div className="min-w-[280px] flex-1">
        <h2 className="text-[15px] font-semibold">Import a delivery workbook</h2>
        <p className="mt-0.5 text-[13px] text-muted">
          Reads <span className="font-medium text-ink">Hourly Files_details</span> for meter / facility / registry ids and{" "}
          <span className="font-medium text-ink">Sheet1</span> for client names. Existing devices are matched on registry id.
        </p>
      </div>
      <label className="flex items-center gap-2 text-[13px] text-muted">
        <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={withActuals} onChange={(e) => setWithActuals(e.target.checked)} />
        Also load actual / eligible / issued into {quarterLabel(quarter)}
      </label>
      <button className="btn btn-primary" disabled={busy} onClick={() => input.current?.click()}>
        <IconUpload /> {busy ? "Importing…" : "Choose .xlsx"}
      </button>
      <input
        ref={input}
        type="file"
        accept=".xlsx"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) upload(f);
          e.target.value = "";
        }}
      />
      {msg && (
        <div className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-[13px] ${msg.ok ? "bg-ok-soft text-ok" : "bg-danger-soft text-danger"}`}>
          {msg.ok ? <IconCheck /> : <IconAlert />} {msg.text}
        </div>
      )}
    </section>
  );
}
